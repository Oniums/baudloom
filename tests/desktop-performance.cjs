const { _electron: electron, expect } = require("@playwright/test");
const { performance } = require("node:perf_hooks");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir, platform, cpus } = require("node:os");
const path = require("node:path");
const trials = Number(process.env.BAUDLOOM_BENCH_TRIALS ?? 10);
if (!Number.isInteger(trials) || trials < 1 || trials > 100)
  throw Error("Invalid trial count");
const summarize = (list) => {
  const a = list.slice().sort((a, b) => a - b);
  return {
    p50Ms: a[Math.floor((a.length - 1) * 0.5)],
    p95Ms: a[Math.ceil((a.length - 1) * 0.95)],
  };
};
(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baudloom-perf-"));
  let app;
  try {
    const startup = [];
    for (let i = 0; i < trials; i++) {
      const start = performance.now();
      app = await electron.launch({
        executablePath: process.env.BAUDLOOM_EXECUTABLE,
        args: [
          ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          ...(process.env.BAUDLOOM_EXECUTABLE ? [] : ["."]),
        ],
        env: {
          ...process.env,
          BAUDLOOM_DATA_DIR: root,
          BAUDLOOM_TEST_MODE: "1",
        },
      });
      const page = await app.firstWindow();
      await expect(page.locator("#connect")).toBeEnabled();
      startup.push(performance.now() - start);
      if (i < trials - 1) {
        await app.close();
        app = null;
      }
    }
    const page = await app.firstWindow();
    const base = await page.evaluate(() => window.baudloom.snapshot());
    await app.evaluate(({ ipcMain }, base) => {
      ipcMain.removeHandler("snapshot");
      const rows = Array.from({ length: 50000 }, (_, i) => ({
        id: i + 1,
        at: "2026-11-03T00:00:00.000Z",
        dir: "RX",
        text: `sample ${i} UTF-8 中文 serial data`,
      }));
      ipcMain.handle("snapshot", () => ({
        ...base,
        rows,
        totalRows: rows.length,
        sessionId: "benchmark",
        viewUpdate: undefined,
        rxBytes: 5000000,
      }));
    }, base);
    await expect(page.locator("#log")).toContainText("sample 49999 ");
    await page.locator("#search-options").click();
    const search = [];
    for (let i = 0; i < 40; i++) {
      const id = 40000 + i,
        start = performance.now();
      await page.locator("#search").fill(`sample ${id} `);
      await expect(page.locator("#log")).toContainText(`sample ${id} `);
      search.push(performance.now() - start);
    }
    const metrics = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((p) => ({
        type: p.type,
        workingSetMiB: p.memory.workingSetSize / 1024,
      })),
    );
    console.log(
      JSON.stringify(
        {
          version: await app.evaluate(({ app }) => app.getVersion()),
          platform: platform(),
          cpu: cpus()[0]?.model,
          executable: process.env.BAUDLOOM_EXECUTABLE ?? "source Electron",
          fixture:
            "automation launch-to-ready; search across 50000 synthetic cached rows; includes automation overhead; not Windows cold start or hardware throughput",
          trials,
          startup: summarize(startup),
          search: summarize(search),
          metrics,
        },
        null,
        2,
      ),
    );
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
