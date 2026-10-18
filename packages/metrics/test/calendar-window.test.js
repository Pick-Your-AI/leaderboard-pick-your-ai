import assert from "node:assert/strict";
import test from "node:test";
import { resolveMetricWindow } from "../dist/index.js";

const novemberStarts = {
  month: "11-01T00:00:00.000Z",
  quarter: "10-01T00:00:00.000Z",
  year: "01-01T00:00:00.000Z",
};

test("calendar presets retain accepted years zero through ninety-nine", () => {
  for (const year of ["0000", "0001", "0042", "0099"]) {
    const cutoff = `${year}-11-03T12:34:56.007Z`;
    for (const [period, start] of Object.entries(novemberStarts)) {
      assert.deepEqual(resolveMetricWindow(period, cutoff), {
        timezone: "UTC", period, from: `${year}-${start}`, to: cutoff,
      }, `${period} in year ${year}`);
    }
  }
});

test("calendar presets retain later centuries and the maximum accepted year", () => {
  for (const year of ["0100", "1969", "2000", "2026", "9999"]) {
    const cutoff = `${year}-11-03T12:34:56.007Z`;
    for (const [period, start] of Object.entries(novemberStarts)) {
      assert.deepEqual(resolveMetricWindow(period, cutoff), {
        timezone: "UTC", period, from: `${year}-${start}`, to: cutoff,
      }, `${period} in year ${year}`);
    }
  }
});

test("calendar starts stay on day one across leap days and quarter-end cutoffs", () => {
  const cases = [
    ["0000-02-29", "0000-02-01", "0000-01-01", "0000-01-01"],
    ["1900-02-28", "1900-02-01", "1900-01-01", "1900-01-01"],
    ["2000-02-29", "2000-02-01", "2000-01-01", "2000-01-01"],
    ["2026-03-31", "2026-03-01", "2026-01-01", "2026-01-01"],
    ["2026-04-30", "2026-04-01", "2026-04-01", "2026-01-01"],
    ["2026-06-30", "2026-06-01", "2026-04-01", "2026-01-01"],
    ["2026-09-30", "2026-09-01", "2026-07-01", "2026-01-01"],
    ["9999-12-31", "9999-12-01", "9999-10-01", "9999-01-01"],
  ];
  for (const [day, month, quarter, year] of cases) {
    const cutoff = `${day}T23:59:59.999Z`;
    for (const [period, start] of Object.entries({ month, quarter, year })) {
      const window = resolveMetricWindow(period, cutoff);
      assert.equal(window.from, `${start}T00:00:00.000Z`, `${period} at ${day}`);
      assert.equal(window.to, cutoff);
    }
  }
});
