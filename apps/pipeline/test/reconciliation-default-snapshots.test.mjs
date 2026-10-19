import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, ago } from "./harness.mjs";

test("default scheduled REST snapshots retain same-clock A to B to A across reopen without unchanged lineage churn", async (t) => {
  const payload = {
    id: 1001,
    node_id: "SYNTHETIC_SCHEDULED_ISSUE",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/1",
    title: "Synthetic scheduled content A",
    body: "Synthetic scheduled body A",
    state: "open",
    created_at: ago(2),
    updated_at: ago(1),
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  };
  const original = structuredClone(payload);
  const h = await harness(t, {
    source: undefined,
    probeRepository: undefined,
    payloads: [payload],
    configure(config) {
      config.reconciliation = { lookbackMs: 7 * 86400000, overlapMs: 86400000, fullAuditsPerCycle: 1 };
    },
  });
  let runtime = h.runtime;
  const publications = [];
  const publish = async () => {
    const result = await runtime.runOnce();
    assert.equal(result.state, "published");
    assert.equal(result.progress.length, 1);
    assert.match(result.progress[0].runId, /^rc1:[a-f0-9]{64}:[a-f0-9-]{36}:0000:0001$/);
    const document = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        result.publications[0].snapshotId,
      ])
    ).rows[0].document;
    assert.ok(document.frozen.coverage.every((entry) => entry.state === "partial" && entry.knownStart === null));
    assert.equal(document.frozen.actors.find((actor) => actor.id === "101").login, payload.user.login);
    publications.push({ snapshotId: result.publications[0].snapshotId, document: structuredClone(document) });
    return document.frozen;
  };

  const first = await publish();
  const unchanged = await publish();
  assert.equal(unchanged.backfillRevision, first.backfillRevision);
  Object.assign(payload, {
    title: "Synthetic scheduled content B",
    body: "Synthetic scheduled body B",
    user: { ...payload.user, login: "synthetic-renamed" },
  });
  assert.equal(payload.updated_at, original.updated_at);
  const edited = await publish();
  assert.notEqual(edited.backfillRevision, first.backfillRevision);

  await runtime.stop();
  await h.reopenDatabase();
  runtime = await createPipeline(h.options);
  t.after(() => runtime.stop());
  Object.assign(payload, structuredClone(original));
  const restored = await publish();
  assert.notEqual(restored.backfillRevision, edited.backfillRevision);
  const repeated = await publish();
  assert.equal(repeated.backfillRevision, restored.backfillRevision);

  const observations = (
    await h.db.query(
      "SELECT fact_key,first_run_id,source_revision,document FROM leaderboard_ingestion.source_facts ORDER BY observed_at,fact_key",
    )
  ).rows;
  assert.equal(observations.length, 5);
  assert.equal(new Set(observations.map((row) => row.fact_key)).size, 5);
  assert.equal(new Set(observations.map((row) => row.source_revision)).size, 5);
  const semantics = observations.map((row) =>
    components.github.githubRestSnapshotSemanticRevision(row.source_revision),
  );
  assert.ok(semantics.every((value) => value !== null));
  assert.equal(semantics[0], semantics[1]);
  assert.notEqual(semantics[1], semantics[2]);
  assert.equal(semantics[0], semantics[3]);
  assert.equal(semantics[3], semantics[4]);
  assert.ok(observations.every((row) => row.first_run_id.startsWith("rc1:")));
  assert.ok(observations.every((row) => row.document.actorId === null && row.document.occurredAt === null));
  assert.doesNotMatch(JSON.stringify(observations), /Synthetic scheduled (body|content)|synthetic-renamed/);
  assert.deepEqual(
    (await h.db.query("SELECT item_count,changed_count FROM leaderboard_ingestion.collection_pages ORDER BY run_id"))
      .rows,
    Array.from({ length: 5 }, () => ({ item_count: 1, changed_count: 1 })),
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n, 5);
  for (const retained of publications)
    assert.deepEqual(
      (
        await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          retained.snapshotId,
        ])
      ).rows[0].document,
      retained.document,
    );
});
