import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { helpfulFeedbackHarness } from "./helpful-feedback-harness.mjs";
import { clock, publicScope } from "./harness.mjs";
import { feedbackSentinel, feedbackTitleSentinel } from "../../../tests/fixtures/helpful-feedback.mjs";

const read = (h, snapshotId = null) => h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
const count = async (h, table) => (await h.db.query("SELECT count(*)::int AS n FROM " + table)).rows[0].n;
const preview = (h, snapshotId) =>
  h.runtime.previewPolicy({
    snapshotId,
    operatorId: "201",
    policy: { ...h.config.policies[0].policy, version: "synthetic-feedback-exclusion-preview/v2" },
  });
const feedbackRows = (selected) =>
  selected.rows
    .filter((row) => row.result.metricId === "helpful_feedback")
    .map((row) => [row.actorId, row.result.value]);
const unavailable = /feedback|authorization_changed|policy_input_revoked|source_unavailable|not_verified/;

async function assertWithheld(h, pin) {
  for (const id of [null, pin]) {
    try {
      assert.equal(await read(h, id), null);
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      assert.match(error.message, unavailable);
    }
  }
  await assert.rejects(preview(h, pin), unavailable);
  await assert.rejects(h.runtime.aggregateExplanations.read(pin), unavailable);
}

async function assertNoRawContent(h) {
  const sentinel = new RegExp(feedbackSentinel + "|" + feedbackTitleSentinel);
  for (const table of [
    "leaderboard_ingestion.source_facts",
    "leaderboard_pipeline.normalizations",
    "leaderboard_pipeline.discussion_feedback_heads",
    "leaderboard_pipeline.discussion_feedback_scans",
    "leaderboard_pipeline.frozen_inputs",
    "leaderboard_pipeline.snapshots",
  ])
    assert.doesNotMatch(JSON.stringify((await h.db.query("SELECT * FROM " + table)).rows), sentinel, table);
  assert.doesNotMatch(JSON.stringify(h.controlsStore.read()), sentinel);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else assert.doesNotMatch(await readFile(path, "utf8"), sentinel, path);
    }
  };
  await visit(h.checkpointDirectory);
}

async function acceptedPublication(h) {
  assert.equal((await h.collect()).state, "published");
  const accepted = await h.accept();
  const cutoff = clock();
  const result = await h.collect({ cutoff });
  assert.equal(result.state, "published");
  const pin = result.publications[0].snapshotId;
  for (const id of [null, pin]) {
    const visible = await read(h, id);
    assert.ok(visible);
    assert.deepEqual(feedbackRows(visible.selected), [["101", 1]]);
    assert.doesNotMatch(
      JSON.stringify(visible),
      /gdf1:|bodyDigest|descriptorFingerprint|coverageEpoch|synthetic-feedback-accepted/,
    );
  }
  assert.ok(await preview(h, pin));
  assert.ok(await h.runtime.aggregateExplanations.read(pin));
  return { accepted, cutoff, pin };
}

test("private initial feedback source is rejected before content reads or accepted observations", async (t) => {
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true });
  h.state.privateRepository = true;
  await assert.rejects(h.collect(), /public_source_not_verified/);
  assert.equal(h.state.reads, 0);
  assert.deepEqual(h.state.queries, []);
  assert.deepEqual(await readdir(h.checkpointDirectory), []);
  for (const table of [
    "leaderboard_ingestion.source_facts",
    "leaderboard_pipeline.normalizations",
    "leaderboard_pipeline.discussion_feedback_heads",
    "leaderboard_pipeline.discussion_feedback_scans",
    "leaderboard_pipeline.frozen_inputs",
    "leaderboard_pipeline.snapshots",
  ])
    assert.equal(await count(h, table), 0, table);
  assert.equal(await read(h), null);
  await assertNoRawContent(h);
});

test("accepted public feedback is withheld after a private probe, including pinned reads and exact replay after reopen", async (t) => {
  // File-backed SQL and the existing controls store retain the accepted receipt.
  // Only the observed repository privacy changes; the synthetic source-use
  // epoch and independent review remain unchanged.
  const h = await helpfulFeedbackHarness(t);
  const { accepted, cutoff, pin } = await acceptedPublication(h);
  const contentReads = h.state.reads;
  const snapshots = await count(h, "leaderboard_pipeline.snapshots");
  const retained = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [pin])
  ).rows;
  const authorityEpoch = h.state.epoch;
  h.state.privateRepository = true;
  await assert.rejects(h.collect(), /public_source_not_verified/);
  assert.equal(h.state.epoch, authorityEpoch);
  assert.equal(h.state.reads, contentReads);
  assert.equal(h.controlsStore.read().requests[accepted.request.id].status, "accepted");
  assert.equal(await count(h, "leaderboard_pipeline.snapshots"), snapshots);
  await assertWithheld(h, pin);
  await assert.rejects(h.collect({ cutoff }), /public_source_not_verified|revoked_or_changed/);
  assert.equal(h.state.reads, contentReads);
  await h.reopenDatabase();
  await assertWithheld(h, pin);
  await assert.rejects(h.collect({ cutoff }), /public_source_not_verified|revoked_or_changed/);
  assert.equal(h.state.reads, contentReads);
  assert.equal(await count(h, "leaderboard_pipeline.snapshots"), snapshots);
  assert.deepEqual(
    (await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [pin]))
      .rows,
    retained,
    "source denial withholds retained evidence without rewriting its historical bytes",
  );
  await assertNoRawContent(h);
});

for (const [label, url] of [
  ["unapproved external platform", "https://unapproved.synthetic.invalid/community/discussions/1"],
  ["unbound native repository", "https://github.com/synthetic-org/unapproved-repo/discussions/1"],
  ["non-Discussion native path", "https://github.com/synthetic-org/synthetic-repo/issues/1"],
])
  test("feedback rejects " + label + " before checkpointing or qualification", async (t) => {
    const h = await helpfulFeedbackHarness(t, { memoryDatabase: true });
    const originalUrl = h.state.rows[0].url;
    h.state.rows[0].url = url;
    const result = await h.collect();
    assert.equal(result.state, "collecting");
    assert.equal(h.state.reads, 1);
    assert.deepEqual(await readdir(h.checkpointDirectory), []);
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT state,item_count,expected_count,reason FROM leaderboard_ingestion.collection_runs ORDER BY attempted_at",
        )
      ).rows,
      [{ state: "failed", item_count: 0, expected_count: null, reason: "source_read_failed" }],
    );
    for (const table of [
      "leaderboard_ingestion.source_facts",
      "leaderboard_pipeline.normalizations",
      "leaderboard_pipeline.discussion_feedback_scans",
      "leaderboard_pipeline.frozen_inputs",
      "leaderboard_pipeline.snapshots",
    ])
      assert.equal(await count(h, table), 0, table);
    assert.equal(await read(h), null);
    await assertNoRawContent(h);

    // The same configured adapter admits a later exact public Discussion.
    // Recovery from the failed scan must establish its own complete receipt.
    h.state.rows[0].url = originalUrl;
    const { pin } = await acceptedPublication(h);
    assert.ok(await count(h, "leaderboard_pipeline.discussion_feedback_scans"));
    assert.deepEqual(feedbackRows((await read(h, pin)).selected), [["101", 1]]);
    await assertNoRawContent(h);
  });
