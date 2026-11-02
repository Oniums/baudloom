import { Deque } from "./deque";
import {
  DEFAULT_VIEW_LIMITS,
  validateViewLimits,
  type ViewLimits,
} from "../view-settings";
import { randomUUID } from "node:crypto";
import type { ConnectionConfig, EventInput, StoredEvent } from "../shared";
import type { Journal } from "./journal";
export type EventJournal = Pick<
  Journal,
  | "sessionId"
  | "file"
  | "pendingBytes"
  | "writtenBytes"
  | "syncedAt"
  | "eventCount"
  | "onFault"
  | "append"
  | "close"
>;
/** Bounded raw-event cache for opt-in backfill; no filesystem access. */
export class MemoryJournal implements EventJournal {
  readonly sessionId = randomUUID();
  readonly file = "";
  readonly pendingBytes = 0;
  readonly writtenBytes = 0;
  readonly syncedAt = null;
  eventCount = 0;
  dropped = 0;
  private retained = 0;
  private events = new Deque<{ event: StoredEvent; bytes: number }>();
  constructor(
    private config: ConnectionConfig,
    private limits = DEFAULT_VIEW_LIMITS,
  ) {}
  setLimits(limits: ViewLimits) {
    this.limits = validateViewLimits(limits);
    this.trim();
  }
  private trim() {
    while (
      this.events.length > this.limits.maxRows ||
      this.retained > this.limits.maxChars
    ) {
      this.retained -= this.events.shift()!.bytes;
      this.dropped++;
    }
  }
  get bufferedCount() {
    return this.events.length;
  }
  buffered() {
    return this.events.slice().map((item) => item.event);
  }
  releaseBuffer() {
    this.events = new Deque();
    this.retained = 0;
  }
  onFault = (_error: Error) => {};
  private closed = false;
  async append(input: EventInput): Promise<StoredEvent> {
    if (this.closed) throw Error("会话已关闭");
    const event: StoredEvent = {
      ...input,
      v: 1,
      seq: ++this.eventCount,
      sessionId: this.sessionId,
      at: new Date().toISOString(),
      mono: process.hrtime.bigint().toString(),
      target: this.config.target,
      source: this.config.source,
      baudRate: this.config.baudRate,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes });
    this.retained += bytes;
    this.trim();
    return event;
  }
  async close() {
    this.closed = true;
  }
}
