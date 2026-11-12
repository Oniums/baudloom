import { StringDecoder } from "node:string_decoder";
import { encodeSend } from "../send-tools";

/** Reading chunks are not lines or UTF-8 character boundaries. */
export class LineDecoder {
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private afterCR = false;
  constructor(readonly max = 8192) {}
  get pendingText(): string {
    return this.partial;
  }
  push(bytes: Buffer): string[] {
    return this.consume(this.decoder.write(bytes));
  }
  finish(): string[] {
    const lines = this.consume(this.decoder.end());
    if (this.partial) lines.push(this.partial);
    this.partial = "";
    this.afterCR = false;
    return lines;
  }
  private consume(text: string): string[] {
    const lines: string[] = [];
    if (!text) return lines;
    const limit = Math.max(1, Math.ceil(this.max)) || Infinity;
    let start = this.afterCR && text.startsWith("\n") ? 1 : 0;
    this.afterCR = text.endsWith("\r");
    const endings = /\r\n|[\r\n]/g;
    endings.lastIndex = start;
    for (;;) {
      const ending = endings.exec(text);
      const end = ending?.index ?? text.length;
      while (start < end) {
        let cut = Math.min(end, start + limit - this.partial.length);
        // A code point can cross the UTF-16 length limit by one code unit.
        if (
          cut < end &&
          text.charCodeAt(cut) >= 0xdc00 &&
          text.charCodeAt(cut) <= 0xdfff
        )
          cut++;
        this.partial += text.slice(start, cut);
        start = cut;
        if (this.partial.length >= limit) {
          lines.push(this.partial);
          this.partial = "";
        }
      }
      if (!ending) break;
      lines.push(this.partial);
      this.partial = "";
      start = endings.lastIndex;
    }
    return lines;
  }
}
export function encodeCommand(
  text: string,
  format: string,
  ending: string,
): Buffer {
  return Buffer.from(encodeSend({ text, format, ending }));
}
