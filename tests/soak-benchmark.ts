import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, platform, cpus } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import assert from "node:assert/strict";
import { Capture } from "../src/core/capture";
import { scanSession, sessionParts } from "../src/core/journal";
const seconds = Number(process.env.BAUDLOOM_BENCH_SECONDS ?? 60);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 28800)
  throw Error("BAUDLOOM_BENCH_SECONDS must be 1–28800");
async function main() {
  const dir = await mkdtemp(join(tmpdir(), "baudloom-soak-"));
  class Wire extends EventEmitter {
    async open() {}
    async close() {}
    async write() {}
  }
  const wire = new Wire(),
    c = new Capture(dir, () => wire);
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  try {
    c.setViewLimits({ maxRows: 50000, maxChars: 16 * 1048576 });
    await c.connect({
      source: "synthetic",
      target: "demo",
      baudRate: 921600,
      saveSession: true,
    });
    const start = performance.now(),
      rssStart = process.memoryUsage().rss;
    let bytes = 0,
      peakRss = rssStart,
      peakQueue = 0;
    const chunk = Buffer.from(
      "synthetic sample 0123456789 ABCDEF\r\n".repeat(300),
    );
    while (performance.now() - start < seconds * 1000) {
      wire.emit("bytes", chunk);
      bytes += chunk.length;
      const s = c.snapshot("text", c.snapshot().viewUpdate!.cursor);
      peakQueue = Math.max(peakQueue, s.pendingBytes);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      await new Promise((r) => setTimeout(r, 100));
    }
    await c.stop();
    const s = c.snapshot();
    let saved = 0;
    const verified = await scanSession(
      await sessionParts(s.sessionFile),
      (e) => {
        if (e.kind === "rx") saved += Buffer.from(e.data!, "base64").length;
      },
    );
    assert.equal(s.state, "stopped");
    assert.equal(saved, bytes);
    assert.equal(s.rxBytes, bytes);
    assert.equal(verified.complete, true);
    console.log(
      JSON.stringify(
        {
          platform: platform(),
          cpu: cpus()[0]?.model,
          seconds,
          fixture:
            "synthetic serial input + real disk recording; no GUI or hardware",
          bytes,
          saved,
          retainedRows: s.rows.length,
          rssStartMiB: rssStart / 1048576,
          rssEndMiB: process.memoryUsage().rss / 1048576,
          rssPeakMiB: peakRss / 1048576,
          queuePeakBytes: peakQueue,
          eventLoopP95Ms: lag.percentile(95) / 1e6,
          segments: s.segmentCount,
        },
        null,
        2,
      ),
    );
  } finally {
    lag.disable();
    await c.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
