import { test } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder, encodeCommand } from "../src/core/text";

test("split UTF-8 and CRLF preserve one line and final partial text", () => {
  const d = new LineDecoder();
  const b = Buffer.from("温度=23\r\nnext");
  assert.deepEqual(d.push(b.subarray(0, 2)), []);
  assert.deepEqual(d.push(b.subarray(2, 7)), []);
  assert.deepEqual(d.push(b.subarray(7, 11)), ["温度=23"]);
  assert.deepEqual(d.push(b.subarray(11)), []);
  assert.deepEqual(d.finish(), ["next"]);
});
test("unbroken lines are bounded without losing byte order", () => {
  const d = new LineDecoder(8);
  assert.deepEqual(d.push(Buffer.from("12345678901234567890")), [
    "12345678",
    "90123456",
  ]);
  assert.deepEqual(d.finish(), ["7890"]);
});
test("bounded lines preserve astral characters, empty lines and split CRLF", () => {
  const d = new LineDecoder(3);
  assert.deepEqual(d.push(Buffer.from("ab😀\r")), ["ab😀", ""]);
  assert.deepEqual(d.push(Buffer.alloc(0)), []);
  assert.deepEqual(d.push(Buffer.from("\n\r\n中")), [""]);
  assert.deepEqual(d.finish(), ["中"]);
});
test("new decoder cannot complete an old connection partial character", () => {
  const first = new LineDecoder();
  first.push(Buffer.from([0xe4, 0xb8]));
  assert.deepEqual(first.finish(), ["�"]);
  assert.deepEqual(new LineDecoder().push(Buffer.from("ok\n")), ["ok"]);
});
test("HEX validation happens before I/O, text newline is explicit", () => {
  assert.deepEqual(
    [...encodeCommand("00 ff 7F", "hex", "none")],
    [0, 255, 127],
  );
  for (const text of ["0", "GG", "00 zz", "a b", ""])
    assert.throws(() => encodeCommand(text, "hex", "none"));
  assert.equal(
    encodeCommand("你好", "text", "crlf").toString("hex"),
    "e4bda0e5a5bd0d0a",
  );
  assert.throws(() => encodeCommand("x".repeat(65537), "text", "none"));
});
