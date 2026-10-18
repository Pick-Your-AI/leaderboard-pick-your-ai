import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import {
  CollectionStore,
  DeliveryPayloadExpiryStore,
  InboxStore,
  OperatorInbox,
  OutboxStore,
  SnapshotStore,
} from "../dist/index.js";

let engine, directory, db, inbox, outbox, expiry;
const migrations = [
  "001_ingestion",
  "002_snapshots",
  "003_collection",
  "004_outbox_dispatch",
  "006_delivery_payload_expiry",
  "007_operator_replay_results",
];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "leaderboard-delivery-expiry-"));
  engine = new PGlite(join(directory, "postgres"));
  db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  };
  for (const file of migrations)
    await engine.exec(await readFile(new URL(`../sql/${file}.up.sql`, import.meta.url), "utf8"));
  inbox = new InboxStore(db);
  outbox = new OutboxStore(db);
  expiry = new DeliveryPayloadExpiryStore(db);
});
after(async () => {
  await engine?.close();
  engine = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  // Fresh synthetic fixtures only; never used by the retention implementation.
  await db.query(
    "TRUNCATE leaderboard_ingestion.inbox, leaderboard_ingestion.repository_access, leaderboard_ingestion.snapshots, leaderboard_ingestion.delivery_payload_expiry_operations CASCADE",
  );
  await new CollectionStore(db).verifyPublic(2, 1, null);
  await new CollectionStore(db).verifyPublic(3, 1, null);
});

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const event = (n) => `github:delivery:${id(n)}`;
const allow = async () => true;
const request = (overrides = {}) => ({
  operationId: "synthetic-expiry-1",
  repositoryId: 2,
  installationId: 1,
  completedBefore: "2026-02-02T00:00:00.000Z",
  policyVersion: "synthetic-retention-v1",
  operatorId: "SYNTHETIC_OPERATOR",
  authorizationId: "synthetic-authorization-1",
  batchLimit: 10,
  ...overrides,
});
const binding = {
  configurationHash: "a".repeat(64),
  configurationVersion: "synthetic-v1",
  configurationRevision: 0,
  normalizationVersion: "issues-creation-dispatch.v1",
  policyVersion: "synthetic-v1",
  dataMode: "synthetic",
  cutoff: "2026-02-01T00:00:00.000Z",
};
const proof = [{ scopeKey: "synthetic-scope", snapshotId: "b".repeat(64), revision: 1 }];
function delivery(n = 1, overrides = {}) {
  return {
    deliveryId: id(n),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: id(n),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: "SYNTHETIC_ISSUE",
      actorId: "SYNTHETIC_ACTOR",
      occurredAt: "2026-01-01T00:00:00.000Z",
      sourceUrl: "https://github.com/synthetic-org/synthetic-repo/issues/3",
      ...overrides,
    },
  };
}
async function completed(n = 1, overrides = {}) {
  await inbox.insert(delivery(n, overrides));
  assert.equal(await inbox.complete(await inbox.claim()), true);
  const lease = await outbox.claim(binding);
  assert.equal(lease.eventKey, event(n));
  assert.equal(await outbox.complete(lease, proof, async () => {}), true);
  // Fix the two database completion clocks only in this disposable synthetic fixture.
  await db.query(
    "UPDATE leaderboard_ingestion.attempt_history SET finished_at='2026-02-01T00:00:00Z' WHERE delivery_id=$1 AND outcome='done'",
    [id(n)],
  );
  await db.query(
    "UPDATE leaderboard_ingestion.outbox_attempts SET finished_at='2026-02-01T00:00:00Z' WHERE event_key=$1 AND outcome='done'",
    [event(n)],
  );
}
async function payloads(n = 1) {
  return (
    await db.query(
      `SELECT intake.envelope,evidence.observation FROM leaderboard_ingestion.inbox AS intake
    LEFT JOIN leaderboard_ingestion.observations AS evidence USING (delivery_id) WHERE intake.delivery_id=$1`,
      [id(n)],
    )
  ).rows[0];
}
async function receiptCount() {
  return (
    await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.delivery_payload_expiry_operations")
  ).rows[0].count;
}

test("expiry requires explicit bounded identities and a real UTC cutoff before database access", async () => {
  const unavailable = new DeliveryPayloadExpiryStore({
    transaction() {
      assert.fail("database must not be reached");
    },
  });
  for (const invalid of [
    { operationId: "" },
    { operationId: {} },
    { policyVersion: undefined },
    { operatorId: null },
    { authorizationId: "unsafe\ntext" },
    { repositoryId: 0 },
    { installationId: "1" },
    { batchLimit: 0 },
    { batchLimit: 101 },
    { batchLimit: 1.5 },
    { completedBefore: undefined },
    { completedBefore: "0000-01-01T00:00:00.000Z" },
    { completedBefore: "2026-02-30T00:00:00.000Z" },
    { completedBefore: "2026-02-02" },
    { completedBefore: "2026-02-02T00:00:00+00:00" },
  ])
    await assert.rejects(unavailable.expireCompleted(request(invalid), allow), /invalid_delivery_expiry_request/);
  await assert.rejects(unavailable.expireCompleted(request(), undefined), /invalid_delivery_expiry_authorizer/);
  await assert.rejects(
    unavailable.expireCompleted(request(), async () => false),
    /delivery_expiry_not_authorized/,
  );
  await assert.rejects(
    expiry.expireCompleted(request({ completedBefore: "9999-01-01T00:00:00.000Z" }), allow),
    /delivery_expiry_future_cutoff/,
  );
  assert.equal(await receiptCount(), 0);
});

test("both minimized copies expire while durable acknowledgment, duplicate conflict detection and completion history survive", async () => {
  await completed();
  const before = {};
  for (const table of ["inbox", "observations", "attempt_history", "outbox", "outbox_attempts"])
    before[table] = (await db.query(`SELECT * FROM leaderboard_ingestion.${table}`)).rows;
  const receipt = await expiry.expireCompleted(request(), allow);
  assert.equal(receipt.expiredCount, 1);
  assert.equal(receipt.coverage, "selected_completed_deliveries_only");
  assert.deepEqual(await payloads(), { envelope: null, observation: null });
  for (const table of ["inbox", "observations", "attempt_history", "outbox", "outbox_attempts"]) {
    const expected = structuredClone(before[table]);
    if (table === "inbox") expected[0].envelope = null;
    if (table === "observations") expected[0].observation = null;
    assert.deepEqual((await db.query(`SELECT * FROM leaderboard_ingestion.${table}`)).rows, expected);
  }
  const restart = new InboxStore(db);
  assert.equal(await restart.insert(delivery()), "duplicate");
  assert.equal(await restart.insert({ ...delivery(), bodyHash: "b".repeat(64) }), "conflict");
  assert.deepEqual(await payloads(), { envelope: null, observation: null });
  assert.equal(await restart.claim(), null);
  assert.equal(await outbox.claim(binding), null);
  assert.equal(await restart.replay(id(1), "synthetic-unavailable-replay"), false);
  assert.equal(await outbox.replay(event(1), "synthetic-unavailable-dispatch"), false);
  const retained = (await db.query("SELECT * FROM leaderboard_ingestion.delivery_payload_expiries")).rows;
  assert.doesNotMatch(JSON.stringify([receipt, retained]), /SYNTHETIC_ACTOR|sourceUrl|occurredAt|github\.com/);
});

test("operation readback is exact, bounded and idempotent; new deliveries need a new operation", async () => {
  await completed(1);
  await completed(2);
  const first = await expiry.expireCompleted(request({ batchLimit: 1 }), allow);
  assert.equal(first.expiredCount, 1);
  assert.deepEqual(await expiry.expireCompleted(request({ batchLimit: 1 }), allow), first);
  assert.notEqual((await payloads(2)).envelope, null);
  for (const change of [
    { batchLimit: 2 },
    { policyVersion: "other" },
    { operatorId: "other" },
    { authorizationId: "other" },
    { repositoryId: 3 },
    { installationId: 2 },
    { completedBefore: "2026-02-03T00:00:00.000Z" },
  ])
    await assert.rejects(
      expiry.expireCompleted(request({ batchLimit: 1, ...change }), allow),
      /delivery_expiry_operation_conflict/,
    );
  assert.equal(
    (await expiry.expireCompleted(request({ operationId: "synthetic-expiry-2", batchLimit: 1 }), allow)).expiredCount,
    1,
  );
  await completed(3);
  assert.deepEqual(await expiry.expireCompleted(request({ batchLimit: 1 }), allow), first);
  assert.notEqual((await payloads(3)).envelope, null);
  await assert.rejects(
    expiry.expireCompleted(request({ batchLimit: 1 }), async () => false),
    /delivery_expiry_not_authorized/,
  );
});

test("a recorded zero-row batch prevents rollback and its operation ID never selects later work", async () => {
  const empty = await expiry.expireCompleted(request(), allow);
  assert.equal(empty.expiredCount, 0);
  await completed();
  const original = await payloads();
  await assert.rejects(
    engine.exec(await readFile(new URL("../sql/006_delivery_payload_expiry.down.sql", import.meta.url), "utf8")),
    /delivery_payload_expiry_irreversible/,
  );
  assert.deepEqual(await expiry.expireCompleted(request(), allow), empty);
  assert.deepEqual(await payloads(), original);
  assert.equal(await receiptCount(), 1);
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.delivery_payload_expiries")).rows[0]
      .count,
    0,
  );
  assert.equal(
    (await expiry.expireCompleted(request({ operationId: "synthetic-next-operation" }), allow)).expiredCount,
    1,
  );
});

test("exact numeric scope and exclusive completion clocks exclude other installations, repositories and newer work", async () => {
  await completed(1);
  await completed(2, { installationId: 2 });
  await completed(3, { repositoryId: 3 });
  await completed(4);
  await completed(5);
  await db.query("UPDATE leaderboard_ingestion.outbox_attempts SET finished_at=$2 WHERE event_key=$1", [
    event(4),
    request().completedBefore,
  ]);
  await db.query("UPDATE leaderboard_ingestion.attempt_history SET finished_at=$2 WHERE delivery_id=$1", [
    id(5),
    request().completedBefore,
  ]);
  assert.equal((await expiry.expireCompleted(request(), allow)).expiredCount, 1);
  for (const n of [2, 3, 4, 5]) assert.notEqual((await payloads(n)).envelope, null);
});

test("pending, leased and quarantined inbox or dispatch work remains recoverable", async () => {
  await inbox.insert(delivery(1));
  assert.equal((await expiry.expireCompleted(request({ operationId: "pending-inbox" }), allow)).expiredCount, 0);
  const inboxLease = await inbox.claim();
  assert.equal((await expiry.expireCompleted(request({ operationId: "leased-inbox" }), allow)).expiredCount, 0);
  await inbox.fail(inboxLease, "source_unavailable", true);
  assert.equal((await expiry.expireCompleted(request({ operationId: "quarantined-inbox" }), allow)).expiredCount, 0);
  assert.equal(await inbox.replay(id(1), "synthetic-inbox-recovery"), true);
  assert.equal(await inbox.complete(await inbox.claim()), true);
  assert.equal((await expiry.expireCompleted(request({ operationId: "pending-outbox" }), allow)).expiredCount, 0);
  let lease = await outbox.claim(binding);
  assert.equal((await expiry.expireCompleted(request({ operationId: "leased-outbox" }), allow)).expiredCount, 0);
  await outbox.fail(lease, "source_unavailable", true);
  assert.equal((await expiry.expireCompleted(request({ operationId: "quarantined-outbox" }), allow)).expiredCount, 0);
  assert.equal(await outbox.replay(event(1), "synthetic-dispatch-recovery"), true);
  lease = await outbox.claim(binding);
  assert.equal(await outbox.complete(lease, proof, async () => {}), true);
  assert.notEqual((await payloads()).observation, null);
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.replay_receipts")).rows[0].count,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.outbox_replays")).rows[0].count,
    1,
  );
});

test("malformed completion receipts and divergent observation copies never authorize payload expiry", async () => {
  const invalidPublications = [
    [],
    null,
    "not-an-array",
    [null],
    [{}],
    [{ ...proof[0], scopeKey: 2 }],
    [{ snapshotId: proof[0].snapshotId, revision: 1 }],
    [proof[0], { snapshotId: proof[0].snapshotId, revision: 1 }],
    [{ ...proof[0], snapshotId: "malformed" }],
    [{ ...proof[0], revision: "1" }],
    [{ ...proof[0], revision: 1.5 }],
    [{ ...proof[0], revision: 0 }],
    [{ ...proof[0], revision: 9007199254740992 }],
    Array.from({ length: 101 }, () => proof[0]),
  ];
  let n = 0;
  for (const publications of invalidPublications) {
    await completed(++n);
    await db.query(
      "UPDATE leaderboard_ingestion.outbox SET completion=jsonb_set(completion,'{publications}',$2::jsonb) WHERE event_key=$1",
      [event(n), JSON.stringify(publications)],
    );
    assert.equal(
      (await expiry.expireCompleted(request({ operationId: `synthetic-invalid-${n}` }), allow)).expiredCount,
      0,
    );
    assert.notEqual((await payloads(n)).envelope, null);
  }
  await completed(++n);
  await db.query(
    "UPDATE leaderboard_ingestion.outbox SET operation=jsonb_set(operation,'{operationKey}','\"malformed\"'),completion=jsonb_set(completion,'{operationKey}','\"malformed\"') WHERE event_key=$1",
    [event(n)],
  );
  assert.equal(
    (await expiry.expireCompleted(request({ operationId: "synthetic-invalid-key" }), allow)).expiredCount,
    0,
  );
  await completed(++n);
  await db.query(
    "UPDATE leaderboard_ingestion.observations SET observation=jsonb_set(observation,'{actorId}','\"SYNTHETIC_DIFFERENT\"') WHERE event_key=$1",
    [event(n)],
  );
  assert.equal(
    (await expiry.expireCompleted(request({ operationId: "synthetic-divergent-observation" }), allow)).expiredCount,
    0,
  );
  assert.notEqual((await payloads(n)).observation, null);
});

test("failure between the two payload updates rolls back the operation and both original payloads", async () => {
  await completed();
  const before = await payloads();
  const broken = new DeliveryPayloadExpiryStore({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          async query(sql, params) {
            const result = await tx.query(sql, params);
            if (sql.startsWith("UPDATE leaderboard_ingestion.inbox SET envelope=NULL"))
              throw new Error("synthetic-crash");
            return result;
          },
        }),
      ),
  });
  await assert.rejects(broken.expireCompleted(request(), allow), /synthetic-crash/);
  assert.deepEqual(await payloads(), before);
  assert.equal(await receiptCount(), 0);
  assert.equal((await expiry.expireCompleted(request(), allow)).expiredCount, 1);
});

test("revoked authorization after deletion rolls back before any expiry receipt commits", async () => {
  await completed();
  const before = await payloads();
  let authorized = true;
  const revoked = new DeliveryPayloadExpiryStore({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          async query(sql, params) {
            const result = await tx.query(sql, params);
            if (sql.startsWith("UPDATE leaderboard_ingestion.observations SET observation=NULL")) authorized = false;
            return result;
          },
        }),
      ),
  });
  await assert.rejects(
    revoked.expireCompleted(request(), async () => authorized),
    /delivery_expiry_not_authorized/,
  );
  assert.deepEqual(await payloads(), before);
  assert.equal(await receiptCount(), 0);
});

test("database guards reject unreceipted removal, incomplete expiry, receipt changes and payload resurrection", async () => {
  await completed();
  const original = await payloads();
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.inbox SET envelope=NULL"),
    /delivery_payload_receipt_required/,
  );
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.observations SET observation=NULL"),
    /delivery_payload_receipt_required/,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(`INSERT INTO leaderboard_ingestion.delivery_payload_expiry_operations
      (operation_id,repository_id,installation_id,completed_before,policy_version,operator_id,authorization_id,batch_limit,expired_count)
      VALUES ('synthetic-incomplete',2,1,'2026-02-02T00:00:00Z','synthetic-policy','synthetic-operator','synthetic-authorization',1,1)`);
      await tx.query(
        `INSERT INTO leaderboard_ingestion.delivery_payload_expiries
      (delivery_id,event_key,operation_id,repository_id,installation_id,subject_id) VALUES($1,$2,'synthetic-incomplete',2,1,'SYNTHETIC_ISSUE')`,
        [id(1), event(1)],
      );
      await tx.query("UPDATE leaderboard_ingestion.inbox SET envelope=NULL WHERE delivery_id=$1", [id(1)]);
    }),
    /incomplete_delivery_payload_expiry/,
  );
  assert.deepEqual(await payloads(), original);
  assert.equal(await receiptCount(), 0);
  await expiry.expireCompleted(request(), allow);
  for (const sql of [
    "UPDATE leaderboard_ingestion.inbox SET body_hash=repeat('b',64)",
    "UPDATE leaderboard_ingestion.inbox SET state='pending'",
    "UPDATE leaderboard_ingestion.inbox SET received_at=clock_timestamp()",
    "DELETE FROM leaderboard_ingestion.inbox",
    "DELETE FROM leaderboard_ingestion.observations",
    "UPDATE leaderboard_ingestion.observations SET normalization_version='other'",
  ])
    await assert.rejects(db.query(sql), /immutable_expired_delivery/);
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.inbox SET envelope=$1::jsonb", [JSON.stringify(original.envelope)]),
    /immutable_expired_delivery/,
  );
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.observations SET observation=$1::jsonb", [
      JSON.stringify(original.observation),
    ]),
    /immutable_expired_delivery/,
  );
  for (const sql of [
    "UPDATE leaderboard_ingestion.outbox SET state='pending'",
    "UPDATE leaderboard_ingestion.outbox SET completion=NULL",
    "DELETE FROM leaderboard_ingestion.outbox",
  ])
    await assert.rejects(db.query(sql), /immutable_expired_dispatch/);
  for (const table of ["delivery_payload_expiries", "delivery_payload_expiry_operations"])
    await assert.rejects(db.query(`DELETE FROM leaderboard_ingestion.${table}`), /immutable_delivery_expiry_receipt/);
  await assert.rejects(
    engine.exec(await readFile(new URL("../sql/006_delivery_payload_expiry.down.sql", import.meta.url), "utf8")),
    /delivery_payload_expiry_irreversible/,
  );
  assert.deepEqual(await payloads(), { envelope: null, observation: null });
});

test("expired object replay is explicit and cannot publish a partial replacement; unrelated history and prior snapshots survive", async () => {
  await completed(1);
  await completed(2, { subjectId: "SYNTHETIC_OTHER" });
  const snapshots = new SnapshotStore(db);
  const original = await snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-v1", "0");
  await expiry.expireCompleted(request({ batchLimit: 1 }), allow);
  await completed(3);
  const replay = await inbox.replayObjectState(2, "SYNTHETIC_ISSUE");
  assert.deepEqual(replay, {
    coverage: "unavailable_expired_observations",
    sourceObservationCount: 1,
    expiredObservationCount: 1,
    reason: "delivery_payload_expired",
    expiryOperationIds: [request().operationId],
    replay: null,
  });
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_ISSUE", "synthetic-v1", "1"),
    /snapshot_replay_unavailable_payload_expired/,
  );
  assert.deepEqual(await snapshots.latest(2, "SYNTHETIC_ISSUE"), {
    revision: original.revision,
    publishedAt: original.publishedAt,
    snapshot: original.snapshot,
  });
  assert.deepEqual(await snapshots.byId(original.snapshot.snapshotId), original.snapshot);
  assert.equal((await inbox.replayObjectState(2, "SYNTHETIC_OTHER")).coverage, "retained_observations_only");
  assert.equal(
    (await new OperatorInbox(db).read(2, async () => ({ policyVersion: "synthetic-v1", revision: "synthetic-grant" })))
      .counts.completed,
    3,
  );
});

test("reopening the actual database preserves missing payloads, operation readback and acknowledgment identity", async () => {
  await completed();
  const receipt = await expiry.expireCompleted(request(), allow);
  await engine.close();
  engine = new PGlite(join(directory, "postgres"));
  const restarted = new DeliveryPayloadExpiryStore(db);
  assert.deepEqual(await restarted.expireCompleted(request(), allow), receipt);
  assert.deepEqual(await payloads(), { envelope: null, observation: null });
  assert.equal(await new InboxStore(db).insert(delivery()), "duplicate");
  assert.equal(await new InboxStore(db).insert({ ...delivery(), bodyHash: "b".repeat(64) }), "conflict");
  assert.equal((await new InboxStore(db).replayObjectState(2, "SYNTHETIC_ISSUE")).reason, "delivery_payload_expired");
});
