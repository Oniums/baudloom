import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSend, restoreSendTools, rememberSend } from "../src/send-tools";
import { portLabel } from "../src/core/port-label";

test("Windows friendly names preserve each WCH channel and avoid duplicate COM suffixes", () => {
  for (const [channel, path] of [
    ["A", "COM12"],
    ["B", "COM5"],
    ["C", "COM10"],
    ["D", "COM4"],
    ["E", "COM9"],
    ["F", "COM11"],
    ["G", "COM14"],
    ["H", "COM8"],
  ]) {
    const name = `WCH USB-SERIAL Ch ${channel} (${path})`;
    assert.equal(
      portLabel({ path, friendlyName: name, manufacturer: "wch.cn" }),
      name,
    );
  }
  assert.equal(
    portLabel({ path: "COM12", friendlyName: "WCH USB-SERIAL Ch A" }),
    "WCH USB-SERIAL Ch A (COM12)",
  );
  assert.equal(
    portLabel({ path: "COM2", friendlyName: "Device (COM12)" }),
    "Device (COM12) (COM2)",
  );
  assert.equal(
    portLabel({ path: "COM3", friendlyName: " ", manufacturer: "WCH" }),
    "WCH (COM3)",
  );
  assert.equal(portLabel({ path: "/dev/ttyUSB0" }), "/dev/ttyUSB0");
});
test("wire byte preview is shared with sending and includes Unicode and CR endings", () => {
  assert.deepEqual(
    [...encodeSend({ text: "中", format: "text", ending: "cr" })],
    [0xe4, 0xb8, 0xad, 13],
  );
  assert.deepEqual(
    [...encodeSend({ text: "00 ff", format: "hex", ending: "crlf" })],
    [0, 255],
  );
  assert.throws(
    () => encodeSend({ text: "A", format: "hex", ending: "none" }),
    /HEX/,
  );
  assert.throws(
    () =>
      encodeSend({ text: "a".repeat(65537), format: "text", ending: "none" }),
    /64 KiB/,
  );
});
test("saved command tools start empty and reject malformed or unbounded preferences", () => {
  const blank = restoreSendTools(null);
  assert.equal(blank.history.length, 0);
  assert.ok(blank.commands.every((c) => c.text === ""));
  assert.equal(blank.clearAfterSend, false);
  assert.deepEqual(restoreSendTools("{bad"), blank);
  const saved = restoreSendTools(
    JSON.stringify({
      version: 1,
      commands: [
        {
          name: "帧",
          text: "AA 01",
          format: "hex",
          ending: "none",
          checksum: "modbus",
          selected: true,
        },
        { name: "bad", text: "x", format: "script", ending: "none" },
      ],
      history: [],
      clearAfterSend: true,
    }),
  );
  assert.equal(saved.commands.length, 1);
  assert.equal(saved.commands[0].text, "AA 01");
  assert.equal(saved.clearAfterSend, true);
  assert.equal(saved.commands[0].selected, true);
  assert.equal(saved.commands[0].checksum, "modbus");
  assert.deepEqual(restoreSendTools("x".repeat(1024 * 1024 + 1)), blank);
});
test("history preserves target and format, deduplicates exact entries and is bounded", () => {
  let history = restoreSendTools(null).history;
  const cmd = {
    target: "COM12",
    text: "AA",
    format: "hex" as const,
    ending: "none" as const,
  };
  history = rememberSend(history, cmd);
  history = rememberSend(history, cmd);
  assert.equal(history.length, 1);
  history = rememberSend(history, { ...cmd, target: "COM5" });
  assert.equal(history.length, 2);
  history = rememberSend(history, { ...cmd, format: "text" });
  assert.equal(history.length, 3);
  for (let i = 0; i < 40; i++)
    history = rememberSend(history, {
      ...cmd,
      text: String(i) + "x".repeat(65500),
    });
  assert.ok(history.length <= 20);
  assert.ok(JSON.stringify(history).length <= 256 * 1024);
  assert.equal(history[0].target, "COM12");
});

test("format conversion preserves UTF-8 bytes and rejects lossy editor text", async () => {
  const { convertFormat } = await import("../src/send-tools");
  assert.equal(convertFormat("123", "text", "hex"), "31 32 33");
  assert.equal(convertFormat("31 32 33", "hex", "text"), "123");
  for (const text of ["中文\nabc", "\uFEFFhello", "🙂", ""]) {
    assert.equal(
      convertFormat(convertFormat(text, "text", "hex"), "hex", "text"),
      text,
    );
  }
  assert.throws(() => convertFormat("FF", "hex", "text"), /UTF-8/);
  assert.throws(() => convertFormat("0D 0A", "hex", "text"), /HEX/);
  assert.throws(() => convertFormat("GG", "hex", "text"), /HEX/);
});
test("checksums cover payload, append once, and precede text line endings", () => {
  const base = { text: "123456789", format: "text", ending: "none" };
  const encode = (checksum: string) =>
    Buffer.from(encodeSend({ ...base, checksum }));
  assert.equal(encode("sum8").toString("hex"), "313233343536373839dd");
  assert.equal(encode("xor8").toString("hex"), "31323334353637383931");
  assert.equal(encode("modbus").toString("hex"), "313233343536373839374b");
  assert.equal(
    Buffer.from(
      encodeSend({
        text: "01 03 00 00 00 0A",
        format: "hex",
        ending: "crlf",
        checksum: "modbus",
      }),
    ).toString("hex"),
    "01030000000ac5cd",
  );
  assert.equal(
    Buffer.from(
      encodeSend({ ...base, checksum: "sum8", ending: "crlf" }),
    ).toString("hex"),
    "313233343536373839dd0d0a",
  );
  assert.throws(() => encode("unknown"), /校验/);
});

test("checksum ranges are inclusive byte indices and reject invalid selections", () => {
  const cmd = {
    text: "AA 01 03 00 00 00 0A BB",
    format: "hex",
    ending: "none",
    checksum: "modbus",
    checksumStart: 2,
    checksumEnd: 7,
  };
  assert.equal(
    Buffer.from(encodeSend(cmd)).toString("hex"),
    "aa01030000000abbc5cd",
  );
  assert.equal(
    Buffer.from(encodeSend({ ...cmd, checksumOrder: "big" })).toString("hex"),
    "aa01030000000abbcdc5",
  );
  for (const range of [
    { checksumStart: 0 },
    { checksumStart: 9 },
    { checksumEnd: 9 },
    { checksumEnd: 1 },
    { checksumStart: 1.5 },
  ])
    assert.throws(() => encodeSend({ ...cmd, ...range }), /范围/);
  assert.equal(
    Buffer.from(
      encodeSend({
        ...cmd,
        text: "中A",
        format: "text",
        checksum: "sum8",
        checksumStart: 4,
        checksumEnd: 0,
      }),
    ).toString("hex"),
    "e4b8ad4141",
  );
});
test("additional checksum variants have explicit parameters and known check vectors", () => {
  const base = { text: "123456789", format: "text", ending: "none" };
  for (const [checksum, suffix] of [
    ["ccitt-false", "b129"],
    ["crc32", "2639f4cb"],
    ["sum16", "dd01"],
    ["lrc8", "23"],
  ]) {
    assert.equal(
      Buffer.from(encodeSend({ ...base, checksum }))
        .subarray(9)
        .toString("hex"),
      suffix,
    );
  }
});

test("all 32 named command rows survive storage in their original order", () => {
  const template = restoreSendTools(null).commands[0];
  const commands = Array.from({ length: 32 }, (_, i) => ({
    ...template,
    name: "row " + (i + 1),
    text: "AT+" + i,
    selected: i % 2 === 0,
  }));
  assert.deepEqual(
    restoreSendTools(JSON.stringify({ version: 1, commands })).commands,
    commands,
  );
});
