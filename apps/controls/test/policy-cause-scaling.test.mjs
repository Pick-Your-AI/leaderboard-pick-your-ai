import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store.mjs";
import { PolicyComparisonStore, comparisonHash } from "../src/policy-comparison.mjs";
import * as metrics from "../../../packages/metrics/dist/index.js";

// Synthetic observations exercise the real engine and retained comparison store.
const cutoff = "2026-10-18T00:00:00.000Z";
const policy = {
  metricId: "issues_opened",
  version: "synthetic-policy/v1",
  definitionVersion: "candidate-0.1.1",
  unit: metrics.getMetricDefinition("issues_opened").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["reporter"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};

function fixture(size) {
  return {
    input: {
      datasetId: "synthetic-cause-scaling",
      cutoff,
      backfillRevision: "synthetic-revision",
      repositoryIds: ["2"],
      actors: [{ id: "101", login: "synthetic-contributor", kind: "user", publicState: "visible" }],
      facts: Array.from({ length: size }, (_, index) =>
        ["a", "b"].map((suffix) => ({
          id: `synthetic-${index}-${suffix}`,
          canonicalKey: `synthetic-action-${index}-${suffix}`,
          metricId: "issues_opened",
          actorId: "101",
          artifactId: `synthetic-artifact-${index}`,
          repoId: "2",
          role: "reporter",
          state: "observed",
          occurredAt: "2026-10-05T00:00:00.000Z",
          acceptedAt: null,
          observedAt: "2026-10-06T00:00:00.000Z",
          revision: 0,
          correctionReceipt: null,
          acceptanceReceipt: null,
          acceptedBy: null,
          subjectActorId: null,
          eventContext: { projects: [], workstreams: [] },
          currentContext: { projects: [], workstreams: [] },
        })),
      ).flat(),
      coverage: [],
    },
    scope: {
      timezone: "UTC",
      from: "2026-10-01T00:00:00.000Z",
      to: cutoff,
      repos: ["2"],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
    policies: [policy],
    snapshot: { snapshotId: "synthetic-snapshot", revision: 1 },
    authorization: {
      configurationHash: "synthetic-config",
      controlsConfigurationRevision: 0,
      dataMode: "synthetic",
      sources: [{ repositoryId: "2", generation: "0" }],
    },
  };
}

function measure(t, size) {
  const directory = mkdtempSync(join(tmpdir(), "policy-cause-scale-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let auditMembershipReads = 0;
  const engine = {
    ...metrics,
    comparePolicies(...args) {
      const comparison = metrics.comparePolicies(...args);
      for (const aggregate of [comparison.before, comparison.after]) {
        for (const entry of aggregate.audit) {
          const factIds = entry.factIds;
          Object.defineProperty(entry, "factIds", {
            enumerable: true,
            get() {
              auditMembershipReads++;
              return factIds;
            },
          });
        }
      }
      return comparison;
    },
  };
  const comparisons = new PolicyComparisonStore(store, engine, { now: () => Date.parse(cutoff) });
  const input = fixture(size);
  const captured = store.transaction((state) => comparisons.capture(state, input));
  assert.equal(captured.state, "retained");
  const record = comparisons.input(captured.inputId);
  const candidate = { ...policy, version: "synthetic-policy/v2", groupBy: "canonical" };
  const result = store.transaction(() => comparisons.compare(record, candidate));
  const observedReads = auditMembershipReads;
  const { document } = result;
  assert.equal(document.before.rows[0].value, size);
  assert.equal(document.after.rows[0].value, size * 2);
  assert.equal(document.changes.length, 1);
  assert.equal(document.changes[0].included.length, size);
  assert.deepEqual(document.changes[0].excluded, []);
  assert.deepEqual(document.changes[0].causes.changedPolicyFields, ["groupBy"]);
  const expectedCauses = Array.from({ length: size }, (_, index) => ({
    factId: `synthetic-${index}-b`,
    reasons: ["repeated_policy_unit"],
    revision: 0,
  })).sort((a, b) => a.factId.localeCompare(b.factId, "en"));
  const actualCauses = [...document.changes[0].causes.included].sort((a, b) => a.factId.localeCompare(b.factId, "en"));
  assert.deepEqual(actualCauses, expectedCauses);
  assert.equal(document.publicEnabled, false);
  assert.equal(document.activationSupported, false);
  assert.equal(result.resultHash, comparisonHash(document));
  assert.deepEqual(comparisons.result(document.comparisonId), result);
  assert.deepEqual(
    store.transaction(() => comparisons.compare(record, candidate)),
    result,
  );
  const removed = comparisons.redact(result, record, store.read(), ["synthetic-artifact-0"]);
  assert.equal(removed.redactionsApplied, true);
  assert.deepEqual(removed.changes, []);
  assert.deepEqual(removed.before.rows, []);
  assert.deepEqual(removed.after.rows, []);
  t.diagnostic(JSON.stringify({ size, auditMembershipReads: observedReads }));
  return observedReads;
}

test("retained policy explanations grow proportionally with changed evidence", (t) => {
  const smaller = measure(t, 128);
  const larger = measure(t, 256);
  assert.ok(smaller > 0, "the real comparison audit was inspected");
  assert.ok(
    larger <= smaller * 3,
    `Doubling changed evidence must not quadruple audit membership reads: ${smaller} -> ${larger}`,
  );
});
