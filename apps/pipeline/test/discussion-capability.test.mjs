import assert from "node:assert/strict";
import test from "node:test";
import { discussionBoardUrl, discussionCapabilityHarness } from "./discussion-capability-harness.mjs";

const sourceRows = async (h) =>
  (
    await h.db.query(
      "SELECT state,item_count,expected_count,reason FROM leaderboard_ingestion.collection_runs ORDER BY attempted_at",
    )
  ).rows;
const count = async (h, table) => (await h.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;

test("disabled Discussion capability cannot publish a zero-contribution board", async (t) => {
  const h = await discussionCapabilityHarness(t, { enabled: false, empty: true });
  assert.equal((await h.collect()).state, "collecting");
  assert.equal(h.state.collections, 1);
  assert.equal(h.state.hydrations, 0);
  assert.deepEqual(await sourceRows(h), [
    { state: "failed", item_count: 0, expected_count: null, reason: "source_read_failed" },
  ]);
  assert.equal(await count(h, "leaderboard_ingestion.source_facts"), 0);
  assert.equal(await count(h, "leaderboard_pipeline.snapshots"), 0);
  for (const path of [discussionBoardUrl, "/api/v1/health", "/api/v1/exports?metric=discussion_answers&format=json"]) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 503, response.body);
    assert.doesNotMatch(
      response.body,
      /"rows"|"value"|synthetic-303|hasDiscussionsEnabled|discussions_source_unavailable/,
    );
  }
});

test("enabled empty Discussions complete their scan without certifying historical zero", async (t) => {
  const h = await discussionCapabilityHarness(t, { enabled: true, empty: true });
  assert.equal((await h.collect()).state, "published");
  assert.equal(h.state.collections, 1);
  assert.equal(h.state.hydrations, 0);
  assert.deepEqual(await sourceRows(h), [{ state: "complete", item_count: 0, expected_count: 0, reason: null }]);
  const response = await h.runtime.app.inject(discussionBoardUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().rows, []);
  const health = await h.runtime.app.inject("/api/v1/health");
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().sources[0].currentCollection.state, "no_activity_in_window");
  assert.equal(health.json().sources[0].state, "partial");
  assert.equal(health.json().status, "stale_or_degraded");
});

test("a later disabled Discussion read preserves the earlier answer and reports degraded current collection", async (t) => {
  const h = await discussionCapabilityHarness(t);
  assert.equal((await h.collect()).state, "published");
  assert.equal(h.state.hydrations, 1);
  const before = await h.runtime.app.inject(discussionBoardUrl);
  assert.equal(before.statusCode, 200, before.body);
  assert.deepEqual(
    before.json().rows.map((row) => [row.actorId, row.result.value]),
    [["303", 1]],
  );
  const oldHealth = (await h.runtime.app.inject("/api/v1/health")).json();
  assert.equal(oldHealth.sources[0].currentCollection.state, "reconciled");
  const snapshots = await count(h, "leaderboard_pipeline.snapshots");
  h.state.enabled = false;
  assert.equal((await h.collect()).state, "collecting");
  assert.equal(h.state.collections, 2);
  assert.equal(h.state.hydrations, 1);
  assert.equal(await count(h, "leaderboard_pipeline.snapshots"), snapshots);
  assert.deepEqual(
    (await sourceRows(h)).map((row) => row.state),
    ["complete", "failed"],
  );
  for (const suffix of ["", `&snapshot=${oldHealth.snapshotId}`]) {
    const retained = await h.runtime.app.inject(discussionBoardUrl + suffix);
    assert.equal(retained.statusCode, 200, retained.body);
    assert.deepEqual(retained.json().rows, before.json().rows);
  }
  const health = await h.runtime.app.inject(`/api/v1/health?snapshot=${oldHealth.snapshotId}`);
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().snapshotId, oldHealth.snapshotId);
  assert.equal(health.json().sources[0].currentCollection.state, "degraded");
  assert.equal(health.json().status, "stale_or_degraded");
  assert.deepEqual(health.json().lastSuccessfulPublish, oldHealth.lastSuccessfulPublish);
  assert.deepEqual(health.json().coverage, oldHealth.coverage);
  assert.doesNotMatch(
    health.body,
    /hasDiscussionsEnabled|discussions_source_unavailable|synthetic-discussion-capability-token/,
  );
});
