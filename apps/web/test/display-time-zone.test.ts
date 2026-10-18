import assert from "node:assert/strict";
import test from "node:test";
import { displayTimeZones, formatDisplayInstant, isDisplayTimeZone } from "../src/lib/display-time-zone.ts";
import { inWindow, parseScope, resolveWindow } from "../src/lib/scope.ts";

test("repeated autumn hours show distinct offsets and retain exact half-open event selection", () => {
  const first = "2026-11-01T05:30:00.000Z";
  const second = "2026-11-01T06:30:00.000Z";
  assert.match(formatDisplayInstant(first, "America/New_York"), /01:30:00\.000 GMT-04:00/);
  assert.match(formatDisplayInstant(second, "America/New_York"), /01:30:00\.000 GMT-05:00/);
  const window = { start: new Date(first), end: new Date(second), label: "Synthetic UTC interval" };
  assert.equal(inWindow("2026-11-01T05:29:59.999Z", window), false);
  assert.equal(inWindow(first, window), true);
  assert.equal(inWindow("2026-11-01T06:29:59.999Z", window), true);
  assert.equal(inWindow(second, window), false);
});

test("spring clock jumps and non-hour offsets describe the instant without moving UTC dates", () => {
  assert.match(formatDisplayInstant("2026-03-08T06:59:59.999Z", "America/New_York"), /01:59:59\.999 GMT-05:00/);
  assert.match(formatDisplayInstant("2026-03-08T07:00:00.000Z", "America/New_York"), /03:00:00\.000 GMT-04:00/);
  assert.match(formatDisplayInstant("2026-01-01T00:00:00.001Z", "Asia/Kathmandu"), /05:45:00\.001 GMT\+05:45/);
  for (const period of ["7d", "30d", "90d", "month", "quarter", "year", "all"]) {
    const query = `?period=${period}`;
    const cutoff = new Date("2026-03-08T07:00:00.000Z");
    assert.deepEqual(
      resolveWindow(parseScope(`${query}&tz=America%2FNew_York`).scope, cutoff),
      resolveWindow(parseScope(query).scope, cutoff),
    );
  }
});

test("timezone validation is bounded, accepts supported IANA aliases and rejects malformed choices", () => {
  for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "Pacific/Kiritimati", "Etc/GMT+5", "US/Eastern"])
    assert.equal(isDisplayTimeZone(zone), true, zone);
  for (const zone of [
    "",
    "Mars/Olympus",
    " UTC",
    "UTC ",
    "+05:00",
    "America//New_York",
    "<UTC>",
    "A".repeat(129),
    null,
    undefined,
    1,
  ])
    assert.equal(isDisplayTimeZone(zone), false, String(zone));
  const zones = displayTimeZones("US/Eastern");
  assert.equal(zones[0], "UTC");
  assert.ok(zones.includes("US/Eastern"));
  assert.equal(new Set(zones).size, zones.length);
  assert.throws(() => formatDisplayInstant("2026-01-01T00:00:00.000Z", "Mars/Olympus"), RangeError);
  assert.throws(() => formatDisplayInstant("not-an-instant", "UTC"), RangeError);
});

test("early Gregorian years retain their era instead of being displayed as a modern century", () => {
  assert.match(formatDisplayInstant("0000-02-29T00:00:00.000Z", "UTC"), /Feb 29, 1 BC/);
  const value = formatDisplayInstant("0099-01-01T00:00:00.000Z", "UTC");
  assert.match(value, /Jan 1, 99,/);
  assert.doesNotMatch(value, /1999/);
  assert.match(formatDisplayInstant("0001-01-01T00:00:00.000Z", "Etc/GMT+5"), /Dec 31, 1 BC/);
  assert.match(formatDisplayInstant("0000-12-31T23:00:00.000Z", "Etc/GMT-5"), /Jan 1, 1 AD/);
});
