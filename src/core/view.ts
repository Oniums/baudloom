import {
  DEFAULT_VIEW_LIMITS,
  validateViewLimits,
  type ViewLimits,
} from "../view-settings";
import { Deque } from "./deque";
import { LineDecoder } from "./text";
import type { LogRow, StoredEvent } from "../shared";

const hexBytes = Array.from({ length: 256 }, (_, n) =>
  n.toString(16).padStart(2, "0"),
);
function hexText(bytes: Buffer, start: number, end: number) {
  const parts = new Array<string>(end - start);
  for (let i = start; i < end; i++) parts[i - start] = hexBytes[bytes[i]];
  return parts.join(" ");
}

/** Display eviction never changes the journal. Every view has a bounded budget. */
export class View {
  private limits: ViewLimits;
  constructor(limits = DEFAULT_VIEW_LIMITS) {
    this.limits = validateViewLimits(limits);
  }
  setLimits(limits: ViewLimits) {
    this.limits = validateViewLimits(limits);
    this.revision++;
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
  private rows = new Deque<LogRow>();
  private hexRows = new Deque<LogRow>();
  revision = 0;
  total = 0;
  hexTotal = 0;
  private size = 0;
  private hexSize = 0;
  private rxLines = 0;
  clearBoundaries() {
    const chars = this.decoder.pendingText.length;
    return {
      text: {
        afterRowId: this.total,
        partial: chars ? { line: this.rxLines + 1, chars } : undefined,
      },
      hex: { afterRowId: this.hexTotal },
    };
  }
  private decoder = new LineDecoder();
  private lastAt = "";
  private lastMono: string | undefined;
  private lastRxMono: string | undefined;
  private lastRxAt = "";
  textSnapshot() {
    return this.snapshot("text");
  }
  snapshot(mode: "text" | "hex", afterId = 0, unchanged = false) {
    const hex = mode === "hex";
    const buffer = hex ? this.hexRows : this.rows;
    const partial = hex ? "" : this.decoder.pendingText;
    const total = (hex ? this.hexTotal : this.total) + (partial ? 1 : 0);
    let start = 0;
    let count = buffer.length + (partial ? 1 : 0);
    let size = (hex ? this.hexSize : this.size) + partial.length;
    while (count > this.limits.maxRows || size > this.limits.maxChars) {
      size -= buffer.at(start++)!.text.length;
      count--;
    }
    const firstId = buffer.at(start)?.id ?? (partial ? total : total + 1);
    let low = start,
      high = buffer.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (buffer.at(mid)!.id < afterId) low = mid + 1;
      else high = mid;
    }
    const rows = unchanged ? [] : buffer.slice(low);
    if (partial && !unchanged && total >= afterId)
      rows.push({
        rxLine: this.rxLines + 1,
        id: total,
        at: this.lastRxAt,
        mono: this.lastRxMono,
        dir: "RX",
        text: partial,
      });
    return { rows, total, count, firstId };
  }
  private add(at: string, dir: string, text: string, hex = false) {
    const row = {
      rxLine: !hex && dir === "RX" ? ++this.rxLines : undefined,
      id: hex ? ++this.hexTotal : ++this.total,
      at,
      mono: this.lastMono,
      dir,
      text,
    };
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
  appendText(text: string) {
    this.revision++;
    this.add("", "", text);
  }
  apply(e: StoredEvent) {
    this.revision++;
    this.lastAt = e.at;
    this.lastMono = e.mono;
    if (e.kind === "rx") {
      this.lastRxAt = e.at;
      this.lastRxMono = e.mono;
      const b = Buffer.from(e.data ?? "", "base64");
      for (const line of this.decoder.push(b)) this.add(e.at, "RX", line);
      for (let i = 0; i < b.length; i += 32)
        this.add(e.at, "RX", hexText(b, i, Math.min(i + 32, b.length)), true);
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
    this.revision++;
    const mono = this.lastMono;
    this.lastMono = this.lastRxMono;
    for (const line of this.decoder.finish())
      this.add(this.lastRxAt, "RX", `${line} [未终止片段]`);
    this.lastMono = mono;
    this.decoder = new LineDecoder();
  }
}
