import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import {
  assertMetric,
  deliveryHarness,
  deliveryMetrics,
  legacySignature,
  restart,
  version,
} from "./default-delivery-fixtures.mjs";

test("pre-transfer delivery classification survives an empty current result after actual reopen", async (t) => {
  const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true });
  const cutoff = new Date().toISOString();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  await assertMetric(h.runtime, h.metric, h.expected, first.snapshotId);
  const original = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  const priorSignature = comparisonHash([version, legacySignature(h.config)]);
  const currentSignature = comparisonHash([
    version,
    comparisonHash(["github-issue-transfer-admission/v1", legacySignature(h.config)]),
  ]);
  assert.equal(original.policy_signature, currentSignature);
  assert.equal(original.document.defaultDeliveryNormalizationVersion, version);
  // Model a persisted pre-transfer key without claiming to run an old runtime.
  // The complete document, its version marker and its hash remain unchanged.
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
    [original.fact_key, priorSignature, original.policy_signature],
  );
  const retained = { ...original, policy_signature: priorSignature };
  const sourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  const frozenRows = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
  ).rows;
  h.state.defaultBranch = undefined;
  const hydrations = h.state.hydrations;
  await restart(h, async (runtime) => {
    const corrected = (await runtime.runOnce({ cutoff })).publications[0];
    assert.ok(h.state.hydrations > hydrations, "the current normalizer must rehydrate the unchanged source");
    await assertMetric(runtime, h.metric, 0, corrected.snapshotId);
    const generations = (
      await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature")
    ).rows;
    assert.equal(generations.length, 2);
    assert.deepEqual(
      generations.find((row) => row.policy_signature === priorSignature),
      retained,
    );
    const current = generations.find((row) => row.policy_signature === currentSignature);
    assert.ok(current, "an empty result must keep the current delivery generation");
    assert.equal(current.document.defaultDeliveryNormalizationVersion, version);
    assert.equal(
      current.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
      false,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
      sourceRows,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId]))
        .rows,
      frozenRows,
    );
  });
});

test("a corrupt pre-transfer cache cannot supply delivery classification during reprocessing", async (t) => {
  const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true });
  await h.runtime.runOnce();
  const original = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  const priorSignature = comparisonHash([version, legacySignature(h.config)]);
  await h.db.query(
    `UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document_hash=$3
     WHERE fact_key=$1 AND policy_signature=$4`,
    [original.fact_key, priorSignature, "0".repeat(64), original.policy_signature],
  );
  const retainedRows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
  const snapshots = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows;
  h.state.defaultBranch = undefined;
  await restart(h, async (runtime) => {
    await assert.rejects(runtime.runOnce(), /normalization_integrity_error/);
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows, retainedRows);
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows,
      snapshots,
    );
  });
});
