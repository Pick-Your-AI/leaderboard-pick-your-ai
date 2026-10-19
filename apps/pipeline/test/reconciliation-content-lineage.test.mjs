import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, clock, ago } from "./harness.mjs";

test("same-clock REST content edits and restoration survive reopen without unchanged-audit lineage churn", async (t) => {
  const payload = {
    id: 1001,
    node_id: "SYNTHETIC_CONTENT_ISSUE",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/1",
    title: "Synthetic content A",
    body: "Synthetic body A",
    state: "open",
    created_at: ago(2),
    updated_at: ago(1),
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  };
  const original = structuredClone(payload);
  let hydrationCount = 0;
  const h = await harness(t, {
    payloads: [payload],
    source: {
      async readPage(request) {
        return {
          repositoryId: 2,
          visibility: "public",
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: payload.node_id,
              sourceRevision: components.github.githubRestSnapshotRevision("issues", payload, request.runId),
              sourceUrl: payload.html_url,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: payload.state,
            },
          ],
        };
      },
    },
    normalizerFactory(options) {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
      return (input) => {
        hydrationCount += 1;
        return normalize(input);
      };
    },
  });
  let runtime = h.runtime;
  const publish = async (mode) => {
    const result = await runtime.runOnce({ mode, cutoff: clock() });
    assert.equal(result.state, "published");
    const row = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        result.publications[0].snapshotId,
      ])
    ).rows[0];
    const frozen = row.document.frozen;
    assert.ok(frozen.coverage.every((entry) => entry.state === "partial"));
    assert.equal(frozen.actors.find((actor) => actor.id === "101").login, payload.user.login);
    return { snapshotId: result.publications[0].snapshotId, document: row.document, frozen };
  };

  const initial = await publish("reconcile");
  const unchanged = await publish("audit");
  assert.equal(unchanged.frozen.backfillRevision, initial.frozen.backfillRevision);
  Object.assign(payload, {
    title: "Synthetic content B",
    body: "Synthetic body B",
    user: { ...payload.user, login: "synthetic-renamed" },
  });
  assert.equal(payload.updated_at, original.updated_at);
  const edited = await publish("audit");
  assert.notEqual(edited.frozen.backfillRevision, initial.frozen.backfillRevision);
  assert.equal(hydrationCount, 3, "each distinct immutable observation receives its own normalization");

  await runtime.stop();
  await h.reopenDatabase();
  runtime = await createPipeline(h.options);
  t.after(() => runtime.stop());
  Object.assign(payload, structuredClone(original));
  const restored = await publish("audit");
  assert.notEqual(restored.frozen.backfillRevision, edited.frozen.backfillRevision);
  const repeat = await publish("audit");
  assert.equal(repeat.frozen.backfillRevision, restored.frozen.backfillRevision);
  assert.equal(hydrationCount, 5, "A after B is a fresh selected observation even when its content hash returns to A");

  const sources = (
    await h.db.query(
      "SELECT fact_key,source_revision,document FROM leaderboard_ingestion.source_facts ORDER BY observed_at",
    )
  ).rows;
  assert.equal(sources.length, 5);
  assert.equal(new Set(sources.map((row) => row.fact_key)).size, 5);
  assert.equal(new Set(sources.map((row) => row.source_revision)).size, 5);
  const semantics = sources.map((row) => components.github.githubRestSnapshotSemanticRevision(row.source_revision));
  assert.equal(semantics[0], semantics[1]);
  assert.notEqual(semantics[1], semantics[2]);
  assert.equal(semantics[0], semantics[3]);
  assert.equal(semantics[3], semantics[4]);
  assert.ok(sources.every((row) => row.document.actorId === null && row.document.occurredAt === null));
  assert.doesNotMatch(JSON.stringify(sources), /Synthetic body|synthetic-renamed|Synthetic content/);
  assert.deepEqual(
    (await h.db.query("SELECT item_count,changed_count FROM leaderboard_ingestion.collection_pages ORDER BY run_id"))
      .rows,
    Array.from({ length: 5 }, () => ({ item_count: 1, changed_count: 1 })),
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n, 5);
  for (const retained of [initial, unchanged, edited, restored])
    assert.deepEqual(
      (
        await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          retained.snapshotId,
        ])
      ).rows[0].document,
      retained.document,
    );
});
