import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { harness, components, getBoard, publicScope } from "./harness.mjs";

test("captured display policy survives reopen while current privacy changes only the projected cohort", async (t) => {
  const h = await harness(t);
  const first = await h.runtime.runOnce();
  assert.equal(first.state, "published");
  const pin = first.publications[0].snapshotId;
  const retained = async () =>
    (await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [pin]))
      .rows[0];
  const original = await retained();
  assert.deepEqual(original.document.rankingPresentationPolicy, components.contracts.currentRankingPresentationPolicy);
  assert.equal(
    createHash("sha256").update(components.metrics.stableJSON(original.document)).digest("hex"),
    original.document_hash,
  );
  const before = await getBoard(h.runtime, `&snapshot=${pin}`);
  assert.equal(before.rankingPresentation.state, "small_cohort");
  assert.equal(before.rankingPresentation.totalContributors, 2);
  assert.equal(before.rankingPresentation.comparableContributors, 2);
  assert.deepEqual(
    before.rows.map((row) => [row.actorId, row.result.value, row.rank]),
    [
      ["101", 1, null],
      ["102", 1, null],
    ],
  );
  const pair = await h.runtime.source.readComparison(
    publicScope,
    pin,
    { snapshotId: pin, scope: publicScope },
    new AbortController().signal,
  );
  assert.ok(pair?.currentHistory);
  const history = structuredClone(pair.currentHistory);
  assert.deepEqual(
    history.metrics[0].rows.map((row) => [row.actorId, row.value, row.rank]),
    [
      ["101", 1, 1],
      ["102", 1, 1],
    ],
  );

  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const reopened = await getBoard(restarted, `&snapshot=${pin}`);
  assert.deepEqual(reopened.rankingPresentation, before.rankingPresentation);
  assert.deepEqual(await retained(), original);
  h.controlsStore.transaction(
    (state) => {
      state.profiles["102"] = { suppressed: true, public: false, bio: "", highlights: [] };
    },
    { publish: true },
  );
  const current = await getBoard(restarted, `&snapshot=${pin}`);
  assert.equal(current.snapshotId, pin);
  assert.equal(current.rankingPresentation.totalContributors, 1);
  assert.equal(current.rankingPresentation.comparableContributors, 1);
  assert.deepEqual(
    current.rows.map((row) => [row.actorId, row.result.value, row.rank]),
    [["101", 1, null]],
  );
  const exported = await restarted.app.inject(`/api/v1/exports?metric=issues_opened&snapshot=${pin}&format=json`);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().exportSchemaVersion, "public-export/v4");
  assert.deepEqual(exported.json().rankingPresentation, current.rankingPresentation);
  assert.deepEqual(
    exported.json().rows.map((row) => [row.actorId, row.rank]),
    [["101", null]],
  );
  const pairedAgain = await restarted.source.readComparison(
    publicScope,
    pin,
    { snapshotId: pin, scope: publicScope },
    new AbortController().signal,
  );
  assert.deepEqual(pairedAgain.currentHistory, history);
  assert.deepEqual(await retained(), original);
});
