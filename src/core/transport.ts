import { serialSettings, serialError } from "../serial-settings";
import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import type { SerialPortStream } from "@serialport/stream";
import type { ConnectionConfig, Port } from "../shared";
import { portLabel } from "./port-label";
export interface Transport extends EventEmitter {
  open(): Promise<void>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}
export class SerialTransport extends EventEmitter implements Transport {
  private port: SerialPortStream;
  private settings: ReturnType<typeof serialSettings>;
  constructor(
    config: ConnectionConfig,
    factory: (options: any) => SerialPortStream = (options) =>
      new SerialPort(options),
  ) {
    super();
    const settings = (this.settings = serialSettings(config.serial));
    this.port = factory({
      path: config.target,
      baudRate: config.baudRate,
      autoOpen: false,
      dataBits: settings.dataBits,
      stopBits: settings.stopBits,
      parity: settings.parity,
      rtscts: settings.flow === "rtscts",
      xon: settings.flow === "xonxoff",
      xoff: settings.flow === "xonxoff",
      highWaterMark: 16384,
    });
    this.port.on("data", (b: Buffer) => this.emit("bytes", b));
    this.port.on("error", (e) => this.emit("fault", serialError(e)));
    this.port.on("close", () => this.emit("closed"));
  }
  async open() {
    await new Promise<void>((resolve, reject) =>
      this.port.open((e) => (e ? reject(serialError(e)) : resolve())),
    );
    // The binding's set() also writes RTS; never override driver-owned handshake lines.
    if (this.settings.flow !== "rtscts") {
      try {
        await new Promise<void>((resolve, reject) =>
          this.port.set(
            { dtr: this.settings.dtr, rts: this.settings.rts },
            (e) => (e ? reject(serialError(e)) : resolve()),
          ),
        );
      } catch (error) {
        await this.close().catch(() => {});
        throw error;
      }
    }
  }
  async write(bytes: Buffer) {
    if (!this.port.isOpen) throw Error("串口未打开");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(Error("主机写入超时，已写字节数不确定")),
        5000,
      );
      const onClose = () => finish(Error("写入期间连接断开，已写字节数不确定"));
      const finish = (error?: Error | null) => {
        clearTimeout(timer);
        this.port.off("close", onClose);
        error ? reject(error) : resolve();
      };
      this.port.once("close", onClose);
      this.port.write(bytes, (error) => finish(error));
    });
  }
  async close() {
    if (this.port.isOpen)
      await new Promise<void>((resolve, reject) =>
        this.port.close((e) => (e ? reject(e) : resolve())),
      );
  }
}
/** Explicit, deterministic source for exercising the real capture and disk path. */
export class SyntheticTransport extends EventEmitter implements Transport {
  private timer?: NodeJS.Timeout;
  private sequence = 0;
  private opened = false;
  async open() {
    this.opened = true;
    this.timer = setInterval(() => {
      this.emit(
        "bytes",
        Buffer.from(`[demo] sample=${++this.sequence} 温度=23.5\r\n`),
      );
    }, 200);
  }
  async write(bytes: Buffer) {
    if (!this.opened) throw Error("测试端口已断开");
    this.emit(
      "bytes",
      Buffer.from(`[demo reply] ${bytes.toString("hex")}\r\n`),
    );
  }
  async close() {
    clearInterval(this.timer);
    if (this.opened) {
      this.opened = false;
      this.emit("closed");
    }
  }
}
export const makeTransport = (config: ConnectionConfig): Transport =>
  config.source === "synthetic"
    ? new SyntheticTransport()
    : new SerialTransport(config);
export async function listPorts(includeSynthetic = false): Promise<Port[]> {
  const ports = await SerialPort.list();
  return [
    ...(includeSynthetic
      ? [
          {
            path: "demo",
            label: "测试端口（合成数据）",
            source: "synthetic" as const,
          },
          {
            path: "demo-2",
            label: "测试端口 2（合成数据）",
            source: "synthetic" as const,
          },
        ]
      : []),
    ...ports.map((p) => ({
      path: p.path,
      label: portLabel(p),
      source: "serial" as const,
    })),
  ];
}
