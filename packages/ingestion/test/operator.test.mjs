import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { OperatorInbox } from "../dist/operator.js";
async function fixture(t) {
  const engine = new PGlite();
  for (const file of ["001_ingestion", "002_snapshots", "003_collection"]) {
    await engine.exec(await readFile(new URL(`../sql/${file}.up.sql`, import.meta.url), "utf8"));
  }
  t.after(() => engine.close());
  const db = {
    query: (s, p) => engine.query(s, p),
    transaction: (fn) => engine.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) })),
  };
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(9,1,'public'),(8,1,'public')",
  );
  const id = "11111111-1111-1111-1111-111111111111";
  await db.query(
    "INSERT INTO leaderboard_ingestion.inbox(delivery_id,body_hash,envelope,state,attempts,reason_code) VALUES($1,$2,$3::jsonb,'quarantined',3,'source_unavailable')",
    [
      id,
      "a".repeat(64),
      JSON.stringify({ repositoryId: 9, installationId: 1, sourceUrl: "private-source-must-not-escape" }),
    ],
  );
  return { db, id, ops: new OperatorInbox(db) };
}
const allow = async () => ({ policyVersion: "reviewed-1", revision: "scope-1" });
test("scoped diagnostics never leak envelopes and audited replay queues once atomically", async (t) => {
  const { db, id, ops } = await fixture(t);
  const read = await ops.read(9, allow);
  assert.equal(read.counts.quarantined, 1);
  assert.equal(JSON.stringify(read).includes("private-source"), false);
  assert.equal((await ops.read(8, allow)).quarantined.length, 0);
  const input = {
    repositoryId: 9,
    deliveryId: id,
    expectedRevision: read.quarantined[0].revision,
    operatorId: "7",
    reason: "source_recovered",
  };
  const receipt = await ops.replay(input, allow);
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.resultingPublicationRevision, null);
  const state = await ops.read(9, allow);
  assert.equal(state.counts.pending, 1);
  assert.equal(state.receipts[0].operatorId, "7");
  assert.equal(state.receipts[0].beforeRevision, input.expectedRevision);
  await assert.rejects(() => ops.replay(input, allow), /changed/);
  assert.equal((await db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows.length, 1);
});
test("replay denies foreign source, changed policy, revoked access and authorization races without writes", async (t) => {
  const { db, id, ops } = await fixture(t);
  const read = await ops.read(9, allow);
  const input = {
    repositoryId: 9,
    deliveryId: id,
    expectedRevision: read.quarantined[0].revision,
    operatorId: "7",
    reason: "operator_reviewed",
  };
  await assert.rejects(() => ops.replay({ ...input, repositoryId: 8 }, allow));
  await assert.rejects(() => ops.replay(input, async () => ({ policyVersion: "new", revision: "scope-1" })));
  let calls = 0;
  await assert.rejects(() =>
    ops.replay(input, async () => {
      if (++calls > 1) throw Error("revoked");
      return allow();
    }),
  );
  assert.equal((await db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows.length, 0);
  await db.query(
    "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1 WHERE repository_id=9",
  );
  await assert.rejects(() => ops.read(9, allow), /unavailable/);
  await assert.rejects(() => ops.replay(input, allow), /unavailable/);
});
test("prior quarantine token cannot authorize a later failed attempt cycle", async (t) => {
  const { db, id, ops } = await fixture(t);
  const before = await ops.read(9, allow);
  await db.query(
    "UPDATE leaderboard_ingestion.inbox SET available_at=available_at+interval '1 second' WHERE delivery_id=$1",
    [id],
  );
  await assert.rejects(
    () =>
      ops.replay(
        {
          repositoryId: 9,
          deliveryId: id,
          expectedRevision: before.quarantined[0].revision,
          operatorId: "7",
          reason: "operator_reviewed",
        },
        allow,
      ),
    /changed/,
  );
});

test("diagnostics bound retained rows and changed installation excludes old deliveries", async (t) => {
  const { db, id, ops } = await fixture(t);
  await db.query(`INSERT INTO leaderboard_ingestion.inbox(delivery_id,body_hash,envelope,state,attempts,reason_code)
    SELECT ('22222222-2222-2222-2222-' || lpad(i::text,12,'0'))::uuid,repeat('b',64),'{"repositoryId":9,"installationId":1}'::jsonb,'quarantined',1,'raw exception text' FROM generate_series(1,51) i`);
  const read = await ops.read(9, allow);
  assert.equal(read.quarantined.length, 50);
  assert.equal(read.truncated.quarantined, true);
  assert.equal(JSON.stringify(read).includes("raw exception"), false);
  await db.query(
    "UPDATE leaderboard_ingestion.repository_access SET installation_id=2,generation=generation+1 WHERE repository_id=9",
  );
  assert.equal((await ops.read(9, allow)).quarantined.length, 0);
  await assert.rejects(() =>
    ops.replay(
      {
        repositoryId: 9,
        deliveryId: id,
        expectedRevision: read.quarantined[0].revision,
        operatorId: "7",
        reason: "operator_reviewed",
      },
      allow,
    ),
  );
});

test("retained run and replay history carries its own source generation after a source epoch changes", async (t) => {
  const { db, id, ops } = await fixture(t);
  const first = await ops.read(9, allow);
  await ops.replay(
    {
      repositoryId: 9,
      deliveryId: id,
      expectedRevision: first.quarantined[0].revision,
      operatorId: "7",
      reason: "operator_reviewed",
    },
    allow,
  );
  await db.query(
    "INSERT INTO leaderboard_ingestion.collection_runs(run_id,repository_id,family,mode,until_at,access_generation) VALUES('historic',9,'issues','audit',clock_timestamp(),1)",
  );
  await db.query("UPDATE leaderboard_ingestion.repository_access SET generation=2 WHERE repository_id=9");
  const history = await ops.read(9, allow);
  assert.equal(history.sourceGeneration, "2");
  assert.equal(history.runs[0].sourceGeneration, "1");
  assert.equal(history.receipts[0].sourceGeneration, "1");
});
