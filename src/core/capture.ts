import { MAX_COMMAND_SLOTS } from "../send-tools";
import { serialSettings, serialSummary } from "../serial-settings";
import { readTextLog } from "./text-import";
import { extname } from "node:path";
import { validBaudRate } from "../baud-rate";
import {
  DEFAULT_VIEW_LIMITS,
  validateViewLimits,
  type ViewLimits,
} from "../view-settings";
import { randomUUID } from "node:crypto";
import type {
  ConnectionConfig,
  ViewCursor,
  ScheduleRequest,
  ScheduleStatus,
  SendRequest,
  Snapshot,
  StoredEvent,
} from "../shared";
import { MemoryJournal, type EventJournal } from "./memory-journal";
import { exportText, validateExport } from "./export";
import type { ExportRequest } from "../shared";
import { Journal, readSession, sessionParts } from "./journal";
import { makeTransport, type Transport } from "./transport";
import { encodeSend } from "../send-tools";
import { View } from "./view";

export class Capture {
  private schedule: ScheduleStatus = {
    active: false,
    kind: "single",
    completed: 0,
    count: 0,
    intervalMs: 1000,
    error: null,
  };
  private scheduleToken = 0;
  private scheduleTimer?: NodeJS.Timeout;
  private state: Snapshot["state"] = "idle";
  private error: string | null = null;
  private warning: string | null = null;
  private journal?: EventJournal;
  private transport?: Transport;
  private config?: ConnectionConfig;
  private viewLimits = { ...DEFAULT_VIEW_LIMITS };
  private view = new View(this.viewLimits);
  private connectionId = "";
  private backfilledEvents = 0;
  private backfillActive = false;
  private droppedEvents = 0;
  private rxBytes = 0;
  private txBytes = 0;
  private operations: Promise<unknown> = Promise.resolve();
  private closeTask?: Promise<void>;
  private openTask?: Promise<void>;
  private reading = false;
  private offlineFile = "";
  private offlineEvents = 0;
  private offlineSegments = 0;
  private fileKind: "session" | "text" = "session";
  private exportController?: AbortController;
  constructor(
    private directory: string,
    private factory = makeTransport,
    private writer: typeof Journal.create = Journal.create,
  ) {}
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operations.then(fn);
    this.operations = next.catch(() => {});
    return next;
  }
  connect(config: ConnectionConfig): Promise<void> {
    if (this.reading)
      return Promise.reject(Error("正在读取历史记录，请稍后连接"));
    if (
      !config ||
      (config.saveSession !== undefined &&
        typeof config.saveSession !== "boolean") ||
      !["serial", "synthetic"].includes(config.source) ||
      typeof config.target !== "string" ||
      !config.target ||
      config.target.length > 1024 ||
      config.target.includes("\0") ||
      !validBaudRate(config.baudRate) ||
      (config.source === "synthetic" && config.target !== "demo")
    )
      return Promise.reject(Error("无效串口参数"));
    if (["connected", "connecting", "stopping"].includes(this.state))
      return Promise.reject(Error("请先停止当前连接"));
    try {
      config = { ...config, serial: serialSettings(config.serial) };
    } catch (e) {
      return Promise.reject(e);
    }
    this.state = "connecting";
    return this.enqueue(async () => {
      if (this.closeTask) await this.closeTask;
      this.connectionId = "";
      this.backfilledEvents = 0;
      this.backfillActive = false;
      this.droppedEvents = 0;
      this.journal = undefined;
      this.transport = undefined;
      this.closeTask = undefined;
      this.openTask = undefined;
      this.config = { ...config };
      this.error = null;
      this.schedule = {
        ...this.schedule,
        active: false,
        error: null,
        completed: 0,
        count: 0,
      };
      this.warning = null;
      this.offlineFile = "";
      this.fileKind = "session";
      this.view = new View(this.viewLimits);
      this.rxBytes = 0;
      this.txBytes = 0;
      try {
        this.journal =
          config.saveSession === true
            ? await this.writer(this.directory, config)
            : new MemoryJournal(config, this.viewLimits);
        this.connectionId = this.journal.sessionId;
        this.journal.onFault = (e) => this.fault(e);
        this.transport = this.factory(config);
        this.transport.on("bytes", (bytes: Buffer) => this.receive(bytes));
        this.transport.on("fault", (error: Error) => this.fault(error));
        this.transport.on("closed", () => {
          if (this.state === "connected" || this.state === "connecting")
            this.fault(Error("设备意外断开；不会自动重连或重发"));
        });
        // Register the pending open before invoking adapters that may emit a fault synchronously.
        this.openTask = Promise.resolve().then(() => this.transport!.open());
        await this.openTask;
        if (this.state === "error") throw Error(this.error ?? "连接失败");
        // A stop requested while open was pending must not publish a connected state.
        if (this.state === "connecting") this.state = "connected";
        await this.record({
          kind: "mark",
          message: `${config.source === "synthetic" ? "合成设备" : "串口"} ${config.target} · ${config.baudRate} · ${serialSummary(config.serial!)}`,
        });
      } catch (error) {
        this.fault(error);
        await this.closeResources();
        throw error;
      }
    });
  }
  setViewLimits(limits: ViewLimits) {
    this.viewLimits = validateViewLimits(limits);
    this.view.setLimits(this.viewLimits);
    if (this.journal instanceof MemoryJournal)
      this.journal.setLimits(this.viewLimits);
  }
  startRecording(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.state !== "connected" || sessionId !== this.connectionId)
        throw Error("连接或会话已变化");
      if (!(this.journal instanceof MemoryJournal)) return;
      const memory = this.journal;
      const disk = await this.writer(this.directory, {
        ...this.config!,
        saveSession: true,
      });
      if (this.state !== "connected" || this.journal !== memory) {
        await disk.close();
        throw Error("连接或会话已变化，未启用保存");
      }
      disk.onFault = (e) => this.fault(e);
      const events = memory.buffered();
      this.backfillActive = true;
      this.droppedEvents = memory.dropped;
      this.journal = disk;
      this.config!.saveSession = true;
      // This call enqueues all history before yielding; new receives append after it.
      const backfill = disk.backfill(events);
      memory.releaseBuffer();
      void memory.close();
      try {
        const boundary = this.record({
          kind: "mark",
          message: `开始保存；补写缓存 ${events.length} 条原始事件（保留原时间），此前已淘汰 ${this.droppedEvents} 条事件。`,
        });
        await Promise.all([backfill, boundary]);
        await disk.sync();
        this.backfilledEvents = events.length;
      } catch (error) {
        this.fault(error);
        throw error;
      } finally {
        this.backfillActive = false;
      }
    });
  }
  private receive(bytes: Buffer) {
    if (!["connected", "connecting"].includes(this.state)) return;
    this.rxBytes += bytes.length;
    for (let i = 0; i < bytes.length; i += 16384) {
      if (this.state === "error") break;
      void this.record({
        kind: "rx",
        data: bytes.subarray(i, i + 16384).toString("base64"),
      }).catch((e) => this.fault(e));
    }
  }
  private async record(
    input: Parameters<Journal["append"]>[0],
  ): Promise<StoredEvent> {
    if (!this.journal) throw Error("没有可写会话");
    const event = await this.journal.append(input);
    this.view.apply(event);
    return event;
  }
  startSchedule(request: ScheduleRequest): void {
    if (this.schedule.active) throw Error("请先停止当前定时发送");
    if (this.state !== "connected" || !this.journal) throw Error("设备未连接");
    if (
      !request ||
      !["single", "multi"].includes(request.kind) ||
      !Number.isInteger(request.intervalMs) ||
      request.intervalMs < 100 ||
      request.intervalMs > 3600000 ||
      !Array.isArray(request.commands) ||
      !request.commands.length ||
      request.commands.length > MAX_COMMAND_SLOTS ||
      (request.kind === "single" && request.commands.length !== 1)
    )
      throw Error(
        `请选择 1–${MAX_COMMAND_SLOTS} 条有效命令，间隔为 100–3600000 ms`,
      );
    const commands = request.commands.map((command) => {
      if (
        !command ||
        command.target !== this.config?.target ||
        command.sessionId !== this.connectionId
      )
        throw Error("定时发送目标或会话已变化");
      encodeSend(command);
      return { ...command };
    });
    const intervalMs = request.intervalMs;
    const token = ++this.scheduleToken;
    this.schedule = {
      active: true,
      kind: request.kind,
      completed: 0,
      count: commands.length,
      intervalMs,
      error: null,
    };
    let index = 0;
    const tick = async () => {
      if (token !== this.scheduleToken) return;
      try {
        await this.send(commands[index], token);
        if (token !== this.scheduleToken) return;
        this.schedule.completed++;
        index = (index + 1) % commands.length;
        // Wait after completion: slow writes never create a backlog or catch-up burst.
        this.scheduleTimer = setTimeout(() => void tick(), intervalMs);
      } catch (error) {
        if (token === this.scheduleToken) this.stopSchedule();
        this.schedule.error = String(error);
      }
    };
    this.scheduleTimer = setTimeout(() => void tick(), 0);
  }
  stopSchedule(): void {
    ++this.scheduleToken;
    clearTimeout(this.scheduleTimer);
    this.schedule.active = false;
  }
  send(request: SendRequest, scheduleToken?: number): Promise<void> {
    // Check identity again after prior commands: a queued command cannot cross sessions.
    return this.enqueue(async () => {
      if (scheduleToken !== undefined && scheduleToken !== this.scheduleToken)
        return;
      if (scheduleToken === undefined && this.schedule.active)
        throw Error("请先停止定时发送再手动发送");
      if (this.state !== "connected" || !this.journal || !this.transport)
        throw Error("设备未连接");
      if (
        request.target !== this.config?.target ||
        request.sessionId !== this.connectionId
      )
        throw Error("发送目标或会话已变化，请重新确认");
      const bytes = Buffer.from(encodeSend(request));
      const requestId = randomUUID();
      try {
        await this.record({
          kind: "tx-request",
          requestId,
          data: bytes.toString("base64"),
        });
        if (
          scheduleToken !== undefined &&
          scheduleToken !== this.scheduleToken
        ) {
          await this.record({
            kind: "tx-result",
            requestId,
            outcome: "uncertain",
            message: "定时任务已取消，本条未写入串口",
          });
          return;
        }
        if (this.state !== "connected") throw Error("发送前连接已停止");
        await this.transport.write(bytes);
        this.txBytes += bytes.length;
        await this.record({
          kind: "tx-result",
          requestId,
          outcome: "host-write-completed",
        });
      } catch (error) {
        await this.record({
          kind: "tx-result",
          requestId,
          outcome: "uncertain",
          message: String(error),
        }).catch(() => {});
        this.fault(error);
        throw error;
      }
    });
  }
  async mark(message: string) {
    if (this.state !== "connected") throw Error("只能标记正在采集的会话");
    if (typeof message !== "string" || message.length > 1024)
      throw Error("书签过长");
    await this.record({ kind: "mark", message });
  }
  private fault(error: unknown) {
    this.stopSchedule();
    if (this.state === "error") return;
    this.error = error instanceof Error ? error.message : String(error);
    this.state = "error";
    this.warning = this.config?.saveSession
      ? "采集已停止；故障附近可能有未保存字节，请核对会话。"
      : "连接已停止；本次未保存会话，窗口中仅保留有限缓存。";
    if (this.journal)
      void this.record({ kind: "error", message: this.error }).catch(() => {});
    void this.closeResources();
  }
  private closeResources(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closeTask = (async () => {
      // An open callback can arrive after a fault; close the acquired handle as well.
      await this.openTask?.catch(() => {});
      try {
        await this.transport?.close();
      } catch (e) {
        this.error ??= String(e);
        this.state = "error";
      }
      try {
        await this.journal?.close();
      } catch (e) {
        this.error ??= String(e);
        this.state = "error";
      }
      this.view.finish();
    })();
    return this.closeTask;
  }
  stop(): Promise<void> {
    this.stopSchedule();
    if (this.state === "idle" || this.state === "offline")
      return Promise.resolve();
    if (this.state !== "error") this.state = "stopping";
    return this.enqueue(async () => {
      await this.closeResources();
      if (this.state !== "error") this.state = "stopped";
    });
  }
  async openFile(file: string): Promise<Snapshot> {
    if (this.reading) throw Error("正在读取历史记录");
    if (["connecting", "connected", "stopping"].includes(this.state))
      throw Error("请先断开设备再打开历史记录");
    this.reading = true;
    try {
      await this.stop();
      if ([".txt", ".log"].includes(extname(file).toLowerCase())) {
        const result = await readTextLog(file, this.viewLimits);
        this.view = result.view;
        this.connectionId = "";
        this.journal = undefined;
        this.transport = undefined;
        this.closeTask = undefined;
        this.config = undefined;
        this.backfilledEvents =
          this.droppedEvents =
          this.rxBytes =
          this.txBytes =
            0;
        this.backfillActive = false;
        this.offlineFile = file;
        this.offlineSegments = this.offlineEvents = 0;
        this.fileKind = "text";
        this.state = "offline";
        this.error = null;
        this.warning =
          this.view.total > this.view.textSnapshot().rows.length
            ? "文本超出视图预算，仅保留尾部内容；原文件未修改。"
            : null;
        return this.snapshot();
      }
      const result = await readSession(
        file,
        this.viewLimits.maxRows,
        this.viewLimits.maxChars,
      );
      this.view = new View(this.viewLimits);
      this.connectionId = "";
      this.backfilledEvents = 0;
      this.backfillActive = false;
      this.droppedEvents = 0;
      this.journal = undefined;
      this.transport = undefined;
      this.closeTask = undefined;
      this.rxBytes = 0;
      this.txBytes = 0;
      const requests = new Map<string, number>();
      for (const e of result.events) {
        this.view.apply(e);
        if (e.kind === "rx")
          this.rxBytes += Buffer.from(e.data ?? "", "base64").length;
        if (e.kind === "tx-request" && e.requestId)
          requests.set(e.requestId, Buffer.from(e.data ?? "", "base64").length);
        if (e.kind === "tx-result" && e.requestId) {
          if (e.outcome === "host-write-completed")
            this.txBytes += requests.get(e.requestId) ?? 0;
          requests.delete(e.requestId);
        }
      }
      this.view.finish();
      const first = result.events[0];
      this.config = first
        ? {
            target: first.target,
            source: first.source,
            baudRate: first.baudRate,
          }
        : undefined;
      this.offlineFile = result.file;
      this.fileKind = "session";
      this.offlineSegments = result.segments;
      this.offlineEvents = result.total;
      this.state = "offline";
      this.error = null;
      this.warning =
        [
          result.warning,
          result.total > result.events.length
            ? "仅载入最后部分事件；字节统计仅覆盖载入范围"
            : null,
        ]
          .filter(Boolean)
          .join("；") || null;
      return this.snapshot();
    } finally {
      this.reading = false;
    }
  }
  cancelExport() {
    this.exportController?.abort(Error("导出已取消"));
  }
  async exportLog(file: string, request: ExportRequest) {
    validateExport(request);
    if (this.exportController) throw Error("已有导出正在进行");
    if (request.sessionId !== (this.connectionId || this.offlineFile))
      throw Error("会话已变化，请重新选择导出范围");
    const controller = new AbortController();
    this.exportController = controller;
    const journal = this.journal;
    const offline = this.offlineFile;
    const live = ["connecting", "connected", "stopping"].includes(this.state);
    try {
      if (request.scope === "session") {
        if (this.fileKind === "text")
          throw Error("普通文本请导出当前缓存或筛选结果，原文件保持不变");
        const parts =
          journal instanceof Journal
            ? await journal.checkpoint()
            : offline
              ? await sessionParts(offline)
              : [];
        return await exportText(
          file,
          request,
          { parts, live },
          controller.signal,
        );
      }
      const rows = this.view.snapshot(request.mode).rows;
      return await exportText(file, request, { rows }, controller.signal);
    } finally {
      this.exportController = undefined;
    }
  }
  snapshot(mode: "text" | "hex" = "text", cursor?: ViewCursor): Snapshot {
    const sessionId = this.connectionId || this.offlineFile;
    const reset =
      !cursor ||
      cursor.sessionId !== sessionId ||
      cursor.mode !== mode ||
      !Number.isSafeInteger(cursor.lastId) ||
      cursor.lastId < 0 ||
      !Number.isSafeInteger(cursor.revision) ||
      cursor.revision < 0 ||
      cursor.revision > this.view.revision ||
      cursor.lastId >
        (mode === "hex" ? this.view.hexTotal : this.view.total + 1);
    const view = this.view.snapshot(
      mode,
      reset ? 0 : cursor!.lastId,
      !reset && cursor!.revision === this.view.revision,
    );
    return {
      fileKind: this.fileKind,
      serial: this.config?.serial,
      state: this.state,
      schedule: { ...this.schedule },
      target: this.config?.target ?? "",
      source: this.config?.source ?? "synthetic",
      sessionFile: this.journal?.file ?? this.offlineFile,
      currentSessionFile:
        this.journal instanceof Journal
          ? this.journal.currentFile
          : this.offlineFile,
      segmentCount:
        this.journal instanceof Journal
          ? this.journal.segmentCount
          : this.offlineFile
            ? this.offlineSegments
            : 0,
      sessionId: this.connectionId || this.offlineFile,
      viewLimits: { ...this.viewLimits },
      bufferedEvents:
        this.journal instanceof MemoryJournal ? this.journal.bufferedCount : 0,
      droppedEvents:
        this.journal instanceof MemoryJournal
          ? this.journal.dropped
          : this.droppedEvents,
      backfilledEvents: this.backfilledEvents,
      backfillActive: this.backfillActive,
      rows: view.rows,
      viewUpdate: {
        cursor: {
          sessionId,
          mode,
          lastId: view.total,
          revision: this.view.revision,
        },
        count: view.count,
        firstId: view.firstId,
        reset,
      },
      totalRows: view.total,
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      pendingBytes: this.journal?.pendingBytes ?? 0,
      writtenBytes: this.journal?.writtenBytes ?? 0,
      syncedAt: this.journal?.syncedAt ?? null,
      error: this.error,
      warning: this.warning,
      eventCount: this.journal?.eventCount ?? this.offlineEvents,
    };
  }
  setDirectory(directory: string) {
    if (
      this.reading ||
      ["connecting", "connected", "stopping"].includes(this.state)
    )
      throw Error("请先停止采集或等待读取完成");
    this.directory = directory;
  }
}
