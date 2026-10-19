import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetric, getMetricDefinition } from "../dist/index.js";

const cutoff = "2026-10-19T12:00:00Z";
const policy = {
  metricId: "issues_opened",
  version: "synthetic/v1",
  definitionVersion: "synthetic/v1",
  unit: getMetricDefinition("issues_opened").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["reporter"],
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
};
const scope = (context, workstreams) => ({
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: cutoff,
  repos: [],
  projects: [],
  workstreams,
  roles: [],
  actors: "user",
  context,
});
const input = (context, basis) => ({
  datasetId: "synthetic-workstream-scope",
  cutoff,
  backfillRevision: "synthetic/v1",
  repositoryIds: ["2"],
  actors: [{ id: "a", login: "synthetic-alice", kind: "user", publicState: "visible" }],
  coverage: [],
  facts: [
    {
      id: "synthetic-action",
      canonicalKey: "synthetic-action",
      metricId: "issues_opened",
      actorId: "a",
      artifactId: "I_synthetic",
      repoId: "2",
      role: "reporter",
      state: "observed",
      occurredAt: "2026-10-02T00:00:00Z",
      acceptedAt: null,
      observedAt: "2026-10-18T00:00:00Z",
      revision: 0,
      correctionReceipt: null,
      acceptanceReceipt: null,
      acceptedBy: null,
      subjectActorId: "a",
      eventContext: null,
      currentContext: null,
      [basis + "Context"]: context,
    },
  ],
});

for (const basis of ["event", "current"]) {
  test(`bounded workstream context validates scope and preserves OR semantics for ${basis} filtering`, () => {
    const context = {
      projects: [],
      workstreams: ["engineering"],
      workstreamsKnown: true,
      workstreamScope: ["engineering", "research"],
    };
    const original = input(context, basis);
    const bytes = JSON.stringify(original);
    assert.equal(aggregateMetric(original, policy, scope(basis, ["engineering", "outside"])).rows[0].value, 1);
    assert.equal(aggregateMetric(original, policy, scope(basis, ["research"])).audit[0].reason, "workstream_filter");
    assert.equal(
      aggregateMetric(original, policy, scope(basis, ["research", "outside"])).audit[0].reason,
      "unknown_membership_context",
    );
    assert.equal(JSON.stringify(original), bytes);
    for (const workstreamScope of [
      null,
      "engineering",
      [],
      ["research"],
      ["engineering", "engineering"],
      ["engineering", ""],
      ["engineering", 7],
    ]) {
      assert.throws(
        () => aggregateMetric(input({ ...context, workstreamScope }, basis), policy, scope(basis, [])),
        /Invalid membership context/,
      );
    }
  });

  test(`retained unscoped ${basis} contexts keep their existing semantics without acquiring scope evidence`, () => {
    const legacy = input({ projects: [], workstreams: [], workstreamsKnown: true }, basis);
    const bytes = JSON.stringify(legacy);
    assert.equal(aggregateMetric(legacy, policy, scope(basis, ["outside"])).audit[0].reason, "workstream_filter");
    assert.equal(JSON.stringify(legacy), bytes);
    assert.equal(
      aggregateMetric(
        input({ projects: [], workstreams: [], workstreamsKnown: false }, basis),
        policy,
        scope(basis, ["outside"]),
      ).audit[0].reason,
      "unknown_membership_context",
    );
    assert.equal(
      aggregateMetric(
        input({ projects: [], workstreams: [], workstreamsKnown: true, workstreamScope: [] }, basis),
        policy,
        scope(basis, ["outside"]),
      ).audit[0].reason,
      "unknown_membership_context",
    );
  });
}
