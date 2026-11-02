import { test } from "node:test";
import assert from "node:assert/strict";
import { BAUD_RATES, parseBaudRate } from "../src/baud-rate";

test("common and custom baud rates accept decimal integers only", () => {
  for (const rate of BAUD_RATES)
    assert.equal(parseBaudRate(String(rate)), rate);
  assert.equal(parseBaudRate(" 123456 "), 123456);
  for (const input of [
    "",
    " ",
    "0",
    "49",
    "4000001",
    "115200.5",
    "1e6",
    "0x100",
    "-9600",
    "NaN",
    "Infinity",
    "9600bps",
  ])
    assert.throws(() => parseBaudRate(input), /波特率/);
});
