import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readdir, stat, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname, basename } from "node:path";
import { Deque } from "./deque";
import type { ConnectionConfig, EventInput, StoredEvent } from "../shared";

const MAX_LINE = 128 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const digest = (event: StoredEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");
export interface SessionPart {
  file: string;
  bytes: number;
  index: number;
}
export class Journal {
  readonly sessionId = randomUUID();
  file = "";
  private parts: SessionPart[] = [];
  get segmentCount() {
    return this.parts.length;
  }
  get currentFile() {
    return this.parts.at(-1)?.file ?? this.file;
  }
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
    journal.parts.push({ file: journal.file, bytes: 0, index: 1 });
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
    if (buffer.length > this.limits.maxBytes)
      return Promise.reject(Error("单条记录超过分段容量"));
    this.seq++;
    this.pendingBytes += buffer.length;
    if (original) this.backfillPending += buffer.length;
    const write = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.parts.at(-1)!.bytes + buffer.length > this.limits.maxBytes) {
        // Rotation stays in the same write queue; event sequence and partial RX continue.
        await this.handle.sync();
        await this.handle.close();
        const index = this.parts.length + 1;
        if (index > 999999) throw Error("会话分段数量已达上限");
        const file = this.file.replace(
          /\.baudloom\.jsonl$/,
          `.part${String(index).padStart(6, "0")}.baudloom.jsonl`,
        );
        this.handle = await open(file, "wx", 0o600);
        this.parts.push({ file, bytes: 0, index });
      }
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
      this.parts.at(-1)!.bytes += buffer.length;
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
  async checkpoint(): Promise<SessionPart[]> {
    if (this.closed) {
      await this.closing;
      if (this.failure) throw this.failure;
      return this.parts.map((part) => ({ ...part }));
    }
    let result: SessionPart[] = [];
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      await this.handle.sync();
      this.syncedAt = new Date().toISOString();
      result = this.parts.map((part) => ({ ...part }));
    });
    this.tail = operation.catch((error) => this.fail(error));
    await operation;
    return result;
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
/** Discover only siblings belonging to the selected recording, starting at part one. */
export async function sessionParts(file: string): Promise<SessionPart[]> {
  const dir = dirname(file);
  const name = basename(file);
  const stem = name.replace(/(?:\.part\d{6})?\.baudloom\.jsonl$/, "");
  if (stem === name)
    return [{ file, bytes: (await stat(file)).size, index: 1 }];
  const first = `${stem}.baudloom.jsonl`;
  const names = await readdir(dir);
  const selected = names
    .flatMap((name) => {
      if (name === first) return [{ name, index: 1 }];
      if (!name.startsWith(stem + ".part")) return [];
      const suffix = name
        .slice(stem.length)
        .match(/^\.part(\d{6})\.baudloom\.jsonl$/);
      return suffix ? [{ name, index: Number(suffix[1]) }] : [];
    })
    .sort((a, b) => a.index - b.index);
  if (!selected.length) throw Error("未找到会话文件");
  return Promise.all(
    selected.map(async (part) => ({
      file: join(dir, part.name),
      index: part.index,
      bytes: (await stat(join(dir, part.name))).size,
    })),
  );
}

export async function scanSession(
  parts: SessionPart[],
  consume: (event: StoredEvent, bytes: number) => void | Promise<void>,
  options: { allowOpenEnd?: boolean; signal?: AbortSignal } = {},
): Promise<{
  total: number;
  complete: boolean;
  warning: string | null;
  segments: number;
}> {
  let total = 0,
    sessionId = "",
    lastKind = "",
    segments = 0;
  let warning: string | null = null;
  outer: for (const part of parts) {
    options.signal?.throwIfAborted();
    if (part.index !== segments + 1) {
      warning = `缺少或重复第 ${segments + 1} 个分段，仅保留已验证前缀`;
      break;
    }
    if (part.bytes > MAX_FILE) {
      warning = "单个文件超过 64 MiB 读取上限";
      break;
    }
    if (!part.bytes) {
      warning = `第 ${part.index} 个分段为空`;
      break;
    }
    let pending = Buffer.alloc(0);
    let read = 0;
    const stream = createReadStream(part.file, {
      highWaterMark: 64 * 1024,
      end: part.bytes - 1,
      signal: options.signal,
    });
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      read += buffer.length;
      pending = Buffer.concat([pending, buffer]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        options.signal?.throwIfAborted();
        if (newline > MAX_LINE) {
          warning = "记录行过长，已停止验证";
          break outer;
        }
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        let event: StoredEvent;
        try {
          const envelope = JSON.parse(line.toString("utf8"));
          event = envelope.event;
          if (!isEvent(event) || envelope.hash !== digest(event))
            throw Error("记录校验失败");
          if (
            event.seq !== total + 1 ||
            (total === 0
              ? event.kind !== "start"
              : event.sessionId !== sessionId ||
                event.kind === "start" ||
                lastKind === "stop")
          )
            throw Error("记录顺序/会话校验失败");
        } catch (error) {
          warning = `第 ${total + 1} 条${error instanceof Error ? error.message : "记录校验失败"}，仅显示已验证前缀`;
          break outer;
        }
        sessionId = event.sessionId;
        lastKind = event.kind;
        total++;
        // Consumer failures (disk full, cancellation) must propagate, not become corruption warnings.
        await consume(event, line.length);
      }
      if (pending.length > MAX_LINE) {
        warning = "记录行过长，已停止验证";
        break outer;
      }
    }
    if (read !== part.bytes || pending.length) {
      warning = "尾部记录截断，仅显示完整前缀";
      break;
    }
    segments++;
  }
  if (!warning && lastKind !== "stop" && !options.allowOpenEnd)
    warning = "会话未正常收尾，可能存在未保存尾部";
  return {
    total,
    complete: !warning && lastKind === "stop",
    warning,
    segments,
  };
}

export async function readSession(
  file: string,
  limit = 2000,
  byteLimit = 2 * 1024 * 1024,
) {
  const events = new Deque<{ event: StoredEvent; bytes: number }>();
  let retained = 0;
  const parts = await sessionParts(file);
  const result = await scanSession(parts, (event, bytes) => {
    events.push({ event, bytes });
    retained += bytes;
    while (events.length > limit || retained > byteLimit)
      retained -= events.shift()!.bytes;
  });
  return {
    ...result,
    events: events.slice().map((item) => item.event),
    file: parts[0].file,
  };
}
