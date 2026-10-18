import assert from "node:assert/strict";
import test from "node:test";
import { nextCalendarRollover, requireSoakMidnightWindow, selectSoakTimezone } from "../soak/midnight.ts";

const at = (value) => Date.parse(value);
const HOUR = 3_600_000;

test("timezone selection leaves startup margin when the first candidate is about to roll over", () => {
  const now = at("2026-10-18T06:59:59.000Z");
  assert.equal(nextCalendarRollover("America/Los_Angeles", now), at("2026-10-18T07:00:00.000Z"));
  const selected = selectSoakTimezone(now, true);
  assert.notEqual(selected, "America/Los_Angeles");
  const delay = nextCalendarRollover(selected, now) - now;
  assert(delay >= 30 * 60_000 && delay <= 5 * HOUR);
});

test("selected timezone offers a safe natural transition throughout winter and summer days", () => {
  for (const date of ["2026-01-15", "2026-07-15", "2026-11-01"]) {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = at(date + "T00:00:00.000Z") + minute * 60_000 + 999;
      const selected = selectSoakTimezone(now, true);
      const delay = nextCalendarRollover(selected, now) - now;
      assert(delay >= 30 * 60_000 && delay <= 5 * HOUR);
    }
  }
});

test("a requested full-run zone must leave startup margin and precede the six-hour zone change", () => {
  const now = at("2026-10-18T06:59:59.000Z");
  assert.throws(() => selectSoakTimezone(now, true, "America/Los_Angeles"), /30 minutes to five hours/);
  assert.throws(() => selectSoakTimezone(now, true, "Etc/UTC"), /30 minutes to five hours/);
  assert.equal(selectSoakTimezone(now, true, "Pacific/Honolulu"), "Pacific/Honolulu");
});

test("the actual start observation rejects a rollover missed during browser setup", () => {
  const selected = selectSoakTimezone(at("2026-10-18T06:00:00.000Z"), true, "America/Los_Angeles");
  assert.throws(() => requireSoakMidnightWindow(selected, at("2026-10-18T07:00:01.000Z")), /expired during startup/);
  assert.throws(() => requireSoakMidnightWindow(selected, at("2026-10-18T06:59:59.000Z")), /expired during startup/);
  assert.equal(
    requireSoakMidnightWindow(selected, at("2026-10-18T06:02:00.000Z")).nextRolloverAt,
    "2026-10-18T07:00:00.000Z",
  );
});

test("next local calendar transition accounts for the 25-hour daylight-saving day", () => {
  const now = at("2026-11-01T04:30:00.000Z");
  assert.equal(nextCalendarRollover("America/New_York", now), at("2026-11-02T05:00:00.000Z"));
});

test("explicit short rehearsals validate their zone without claiming a midnight matrix", () => {
  const now = at("2026-10-18T06:59:59.000Z");
  assert.equal(selectSoakTimezone(now, false), "Etc/UTC");
  assert.equal(selectSoakTimezone(now, false, "America/Los_Angeles"), "America/Los_Angeles");
  assert.throws(() => selectSoakTimezone(now, false, "Not/AZone"), RangeError);
  assert.throws(() => nextCalendarRollover("Etc/UTC", NaN), /integer clock/);
});
