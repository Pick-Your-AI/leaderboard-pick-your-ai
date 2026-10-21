import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateMetric,
  metricDefinitionsV1,
  getMetricGroupingPolicy,
  relationshipPairNormalizationVersion,
  stableJSON,
} from "../dist/index.js";

// Synthetic normalized facts only. These do not certify source qualification,
// acceptance receipts, or an approved/public policy for any registry definition.
const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const at = "2026-10-05T00:00:00Z";
const aggregations = {
  count_distinct_eligible_units: "count",
  sum_eligible_line_units: "sum",
  ratio: "ratio",
  median_and_p75_of_elapsed_hours: "duration",
};
const relationshipMetric = (metricId) => ["reference_links", "closing_links"].includes(metricId);
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
const coverage = {
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
};
function policy(metric) {
  const grouping = getMetricGroupingPolicy(metric.id);
  return {
    metricId: metric.id,
    version: "synthetic-audit/v1",
    definitionVersion: "synthetic-definition/v1",
    unit: metric.definition.unit,
    aggregation: aggregations[metric.definition.aggregation],
    dateBasis: metric.id === "localization" ? "occurredAt" : "acceptedAt",
    rankedStates: ["qualified"],
    roles: ["author"],
    groupBy: metric.id === "localization" ? "canonical" : "actor_artifact",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
    ...(metric.id === "project_items_curated"
      ? {
          dateBasis: "occurredAt",
          rankedStates: ["observed"],
          roles: ["triager"],
          groupBy: "canonical",
        }
      : {}),
    ...(metric.id === "release_changes"
      ? {
          dateBasis: "occurredAt",
          groupBy: "canonical",
          groupingPolicyVersion: "release-inclusion-units/v1",
        }
      : {}),
    ...(metric.id === "helpful_feedback"
      ? {
          groupBy: "canonical",
          groupingPolicyVersion: "accepted-feedback-threads/v1",
        }
      : {}),
    ...(grouping
      ? {
          dateBasis: grouping.date_basis,
          rankedStates: [grouping.state],
          roles: ["triager"],
          groupBy: grouping.group_by,
          groupingSeconds: grouping.grouping_seconds,
          groupingPolicyVersion: grouping.version,
        }
      : {}),
    ...(relationshipMetric(metric.id)
      ? {
          dateBasis: "occurredAt",
          rankedStates: ["observed"],
          roles: ["triager"],
          groupBy: "canonical",
          groupingPolicyVersion: relationshipPairNormalizationVersion,
        }
      : {}),
  };
}
function fact(metric, id, patch = {}) {
  return {
    id,
    canonicalKey: `synthetic:${id}`,
    metricId: metric.id,
    actorId: "a",
    artifactId: `synthetic:${id}`,
    repoId: "synthetic-repo",
    role: "author",
    state: "qualified",
    occurredAt: at,
    acceptedAt: at,
    observedAt: at,
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: "synthetic-acceptance",
    acceptedBy: "synthetic-independent-reviewer",
    subjectActorId: "a",
    eventContext: null,
    currentContext: null,
    quantity: 7,
    outcome: "merged",
    readyAt: at,
    firstReviewAt: "2026-10-05T02:00:00Z",
    ...(getMetricGroupingPolicy(metric.id)
      ? {
          role: "triager",
          state: "observed",
          acceptedAt: null,
          acceptanceReceipt: null,
          acceptedBy: null,
          rawState: "labeled:synthetic-bug",
        }
      : {}),
    ...(metric.id === "project_items_curated"
      ? {
          role: "triager",
          state: "observed",
          acceptedAt: null,
          acceptanceReceipt: null,
          acceptedBy: null,
          rawState: "added:PVT_synthetic",
        }
      : {}),
    ...(metric.id === "release_changes"
      ? {
          releaseInclusion: {
            version: "release-inclusion-units/v1",
            releaseId: 1,
            releaseNodeId: "RE_synthetic",
            pullRequestNodeId: `synthetic:${id}`,
            mergeCommitSha: "a".repeat(40),
            releaseCommitSha: "b".repeat(40),
            publishedAt: patch.occurredAt ?? at,
            proofHash: "c".repeat(64),
          },
        }
      : {}),
    ...(relationshipMetric(metric.id)
      ? {
          repoId: "2",
          role: "triager",
          state: "observed",
          acceptedAt: null,
          acceptanceReceipt: null,
          acceptedBy: null,
          relationshipPair: {
            version: relationshipPairNormalizationVersion,
            kind: metric.id === "reference_links" ? "reference" : "closing",
            action: metric.id === "reference_links" ? "reference" : "connect",
            eventId: `synthetic-pair-event:${id}`,
            from: { repositoryId: "2", artifactId: `synthetic:${id}`, kind: "pull_request" },
            to: { repositoryId: "2", artifactId: `synthetic-target:${id}`, kind: "issue" },
          },
        }
      : {}),
    ...patch,
  };
}
function input(facts, patch = {}) {
  const pairs = facts.some((fact) => relationshipMetric(fact.metricId));
  return {
    datasetId: "synthetic-invariant-audit",
    cutoff: to,
    backfillRevision: "synthetic-backfill/v1",
    repositoryIds: [pairs ? "2" : "synthetic-repo"],
    actors: ["a", "b"].map((id) => ({ id, login: `synthetic-${id}`, kind: "user", publicState: "visible" })),
    facts,
    coverage: [pairs ? { ...coverage, scopeId: "2" } : coverage],
    ...patch,
  };
}
function board(metric, facts, patch = {}) {
  return aggregateMetric(input(facts, patch), policy(metric), scope);
}

// Pin unsupported definitions explicitly: adding a new unsupported aggregation
// requires a coverage decision rather than silently disappearing from this suite.
test("audit accounts for every registry definition and rejects unsupported net lines", () => {
  const unsupported = metricDefinitionsV1.filter((metric) => !aggregations[metric.definition.aggregation]);
  assert.deepEqual(
    unsupported.map((metric) => metric.id),
    ["net_lines"],
  );
  assert.equal(metricDefinitionsV1.length, 98);
  assert.throws(
    () => aggregateMetric(input([]), { ...policy(unsupported[0]), aggregation: "sum" }, scope),
    /signed net changes/,
  );
});

for (const metric of metricDefinitionsV1.filter((metric) => aggregations[metric.definition.aggregation])) {
  test(`${metric.id}: candidate inclusion, exclusion, actor conservation and deterministic correction`, () => {
    assert.deepEqual(board(metric, []).rows, [], "empty observations cannot invent a contributor");
    const included = fact(metric, "included");
    const grouping = getMetricGroupingPolicy(metric.id);
    const invalidEligibility = relationshipMetric(metric.id)
      ? { occurredAt: null }
      : grouping?.group_by === "actor_artifact_state_interval"
        ? { rawState: undefined }
        : grouping || metric.id === "project_items_curated"
          ? { occurredAt: null }
          : { acceptedBy: "a" };
    const eligibilityReason = relationshipMetric(metric.id)
      ? "ambiguous_relationship_pair"
      : grouping?.group_by === "actor_artifact_state_interval"
        ? "unknown_raw_state_or_time"
        : grouping || metric.id === "project_items_curated"
          ? "unknown_effective_time"
          : "missing_independent_acceptance";
    const facts = [
      included,
      { ...included, id: "duplicate-adapter" },
      fact(metric, "other-actor", { actorId: "b", subjectActorId: "b" }),
      fact(metric, "invalid-eligibility", invalidEligibility),
      fact(metric, "excluded", { state: "excluded" }),
      fact(metric, "outside", { occurredAt: to, acceptedAt: to, readyAt: to }),
      fact(metric, "future-observation", { observedAt: "2026-11-02T00:00:00Z" }),
    ];
    const frozen = input(facts);
    const original = stableJSON(frozen);
    const result = aggregateMetric(frozen, policy(metric), scope);
    const expectedValue = { count: 1, sum: 7, ratio: 1, duration: 2 }[policy(metric).aggregation];
    assert.equal(result.publicEnabled, false);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(
      result.rows.map((row) => [row.actorId, row.value, row.sampleCount]),
      [
        ["a", expectedValue, 1],
        ["b", expectedValue, 1],
      ],
    );
    const evidence = result.rows.flatMap((row) => row.evidenceIds);
    assert.equal(evidence.length, 2);
    assert.ok(evidence.includes("other-actor"));
    assert.ok(evidence.includes("included") || evidence.includes("duplicate-adapter"));
    assert.ok(result.audit.some((entry) => entry.reason === eligibilityReason));
    assert.equal(result.coverage, "incomplete", "unverified eligibility must prevent complete coverage");
    assert.equal(stableJSON(board(metric, [...facts].reverse())), stableJSON(result));
    assert.equal(stableJSON(frozen), original, "rebuild must not mutate frozen facts");

    // A reviewed source deletion/exclusion reverses only its own actor's unit.
    const correction = {
      ...included,
      state: "excluded",
      revision: 1,
      correctionReceipt: "synthetic-reviewed-deletion",
      observedAt: "2026-10-20T00:00:00Z",
    };
    const corrected = board(metric, [included, facts[2], correction]);
    assert.deepEqual(
      corrected.rows.map((row) => row.actorId),
      ["b"],
    );
    assert.equal(corrected.rows[0].value, expectedValue);
    const historicalScope = { ...scope, to: "2026-10-10T00:00:00Z" };
    const historic = aggregateMetric(
      input([correction, facts[2], included], { cutoff: historicalScope.to }),
      policy(metric),
      historicalScope,
    );
    assert.equal(historic.rows.length, 2, "later deletion cannot rewrite an earlier frozen observation cutoff");
  });
}

for (const metricId of ["pr_lines_added", "pr_accepted_rate", "review_wait"]) {
  const metric = metricDefinitionsV1.find((metric) => metric.id === metricId);
  test(`${metricId}: complete zero differs from missing source coverage`, () => {
    const zero = fact(metric, "zero", { quantity: 0, outcome: "closed_unmerged", firstReviewAt: at });
    const complete = board(metric, [zero]);
    assert.equal(complete.rows[0].value, 0);
    assert.equal(complete.rows[0].state, "zero");
    for (const patch of [
      { coverage: [] },
      { coverage: [{ ...coverage, permissionsMissing: ["synthetic-permission"] }] },
    ]) {
      const unknown = board(metric, [zero], patch);
      assert.equal(unknown.rows[0].value, null);
      assert.equal(unknown.coverage, "incomplete");
    }
    assert.deepEqual(board(metric, []).rows, [], "no observations cannot invent zero-valued people");
  });
}
