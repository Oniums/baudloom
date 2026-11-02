import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SerialPortMock } from "serialport";
import { Capture } from "../src/core/capture";
import { SerialTransport, type Transport } from "../src/core/transport";
import { Journal, readSession } from "../src/core/journal";
const config = {
  target: "demo",
  source: "synthetic" as const,
  baudRate: 115200,
  saveSession: true,
};
class Wire extends EventEmitter implements Transport {
  sent: Buffer[] = [];
  opened = false;
  async open() {
    this.opened = true;
  }
  async write(bytes: Buffer) {
    if (!this.opened) throw Error("closed");
    this.sent.push(Buffer.from(bytes));
  }
  async close() {
    if (this.opened) {
      this.opened = false;
      this.emit("closed");
    }
  }
}
async function setup(t: any, writer?: typeof Journal.create) {
  const dir = await mkdtemp(join(tmpdir(), "baudloom-capture-"));
  const wire = new Wire();
  const c = new Capture(dir, () => wire, writer);
  t.after(async () => {
    await c.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { c, wire, dir };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), "condition timed out");
};
test("receive split text but persist exact chunks and independent sending", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  const id = c.snapshot().sessionId;
  wire.emit("bytes", Buffer.from([0xe4, 0xb8]));
  wire.emit("bytes", Buffer.from([0xad, 13, 10]));
  await until(() => c.snapshot().rows.some((r) => r.text === "中"));
  await c.send({
    target: "demo",
    sessionId: id,
    text: "status",
    format: "text",
    ending: "crlf",
  });
  await c.stop();
  const r = await readSession(c.snapshot().sessionFile);
  assert.equal(
    Buffer.concat(
      r.events
        .filter((e) => e.kind === "rx")
        .map((e) => Buffer.from(e.data!, "base64")),
    ).toString("hex"),
    "e4b8ad0d0a",
  );
  assert.equal(wire.sent[0].toString(), "status\r\n");
  assert.equal(
    r.events.find((e) => e.kind === "tx-result")?.outcome,
    "host-write-completed",
  );
  assert.equal(r.complete, true);
  assert.equal(c.snapshot().state, "stopped");
});
test("wrong target, stale session and invalid hex never reach the device", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  const req = {
    target: "demo",
    sessionId: c.snapshot().sessionId,
    text: "GG",
    format: "hex" as const,
    ending: "none" as const,
  };
  await assert.rejects(c.send(req));
  await assert.rejects(c.send({ ...req, text: "AA", target: "other" }));
  await assert.rejects(c.send({ ...req, text: "AA", sessionId: "old" }));
  assert.equal(wire.sent.length, 0);
  await c.stop();
  await assert.rejects(c.send({ ...req, text: "AA" }));
});
test("disconnect is visible and never silently reconnects or replays sends", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  await wire.close();
  await until(() => c.snapshot().state === "error");
  assert.match(c.snapshot().error!, /断开/);
  assert.equal(wire.sent.length, 0);
  await c.stop();
});
test("bounded view is independent of complete disk recording", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  for (let i = 0; i < 1500; i++) wire.emit("bytes", Buffer.from(`row-${i}\n`));
  await until(() => c.snapshot().rxBytes > 0);
  await c.stop();
  assert.ok(c.snapshot().rows.length <= c.snapshot().viewLimits.maxRows);
  const r = await readSession(c.snapshot().sessionFile);
  assert.equal(r.events.filter((e) => e.kind === "rx").length, 1500);
  assert.ok(c.snapshot().totalRows >= 1500);
});
test("record limit stops acquisition with an explicit error", async (t) => {
  const writer: typeof Journal.create = (dir, meta) =>
    Journal.create(dir, meta, { maxBytes: 3000, maxQueueBytes: 1000 });
  const { c, wire } = await setup(t, writer);
  await c.connect(config);
  wire.emit("bytes", Buffer.alloc(3000));
  await until(() => c.snapshot().state === "error");
  assert.match(c.snapshot().error!, /队列|容量/);
  await c.stop();
  assert.equal(wire.opened, false);
});
test("serial adapter uses actual SerialPort stream and never auto-opens", async () => {
  const path = "/dev/baudloom-mock";
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort(path, { echo: true, record: true });
  let port!: SerialPortMock;
  const transport = new SerialTransport(
    { target: path, source: "serial", baudRate: 115200 },
    (options) => (port = new SerialPortMock(options)),
  );
  const rx: Buffer[] = [];
  transport.on("bytes", (b) => rx.push(b));
  transport.on("fault", () => {});
  assert.equal(port.isOpen, false);
  await transport.open();
  await transport.write(Buffer.from([0, 255, 13, 10]));
  await until(() => Buffer.concat(rx).length === 4);
  assert.deepEqual([...Buffer.concat(rx)], [0, 255, 13, 10]);
  await transport.close();
  assert.equal(port.isOpen, false);
});
test("a fault while opening still closes a late-opened transport", async (t) => {
  const { dir } = await setup(t);
  let release!: () => void;
  class LateWire extends Wire {
    async open() {
      await new Promise<void>((r) => {
        release = r;
      });
      this.opened = true;
    }
  }
  const wire = new LateWire();
  const c = new Capture(dir, () => wire);
  t.after(() => c.stop());
  const connecting = c.connect(config);
  const rejected = assert.rejects(connecting, /opening fault/);
  await until(() => Boolean(release));
  wire.emit("fault", Error("opening fault"));
  await new Promise((r) => setImmediate(r));
  release();
  await rejected;
  await c.stop();
  assert.equal(wire.opened, false);
});
test("opening offline history reserves the session before an asynchronous read", async (t) => {
  const { c } = await setup(t);
  await c.connect(config);
  const file = c.snapshot().sessionFile;
  await c.stop();
  const opening = c.openFile(file);
  await assert.rejects(c.connect(config), /停止|读取/);
  await opening;
  assert.equal(c.snapshot().state, "offline");
});
test("offline TX counts completed host writes, not uncertain requests", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  wire.write = async () => {
    throw Error("write outcome unknown");
  };
  await assert.rejects(
    c.send({
      target: "demo",
      sessionId: c.snapshot().sessionId,
      text: "status",
      format: "text",
      ending: "none",
    }),
  );
  await c.stop();
  const file = c.snapshot().sessionFile;
  assert.equal(c.snapshot().txBytes, 0);
  await c.openFile(file);
  assert.equal(c.snapshot().txBytes, 0);
});

test("scheduled commands rotate a frozen batch, stop immediately, and never resume on reconnect", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  const first = {
    target: "demo",
    sessionId: c.snapshot().sessionId,
    text: "A",
    format: "text" as const,
    ending: "none" as const,
  };
  const commands = [first, { ...first, text: "B" }];
  const job = { commands, kind: "multi" as const, intervalMs: 100 };
  c.startSchedule(job);
  job.intervalMs = 3600000;
  first.text = "changed";
  await until(() => wire.sent.length >= 3);
  c.stopSchedule();
  assert.deepEqual(
    wire.sent.slice(0, 3).map((b) => b.toString()),
    ["A", "B", "A"],
  );
  const count = wire.sent.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(wire.sent.length, count);
  c.startSchedule({
    commands: [{ ...first, sessionId: c.snapshot().sessionId }],
    kind: "single",
    intervalMs: 100,
  });
  await c.stop();
  await c.connect(config);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(wire.sent.length, count);
  assert.equal(c.snapshot().schedule.active, false);
});
test("schedule validates the entire batch before writing and stops on transport failure", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  const cmd = {
    target: "demo",
    sessionId: c.snapshot().sessionId,
    text: "AA",
    format: "hex" as const,
    ending: "none" as const,
  };
  assert.throws(() =>
    c.startSchedule({
      commands: [cmd, { ...cmd, text: "GG" }],
      kind: "multi",
      intervalMs: 100,
    }),
  );
  assert.throws(() =>
    c.startSchedule({
      commands: [{ ...cmd, sessionId: "stale" }],
      kind: "single",
      intervalMs: 100,
    }),
  );
  assert.throws(() =>
    c.startSchedule({ commands: [cmd], kind: "single", intervalMs: 0 }),
  );
  assert.equal(wire.sent.length, 0);
  wire.write = async () => {
    throw Error("write failed");
  };
  c.startSchedule({ commands: [cmd], kind: "single", intervalMs: 100 });
  await until(() => c.snapshot().state === "error");
  assert.equal(c.snapshot().schedule.active, false);
});

test("slow scheduled writes never overlap or catch up, cancellation discards queued work", async (t) => {
  const { c, wire } = await setup(t);
  await c.connect(config);
  let release: (() => void) | undefined;
  let writes = 0;
  wire.write = async (bytes) => {
    writes++;
    wire.sent.push(Buffer.from(bytes));
    await new Promise<void>((r) => {
      release = r;
    });
  };
  const cmd = {
    target: "demo",
    sessionId: c.snapshot().sessionId,
    text: "A",
    format: "text" as const,
    ending: "none" as const,
  };
  c.startSchedule({ commands: [cmd], kind: "single", intervalMs: 100 });
  await until(() => writes === 1);
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(writes, 1);
  c.stopSchedule();
  // A new job queued behind the old in-flight write can be cancelled before it reaches the wire.
  c.startSchedule({ commands: [cmd], kind: "single", intervalMs: 100 });
  await new Promise((r) => setTimeout(r, 20));
  c.stopSchedule();
  release!();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(writes, 1);
  assert.equal(c.snapshot().state, "connected");
});

test("cancelling during journal persistence prevents the scheduled device write", async (t) => {
  let release: (() => void) | undefined;
  let recording = false;
  const { c, wire } = await setup(t, async (...args) => {
    const journal = await Journal.create(...args);
    const append = journal.append.bind(journal);
    journal.append = async (input) => {
      const event = await append(input);
      if (input.kind === "tx-request") {
        recording = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return event;
    };
    return journal;
  });
  await c.connect(config);
  c.startSchedule({
    commands: [
      {
        target: "demo",
        sessionId: c.snapshot().sessionId,
        text: "AA",
        format: "hex",
        ending: "none",
      },
    ],
    kind: "single",
    intervalMs: 100,
  });
  await until(() => recording);
  c.stopSchedule();
  release!();
  await c.stop();
  assert.equal(wire.sent.length, 0);
  const records = await readSession(c.snapshot().sessionFile);
  assert.ok(
    records.events.some(
      (e) =>
        e.kind === "tx-result" &&
        e.outcome === "uncertain" &&
        e.message?.includes("未写入"),
    ),
  );
});

test("recording is opt-in: unsaved connections never create a session file", async (t) => {
  const { c, wire, dir } = await setup(t, async () => {
    throw Error("disk writer must not be called");
  });
  const { saveSession, ...unsaved } = config;
  await c.connect(unsaved);
  wire.emit("bytes", Buffer.from("hello\r\n"));
  await until(() => c.snapshot().rxBytes === 7);
  const id = c.snapshot().sessionId;
  await c.send({
    target: "demo",
    sessionId: id,
    text: "A",
    format: "text",
    ending: "none",
  });
  assert.equal(c.snapshot().sessionFile, "");
  assert.equal(c.snapshot().writtenBytes, 0);
  assert.equal(c.snapshot().txBytes, 1);
  await c.stop();
  assert.deepEqual(await (await import("node:fs/promises")).readdir(dir), []);
  await c.connect({ ...unsaved, saveSession: false });
  await assert.rejects(
    c.send({
      target: "demo",
      sessionId: id,
      text: "A",
      format: "text",
      ending: "none",
    }),
  );
});

test("starting recording backfills exact cached events, preserves times and connection identity", async (t) => {
  let release!: () => void;
  let creating = false;
  const { c, wire } = await setup(t, async (...args) => {
    creating = true;
    await new Promise<void>((r) => {
      release = r;
    });
    return Journal.create(...args);
  });
  await c.connect({ ...config, saveSession: false });
  const id = c.snapshot().sessionId;
  wire.emit("bytes", Buffer.from([0xe4, 0xb8]));
  const command = {
    target: "demo",
    sessionId: id,
    text: "before",
    format: "text" as const,
    ending: "none" as const,
  };
  await c.send(command);
  const beforeAt = c.snapshot().rows.find((r) => r.dir === "TX")!.at;
  const saving = c.startRecording(id);
  await until(() => creating);
  wire.emit("bytes", Buffer.from([0xad, 13, 10]));
  release();
  await saving;
  assert.equal(c.snapshot().sessionId, id);
  assert.equal(c.snapshot().state, "connected");
  assert.ok(c.snapshot().backfilledEvents >= 4);
  wire.emit("bytes", Buffer.from("after\n"));
  await c.send({ ...command, text: "after" });
  const file = c.snapshot().sessionFile;
  await c.startRecording(id);
  assert.equal(c.snapshot().sessionFile, file);
  await c.stop();
  const result = await readSession(file);
  assert.equal(result.complete, true);
  assert.equal(
    Buffer.concat(
      result.events
        .filter((e) => e.kind === "rx")
        .map((e) => Buffer.from(e.data!, "base64")),
    ).toString(),
    "中\r\nafter\n",
  );
  const tx = result.events.filter((e) => e.kind === "tx-request");
  assert.equal(tx.length, 2);
  assert.equal(tx[0].at, beforeAt);
  assert.equal(Buffer.from(tx[0].data!, "base64").toString(), "before");
});
test("failed recording creation leaves unsaved capture usable; stale recording requests are rejected", async (t) => {
  const { c } = await setup(t, async () => {
    throw Error("disk unavailable");
  });
  await c.connect({ ...config, saveSession: false });
  const id = c.snapshot().sessionId;
  await assert.rejects(c.startRecording("stale"), /会话/);
  await assert.rejects(c.startRecording(id), /disk unavailable/);
  assert.equal(c.snapshot().state, "connected");
  assert.equal(c.snapshot().sessionFile, "");
  await c.send({
    target: "demo",
    sessionId: id,
    text: "still works",
    format: "text",
    ending: "none",
  });
});
test("stop during recording creation never replaces the closed memory journal", async (t) => {
  let release!: () => void;
  const { c, wire } = await setup(t, async (...args) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return Journal.create(...args);
  });
  await c.connect({ ...config, saveSession: false });
  const saving = c.startRecording(c.snapshot().sessionId);
  await until(() => Boolean(release));
  const stopped = c.stop();
  release();
  await assert.rejects(saving, /连接|会话/);
  await stopped;
  assert.equal(wire.opened, false);
  assert.equal(c.snapshot().sessionFile, "");
});

test("backfill reports eviction and continues an active timer without replaying commands to the device", async (t) => {
  const { c, wire } = await setup(t);
  c.setViewLimits({ maxRows: 1000, maxChars: 1048576 });
  await c.connect({ ...config, saveSession: false });
  for (let i = 0; i < 1100; i++) wire.emit("bytes", Buffer.from(`line${i}\n`));
  const id = c.snapshot().sessionId;
  c.startSchedule({
    commands: [
      {
        target: "demo",
        sessionId: id,
        text: "tick",
        format: "text",
        ending: "none",
      },
    ],
    kind: "single",
    intervalMs: 100,
  });
  await until(() => wire.sent.length > 0);
  await c.startRecording(id);
  const count = wire.sent.length;
  assert.ok(c.snapshot().droppedEvents >= 101);
  assert.equal(c.snapshot().backfilledEvents, 1000);
  await until(() => wire.sent.length > count);
  assert.equal(c.snapshot().schedule.active, true);
  await c.stop();
  const saved = await readSession(c.snapshot().sessionFile, 5000);
  assert.equal(saved.complete, true);
  assert.ok(saved.events.some((e) => e.message?.includes("此前已淘汰")));
  assert.ok(
    !saved.events.some(
      (e) => e.data === Buffer.from("line0\n").toString("base64"),
    ),
  );
  assert.ok(wire.sent.every((b) => b.toString() === "tick"));
});

test("offline reopen respects the expanded view budget instead of the old 2000-event tail", async (t) => {
  const { c, wire } = await setup(t);
  c.setViewLimits({ maxRows: 3000, maxChars: 4 * 1048576 });
  await c.connect(config);
  for (let i = 0; i < 2500; i++)
    wire.emit("bytes", Buffer.from(`saved-${i}\n`));
  await c.stop();
  await c.openFile(c.snapshot().sessionFile);
  assert.equal(c.snapshot().rows.filter((r) => r.dir === "RX").length, 2500);
});
