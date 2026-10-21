import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation } from "../../github/dist/index.js";
import {
  aggregateMetric,
  getMetricDefinition,
  getMetricUi,
  metricRegistryV1,
  stableJSON,
  validateMetricPolicy,
} from "../dist/index.js";
import { curationActor, curationEvent, curationProjectId } from "../../../tests/fixtures/project-curation.mjs";

const metricId = "project_items_curated";
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-02T00:00:00.000Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
function policy(patch = {}) {
  return {
    metricId,
    version: "synthetic-native-project-curation/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["triager"],
    groupBy: "canonical",
    sources: ["github_graphql"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
}
function observation(eventId, options = {}, alter = () => {}) {
  const {
    actor = curationActor,
    projectId = curationProjectId,
    subjectId = "I_SYNTHETIC_CURATION",
    number = 1,
    kind = "issue",
    action = "added",
    createdAt = "2026-10-01T12:00:00.000Z",
    repositoryId = 2,
    observedAt = "2026-10-03T00:00:00.000Z",
    wasAutomated = false,
  } = options;
  const value = {
    repository: { id: repositoryId, slug: "synthetic-org/synthetic-repo", visibility: "public" },
    proof: { verified: true, source: "github_graphql", eventId, revision: "synthetic-source", isSynthetic: true },
    family: "project_curation",
    action,
    observedAt,
    occurredAt: createdAt,
    payload: {
      [kind]: {
        id: subjectId,
        number,
        url: "https://github.com/synthetic-org/synthetic-repo/" + (kind === "pull_request" ? "pull/" : "issues/") + number,
        // Neither the issue author nor a current item creator supplies this actor.
        user: { id: 101, node_id: "U_SYNTHETIC_AUTHOR", type: "User" },
        creator: { id: 303, node_id: "U_SYNTHETIC_CREATOR", type: "User" },
      },
      sender: { id: 404, type: "User" },
      project_curation: curationEvent(eventId, {
        actor,
        createdAt,
        wasAutomated,
        __typename: action === "removed" ? "RemovedFromProjectV2Event" : "AddedToProjectV2Event",
        project: { id: projectId, public: true },
      }),
    },
  };
  alter(value);
  const before = stableJSON(value);
  const output = normalizeGithubObservation(value);
  assert.equal(stableJSON(value), before);
  return output;
}
function board(results, selectedScope = scope) {
  const input = {
    datasetId: "synthetic-project-curation",
    cutoff: "2026-10-04T00:00:00.000Z",
    backfillRevision: "synthetic-native-project-curation/v1",
    repositoryIds: [...new Set(results.flatMap((result) => result.facts.map((fact) => fact.repoId)))],
    actors: [...new Map(results.flatMap((result) => result.actors).map((actor) => [actor.id, actor])).values()],
    facts: results.flatMap((result) => result.facts),
    coverage: [],
  };
  const before = stableJSON(input);
  const result = aggregateMetric(input, policy(), selectedScope);
  assert.equal(stableJSON(input), before);
  assert.equal(result.publicEnabled, false);
  assert.equal(result.coverage, "incomplete");
  assert.ok(result.rows.every((row) => row.rank === null));
  return result;
}
const values = (result) => result.rows.map((row) => [row.actorId, row.value]);
const noCount = (result) => assert.ok(result.rows.every((row) => row.value === null));

test("native Project curation pins source-time canonical operations and keeps public selection unavailable", () => {
  validateMetricPolicy(policy());
  for (const aggregation of ["sum", "ratio", "duration"])
    assert.throws(
      () => validateMetricPolicy(policy({ aggregation })),
      /Aggregation must match implemented registry semantics/,
    );
  for (const patch of [
    { groupBy: "actor_artifact" },
    { groupBy: "actor_artifact_state_interval", groupingSeconds: 3600 },
    { groupingSeconds: 86400 },
    { dateBasis: "acceptedAt" },
    { rankedStates: ["qualified"] },
    { rankedStates: ["reviewed"] },
    { roles: ["author"] },
    { roles: ["triager", "author"] },
  ])
    assert.throws(() => validateMetricPolicy(policy(patch)), /Project curation/);
  assert.equal(getMetricDefinition(metricId).coverage_class, "history_partial");
  assert.equal(getMetricUi(metricId).maturity, "definition_only");
  assert.deepEqual(getMetricUi(metricId).supported_combinations, []);
  assert.equal(getMetricUi(metricId).default_combination, null);
  assert.equal(metricRegistryV1.ui_metadata.public_enabled, false);
});

test("native add remove and re-add remain distinct while replay and arrival order cannot multiply credit", () => {
  const add = observation("PVE_ADD");
  const remove = observation("PVE_REMOVE", { action: "removed", createdAt: "2026-10-01T13:00:00.000Z" });
  const readd = observation("PVE_READD", { createdAt: "2026-10-01T14:00:00.000Z" });
  const replay = observation("PVE_ADD", { observedAt: "2026-10-03T01:00:00.000Z" });
  assert.equal(add.facts[0].id, replay.facts[0].id);
  const first = board([add, remove, readd, replay]);
  const reordered = board([replay, readd, remove, add]);
  assert.deepEqual(values(first), [["202", 3]]);
  assert.deepEqual(reordered.rows, first.rows);
  assert.deepEqual(new Set(first.rows[0].evidenceIds), new Set([add, remove, readd].map((value) => value.facts[0].id)));
  assert.deepEqual(add.actors.map((actor) => actor.id), ["202"]);
  assert.equal(add.actors[0].executionMode, "unknown");
  assert.equal(add.facts[0].acceptanceReceipt, null);
  assert.equal(add.facts[0].subjectActorId, null);
});

test("Project curation conserves repository subject Project and event identities before filtering", () => {
  // Deliberately reuse one fictional event ID to test every native scope
  // component independently; this is not a claim that GitHub reassigns IDs.
  const observations = [
    observation("PVE_BASE"),
    observation("PVE_BASE", { projectId: "PVT_OTHER" }),
    observation("PVE_BASE", { subjectId: "PR_OTHER", number: 2, kind: "pull_request" }),
    observation("PVE_BASE", { repositoryId: 3 }),
  ];
  assert.equal(new Set(observations.map((entry) => entry.facts[0].id)).size, 4);
  assert.deepEqual(values(board(observations)), [["202", 4]]);
  assert.deepEqual(values(board(observations, { ...scope, repos: ["2"], projects: ["PVT_OTHER"] })), [["202", 1]]);
  noCount(board(observations, { ...scope, workstreams: ["unproved-workstream"] }));
  noCount(board(observations, { ...scope, context: "current", projects: [curationProjectId] }));
});

test("native curation uses exact source instants at both half-open UTC boundaries", () => {
  const observations = [
    observation("PVE_BEFORE", { createdAt: "2026-09-30T23:59:59.999Z" }),
    observation("PVE_START", { createdAt: scope.from }),
    observation("PVE_LAST", { createdAt: "2026-10-01T23:59:59.999Z" }),
    observation("PVE_END", { createdAt: scope.to }),
  ];
  const result = board(observations);
  assert.deepEqual(values(result), [["202", 2]]);
  assert.deepEqual(new Set(result.rows[0].evidenceIds), new Set(observations.slice(1, 3).map((entry) => entry.facts[0].id)));
});

test("missing native proof actor identity or source scope never borrows author creator or snapshot credit", () => {
  const unknown = observation("PVE_UNKNOWN", { actor: null });
  assert.equal(unknown.facts[0].actorId, null);
  assert.equal(unknown.facts[0].state, "unknown");
  noCount(board([unknown]));
  for (const alter of [
    (value) => { value.proof.eventId = undefined; },
    (value) => { value.proof.source = "github_webhook"; },
    (value) => { value.payload.project_curation.id = "PVE_OTHER"; },
    (value) => { value.payload.project_curation.project.public = false; },
    (value) => { value.payload.project_curation.project.id = ""; },
    (value) => { value.payload.project_curation.__typename = "ProjectV2ItemStatusChangedEvent"; },
    (value) => { value.payload.project_curation.wasAutomated = undefined; },
    (value) => { value.payload.project_curation.createdAt = "2026-02-30T00:00:00Z"; },
    (value) => { value.payload.issue.id = ""; },
    (value) => { value.payload.issue.url = "https://github.com/other/repository/issues/1"; },
    (value) => { value.action = "snapshot"; },
  ]) {
    const output = observation("PVE_INVALID", {}, alter);
    assert.deepEqual(output.facts, []);
  }
  const snapshot = observation("PVE_SNAPSHOT", {}, (value) => { value.family = "project_snapshot"; });
  assert.deepEqual(snapshot.facts, []);
});

test("explicit automation and nonhuman accounts stay raw without human curation credit", () => {
  const automated = observation("PVE_AUTOMATED", { wasAutomated: true });
  assert.equal(automated.actors[0].kind, "user");
  assert.equal(automated.actors[0].executionMode, "automated");
  assert.equal(automated.facts[0].role, "automation");
  assert.equal(automated.facts[0].state, "observed");
  noCount(board([automated]));
  const bot = observation("PVE_BOT", { actor: { ...curationActor, __typename: "Bot" } });
  assert.equal(bot.actors[0].kind, "bot");
  noCount(board([bot]));
});

test("contradictory observations of one native operation fail closed instead of creating another actor credit", () => {
  const first = observation("PVE_CONFLICT");
  for (const patch of [
    { actor: { ...curationActor, id: "U_SYNTHETIC_OTHER", databaseId: 303 } },
    { action: "removed" },
    { createdAt: "2026-10-01T13:00:00.000Z" },
  ]) {
    const conflicting = observation("PVE_CONFLICT", patch);
    assert.equal(first.facts[0].id, conflicting.facts[0].id);
    assert.equal(first.facts[0].canonicalKey, conflicting.facts[0].canonicalKey);
    const result = board([first, conflicting]);
    noCount(result);
    assert.ok(result.audit.some((entry) => entry.reason === "conflicting_revision"));
  }
  assert.equal(first.facts[0].revision, 0);
  assert.equal(first.facts[0].correctionReceipt, null);
});
