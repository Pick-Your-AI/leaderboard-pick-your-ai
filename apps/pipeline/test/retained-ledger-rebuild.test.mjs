import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, clock, getBoard } from "./harness.mjs";

test("retained source ledger rebuilds identical normalized documents and snapshot after cache loss and restart", async (t) => {
  let normalizations = 0;
  const h = await harness(t, {
    normalizerFactory(options) {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
      return async (input) => {
        normalizations++;
        return normalize(input);
      };
    },
  });
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  assert.equal(first.state, "published");
  const normalized = () =>
    h.db
      .query(
        "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
      )
      .then((result) => result.rows);
  const snapshots = () =>
    h.db
      .query(
        "SELECT snapshot_id,revision,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
      )
      .then((result) => result.rows);
  const beforeFacts = await normalized();
  const beforeSnapshots = await snapshots();
  const beforeReceipts = (await h.runtime.receipts()).filter((entry) => entry.kind === "snapshot_published");
  const beforeBoard = await getBoard(h.runtime);
  assert.equal(beforeFacts.length, 2);
  assert.equal(normalizations, 2);
  // Only disposable derived cache rows are removed. Retained source observations,
  // source-mode bindings, policies, approval records and publication history stay.
  await h.runtime.stop();
  await h.db.query("DELETE FROM leaderboard_pipeline.normalizations");
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const rebuilt = await restarted.runOnce({ cutoff });
  assert.equal(rebuilt.state, "published");
  assert.equal(normalizations, 4, "both retained facts were actually renormalized");
  assert.deepEqual(await normalized(), beforeFacts);
  assert.deepEqual(await snapshots(), beforeSnapshots);
  assert.deepEqual(
    rebuilt.publications.map(({ snapshotId, revision, changed }) => ({ snapshotId, revision, changed })),
    first.publications.map(({ snapshotId, revision }) => ({ snapshotId, revision, changed: false })),
  );
  assert.deepEqual(
    (await restarted.receipts()).filter((entry) => entry.kind === "snapshot_published"),
    beforeReceipts,
  );
  const afterBoard = await getBoard(restarted);
  assert.deepEqual(afterBoard.rows, beforeBoard.rows);
  assert.equal(afterBoard.snapshotId, beforeBoard.snapshotId);
  assert.equal(afterBoard.revision, beforeBoard.revision);
});
