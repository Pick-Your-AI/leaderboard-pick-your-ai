import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import {
  CollectionStore,
  InboxStore,
  SnapshotStore,
  RepositoryRetirementStore,
  postgresDatabase,
} from "../dist/index.js";

const migrations = await Promise.all(
  [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "005_collection_retirement",
    "007_operator_replay_results",
  ].map((name) => readFile(new URL(`../sql/${name}.up.sql`, import.meta.url), "utf8")),
);
const retirementUp = await readFile(new URL("../sql/005_collection_retirement.up.sql", import.meta.url), "utf8");
const retirementDown = await readFile(new URL("../sql/005_collection_retirement.down.sql", import.meta.url), "utf8");
let engine, db, collection, retirement, administration;
const external = process.env.INGESTION_TEST_DATABASE_URL;
const independentConnections = external ? false : "PGlite cannot open independent PostgreSQL connections";
before(async () => {
  if (external) {
    const url = new URL(external);
    if (!/^\/leaderboard_ingestion(?:_[a-z0-9]+)*_test$/.test(url.pathname))
      throw new Error("Retirement tests require a disposable ingestion test database");
    administration = new Pool({ connectionString: url.href });
    const name = url.pathname.slice(1, -5) + "_retirement_test";
    // Dedicated database: never share the other suite's schema or remove existing data.
    const found = await administration.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    assert.equal(found.rows.length, 0, "retirement test database exists; refusing to overwrite");
    await administration.query(`CREATE DATABASE "${name}"`);
    url.pathname = "/" + name;
    engine = new Pool({ connectionString: url.href });
    db = postgresDatabase(engine);
  } else {
    engine = new PGlite();
    db = {
      query: (sql, params) => engine.query(sql, params),
      transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
    };
  }
  for (const sql of migrations) await (external ? engine.query(sql) : engine.exec(sql));
});
after(async () => {
  await (external ? engine?.end() : engine?.close());
  await administration?.end();
});
beforeEach(async () => {
  // All contents belong to this newly created disposable test database/engine.
  await db.query(
    "TRUNCATE leaderboard_ingestion.repository_access,leaderboard_ingestion.repository_retirements,leaderboard_ingestion.collection_erasure_batches,leaderboard_ingestion.source_facts,leaderboard_ingestion.inbox,leaderboard_ingestion.snapshots CASCADE",
  );
  collection = new CollectionStore(db);
  retirement = new RepositoryRetirementStore(db);
  await collection.verifyPublic(2, 1, null);
  await collection.verifyPublic(3, 1, null);
});
const approved = async () => true;
const request = (overrides = {}) => ({
  operationId: "synthetic-retirement",
  repositoryId: 2,
  expectedGeneration: "1",
  policyVersion: "synthetic-policy-v1",
  authorizationReceipt: "synthetic-private-approval",
  operatorId: "synthetic-operator",
  ...overrides,
});
const scan = (repositoryId = 2, runId = `synthetic-run-${repositoryId}`) => ({
  runId,
  repositoryId,
  family: "issues",
  mode: "backfill",
  since: null,
  until: "2026-01-02T00:00:00.000Z",
});
function page(repositoryId = 2, count = 3) {
  return {
    repositoryId,
    visibility: "public",
    nextCursor: null,
    expectedCount: count,
    facts: Array.from({ length: count }, (_, i) => ({
      subjectId: `SYNTHETIC_${repositoryId}_${i}`,
      sourceRevision: "r1",
      sourceUrl: `https://github.com/synthetic-org/synthetic-repo-${repositoryId}/issues/${i + 1}`,
      evidence: "observed_transition",
      actorId: `synthetic-actor-${repositoryId}`,
      occurredAt: "2026-01-01T00:00:00.000Z",
      state: "open",
    })),
  };
}
async function seed(repositoryId = 2, count = 3) {
  const s = scan(repositoryId);
  await collection.start(s);
  assert.equal(await collection.step(s.runId, { readPage: async () => page(repositoryId, count) }), "complete");
}
async function rows(table) {
  return (await db.query(`SELECT * FROM leaderboard_ingestion.${table}`)).rows;
}
async function retirementSchema() {
  return (
    await db.query(`
      SELECT 'relation' AS kind,relname::text AS name,oid::text AS definition
      FROM pg_catalog.pg_class WHERE relnamespace='leaderboard_ingestion'::regnamespace
      UNION ALL
      SELECT 'function',proname::text,pg_catalog.pg_get_functiondef(oid)
      FROM pg_catalog.pg_proc WHERE pronamespace='leaderboard_ingestion'::regnamespace
      UNION ALL
      SELECT 'trigger',trigger.tgname::text,pg_catalog.pg_get_triggerdef(trigger.oid)
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid=trigger.tgrelid
      WHERE relation.relnamespace='leaderboard_ingestion'::regnamespace
      ORDER BY kind,name,definition
    `)
  ).rows;
}
const delivery = (n = 1, repositoryId = 2) => {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    deliveryId: id,
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: id,
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId,
      subjectId: `SYNTHETIC_${repositoryId}`,
      actorId: null,
      occurredAt: null,
      sourceUrl: `https://github.com/synthetic-org/synthetic-repo-${repositoryId}/issues/1`,
    },
  };
};

test("permanent retirement fences reprobes, new source payloads and every retained snapshot reader without forging lifecycle", async () => {
  await seed();
  const inbox = new InboxStore(db);
  await inbox.insert(delivery());
  const lease = await inbox.claim();
  await inbox.complete(lease);
  const snapshots = new SnapshotStore(db);
  const published = await snapshots.publishObjectState(2, "SYNTHETIC_2", "synthetic-definition", "0");
  const result = await retirement.retire(request(), approved);
  assert.equal(result.status, "collection_fenced");
  assert.equal(result.sourceGeneration, "2");
  assert.equal((await rows("lifecycle_receipts")).length, 0);
  await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
  await assert.rejects(collection.start(scan(2, "synthetic-new-scan")), /repository_unverified/);
  await assert.rejects(inbox.insert(delivery(2)), /repository_retired/);
  await assert.rejects(inbox.replayObjectState(2, "SYNTHETIC_2"), /repository_unavailable/);
  assert.equal(await snapshots.latest(2, "SYNTHETIC_2"), null);
  assert.equal(await snapshots.byId(published.snapshot.snapshotId), null);
  assert.deepEqual(await snapshots.notices(2, "SYNTHETIC_2", "0"), []);
  await assert.rejects(
    snapshots.publishObjectState(2, "SYNTHETIC_2", "synthetic-definition", "1"),
    /repository_unavailable/,
  );
  assert.equal(await collection.verifyPublic(3, 1, "1"), true);
  assert.equal(await inbox.insert(delivery(3, 3)), "accepted");
  await assert.rejects(
    db.query("DELETE FROM leaderboard_ingestion.repository_retirements"),
    /immutable_repository_retirement/,
  );
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.repository_retirements SET policy_version='changed'"),
    /immutable_repository_retirement/,
  );
  await assert.rejects(
    db.query("DELETE FROM leaderboard_ingestion.repository_access WHERE repository_id=2"),
    /repository_retired/,
  );
});

test("bounded erasure removes exact collected facts and dependent ingestion payloads; retries retain counts and unrelated sources", async () => {
  await seed();
  await seed(3, 2);
  await db.query(
    "INSERT INTO leaderboard_ingestion.enrichment_jobs(fact_key,policy_version,metadata) SELECT fact_key,'synthetic-policy','{\"actorId\":\"synthetic-payload\"}'::jsonb FROM leaderboard_ingestion.source_facts",
  );
  const preserved = await db.query(
    "SELECT * FROM leaderboard_ingestion.source_facts WHERE repository_id=3 ORDER BY fact_key",
  );
  const fixed = await retirement.retire(request(), approved);
  assert.deepEqual(await new RepositoryRetirementStore(db).retire(request(), approved), fixed);
  const first = await retirement.eraseBatch(request(), "synthetic-batch-1", 2, approved);
  assert.equal(first.status, "erased");
  assert.equal(first.deletedSourceFacts, 2);
  assert.equal(first.sourceFactsRemaining, true);
  assert.deepEqual(
    await new RepositoryRetirementStore(db).eraseBatch(request(), "synthetic-batch-1", 2, approved),
    first,
  );
  await assert.rejects(retirement.eraseBatch(request(), "synthetic-batch-1", 1, approved), /erasure_batch_conflict/);
  const final = await retirement.eraseBatch(request(), "synthetic-batch-2", 2, approved);
  assert.equal(final.deletedSourceFacts, 1);
  assert.equal(final.sourceFactsRemaining, false);
  await assert.rejects(
    retirement.eraseBatch(request(), "synthetic-unneeded-empty", 2, approved),
    /source_scope_already_erased/,
  );
  assert.equal((await rows("collection_erasure_batches")).length, 2);
  assert.deepEqual(
    await db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE repository_id=3 ORDER BY fact_key"),
    preserved,
  );
  assert.equal((await rows("collection_items")).length, 2);
  assert.equal((await rows("enrichment_jobs")).length, 2);
  assert.equal((await rows("collection_runs")).length, 2, "run metadata is outside the collected-fact erasure claim");
  for (const batch of await rows("collection_erasure_batches")) {
    assert.equal(batch.active_transaction, null);
    assert.equal(batch.active_fact_keys, null);
  }
  assert.doesNotMatch(
    JSON.stringify(await rows("collection_erasure_batches")),
    /synthetic-actor|synthetic-payload|sourceUrl/,
  );
  await assert.rejects(db.query("DELETE FROM leaderboard_ingestion.source_facts"), /immutable_source_fact/);
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.source_facts SET document='{}'::jsonb"),
    /immutable_source_fact/,
  );
});

test("completed audit history cannot cap remaining source erasure or grow on empty retries", async () => {
  await seed(2, 1);
  await retirement.retire(request(), approved);
  // A synthetic retained receipt history isolates the capacity boundary without
  // claiming that this fixture performed 10,000 earlier erasure transactions.
  await db.query(
    `INSERT INTO leaderboard_ingestion.collection_erasure_batches
    (operation_id,batch_id,batch_limit,attempt,status,deleted_count,source_facts_remaining,completed_at)
    SELECT $1,'synthetic-history-'||n,1,1,'erased',1,true,clock_timestamp()
    FROM generate_series(1,10000) AS n`,
    [request().operationId],
  );
  const result = await retirement.eraseBatch(request(), "synthetic-after-history", 1, approved);
  assert.equal(result.deletedSourceFacts, 1);
  assert.equal(result.sourceFactsRemaining, false);
  assert.equal((await rows("source_facts")).length, 0);
  for (const id of ["synthetic-empty-1", "synthetic-empty-2"])
    await assert.rejects(retirement.eraseBatch(request(), id, 1, approved), /source_scope_already_erased/);
  assert.equal((await rows("collection_erasure_batches")).length, 10001);
  assert.deepEqual(await retirement.eraseBatch(request(), "synthetic-after-history", 1, approved), result);
});

test("unfinished receipt capacity permits the same blocked batch to complete and an empty scope records once", async () => {
  await seed(2, 1);
  await retirement.retire(request(), approved);
  await db.query(
    `INSERT INTO leaderboard_ingestion.collection_erasure_batches
    (operation_id,batch_id,batch_limit,attempt,status,deleted_count,source_facts_remaining,completed_at)
    SELECT $1,'synthetic-blocked-'||n,1,1,'blocked',0,true,clock_timestamp()
    FROM generate_series(1,10000) AS n`,
    [request().operationId],
  );
  await assert.rejects(
    retirement.eraseBatch(request(), "synthetic-new-over-capacity", 1, approved),
    /erasure_receipt_limit_exceeded/,
  );
  const retried = await retirement.eraseBatch(request(), "synthetic-blocked-1", 1, approved);
  assert.equal(retried.deletedSourceFacts, 1);
  assert.equal(retried.attempt, 2);
  assert.equal(retried.sourceFactsRemaining, false);

  const empty = request({ repositoryId: 3, operationId: "synthetic-empty-repository" });
  await retirement.retire(empty, approved);
  const first = await retirement.eraseBatch(empty, "synthetic-empty-first", 1, approved);
  assert.equal(first.deletedSourceFacts, 0);
  assert.equal(first.sourceFactsRemaining, false);
  assert.deepEqual(await retirement.eraseBatch(empty, "synthetic-empty-first", 1, approved), first);
  await assert.rejects(
    retirement.eraseBatch(empty, "synthetic-empty-again", 1, approved),
    /source_scope_already_erased/,
  );
});

test("a protected non-owner caller erases through the function with only its documented privileges", async () => {
  await seed(2, 2);
  await retirement.retire(request(), approved);
  const role = `synthetic_retention_caller_${process.pid}`;
  await db.query(`CREATE ROLE ${role} NOLOGIN`);
  const asRole = (work) =>
    db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${role}`);
      return work(tx);
    });
  try {
    await db.query(`GRANT USAGE ON SCHEMA leaderboard_ingestion TO ${role}`);
    await db.query(`GRANT SELECT ON leaderboard_ingestion.repository_retirements TO ${role}`);
    const privileges = (
      await db.query(
        `SELECT has_function_privilege($1,
      'leaderboard_ingestion.erase_collected_source_batch(text,text,integer)','EXECUTE') AS can_execute,
      has_table_privilege($1,'leaderboard_ingestion.collection_erasure_batches','INSERT') AS can_insert,
      has_table_privilege($1,'leaderboard_ingestion.source_facts','DELETE') AS can_delete`,
        [role],
      )
    ).rows[0];
    assert.deepEqual(privileges, { can_execute: false, can_insert: false, can_delete: false });
    await db.query(
      `GRANT EXECUTE ON FUNCTION leaderboard_ingestion.erase_collected_source_batch(text,text,integer) TO ${role}`,
    );
    const caller = new RepositoryRetirementStore({
      query: (sql, params) => asRole((tx) => tx.query(sql, params)),
      transaction: asRole,
    });
    const result = await caller.eraseBatch(request(), "synthetic-function-only", 1, approved);
    assert.equal(result.deletedSourceFacts, 1);
    assert.equal(result.sourceFactsRemaining, true);
    assert.deepEqual(await caller.eraseBatch(request(), "synthetic-function-only", 1, approved), result);
    assert.equal((await rows("source_facts")).length, 1);
    await assert.rejects(
      asRole((tx) => tx.query("DELETE FROM leaderboard_ingestion.source_facts")),
      /permission denied/,
    );

    // A reporting role's accidental table-update grant must not authorize edits
    // to the function's retained receipt or its transaction-bound state.
    await db.query(`GRANT SELECT,UPDATE ON leaderboard_ingestion.collection_erasure_batches TO ${role}`);
    await assert.rejects(
      asRole((tx) => tx.query("UPDATE leaderboard_ingestion.collection_erasure_batches SET attempt=attempt+1")),
      /erasure_receipt_write_forbidden/,
    );
    assert.equal((await rows("collection_erasure_batches"))[0].attempt, 1);
  } finally {
    await db.query(`DROP OWNED BY ${role}`);
    await db.query(`DROP ROLE ${role}`);
  }
});

test("ordinary active-source inserts retain their minimal guard-reader permissions", async () => {
  await seed(2, 1);
  await seed(3, 1);
  await retirement.retire(request(), approved);
  const role = `synthetic_retention_collector_${process.pid}`;
  await db.query(`CREATE ROLE ${role} NOLOGIN`);
  const insert = (repositoryId) =>
    db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${role}`);
      return tx.query(
        `INSERT INTO leaderboard_ingestion.source_facts
      (fact_key,repository_id,family,subject_id,source_revision,document,first_run_id)
      VALUES($1,$2,'issues','synthetic-role-source','r1','{}'::jsonb,$3)`,
        [`synthetic-role-source-${repositoryId}`, repositoryId, `synthetic-run-${repositoryId}`],
      );
    });
  try {
    await db.query(`GRANT USAGE ON SCHEMA leaderboard_ingestion TO ${role}`);
    await db.query(`GRANT SELECT(repository_id) ON leaderboard_ingestion.repository_retirements TO ${role}`);
    await db.query(`GRANT SELECT,UPDATE ON leaderboard_ingestion.repository_access TO ${role}`);
    await db.query(`GRANT INSERT ON leaderboard_ingestion.source_facts TO ${role}`);
    await insert(3);
    await assert.rejects(insert(2), /repository_retired/);
    assert.equal(
      (await rows("source_facts")).filter((row) => row.fact_key.startsWith("synthetic-role-source-")).length,
      1,
    );
  } finally {
    await db.query(`DROP OWNED BY ${role}`);
    await db.query(`DROP ROLE ${role}`);
  }
});

test("database guards keep fixed catalog lookup and only source erasure elevates privileges", async () => {
  const names = [
    "reject_retirement_change",
    "guard_retired_access",
    "guard_retired_payload",
    "guard_erasure_receipt",
    "reject_source_fact_change",
    "erase_collected_source_batch",
  ];
  const functions = (
    await db.query(
      `SELECT proname,prosecdef,proconfig FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname='leaderboard_ingestion' AND proname=ANY($1::text[])`,
      [names],
    )
  ).rows;
  assert.equal(functions.length, names.length);
  for (const routine of functions) {
    assert.equal(routine.prosecdef, routine.proname === "erase_collected_source_batch");
    assert.ok(routine.proconfig.includes("search_path=pg_catalog"));
  }
});

test("downstream foreign keys block the entire batch, preserve the fence and yield a retryable minimized receipt", async () => {
  await seed(2, 2);
  await db.query(
    "CREATE TABLE synthetic_projection(fact_key text PRIMARY KEY REFERENCES leaderboard_ingestion.source_facts(fact_key))",
  );
  try {
    await db.query(
      "INSERT INTO synthetic_projection SELECT fact_key FROM leaderboard_ingestion.source_facts ORDER BY fact_key LIMIT 1",
    );
    await retirement.retire(request(), approved);
    const blocked = await retirement.eraseBatch(request(), "synthetic-blocked", 100, approved);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedReason, "retained_dependencies");
    assert.equal(blocked.deletedSourceFacts, 0);
    assert.equal(blocked.attempt, 1);
    assert.equal((await rows("source_facts")).length, 2);
    assert.equal((await rows("collection_items")).length, 2);
    await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
    await assert.rejects(db.query("DELETE FROM leaderboard_ingestion.source_facts"), /immutable_source_fact/);
    await db.query("DELETE FROM synthetic_projection");
    const retried = await retirement.eraseBatch(request(), "synthetic-blocked", 100, approved);
    assert.equal(retried.status, "erased");
    assert.equal(retried.deletedSourceFacts, 2);
    assert.equal(retried.attempt, 2);
    assert.equal(retried.sourceFactsRemaining, false);
  } finally {
    await db.query("DROP TABLE synthetic_projection");
  }
});

test("authorization loss rolls back fence or erasure atomically, including deletion exceptions and receipt writes", async () => {
  await seed();
  let calls = 0;
  await assert.rejects(
    retirement.retire(request(), async () => ++calls < 3),
    /retirement_not_authorized/,
  );
  assert.equal((await rows("repository_retirements")).length, 0);
  assert.equal((await rows("repository_access")).find((r) => Number(r.repository_id) === 2).state, "public");
  await retirement.retire(request(), approved);
  calls = 0;
  await assert.rejects(
    retirement.eraseBatch(request(), "synthetic-crash", 2, async () => ++calls < 3),
    /retirement_not_authorized/,
  );
  assert.equal((await rows("source_facts")).length, 3);
  assert.equal((await rows("collection_erasure_batches")).length, 0);
  await assert.rejects(db.query("DELETE FROM leaderboard_ingestion.source_facts"), /immutable_source_fact/);
  const retried = await retirement.eraseBatch(request(), "synthetic-crash", 2, approved);
  assert.equal(retried.deletedSourceFacts, 2);
  assert.equal(retried.attempt, 1);
});

test("a collector paused at the network boundary cannot restore a retired payload", async () => {
  const s = scan();
  await collection.start(s);
  let release, entered;
  const waiting = new Promise((resolve) => (entered = resolve));
  const pause = new Promise((resolve) => (release = resolve));
  const step = collection.step(s.runId, {
    readPage: async () => {
      entered();
      await pause;
      return page();
    },
  });
  await waiting;
  await retirement.retire(request(), approved);
  release();
  assert.equal(await step, "failed");
  assert.equal((await rows("source_facts")).length, 0);
  assert.equal((await rows("repository_access")).find((r) => Number(r.repository_id) === 2).state, "unavailable");
});

test("operation identities, current generations and bounded batch inputs cannot be changed or guessed", async () => {
  await assert.rejects(
    retirement.retire(request(), async () => ({ allowed: true })),
    /retirement_not_authorized/,
  );
  await assert.rejects(
    retirement.retire(request({ expectedGeneration: "2" }), approved),
    /retirement_generation_changed/,
  );
  await assert.rejects(
    retirement.retire(request({ expectedGeneration: 1 }), approved),
    /invalid_repository_retirement/,
  );
  await assert.rejects(retirement.retire(request({ repositoryId: 9 }), approved), /retirement_repository_unknown/);
  await retirement.retire(request(), approved);
  for (const overrides of [
    { operationId: "different" },
    { repositoryId: 3 },
    { policyVersion: "changed" },
    { authorizationReceipt: "changed" },
    { operatorId: "changed" },
    { expectedGeneration: "2" },
  ])
    await assert.rejects(retirement.retire(request(overrides), approved), /retirement_operation_conflict/);
  for (const limit of [0, 101, 1.5, NaN])
    await assert.rejects(retirement.eraseBatch(request(), "synthetic-batch", limit, approved), /invalid_erasure_batch/);
  await assert.rejects(
    retirement.eraseBatch(request({ operationId: "unknown" }), "synthetic-batch", 1, approved),
    /unknown_repository_retirement/,
  );
  assert.equal((await rows("collection_erasure_batches")).length, 0);
});

test("a rollback preserves permanent retirement history and an empty migration can reapply", async () => {
  const migrate = (sql) =>
    external ? db.transaction((tx) => tx.query(sql)) : engine.transaction((tx) => tx.exec(sql));
  // A single-statement runner must also retain the locks through every DROP.
  await (external ? engine.query(retirementDown) : engine.exec(retirementDown));
  await migrate(retirementUp);
  await migrate(retirementDown);
  await migrate(retirementUp);
  await retirement.retire(request(), approved);
  const schema = await retirementSchema();
  await assert.rejects(migrate(retirementDown), /retirement_history_prevents_rollback/);
  assert.deepEqual(await retirementSchema(), schema);
  await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
  assert.equal((await rows("repository_retirements")).length, 1);
});

test("rollback rejects inherited non-read-committed isolation before changing any guard", async () => {
  const schema = await retirementSchema();
  for (const isolation of ["READ UNCOMMITTED", "REPEATABLE READ", "SERIALIZABLE"]) {
    const migrate = external
      ? db.transaction(async (tx) => {
          await tx.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await tx.query("SELECT count(*) FROM leaderboard_ingestion.repository_retirements");
          await tx.query(retirementDown);
        })
      : engine.transaction(async (tx) => {
          await tx.exec(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await tx.query("SELECT count(*) FROM leaderboard_ingestion.repository_retirements");
          await tx.exec(retirementDown);
        });
    await assert.rejects(migrate, /retirement_rollback_requires_read_committed/);
    assert.deepEqual(await retirementSchema(), schema);
  }
  await retirement.retire(request(), approved);
  await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
});

test("a late rollback DDL failure restores every preceding guard change even without an outer transaction", async () => {
  await seed(2, 1);
  await db.query(
    "CREATE TABLE synthetic_retirement_dependency(operation_id text REFERENCES leaderboard_ingestion.repository_retirements(operation_id))",
  );
  const schema = await retirementSchema();
  try {
    await assert.rejects(
      external ? engine.query(retirementDown) : engine.exec(retirementDown),
      /other objects depend on it/,
    );
    assert.deepEqual(await retirementSchema(), schema);
    await retirement.retire(request(), approved);
    const erased = await retirement.eraseBatch(request(), "synthetic-after-failed-rollback", 1, approved);
    assert.equal(erased.deletedSourceFacts, 1);
    assert.equal(erased.sourceFactsRemaining, false);
    await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
  } finally {
    await db.query("DROP TABLE synthetic_retirement_dependency");
  }
});

test(
  "rollback fails before an in-flight PostgreSQL retirement commits and preserves its permanent fence",
  { skip: independentConnections, timeout: 15_000 },
  async () => {
    const schema = await retirementSchema();
    let reachedCommit, releaseCommit;
    const atCommit = new Promise((resolve) => (reachedCommit = resolve));
    const mayCommit = new Promise((resolve) => (releaseCommit = resolve));
    const paused = new RepositoryRetirementStore({
      query: db.query,
      transaction: (work) =>
        db.transaction(async (tx) => {
          const result = await work(tx);
          reachedCommit();
          await mayCommit;
          return result;
        }),
    });
    const migration = await engine.connect();
    const retiring = paused.retire(request(), approved);
    let pendingRollback, rollbackResult, beforeCommit;
    try {
      await Promise.race([atCommit, retiring.then(() => assert.fail("retirement returned before its commit barrier"))]);
      await migration.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // This statement timeout is only a cleanup bound (57014). A lock-timeout
      // oracle (55P03) could also accept an old script blocked at a later DROP.
      // Observe actual blocking before allowing the retirement to commit instead.
      await migration.query("SET LOCAL statement_timeout='5s'");
      const pid = (await migration.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pendingRollback = migration.query(retirementDown).then(
        () => (rollbackResult = { error: null }),
        (error) => (rollbackResult = { error }),
      );
      const deadline = performance.now() + 3_000;
      let blocked = false;
      while (!rollbackResult && !blocked && performance.now() < deadline) {
        blocked =
          (await engine.query("SELECT 1 FROM pg_catalog.pg_locks WHERE pid=$1 AND NOT granted", [pid])).rows.length > 0;
        if (!rollbackResult && !blocked) await delay(10);
      }
      assert.ok(
        rollbackResult || blocked,
        "observe rejection or a real PostgreSQL lock wait before releasing retirement",
      );
      beforeCommit = rollbackResult;
      releaseCommit();
      assert.equal((await retiring).status, "collection_fenced");
      await pendingRollback;
    } finally {
      releaseCommit();
      await retiring.catch(() => {});
      await pendingRollback;
      // Never commit the test's attempted rollback. An old implementation can
      // otherwise discard the freshly committed tombstone when its DROP resumes.
      await migration.query("ROLLBACK");
      migration.release();
    }
    assert.equal(beforeCommit?.error?.code, "55P03", "rollback must reject before the retirement commits");
    assert.equal(rollbackResult.error.code, "55P03");
    assert.deepEqual(await retirementSchema(), schema);
    assert.equal((await rows("repository_retirements")).length, 1);
    await assert.rejects(
      db.transaction((tx) => tx.query(retirementDown)),
      /retirement_history_prevents_rollback/,
    );
    await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
  },
);

for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"])
  test(
    `a stale PostgreSQL ${isolation} rollback snapshot cannot hide a newly committed retirement`,
    { skip: independentConnections, timeout: 15_000 },
    async () => {
      const schema = await retirementSchema();
      const migration = await engine.connect();
      try {
        await migration.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await migration.query("SET LOCAL statement_timeout='5s'");
        assert.equal(
          (await migration.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.repository_retirements"))
            .rows[0].count,
          0,
        );
        await retirement.retire(request(), approved);
        assert.equal(
          (await migration.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.repository_retirements"))
            .rows[0].count,
          0,
          "the inherited snapshot demonstrably predates the committed retirement",
        );
        await assert.rejects(migration.query(retirementDown), /retirement_rollback_requires_read_committed/);
      } finally {
        await migration.query("ROLLBACK");
        migration.release();
      }
      assert.deepEqual(await retirementSchema(), schema);
      assert.equal((await rows("repository_retirements")).length, 1);
      await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
    },
  );

test(
  "concurrent source insertion and retirement serialize through the same PostgreSQL repository row",
  { skip: independentConnections },
  async () => {
    const s = scan();
    await collection.start(s);
    const client = await engine.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=2 FOR SHARE",
      );
      let done = false;
      const pending = retirement.retire(request(), approved).then((value) => {
        done = true;
        return value;
      });
      await client.query("SELECT pg_sleep(0.05)");
      assert.equal(done, false, "retirement waits for the in-flight source transaction");
      await client.query(
        `INSERT INTO leaderboard_ingestion.source_facts(fact_key,repository_id,family,subject_id,source_revision,document,first_run_id) VALUES('synthetic-in-flight',2,'issues','SYNTHETIC_IN_FLIGHT','r1','{}'::jsonb,$1)`,
        [s.runId],
      );
      await client.query("COMMIT");
      await pending;
      assert.equal((await rows("source_facts")).length, 1);
      assert.equal(
        (await retirement.eraseBatch(request(), "synthetic-after-writer", 1, approved)).deletedSourceFacts,
        1,
      );
      await assert.rejects(
        client.query(
          `INSERT INTO leaderboard_ingestion.source_facts(fact_key,repository_id,family,subject_id,source_revision,document,first_run_id) VALUES('synthetic-late',2,'issues','SYNTHETIC_LATE','r1','{}'::jsonb,$1)`,
          [s.runId],
        ),
        /repository_retired/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
