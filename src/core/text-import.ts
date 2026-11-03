import { open } from "node:fs/promises";
import type { ViewLimits } from "../view-settings";
import { View } from "./view";

/** Ordinary files carry no trusted session timing; never invent receive timestamps. */
export async function readTextLog(file: string, limits: ViewLimits) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error("请选择普通文本文件");
    const prefix = Buffer.alloc(3);
    await handle.read(prefix, 0, 3, 0);
    const encoding =
      prefix[0] === 0xff && prefix[1] === 0xfe
        ? "utf-16le"
        : prefix[0] === 0xfe && prefix[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    const decoder = new TextDecoder(encoding, { fatal: true });
    const view = new View(limits);
    let partial = "",
      afterCR = false,
      bytes = 0;
    const consume = (text: string) => {
      if (text.includes("\0"))
        throw Error("文件包含 NUL 字节，可能不是文本日志");
      for (const char of text) {
        if (char === "\n" && afterCR) {
          afterCR = false;
          continue;
        }
        afterCR = char === "\r";
        if (char === "\r" || char === "\n") {
          view.appendText(partial);
          partial = "";
        } else {
          partial += char;
          if (partial.length >= 8192) {
            view.appendText(partial);
            partial = "";
          }
        }
      }
    };
    if (stat.size) {
      const stream = handle.createReadStream({
        start: 0,
        end: stat.size - 1,
        highWaterMark: 16384,
        autoClose: false,
      });
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          consume(decoder.decode(chunk, { stream: true }));
        }
      } finally {
        stream.destroy();
      }
    }
    consume(decoder.decode());
    if (partial) view.appendText(partial);
    if (bytes !== stat.size) throw Error("读取期间文件长度变化，请重新打开");
    return { view, bytes, encoding };
  } catch (error) {
    if (error instanceof TypeError)
      throw Error("无法按 UTF-8 或带 BOM 的 UTF-16 读取，请先转换文本编码");
    throw error;
  } finally {
    await handle.close();
  }
}
