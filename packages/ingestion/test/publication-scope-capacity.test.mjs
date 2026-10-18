import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { maximalPublicationScopeCases } from "../../../tests/fixtures/publication-scope-capacity.mjs";
import {
  CollectionStore,
  DeliveryPayloadExpiryStore,
  InboxStore,
  OutboxStore,
  dispatchPublicationScopeKeyLimit,
  parseDispatchPublications,
  postgresDatabase,
} from "../dist/index.js";

const capacityUp = await readFile(
  new URL("../sql/008_dispatch_publication_scope_capacity.up.sql", import.meta.url),
  "utf8",
);
const capacityDown = await readFile(
  new URL("../sql/008_dispatch_publication_scope_capacity.down.sql", import.meta.url),
  "utf8",
);
const external = process.env.INGESTION_TEST_DATABASE_URL;
const independentConnections = external ? false : "PGlite cannot open independent PostgreSQL connections";
let engine, db, administration, directory, databaseUrl, originalDefinition;
const migrate = (sql) => (external ? engine.query(sql) : engine.exec(sql));
const bindDatabase = () => {
  db = external
    ? postgresDatabase(engine)
    : {
        query: (sql, parameters) => engine.query(sql, parameters),
        transaction: (work) =>
          engine.transaction((tx) => work({ query: (sql, parameters) => tx.query(sql, parameters) })),
      };
};
before(async () => {
  if (external) {
    const url = new URL(external);
    if (!/^\/leaderboard_ingestion(?:_[a-z0-9]+)*_test$/.test(url.pathname))
      throw new Error("Capacity tests require a disposable ingestion test database");
    const name = url.pathname.slice(1, -5) + "_scope_capacity_test";
    assert.ok(name.length <= 63, "the dedicated database name must not be truncated");
    administration = new Pool({ connectionString: url.href });
    const found = await administration.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    assert.equal(found.rows.length, 0, "capacity test database exists; refusing to overwrite");
    await administration.query(`CREATE DATABASE "${name}"`);
    url.pathname = "/" + name;
    databaseUrl = url.href;
    engine = new Pool({ connectionString: databaseUrl });
  } else {
    directory = await mkdtemp(join(tmpdir(), "leaderboard-scope-capacity-"));
    engine = new PGlite(join(directory, "postgres"));
  }
  bindDatabase();
  for (const name of [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "006_delivery_payload_expiry",
    "007_operator_replay_results",
  ])
    await migrate(await readFile(new URL(`../sql/${name}.up.sql`, import.meta.url), "utf8"));
  originalDefinition = await definition();
});
after(async () => {
  await (external ? engine?.end() : engine?.close());
  await administration?.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  // Only this newly created disposable engine/database contains these fixtures.
  await db.query(
    "TRUNCATE leaderboard_ingestion.inbox,leaderboard_ingestion.repository_access,leaderboard_ingestion.delivery_payload_expiry_operations CASCADE",
  );
  await migrate(capacityDown);
  await new CollectionStore(db).verifyPublic(2, 1, null);
});
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const event = (n) => `github:delivery:${id(n)}`;
const operationBinding = {
  configurationHash: "a".repeat(64),
  configurationVersion: "synthetic-v1",
  configurationRevision: 0,
  normalizationVersion: "issues-creation-dispatch.v1",
  policyVersion: "synthetic-v1",
  dataMode: "synthetic",
  cutoff: "2026-02-01T00:00:00.000Z",
};
const publication = (scopeKey) => [{ scopeKey, snapshotId: "b".repeat(64), revision: 1 }];
async function lease(n) {
  const inbox = new InboxStore(db);
  await inbox.insert({
    deliveryId: id(n),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: id(n),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: `SYNTHETIC_ISSUE_${n}`,
      actorId: null,
      occurredAt: "2026-01-01T00:00:00.000Z",
      sourceUrl: `https://github.com/synthetic-org/synthetic-repo/issues/${n}`,
    },
  });
  assert.equal(await inbox.complete(await inbox.claim()), true);
  const result = await new OutboxStore(db).claim(operationBinding);
  assert.equal(result.eventKey, event(n));
  return result;
}
async function complete(n, references) {
  const current = await lease(n);
  assert.equal(await new OutboxStore(db).complete(current, references, async () => {}), true);
  await db.query(
    "UPDATE leaderboard_ingestion.attempt_history SET finished_at='2026-02-01T00:00:00Z' WHERE delivery_id=$1 AND outcome='done'",
    [id(n)],
  );
  await db.query(
    "UPDATE leaderboard_ingestion.outbox_attempts SET finished_at='2026-02-01T00:00:00Z' WHERE event_key=$1 AND outcome='done'",
    [event(n)],
  );
  return current;
}
async function definition() {
  return (
    await db.query(
      "SELECT pg_get_functiondef('leaderboard_ingestion.delivery_expiry_completion_valid(jsonb,jsonb)'::regprocedure) AS value",
    )
  ).rows[0].value;
}
async function retainedRows() {
  const rows = {};
  for (const [table, identity] of [
    ["inbox", "delivery_id"],
    ["observations", "event_key"],
    ["attempt_history", "lease_token"],
    ["outbox", "event_key"],
    ["outbox_attempts", "lease_token"],
    ["replay_receipts", "receipt_id"],
    ["replay_processing_results", "receipt_id"],
  ])
    rows[table] = (await db.query(`SELECT * FROM leaderboard_ingestion.${table} ORDER BY ${identity}`)).rows;
  return rows;
}
async function recognized(operation, completion) {
  return (
    await db.query("SELECT leaderboard_ingestion.delivery_expiry_completion_valid($1::jsonb,$2::jsonb) AS valid", [
      JSON.stringify(operation),
      JSON.stringify(completion),
    ])
  ).rows[0].valid;
}
async function retainedRecognition() {
  return (
    await db.query(
      "SELECT event_key,completion,leaderboard_ingestion.delivery_expiry_completion_valid(operation,completion) AS valid FROM leaderboard_ingestion.outbox ORDER BY event_key",
    )
  ).rows;
}

test("the versioned upgrade recognizes maximal retained canonical scopes without rewriting any receipt", async () => {
  const examples = maximalPublicationScopeCases();
  for (const [index, example] of examples.entries()) await complete(index + 1, publication(example.scopeKey));
  const before = await retainedRows();
  assert.deepEqual(
    (await retainedRecognition()).map((row) => row.valid),
    [true, false, false],
    "the actual legacy function rejects both admitted large Project scopes",
  );
  await migrate(capacityUp);
  assert.deepEqual(await retainedRows(), before);
  const after = await retainedRecognition();
  assert.ok(after.every((row) => row.valid === true));
  for (const [index, row] of after.entries())
    assert.deepEqual(
      parseDispatchPublications(row.completion, row.completion.operationKey),
      publication(examples[index].scopeKey),
    );
  const request = {
    operationId: "synthetic-capacity-expiry",
    repositoryId: 2,
    installationId: 1,
    completedBefore: "2026-02-02T00:00:00.000Z",
    policyVersion: "synthetic-retention-v1",
    operatorId: "SYNTHETIC_OPERATOR",
    authorizationId: "synthetic-authorization",
    batchLimit: 10,
  };
  const receipt = await new DeliveryPayloadExpiryStore(db).expireCompleted(request, async () => true);
  assert.equal(receipt.expiredCount, 3);
  assert.deepEqual(await new DeliveryPayloadExpiryStore(db).expireCompleted(request, async () => true), receipt);
  const expired = await retainedRows();
  for (const row of before.inbox) row.envelope = null;
  for (const row of before.observations) row.observation = null;
  assert.deepEqual(
    expired,
    before,
    "only the authorized two payload copies change; full completion keys and histories survive",
  );
});

test("SQL completion recognition retains the writer's inclusive key and bounded receipt fields", async () => {
  await migrate(capacityUp);
  assert.equal(dispatchPublicationScopeKeyLimit, 16_384);
  const operation = { operationKey: "a".repeat(64) };
  const completion = (publications) => ({ operationKey: operation.operationKey, publications });
  const atLimit = publication("S".repeat(16_384));
  await complete(1, atLimit);
  assert.equal(await recognized(operation, completion(atLimit)), true);
  assert.deepEqual(parseDispatchPublications(completion(atLimit), operation.operationKey), atLimit);
  const hundred = Array.from({ length: 100 }, (_, index) => ({ ...atLimit[0], scopeKey: `${index}:synthetic-scope` }));
  assert.equal(await recognized(operation, completion(hundred)), true);
  const invalid = [
    publication("S".repeat(16_385)),
    [{ ...atLimit[0], scopeKey: null }],
    [{ ...atLimit[0], snapshotId: "B".repeat(64) }],
    [{ ...atLimit[0], revision: 0 }],
    [{ ...atLimit[0], revision: 1.5 }],
    [{ ...atLimit[0], revision: "1" }],
    [{ ...atLimit[0], revision: 9007199254740992 }],
    [...hundred, hundred[0]],
    [],
    null,
  ];
  for (const references of invalid) {
    assert.equal(await recognized(operation, completion(references)), false);
    assert.equal(parseDispatchPublications(completion(references), operation.operationKey), null);
  }
  for (const value of ["malformed", "f".repeat(64), 1, null])
    assert.equal(await recognized(operation, { ...completion(atLimit), operationKey: value }), false);
  assert.equal(
    await recognized({ operationKey: "malformed" }, { operationKey: "malformed", publications: atLimit }),
    false,
  );
  const unavailable = new OutboxStore({
    transaction() {
      assert.fail("overflow must precede SQL or confirmation");
    },
  });
  await assert.rejects(
    unavailable.complete({}, publication("S".repeat(16_385)), async () => assert.fail("overflow confirmation")),
    /invalid_dispatch_publication/,
  );
});

test("unused capacity downgrade restores the exact legacy function and can be reapplied", async () => {
  await complete(1, publication("synthetic-short-scope"));
  const before = await retainedRows();
  await migrate(capacityUp);
  const upgraded = await definition();
  await migrate(capacityUp);
  assert.equal(await definition(), upgraded);
  await migrate(capacityDown);
  assert.equal(await definition(), originalDefinition);
  assert.deepEqual(await retainedRows(), before);
  const example = maximalPublicationScopeCases()[2];
  const operation = { operationKey: "a".repeat(64) },
    completion = { operationKey: operation.operationKey, publications: publication(example.scopeKey) };
  assert.equal(await recognized(operation, completion), false);
  await migrate(capacityUp);
  assert.equal(await recognized(operation, completion), true);
  assert.deepEqual(await retainedRows(), before);
});

test("capacity downgrade refuses retained long references without changing upgraded recognition", async () => {
  await migrate(capacityUp);
  await complete(1, publication(maximalPublicationScopeCases()[2].scopeKey));
  const before = await retainedRows(),
    upgraded = await definition();
  await assert.rejects(migrate(capacityDown), /publication_scope_capacity_in_use/);
  assert.equal(await definition(), upgraded);
  assert.deepEqual(await retainedRows(), before);
  assert.equal((await retainedRecognition())[0].valid, true);
});

test("capacity downgrade rejects inherited non-read-committed isolation before changing the function", async () => {
  await migrate(capacityUp);
  const upgraded = await definition();
  for (const isolation of ["READ UNCOMMITTED", "REPEATABLE READ", "SERIALIZABLE"])
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        await tx.query("SELECT count(*) FROM leaderboard_ingestion.outbox");
        await tx.query(capacityDown);
      }),
      /publication_scope_capacity_requires_read_committed/,
    );
  assert.equal(await definition(), upgraded);
});

test("the actual reopened database retains upgraded recognition and complete canonical keys", async () => {
  await migrate(capacityUp);
  await complete(1, publication(maximalPublicationScopeCases()[2].scopeKey));
  const before = await retainedRows(),
    upgraded = await definition();
  await (external ? engine.end() : engine.close());
  engine = external ? new Pool({ connectionString: databaseUrl }) : new PGlite(join(directory, "postgres"));
  bindDatabase();
  assert.deepEqual(await retainedRows(), before);
  assert.equal(await definition(), upgraded);
  assert.equal((await retainedRecognition())[0].valid, true);
});

for (const stage of ["confirmation", "commit"])
  test(
    `PostgreSQL capacity downgrade refuses a long-scope worker awaiting ${stage} before changing recognition`,
    { skip: independentConnections, timeout: 15_000 },
    async () => {
      await migrate(capacityUp);
      const current = await lease(1),
        references = publication(maximalPublicationScopeCases()[2].scopeKey),
        upgraded = await definition();
      let entered, release;
      const atBarrier = new Promise((resolve) => {
        entered = resolve;
      });
      const mayFinish = new Promise((resolve) => {
        release = resolve;
      });
      const pause = async (tx) => {
        const row = (
          await tx.query(
            "SELECT pg_backend_pid() AS pid,state,completion FROM leaderboard_ingestion.outbox WHERE event_key=$1",
            [current.eventKey],
          )
        ).rows[0];
        assert.equal(row.state, stage === "confirmation" ? "leased" : "done");
        assert.deepEqual(row.completion?.publications ?? null, stage === "confirmation" ? null : references);
        entered(row.pid);
        await mayFinish;
      };
      const paused =
        stage === "confirmation"
          ? new OutboxStore(db)
          : new OutboxStore({
              ...db,
              transaction: (work) =>
                db.transaction(async (tx) => {
                  const value = await work(tx);
                  await pause(tx);
                  return value;
                }),
            });
      const connection = await engine.connect();
      const completing = paused.complete(current, references, stage === "confirmation" ? pause : async () => {});
      try {
        const workerPid = await Promise.race([
          atBarrier,
          completing.then(() => assert.fail("completion escaped its selected barrier")),
        ]);
        const locks = (
          await engine.query(
            "SELECT mode FROM pg_catalog.pg_locks WHERE pid=$1 AND relation='leaderboard_ingestion.outbox'::regclass AND granted",
            [workerPid],
          )
        ).rows.map((row) => row.mode);
        assert.ok(locks.includes("RowShareLock"), "the persisted lease is actually locked before confirmation");
        assert.equal(
          locks.includes("RowExclusiveLock"),
          stage === "commit",
          "the selected barrier distinguishes prewrite from postwrite",
        );
        await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await connection.query("SET LOCAL statement_timeout='5s'");
        await assert.rejects(
          connection.query(capacityDown),
          (error) => error.code === "55P03",
          "rollback must fail on active access before the worker is released, without waiting for a lock upgrade",
        );
        await connection.query("ROLLBACK");
        assert.equal(await definition(), upgraded);
        release();
        assert.equal(await completing, true);
        await assert.rejects(migrate(capacityDown), /publication_scope_capacity_in_use/);
      } finally {
        // Release any unexpectedly admitted downgrade before allowing the
        // worker's lock upgrade, so a regression fails without a deadlock.
        try {
          await connection.query("ROLLBACK");
        } finally {
          connection.release();
          release();
          await completing.catch(() => {});
        }
      }
      assert.deepEqual((await retainedRecognition())[0].completion.publications, references);
      assert.equal(await definition(), upgraded);
      assert.equal((await retainedRecognition())[0].valid, true);
    },
  );

for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"])
  test(
    `a stale PostgreSQL ${isolation} capacity downgrade cannot miss a newly retained long reference`,
    { skip: independentConnections, timeout: 15_000 },
    async () => {
      await migrate(capacityUp);
      const connection = await engine.connect(),
        upgraded = await definition();
      try {
        await connection.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        assert.equal(
          (await connection.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.outbox")).rows[0].count,
          0,
        );
        await complete(1, publication(maximalPublicationScopeCases()[2].scopeKey));
        assert.equal(
          (await connection.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.outbox")).rows[0].count,
          0,
          "the inherited snapshot demonstrably predates completion",
        );
        await assert.rejects(connection.query(capacityDown), /publication_scope_capacity_requires_read_committed/);
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
      assert.equal(await definition(), upgraded);
      assert.equal((await retainedRecognition())[0].valid, true);
    },
  );
