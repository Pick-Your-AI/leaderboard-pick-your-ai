import assert from "node:assert/strict";
import test from "node:test";
import { getMetricDefinition, participationView } from "../dist/index.js";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const at = "2026-10-05T00:00:00Z";
const observed = "2026-10-06T00:00:00Z";
const history = { originAt: "2026-01-01T00:00:00Z", reviewReceipt: "synthetic-history-review" };
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
  metricId: "pr_merged",
  version: "synthetic-participation-policy/v1",
  definitionVersion: "synthetic-participation-definition/v1",
  unit: getMetricDefinition("pr_merged").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
const actor = (id) => ({ id, login: `synthetic-${id}`, kind: "user", publicState: "visible" });
const fact = (id, actorId, acceptedAt = at, repoId = "synthetic-repo") => ({
  id,
  canonicalKey: `synthetic-action-${id}`,
  metricId: policy.metricId,
  actorId,
  artifactId: `synthetic-artifact-${id}`,
  repoId,
  role: "author",
  state: "qualified",
  occurredAt: acceptedAt,
  acceptedAt,
  observedAt: observed,
  revision: 0,
  correctionReceipt: null,
  acceptanceReceipt: "synthetic-independent-acceptance",
  acceptedBy: "synthetic-reviewer",
  subjectActorId: actorId,
  eventContext: null,
  currentContext: null,
});
const input = (actors, facts, repositoryIds = ["synthetic-repo"]) => ({
  datasetId: "synthetic-participation-dataset",
  cutoff: to,
  backfillRevision: "synthetic-participation-history/v1",
  repositoryIds,
  actors,
  facts,
  coverage: repositoryIds.map((scopeId) => ({
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId,
    windowStart: history.originAt,
    windowEnd: to,
    knownStart: history.originAt,
    lastSuccessfulSync: to,
    sourceWatermark: to,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  })),
});

test("10,000-contributor participation preserves every result with bounded identity reads", (t) => {
  const size = 10_000;
  const ids = Array.from({ length: size }, (_, index) => `actor-${String(index).padStart(5, "0")}`);
  let identityReads = 0;
  const facts = ids.map((id, index) => ({
    ...fact(`synthetic-fact-${index}`, id),
    get actorId() {
      identityReads++;
      return id;
    },
  }));
  const rows = participationView(input(ids.map(actor), facts), policy, scope, history);
  assert.equal(rows.length, size);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.actorId, ids[index]);
    assert.equal(row.firstContributionId, `synthetic-fact-${index}`);
    assert.equal(row.firstContributionAt, at);
    assert.equal(row.firstObservedAt, observed);
    assert.deepEqual(row.activeWeeks, ["2026-10-05T00:00:00.000Z"]);
    assert.equal(row.denominatorWeeks, 5);
    assert.equal(row.newcomer, true);
    assert.equal(row.historyCoverage, "complete_known_history");
    assert.equal(row.ranked, false);
  }
  // Observe actual source-property work without depending on host speed.
  assert.ok(identityReads <= size * 100, `identity reads exceeded the linear budget: ${identityReads}`);
  t.diagnostic(`Fact actor identity reads for ${size} contributors: ${identityReads}`);
});

test("partitioned participation keeps actor ordering, historic scope and sorted active weeks", () => {
  const facts = [
    fact("b-later", "b", "2026-10-29T00:00:00Z"),
    fact("a-week-two", "a", "2026-10-12T00:00:00Z"),
    fact("z-history", "a", "2026-09-30T23:59:59.000Z", "synthetic-other"),
    fact("a-history", "a", "2026-09-30T23:59:59Z", "synthetic-other"),
    fact("a-week-one", "a", at),
    fact("a-same-week", "a", "2026-10-06T00:00:00Z"),
    fact("b-first", "b", from),
    fact("c-historic-only", "c", "2026-09-01T00:00:00Z"),
  ].map((entry) => ({ ...entry, observedAt: "2026-10-30T00:00:00Z" }));
  const frozen = input([actor("c"), actor("b"), actor("a")], facts, ["synthetic-repo", "synthetic-other"]);
  const original = JSON.stringify(frozen);
  const selected = { ...scope, repos: ["synthetic-repo"] };
  const rows = participationView(frozen, policy, selected, history);
  assert.deepEqual(
    rows.map((row) => row.actorId),
    ["a", "b"],
  );
  assert.deepEqual(
    rows.map((row) => row.firstContributionId),
    ["a-history", "b-first"],
  );
  assert.deepEqual(
    rows.map((row) => row.newcomer),
    [false, true],
  );
  assert.deepEqual(
    rows.map((row) => row.activeWeeks),
    [
      ["2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z"],
      ["2026-09-28T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
    ],
  );
  assert.ok(rows.every((row) => row.denominatorWeeks === 5 && row.ranked === false));
  assert.deepEqual(participationView({ ...frozen, facts: [...facts].reverse() }, policy, selected, history), rows);
  assert.equal(JSON.stringify(frozen), original);
  for (const row of participationView(frozen, policy, selected)) {
    assert.equal(row.newcomer, null);
    assert.equal(row.historyCoverage, "incomplete");
  }
  const allTime = participationView(frozen, policy, { ...selected, from: null });
  assert.deepEqual(
    allTime.map((row) => row.actorId),
    ["a", "b", "c"],
  );
  assert.ok(allTime.every((row) => row.denominatorWeeks === null && row.newcomer === null && row.ranked === false));
});
