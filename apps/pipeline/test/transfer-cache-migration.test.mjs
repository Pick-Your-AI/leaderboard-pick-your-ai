import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { components, getBoard, harness } from "./harness.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/legacy-transfer-admission.json", import.meta.url), "utf8"),
);
assert.equal(fixture.schemaVersion, "synthetic-legacy-transfer-admission/v1");

// This is the exact deployed cache key before transfer admission changed. The
// fixture contains actual old-producer output, not a new adapter's approximation.
function previousProjectSignature(config) {
  const policy = comparisonHash([
    "current-state-selection-v1",
    "synthetic",
    config.policies.map((item) => item.signature),
  ]);
  const attribution = comparisonHash([normalizationDocumentVersion, policy]);
  return comparisonHash([
    "project-membership-context/v1",
    comparisonHash(["verified-default-branch-merge-pins/v1", attribution]),
    [],
  ]);
}

for (const legacy of fixture.cases) {
  test(`a cached ${legacy.visibility} transfer is recomputed after restart without changing its source revision or frozen identity`, async (t) => {
    let phase = "ordinary";
    let freshWithdrawals = 0;
    const h = await harness(t, {
      authorizePolicyPreview: async () => true,
      policyComparisonAuthorityCurrent: () => true,
      normalizerFactory(options) {
        const ordinary = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: "installation:1",
          allowedRepositoryIds: [2],
          isSynthetic: true,
        });
        return async (input) => {
          if (phase === "ordinary" || input.fact.subjectId !== "SYNTHETIC_ISSUE_1") return ordinary(input);
          // The captured empty result contains no clock/revision fields. Its
          // invariance under those substitutions was checked against the pinned
          // old producer when generating this committed synthetic fixture.
          if (phase === "legacy") return structuredClone(legacy.output);
          freshWithdrawals++;
          return components.github.normalizeGithubObservation({
            ...structuredClone(legacy.envelope),
            repository: { ...input.repository, visibility: "public" },
            proof: { ...legacy.envelope.proof, revision: input.fact.sourceRevision },
            observedAt: input.observedAt,
          });
        };
      },
    });
    assert.equal((await h.runtime.runOnce()).state, "published");
    const original = await getBoard(h.runtime);
    const evidenceId = original.rows.find((row) => row.actorId === "101").evidenceIds[0];
    const frozen = (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        original.snapshotId,
      ])
    ).rows[0];
    h.duplicate();
    phase = "legacy";
    assert.equal((await h.runtime.runOnce()).state, "published");
    assert.ok(
      (await getBoard(h.runtime, "&snapshot=" + original.snapshotId)).rows.some((row) => row.actorId === "101"),
    );
    assert.deepEqual((await h.db.query("SELECT subject_id FROM leaderboard_ingestion.object_suppressions")).rows, []);

    // Simulate deployment of the old generation even when this regression runs
    // on the corrected runtime. Retain all historical documents and their hashes.
    const oldSignature = previousProjectSignature(h.config);
    await h.db.query("UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1", [oldSignature]);
    const oldRows = (
      await h.db.query(
        `SELECT n.fact_key,n.document,n.document_hash FROM leaderboard_pipeline.normalizations AS n
       JOIN leaderboard_ingestion.source_facts AS f USING(fact_key)
       WHERE f.subject_id='SYNTHETIC_ISSUE_1' AND n.document->'facts'='[]'::jsonb`,
      )
    ).rows;
    assert.equal(oldRows.length, 1);
    const oldWithdrawal = oldRows[0];
    assert.deepEqual(oldWithdrawal.document.suppressArtifactIds, []);
    assert.deepEqual(oldWithdrawal.document.reasons, ["missing_public_artifact_identity"]);
    const sources = (
      await h.db.query(
        "SELECT fact_key,source_revision,observed_at FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
      )
    ).rows;
    await h.runtime.stop();
    await h.reopenDatabase();
    phase = "current";
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());

    // A cache migration must still authorize the exact older identity source
    // generation for an existing frozen comparison, before any new collection.
    const request = {
      snapshotId: original.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-transfer-cache-preview", rank: false },
      operatorId: "201",
    };
    const comparison = await restarted.previewPolicy(request);
    assert.equal(comparison.comparison.before.rows.find((row) => row.actorId === "101").value, 1);
    assert.equal(freshWithdrawals, 0);
    assert.equal((await restarted.runOnce()).state, "published");

    const current = await getBoard(restarted);
    const pinned = await getBoard(restarted, "&snapshot=" + original.snapshotId);
    const evidence = await restarted.app.inject("/api/v1/evidence/" + evidenceId + "?snapshot=" + original.snapshotId);
    const json = await restarted.app.inject(
      "/api/v1/exports?metric=issues_opened&format=json&snapshot=" + original.snapshotId,
    );
    const csv = await restarted.app.inject(
      "/api/v1/exports?metric=issues_opened&format=csv&snapshot=" + original.snapshotId,
    );
    const suppressions = (
      await h.db.query(
        "SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=2 ORDER BY subject_id",
      )
    ).rows;
    assert.deepEqual(
      {
        freshWithdrawals,
        suppressed: suppressions.map((row) => row.subject_id),
        current: current.rows.map((row) => row.actorId),
        pinned: pinned.rows.map((row) => row.actorId),
        evidenceStatus: evidence.statusCode,
        jsonStatus: json.statusCode,
        csvStatus: csv.statusCode,
        jsonExposesWithdrawnEvidence: json.body.includes(evidenceId) || json.body.includes("synthetic-alice"),
        csvExposesWithdrawnEvidence: csv.body.includes(evidenceId) || csv.body.includes("synthetic-alice"),
      },
      {
        freshWithdrawals: 1,
        suppressed: ["SYNTHETIC_ISSUE_1"],
        current: ["102"],
        pinned: ["102"],
        evidenceStatus: 404,
        jsonStatus: 200,
        csvStatus: 200,
        jsonExposesWithdrawnEvidence: false,
        csvExposesWithdrawnEvidence: false,
      },
    );
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT fact_key,source_revision,observed_at FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
        )
      ).rows,
      sources,
    );
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT fact_key,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2",
          [oldWithdrawal.fact_key, oldSignature],
        )
      ).rows,
      [oldWithdrawal],
    );
    assert.deepEqual(
      (
        await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          original.snapshotId,
        ])
      ).rows,
      [frozen],
    );
    const replacement = (
      await h.db.query(
        "SELECT document FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature<>$2",
        [oldWithdrawal.fact_key, oldSignature],
      )
    ).rows;
    assert.equal(replacement.length, 1);
    assert.deepEqual(replacement[0].document.suppressArtifactIds, ["SYNTHETIC_ISSUE_1"]);
  });
}
