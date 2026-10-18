import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetric, getMetricDefinition, selectPortfolioFacts } from "../dist/index.js";

const classification = { schemaVersion: "leaderboard-service-account/v1", classificationId: "synthetic-review",
  githubDatabaseId: 101, source: "reviewed_source", evidenceIds: ["synthetic-source-evidence"],
  reviewerActorId: "202", reviewedAt: "2026-10-01T00:00:00Z" };
const actor = { id: "101", login: "synthetic-service", kind: "service_account", publicState: "visible",
  executionMode: "unknown", serviceAccountClassification: classification };
const fact = { id: "synthetic-fact", canonicalKey: "synthetic-action", metricId: "pr_merged", actorId: "101",
  artifactId: "synthetic-pr", repoId: "2", role: "author", state: "qualified", occurredAt: "2026-10-02T00:00:00Z",
  acceptedAt: "2026-10-02T00:00:00Z", observedAt: "2026-10-02T00:00:00Z", revision: 0, correctionReceipt: null,
  acceptanceReceipt: "synthetic-acceptance", acceptedBy: "202", subjectActorId: "101", eventContext: null, currentContext: null };
const input = { datasetId: "synthetic-dataset", cutoff: "2026-10-03T00:00:00Z", backfillRevision: "synthetic-v1",
  repositoryIds: ["2"], actors: [actor], facts: [fact], coverage: [] };
const scope = { timezone: "UTC", from: "2026-10-01T00:00:00Z", to: input.cutoff, repos: [], projects: [], workstreams: [],
  roles: [], actors: "user", context: "event" };
const policy = { metricId: "pr_merged", version: "synthetic-v1", definitionVersion: "synthetic-v1",
  unit: getMetricDefinition("pr_merged").definition.unit, aggregation: "count", dateBasis: "acceptedAt",
  rankedStates: ["qualified"], roles: ["author"], groupBy: "canonical", sources: ["github_rest"], minimumSamples: 1, rank: true };

test("service accounts never enter user-account rankings or portfolios but retain automation/all activity", () => {
  for (const actors of ["user", "automation", "all"]) {
    const result = aggregateMetric(input, policy, { ...scope, actors });
    const selected = selectPortfolioFacts(input, policy, { ...scope, actors });
    assert.equal(result.rows.length, actors === "user" ? 0 : 1);
    assert.equal(selected.length, actors === "user" ? 0 : 1);
    if (actors !== "user") {
      assert.equal(result.rows[0].actorId, "101");
      assert.equal(result.rows[0].value, 1);
    }
  }
  assert.equal(actor.executionMode, "unknown");
});

test("service-account evidence cannot be missing, misbound, future or silently downcast to user", () => {
  for (const patch of [
    { serviceAccountClassification: undefined },
    { serviceAccountClassification: { ...classification, evidenceIds: [] } },
    { serviceAccountClassification: { ...classification, reviewerActorId: "101" } },
    { serviceAccountClassification: { ...classification, githubDatabaseId: 999 } },
    { serviceAccountClassification: { ...classification, reviewedAt: "2026-10-04T00:00:00Z" } },
    { kind: "user" }, { kind: "bot" }, { executionMode: "manual" },
  ]) {
    assert.throws(() => aggregateMetric({ ...input, actors: [{ ...actor, ...patch }] }, policy, scope));
  }
});

test("ordinary and explicitly automated User accounts remain compatible without manual certification", () => {
  for (const executionMode of [undefined, "unknown", "automated"]) {
    const ordinary = { ...actor, kind: "user", serviceAccountClassification: undefined, executionMode };
    assert.equal(aggregateMetric({ ...input, actors: [ordinary] }, policy, scope).rows.length, 1);
    const automated = aggregateMetric({ ...input, actors: [ordinary] }, policy, { ...scope, actors: "automation" });
    assert.equal(automated.rows.length, executionMode === "automated" ? 1 : 0);
  }
});

test("combining observations cannot give a service-account node a different user-ranking identity", () => {
  const reviewed = { ...actor, githubDatabaseId: 101, githubNodeId: "U_synthetic_101" };
  const conflicting = { id: "999", login: "synthetic-other", kind: "user", publicState: "visible",
    githubDatabaseId: 999, githubNodeId: "U_synthetic_101", executionMode: "unknown" };
  const facts = [fact, { ...fact, id: "synthetic-other", canonicalKey: "synthetic-other", actorId: "999" }];
  for (const actors of [[reviewed, conflicting], [conflicting, reviewed]]) {
    assert.throws(() => aggregateMetric({ ...input, actors, facts }, policy, scope), /Conflicting actor node identity bindings/);
    assert.throws(() => selectPortfolioFacts({ ...input, actors, facts }, policy, scope), /Conflicting actor node identity bindings/);
  }
  const safe = { ...conflicting, githubNodeId: "U_synthetic_999" };
  assert.deepEqual(aggregateMetric({ ...input, actors: [reviewed, safe], facts }, policy, scope).rows.map((row) => row.actorId), ["999"]);
  for (const invalid of [
    { ...reviewed, githubDatabaseId: 999 },
    { ...reviewed, serviceAccountClassification: { ...classification, githubNodeId: "U_conflicting" } },
    { ...reviewed, githubNodeId: undefined, serviceAccountClassification: { ...classification, githubNodeId: "U_synthetic_101" } },
  ]) assert.throws(() => aggregateMetric({ ...input, actors: [invalid] }, policy, scope));
});
