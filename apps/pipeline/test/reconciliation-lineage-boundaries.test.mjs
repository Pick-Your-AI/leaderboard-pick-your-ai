import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { harness, components, clock, ago, fixtureId } from "./harness.mjs";

const issue = (number) => ({
  id: 1000 + number,
  node_id: `SYNTHETIC_LINEAGE_${number}`,
  number,
  html_url: `https://github.com/synthetic-org/synthetic-repo/issues/${number}`,
  created_at: ago(2),
  updated_at: ago(1),
  user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
});
const fact = (item) => ({
  subjectId: item.node_id,
  sourceRevision: item.updated_at,
  sourceUrl: item.html_url,
  evidence: "current_state",
  actorId: null,
  occurredAt: null,
  state: "open",
});
const page = (items, nextCursor = null, expectedCount = items.length) => ({
  repositoryId: 2,
  visibility: "public",
  facts: items.map(fact),
  nextCursor,
  expectedCount,
});
async function frozen(h, options = {}, runtime = h.runtime) {
  const publication = await runtime.runOnce(options);
  assert.equal(publication.state, "published");
  const row = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.publications[0].snapshotId,
    ])
  ).rows[0];
  assert.ok(row.document.frozen.coverage.every((record) => record.state === "partial"));
  return row.document.frozen;
}

async function correct(h, fact, number, id = 901) {
  const requestId = fixtureId(id);
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "102",
      locator: `https://github.com/synthetic-org/synthetic-repo/issues/${number}`,
      status: "pending",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId: fact.id,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  await h.runtime.applyCorrection(decision);
  return decision;
}

test("persistent imported fact lineage handles committed partial pages, failure, same-run resume, refresh, and audit", async (t) => {
  const payloads = [issue(1)];
  let visible = 1;
  const h = await harness(t, {
    payloads,
    source: {
      async readPage(request) {
        if (request.mode === "backfill")
          return request.cursor === null ? page([payloads[1]], "page-2", 2) : page([payloads[2]], null, 2);
        return page(payloads.slice(0, visible));
      },
    },
  });
  const initial = await frozen(h);
  h.add(issue(2));
  h.add(issue(3));
  visible = 2;
  const backfillCutoff = clock();
  const pending = await h.runtime.runOnce({ mode: "backfill", cutoff: backfillCutoff, maxPages: 1 });
  assert.equal(pending.state, "collecting");
  const runId = pending.progress[0].runId;
  const partial = await frozen(h);
  assert.equal(partial.facts.length, 2);
  assert.notEqual(partial.backfillRevision, initial.backfillRevision);
  assert.deepEqual(
    (await h.db.query("SELECT state FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [runId])).rows,
    [{ state: "pending" }],
  );
  assert.equal(
    await h.runtime.collection.step(runId, {
      async readPage() {
        throw new Error("synthetic failed next page");
      },
    }),
    "failed",
  );
  const failed = await frozen(h);
  assert.equal(failed.backfillRevision, partial.backfillRevision);
  const resumed = await frozen(h, { mode: "backfill", cutoff: backfillCutoff });
  assert.equal(resumed.facts.length, 3);
  assert.notEqual(resumed.backfillRevision, partial.backfillRevision);
  const origins = (
    await h.db.query(
      "SELECT first_run_id FROM leaderboard_ingestion.source_facts WHERE subject_id IN ('SYNTHETIC_LINEAGE_2','SYNTHETIC_LINEAGE_3') ORDER BY subject_id",
    )
  ).rows;
  assert.deepEqual(origins, [{ first_run_id: runId }, { first_run_id: runId }]);
  visible = 3;
  for (const item of payloads) item.updated_at = clock();
  const refreshed = await frozen(h);
  assert.equal(refreshed.backfillRevision, resumed.backfillRevision);
  const retainedImportCount = (
    await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1", [runId])
  ).rows[0].n;
  assert.equal(retainedImportCount, 2);
  assert.equal((await frozen(h, { mode: "audit" })).backfillRevision, resumed.backfillRevision);
  h.add(issue(4));
  visible = 4;
  assert.notEqual((await frozen(h, { mode: "audit" })).backfillRevision, resumed.backfillRevision);
});

test("empty or failed-before-first-page explicit scans do not invent a lineage change", async (t) => {
  const h = await harness(t);
  const original = await frozen(h);
  for (const [runId, mode, shouldFail] of [
    ["synthetic-empty-audit", "audit", false],
    ["synthetic-unstarted-backfill", "backfill", true],
  ]) {
    await h.runtime.collection.start({ runId, repositoryId: 2, family: "issues", mode, since: null, until: clock() });
    const status = await h.runtime.collection.step(runId, {
      async readPage() {
        if (shouldFail) throw new Error("synthetic failure before first page");
        return page([]);
      },
    });
    assert.equal(status, shouldFail ? "failed" : "complete");
    assert.equal((await frozen(h)).backfillRevision, original.backfillRevision);
  }
});

test("cumulative imported history admits 10,000 retained facts and rejects 10,001 even when current selection is small", async (t) => {
  const h = await harness(t);
  await frozen(h);
  const seed = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key LIMIT 1")).rows[0];
  const runId = "synthetic-cumulative-lineage-budget";
  await h.runtime.collection.start({
    runId,
    repositoryId: 2,
    family: "issues",
    mode: "backfill",
    since: null,
    until: clock(),
  });
  // Disposable obsolete source fixtures test the cumulative guard independently
  // of the smaller currently selected source count. No complete-history receipt
  // is created and the published coverage remains partial.
  const add = async (from, to) => {
    await h.db.query(
      `INSERT INTO leaderboard_ingestion.source_facts
       (fact_key,repository_id,family,subject_id,source_revision,document,first_run_id,observed_at)
       SELECT lpad(to_hex(i),64,'0'),2,'issues',$1,'synthetic-obsolete-'||i,$2::jsonb,$3,
         $4::timestamptz-interval '1 second'
       FROM generate_series($5::int,$6::int) AS i`,
      [seed.subject_id, JSON.stringify(seed.document), runId, seed.observed_at, from, to],
    );
    await h.db.query(
      `INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode)
       SELECT lpad(to_hex(i),64,'0'),'synthetic' FROM generate_series($1::int,$2::int) AS i`,
      [from, to],
    );
  };
  await add(100000, 109999);
  const valid = await frozen(h);
  assert.equal(valid.facts.length, 2);
  await add(110000, 110000);
  await assert.rejects(h.runtime.runOnce(), /reconciliation_history_budget_exceeded/);
  const head = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id;
  const retained = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [head])
  ).rows[0].document.frozen;
  assert.deepEqual(retained, valid);
});

test("authorized corrections change lineage once and correction row order cannot change the epoch", async (t) => {
  const h = await harness(t);
  const original = await frozen(h);
  const firstDecision = await correct(
    h,
    original.facts.find((item) => item.artifactId === "SYNTHETIC_ISSUE_1"),
    1,
    902,
  );
  const first = await frozen(h);
  assert.notEqual(first.backfillRevision, original.backfillRevision);
  await h.runtime.applyCorrection(firstDecision);
  assert.equal((await frozen(h)).backfillRevision, first.backfillRevision);
  await correct(
    h,
    original.facts.find((item) => item.artifactId === "SYNTHETIC_ISSUE_2"),
    2,
    901,
  );
  const second = await frozen(h);
  assert.notEqual(second.backfillRevision, first.backfillRevision);
  const query = h.db.query.bind(h.db),
    transaction = h.db.transaction.bind(h.db),
    reorderedReads = { materialization: 0, publication: 0 };
  const reverseCorrections = (sql, result, phase) => {
    if (sql.startsWith("SELECT c.request_id,c.fact_id,c.artifact_id,c.repository_id,c.document,")) {
      reorderedReads[phase]++;
      result.rows.reverse();
    }
    return result;
  };
  h.db.query = async (sql, params) => reverseCorrections(sql, await query(sql, params), "materialization");
  // Apply the same permutation to the final locked state recheck: this tests
  // row-order invariance, not a correction-state change during publication.
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => reverseCorrections(sql, await tx.query(sql, params), "publication"),
      }),
    );
  const reordered = await frozen(h);
  assert.deepEqual(reorderedReads, { materialization: 1, publication: 1 });
  assert.equal(reordered.backfillRevision, second.backfillRevision);
  assert.deepEqual(
    reordered.facts.filter((item) => item.correctionReceipt).map((item) => item.id),
    second.facts
      .filter((item) => item.correctionReceipt)
      .map((item) => item.id)
      .reverse(),
  );
});

test("a frozen dispatch retry excludes later import and correction lineage while retaining the complete correction input", async (t) => {
  const payloads = [issue(1), issue(2)];
  const h = await harness(t, {
    payloads,
    webhookDispatch: true,
    source: {
      async readPage(request) {
        return request.mode === "backfill" ? page([payloads[2]], "page-2", 2) : page(payloads);
      },
    },
  });
  const original = await frozen(h);
  const secret = "synthetic-lineage-webhook-secret-more-than-32-characters";
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: { node_id: "SYNTHETIC_SENDER_NOT_AUTHOR" },
    issue: { node_id: payloads[0].node_id, number: 1, created_at: payloads[0].created_at },
  });
  const handler = components.ingestion.createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
  });
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": fixtureId(700),
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(response.status, 202, await response.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  const query = h.db.query.bind(h.db);
  let stoppedAfterFreeze = 0;
  h.db.query = async (sql, params) => {
    // Match the source-row read for both direct and private-field-stripped projections.
    if (sql.startsWith("SELECT fact.* FROM ") && sql.includes("FROM leaderboard_ingestion.source_facts")) {
      stoppedAfterFreeze++;
      throw new Error("synthetic_stop_after_freeze");
    }
    return query(sql, params);
  };
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  h.db.query = query;
  assert.equal(stoppedAfterFreeze, 1);
  const eventKey = `github:delivery:${fixtureId(700)}`;
  const retained = (await query("SELECT * FROM leaderboard_ingestion.outbox WHERE event_key=$1", [eventKey])).rows[0];
  assert.notEqual(retained.observation_cutoff, null);
  const observationCutoff = new Date(retained.observation_cutoff).toISOString();
  assert.ok(observationCutoff);
  assert.equal(retained.completion, null);

  h.add(issue(3));
  assert.equal((await h.runtime.runOnce({ mode: "backfill", maxPages: 1 })).state, "collecting");
  await correct(
    h,
    original.facts.find((item) => item.artifactId === payloads[0].node_id),
    1,
  );
  await query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE event_key=$1", [eventKey]);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const done = (await query("SELECT * FROM leaderboard_ingestion.outbox WHERE event_key=$1", [eventKey])).rows[0];
  assert.equal(new Date(done.observation_cutoff).toISOString(), observationCutoff);
  const replay = (
    await query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      done.completion.publications[0].snapshotId,
    ])
  ).rows[0].document.frozen;
  assert.equal(replay.cutoff, observationCutoff);
  assert.equal(replay.backfillRevision, original.backfillRevision);
  assert.equal(
    replay.facts.some((item) => item.artifactId === payloads[2].node_id),
    false,
  );
  const later = replay.facts.filter((item) => item.correctionReceipt);
  assert.equal(later.length, 1);
  assert.ok(later[0].observedAt > replay.cutoff);
  assert.notEqual(replay.datasetId, original.datasetId);
  assert.ok(replay.coverage.every((record) => record.state === "partial"));
});
