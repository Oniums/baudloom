import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { ConnectionConfig, EventInput, StoredEvent } from "../shared";

const MAX_LINE = 128 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const digest = (event: StoredEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");
export class Journal {
  readonly sessionId = randomUUID();
  file = "";
  private handle!: FileHandle;
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private syncing = false;
  private failure: Error | null = null;
  pendingBytes = 0;
  private backfillPending = 0;
  writtenBytes = 0;
  syncedAt: string | null = null;
  onFault: (error: Error) => void = () => {};
  private constructor(
    private metadata: ConnectionConfig,
    private limits = { maxBytes: MAX_FILE, maxQueueBytes: 4 * 1024 * 1024 },
  ) {}
  static async create(
    directory: string,
    metadata: ConnectionConfig,
    limits?: { maxBytes: number; maxQueueBytes: number },
  ): Promise<Journal> {
    const journal = new Journal(metadata, limits);
    await mkdir(directory, { recursive: true });
    journal.file = join(
      directory,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${journal.sessionId}.baudloom.jsonl`,
    );
    journal.handle = await open(journal.file, "wx", 0o600);
    try {
      await journal.append({ kind: "start", message: "capture started" });
      await journal.sync();
    } catch (error) {
      await journal.handle.close();
      throw error;
    }
    journal.timer = setInterval(() => {
      if (journal.syncing || journal.closed || journal.failure) return;
      journal.syncing = true;
      void journal
        .sync()
        .catch(() => {})
        .finally(() => {
          journal.syncing = false;
        });
    }, 1000);
    journal.timer.unref();
    return journal;
  }
  get eventCount() {
    return this.seq;
  }
  backfill(events: StoredEvent[]): Promise<unknown> {
    // Enqueue the bounded history synchronously so new RX follows it without a gap.
    return Promise.all(
      events.map(({ kind, data, message, requestId, outcome, at, mono }) =>
        this.appendEvent(
          { kind, data, message, requestId, outcome },
          { at, mono },
        ),
      ),
    );
  }
  append(input: EventInput): Promise<StoredEvent> {
    return this.appendEvent(input);
  }
  private appendEvent(
    input: EventInput,
    original?: Pick<StoredEvent, "at" | "mono">,
  ): Promise<StoredEvent> {
    if (this.closed || this.failure)
      return Promise.reject(this.failure ?? Error("记录已关闭"));
    const event: StoredEvent = {
      ...input,
      v: 1,
      seq: this.seq + 1,
      sessionId: this.sessionId,
      at: original?.at ?? new Date().toISOString(),
      mono: original?.mono ?? process.hrtime.bigint().toString(),
      ...this.metadata,
    };
    const buffer = Buffer.from(
      JSON.stringify({ event, hash: digest(event) }) + "\n",
    );
    if (buffer.length > MAX_LINE) return Promise.reject(Error("单条记录过长"));
    if (
      original
        ? this.backfillPending + buffer.length > 32 * 1024 * 1024
        : this.pendingBytes - this.backfillPending + buffer.length >
          this.limits.maxQueueBytes
    )
      return Promise.reject(Error("记录队列已满，采集必须停止"));
    if (
      this.writtenBytes + this.pendingBytes + buffer.length >
      this.limits.maxBytes - (input.kind === "stop" ? 0 : 512)
    )
      return Promise.reject(Error("会话容量已达上限，采集必须停止"));
    this.seq++;
    this.pendingBytes += buffer.length;
    if (original) this.backfillPending += buffer.length;
    const write = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      let offset = 0;
      while (offset < buffer.length) {
        const result = await this.handle.write(
          buffer,
          offset,
          buffer.length - offset,
        );
        if (!result.bytesWritten) throw Error("记录写入未前进");
        offset += result.bytesWritten;
      }
      this.writtenBytes += buffer.length;
    });
    const result = write
      .then(() => event)
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.pendingBytes -= buffer.length;
        if (original) this.backfillPending -= buffer.length;
      });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private fail(error: unknown) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : Error(String(error));
    this.onFault(this.failure);
  }
  async sync() {
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      await this.handle.sync();
      this.syncedAt = new Date().toISOString();
    });
    this.tail = operation.catch((error) => {
      this.fail(error);
    });
    return operation;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    const stop = this.append({ kind: "stop", message: "capture stopped" });
    this.closed = true;
    this.closing = (async () => {
      try {
        await stop;
        await this.sync();
      } finally {
        await this.tail;
        await this.handle.close();
      }
    })();
    return this.closing;
  }
}
function isEvent(e: any): e is StoredEvent {
  return (
    e &&
    e.v === 1 &&
    Number.isSafeInteger(e.seq) &&
    e.seq > 0 &&
    typeof e.sessionId === "string" &&
    e.sessionId.length <= 64 &&
    typeof e.at === "string" &&
    Number.isFinite(Date.parse(e.at)) &&
    typeof e.mono === "string" &&
    /^\d{1,30}$/.test(e.mono) &&
    ["serial", "synthetic"].includes(e.source) &&
    typeof e.target === "string" &&
    e.target.length <= 1024 &&
    Number.isInteger(e.baudRate) &&
    e.baudRate > 0 &&
    [
      "start",
      "rx",
      "tx-request",
      "tx-result",
      "mark",
      "error",
      "stop",
    ].includes(e.kind) &&
    (e.data === undefined ||
      (typeof e.data === "string" &&
        Buffer.from(e.data, "base64").toString("base64") === e.data)) &&
    (e.message === undefined || typeof e.message === "string")
  );
}
export async function readSession(
  file: string,
  limit = 2000,
  byteLimit = 2 * 1024 * 1024,
): Promise<{
  events: StoredEvent[];
  total: number;
  complete: boolean;
  warning: string | null;
}> {
  const events: StoredEvent[] = [];
  let pending = Buffer.alloc(0),
    total = 0,
    bytes = 0,
    retained = 0,
    sessionId = "",
    lastKind = "",
    warning: string | null = null;
  const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
  outer: for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_FILE) {
      warning = "文件超过 64 MiB 读取上限";
      break;
    }
    pending = Buffer.concat([pending, buffer]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > MAX_LINE) {
        warning = "记录行过长，已停止验证";
        break outer;
      }
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      try {
        const envelope = JSON.parse(line.toString("utf8"));
        const e = envelope.event;
        if (!isEvent(e) || envelope.hash !== digest(e))
          throw Error("记录校验失败");
        if (
          e.seq !== total + 1 ||
          (total === 0
            ? e.kind !== "start"
            : e.sessionId !== sessionId ||
              e.kind === "start" ||
              lastKind === "stop")
        )
          throw Error("记录顺序/会话校验失败");
        sessionId = e.sessionId;
        lastKind = e.kind;
        total++;
        events.push(e);
        retained += line.length;
        while (events.length > limit || retained > byteLimit) {
          retained -=
            Buffer.byteLength(JSON.stringify({ event: events[0], hash: "" })) +
            64;
          events.shift();
        }
      } catch (error) {
        warning = `第 ${total + 1} 条${error instanceof Error ? error.message : "记录校验失败"}，仅显示已验证前缀`;
        break outer;
      }
    }
    if (pending.length > MAX_LINE) {
      warning = "记录行过长，已停止验证";
      break;
    }
  }
  if (!warning && pending.length) warning = "尾部记录截断，仅显示完整前缀";
  if (!warning && lastKind !== "stop")
    warning = "会话未正常收尾，可能存在未保存尾部";
  return { events, total, complete: !warning && lastKind === "stop", warning };
}
