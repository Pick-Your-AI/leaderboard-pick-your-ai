import assert from "node:assert/strict";
import test from "node:test";
import { defaultScope, inWindow, parseScope, resolveWindow, serializeScope } from "../src/lib/scope.ts";

test("calendar scopes preserve accepted UTC years and the supplied cutoff", () => {
  for (const year of ["0000", "0001", "0042", "0099", "0100", "1969", "2000", "2026", "9999"]) {
    const original = `${year}-11-30T12:34:56.007Z`;
    const cutoff = new Date(original);
    for (const [period, start] of [
      ["month", `${year}-11-01T00:00:00.000Z`],
      ["quarter", `${year}-10-01T00:00:00.000Z`],
      ["year", `${year}-01-01T00:00:00.000Z`],
    ] as const) {
      const window = resolveWindow({ ...defaultScope, period }, cutoff);
      assert.equal(window.start?.toISOString(), start, `${period} in ${year}`);
      assert.equal(window.end, cutoff);
      assert.equal(cutoff.toISOString(), original);
      assert.equal(inWindow(start, window), true);
      assert.equal(inWindow(original, window), false);
    }
  }
});

test("calendar scopes keep day one through leap days and quarter ends", () => {
  for (const [day, month, quarter, year] of [
    ["0000-02-29", "0000-02-01", "0000-01-01", "0000-01-01"],
    ["1900-02-28", "1900-02-01", "1900-01-01", "1900-01-01"],
    ["2000-02-29", "2000-02-01", "2000-01-01", "2000-01-01"],
    ["2026-03-31", "2026-03-01", "2026-01-01", "2026-01-01"],
    ["2026-04-30", "2026-04-01", "2026-04-01", "2026-01-01"],
    ["2026-06-30", "2026-06-01", "2026-04-01", "2026-01-01"],
    ["2026-09-30", "2026-09-01", "2026-07-01", "2026-01-01"],
    ["9999-12-31", "9999-12-01", "9999-10-01", "9999-01-01"],
  ]) {
    const original = `${day}T23:59:59.999Z`;
    const cutoff = new Date(original);
    for (const [period, start] of [
      ["month", month],
      ["quarter", quarter],
      ["year", year],
    ] as const) {
      const window = resolveWindow({ ...defaultScope, period }, cutoff);
      assert.equal(window.start?.toISOString(), `${start}T00:00:00.000Z`, `${period} at ${day}`);
      assert.equal(cutoff.toISOString(), original);
    }
  }
});

test("accepted custom dates round-trip without century remapping and retain half-open bounds", () => {
  for (const [from, to, cutoff] of [
    ["0000-02-29", "0000-03-02", "0000-03-03"],
    ["0001-01-01", "0001-01-02", "0001-01-03"],
    ["0099-12-31", "0100-01-02", "0100-01-03"],
    ["9999-12-29", "9999-12-30", "9999-12-31"],
  ]) {
    const parsed = parseScope(`?from=${from}&to=${to}`);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parseScope(serializeScope(parsed.scope)), parsed);
    const window = resolveWindow(parsed.scope, new Date(`${cutoff}T12:00:00.000Z`));
    assert.equal(window.start?.toISOString(), `${from}T00:00:00.000Z`);
    assert.equal(window.end.toISOString(), `${to}T00:00:00.000Z`);
    assert.equal(inWindow(`${from}T00:00:00.000Z`, window), true);
    assert.equal(inWindow(`${to}T00:00:00.000Z`, window), false);
    assert.equal(inWindow(new Date(window.end.getTime() - 1).toISOString(), window), true);
  }
});

test("custom scopes truncate at the original snapshot cutoff without mutating it", () => {
  const parsed = parseScope("?from=0099-11-01&to=0099-12-01");
  assert.deepEqual(parsed.issues, []);
  const original = "0099-11-03T12:34:56.007Z";
  const cutoff = new Date(original);
  const window = resolveWindow(parsed.scope, cutoff);
  assert.equal(window.start?.toISOString(), "0099-11-01T00:00:00.000Z");
  assert.equal(window.end, cutoff);
  assert.equal(cutoff.toISOString(), original);
  assert.equal(inWindow("0099-11-03T12:34:56.006Z", window), true);
  assert.equal(inWindow(original, window), false);
});
