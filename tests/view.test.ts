import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsAfterClear } from "../src/clear-boundary";
import { View } from "../src/core/view";
import type { StoredEvent } from "../src/shared";

const rx = (seq: number, data: Buffer): StoredEvent => ({
  v: 1,
  seq,
  sessionId: "test",
  kind: "rx",
  at: "2026-11-02T00:00:00.000Z",
  mono: String(seq),
  source: "synthetic",
  target: "demo",
  baudRate: 115200,
  data: data.toString("base64"),
});
test("the HEX view keeps every byte and a short final row", () => {
  const view = new View();
  const bytes = Buffer.from([...Array.from({ length: 256 }, (_, n) => n), 0]);
  view.apply(rx(1, bytes));
  const rows = view.snapshot("hex").rows;
  assert.equal(rows.length, 9);
  assert.equal(rows.at(-1)?.text, "00");
  assert.equal(
    rows.map((row) => row.text).join(" "),
    bytes.toString("hex").match(/../g)!.join(" "),
  );
});
test("an unterminated prompt is visible and later becomes one complete line", () => {
  const view = new View({ maxRows: 1000, maxChars: 1024 * 1024 });
  view.apply(rx(1, Buffer.from("prompt> ")));
  assert.equal(view.textSnapshot().rows[0].text, "prompt> ");
  view.apply(rx(2, Buffer.from("OK\r\n")));
  assert.deepEqual(
    view.textSnapshot().rows.map((r) => r.text),
    ["prompt> OK"],
  );
});
test("a partial row keeps the same bounded row and character budget", () => {
  const view = new View({ maxRows: 1000, maxChars: 1024 * 1024 });
  for (let i = 0; i < 1000; i++)
    view.apply(rx(i + 1, Buffer.from("x".repeat(1500) + "\n")));
  view.apply(rx(1001, Buffer.from("partial")));
  const { rows } = view.textSnapshot();
  assert.ok(rows.length <= 1000);
  assert.ok(rows.reduce((n, r) => n + r.text.length, 0) <= 1024 * 1024);
  assert.equal(rows.at(-1)?.text, "partial");
});

test("view limits expand retention and shrinking evicts immediately without resetting IDs", () => {
  const view = new View({ maxRows: 3000, maxChars: 1024 * 1024 });
  for (let i = 0; i < 2500; i++) view.apply(rx(i + 1, Buffer.from("x\n")));
  assert.equal(view.textSnapshot().rows.length, 2500);
  view.setLimits({ maxRows: 1000, maxChars: 1024 * 1024 });
  assert.equal(view.textSnapshot().rows.length, 1000);
  assert.equal(view.textSnapshot().rows[0].id, 1501);
  assert.equal(view.textSnapshot().total, 2500);
  assert.throws(() => view.setLimits({ maxRows: Infinity, maxChars: 1 }));
});

test("clearing a partial line preserves later characters, intervening marks and both raw views", () => {
  const view = new View();
  view.apply(rx(1, Buffer.from("older\r\n提示>")));
  const before = view.clearBoundaries();
  const visible = () =>
    rowsAfterClear(view.textSnapshot().rows, before.text).map(
      (row) => row.text,
    );
  assert.deepEqual(visible(), []);
  view.apply({ ...rx(2, Buffer.alloc(0)), kind: "mark", message: "bookmark" });
  assert.deepEqual(visible(), ["bookmark"]);
  view.apply(rx(3, Buffer.from("好")));
  assert.deepEqual(visible(), ["bookmark", "好"]);
  const again = view.clearBoundaries();
  view.apply(rx(4, Buffer.from("了\r\nnext\n")));
  assert.deepEqual(visible(), ["bookmark", "好了", "next"]);
  assert.deepEqual(
    rowsAfterClear(view.textSnapshot().rows, again.text).map((row) => row.text),
    ["了", "next"],
  );
  assert.equal(rowsAfterClear(view.snapshot("hex").rows, again.hex).length, 1);
  assert.deepEqual(
    view.textSnapshot().rows.map((row) => row.text),
    ["older", "bookmark", "提示>好了", "next"],
  );
});
