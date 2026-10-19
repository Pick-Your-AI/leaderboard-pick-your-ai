import test from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/index.mjs";
import { issueTransferDigest } from "../src/issue-transfer-store.mjs";
import { issueTransferHarness } from "./issue-transfer-harness.mjs";
import { components, fixtureId } from "./harness.mjs";
import {
  operatorAllow,
  operatorSettings,
  operatorScopes,
  operatorHarness,
  queueOperatorReplay,
} from "./operator-harness.mjs";

// These traces exercise actual single-connection transaction entry. They model
// lock ordering; they do not claim PostgreSQL interconnection scheduling.
function transactionTrace(db) {
  const traces = [];
  const transaction = db.transaction.bind(db);
  db.transaction = (work) =>
    transaction(async (tx) => {
      const trace = [];
      traces.push(trace);
      return work({
        query: async (sql, params) => {
          trace.push({ sql, params: structuredClone(params) });
          return tx.query(sql, params);
        },
      });
    });
  return traces;
}
function graphFirst(traces) {
  const entered = traces.filter((trace) =>
    trace.some((entry) => entry.sql.includes("'pipeline-issue-transfer-graph/v1'")),
  );
  assert.ok(entered.length > 0, "The actual nested graph path must execute");
  for (const trace of entered) {
    const first = trace.findIndex((entry) => entry.sql.includes("'pipeline-issue-transfer-graph/v1'"));
    for (const entry of trace.slice(0, first))
      assert.equal(
        /(?:repository_access|outbox|normalizations)[\s\S]*FOR (?:SHARE|UPDATE)/.test(entry.sql),
        false,
        `A source, normalization or outbox row lock preceded the graph gate: ${entry.sql}`,
      );
    let shared = false;
    for (const entry of trace.filter((entry) => entry.sql.includes("'pipeline-issue-transfer-graph/v1'"))) {
      const exclusive = entry.sql.includes("pg_advisory_xact_lock(");
      assert.equal(shared && exclusive, false, "A shared graph gate must not be upgraded");
      if (!exclusive) shared = true;
    }
  }
  return entered;
}
async function completeReplay(h, receipt) {
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const replay = await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  assert.equal(replay.status, "published", JSON.stringify(replay));
  const health = await h.runtime.operations.readHealth(2, operatorAllow);
  assert.equal(health.publication.state, "verified", JSON.stringify(health.publication));
  assert.deepEqual(health.publication.publications, replay.publications);
  return { replay, health };
}
async function transferOperator(t) {
  const original = await issueTransferHarness(t);
  const runtime = await createPipeline({
    ...original.options,
    webhookDispatch: true,
    operatorDiagnostics: operatorSettings(),
  });
  t.after(() => runtime.stop());
  const h = { ...original, runtime };
  for (const id of [2, 3]) assert.equal(await runtime.collection.verifyPublic(id, 1, null), true);
  await runtime.inbox.insert({
    deliveryId: fixtureId(650),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: fixtureId(650),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: h.fixture.sourceSubjectId,
      sourceUrl: h.fixture.sourceUrl,
      actorId: null,
      occurredAt: h.fixture.bornAt,
    },
  });
  const failing = new components.ingestion.InboxStore(h.db, 1);
  assert.equal(await failing.fail(await failing.claim(), "source_unavailable", true), true);
  const row = (await runtime.operations.read(2, operatorAllow)).quarantined.find(
    (entry) => entry.deliveryId === fixtureId(650),
  );
  const receipt = await runtime.operations.replay(
    {
      repositoryId: 2,
      deliveryId: row.deliveryId,
      expectedRevision: row.revision,
      reason: "source_recovered",
      operatorId: "201",
    },
    operatorAllow,
  );
  return { h, receipt };
}

test("ordinary dispatch completion and operator replay health enter graph gates before their row locks", async (t) => {
  const h = await operatorHarness(t, {
    webhookDispatch: true,
    configure(config) {
      config.scopes = operatorScopes;
    },
  });
  const traces = transactionTrace(h.db);
  const receipt = await queueOperatorReplay(h, 649);
  const { replay } = await completeReplay(h, receipt);
  assert.equal(replay.publications.length, 2);
  const entered = graphFirst(traces);
  assert.ok(
    entered.some((trace) => trace.some((entry) => entry.sql.includes("outbox SET state='done'"))),
    "Completion transaction must be checked",
  );
  assert.ok(
    entered.some((trace) => trace.some((entry) => entry.sql.includes("replay_processing_results"))),
    "Replay reader must be checked",
  );
});

test("transfer dispatch operator proof binds selected scope separately from retained dependency IDs and rejects corrupted capture", async (t) => {
  const { h, receipt } = await transferOperator(t);
  const traces = transactionTrace(h.db);
  const { replay } = await completeReplay(h, receipt);
  assert.equal(replay.publications.length, 3);
  const frozen = (await h.db.query("SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs"))
    .rows;
  const target = frozen.find(
    (row) => row.document.engineScope.repos.length === 1 && row.document.engineScope.repos[0] === "3",
  );
  assert.ok(target);
  assert.deepEqual(target.document.frozen.repositoryIds, ["2", "3"]);
  assert.deepEqual(target.document.identityAuthorization.issueTransferEvidence.selectedRepositoryIds, ["3"]);
  assert.ok(target.document.identityAuthorization.issueTransferEvidence.bindings.length > 0);
  assert.ok(replay.publications.some((publication) => publication.snapshotId === target.snapshot_id));
  graphFirst(traces);
  for (const mutation of ["unhashed-repository-set", "repinned-capture-omission"]) {
    const changed = structuredClone(target.document);
    if (mutation === "unhashed-repository-set") changed.frozen.repositoryIds = ["3"];
    else changed.identityAuthorization.issueTransferEvidence.bindings = [];
    await h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [
        target.snapshot_id,
        JSON.stringify(changed),
        mutation === "unhashed-repository-set" ? target.document_hash : issueTransferDigest(changed),
      ],
    );
    const denied = await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
    assert.equal(denied.status, "unavailable", mutation);
    assert.deepEqual(denied.publications, []);
    await h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [target.snapshot_id, JSON.stringify(target.document), target.document_hash],
    );
    assert.equal((await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow)).status, "published");
  }
  assert.equal(await h.runtime.collection.suppress(fixtureId(651), "b".repeat(64), 1, [3], "private"), "accepted");
  assert.equal((await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow)).status, "unavailable");
  assert.equal((await h.runtime.operations.readHealth(2, operatorAllow)).publication.state, "unavailable");
});

test("outbox completion awaits trusted preparation and a failed preparation cannot lock a lease or acknowledge", async () => {
  const events = [];
  const db = {
    transaction: async (work) =>
      work({
        query: async () => {
          events.push("query");
          assert.fail("Preparation failure must precede every SQL row lock");
        },
      }),
  };
  const outbox = new components.ingestion.OutboxStore(db);
  await assert.rejects(
    outbox.complete(
      {},
      [{ scopeKey: "synthetic", snapshotId: "a".repeat(64), revision: 1 }],
      async () => assert.fail("No confirmation"),
      () => assert.fail("No acknowledgment"),
      async () => {
        events.push("preparing");
        await Promise.resolve();
        events.push("rejected");
        throw Error("synthetic_prepare_failed");
      },
    ),
    /synthetic_prepare_failed/,
  );
  assert.deepEqual(events, ["preparing", "rejected"]);
});

for (const method of ["readReplayResult", "readHealth"])
  test(`operator ${method} authenticates before trusted preparation and locks no source after preparation failure`, async () => {
    const events = [];
    const operations = new components.ingestion.OperatorInbox(
      {
        transaction: async (work) => work({ query: async () => assert.fail("No source row after failed preparation") }),
      },
      {
        readHealth: async () => assert.fail("No diagnostic"),
        prepareSourceRead: async () => {
          events.push("prepare");
          await Promise.resolve();
          throw Error("synthetic_prepare_failed");
        },
      },
    );
    const allow = async () => {
      events.push("authorize");
      return operatorAllow();
    };
    await assert.rejects(
      method === "readHealth"
        ? operations.readHealth(2, allow)
        : operations.readReplayResult(2, "synthetic-receipt", allow),
      /synthetic_prepare_failed/,
    );
    assert.deepEqual(events, ["authorize", "prepare"]);
    events.length = 0;
    const denied = async () => {
      events.push("denied");
      throw Error("synthetic_authority_revoked");
    };
    await assert.rejects(
      method === "readHealth"
        ? operations.readHealth(2, denied)
        : operations.readReplayResult(2, "synthetic-receipt", denied),
      /synthetic_authority_revoked/,
    );
    assert.deepEqual(events, ["denied"]);
  });
