import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, clock, ago, boardUrl } from "./harness.mjs";

const issue = (number, createdAt = clock()) => ({
  id: 1000 + number,
  node_id: `SYNTHETIC_ISSUE_${number}`,
  number,
  html_url: `https://github.com/synthetic-org/synthetic-repo/issues/${number}`,
  created_at: createdAt,
  updated_at: clock(),
  user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
});

async function publish(h, options = {}, runtime = h.runtime) {
  const result = await runtime.runOnce(options);
  assert.equal(result.state, "published");
  const publication = result.publications[0];
  const row = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0];
  const explanation = h.controlsStore.db
    .prepare("SELECT document,digest FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
    .get(publication.snapshotId);
  assert.equal(JSON.parse(explanation.document).backfillRevision, row.document.frozen.backfillRevision);
  return { ...publication, input: row.document.frozen, row, explanation };
}

test("ordinary collected activity keeps the persisted reconciliation lineage through refresh and restart", async (t) => {
  const h = await harness(t);
  const first = await publish(h, { cutoff: ago(0.01) });
  const added = issue(3, new Date(Date.parse(first.input.cutoff) + 1).toISOString());
  assert.ok(added.created_at > first.input.cutoff, "new activity follows the first actual observation boundary");
  h.add(added);
  const cutoff = clock();
  assert.ok(cutoff > added.created_at, "the half-open publication window includes the new activity");
  const second = await publish(h, { cutoff });
  const response = await h.runtime.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().rows.find((row) => row.actorId === "101").result.value, 2);
  assert.notEqual(first.input.datasetId, second.input.datasetId);
  assert.equal(second.input.backfillRevision, first.input.backfillRevision);
  assert.ok(second.input.coverage.every((coverage) => coverage.state === "partial"));

  h.duplicate();
  const refreshed = await publish(h);
  assert.equal(refreshed.input.backfillRevision, first.input.backfillRevision);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const afterRestart = await publish(h, {}, restarted);
  assert.equal(afterRestart.input.backfillRevision, first.input.backfillRevision);
  const original = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      first.snapshotId,
    ])
  ).rows[0];
  assert.deepEqual(original, first.row);
  assert.deepEqual(
    h.controlsStore.db
      .prepare("SELECT document,digest FROM pipeline_aggregate_explanations WHERE snapshot_id=?")
      .get(first.snapshotId),
    first.explanation,
  );
});
