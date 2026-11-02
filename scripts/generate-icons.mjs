import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";
const svg = await readFile("assets/brand/baudloom.svg", "utf8");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map((size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng(),
);
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (let i = 0; i < frames.length; i++) {
  const pos = 6 + 16 * i;
  header[pos] = sizes[i] === 256 ? 0 : sizes[i];
  header[pos + 1] = header[pos];
  header.writeUInt16LE(1, pos + 4);
  header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(frames[i].length, pos + 8);
  header.writeUInt32LE(offset, pos + 12);
  offset += frames[i].length;
}
await writeFile(
  "assets/brand/baudloom.ico",
  Buffer.concat([header, ...frames]),
);
await writeFile(
  "assets/brand/baudloom.png",
  new Resvg(svg, { fitTo: { mode: "width", value: 512 } }).render().asPng(),
);
console.log("Rendered original SVG to 512px PNG and 16–256px Windows ICO");
