import assert from "node:assert/strict";
import test from "node:test";
import { coverageSchema } from "@pick-your-ai/contracts";
import {
  aggregateMetric,
  compareRankMovement,
  getMetricDefinition,
  hasCompleteSourceCoverage,
  participationView,
  stableJSON,
} from "../dist/index.js";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const scope = {
  timezone: "UTC",
  from,
  to,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const history = { originAt: from, reviewReceipt: "synthetic-reviewed-origin" };
const policy = (metricId = "pr_merged") => ({
  metricId,
  version: "synthetic-coverage-policy/v1",
  definitionVersion: "synthetic-coverage-definition/v1",
  unit: getMetricDefinition(metricId).definition.unit,
  aggregation: metricId === "pr_lines_changed" ? "sum" : "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
});
const coverage = (patch = {}) => ({
  schemaVersion: "leaderboard/v1",
  state: "complete",
  source: "github_rest",
  scopeId: "synthetic-repo",
  windowStart: from,
  windowEnd: to,
  knownStart: from,
  lastSuccessfulSync: to,
  sourceWatermark: to,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
  ...patch,
});
const input = (covered, metricId = "pr_merged") => ({
  datasetId: "synthetic-coverage-dataset",
  cutoff: to,
  backfillRevision: "synthetic-coverage-history/v1",
  repositoryIds: ["synthetic-repo"],
  actors: [{ id: "a", login: "synthetic-a", kind: "user", publicState: "visible" }],
  facts: [
    {
      id: "synthetic-fact",
      canonicalKey: "synthetic-action",
      metricId,
      actorId: "a",
      artifactId: "synthetic-pr",
      repoId: "synthetic-repo",
      role: "author",
      state: "qualified",
      occurredAt: "2026-10-05T00:00:00Z",
      acceptedAt: "2026-10-05T00:00:00Z",
      observedAt: "2026-10-06T00:00:00Z",
      revision: 0,
      correctionReceipt: null,
      acceptanceReceipt: "synthetic-acceptance",
      acceptedBy: "synthetic-independent-reviewer",
      subjectActorId: "a",
      eventContext: null,
      currentContext: null,
      ...(metricId === "pr_lines_changed" ? { quantity: 0 } : {}),
    },
  ],
  coverage: [covered],
});

function assertCoverageResults(covered, complete) {
  const frozen = input(covered);
  const original = stableJSON(frozen);
  const result = aggregateMetric(frozen, policy(), scope);
  assert.equal(hasCompleteSourceCoverage(frozen, policy(), scope), complete);
  assert.equal(result.coverage, complete ? "complete" : "incomplete");
  assert.deepEqual(
    [result.rows[0].state, result.rows[0].value, result.rows[0].rank, result.rows[0].evidenceIds],
    [complete ? "measured" : "partial", 1, 1, ["synthetic-fact"]],
  );
  assert.equal(result.publicEnabled, false);

  const zeroInput = input(covered, "pr_lines_changed");
  const originalZero = stableJSON(zeroInput);
  const zero = aggregateMetric(zeroInput, policy("pr_lines_changed"), scope).rows[0];
  assert.deepEqual(
    [zero.state, zero.value, zero.rank, zero.evidenceIds],
    [complete ? "zero" : "unknown", complete ? 0 : null, complete ? 1 : null, ["synthetic-fact"]],
  );
  const participant = participationView(frozen, policy(), scope, history)[0];
  assert.deepEqual(
    [participant.historyCoverage, participant.newcomer, participant.firstContributionId],
    [complete ? "complete_known_history" : "incomplete", complete ? true : null, "synthetic-fact"],
  );
  const later = aggregateMetric(
    { ...frozen, datasetId: "synthetic-later-dataset", cutoff: "2026-11-02T00:00:00Z" },
    policy(),
    scope,
  );
  const movement = compareRankMovement(result, later)[0];
  assert.deepEqual([movement.state, movement.delta], [complete ? "comparable" : "unavailable", complete ? 0 : null]);
  if (!complete) assert.equal(movement.reason, "insufficient_history");
  assert.equal(stableJSON(frozen), original);
  assert.equal(stableJSON(zeroInput), originalZero);
}

for (const [label, patch] of [
  ["UTC control", {}],
  ["offset window start", { windowStart: "2026-09-30T19:00:00-05:00" }],
  ["offset window end", { windowEnd: "2026-10-31T19:00:00-05:00" }],
  ["offset known origin", { knownStart: "2026-09-30T19:00:00-05:00" }],
  ["precise window start", { windowStart: "2026-10-01T00:00:00.000000000Z" }],
  ["precise window end", { windowEnd: "2026-11-01T00:00:00.000000000Z" }],
  ["precise known origin", { knownStart: "2026-10-01T00:00:00.000000000Z" }],
  [
    "combined equivalent source clocks",
    {
      windowStart: "2026-09-30T19:00:00.000000000-05:00",
      windowEnd: "2026-11-01T05:30:00.000000000+05:30",
      knownStart: "2026-10-01T09:00:00.000000000+09:00",
    },
  ],
])
  test(`${label} preserves exact complete counts, zero, history and movement`, () => {
    assertCoverageResults(coverageSchema.parse(coverage(patch)), true);
  });

for (const [label, patch] of [
  ["fractionally late window start", { windowStart: "2026-10-01T00:00:00.000000001Z" }],
  ["fractionally short window end", { windowEnd: "2026-10-31T23:59:59.999999999Z" }],
  ["fractionally late known origin", { knownStart: "2026-10-01T00:00:00.000000001Z" }],
  ["missing window start", { windowStart: null }],
  ["missing window end", { windowEnd: null }],
  ["missing known origin", { knownStart: null }],
])
  test(`${label} retains observed results without complete coverage claims`, () => {
    assertCoverageResults(coverageSchema.parse(coverage(patch)), false);
  });

for (const field of ["windowStart", "windowEnd", "knownStart"])
  for (const value of ["not-an-instant", "2026-02-30T00:00:00Z", "2026-11-01 00:00:00Z"])
    test(`direct frozen input cannot use invalid ${field}: ${value}`, () => {
      const invalid = coverage({ [field]: value });
      assert.equal(coverageSchema.safeParse(invalid).success, false);
      assertCoverageResults(invalid, false);
    });

for (const field of ["from", "to"])
  for (const value of ["2026-10-31T19:00:00-05:00", "2026-11-01T00:00:00.000000000Z"])
    test(`metric ${field} remains a strict UTC millisecond scope: ${value}`, () => {
      const requested = { ...scope, [field]: value };
      const frozen = input(coverage());
      for (const evaluate of [hasCompleteSourceCoverage, aggregateMetric, participationView])
        assert.throws(() => evaluate(frozen, policy(), requested), /Expected an explicit UTC instant/);
    });

for (const cutoff of ["2026-10-31T19:00:00-05:00", "2026-11-01T00:00:00.000000000Z"])
  test(`normalized frozen cutoff remains strict: ${cutoff}`, () => {
    for (const evaluate of [aggregateMetric, participationView])
      assert.throws(
        () => evaluate({ ...input(coverage()), cutoff }, policy(), scope),
        /Expected an explicit UTC instant/,
      );
  });

for (const field of ["occurredAt", "acceptedAt", "observedAt"])
  test(`normalized fact ${field} remains a strict UTC millisecond clock`, () => {
    const frozen = input(coverage());
    frozen.facts[0][field] = "2026-10-05T00:00:00.000000001Z";
    for (const evaluate of [aggregateMetric, participationView])
      assert.throws(() => evaluate(frozen, policy(), scope), /Expected an explicit UTC instant/);
  });

for (const originAt of ["2026-09-30T19:00:00-05:00", "2026-10-01T00:00:00.000000000Z"])
  test(`reviewed metric history origin remains strict: ${originAt}`, () => {
    assert.throws(
      () => participationView(input(coverage()), policy(), scope, { ...history, originAt }),
      /Expected an explicit UTC instant/,
    );
  });
