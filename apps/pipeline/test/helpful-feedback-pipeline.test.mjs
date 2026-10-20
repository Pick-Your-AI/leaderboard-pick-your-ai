import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { helpfulFeedbackHarness } from "./helpful-feedback-harness.mjs";
import { publicScope, clock } from "./harness.mjs";
import { feedbackSentinel, feedbackTitleSentinel, feedbackNode } from "../../../tests/fixtures/helpful-feedback.mjs";

const read = (h, snapshotId) => h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
const totals = (selected) =>
  selected.rows
    .filter((row) => row.result.metricId === "helpful_feedback")
    .reduce((sum, row) => sum + (row.result.value ?? 0), 0);
const head = async (h) =>
  (await h.db.query("SELECT document FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=2"))
    .rows[0]?.document;
const preview = (h, snapshotId) =>
  h.runtime.previewPolicy({
    snapshotId,
    operatorId: "201",
    policy: { ...h.config.policies[0].policy, version: "synthetic-feedback-preview/v2" },
  });
async function withheld(h, pin, reason = /feedback|authorization_changed|policy_input_revoked|source_unavailable/) {
  for (const id of [pin, null]) {
    try {
      assert.equal(await read(h, id), null);
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      assert.match(error.message, reason);
    }
  }
}
async function acceptedPublication(h) {
  assert.equal((await h.collect()).state, "published");
  const receipt = await h.accept();
  const cutoff = clock(),
    result = await h.collect({ cutoff });
  assert.equal(result.state, "published", JSON.stringify(result));
  return { receipt, cutoff, pin: result.publications[0].snapshotId };
}
async function assertMinimized(h) {
  for (const name of [
    "leaderboard_ingestion.source_facts",
    "leaderboard_pipeline.normalizations",
    "leaderboard_pipeline.discussion_feedback_heads",
    "leaderboard_pipeline.discussion_feedback_scans",
    "leaderboard_pipeline.frozen_inputs",
    "leaderboard_pipeline.snapshots",
    "leaderboard_pipeline.receipts",
  ])
    assert.doesNotMatch(
      JSON.stringify((await h.db.query(`SELECT * FROM ${name}`)).rows),
      new RegExp(`${feedbackSentinel}|${feedbackTitleSentinel}`),
      name,
    );
  assert.doesNotMatch(
    JSON.stringify(h.controlsStore.read()),
    new RegExp(`${feedbackSentinel}|${feedbackTitleSentinel}`),
  );
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        assert.doesNotMatch(
          await readFile(path, "utf8"),
          new RegExp(`${feedbackSentinel}|${feedbackTitleSentinel}`),
          path,
        );
    }
  };
  await walk(h.checkpointDirectory);
}
test("stored sentinel and actual pipeline: independent author/thread acceptance survives unchanged scans and durable reopen", async (t) => {
  const h = await helpfulFeedbackHarness(t);
  const initial = await h.collect();
  assert.equal(initial.state, "published", JSON.stringify(initial));
  const receipt = await h.accept();
  await h.accept({ sourceMetricId: "discussion_answers", id: "synthetic-feedback-answer-alias" });
  const accepted = await h.collect();
  assert.equal(accepted.state, "published", JSON.stringify(accepted));
  const pin = accepted.publications[0].snapshotId;
  const visible = await read(h, pin);
  assert.ok(visible);
  assert.equal(totals(visible.selected), 1);
  const proof = visible.selected.evidence.find((entry) => entry.contribution.metricIds.includes("helpful_feedback"));
  assert.ok(proof);
  assert.equal(proof.contribution.actorId, "101");
  assert.equal(proof.evidenceMetadata.acceptedAt, new Date(receipt.decision.at).toISOString());
  assert.equal(proof.evidenceMetadata.sourceOccurredAt, receipt.target.occurredAt);
  assert.doesNotMatch(
    JSON.stringify(visible),
    /gdf1:|bodyDigest|descriptorFingerprint|coverageEpoch|synthetic-feedback-accepted/,
  );
  await assertMinimized(h);
  const original = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=2")
  ).rows[0].document;
  await h.reopenDatabase();
  const next = await h.collect();
  assert.equal(next.state, "published", JSON.stringify(next));
  const current = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=2")
  ).rows[0].document;
  assert.equal(current.coverageEpoch, original.coverageEpoch);
  assert.deepEqual(current.inventory, original.inventory);
  assert.notEqual(current.lastScanId, original.lastScanId);
  assert.equal(totals((await read(h, next.publications[0].snapshotId)).selected), 1);
  assert.equal(totals((await read(h, pin)).selected), 1);
  await assertMinimized(h);
});

test("content enrollment is disabled by default; absent exact source-use authority prevents all content reads", async (t) => {
  await t.test("metadata-only default", async (t) => {
    const h = await helpfulFeedbackHarness(t, { enrolled: false, memoryDatabase: true });
    assert.equal((await h.collect()).state, "published");
    assert.ok(h.state.queries.length > 0);
    assert.ok(h.state.queries.every((query) => !/\bbody\b|\btitle\b|lastEditedAt/.test(query)));
    assert.equal(await head(h), undefined);
    assert.equal(
      (await h.db.query("SELECT count(*) AS n FROM leaderboard_pipeline.discussion_feedback_scans")).rows[0].n,
      0,
    );
  });
  await t.test("exact enrolled authority is unavailable", async (t) => {
    const h = await helpfulFeedbackHarness(t, { memoryDatabase: true });
    h.state.epoch = null;
    await assert.rejects(h.collect(), /discussion_feedback_authority_unavailable/);
    assert.equal(h.state.reads, 0);
    assert.deepEqual(await readdir(h.checkpointDirectory), []);
  });
});

test("complete scan receipts are immutable and exact collection replay does not reread or relabel withdrawn feedback", async (t) => {
  const h = await helpfulFeedbackHarness(t),
    { receipt, cutoff, pin } = await acceptedPublication(h);
  const beforeReads = h.state.reads,
    beforeHead = await head(h);
  await assert.rejects(
    h.db.query("UPDATE leaderboard_pipeline.discussion_feedback_scans SET document=document WHERE repository_id=2"),
    /immutable_discussion_feedback_scan/,
  );
  const replay = await h.collect({ cutoff });
  assert.equal(replay.state, "published");
  assert.equal(replay.publications[0].snapshotId, pin);
  assert.equal(h.state.reads, beforeReads);
  assert.deepEqual(await head(h), beforeHead);
  assert.equal(totals((await read(h, pin)).selected), 1);
  assert.ok(await preview(h, pin));
  assert.ok(await h.runtime.aggregateExplanations.read(pin));
  h.controlsStore.transaction((controls) => {
    controls.requests[receipt.request.id].status = "withdrawn";
  });
  await withheld(h, pin);
  await assert.rejects(preview(h, pin), /policy_input_revoked|authorization_changed/);
  await assert.rejects(h.runtime.aggregateExplanations.read(pin), /authorization_changed/);
  const repaired = await h.collect({ cutoff });
  assert.equal(repaired.state, "published");
  assert.notEqual(repaired.publications[0].snapshotId, pin);
  assert.equal(h.state.reads, beforeReads);
  assert.equal(totals((await read(h, repaired.publications[0].snapshotId)).selected), 0);
  await assertMinimized(h);
});

test("observed A to B to A cannot resurrect approval after the intermediate complete receipt is pruned", async (t) => {
  const h = await helpfulFeedbackHarness(t),
    { receipt, pin } = await acceptedPublication(h);
  const original = await head(h);
  h.state.rows[0].body += "_OBSERVED_B";
  await assert.rejects(h.collect(), /feedback_source_unverified/);
  const changed = await head(h);
  assert.equal(changed.coverageEpoch, original.coverageEpoch);
  assert.notEqual(changed.inventory[0].generation, original.inventory[0].generation);
  await withheld(h, pin);
  await assert.rejects(preview(h, pin), /feedback_publication_obsolete|feedback_coverage_unavailable/);
  // Simulate loss of an intermediate receipt in this
  // synthetic database. The retained generation head cannot infer continuity
  // from the now-incomplete list of old observations.
  await h.db.query("DELETE FROM leaderboard_pipeline.discussion_feedback_scans WHERE repository_id=2 AND scan_id=$1", [
    changed.lastScanId,
  ]);
  h.state.rows[0].body = feedbackSentinel;
  await assert.rejects(h.collect(), /feedback_source_unverified/);
  const reverted = await head(h);
  assert.equal(reverted.inventory[0].fingerprint, original.inventory[0].fingerprint);
  assert.notEqual(reverted.inventory[0].generation, original.inventory[0].generation);
  assert.notEqual(reverted.inventory[0].generation, changed.inventory[0].generation);
  await h.reopenDatabase();
  await withheld(h, pin);
  h.controlsStore.transaction((controls) => {
    controls.requests[receipt.request.id].status = "withdrawn";
  });
  const noCredit = await h.collect();
  assert.equal(noCredit.state, "published");
  assert.equal(totals((await read(h, noCredit.publications[0].snapshotId)).selected), 0);
  const fresh = await h.accept({ id: "synthetic-feedback-new-review" });
  assert.equal(fresh.source.metadata.generation, reverted.inventory[0].generation);
  const accepted = await h.collect();
  assert.equal(accepted.state, "published");
  assert.equal(totals((await read(h, accepted.publications[0].snapshotId)).selected), 1);
});

test("complete absence and later reappearance require a new review even for identical bytes", async (t) => {
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true }),
    { receipt, pin } = await acceptedPublication(h);
  const original = await head(h),
    node = structuredClone(h.state.rows[0]);
  h.state.rows = [];
  await assert.rejects(h.collect(), /discussion_feedback_source_unverified/);
  assert.deepEqual((await head(h)).inventory, []);
  await withheld(h, pin);
  h.controlsStore.transaction((controls) => {
    controls.requests[receipt.request.id].status = "withdrawn";
  });
  const empty = await h.collect();
  assert.equal(empty.state, "published");
  assert.equal(totals((await read(h, empty.publications[0].snapshotId)).selected), 0);
  h.state.rows = [node];
  const returned = await h.collect();
  assert.equal(returned.state, "published");
  assert.notEqual((await head(h)).inventory[0].generation, original.inventory[0].generation);
  assert.equal(totals((await read(h, returned.publications[0].snapshotId)).selected), 0);
});

test("an incomplete scan and lost checkpoints rotate coverage before any subsequent complete observation", async (t) => {
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true }),
    { pin } = await acceptedPublication(h);
  const original = await head(h);
  h.state.rows[0].body += "_INTERMEDIATE";
  for (let index = 0; index < 10; index++) {
    const node = feedbackNode();
    node.id = `D_SYNTHETIC_EXTRA_${index}`;
    node.url = node.url.replace(/4$/, String(100 + index));
    node.answer.id = `DC_SYNTHETIC_EXTRA_${index}`;
    h.state.rows.push(node);
  }
  const beforeReads = h.state.reads,
    cutoff = clock();
  h.state.failPage = 10;
  const interrupted = await h.collect({ cutoff });
  assert.notEqual(interrupted.state, "published");
  assert.equal(h.state.reads, beforeReads + 2, "the first content page was actually observed before the second failed");
  assert.ok((await readdir(h.checkpointDirectory)).length > 0);
  const pending = await head(h);
  assert.ok(pending.pending);
  await withheld(h, pin);
  for (const name of await readdir(h.checkpointDirectory))
    await rm(join(h.checkpointDirectory, name), { recursive: true, force: true });
  h.state.rows[0].body = feedbackSentinel;
  h.state.failPage = false;
  await assert.rejects(h.collect({ cutoff }), /feedback_source_unverified/);
  const resumed = await head(h);
  assert.notEqual(resumed.coverageEpoch, original.coverageEpoch);
  assert.notEqual(resumed.coverageEpoch, pending.coverageEpoch);
  assert.notEqual(
    resumed.inventory.find((entry) => entry.discussionId === original.inventory[0].discussionId).generation,
    original.inventory[0].generation,
  );
  await withheld(h, pin);
  await assertMinimized(h);
});

test("current source-use revocation fences retained reads and frozen previews, and changing epoch requires fresh acceptance", async (t) => {
  const h = await helpfulFeedbackHarness(t),
    { receipt, pin } = await acceptedPublication(h),
    beforeReads = h.state.reads;
  const original = await head(h);
  h.state.epoch = null;
  await assert.rejects(h.collect(), /feedback_authority_unavailable/);
  assert.equal(h.state.reads, beforeReads);
  await withheld(h, pin);
  await assert.rejects(preview(h, pin), /feedback_authority_unavailable/);
  h.state.epoch = "synthetic-feedback-authority-2";
  await assert.rejects(h.collect(), /feedback_coverage_unavailable/);
  assert.notEqual((await head(h)).coverageEpoch, original.coverageEpoch);
  await withheld(h, pin);
  h.controlsStore.transaction((controls) => {
    controls.requests[receipt.request.id].status = "withdrawn";
  });
  const next = await h.collect();
  assert.equal(next.state, "published");
  assert.equal(totals((await read(h, next.publications[0].snapshotId)).selected), 0);
});

test("content scope revocation during a read prevents checkpointing or completing the observation", async (t) => {
  const h = await helpfulFeedbackHarness(t, { memoryDatabase: true });
  h.state.onRead = () => {
    h.state.epoch = null;
  };
  await assert.rejects(h.collect(), /feedback_authority_unavailable/);
  assert.equal(h.state.reads, 1);
  assert.deepEqual(await readdir(h.checkpointDirectory), []);
  assert.equal(
    (await h.db.query("SELECT count(*) AS n FROM leaderboard_pipeline.discussion_feedback_scans")).rows[0].n,
    0,
  );
});

test("raw text never reaches a checkpoint on invalid Unicode, size, hidden answer or a future native clock", async (t) => {
  for (const change of [
    (node) => {
      node.body = feedbackSentinel + "\ud800";
    },
    (node) => {
      node.title = feedbackTitleSentinel + "a".repeat(4096);
    },
    (node) => {
      node.answer.isMinimized = true;
    },
    (node) => {
      node.updatedAt = "2099-01-01T00:00:00Z";
    },
  ])
    await t.test(change.toString(), async (t) => {
      const h = await helpfulFeedbackHarness(t, { memoryDatabase: true });
      change(h.state.rows[0]);
      let outcome;
      try {
        outcome = await h.collect();
      } catch (error) {
        assert.match(error.message, /feedback/);
      }
      assert.notEqual(outcome?.state, "published");
      await assertMinimized(h);
    });
});

test("a missing coverage head, original receipt, or current membership fails unavailable instead of guessing continuity", async (t) => {
  for (const missing of ["head", "original receipt", "current membership"])
    await t.test(missing, async (t) => {
      const h = await helpfulFeedbackHarness(t, { memoryDatabase: true }),
        { receipt, cutoff, pin } = await acceptedPublication(h);
      if (missing === "head")
        await h.db.query("DELETE FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=2");
      else if (missing === "original receipt")
        await h.db.query(
          "DELETE FROM leaderboard_pipeline.discussion_feedback_scans WHERE repository_id=2 AND scan_id=$1",
          [receipt.source.metadata.scanId],
        );
      else
        await h.db.query("DELETE FROM leaderboard_ingestion.collection_items WHERE run_id=$1", [
          (await head(h)).lastScanId,
        ]);
      await withheld(h, pin);
      await assert.rejects(preview(h, pin), /feedback/);
      await assert.rejects(h.runtime.aggregateExplanations.read(pin), /feedback/);
      await assert.rejects(h.collect({ cutoff }), /feedback|collection/);
    });
});
