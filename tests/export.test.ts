import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/core/journal";
import { exportText } from "../src/core/export";
import type { ExportRequest } from "../src/shared";
const options: ExportRequest = {
  scope: "session",
  sessionId: "test",
  mode: "text",
  afterRowId: 0,
  query: "",
  exclude: "",
  caseSensitive: false,
  onlyMatches: true,
  timestamps: false,
  direction: false,
};
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "baudloom-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("full segmented export joins split UTF-8 and CRLF without duplicate partial rows", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(
    dir,
    { source: "synthetic", target: "demo", baudRate: 115200 },
    { maxBytes: 600, maxQueueBytes: 16384 },
  );
  for (const b of [
    Buffer.from([0xe4, 0xb8]),
    Buffer.from([0xad, 0x0d]),
    Buffer.from("\nnext"),
    Buffer.from(" line\n"),
  ])
    await j.append({ kind: "rx", data: b.toString("base64") });
  await j.close();
  assert.ok(j.segmentCount > 1);
  const file = join(dir, "export.txt");
  const result = await exportText(file, options, {
    parts: await j.checkpoint(),
  });
  const text = await readFile(file, "utf8");
  assert.equal(text, "capture started\n中\nnext line\ncapture stopped\n");
  assert.equal(result.rows, 4);
  assert.equal(result.bytes, Buffer.byteLength(text));
});
test("cache and filtered exports have explicit clear/search scope and optional metadata", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "out.log");
  const rows = [
    { id: 1, at: "2026-11-03T00:00:00.000Z", dir: "RX", text: "error old" },
    {
      id: 2,
      at: "2026-11-03T00:00:01.000Z",
      dir: "RX",
      text: "ERROR <script>",
    },
    { id: 3, at: "2026-11-03T00:00:02.000Z", dir: "RX", text: "error noise" },
  ];
  await exportText(
    file,
    {
      ...options,
      scope: "filtered",
      afterRowId: 1,
      query: "error",
      exclude: "noise",
      timestamps: true,
      direction: true,
    },
    { rows },
  );
  assert.equal(
    await readFile(file, "utf8"),
    "2026-11-03T00:00:01.000Z\tRX\tERROR <script>\n",
  );
  await exportText(
    file,
    { ...options, scope: "cache", afterRowId: 2, query: "absent" },
    { rows },
  );
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 3);
});
test("cancelled or corrupt full export preserves the destination and cleans temporary files", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "keep.txt");
  await writeFile(file, "old");
  const controller = new AbortController();
  controller.abort(Error("cancelled"));
  await assert.rejects(
    exportText(
      file,
      { ...options, scope: "selection", selection: "new" },
      {},
      controller.signal,
    ),
    /cancelled/,
  );
  assert.equal(await readFile(file, "utf8"), "old");
  const j = await Journal.create(dir, {
    source: "synthetic",
    target: "demo",
    baudRate: 9600,
  });
  await j.close();
  const parts = await j.checkpoint();
  await writeFile(
    j.file,
    (await readFile(j.file, "utf8")).replace(
      "capture started",
      "capture changed",
    ),
  );
  await assert.rejects(exportText(file, options, { parts }), /未导出/);
  assert.equal(await readFile(file, "utf8"), "old");
  assert.ok((await readdir(dir)).every((name) => !name.endsWith(".tmp")));
  await assert.rejects(
    exportText(j.file, { ...options, scope: "cache" }, { rows: [] }),
    /扩展名/,
  );
});
test("live full export stops at the checkpoint and keeps a final unterminated fragment once", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, {
    source: "synthetic",
    target: "demo",
    baudRate: 9600,
  });
  await j.append({
    kind: "rx",
    data: Buffer.from("before").toString("base64"),
  });
  const parts = await j.checkpoint();
  await j.append({
    kind: "rx",
    data: Buffer.from("after\n").toString("base64"),
  });
  const result = await exportText(join(dir, "live.txt"), options, {
    parts,
    live: true,
  });
  const text = await readFile(result.file, "utf8");
  assert.match(text, /before/);
  assert.ok(!text.includes("after"));
  assert.ok(result.warning);
  await j.close();
});

test("full export retains every line of a newline-dense RX record", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, {
    source: "synthetic",
    target: "demo",
    baudRate: 9600,
  });
  await j.append({
    kind: "rx",
    data: Buffer.from("x\n".repeat(20000)).toString("base64"),
  });
  await j.close();
  const result = await exportText(join(dir, "dense.txt"), options, {
    parts: await j.checkpoint(),
  });
  assert.equal(result.rows, 20002);
  assert.equal(
    await readFile(result.file, "utf8"),
    "capture started\n" + "x\n".repeat(20000) + "capture stopped\n",
  );
});
