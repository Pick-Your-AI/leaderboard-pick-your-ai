import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { InboxStore, OutboxStore, OperatorInbox } from "../dist/index.js";

let engine, db, inbox, outbox, operations;
const files = [
  "001_ingestion",
  "002_snapshots",
  "003_collection",
  "004_outbox_dispatch",
  "006_delivery_payload_expiry",
  "007_operator_replay_results",
  "008_dispatch_publication_scope_capacity",
];
const allow = async () => ({ policyVersion: "synthetic-replay-policy", revision: "grant-1" });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clock = () => new Date().toISOString();
const binding = () => ({
  configurationHash: "a".repeat(64),
  configurationVersion: "synthetic-config-1",
  configurationRevision: 0,
  normalizationVersion: "synthetic-dispatch-v1",
  policyVersion: "synthetic-publication-policy",
  dataMode: "synthetic",
  cutoff: clock(),
});
const publications = [
  { scopeKey: '["synthetic-org",null,null,null,null]', snapshotId: "b".repeat(64), revision: 2 },
  { scopeKey: '["synthetic-org","9",null,null,null]', snapshotId: "c".repeat(64), revision: 5 },
];
before(async () => {
  engine = new PGlite();
  for (const file of files)
    await engine.exec(await readFile(new URL(`../sql/${file}.up.sql`, import.meta.url), "utf8"));
  db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  };
  inbox = new InboxStore(db);
  outbox = new OutboxStore(db);
  operations = new OperatorInbox(db);
});
after(async () => engine?.close());
beforeEach(async () => {
  await db.query("TRUNCATE leaderboard_ingestion.inbox, leaderboard_ingestion.repository_access CASCADE");
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(9,1,'public'),(8,1,'public')",
  );
});
async function insert(n = 1) {
  await inbox.insert({
    deliveryId: id(n),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: id(n),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 9,
      subjectId: "SYNTHETIC_PRIVATE_SUBJECT",
      sourceUrl: "https://synthetic-private.invalid/raw-source",
      actorId: null,
      occurredAt: null,
    },
  });
  await db.query("UPDATE leaderboard_ingestion.inbox SET state='quarantined',attempts=3 WHERE delivery_id=$1", [id(n)]);
}
async function queue(n = 1) {
  const read = await operations.read(9, allow);
  const row = read.quarantined.find((entry) => entry.deliveryId === id(n));
  return operations.replay(
    { repositoryId: 9, deliveryId: id(n), expectedRevision: row.revision, reason: "source_recovered", operatorId: "7" },
    allow,
  );
}
const read = (receipt, options = {}, authorize = allow) =>
  new OperatorInbox(db, options).readReplayResult(9, receipt.id, authorize);
const counts = async () =>
  (
    await db.query(`SELECT
  (SELECT count(*)::integer FROM leaderboard_ingestion.replay_processing_results) AS results,
  (SELECT count(*)::integer FROM leaderboard_ingestion.observations) AS observations,
  (SELECT count(*)::integer FROM leaderboard_ingestion.outbox) AS notices`)
  ).rows[0];
async function processed(n = 1) {
  await insert(n);
  const receipt = await queue(n);
  assert.equal(await inbox.complete(await inbox.claim()), true);
  return receipt;
}
async function published(n = 1) {
  const receipt = await processed(n);
  const lease = await outbox.claim(binding());
  await outbox.freeze(lease, clock(), [{ repositoryId: 9, generation: "1" }]);
  assert.equal(await outbox.complete(lease, publications, async () => {}), true);
  return { receipt, lease };
}

test("queue, persisted intake lease and newly inserted notice have one durable causation record", async () => {
  await insert();
  const receipt = await queue();
  assert.equal((await read(receipt)).status, "queued");
  const lease = await inbox.claim();
  assert.equal((await read(receipt)).reason, "intake_in_progress");
  assert.equal(await inbox.complete({ ...lease, envelope: { private: "untrusted worker copy" } }), true);
  assert.equal(await inbox.complete(lease), false);
  const result = await read(receipt);
  assert.equal(result.status, "processed");
  assert.equal(result.reason, "awaiting_publication");
  assert.ok(result.processedAt >= result.queuedAt);
  assert.ok(result.processingDelaySeconds >= 0);
  assert.equal(result.publicationDelaySeconds, null);
  assert.deepEqual(result.publications, []);
  const retained = (await db.query("SELECT * FROM leaderboard_ingestion.replay_processing_results")).rows[0];
  assert.equal(retained.receipt_id, receipt.id);
  assert.equal(retained.delivery_id, lease.deliveryId);
  assert.equal(retained.lease_token, lease.token);
  assert.equal(retained.event_key, `github:delivery:${id(1)}`);
  assert.deepEqual(await counts(), { results: 1, observations: 1, notices: 1 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SUBJECT|raw-source|untrusted|configurationHash/);
});

test("an expired intake worker cannot bind or duplicate a recovered replay", async () => {
  await insert();
  const receipt = await queue();
  const lost = await inbox.claim();
  await db.query("UPDATE leaderboard_ingestion.inbox SET lease_until=clock_timestamp()-interval '1 second'");
  const recovered = await new InboxStore(db).claim();
  assert.notEqual(recovered.token, lost.token);
  assert.equal(await inbox.complete(lost), false);
  assert.deepEqual(await counts(), { results: 0, observations: 0, notices: 0 });
  assert.equal(await new InboxStore(db).complete(recovered), true);
  assert.equal((await read(receipt)).reason, "awaiting_publication");
  assert.equal(
    (await db.query("SELECT lease_token FROM leaderboard_ingestion.replay_processing_results")).rows[0].lease_token,
    recovered.token,
  );
  assert.deepEqual(await counts(), { results: 1, observations: 1, notices: 1 });
});

test("a failed causation insert rolls back the observation, notice and intake completion", async () => {
  await insert();
  const receipt = await queue();
  const lease = await inbox.claim();
  const failing = new InboxStore({
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query(sql, params) {
            if (sql.includes("INSERT INTO leaderboard_ingestion.replay_processing_results"))
              throw Error("synthetic storage failure");
            return tx.query(sql, params);
          },
        }),
      ),
  });
  await assert.rejects(failing.complete(lease), /storage failure/);
  assert.deepEqual(await counts(), { results: 0, observations: 0, notices: 0 });
  assert.equal((await read(receipt)).status, "processing");
  assert.equal(await inbox.complete(lease), true);
  assert.deepEqual(await counts(), { results: 1, observations: 1, notices: 1 });
});

test("an earlier notice is not relabelled as a new replay publication", async () => {
  await insert();
  const eventKey = `github:delivery:${id(1)}`;
  await db.query(
    "INSERT INTO leaderboard_ingestion.observations(event_key,delivery_id,normalization_version,observation) VALUES($1,$2,'delivery-observation/v1','{}')",
    [eventKey, id(1)],
  );
  await db.query("INSERT INTO leaderboard_ingestion.outbox(event_key) VALUES($1)", [eventKey]);
  const receipt = await queue();
  assert.equal(await inbox.complete(await inbox.claim()), true);
  let called = false;
  const result = await read(receipt, {
    verifyPublications: async () => {
      called = true;
      return () => true;
    },
  });
  assert.equal(result.status, "processed");
  assert.equal(result.reason, "no_new_publication_notice");
  assert.equal(called, false);
  assert.deepEqual(result.publications, []);
  assert.equal(
    (await db.query("SELECT event_key FROM leaderboard_ingestion.replay_processing_results")).rows[0].event_key,
    null,
  );
  assert.deepEqual(await counts(), { results: 1, observations: 1, notices: 1 });
});

test("later explicit replay supersedes a failed unprocessed queue binding", async () => {
  await insert();
  const first = await queue();
  assert.equal(await inbox.fail(await inbox.claim(), "source_unavailable", true), true);
  assert.equal((await read(first)).reason, "intake_failed");
  const second = await queue();
  assert.equal((await read(first)).status, "superseded");
  assert.equal((await read(second)).status, "queued");
  assert.equal(await inbox.complete(await inbox.claim()), true);
  assert.equal(
    (await db.query("SELECT receipt_id FROM leaderboard_ingestion.replay_processing_results")).rows[0].receipt_id,
    second.id,
  );
  assert.equal((await read(first)).status, "superseded");
});

test("the legacy low-level replay primitive clears an earlier protected queue binding", async () => {
  await insert();
  const first = await queue();
  await inbox.fail(await inbox.claim(), "source_unavailable", true);
  assert.equal(await inbox.replay(id(1), "synthetic-legacy-replay"), true);
  assert.equal((await read(first)).status, "superseded");
  assert.equal(await inbox.complete(await inbox.claim()), true);
  assert.deepEqual(await counts(), { results: 0, observations: 1, notices: 1 });
});

test("completed outbox metadata alone does not establish a published replay", async () => {
  const { receipt } = await published();
  const result = await read(receipt);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "publication_verification_unavailable");
  assert.deepEqual(result.publications, []);
  assert.equal(result.publicationCompletedAt, null);
});

test("a configured verifier receives exact multi-scope binding and is fenced after operator reauthentication", async () => {
  const { receipt, lease } = await published();
  let calls = 0,
    currentChecks = 0,
    authorizations = 0;
  const result = await read(
    receipt,
    {
      verifyPublications: async (tx, bound) => {
        calls++;
        assert.equal(typeof tx.query, "function");
        assert.equal(bound.receiptId, receipt.id);
        assert.equal(bound.operation.operationKey, lease.operation.operationKey);
        assert.equal(bound.repositoryId, 9);
        assert.equal(bound.installationId, "1");
        assert.deepEqual(bound.sourceGenerations, [{ repositoryId: 9, generation: "1" }]);
        assert.deepEqual(bound.publications, publications);
        bound.publications[0].snapshotId = "f".repeat(64);
        return () => {
          currentChecks++;
          assert.equal(authorizations, 2);
          return true;
        };
      },
    },
    async () => {
      authorizations++;
      return allow();
    },
  );
  assert.equal(calls, 1);
  assert.equal(currentChecks, 1);
  assert.equal(result.status, "published");
  assert.equal(result.replayPolicyVersion, "synthetic-replay-policy");
  assert.equal(result.publicationPolicyVersion, "synthetic-publication-policy");
  assert.deepEqual(result.publications, publications);
  assert.ok(result.publicationCompletedAt >= result.processedAt);
  assert.ok(result.publicationDelaySeconds >= result.processingDelaySeconds);
  result.publications[0].snapshotId = "e".repeat(64);
  const stored = (await db.query("SELECT completion FROM leaderboard_ingestion.outbox")).rows[0].completion;
  assert.deepEqual(stored.publications, publications);
});

test("publication failure, pending retry and a currently leased dispatch remain distinct", async () => {
  const receipt = await processed();
  const lease = await outbox.claim(binding());
  assert.equal((await read(receipt)).reason, "publication_in_progress");
  await outbox.fail(lease, "publication_unavailable", true);
  assert.equal((await read(receipt)).reason, "publication_failed");
  assert.equal(await outbox.replay(lease.eventKey, "synthetic-explicit-outbox-review"), true);
  assert.equal((await read(receipt)).reason, "awaiting_publication");
});

test("a verifier error is minimized while current operator revocation wins", async () => {
  const { receipt } = await published();
  const options = {
    verifyPublications: async () => {
      throw Error("SYNTHETIC_PRIVATE_EXCEPTION");
    },
  };
  const result = await read(receipt, options);
  assert.equal(result.reason, "publication_verification_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_EXCEPTION/);
  let calls = 0;
  await assert.rejects(
    read(receipt, options, async () => {
      if (++calls === 2) throw Error("revoked");
      return allow();
    }),
    /revoked/,
  );
});

test("a publisher authority change during final operator reauthentication withholds publication", async () => {
  const { receipt } = await published();
  let current = true,
    calls = 0;
  await assert.rejects(
    read(receipt, { verifyPublications: async () => () => current }, async () => {
      if (++calls === 2) current = false;
      return allow();
    }),
    /operation_publication_changed/,
  );
});

test("foreign receipts, source epochs and missing identities cannot authorize a result", async () => {
  const { receipt } = await published();
  await assert.rejects(operations.readReplayResult(8, receipt.id, allow), /operation_result_unavailable/);
  await assert.rejects(operations.readReplayResult(9, "missing-receipt", allow), /operation_result_unavailable/);
  for (const value of ["", "../receipt", "x".repeat(129), null, 1])
    await assert.rejects(operations.readReplayResult(9, value, allow), /invalid_replay_receipt/);
  await db.query("UPDATE leaderboard_ingestion.repository_access SET generation=2 WHERE repository_id=9");
  const result = await read(receipt, { verifyPublications: async () => () => true });
  assert.equal(result.reason, "source_generation_changed");
  assert.deepEqual(result.publications, []);
});

for (const [name, change] of [
  ["wrong operation identity", (value) => ({ ...value, operationKey: "d".repeat(64) })],
  ["duplicated scope", (value) => ({ ...value, publications: [value.publications[0], value.publications[0]] })],
  ["oversized publication set", (value) => ({ ...value, publications: Array(101).fill(value.publications[0]) })],
  [
    "arbitrary publication fields",
    (value) => ({ ...value, publications: [{ ...value.publications[0], rawPayload: "private" }] }),
  ],
  ["arbitrary completion fields", (value) => ({ ...value, rawPayload: "private" })],
])
  test(name + " cannot pass retained publication validation", async () => {
    const { receipt } = await published();
    const completion = (await db.query("SELECT completion FROM leaderboard_ingestion.outbox")).rows[0].completion;
    await db.query("UPDATE leaderboard_ingestion.outbox SET completion=$1::jsonb", [
      JSON.stringify(change(completion)),
    ]);
    let called = false;
    const result = await read(receipt, {
      verifyPublications: async () => {
        called = true;
        return () => true;
      },
    });
    assert.equal(result.reason, "result_binding_unavailable");
    assert.deepEqual(result.publications, []);
    assert.equal(called, false);
  });

test("immutable processing receipts reject changed causation and survive denied mutations", async () => {
  const receipt = await processed();
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.replay_processing_results SET event_key=NULL"),
    /immutable_replay_processing_result/,
  );
  await assert.rejects(
    db.query("DELETE FROM leaderboard_ingestion.replay_processing_results"),
    /immutable_replay_processing_result/,
  );
  await insert(2);
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.inbox SET operator_replay_receipt_id=$1 WHERE delivery_id=$2", [
      receipt.id,
      id(2),
    ]),
    /foreign key/,
  );
  assert.equal((await read(receipt)).reason, "awaiting_publication");
});

test("old unbound audit metadata never acquires a publication by timestamp inference", async () => {
  await insert();
  const audit = {
    repositoryId: 9,
    operatorId: "7",
    policyVersion: "legacy-policy",
    resultingRevision: "claimed-unverified",
  };
  await db.query(
    "INSERT INTO leaderboard_ingestion.replay_receipts(receipt_id,delivery_id,prior_attempts,audit) VALUES('synthetic-legacy',$1,3,$2::jsonb)",
    [id(1), JSON.stringify(audit)],
  );
  const result = await operations.readReplayResult(9, "synthetic-legacy", allow);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "legacy_unbound");
  assert.equal(result.replayPolicyVersion, "legacy-policy");
  assert.deepEqual(result.publications, []);
  assert.deepEqual((await db.query("SELECT audit FROM leaderboard_ingestion.replay_receipts")).rows[0].audit, audit);
});

for (const [name, factory] of [
  ["null factory", null],
  ["nonfunction factory", true],
  [
    "throwing factory",
    () => {
      throw new Error("synthetic-private-factory");
    },
  ],
  ["missing closure", () => undefined],
  ["promise factory", () => Promise.resolve(() => true)],
  ["rejected factory", () => Promise.reject(new Error("synthetic-private-factory-rejection"))],
  ["false closure", () => () => false],
  [
    "throwing closure",
    () => () => {
      throw new Error("synthetic-private-closure");
    },
  ],
  ["promise closure", () => () => Promise.resolve(true)],
  ["rejected closure", () => () => Promise.reject(new Error("synthetic-private-closure-rejection"))],
  ["truthy closure", () => () => "true"],
])
  test(`an optional native replay guard rejects a ${name} without leaking host errors`, async () => {
    await insert();
    const receipt = await queue();
    const before = (await db.query("SELECT receipt_id,audit::text FROM leaderboard_ingestion.replay_receipts")).rows;
    const original = await read(receipt);
    await assert.rejects(
      () => read(receipt, { replayReadGuard: factory }),
      (error) => {
        assert.match(error.message, /^operation_result_(?:unavailable|changed)$/);
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      await read(receipt),
      original,
      "an explicitly authorized standalone adapter keeps its retained reader",
    );
    assert.deepEqual(
      (await db.query("SELECT receipt_id,audit::text FROM leaderboard_ingestion.replay_receipts")).rows,
      before,
    );
  });

test("a native replay guard captures one immutable source scope per read", async () => {
  await insert();
  const receipt = await queue();
  let factories = 0;
  const guarded = new OperatorInbox(db, {
    replayReadGuard(scope) {
      factories++;
      assert.deepEqual(scope, { repositoryId: 9, installationId: "1", generation: "1" });
      assert.equal(Object.isFrozen(scope), true);
      return () => true;
    },
  });
  assert.equal((await guarded.readReplayResult(9, receipt.id, allow)).status, "queued");
  assert.equal(factories, 1);
});

test("a native replay guard fences the final awaited observer", async () => {
  await insert();
  const receipt = await queue();
  let current = true;
  const guarded = new OperatorInbox(db, { replayReadGuard: () => () => current });
  await assert.rejects(
    () =>
      guarded.readReplayResult(9, receipt.id, allow, async (_data, beforeSend) => {
        beforeSend();
        await Promise.resolve();
        current = false;
      }),
    /operation_result_changed/,
  );
});
