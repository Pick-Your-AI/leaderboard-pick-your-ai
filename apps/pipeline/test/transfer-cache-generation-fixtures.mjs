import assert from "node:assert/strict";

// Synthetic persisted-row migration: retain the exact current source document
// under the pre-transfer cache key. This models the earlier versioned cache;
// it does not claim execution of an old runtime or manufacture source evidence.
export async function assertRetainedSourceGeneration({ h, priorSignature, request, assertPublic, restart }) {
  const cutoff = new Date().toISOString();
  const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.ok(publication);
  const previewRequest = request(h, publication.snapshotId);
  const preview = await h.runtime.previewPolicy(previewRequest);
  const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.equal(rows.length, 1);
  const current = rows[0];
  assert.notEqual(current.policy_signature, priorSignature);
  const sourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  const frozen = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [publication.snapshotId])
  ).rows;
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
    [current.fact_key, priorSignature, current.policy_signature],
  );
  const retained = { ...current, policy_signature: priorSignature };
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows, [
    retained,
  ]);
  await restart(h, async (runtime) => {
    // Both public reads and the private preview must work before reprocessing
    // can create a replacement cache with the same normalization hash.
    await assertPublic(runtime, null);
    await assertPublic(runtime, publication.snapshotId);
    assert.deepEqual(await runtime.previewPolicy(previewRequest), preview);
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows, [
      retained,
    ]);
    const rebuilt = (await runtime.runOnce({ cutoff })).publications[0];
    assert.ok(rebuilt);
    await assertPublic(runtime, null);
    await assertPublic(runtime, publication.snapshotId);
    const generations = (
      await h.db.query(
        "SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 ORDER BY policy_signature",
        [current.fact_key],
      )
    ).rows;
    assert.equal(generations.length, 2);
    assert.deepEqual(
      generations.find((row) => row.policy_signature === priorSignature),
      retained,
    );
    assert.deepEqual(
      generations.find((row) => row.policy_signature === current.policy_signature),
      current,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
      sourceRows,
    );
    assert.deepEqual(
      (
        await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          publication.snapshotId,
        ])
      ).rows,
      frozen,
    );
    // A valid replacement must not hide corruption in the still-authoritative
    // retained generation; its document hash and frozen binding stay untouched.
    await h.db.query(
      `UPDATE leaderboard_pipeline.normalizations
       SET document=jsonb_set(document,'{reasons}','["synthetic-retained-cache-tamper"]'::jsonb)
       WHERE fact_key=$1 AND policy_signature=$2`,
      [current.fact_key, priorSignature],
    );
    await assert.rejects(runtime.previewPolicy(previewRequest), /Frozen identity evidence integrity failure/);
  });
}
