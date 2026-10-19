// Disposable synthetic enrichment and SQLite/PGlite state exercise cache
// migration only; these fixtures do not collect or attest an actual release.
import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import {
  deliveryHarness,
  version,
  legacySignature,
  currentSignature,
  deliveryMetrics,
} from "./default-delivery-fixtures.mjs";

async function selectedReleaseIssue(t) {
  const h = await deliveryHarness(t, "issue");
  await h.runtime.stop();
  const config = structuredClone(h.config);
  config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }];
  const runtime = await createPipeline({ ...h.options, config });
  t.after(() => runtime.stop());
  const wrap = (signature) =>
    comparisonHash(["github-release-inclusion/v1", signature, config.releaseInclusionTargets]);
  const current = comparisonHash([version, wrap(currentSignature(config))]);
  const previous = comparisonHash([version, wrap(legacySignature(config))]);
  await runtime.runOnce();
  const row = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  assert.equal(row.policy_signature, current);
  assert.equal(row.document.defaultDeliveryNormalizationVersion, version);
  assert.ok(row.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)));
  return { h, runtime, current, previous, row };
}

test("a release-wrapped Project v1 delivery hint retains the empty correction's version without reusing old facts", async (t) => {
  const { h, runtime, current, previous, row } = await selectedReleaseIssue(t);
  // Rehydrate through the already accepted bare-Project migration first. A
  // still-current cache would correctly preserve its original source result.
  const barePrevious = legacySignature(h.config);
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
    [row.fact_key, barePrevious, current],
  );
  h.state.defaultBranch = undefined;
  await runtime.runOnce();
  const corrected = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE policy_signature=$1", [current])
  ).rows[0];
  assert.equal(corrected.document.defaultDeliveryNormalizationVersion, version);
  assert.equal(
    corrected.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
    false,
  );
  // Remove this fixture's older positive hint so it cannot mask the empty
  // release-wrapped generation that is the actual regression boundary.
  await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE policy_signature=$1", [barePrevious]);
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
    [corrected.fact_key, previous, current],
  );
  const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
    .rows;
  const hydrations = h.state.hydrations;
  await runtime.runOnce();
  assert.ok(h.state.hydrations > hydrations);
  const fresh = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE policy_signature=$1", [current])
  ).rows[0];
  assert.ok(fresh, "the retained release wrapper must keep the delivery generation even for empty corrected output");
  assert.equal(fresh.document.defaultDeliveryNormalizationVersion, version);
  assert.equal(
    fresh.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
    false,
  );
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT * FROM leaderboard_pipeline.normalizations WHERE policy_signature<>$1 ORDER BY policy_signature",
        [current],
      )
    ).rows,
    retained,
  );
});

for (const mutation of ["hash", "mode"])
  test(`a release-wrapped Project v1 hint rejects ${mutation} corruption before hydration`, async (t) => {
    const { h, runtime, previous, row } = await selectedReleaseIssue(t);
    const document = { ...row.document, isSynthetic: false };
    const hash = mutation === "hash" ? row.document_hash : comparisonHash(document);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document=$3::jsonb,document_hash=$4 WHERE fact_key=$1",
      [row.fact_key, previous, JSON.stringify(document), hash],
    );
    const hydrations = h.state.hydrations;
    await assert.rejects(
      runtime.runOnce(),
      mutation === "hash" ? /normalization_integrity_error/ : /normalization_data_mode_mismatch/,
    );
    assert.equal(h.state.hydrations, hydrations);
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS count FROM leaderboard_pipeline.normalizations")).rows[0].count,
      1,
    );
  });
