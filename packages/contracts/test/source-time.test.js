import assert from "node:assert/strict";
import test from "node:test";
import { compareSourceInstants, coverageSchema, sourceEventSchema } from "../dist/index.js";

test("exact source ordering preserves offsets, long fractions and the full accepted year range", () => {
  const cases = [
    ["2026-10-18T03:00:00.1234Z", "2026-10-18T03:00:00.1235Z", -1],
    ["2026-10-18T03:00:00.1234000Z", "2026-10-17T23:00:00.1234-04:00", 0],
    ["2026-10-18T03:00:00Z", "2026-10-18T05:00:00.00000+02:00", 0],
    ["1969-12-31T23:59:59.9999Z", "1970-01-01T00:00:00Z", -1],
    ["1969-12-31T23:59:59.1234Z", "1969-12-31T23:59:59.1235Z", -1],
    ["0000-01-01T00:00:00.0001Z", "0000-01-01T00:00:00.0002Z", -1],
    ["9999-12-31T23:59:59.999999999999999999Z", "9999-12-31T23:59:59.999999999999999998Z", 1],
  ];
  for (const [left, right, order] of cases) {
    assert.equal(sourceEventSchema.shape.occurredAt.safeParse(left).success, true);
    assert.equal(sourceEventSchema.shape.occurredAt.safeParse(right).success, true);
    assert.equal(Math.sign(compareSourceInstants(left, right)), order);
    assert.equal(Math.sign(compareSourceInstants(right, left)), -order || 0);
  }
  assert.equal(Number.isNaN(compareSourceInstants("invalid", "2026-10-18T00:00:00Z")), true);
});

const coverage = {
  schemaVersion: "leaderboard/v1",
  state: "complete",
  source: "github_rest",
  scopeId: "synthetic-precision",
  windowStart: "2026-10-18T03:00:00.1234Z",
  windowEnd: "2026-10-18T03:00:00.1235Z",
  knownStart: null,
  lastSuccessfulSync: null,
  sourceWatermark: null,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
};

test("coverage windows retain the source contract's full fractional precision", () => {
  assert.equal(coverageSchema.safeParse(coverage).success, true);
  assert.equal(
    coverageSchema.safeParse({ ...coverage, windowEnd: "2026-10-17T23:00:00.12340-04:00" }).success,
    false,
    "equivalent instants still form an empty window",
  );
  assert.equal(
    coverageSchema.safeParse({ ...coverage, windowEnd: "2026-10-18T03:00:00.1233Z" }).success,
    false,
    "reversed fractional bounds are invalid",
  );
  assert.equal(coverageSchema.safeParse({ ...coverage, windowEnd: "invalid" }).success, false);
});
