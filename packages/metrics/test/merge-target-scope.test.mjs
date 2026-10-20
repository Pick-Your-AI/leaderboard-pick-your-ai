import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetric, getMetricDefinition, participationView, selectPortfolioFacts } from "../dist/index.js";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const roles = { pr_merged: "author", maintainer_merges: "merger", pr_coauthored: "coauthor" };
const actorIds = { pr_merged: "101", maintainer_merges: "102", pr_coauthored: "103" };
const policy = (metricId = "pr_merged", patch = {}) => ({
  metricId,
  version: "synthetic-merge-target/v1",
  definitionVersion: "synthetic-merge-target/v1",
  unit: getMetricDefinition(metricId).definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: [roles[metricId] ?? "author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
  ...patch,
});
const scope = (patch = {}) => ({
  timezone: "UTC",
  from,
  to,
  repos: ["42"],
  branch: "feature/Release",
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
  ...patch,
});
const fact = (metricId = "pr_merged", patch = {}) => ({
  id: `synthetic-${metricId}`,
  canonicalKey: `synthetic-merge-${metricId}`,
  metricId,
  actorId: actorIds[metricId],
  artifactId: "PR_synthetic_7",
  repoId: "42",
  role: roles[metricId],
  state: "observed",
  occurredAt: "2026-10-03T12:00:00Z",
  acceptedAt: null,
  observedAt: "2026-10-04T00:00:00Z",
  revision: 0,
  correctionReceipt: null,
  acceptanceReceipt: null,
  acceptedBy: null,
  subjectActorId: "101",
  eventContext: { projects: [], workstreams: [] },
  currentContext: { projects: [], workstreams: [] },
  mergeTarget: {
    schemaVersion: "pr-merge-target/v1",
    repositoryId: "42",
    pullRequestId: "PR_synthetic_7",
    eventId: "ME_synthetic_7",
    mergedAt: "2026-10-03T12:00:00.000Z",
    branch: "feature/Release",
    proofHash: "a".repeat(64),
  },
  ...patch,
});
const input = (facts) => ({
  datasetId: "synthetic-merge-targets",
  cutoff: to,
  backfillRevision: "synthetic/v1",
  repositoryIds: ["42", "43"],
  actors: ["101", "102", "103"].map((id) => ({
    id,
    login: `synthetic-${id}`,
    kind: "user",
    publicState: "visible",
  })),
  facts,
  coverage: ["42", "43"].map((scopeId) => ({
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId,
    windowStart: from,
    windowEnd: to,
    knownStart: from,
    lastSuccessfulSync: to,
    sourceWatermark: to,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  })),
});

for (const metricId of Object.keys(roles)) {
  test(`${metricId} uses the exact historical branch and preserves its separate contributor role`, () => {
    const frozen = input([fact(metricId)]);
    const before = JSON.stringify(frozen);
    const result = aggregateMetric(frozen, policy(metricId), scope());
    assert.equal(result.rows[0].actorId, actorIds[metricId]);
    assert.equal(result.rows[0].value, 1);
    assert.equal(result.coverage, "complete");
    for (const branch of ["feature/release", "main", "Release"]) {
      const excluded = aggregateMetric(frozen, policy(metricId), scope({ branch }));
      assert.equal(excluded.rows.length, 0);
      assert.equal(excluded.coverage, "complete");
      assert.equal(excluded.audit[0].reason, "branch_filter");
    }
    assert.deepEqual(selectPortfolioFacts(frozen, policy(metricId), scope()), frozen.facts);
    assert.equal(JSON.stringify(frozen), before);
  });
}

test("branch scopes require one repository and explicitly reject unsupported event or denominator semantics", () => {
  for (const patch of [{ repos: [] }, { repos: ["42", "43"] }, { branch: null }, { branch: "feature//main" }])
    assert.throws(() => aggregateMetric(input([]), policy(), scope(patch)), /one explicit repository/);
  for (const metricId of ["pr_opened", "pr_ready", "reverted_delivery"])
    assert.throws(() => aggregateMetric(input([]), policy(metricId), scope()), /unsupported for this metric/, metricId);
  assert.throws(() => selectPortfolioFacts(input([]), policy("pr_opened"), scope()), /unsupported for this metric/);
});

test("missing and malformed branch projections are unknown even with complete raw-source coverage", () => {
  for (const mergeTarget of [
    undefined,
    null,
    {},
    { branch: "feature/Release" },
    { ...fact().mergeTarget, proofHash: "bad" },
  ]) {
    const result = aggregateMetric(input([fact("pr_merged", { mergeTarget })]), policy(), scope());
    assert.equal(result.rows.length, 0);
    assert.equal(result.coverage, "incomplete");
    assert.equal(result.audit[0].reason, "unknown_merge_target");
  }
  const unproved = fact("pr_merged", { mergeTarget: undefined, rawState: "target:feature/Release" });
  assert.equal(aggregateMetric(input([unproved]), policy(), scope()).audit[0].reason, "unknown_merge_target");
});

test("projected merge evidence must bind the actual repository, PR, source clock and role", () => {
  const candidates = [
    fact("pr_merged", { mergeTarget: { ...fact().mergeTarget, repositoryId: "43" } }),
    fact("pr_merged", { mergeTarget: { ...fact().mergeTarget, pullRequestId: "PR_other" } }),
    fact("pr_merged", { mergeTarget: { ...fact().mergeTarget, mergedAt: "2026-10-03T12:00:00.001Z" } }),
    fact("pr_merged", { mergeTarget: { ...fact().mergeTarget, eventId: "" } }),
    fact("pr_merged", { role: "merger" }),
    fact("pr_merged", { outcome: "closed_unmerged" }),
    fact("pr_merged", { observedAt: "2026-10-03T11:00:00Z" }),
    fact("pr_coauthored", { state: "pending" }),
    fact("pr_coauthored", { subjectActorId: "103" }),
    fact("pr_coauthored", { subjectActorId: null }),
  ];
  for (const candidate of candidates) {
    const selected = policy(candidate.metricId, { roles: [candidate.role] });
    const result = aggregateMetric(input([candidate]), selected, scope());
    assert.equal(result.rows.length, 0, JSON.stringify(candidate));
    assert.equal(result.coverage, "incomplete");
    assert.equal(result.audit[0].reason, "unknown_merge_target");
  }
});

test("contradictory branch proofs cannot win by observation order or a second canonical key", () => {
  const original = fact();
  for (const sameCanonical of [true, false]) {
    const conflict = {
      ...original,
      id: "synthetic-conflict",
      canonicalKey: sameCanonical ? original.canonicalKey : "synthetic-other-adapter-key",
      mergeTarget: { ...original.mergeTarget, branch: "main", proofHash: "b".repeat(64) },
    };
    for (const facts of [
      [original, conflict],
      [conflict, original],
    ]) {
      const result = aggregateMetric(input(facts), policy(), scope());
      assert.equal(result.rows.length, 0);
      assert.equal(result.coverage, "incomplete");
      assert.equal(result.audit[0].reason, sameCanonical ? "ambiguous_canonical_action" : "conflicting_merge_target");
    }
  }
});

test("independent matching capture digests deduplicate one historical PR without losing its native identity", () => {
  const original = fact();
  const replay = {
    ...original,
    id: "synthetic-replay",
    observedAt: "2026-10-05T00:00:00Z",
    mergeTarget: { ...original.mergeTarget, proofHash: "b".repeat(64) },
  };
  const result = aggregateMetric(input([replay, original]), policy(), scope());
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.coverage, "complete");
  assert.equal(result.audit.filter((entry) => entry.reason === "duplicate_observation").length, 1);
});

test("an unproved current correction cannot restore an earlier valid merge target", () => {
  const original = fact();
  const correction = {
    ...original,
    revision: 1,
    correctionReceipt: "synthetic-reviewed-correction",
    observedAt: "2026-10-20T00:00:00Z",
    mergeTarget: undefined,
  };
  const result = aggregateMetric(input([original, correction]), policy(), scope());
  assert.equal(result.rows.length, 0);
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.audit[0].reason, "unknown_merge_target");
  const historical = aggregateMetric(
    { ...input([correction, original]), cutoff: "2026-10-10T00:00:00Z" },
    policy(),
    scope({ to: "2026-10-10T00:00:00Z" }),
  );
  assert.equal(historical.rows[0].value, 1);
});

test("known out-of-scope repositories and half-open event windows retain their ordinary exclusion meaning", () => {
  const outside = [
    fact("pr_merged", { repoId: "43", mergeTarget: undefined }),
    fact("pr_merged", { occurredAt: "2026-09-30T23:59:59Z", mergeTarget: undefined }),
    fact("pr_merged", { occurredAt: to, mergeTarget: undefined }),
    fact("pr_merged", { state: "excluded", mergeTarget: undefined }),
  ];
  for (const candidate of outside) {
    const result = aggregateMetric(input([candidate]), policy(), scope());
    assert.equal(result.rows.length, 0);
    assert.equal(result.coverage, "complete");
    assert.equal(
      result.audit.some((entry) => entry.reason === "unknown_merge_target"),
      false,
    );
  }
});

test("one known branch contribution alongside missing evidence stays partial rather than certified complete", () => {
  const known = fact();
  const unknown = fact("pr_merged", {
    id: "synthetic-unproved-pr",
    canonicalKey: "synthetic-unproved-pr",
    artifactId: "PR_synthetic_8",
    mergeTarget: undefined,
  });
  const result = aggregateMetric(input([known, unknown]), policy(), scope());
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.rows[0].state, "partial");
  assert.equal(result.coverage, "incomplete");
});

test("unfiltered scopes retain legacy result and duplicate behavior even when optional target proofs differ", () => {
  const { branch, ...legacyScope } = scope();
  const { mergeTarget, ...original } = fact();
  const replay = { ...original, id: "synthetic-replay", observedAt: "2026-10-05T00:00:00Z" };
  const expected = aggregateMetric(input([original, replay]), policy(), legacyScope);
  const extended = [
    { ...original, mergeTarget },
    { ...replay, mergeTarget: { ...mergeTarget, branch: "main", proofHash: "b".repeat(64) } },
  ];
  assert.deepEqual(aggregateMetric(input(extended), policy(), legacyScope), expected);
  assert.equal("branch" in expected.scope, false);
});

test("branch participation preserves organization history while keeping current activity branch-filtered", () => {
  const older = fact("pr_merged", {
    id: "synthetic-older-other-repository",
    canonicalKey: "synthetic-older-other-repository",
    artifactId: "PR_synthetic_old",
    repoId: "43",
    occurredAt: "2026-09-03T12:00:00Z",
    observedAt: "2026-09-04T00:00:00Z",
    mergeTarget: undefined,
  });
  const currentOtherBranch = fact("pr_merged", {
    id: "synthetic-current-other-branch",
    canonicalKey: "synthetic-current-other-branch",
    artifactId: "PR_synthetic_other",
    occurredAt: "2026-10-14T12:00:00Z",
    observedAt: "2026-10-15T00:00:00Z",
    mergeTarget: {
      ...fact().mergeTarget,
      pullRequestId: "PR_synthetic_other",
      eventId: "ME_synthetic_other",
      mergedAt: "2026-10-14T12:00:00.000Z",
      branch: "main",
    },
  });
  const frozen = input([fact(), currentOtherBranch, older]);
  for (const coverage of frozen.coverage) {
    coverage.windowStart = "2026-09-01T00:00:00Z";
    coverage.knownStart = "2026-09-01T00:00:00Z";
  }
  const selected = scope();
  const before = JSON.stringify({ frozen, selected });
  const [row] = participationView(frozen, policy(), selected, {
    originAt: "2026-09-01T00:00:00Z",
    reviewReceipt: "synthetic-known-history",
  });
  assert.equal(row.historyCoverage, "complete_known_history");
  assert.equal(row.firstContributionId, older.id);
  assert.equal(row.newcomer, false);
  assert.deepEqual(row.activeWeeks, ["2026-09-28T00:00:00.000Z"]);
  assert.equal(JSON.stringify({ frozen, selected }), before);
});
