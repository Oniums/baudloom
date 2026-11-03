import type { SendRequest } from "./shared";
export type CommandDraft = Pick<
  SendRequest,
  | "text"
  | "format"
  | "ending"
  | "checksum"
  | "checksumStart"
  | "checksumEnd"
  | "checksumOrder"
>;
export type HistoryEntry = CommandDraft & { target: string };
export type CommandSlot = CommandDraft & { name: string; selected?: boolean };
export interface SendTools {
  version: 1;
  clearAfterSend: boolean;
  history: HistoryEntry[];
  commands: CommandSlot[];
}
export const blankCommand = (): CommandSlot => ({
  name: "",
  text: "",
  format: "text",
  ending: "crlf",
  ...checksumSettings({}),
  selected: false,
});
export function payload(text: string, format: string): Uint8Array {
  if (typeof text !== "string" || text.length > 196608)
    throw Error("命令超过 64 KiB");
  let bytes: Uint8Array;
  if (format === "hex") {
    if (text && !/^(?:[\da-fA-F]{2}\s*)+$/.test(text.trim()))
      throw Error("HEX 必须是完整的两位十六进制字节");
    bytes = Uint8Array.from(text.replace(/\s/g, "").match(/../g) ?? [], (b) =>
      parseInt(b, 16),
    );
  } else if (format === "text") {
    bytes = new TextEncoder().encode(text);
  } else throw Error("无效发送格式");
  if (bytes.length > 65536) throw Error("命令超过 64 KiB");
  return bytes;
}
export function convertFormat(text: string, from: string, to: string): string {
  if (from === to) return text;
  const bytes = payload(text, from);
  if (to === "hex")
    return Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0").toUpperCase(),
    ).join(" ");
  if (to !== "text") throw Error("无效发送格式");
  let result: string;
  try {
    result = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw Error("这些字节不是有效 UTF-8，已保留 HEX 内容");
  }
  // Textareas normalize CR and cannot faithfully edit binary controls.
  if (/[\x00-\x08\x0b-\x0d\x0e-\x1f\x7f]/.test(result))
    throw Error("包含文本框无法原样编辑的控制字节，请继续使用 HEX");
  return result;
}
export const checksumOptions = [
  ["none", "不加校验"],
  ["sum8", "ADD / SUM8"],
  ["sum16", "SUM16"],
  ["xor8", "XOR8"],
  ["lrc8", "LRC8"],
  ["modbus", "Modbus CRC16"],
  ["ccitt-false", "CRC16/CCITT-FALSE"],
  ["crc32", "CRC32/IEEE"],
] as const;
export function checksumSettings(command: Partial<SendRequest>) {
  return {
    checksum: command.checksum ?? "none",
    checksumStart: command.checksumStart ?? 1,
    checksumEnd: command.checksumEnd ?? 0,
    checksumOrder: command.checksumOrder ?? "little",
  };
}
interface EncodingOptions {
  text: string;
  format: string;
  ending: string;
  checksum?: string;
  checksumStart?: number;
  checksumEnd?: number;
  checksumOrder?: string;
}
export function checksumBytes(
  bytes: Uint8Array,
  command: Omit<EncodingOptions, "text" | "format" | "ending">,
): Uint8Array {
  const {
    checksum = "none",
    checksumStart = 1,
    checksumEnd = 0,
    checksumOrder = "little",
  } = command;
  if (checksum === "none") return new Uint8Array();
  const end = checksumEnd === 0 ? bytes.length : checksumEnd;
  if (
    !Number.isInteger(checksumStart) ||
    !Number.isInteger(end) ||
    checksumStart < 1 ||
    end < checksumStart ||
    end > bytes.length
  )
    throw Error("校验范围无效：按字节从 1 开始，结束位置不可超出内容");
  if (!["little", "big"].includes(checksumOrder))
    throw Error("无效校验字节顺序");
  const data = bytes.subarray(checksumStart - 1, end);
  let value = 0,
    size = 1;
  if (checksum === "sum8" || checksum === "sum16" || checksum === "lrc8") {
    value = data.reduce((sum, b) => sum + b, 0);
    if (checksum === "sum16") size = 2;
    if (checksum === "lrc8") value = -value;
  } else if (checksum === "xor8") value = data.reduce((sum, b) => sum ^ b, 0);
  else if (checksum === "modbus") {
    value = 0xffff;
    size = 2;
    for (const byte of data) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = (value >>> 1) ^ (value & 1 ? 0xa001 : 0);
    }
  } else if (checksum === "ccitt-false") {
    value = 0xffff;
    size = 2;
    for (const byte of data) {
      value ^= byte << 8;
      for (let i = 0; i < 8; i++)
        value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
  } else if (checksum === "crc32") {
    value = 0xffffffff;
    size = 4;
    for (const byte of data) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    value = (value ^ 0xffffffff) >>> 0;
  } else throw Error("无效校验方式");
  const result = Uint8Array.from(
    { length: size },
    (_, i) => (value >>> (8 * i)) & 255,
  );
  return checksumOrder === "big" ? result.reverse() : result;
}
export function encodeSend(command: EncodingOptions): Uint8Array {
  const { text, format, ending } = command;
  const bytes = payload(text, format);
  if (!bytes.length) throw Error("命令为空或超过 64 KiB");
  if (!["none", "cr", "lf", "crlf"].includes(ending))
    throw Error("无效换行设置");
  const trailer = checksumBytes(bytes, command);
  const endingBytes =
    format === "text"
      ? new TextEncoder().encode(
          { none: "", cr: "\r", lf: "\n", crlf: "\r\n" }[ending],
        )
      : new Uint8Array();
  const output = new Uint8Array(
    bytes.length + trailer.length + endingBytes.length,
  );
  output.set(bytes);
  output.set(trailer, bytes.length);
  output.set(endingBytes, bytes.length + trailer.length);
  return output;
}
export function isCommandDraft(value: any): value is CommandDraft {
  return (
    value &&
    typeof value.text === "string" &&
    value.text.length <= 196608 &&
    ["text", "hex"].includes(value.format) &&
    ["none", "cr", "lf", "crlf"].includes(value.ending) &&
    (value.checksum === undefined ||
      checksumOptions.some(([key]) => key === value.checksum)) &&
    [value.checksumStart ?? 1, value.checksumEnd ?? 0].every(
      Number.isInteger,
    ) &&
    (value.checksumStart ?? 1) >= 1 &&
    (value.checksumEnd ?? 0) >= 0 &&
    [undefined, "little", "big"].includes(value.checksumOrder)
  );
}
export function rememberSend(
  history: HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const key = JSON.stringify([
    entry.target,
    entry.text,
    entry.format,
    entry.ending,
    ...Object.values(checksumSettings(entry)),
  ]);
  const result = [
    { ...entry },
    ...history.filter(
      (h) =>
        JSON.stringify([
          h.target,
          h.text,
          h.format,
          h.ending,
          ...Object.values(checksumSettings(h)),
        ]) !== key,
    ),
  ].slice(0, 20);
  while (result.length && JSON.stringify(result).length > 256 * 1024)
    result.pop();
  return result;
}
export function restoreSendTools(raw: string | null): SendTools {
  const empty = (): SendTools => ({
    version: 1,
    clearAfterSend: false,
    history: [],
    commands: Array.from({ length: 4 }, blankCommand),
  });
  if (!raw || raw.length > 1024 * 1024) return empty();
  try {
    const input = JSON.parse(raw);
    if (input?.version !== 1) return empty();
    const state = empty();
    state.clearAfterSend = input.clearAfterSend === true;
    if (Array.isArray(input.commands)) {
      const slots = input.commands
        .filter(
          (v: any) =>
            v &&
            typeof v.name === "string" &&
            v.name.length <= 60 &&
            isCommandDraft(v) &&
            v.text.length <= 8192,
        )
        .slice(0, 12);
      if (slots.length)
        state.commands = slots.map((v: CommandSlot) => ({
          name: v.name,
          text: v.text,
          format: v.format,
          ending: v.ending,
          ...checksumSettings(v),
          selected: v.selected === true,
        }));
    }
    if (Array.isArray(input.history)) {
      for (const v of input.history.slice(0, 20).reverse()) {
        const target = v?.target;
        if (
          isCommandDraft(v) &&
          typeof target === "string" &&
          target.length <= 1024
        ) {
          try {
            encodeSend(v);
            state.history = rememberSend(state.history, {
              text: v.text,
              format: v.format,
              ending: v.ending,
              ...checksumSettings(v),
              target,
            });
          } catch {}
        }
      }
    }
    return state;
  } catch {
    return empty();
  }
}
