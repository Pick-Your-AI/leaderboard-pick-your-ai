import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import {
  assertMetric,
  currentSignature,
  deliveryHarness,
  deliveryMetrics,
  legacySignature,
  restart,
  version,
} from "./default-delivery-fixtures.mjs";

// These literal historical keys model persisted rows from the two independently
// versioned upgrades. The current document bytes are retained under those keys;
// this fixture does not claim that an earlier runtime was executed.
const precedingSignature = (config, generation) => {
  if (generation === "P1") return legacySignature(config);
  if (generation === "A(P1)") return comparisonHash(["github-issue-transfer-admission/v1", legacySignature(config)]);
  assert.equal(generation, "P2");
  return comparisonHash([
    "project-membership-context/v2",
    comparisonHash([
      "verified-default-branch-merge-pins/v1",
      comparisonHash([
        normalizationDocumentVersion,
        comparisonHash(["current-state-selection-v1", "synthetic", config.policies.map((entry) => entry.signature)]),
      ]),
    ]),
    [],
  ]);
};

for (const generation of ["A(P1)", "P2"])
  test(`${generation} delivery classification survives a fresh empty result after restart`, async (t) => {
    const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true });
    const cutoff = new Date().toISOString();
    const first = (await h.runtime.runOnce({ cutoff })).publications[0];
    await assertMetric(h.runtime, h.metric, h.expected, first.snapshotId);
    const original = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
    const prior = comparisonHash([version, precedingSignature(h.config, generation)]);
    const current = comparisonHash([version, currentSignature(h.config)]);
    assert.equal(original.policy_signature, current);
    assert.notEqual(prior, current);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
      [original.fact_key, prior, current],
    );
    const retained = { ...original, policy_signature: prior };
    const sources = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
    const frozen = (
      await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
    ).rows;
    h.state.defaultBranch = undefined;
    const hydrations = h.state.hydrations;
    await restart(h, async (runtime) => {
      const corrected = (await runtime.runOnce({ cutoff })).publications[0];
      assert.ok(h.state.hydrations > hydrations, "the current source must be hydrated again");
      await assertMetric(runtime, h.metric, 0, corrected.snapshotId);
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
        .rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.find((row) => row.policy_signature === prior),
        retained,
      );
      const fresh = rows.find((row) => row.policy_signature === current);
      assert.ok(fresh, "the corrected empty output must retain the current delivery wrapper");
      assert.equal(fresh.document.defaultDeliveryNormalizationVersion, version);
      assert.equal(
        fresh.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
        false,
      );
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
        sources,
      );
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId]))
          .rows,
        frozen,
      );
    });
  });

for (const generation of ["P1", "A(P1)", "P2"])
  for (const mutation of ["hash", "mode"])
    test(`${generation} ${mutation} corruption rejects before reusing an already-valid current delivery cache`, async (t) => {
      const h = await deliveryHarness(t, "issue");
      const cutoff = new Date().toISOString();
      await h.runtime.runOnce({ cutoff });
      const current = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
      assert.equal(current.policy_signature, comparisonHash([version, currentSignature(h.config)]));
      const prior = comparisonHash([version, precedingSignature(h.config, generation)]);
      assert.notEqual(prior, current.policy_signature);
      const document = { ...current.document, isSynthetic: false };
      const hash = mutation === "hash" ? current.document_hash : comparisonHash(document);
      await h.db.query(
        `INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash)
         VALUES($1,$2,$3::jsonb,$4)`,
        [current.fact_key, prior, JSON.stringify(document), hash],
      );
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
        .rows;
      assert.deepEqual(
        rows.find((row) => row.policy_signature === current.policy_signature),
        current,
      );
      const snapshots = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows;
      const hydrations = h.state.hydrations;
      await assert.rejects(
        h.runtime.runOnce({ cutoff }),
        mutation === "hash" ? /normalization_integrity_error/ : /normalization_data_mode_mismatch/,
      );
      assert.equal(h.state.hydrations, hydrations);
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature")).rows,
        rows,
      );
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows,
        snapshots,
      );
    });
