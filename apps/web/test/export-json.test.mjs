import assert from "node:assert/strict";
import test from "node:test";
import { parseExportJSON } from "../src/remote/export-json.ts";

test("export JSON rejects duplicate decoded members at every nesting level", () => {
  for (const raw of [
    '{"key":1,"key":2}',
    '{"key":1,"\\u006bey":2}',
    '[{"key":{"nested":1,"nested":2}}]',
    '{"array":[0,{"key":1,"key":2}]}',
  ])
    assert.throws(() => parseExportJSON(raw), /invalid_export_json/);
});

test("export JSON preserves normal syntax and text without confusing quoted keys with object structure", () => {
  const value = {
    nested: [{ first: '€, comma, quote" and slash\\', second: '{"repeated":1,"repeated":2}' }],
    empty: {},
    lists: [[], { first: 3 }],
    literals: [true, false, null, 1.5],
  };
  for (const raw of [JSON.stringify(value), JSON.stringify(value, null, 2)])
    assert.deepEqual(parseExportJSON(raw), value);
  for (const raw of ['{"key":1,}', '{"key" 1}', "[1,,2]", '{"key":"unterminated}', "[}", "{}{}"])
    assert.throws(() => parseExportJSON(raw));
});

test("export JSON bounds nesting and decoded source length before native parsing", () => {
  const allowed = "[".repeat(25) + "0" + "]".repeat(25);
  assert.deepEqual(parseExportJSON(allowed), JSON.parse(allowed));
  assert.throws(() => parseExportJSON("[".repeat(26) + "0" + "]".repeat(26)), /invalid_export_json/);
  assert.throws(() => parseExportJSON('"' + "x".repeat(2_000_000) + '"'), /invalid_export_json/);
});
