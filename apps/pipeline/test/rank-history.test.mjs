import assert from "node:assert/strict";
import test from "node:test";
import { retainedRankHistory } from "../src/rank-history.mjs";

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
