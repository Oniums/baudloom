import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { View } from "../src/core/view";
import { Capture } from "../src/core/capture";
import type { StoredEvent } from "../src/shared";

async function main() {
  const limits = { maxRows: 50000, maxChars: 16 * 1048576 };
  const event: StoredEvent = {
    v: 1,
    seq: 1,
    sessionId: "benchmark",
    kind: "rx",
    at: "2026-11-02T00:00:00.000Z",
    mono: "1",
    source: "synthetic",
    target: "demo",
    baudRate: 115200,
    data: Buffer.from("serial data " + "x".repeat(80) + "\n").toString(
      "base64",
    ),
  };
  const view = new View(limits);
  const start = performance.now();
  for (let i = 0; i < 60000; i++) view.apply({ ...event, seq: i + 1 });
  const ingestMs = performance.now() - start;
  class Wire extends EventEmitter {
    async open() {}
    async write() {}
    async close() {}
  }
  const wire = new Wire();
  // Recording is disabled: this fixture neither opens hardware nor creates session files.
  const capture = new Capture("unused", () => wire);
  capture.setViewLimits(limits);
  await capture.connect({
    source: "synthetic",
    target: "demo",
    baudRate: 115200,
  });
  wire.emit("bytes", Buffer.from("serial data\n".repeat(51000)));
  await new Promise((resolve) => setImmediate(resolve));
  const full = capture.snapshot();
  const idle = capture.snapshot("text", full.viewUpdate!.cursor);
  wire.emit("bytes", Buffer.from("next\n"));
  await new Promise((resolve) => setImmediate(resolve));
  const delta = capture.snapshot("text", full.viewUpdate!.cursor);
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  console.log(
    JSON.stringify(
      {
        fixture: "synthetic; 60000 input lines; 50000 retained rows",
        ingestMs: Math.round(ingestMs),
        fullRows: full.rows.length,
        idleRows: idle.rows.length,
        changedRows: delta.rows.length,
        fullSerializedBytes: bytes(full),
        idleSerializedBytes: bytes(idle),
        changedSerializedBytes: bytes(delta),
      },
      null,
      2,
    ),
  );
  await capture.stop();
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
