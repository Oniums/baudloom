import type { ViewLimits } from "./view-settings";
export type Source = "serial" | "synthetic";
export type EventKind =
  "start" | "rx" | "tx-request" | "tx-result" | "mark" | "error" | "stop";
export interface ConnectionConfig {
  saveSession?: boolean;
  target: string;
  baudRate: number;
  source: Source;
}
export interface EventInput {
  kind: EventKind;
  data?: string;
  message?: string;
  requestId?: string;
  outcome?: "host-write-completed" | "uncertain";
}
export interface StoredEvent extends EventInput {
  v: 1;
  seq: number;
  sessionId: string;
  at: string;
  mono: string;
  source: Source;
  target: string;
  baudRate: number;
}
export interface LogRow {
  id: number;
  at: string;
  dir: string;
  text: string;
}
export interface Snapshot {
  state:
    | "idle"
    | "connecting"
    | "connected"
    | "stopping"
    | "stopped"
    | "error"
    | "offline";
  target: string;
  source: Source;
  sessionFile: string;
  viewLimits: ViewLimits;
  bufferedEvents: number;
  droppedEvents: number;
  backfilledEvents: number;
  backfillActive: boolean;
  sessionId: string;
  rows: LogRow[];
  totalRows: number;
  rxBytes: number;
  txBytes: number;
  pendingBytes: number;
  writtenBytes: number;
  syncedAt: string | null;
  error: string | null;
  warning: string | null;
  eventCount: number;
  schedule: ScheduleStatus;
}
export interface Port {
  path: string;
  label: string;
  source: Source;
}
export type Checksum =
  | "none"
  | "sum8"
  | "sum16"
  | "xor8"
  | "lrc8"
  | "modbus"
  | "ccitt-false"
  | "crc32";
export interface ScheduleRequest {
  commands: SendRequest[];
  intervalMs: number;
  kind: "single" | "multi";
}
export interface ScheduleStatus {
  active: boolean;
  kind: "single" | "multi";
  completed: number;
  count: number;
  intervalMs: number;
  error: string | null;
}
export interface SendRequest {
  checksum?: Checksum;
  checksumStart?: number;
  checksumEnd?: number;
  checksumOrder?: "little" | "big";
  target: string;
  sessionId: string;
  text: string;
  format: "text" | "hex";
  ending: "none" | "cr" | "lf" | "crlf";
}
export interface Api {
  ports(): Promise<Port[]>;
  connect(config: ConnectionConfig): Promise<void>;
  stop(): Promise<void>;
  startRecording(sessionId: string): Promise<void>;
  setViewLimits(limits: ViewLimits): Promise<void>;
  send(request: SendRequest): Promise<void>;
  startSchedule(request: ScheduleRequest): Promise<void>;
  stopSchedule(): Promise<void>;
  snapshot(mode?: "text" | "hex"): Promise<Snapshot>;
  mark(message: string): Promise<void>;
  directory(): Promise<string>;
  chooseDirectory(): Promise<string | null>;
  openSession(): Promise<Snapshot | null>;
}
