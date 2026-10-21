import assert from "node:assert/strict";
import test from "node:test";
import { retainedRankHistory } from "../src/rank-history.mjs";
import { decisionProjectionBinding } from "../src/pull-request-decided-projection.mjs";

const receipt = (size) => ({
  snapshot: { snapshotId: "synthetic-indexed-snapshot", revision: 1 },
  scope: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z" },
  cutoff: "2026-10-18T00:00:00.000Z",
  backfillRevision: "synthetic-backfill-1",
  metrics: [
    {
      metricId: "issues_opened",
      policyVersion: "synthetic-policy-v1",
      policyHash: "a".repeat(64),
      definitionVersion: "synthetic-definition-v1",
      unit: "issues",
      aggregation: "count",
      coverage: "complete",
      rows: Array.from({ length: size }, (_, index) => ({
        actorId: `synthetic-actor-${index}`,
        value: 1,
        rank: 1,
        eligible: [{ factId: `synthetic-fact-${index}` }],
      })),
    },
  ],
  rankEvidence: {
    schemaVersion: "private-rank-evidence/v1",
    metrics: [
      {
        metricId: "issues_opened",
        sources: ["github_rest"],
        rows: Array.from({ length: size }, (_, index) => ({
          actorId: `synthetic-actor-${index}`,
          evidence: [
            {
              id: `synthetic-fact-${index}`,
              effectiveAt: "2026-10-10T00:00:00.000Z",
              observedAt: "2026-10-10T00:00:00.000Z",
              comparisonSignature: "b".repeat(64),
            },
          ],
        })),
      },
    ],
  },
});

test("large retained cohorts index rows once while preserving exact evidence", () => {
  const size = 10_000;
  const document = receipt(size);
  let actorReads = 0;
  for (const row of document.rankEvidence.metrics[0].rows) {
    const actorId = row.actorId;
    Object.defineProperty(row, "actorId", {
      get() {
        assert.ok(++actorReads <= size * 3, "retained actor lookups must stay linear");
        return actorId;
      },
    });
  }
  const history = retainedRankHistory(document);
  assert.equal(history.metrics[0].rows.length, size);
  for (let index = 0; index < size; index++)
    assert.deepEqual(history.metrics[0].rows[index], {
      actorId: `synthetic-actor-${index}`,
      value: 1,
      rank: 1,
      evidence: document.rankEvidence.metrics[0].rows[index].evidence,
    });
  assert.ok(actorReads <= size * 3);
});

test("retained cohort and evidence duplicates remain integrity failures", () => {
  for (const patch of [
    (rows) => rows.push(structuredClone(rows[0])),
    (rows) => {
      rows[1] = structuredClone(rows[0]);
    },
    (rows) => rows[0].evidence.push(structuredClone(rows[0].evidence[0])),
    (rows) => {
      rows[1].evidence = structuredClone(rows[0].evidence);
    },
  ]) {
    const document = receipt(2);
    patch(document.rankEvidence.metrics[0].rows);
    assert.throws(() => retainedRankHistory(document), /rank_history_integrity_error/);
  }
});

test("retained native ratio evidence preserves microseconds and nanoseconds without changing legacy clocks", () => {
  const document = receipt(1);
  const capture = {
    schemaVersion: "pipeline-pr-decision-generations/v1",
    source: "synthetic-native-rank-source",
    asOf: document.cutoff,
    observationCutoff: document.cutoff,
    runs: [
      {
        repositoryId: 2,
        runId: "synthetic-native-rank-run",
        accessGeneration: "1",
        completedAt: document.cutoff,
        observations: [],
      },
    ],
  };
  document.authorization = {
    pullRequestDecisionEvidence: capture,
    pullRequestDecisionProjection: decisionProjectionBinding(capture, document.scope.to, []),
  };
  document.metrics[0].metricId = "pr_accepted_rate";
  document.metrics[0].aggregation = "ratio";
  document.metrics[0].rows[0].rank = null;
  document.rankEvidence.metrics[0].metricId = "pr_accepted_rate";
  const evidence = document.rankEvidence.metrics[0].rows[0].evidence[0];
  evidence.effectiveAt = "2026-10-10T00:00:00.123456789Z";
  evidence.observedAt = "2026-10-10T00:00:01.123456Z";
  const original = structuredClone(document);
  assert.deepEqual(retainedRankHistory(document).metrics[0].rows[0].evidence, [evidence]);
  assert.deepEqual(document, original);
  for (const field of ["effectiveAt", "observedAt"]) {
    for (const invalid of ["2026-10-10T00:00:00.1234567890Z", "2026-10-10T00:00:00+00:00", "2026-02-30T00:00:00Z"]) {
      const changed = structuredClone(document);
      changed.rankEvidence.metrics[0].rows[0].evidence[0][field] = invalid;
      assert.throws(() => retainedRankHistory(changed), /rank_history_integrity_error/);
    }
  }
  for (const mutate of [
    (value) => {
      delete value.authorization;
    },
    (value) => {
      value.authorization.pullRequestDecisionProjection.captureHash = "0".repeat(64);
    },
    (value) => {
      value.authorization.pullRequestDecisionProjection.asOf = "2026-10-17T00:00:00.000Z";
    },
    (value) => {
      value.metrics[0].aggregation = "count";
    },
    (value) => {
      value.metrics[0].metricId = value.rankEvidence.metrics[0].metricId = "issues_opened";
    },
  ]) {
    const changed = structuredClone(document);
    mutate(changed);
    assert.throws(() => retainedRankHistory(changed), /rank_history_integrity_error/);
  }
});
