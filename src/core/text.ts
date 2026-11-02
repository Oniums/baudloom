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
    for (const char of text) {
      if (char === "\n" && this.afterCR) {
        this.afterCR = false;
        continue;
      }
      this.afterCR = false;
      if (char === "\r" || char === "\n") {
        lines.push(this.partial);
        this.partial = "";
        this.afterCR = char === "\r";
      } else {
        this.partial += char;
        if (this.partial.length >= this.max) {
          lines.push(this.partial);
          this.partial = "";
        }
      }
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
