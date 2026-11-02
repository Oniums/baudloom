import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readSession } from "../src/core/journal";
const metadata = {
  target: "synthetic",
  baudRate: 115200,
  source: "synthetic" as const,
};
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "baudloom-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("journal preserves raw bytes, event order and close record on disk", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, metadata);
  await Promise.all([
    j.append({ kind: "rx", data: "AP+A" }),
    j.append({ kind: "mark", message: "观察" }),
  ]);
  await j.close();
  const result = await readSession(j.file);
  assert.equal(result.warning, null);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.events.map((e) => e.kind),
    ["start", "rx", "mark", "stop"],
  );
  assert.deepEqual(
    result.events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    [...Buffer.from(result.events[1].data!, "base64")],
    [0, 255, 128],
  );
  assert.equal(result.events[0].source, "synthetic");
  await assert.rejects(j.append({ kind: "rx", data: "AA==" }));
});
test("truncated tail returns verified prefix and does not change original", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, metadata);
  await j.append({ kind: "rx", data: "AQI=" });
  await j.close();
  const original = await readFile(j.file);
  await writeFile(j.file, original.subarray(0, original.length - 8));
  const before = await readFile(j.file);
  const r = await readSession(j.file);
  assert.equal(r.complete, false);
  assert.equal(r.events.length, 2);
  assert.match(r.warning!, /截断/);
  assert.deepEqual(await readFile(j.file), before);
});
test("middle corruption stops verification and warns instead of hiding gap", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, metadata);
  await j.append({ kind: "rx", data: "AQI=" });
  await j.close();
  await writeFile(
    j.file,
    (await readFile(j.file, "utf8")).replace("AQI=", "AQM="),
  );
  const r = await readSession(j.file);
  assert.equal(r.events.length, 1);
  assert.match(r.warning!, /校验/);
});
test("reader rejects unbounded line and reports source without rewriting", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "huge.jsonl");
  await writeFile(file, "x".repeat(150000));
  const r = await readSession(file);
  assert.equal(r.events.length, 0);
  assert.match(r.warning!, /过长/);
});
test("limited view retains latest records while total count is accurate", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, metadata);
  for (let i = 0; i < 12; i++) await j.append({ kind: "rx", data: "AA==" });
  await j.close();
  const r = await readSession(j.file, 4);
  assert.equal(r.total, 14);
  assert.equal(r.events.length, 4);
  assert.equal(r.events[0].seq, 11);
});
test("session and queue limits reject writes explicitly", async (t) => {
  const dir = await fixture(t);
  const j = await Journal.create(dir, metadata, {
    maxBytes: 1200,
    maxQueueBytes: 800,
  });
  await assert.rejects(
    j.append({ kind: "rx", data: "A".repeat(1000) }),
    /队列|容量/,
  );
  await j.close();
});
test("close seals the journal immediately and concurrent closers await the same drain", async (t) => {
  const j = await Journal.create(await fixture(t), metadata);
  const closing = j.close();
  await assert.rejects(j.append({ kind: "mark", message: "too late" }), /关闭/);
  await Promise.all([closing, j.close()]);
  assert.equal((await readSession(j.file)).complete, true);
});
test("partial filesystem writes are retried until all bytes are preserved", async (t) => {
  const j = await Journal.create(await fixture(t), metadata);
  // Exercise actual FileHandle errors/short writes without requiring a full disk.
  const handle = (j as unknown as { handle: FileHandle }).handle;
  const write = handle.write.bind(handle);
  t.mock.method(
    handle,
    "write",
    async (buffer: Buffer, offset: number, length: number) =>
      write(buffer, offset, Math.min(length, 7)),
  );
  await j.append({ kind: "rx", data: "AP8=" });
  await j.close();
  const r = await readSession(j.file);
  assert.equal(r.complete, true);
  assert.equal(r.events[1].data, "AP8=");
});
test("disk write and sync failures are explicit and never produce a normal close", async (t) => {
  for (const operation of ["write", "sync"] as const) {
    const j = await Journal.create(await fixture(t), metadata);
    const handle = (j as unknown as { handle: FileHandle }).handle;
    let faults = 0;
    j.onFault = () => {
      faults++;
    };
    t.mock.method(handle, operation, async () => {
      throw Error("injected ENOSPC");
    });
    await assert.rejects(
      operation === "write" ? j.append({ kind: "rx", data: "AA==" }) : j.sync(),
      /ENOSPC/,
    );
    await assert.rejects(j.close(), /ENOSPC/);
    assert.equal(faults, 1);
    const r = await readSession(j.file);
    assert.equal(r.complete, false);
    assert.match(r.warning!, /收尾/);
  }
});

test("bounded history backfill does not consume the live queue budget and preserves timestamps", async (t) => {
  const dir = await fixture(t);
  const journal = await Journal.create(
    dir,
    { target: "demo", source: "synthetic", baudRate: 115200 },
    { maxBytes: 8 * 1024 * 1024, maxQueueBytes: 4096 },
  );
  const events = Array.from({ length: 100 }, (_, i) => ({
    v: 1 as const,
    seq: i + 1,
    sessionId: "memory",
    at: "2026-11-02T00:00:00.000Z",
    mono: String(i),
    source: "synthetic" as const,
    target: "demo",
    baudRate: 115200,
    kind: "rx" as const,
    data: Buffer.alloc(8192, i).toString("base64"),
  }));
  const replay = journal.backfill(events);
  await journal.append({
    kind: "rx",
    data: Buffer.from("live").toString("base64"),
  });
  await replay;
  await journal.close();
  const saved = await readSession(journal.file);
  assert.equal(saved.complete, true);
  assert.equal(saved.events[1].at, events[0].at);
  assert.equal(saved.events[100].data, events[99].data);
  assert.equal(saved.events[101].data, Buffer.from("live").toString("base64"));
});
