import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSearch, searchTerms } from "../src/log-search";
const base = {
  query: "error | timeout",
  exclude: "heartbeat",
  caseSensitive: false,
  onlyMatches: true,
};
test("literal multi-keyword search supports case, exclusion and highlight-only mode", () => {
  const search = compileSearch(base);
  assert.ok(search.visible("ERROR <script>"));
  assert.ok(!search.visible("error heartbeat"));
  assert.ok(!search.visible("normal"));
  assert.ok(compileSearch({ ...base, onlyMatches: false }).visible("normal"));
  assert.ok(!compileSearch({ ...base, caseSensitive: true }).matches("ERROR"));
  const literal = compileSearch({ ...base, query: "a.* | [x]", exclude: "" });
  assert.ok(!literal.matches("aaaa"));
  assert.ok(literal.matches("a.* [x]"));
  assert.deepEqual(literal.highlights("<a.*> [x]"), [
    { start: 1, end: 4 },
    { start: 6, end: 9 },
  ]);
  assert.equal(searchTerms("a|a|b|c|d|e|f|g").length, 6);
  assert.deepEqual(
    compileSearch({ ...base, query: "中" }).highlights("前中文"),
    [{ start: 1, end: 2 }],
  );
});
