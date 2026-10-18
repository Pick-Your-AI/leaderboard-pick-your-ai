import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  ["001_ingestion", "002_snapshots", "003_collection", "004_outbox_dispatch", "005_collection_retirement"].map((name) =>
    readFile(new URL(`../sql/${name}.up.sql`, import.meta.url), "utf8"),
  ),
);
const retirementDown = await readFile(new URL("../sql/005_collection_retirement.down.sql", import.meta.url), "utf8");
let engine, db, collection, retirement, administration;
const external = process.env.INGESTION_TEST_DATABASE_URL;
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
  await migrate(retirementDown);
  await migrate(migrations.at(-1));
  await retirement.retire(request(), approved);
  await assert.rejects(migrate(retirementDown), /retirement_history_prevents_rollback/);
  await assert.rejects(collection.verifyPublic(2, 1, "2"), /repository_retired/);
  assert.equal((await rows("repository_retirements")).length, 1);
});

test(
  "concurrent source insertion and retirement serialize through the same PostgreSQL repository row",
  { skip: !external },
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
