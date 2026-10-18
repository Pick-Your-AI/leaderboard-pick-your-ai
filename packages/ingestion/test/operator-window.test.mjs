import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { InboxStore, OperatorInbox } from "../dist/index.js";

// One shared, disposable database keeps this focused batch memory-bounded.
let engine, db, ops;
before(async () => {
  engine = new PGlite();
  for (const file of [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "006_delivery_payload_expiry",
  ])
    await engine.exec(await readFile(new URL(`../sql/${file}.up.sql`, import.meta.url), "utf8"));
  db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  };
  ops = new OperatorInbox(db);
});
after(async () => engine?.close());
beforeEach(async () => {
  await db.query("TRUNCATE leaderboard_ingestion.inbox, leaderboard_ingestion.repository_access CASCADE");
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(9,1,'public'),(8,1,'public')",
  );
});
const allow = async () => ({ policyVersion: "reviewed-1", revision: "scope-1" });
const scope = {
  repositoryId: 9,
  receivedSince: "2026-10-01T00:00:00.000Z",
  receivedUntil: "2026-10-02T00:00:00.000Z",
  limit: 10,
  policyVersion: "reviewed-1",
};
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function insert(n, overrides = {}) {
  const { receivedAt = scope.receivedSince, state = "quarantined", repositoryId = 9, installationId = 1 } = overrides;
  await db.query(
    `INSERT INTO leaderboard_ingestion.inbox(delivery_id,body_hash,envelope,received_at,state,attempts,reason_code)
     VALUES($1,$2,$3::jsonb,$4,$5,3,'source_unavailable')`,
    [
      id(n),
      "a".repeat(64),
      JSON.stringify({
        version: "github-delivery/v1",
        deliveryId: id(n),
        event: "issues",
        action: "opened",
        repositoryId,
        installationId,
        subjectId: `SYNTHETIC_${n}`,
        sourceUrl: "private-source-must-not-escape",
        actorId: null,
        occurredAt: null,
      }),
      receivedAt,
      state,
    ],
  );
}
const request = (preview) => ({
  ...preview.window,
  expectedRevision: preview.revision,
  operatorId: "7",
  reason: "source_recovered",
});
async function noWrites() {
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.replay_receipts")).rows[0].count,
    0,
  );
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.inbox WHERE state='pending'")).rows[0]
      .count,
    0,
  );
}

test("window admission requires explicit valid UTC bounds, policy and a delivery cap before database access", async () => {
  const unavailable = new OperatorInbox({
    transaction: () => {
      throw Error("database must not be reached");
    },
  });
  for (const invalid of [
    { repositoryId: 0 },
    { repositoryId: "9" },
    { receivedSince: undefined },
    { receivedUntil: undefined },
    { receivedSince: "2026-02-30T00:00:00.000Z" },
    { receivedSince: "2026-10-01" },
    { receivedUntil: scope.receivedSince },
    { receivedUntil: "2026-09-30T00:00:00.000Z" },
    { receivedUntil: "2026-11-02T00:00:00.000Z" },
    { limit: undefined },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.1 },
    { limit: "10" },
    { policyVersion: "" },
    { policyVersion: undefined },
  ]) {
    await assert.rejects(unavailable.previewReplayWindow({ ...scope, ...invalid }, allow), /invalid_/);
    await assert.rejects(
      unavailable.replayWindow(
        { ...scope, expectedRevision: "a".repeat(64), operatorId: "7", reason: "operator_reviewed", ...invalid },
        allow,
      ),
      /invalid_/,
    );
  }
  for (const invalid of [
    { expectedRevision: undefined },
    { expectedRevision: "not-a-preview" },
    { operatorId: "" },
    { reason: "automatic" },
  ])
    await assert.rejects(
      unavailable.replayWindow(
        { ...scope, expectedRevision: "a".repeat(64), operatorId: "7", reason: "operator_reviewed", ...invalid },
        allow,
      ),
      /invalid_replay_request/,
    );
});

test("preview includes only current-source quarantine inside half-open receive boundaries in stable order", async () => {
  await insert(2);
  await insert(1);
  await insert(3, { receivedAt: "2026-10-01T23:59:59.999Z" });
  await insert(4, { receivedAt: scope.receivedUntil });
  await insert(5, { receivedAt: "2026-09-30T23:59:59.999Z" });
  await insert(6, { repositoryId: 8 });
  await insert(7, { installationId: 2 });
  await insert(8, { state: "done" });
  const preview = await ops.previewReplayWindow(scope, allow);
  assert.deepEqual(
    preview.deliveries.map((row) => row.deliveryId),
    [id(1), id(2), id(3)],
  );
  assert.deepEqual(await ops.previewReplayWindow(scope, allow), preview);
  assert.equal(JSON.stringify(preview).includes("private-source"), false);
  assert.equal(JSON.stringify(preview).includes("body_hash"), false);
  assert.match(preview.meaning, /receive-time/);
  await noWrites();
  const empty = await ops.previewReplayWindow({ ...scope, repositoryId: 10 }, allow).catch((error) => error.message);
  assert.equal(empty, "operation_source_unavailable");
});

test("overflow refuses the entire window and the explicit 50-delivery cap is supported", async () => {
  for (let i = 1; i <= 51; i++) await insert(i);
  await assert.rejects(ops.previewReplayWindow({ ...scope, limit: 50 }, allow), /replay_window_limit_exceeded/);
  await assert.rejects(
    ops.replayWindow(
      { ...scope, limit: 50, expectedRevision: "a".repeat(64), operatorId: "7", reason: "operator_reviewed" },
      allow,
    ),
    /replay_window_limit_exceeded/,
  );
  await noWrites();
  await db.query("UPDATE leaderboard_ingestion.inbox SET state='done' WHERE delivery_id=$1", [id(51)]);
  const preview = await ops.previewReplayWindow(
    { ...scope, limit: 50, receivedUntil: "2026-11-01T00:00:00.000Z" },
    allow,
  );
  const receipt = await ops.replayWindow(request(preview), allow);
  assert.equal(receipt.receipts.length, 50);
  assert.equal((await ops.read(9, allow)).counts.pending, 50);
});

test("preview is bound to membership, bounds, cap and each quarantine attempt cycle", async () => {
  await insert(1);
  let preview = await ops.previewReplayWindow(scope, allow);
  for (const change of [{ limit: 9 }, { receivedUntil: "2026-10-03T00:00:00.000Z" }, { repositoryId: 8 }])
    await assert.rejects(ops.replayWindow({ ...request(preview), ...change }, allow), /replay_selection_changed/);
  await insert(2);
  await assert.rejects(ops.replayWindow(request(preview), allow), /replay_selection_changed/);
  preview = await ops.previewReplayWindow(scope, allow);
  await db.query(
    "UPDATE leaderboard_ingestion.inbox SET available_at=available_at+interval '1 second' WHERE delivery_id=$1",
    [id(1)],
  );
  await assert.rejects(ops.replayWindow(request(preview), allow), /replay_selection_changed/);
  preview = await ops.previewReplayWindow(scope, allow);
  await db.query(
    "UPDATE leaderboard_ingestion.inbox SET received_at=received_at+interval '1 second' WHERE delivery_id=$1",
    [id(1)],
  );
  await assert.rejects(ops.replayWindow(request(preview), allow), /replay_selection_changed/);
  await noWrites();
});

test("authorization, policy, source generation and installation changes fail closed", async () => {
  await insert(1);
  const preview = await ops.previewReplayWindow(scope, allow);
  for (const authorize of [
    async () => null,
    async () => {
      throw Error("denied");
    },
    async () => ({ policyVersion: "reviewed-2", revision: "scope-1" }),
  ]) {
    await assert.rejects(ops.previewReplayWindow(scope, authorize));
    await assert.rejects(ops.replayWindow(request(preview), authorize));
  }
  await assert.rejects(
    ops.replayWindow(request(preview), async () => ({ policyVersion: "reviewed-1", revision: "scope-2" })),
    /replay_selection_changed/,
  );
  await db.query("UPDATE leaderboard_ingestion.repository_access SET generation=2 WHERE repository_id=9");
  await assert.rejects(ops.replayWindow(request(preview), allow), /replay_selection_changed/);
  await db.query(
    "UPDATE leaderboard_ingestion.repository_access SET generation=1,installation_id=2 WHERE repository_id=9",
  );
  await assert.rejects(ops.replayWindow(request(preview), allow), /replay_selection_changed/);
  await db.query("UPDATE leaderboard_ingestion.repository_access SET state='unavailable' WHERE repository_id=9");
  await assert.rejects(ops.replayWindow(request(preview), allow), /operation_source_unavailable/);
  await noWrites();
});

test("authority changes during preview, before writes and after writes roll back the full batch", async () => {
  await insert(1);
  await insert(2);
  const preview = await ops.previewReplayWindow(scope, allow);
  for (const changeOn of [2, 3]) {
    // Deliberately reuse the authority object: authorization must snapshot its fields.
    const a = await allow();
    let calls = 0;
    const authorize = async () => {
      if (++calls === changeOn) a.revision = "revoked";
      return a;
    };
    await assert.rejects(ops.replayWindow(request(preview), authorize), /operation_authority_changed/);
    await noWrites();
  }
  let calls = 0;
  await assert.rejects(
    ops.previewReplayWindow(scope, async () => {
      if (++calls > 1) throw Error("revoked");
      return allow();
    }),
    /revoked/,
  );
});

test("a failed later receipt insert rolls back earlier receipts and queue transitions", async () => {
  await insert(1);
  await insert(2);
  const preview = await ops.previewReplayWindow(scope, allow);
  let writes = 0;
  const failing = new OperatorInbox({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO leaderboard_ingestion.replay_receipts") && ++writes === 2)
              throw Error("synthetic receipt failure");
            return tx.query(sql, params);
          },
        }),
      ),
  });
  await assert.rejects(failing.replayWindow(request(preview), allow), /synthetic receipt failure/);
  assert.equal(writes, 2);
  await noWrites();
});

test("recovery retains original evidence/history and receipts, then completes once without duplicate observations", async () => {
  const store = new InboxStore(db, 3);
  for (let n = 1; n <= 2; n++) {
    await insert(n, { state: "pending" });
    await db.query("UPDATE leaderboard_ingestion.inbox SET attempts=0 WHERE delivery_id=$1", [id(n)]);
    const lease = await store.claim();
    assert.equal(await store.fail(lease, "source_unavailable", true), true);
  }
  const original = (
    await db.query(
      "SELECT delivery_id,body_hash,envelope,received_at FROM leaderboard_ingestion.inbox ORDER BY delivery_id",
    )
  ).rows;
  const history = (await db.query("SELECT * FROM leaderboard_ingestion.attempt_history ORDER BY delivery_id")).rows;
  const preview = await ops.previewReplayWindow(scope, allow);
  const receipt = await ops.replayWindow(request(preview), allow);
  assert.equal(receipt.resultingPublicationRevision, null);
  assert.match(receipt.queuedRevision, /^[a-f0-9]{64}$/);
  await assert.rejects(ops.replayWindow(request(preview), allow), /replay_selection_changed/);
  const audits = (
    await db.query(
      "SELECT prior_attempts,prior_reason_code,audit FROM leaderboard_ingestion.replay_receipts ORDER BY delivery_id",
    )
  ).rows;
  assert.equal(audits.length, 2);
  for (const row of audits) {
    assert.equal(row.prior_attempts, 1);
    assert.equal(row.prior_reason_code, "source_unavailable");
    assert.equal(row.audit.operatorId, "7");
    assert.equal(row.audit.policyVersion, scope.policyVersion);
    assert.equal(row.audit.batchId, receipt.id);
    assert.equal(row.audit.batchSize, 2);
    assert.equal(row.audit.selectionRevision, preview.revision);
    assert.equal(row.audit.resultingRevision, null);
    assert.deepEqual(row.audit.window, scope);
  }
  assert.deepEqual(
    (await db.query("SELECT * FROM leaderboard_ingestion.attempt_history ORDER BY delivery_id")).rows,
    history,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT delivery_id,body_hash,envelope,received_at FROM leaderboard_ingestion.inbox ORDER BY delivery_id",
      )
    ).rows,
    original,
  );
  const restarted = new InboxStore(db, 3);
  for (let n = 1; n <= 2; n++) {
    const lease = await restarted.claim();
    assert.equal(lease.attempt, 1);
    assert.equal(await restarted.complete(lease), true);
    assert.equal(await restarted.complete(lease), false);
  }
  assert.equal(await restarted.claim(), null);
  for (const table of ["observations", "outbox"])
    assert.equal(
      (await db.query(`SELECT count(*)::integer AS count FROM leaderboard_ingestion.${table}`)).rows[0].count,
      2,
    );
  const diagnostics = await new OperatorInbox(db).read(9, allow);
  assert.equal(diagnostics.counts.completed, 2);
  assert.equal(diagnostics.receipts[0].batch.id, receipt.id);
  assert.deepEqual(diagnostics.receipts[0].batch.window, scope);
  assert.equal(diagnostics.receipts[0].resultingPublicationRevision, null);
  assert.equal(JSON.stringify(diagnostics).includes("private-source"), false);
  const empty = await ops.previewReplayWindow(scope, allow);
  assert.equal(empty.deliveries.length, 0);
  await assert.rejects(ops.replayWindow(request(empty), allow), /replay_selection_empty/);
});

test("untrusted extra fields in retained batch audit never escape protected diagnostics", async () => {
  await insert(1);
  const preview = await ops.previewReplayWindow(scope, allow);
  await ops.replayWindow(request(preview), allow);
  await db.query(
    `UPDATE leaderboard_ingestion.replay_receipts SET audit=jsonb_set(audit,'{window,extra}', '"private-source-must-not-escape"')`,
  );
  assert.equal(JSON.stringify(await ops.read(9, allow)).includes("private-source"), false);
  const original = (await db.query("SELECT audit FROM leaderboard_ingestion.replay_receipts")).rows[0].audit;
  for (const field of ["batchId", "selectionRevision"]) {
    await db.query("UPDATE leaderboard_ingestion.replay_receipts SET audit=$1::jsonb", [
      JSON.stringify({ ...original, [field]: [original[field]] }),
    ]);
    assert.equal((await ops.read(9, allow)).receipts[0].batch, null);
  }
  await db.query("UPDATE leaderboard_ingestion.replay_receipts SET audit=$1::jsonb", [JSON.stringify(original)]);
  await db.query(
    `UPDATE leaderboard_ingestion.replay_receipts SET audit=jsonb_set(audit,'{window,receivedSince}', '"private-source-must-not-escape"')`,
  );
  assert.equal((await ops.read(9, allow)).receipts[0].batch, null);
});
