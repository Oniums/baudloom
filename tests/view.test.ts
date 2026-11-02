import { test } from "node:test";
import assert from "node:assert/strict";
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
