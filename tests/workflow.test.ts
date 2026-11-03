import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SERIAL,
  serialSettings,
  serialError,
} from "../src/serial-settings";
import { SerialTransport } from "../src/core/transport";
import { Capture } from "../src/core/capture";
import { readTextLog } from "../src/core/text-import";
import { validateProfile, readProfiles } from "../src/profiles";
import { blankCommand } from "../src/send-tools";
import { rowInterval } from "../src/log-reading";
const limits = { maxRows: 1000, maxChars: 1048576 };
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "baudloom-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("serial settings reach the adapter and handshake never manually writes RTS", async () => {
  for (const flow of ["none", "rtscts", "xonxoff"] as const) {
    let options: any, signals: any;
    class Port extends EventEmitter {
      isOpen = false;
      open(cb: any) {
        this.isOpen = true;
        cb(null);
      }
      set(value: any, cb: any) {
        signals = value;
        cb(null);
      }
      close(cb: any) {
        this.isOpen = false;
        cb(null);
      }
    }
    const p = new Port();
    const t = new SerialTransport(
      {
        source: "serial",
        target: "mock",
        baudRate: 230400,
        serial: {
          ...DEFAULT_SERIAL,
          dataBits: 7,
          stopBits: 2,
          parity: "even",
          flow,
          dtr: false,
          rts: false,
        },
      },
      (o) => {
        options = o;
        return p as any;
      },
    );
    await t.open();
    assert.equal(options.dataBits, 7);
    assert.equal(options.stopBits, 2);
    assert.equal(options.parity, "even");
    assert.equal(options.rtscts, flow === "rtscts");
    assert.equal(options.xon, flow === "xonxoff");
    assert.equal(options.xoff, flow === "xonxoff");
    if (flow === "rtscts") assert.equal(signals, undefined);
    else assert.deepEqual(signals, { dtr: false, rts: false });
    await t.close();
  }
});
test("invalid settings are rejected before creating a transport and failed signal setup closes it", async (t) => {
  let created = false;
  const c = new Capture(await fixture(t), () => {
    created = true;
    throw Error("unexpected");
  });
  await assert.rejects(
    c.connect({
      source: "serial",
      target: "mock",
      baudRate: 9600,
      serial: { ...DEFAULT_SERIAL, dataBits: 9 as any },
    }),
    /无效串口参数/,
  );
  assert.equal(created, false);
  assert.throws(
    () => serialSettings({ ...DEFAULT_SERIAL, flow: "invalid" }),
    /无效/,
  );
  assert.match(serialError(Error("Access denied")).message, /占用.*权限/);
  assert.match(serialError(Error("ENOENT")).message, /拔出/);
  let closed = false;
  class Port extends EventEmitter {
    isOpen = true;
    open(cb: any) {
      cb(null);
    }
    set(_: any, cb: any) {
      cb(Error("signals failed"));
    }
    close(cb: any) {
      closed = true;
      this.isOpen = false;
      cb(null);
    }
  }
  const transport = new SerialTransport(
    { source: "serial", target: "mock", baudRate: 9600 },
    () => new Port() as any,
  );
  await assert.rejects(transport.open(), /signals failed/);
  assert.equal(closed, true);
});
test("text reader streams UTF-8 and BOM UTF-16 with bounded tail and no invented timing", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "fixture.log");
  for (const content of [
    Buffer.from("first\r\n" + "中\n".repeat(1500) + "last"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("first\r\n" + "中\n".repeat(1500) + "last", "utf16le"),
    ]),
  ]) {
    await writeFile(file, content);
    const result = await readTextLog(file, limits),
      snap = result.view.textSnapshot();
    assert.equal(snap.total, 1502);
    assert.equal(snap.rows.length, 1000);
    assert.equal(snap.rows.at(-1)?.text, "last");
    assert.ok(
      snap.rows.every(
        (r) => r.at === "" && r.dir === "" && r.mono === undefined,
      ),
    );
    assert.deepEqual(await readFile(file), content);
  }
});
test("invalid text import preserves the prior offline view, and plain files cannot masquerade as full sessions", async (t) => {
  const dir = await fixture(t),
    file = join(dir, "plain.txt");
  await writeFile(file, "plain\nlast");
  const c = new Capture(dir);
  const before = await c.openFile(file);
  assert.equal(before.fileKind, "text");
  assert.equal(before.rows[0].text, "plain");
  const bad = join(dir, "bad.log");
  await writeFile(bad, Buffer.from([0xff, 0xff, 0xff]));
  await assert.rejects(c.openFile(bad), /编码/);
  assert.deepEqual(c.snapshot().rows, before.rows);
  await assert.rejects(
    c.exportLog(join(dir, "out.txt"), {
      scope: "session",
      sessionId: before.sessionId,
      mode: "text",
      afterRowId: 0,
      query: "",
      exclude: "",
      caseSensitive: false,
      onlyMatches: true,
      timestamps: false,
      direction: false,
    }),
    /普通文本/,
  );
  await writeFile(bad, "nul\0log");
  await assert.rejects(readTextLog(bad, limits), /NUL/);
});
test("profiles round-trip all send and connection settings without aliasing or side effects", () => {
  const p = validateProfile({
    name: "Test",
    baudRate: 123456,
    serial: { ...DEFAULT_SERIAL, parity: "odd" },
    draft: { ...blankCommand(), text: "123" },
    commands: [
      {
        ...blankCommand(),
        name: "A",
        text: "AA",
        format: "hex",
        selected: true,
        checksum: "xor8",
      },
    ],
    clearAfterSend: true,
    singleInterval: 123,
    multiInterval: 234,
  });
  const restored = readProfiles(
    JSON.stringify({ version: 1, profiles: [p] }),
  )[0];
  assert.deepEqual(restored, p);
  restored.commands[0].text = "changed";
  assert.equal(p.commands[0].text, "AA");
  assert.throws(() => validateProfile({ ...p, baudRate: 0 }), /波特率/);
  assert.throws(
    () =>
      validateProfile({
        ...p,
        commands: [{ ...p.commands[0], format: "bad" as any }],
      }),
    /配置无效/,
  );
  assert.throws(() => readProfiles('{"version":2,"profiles":[]}'), /无效/);
});
test("time difference uses monotonic time despite wall-clock changes and never invents text timestamps", () => {
  const a = {
    id: 1,
    dir: "RX",
    text: "a",
    at: "2026-11-03T01:00:01Z",
    mono: "999999999999999999900",
  };
  const b = {
    ...a,
    id: 2,
    at: "2026-11-03T01:00:00Z",
    mono: "1000000000000000999900",
  };
  assert.match(rowInterval(a, b), /^1.000 ms/);
  assert.match(
    rowInterval({ ...a, mono: undefined }, { ...b, mono: undefined }),
    /^-1000 ms.*校时/,
  );
  assert.match(rowInterval({ ...a, at: "", mono: undefined }, b), /无法计算/);
});
