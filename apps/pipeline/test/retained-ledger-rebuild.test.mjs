import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, clock, getBoard, publicScope } from "./harness.mjs";

async function assertRetainedLedgerRebuild(t, { transformPayloads, inspect = async () => {} } = {}) {
  let normalizations = 0;
  const h = await harness(t, {
    transformPayloads,
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
  await inspect(beforeFacts, beforeBoard, h.runtime);
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
  await inspect(await normalized(), afterBoard, restarted);
}

test("retained source ledger rebuilds identical normalized documents and snapshot after cache loss and restart", async (t) => {
  await assertRetainedLedgerRebuild(t);
});

test("deleted source actor stays unknown and unranked through retained-ledger rebuild and database restart", async (t) => {
  await assertRetainedLedgerRebuild(t, {
    // Synthetic representation of an unavailable/deleted source actor. A null
    // source user does not authorize reconstructing their former identity.
    transformPayloads: (payloads) =>
      payloads.map((payload, index) => (index === 1 ? { ...payload, user: null } : payload)),
    async inspect(normalized, board, runtime) {
      const deleted = normalized.find((row) =>
        row.document.facts.some((fact) => fact.artifactId === "SYNTHETIC_ISSUE_2"),
      ).document;
      assert.deepEqual(deleted.actors, [], "no stable named actor can be inferred from the missing source user");
      assert.ok(deleted.reasons.includes("unknown_actor"));
      const facts = deleted.facts.filter((fact) => fact.metricId === "issues_opened");
      assert.equal(facts.length, 1, "unknown attribution remains an explicit retained fact");
      assert.equal(facts[0].actorId, null);
      assert.equal(facts[0].subjectActorId, null);
      assert.equal(facts[0].state, "unknown");
      assert.ok(deleted.evidence.every((entry) => entry.contribution.actorId === null));
      assert.deepEqual(
        board.rows.map((row) => [row.actorId, row.result.value, row.rank]),
        [["101", 1, null]],
        "only the known actor receives a named total; the small public cohort remains unranked before and after rebuild",
      );
      assert.equal(board.rankingPresentation.state, "small_cohort");
      assert.equal(board.rankingPresentation.comparableContributors, 1);
      const paired = await runtime.source.readComparison(
        publicScope,
        board.snapshotId,
        { snapshotId: board.snapshotId, scope: publicScope },
        new AbortController().signal,
      );
      assert.equal(
        paired.currentHistory.metrics
          .find((entry) => entry.metricId === "issues_opened")
          .rows.find((row) => row.actorId === "101").rank,
        1,
        "the original private rank remains intact without reconstructing the deleted actor",
      );
      const directory = await runtime.app.inject("/api/v1/contributors");
      assert.equal(directory.statusCode, 200, directory.body);
      assert.deepEqual(
        directory.json().contributors.map((entry) => entry.actor.githubDatabaseId),
        [101],
      );
    },
  });
});
