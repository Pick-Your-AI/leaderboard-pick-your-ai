import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { profile, selection } from "../../web/src/remote/client.ts";
import { selectionScope } from "../../web/src/remote/public-scope.ts";
import { participationFixture, participationStart, participationEnd } from "../../../tests/fixtures/participation.mjs";

async function actualProfile(
  t,
  { zero = false, partialResult = false, bounded = true, extra = "", change = () => {} } = {},
) {
  const input = participationFixture();
  const query = bounded ? `start=${participationStart}&end=${participationEnd}${extra}` : extra;
  const selected = selection(`?${query}`);
  input.selected.scope = selectionScope(selected);
  const row = input.selected.rows.find((entry) => entry.actorId === "101");
  if (zero) {
    row.result.value = 0;
    // An incomplete numeric sample is partial, never a certified zero result.
    row.result.state = partialResult ? "partial" : "zero";
    row.evidenceIds = [];
  }
  change(input, row);
  const app = createService({
    source: { read: async () => structuredClone(input) },
  });
  t.after(() => app.close());
  const response = await app.inject(`/api/v1/contributors/101?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const before = structuredClone(body);
  assert.deepEqual(profile(body, selected).activitySummary, body.activitySummary);
  assert.deepEqual(body, before);
  return { body, selected };
}

const missingCoverage = [
  [
    "partial coverage",
    (_input, row) => {
      row.result.coverage.state = "partial";
    },
  ],
  [
    "unknown coverage",
    (_input, row) => {
      row.result.coverage.state = "unknown";
    },
  ],
  [
    "unavailable coverage",
    (_input, row) => {
      row.result.coverage.state = "unavailable";
    },
  ],
  [
    "missing known-history start",
    (_input, row) => {
      row.result.coverage.knownStart = null;
    },
  ],
  [
    "known history one nanosecond after the start",
    (_input, row) => {
      row.result.coverage.knownStart = "2026-10-04T00:00:00.000000001Z";
    },
  ],
  [
    "missing covered-window start",
    (_input, row) => {
      row.result.coverage.windowStart = null;
    },
  ],
  [
    "covered window one nanosecond after the start",
    (_input, row) => {
      row.result.coverage.windowStart = "2026-10-04T00:00:00.000000001Z";
    },
  ],
  [
    "missing covered-window end",
    (_input, row) => {
      row.result.coverage.windowEnd = null;
    },
  ],
  [
    "covered window one nanosecond short of the end",
    (_input, row) => {
      row.result.coverage.windowEnd = "2026-10-18T23:59:59.999999999Z";
    },
  ],
  [
    "missing reconciled source watermark",
    (_input, row) => {
      row.result.coverage.sourceWatermark = null;
    },
  ],
  [
    "source watermark one nanosecond short of the end",
    (_input, row) => {
      row.result.coverage.sourceWatermark = "2026-10-18T23:59:59.999999999Z";
    },
  ],
  [
    "snapshot cutoff one nanosecond short of the end",
    (input) => {
      input.selected.snapshot.generatedAt = "2026-10-18T23:59:59.999999999Z";
    },
  ],
];

for (const zero of [false, true]) {
  for (const [name, change] of missingCoverage) {
    test(`client rejects a complete ${zero ? "zero" : "positive"} participation claim with ${name}`, async (t) => {
      const { body, selected } = await actualProfile(t, { zero, partialResult: zero, change });
      const honest = body.activitySummary.metrics[0];
      assert.equal(honest.state, zero ? "unknown" : "partial");
      assert.equal(honest.activeWeeks, zero ? null : 3);
      assert.equal(body.activitySummary.history.newcomer, null);

      const contradictory = structuredClone(body);
      contradictory.activitySummary.metrics[0].state = "measured";
      if (zero) contradictory.activitySummary.metrics[0].activeWeeks = 0;
      const original = structuredClone(contradictory),
        originalSelection = structuredClone(selected);
      assert.throws(() => profile(contradictory, selected), {
        status: 502,
        code: "invalid_participation_response",
      });
      assert.deepEqual(contradictory, original);
      assert.deepEqual(selected, originalSelection);
      assert.deepEqual(profile(body, selected).activitySummary, body.activitySummary);
    });
  }

  test(`client cannot certify complete ${zero ? "zero" : "positive"} all-time participation`, async (t) => {
    const { body, selected } = await actualProfile(t, { zero, partialResult: zero, bounded: false });
    assert.equal(body.activitySummary.denominatorWeeks, null);
    assert.equal(body.activitySummary.metrics[0].state, zero ? "unknown" : "partial");
    const contradictory = structuredClone(body);
    contradictory.activitySummary.metrics[0].state = "measured";
    if (zero) contradictory.activitySummary.metrics[0].activeWeeks = 0;
    assert.throws(() => profile(contradictory, selected), {
      status: 502,
      code: "invalid_participation_response",
    });
    assert.deepEqual(profile(body, selected).activitySummary, body.activitySummary);
  });

  for (const [version, extra] of [
    ["legacy event", ""],
    ["current Projects", "&context=current&project=7"],
    ["current Projects and roles", "&context=current&project=7&role=author"],
  ]) {
    test(`client preserves genuinely complete ${zero ? "zero" : "positive"} participation for ${version}`, async (t) => {
      const { body, selected } = await actualProfile(t, { zero, extra });
      const before = structuredClone(body);
      assert.equal(body.activitySummary.metrics[0].state, "measured");
      assert.equal(body.activitySummary.metrics[0].activeWeeks, zero ? 0 : 3);
      assert.equal(body.activitySummary.denominatorWeeks, 3);
      assert.equal(body.activitySummary.history.newcomer, null);
      assert.deepEqual(profile(body, selected).activitySummary, body.activitySummary);
      assert.deepEqual(body, before);
    });
  }

  test(`complete ${zero ? "zero" : "positive"} participation preserves equivalent offset clocks and finer cutoff precision`, async (t) => {
    const { body, selected } = await actualProfile(t, {
      zero,
      change(input, row) {
        row.result.coverage.knownStart = "2026-10-03T20:00:00-04:00";
        row.result.coverage.windowStart = "2026-10-03T20:00:00-04:00";
        row.result.coverage.windowEnd = "2026-10-18T20:00:00-04:00";
        row.result.coverage.sourceWatermark = "2026-10-19T00:00:00.000000001Z";
        input.selected.snapshot.generatedAt = "2026-10-19T00:00:00.000000001Z";
        input.head.publishedAt = "2026-10-20T00:00:00Z";
      },
    });
    assert.equal(body.activitySummary.metrics[0].state, "measured");
    assert.equal(body.generatedAt, "2026-10-19T00:00:00.000000001Z");
    assert.deepEqual(profile(body, selected).activitySummary, body.activitySummary);
  });
}

test("legacy profiles may omit participation without certifying incomplete history", async (t) => {
  const { body, selected } = await actualProfile(t, {
    change(_input, row) {
      row.result.coverage.state = "partial";
    },
  });
  const legacy = structuredClone(body);
  delete legacy.activitySummary;
  const accepted = profile(legacy, selected);
  assert.equal(accepted.activitySummary, null);
  assert.equal(accepted.results[0].coverage.state, "partial");
});
