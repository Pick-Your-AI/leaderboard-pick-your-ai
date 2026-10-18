import assert from "node:assert/strict";
import test from "node:test";
import { getMetricDefinition, participationView } from "../dist/index.js";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const origin = "2026-01-01T00:00:00Z";
const history = { originAt: origin, reviewReceipt: "synthetic-history-review" };
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
  version: "synthetic-role-history/v1",
  definitionVersion: "synthetic-definition/v1",
  unit: getMetricDefinition("pr_merged").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author", "coauthor"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
function fixture(earlierRole = "author", laterRole = "coauthor") {
  const fact = (id, role, at) => ({
    id,
    canonicalKey: `synthetic-action-${id}`,
    metricId: "pr_merged",
    actorId: "a",
    artifactId: `synthetic-artifact-${id}`,
    repoId: "synthetic-repo",
    role,
    state: "qualified",
    occurredAt: at,
    acceptedAt: at,
    observedAt: "2026-10-30T00:00:00Z",
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: "synthetic-acceptance",
    acceptedBy: "synthetic-independent-reviewer",
    subjectActorId: "a",
    eventContext: { projects: ["synthetic-project"], workstreams: ["synthetic-workstream"] },
    currentContext: { projects: ["synthetic-project"], workstreams: ["synthetic-workstream"] },
  });
  return {
    datasetId: "synthetic-role-history-input",
    cutoff: to,
    backfillRevision: "synthetic-history/v1",
    repositoryIds: ["synthetic-repo"],
    actors: [{ id: "a", login: "synthetic-actor", kind: "user", publicState: "visible" }],
    facts: [fact("earlier", earlierRole, "2026-09-01T10:00:00Z"), fact("selected", laterRole, "2026-10-05T10:00:00Z")],
    coverage: [
      {
        schemaVersion: "leaderboard/v1",
        state: "complete",
        source: "github_rest",
        scopeId: "synthetic-repo",
        windowStart: origin,
        windowEnd: to,
        knownStart: origin,
        lastSuccessfulSync: to,
        sourceWatermark: to,
        missingPages: 0,
        permissionsMissing: [],
        sourceErrors: [],
      },
    ],
  };
}

test("unfiltered reviewed organization history retains the earlier eligible contribution", () => {
  const input = fixture(),
    before = JSON.stringify(input);
  const [row] = participationView(input, policy, scope, history);
  assert.equal(row.newcomer, false);
  assert.equal(row.firstContributionId, "earlier");
  assert.deepEqual(row.activeWeeks, ["2026-10-05T00:00:00.000Z"]);
  assert.equal(row.denominatorWeeks, 5);
  assert.equal(JSON.stringify(input), before);
});

for (const [earlierRole, laterRole] of [
  ["author", "coauthor"],
  ["coauthor", "author"],
]) {
  test(`selecting ${laterRole} keeps earlier eligible ${earlierRole} organization history`, () => {
    const input = fixture(earlierRole, laterRole),
      before = JSON.stringify(input);
    const selected = { ...scope, roles: [laterRole] },
      scopeBefore = JSON.stringify(selected);
    const [row] = participationView(input, policy, selected, history);
    assert.equal(row.historyCoverage, "complete_known_history");
    assert.deepEqual(row.activeWeeks, ["2026-10-05T00:00:00.000Z"]);
    assert.equal(row.denominatorWeeks, 5);
    assert.equal(row.newcomer, false);
    assert.equal(row.firstContributionId, "earlier");
    assert.equal(JSON.stringify(input), before);
    assert.equal(JSON.stringify(selected), scopeBefore);
  });
}

test("the configured policy can exclude an earlier role from qualifying history", () => {
  const [row] = participationView(
    fixture(),
    { ...policy, roles: ["coauthor"] },
    { ...scope, roles: ["coauthor"] },
    history,
  );
  assert.equal(row.newcomer, true);
  assert.equal(row.firstContributionId, "selected");
  assert.equal(row.historyCoverage, "complete_known_history");
});

test("absent reviewed history remains unknown under a role selection", () => {
  const [row] = participationView(fixture(), policy, { ...scope, roles: ["coauthor"] });
  assert.equal(row.newcomer, null);
  assert.equal(row.historyCoverage, "incomplete");
  assert.deepEqual(row.activeWeeks, ["2026-10-05T00:00:00.000Z"]);
});

test("incomplete source history remains unknown under a role selection", () => {
  const input = fixture();
  input.coverage[0].knownStart = "2026-09-15T00:00:00Z";
  const [row] = participationView(input, policy, { ...scope, roles: ["coauthor"] }, history);
  assert.equal(row.newcomer, null);
  assert.equal(row.historyCoverage, "incomplete");
});

test("an uncertain earlier eligible role cannot certify a newcomer in the selected role", () => {
  const input = fixture();
  input.facts[0].state = "unknown";
  const [row] = participationView(input, policy, { ...scope, roles: ["coauthor"] }, history);
  assert.equal(row.newcomer, null);
  assert.equal(row.historyCoverage, "incomplete");
  assert.deepEqual(row.activeWeeks, ["2026-10-05T00:00:00.000Z"]);
});
