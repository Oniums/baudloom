import {
  DEFAULT_VIEW_LIMITS,
  validateViewLimits,
  type ViewLimits,
} from "../view-settings";
import { LineDecoder } from "./text";
import type { LogRow, StoredEvent } from "../shared";

/** Display eviction never changes the journal. Every view has a bounded budget. */
export class View {
  private limits: ViewLimits;
  constructor(limits = DEFAULT_VIEW_LIMITS) {
    this.limits = validateViewLimits(limits);
  }
  setLimits(limits: ViewLimits) {
    this.limits = validateViewLimits(limits);
    for (const hex of [false, true]) {
      const rows = hex ? this.hexRows : this.rows;
      while (
        rows.length > this.limits.maxRows ||
        (hex ? this.hexSize : this.size) > this.limits.maxChars
      ) {
        const row = rows.shift()!;
        if (hex) this.hexSize -= row.text.length;
        else this.size -= row.text.length;
      }
    }
  }
  rows: LogRow[] = [];
  hexRows: LogRow[] = [];
  total = 0;
  hexTotal = 0;
  private size = 0;
  private hexSize = 0;
  private decoder = new LineDecoder();
  private lastAt = "";
  private lastRxAt = "";
  textSnapshot(): { rows: LogRow[]; total: number } {
    const rows = this.rows.slice();
    const partial = this.decoder.pendingText;
    if (!partial) return { rows, total: this.total };
    rows.push({
      id: this.total + 1,
      at: this.lastRxAt,
      dir: "RX",
      text: partial,
    });
    let size = this.size + partial.length;
    while (rows.length > this.limits.maxRows || size > this.limits.maxChars)
      size -= rows.shift()!.text.length;
    return { rows, total: this.total + 1 };
  }
  private add(at: string, dir: string, text: string, hex = false) {
    const row = { id: hex ? ++this.hexTotal : ++this.total, at, dir, text };
    const rows = hex ? this.hexRows : this.rows;
    rows.push(row);
    if (hex) this.hexSize += text.length;
    else this.size += text.length;
    while (
      rows.length > this.limits.maxRows ||
      (hex ? this.hexSize : this.size) > this.limits.maxChars
    ) {
      const old = rows.shift()!;
      if (hex) this.hexSize -= old.text.length;
      else this.size -= old.text.length;
    }
  }
  apply(e: StoredEvent) {
    this.lastAt = e.at;
    if (e.kind === "rx") {
      this.lastRxAt = e.at;
      const b = Buffer.from(e.data ?? "", "base64");
      for (const line of this.decoder.push(b)) this.add(e.at, "RX", line);
      for (let i = 0; i < b.length; i += 32)
        this.add(
          e.at,
          "RX",
          b
            .subarray(i, i + 32)
            .toString("hex")
            .match(/../g)!
            .join(" "),
          true,
        );
    } else {
      if (e.kind === "stop") this.finish();
      const dir =
        e.kind === "tx-request"
          ? "TX"
          : e.kind === "mark"
            ? "MARK"
            : e.kind === "error"
              ? "ERROR"
              : "SYS";
      let text = e.message ?? e.kind;
      if (e.kind === "tx-request")
        text = Buffer.from(e.data ?? "", "base64")
          .toString("utf8")
          .replace(/\r/g, "\\r")
          .replace(/\n/g, "\\n");
      if (e.kind === "tx-result")
        text =
          e.outcome === "host-write-completed"
            ? "主机写入完成（不代表设备执行成功）"
            : `发送结果不确定：${e.message ?? ""}`;
      this.add(e.at, dir, text);
      this.add(
        e.at,
        dir,
        e.kind === "tx-request"
          ? Buffer.from(e.data ?? "", "base64")
              .toString("hex")
              .match(/../g)!
              .join(" ")
          : text,
        true,
      );
    }
  }
  finish() {
    for (const line of this.decoder.finish())
      this.add(this.lastAt, "RX", `${line} [未终止片段]`);
    this.decoder = new LineDecoder();
  }
}
