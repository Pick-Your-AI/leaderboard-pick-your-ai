import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetric, getMetricDefinition } from "../dist/index.js";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const at = "2026-10-05T00:00:00Z";
const metricId = "pr_lines_changed";
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
const policy = {
  metricId,
  version: "synthetic-scale-policy/v1",
  definitionVersion: "synthetic-scale-definition/v1",
  unit: getMetricDefinition(metricId).definition.unit,
  aggregation: "sum",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
function fixture(quantities) {
  let identityReads = 0;
  const actors = quantities.map((_, index) => ({
    get id() {
      identityReads++;
      return `actor-${String(index).padStart(5, "0")}`;
    },
    login: `synthetic-${String(index).padStart(5, "0")}`,
    kind: "user",
    publicState: "visible",
  }));
  const facts = quantities.map((quantity, index) => ({
    id: `synthetic-fact-${index}`,
    canonicalKey: `synthetic-action-${index}`,
    metricId,
    actorId: `actor-${String(index).padStart(5, "0")}`,
    artifactId: `synthetic-artifact-${index}`,
    repoId: "synthetic-repo",
    role: "author",
    state: "qualified",
    occurredAt: at,
    acceptedAt: at,
    observedAt: at,
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: "synthetic-reviewed-source",
    acceptedBy: "synthetic-independent-reviewer",
    subjectActorId: `actor-${String(index).padStart(5, "0")}`,
    eventContext: null,
    currentContext: null,
    ...(quantity === undefined ? {} : { quantity }),
  }));
  return {
    input: {
      datasetId: "synthetic-scale-dataset",
      cutoff: to,
      backfillRevision: "synthetic-scale-history/v1",
      repositoryIds: ["synthetic-repo"],
      actors,
      facts,
      coverage: [
        {
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
        },
      ],
    },
    identityReads: () => identityReads,
  };
}

test("a 10,000-contributor aggregate resolves source identities with bounded linear reads", (t) => {
  const size = 10_000;
  const h = fixture(Array.from({ length: size }, (_, index) => index + 1));
  const result = aggregateMetric(h.input, policy, scope);
  assert.equal(result.publicEnabled, false);
  assert.equal(result.rows.length, size);
  for (const [index, row] of result.rows.entries()) {
    assert.equal(row.actorId, `actor-${String(size - index - 1).padStart(5, "0")}`);
    assert.equal(row.value, size - index);
    assert.equal(row.rank, index + 1);
    assert.equal(row.tied, false);
    assert.equal(row.state, "measured");
    assert.equal(row.evidenceIds.length, 1);
  }
  // Count source-property reads instead of relying on host speed or wall time.
  assert.ok(h.identityReads() <= size * 20, `identity reads exceeded a linear budget: ${h.identityReads()}`);
  t.diagnostic(`Source identity reads for ${size} contributors: ${h.identityReads()}`);
});

test("indexed tie membership preserves dense ranks, complete zeroes and unranked unknowns", () => {
  const h = fixture([9, 9, 4, 0, 0, undefined, undefined]);
  const result = aggregateMetric(h.input, policy, scope);
  assert.deepEqual(
    result.rows.map((row) => [row.value, row.rank, row.tied, row.state]),
    [
      [9, 1, true, "measured"],
      [9, 1, true, "measured"],
      [4, 2, false, "measured"],
      [0, 3, true, "zero"],
      [0, 3, true, "zero"],
      [null, null, false, "unknown"],
      [null, null, false, "unknown"],
    ],
  );
  const unranked = aggregateMetric(h.input, { ...policy, rank: false }, scope);
  assert.ok(unranked.rows.every((row) => row.rank === null && row.tied === false));
  assert.deepEqual(
    unranked.rows.map((row) => row.actorId),
    h.input.actors.map((actor) => actor.id),
  );
});
