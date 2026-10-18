import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { publicScopeKey } from "@pick-your-ai/contracts";
import { migratePipeline, assertPipelineStorage, pipelineKeySQL } from "../src/scope-storage.mjs";
import {
  baseScope,
  capacityScope,
  hash,
  retainedRows,
  schemaState,
  seedRetained,
  storageDatabase,
} from "./scope-storage-harness.mjs";

let h, db;
before(async () => {
  h = await storageDatabase();
  db = h.db;
});
after(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});
const nativeOnly = process.env.PIPELINE_SCOPE_STORAGE_TEST_DATABASE_URL
  ? false
  : "independent PostgreSQL connections require the dedicated disposable service";

test("retained v1 migration preserves every original row, full key, receipt ID and frozen document", async () => {
  const legacy = await seedRetained(db);
  const beforeRows = await retainedRows(db);
  await assert.rejects(() => assertPipelineStorage(db), /unsupported_pipeline_storage_schema/);
  await migratePipeline(db);
  await assertPipelineStorage(db);
  assert.deepEqual(await retainedRows(db), beforeRows);
  for (const [table, column, original] of [
    ["heads", "scope_hash", legacy.key],
    ["dispatch_publications", "scope_hash", legacy.key],
    ["receipts", "operation_hash", legacy.operation],
  ]) {
    const row = (
      await db.query(
        `SELECT encode(${column},'hex') AS digest,octet_length(${column}) AS bytes FROM leaderboard_pipeline.${table}`,
      )
    ).rows[0];
    assert.deepEqual(row, { digest: hash(original), bytes: 32 });
  }
  const version = (await db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows;
  const shape = await schemaState(db);
  await migratePipeline(db);
  assert.deepEqual((await db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows, version);
  assert.deepEqual(await schemaState(db), shape);
  assert.deepEqual(await retainedRows(db), beforeRows);
});

test("maximum high-entropy canonical v2 and v3 scopes occupy all three bounded indexes without rewriting identities", async () => {
  const legacy = await seedRetained(db);
  await migratePipeline(db);
  const values = [
    await seedRetained(db, capacityScope(false), "SYNTHETIC_MAX_V2"),
    await seedRetained(db, capacityScope(true), "SYNTHETIC_MAX_V3"),
  ];
  assert.deepEqual(
    values.map((value) => value.key.length),
    [13796, 13895],
  );
  assert.notEqual(values[0].key, values[1].key);
  const snapshots = (await db.query("SELECT scope_key,snapshot_id,document FROM leaderboard_pipeline.snapshots")).rows;
  for (const value of [legacy, ...values]) {
    assert.deepEqual(
      snapshots.find((row) => row.snapshot_id === value.snapshotId),
      {
        scope_key: value.key,
        snapshot_id: value.snapshotId,
        document: value.document,
      },
    );
    const dispatch = (
      await db.query(
        `SELECT snapshot_id FROM leaderboard_pipeline.dispatch_publications
      WHERE operation_key=$1 AND scope_hash=sha256(convert_to($2,'UTF8')) AND scope_key=$2`,
        [value.dispatchKey, value.key],
      )
    ).rows;
    assert.deepEqual(dispatch, [{ snapshot_id: value.snapshotId }]);
    const receipts = (
      await db.query(
        `SELECT receipt_id,operation_key FROM leaderboard_pipeline.receipts
      WHERE operation_hash=sha256(convert_to($1,'UTF8')) AND operation_key=$1`,
        [value.operation],
      )
    ).rows;
    assert.deepEqual(receipts, [{ receipt_id: value.receiptId, operation_key: value.operation }]);
  }
  await assertPipelineStorage(db);
});

test("each historical raw B-tree boundary actually rejects a valid maximum scope before migration", async () => {
  const scope = capacityScope(true);
  const key = publicScopeKey(scope);
  const snapshot = hash("SYNTHETIC_OLD_CAPACITY");
  await db.query(
    `INSERT INTO leaderboard_pipeline.snapshots(snapshot_id,scope_key,revision,config_version,repository_ids,document,document_hash)
    VALUES($1,$2,1,'SYNTHETIC','[]','{}',$1)`,
    [snapshot, key],
  );
  const operation = `publish:${key}:${snapshot}`;
  for (const [sql, parameters] of [
    ["INSERT INTO leaderboard_pipeline.heads(scope_key,snapshot_id,revision) VALUES($1,$2,1)", [key, snapshot]],
    [
      "INSERT INTO leaderboard_pipeline.dispatch_publications(operation_key,scope_key,snapshot_id) VALUES($1,$2,$3)",
      [hash("SYNTHETIC_OPERATION"), key, snapshot],
    ],
    [
      "INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash) VALUES($1,$2,'snapshot_published','{}',$1)",
      [hash(JSON.stringify([operation, "snapshot_published"])), operation],
    ],
  ])
    await assert.rejects(
      () => db.query(sql, parameters),
      (error) => error.code === "54000",
    );
  for (const table of ["heads", "dispatch_publications", "receipts"])
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM leaderboard_pipeline.${table}`)).rows[0].count, 0);
});

test("interruption after every schema/backfill mutation rolls the retained database back exactly and permits retry", async () => {
  await seedRetained(db);
  const rows = await retainedRows(db);
  const schema = await schemaState(db);
  const boundaries = [];
  const recording = {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await work({
          query: async (sql, parameters) => {
            const result = await tx.query(sql, parameters);
            if (/^(CREATE|ALTER|UPDATE|INSERT)\b/.test(sql)) boundaries.push(sql);
            return result;
          },
        });
        throw new Error("SYNTHETIC_RECORD_BOUNDARIES");
      }),
  };
  await assert.rejects(() => migratePipeline(recording), /SYNTHETIC_RECORD_BOUNDARIES/);
  assert.ok(boundaries.length >= 18, "record actual executed schema and data writes");
  for (let boundary = 0; boundary < boundaries.length; boundary++) {
    let seen = 0,
      injected = false;
    const interrupted = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            query: async (sql, parameters) => {
              const result = await tx.query(sql, parameters);
              if (/^(CREATE|ALTER|UPDATE|INSERT)\b/.test(sql) && seen++ === boundary) {
                injected = true;
                throw new Error("SYNTHETIC_INTERRUPTED_UPGRADE");
              }
              return result;
            },
          }),
        ),
    };
    await assert.rejects(() => migratePipeline(interrupted), /SYNTHETIC_INTERRUPTED_UPGRADE/);
    assert.equal(injected, true, `fault ${boundary} must execute`);
    assert.deepEqual(await schemaState(db), schema, `schema restored after ${boundaries[boundary]}`);
    assert.deepEqual(await retainedRows(db), rows, `rows restored after boundary ${boundary}`);
    assert.equal(
      (await db.query("SELECT to_regclass('leaderboard_pipeline.storage_migrations') AS name")).rows[0].name,
      null,
    );
  }
  await migratePipeline(db);
  assert.deepEqual(await retainedRows(db), rows);
});

test("legacy partial schema or inconsistent retained head, dispatch and receipt identities are preserved and refused", async () => {
  for (const mutation of ["partial", "head", "dispatch", "receipt"]) {
    await h.reset();
    const retained = await seedRetained(db);
    if (mutation === "partial") await db.query("ALTER TABLE leaderboard_pipeline.heads ADD COLUMN scope_hash bytea");
    if (mutation === "head") await db.query("UPDATE leaderboard_pipeline.heads SET revision=2");
    if (mutation === "dispatch")
      await db.query("UPDATE leaderboard_pipeline.dispatch_publications SET scope_key=$1", [
        publicScopeKey({ ...baseScope, workstream: "SYNTHETIC_OTHER" }),
      ]);
    if (mutation === "receipt")
      await db.query("UPDATE leaderboard_pipeline.receipts SET receipt_id=$1", [hash(retained.receiptId)]);
    const rows = await retainedRows(db),
      schema = await schemaState(db);
    await assert.rejects(() => migratePipeline(db), /pipeline_storage_(schema|retained_identity)_invalid/);
    assert.deepEqual(await retainedRows(db), rows);
    assert.deepEqual(await schemaState(db), schema);
  }
});

test("receipt validation covers empty IDs and identities beyond the first bounded batch", async () => {
  const retained = await seedRetained(db);
  await db.query("UPDATE leaderboard_pipeline.receipts SET receipt_id='' WHERE receipt_id=$1", [retained.receiptId]);
  await assert.rejects(() => migratePipeline(db), /pipeline_storage_retained_identity_invalid/);
  assert.equal((await db.query("SELECT receipt_id FROM leaderboard_pipeline.receipts")).rows[0].receipt_id, "");
  await db.query("UPDATE leaderboard_pipeline.receipts SET receipt_id=$1 WHERE receipt_id=''", [retained.receiptId]);
  const records = Array.from({ length: 257 }, (_, index) => {
    const operation = `SYNTHETIC_BATCH_${index}`;
    return { receipt_id: hash(JSON.stringify([operation, "SYNTHETIC_KIND"])), operation_key: operation };
  });
  await db.query(
    `INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash)
    SELECT receipt_id,operation_key,'SYNTHETIC_KIND','{}',$2
    FROM jsonb_to_recordset($1::jsonb) AS receipt(receipt_id text,operation_key text)`,
    [JSON.stringify(records), hash("{}")],
  );
  await db.query(
    `INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash)
    VALUES($1,'SYNTHETIC_LATE_INVALID','SYNTHETIC_KIND','{}',$2)`,
    ["z".repeat(64), hash("{}")],
  );
  const rows = await retainedRows(db),
    schema = await schemaState(db);
  await assert.rejects(() => migratePipeline(db), /pipeline_storage_retained_identity_invalid/);
  assert.deepEqual(await retainedRows(db), rows);
  assert.deepEqual(await schemaState(db), schema);
  await db.query("DELETE FROM leaderboard_pipeline.receipts WHERE receipt_id=$1", ["z".repeat(64)]);
  const repaired = await retainedRows(db);
  await migratePipeline(db);
  assert.deepEqual(await retainedRows(db), repaired);
});

test("future or edited migration receipts, missing checks and reintroduced raw indexes are refused without repair", async () => {
  for (const mutation of ["version", "checksum", "missing", "unvalidated", "raw_index"]) {
    await h.reset();
    await seedRetained(db);
    await migratePipeline(db);
    if (mutation === "version")
      await db.query("UPDATE leaderboard_pipeline.storage_migrations SET version='pipeline-storage/v999'");
    if (mutation === "checksum")
      await db.query("UPDATE leaderboard_pipeline.storage_migrations SET migration_hash=$1", [hash("SYNTHETIC_EDIT")]);
    if (["missing", "unvalidated"].includes(mutation))
      await db.query("ALTER TABLE leaderboard_pipeline.heads DROP CONSTRAINT heads_scope_hash_valid");
    if (mutation === "unvalidated")
      await db.query(
        "ALTER TABLE leaderboard_pipeline.heads ADD CONSTRAINT heads_scope_hash_valid CHECK(scope_hash=sha256(convert_to(scope_key,'UTF8'))) NOT VALID",
      );
    if (mutation === "raw_index")
      await db.query("CREATE INDEX synthetic_raw_scope ON leaderboard_pipeline.heads(scope_key)");
    const rows = await retainedRows(db),
      schema = await schemaState(db);
    const versions = (await db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows;
    await assert.rejects(() => assertPipelineStorage(db), /pipeline_storage_schema/);
    await assert.rejects(() => migratePipeline(db), /pipeline_storage_schema/);
    assert.deepEqual(await retainedRows(db), rows);
    assert.deepEqual(await schemaState(db), schema);
    assert.deepEqual((await db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows, versions);
  }
});

test("the database rejects false digests and does not silently accept an old writer's raw conflict target", async () => {
  const value = await seedRetained(db);
  await migratePipeline(db);
  const rows = await retainedRows(db);
  for (const [table, column] of [
    ["heads", "scope_hash"],
    ["dispatch_publications", "scope_hash"],
    ["receipts", "operation_hash"],
  ])
    await assert.rejects(
      () =>
        db.query(`UPDATE leaderboard_pipeline.${table} SET ${column}=decode($1,'hex')`, [
          hash("SYNTHETIC_WRONG_DIGEST"),
        ]),
      (error) => error.code === "23514",
    );
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO leaderboard_pipeline.heads(scope_key,snapshot_id,revision)
    VALUES($1,$2,1) ON CONFLICT(scope_key) DO NOTHING`,
        [value.key, value.snapshotId],
      ),
    (error) => error.code === "42P10",
  );
  assert.deepEqual(await retainedRows(db), rows);
});

test(
  "retained identities and checks survive a real file close and reopen",
  {
    skip: process.env.PIPELINE_SCOPE_STORAGE_TEST_DATABASE_URL
      ? "PGlite file-reopen case; native connections have separate tests"
      : false,
  },
  async () => {
    await seedRetained(db);
    await migratePipeline(db);
    await seedRetained(db, capacityScope(true), "SYNTHETIC_PERSISTENT_MAX");
    const rows = await retainedRows(db),
      schema = await schemaState(db);
    await h.reopen();
    await assertPipelineStorage(db);
    await migratePipeline(db);
    assert.deepEqual(await retainedRows(db), rows);
    assert.deepEqual(await schemaState(db), schema);
  },
);

test("SQL digest construction only accepts a parameter placeholder", () => {
  assert.equal(pipelineKeySQL("$12"), "pg_catalog.sha256(pg_catalog.convert_to($12, 'UTF8'))");
  for (const value of ["raw", "$0", "$1::text", "$1); SELECT 1", 1, null])
    assert.throws(() => pipelineKeySQL(value), /invalid_pipeline_key_parameter/);
});

test(
  "independent PostgreSQL migrators wait on the actual advisory lock and commit one exact version",
  { skip: nativeOnly, timeout: 15_000 },
  async () => {
    await seedRetained(db);
    const original = await retainedRows(db);
    let release, acquired, announced;
    const held = new Promise((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const requested = new Promise((resolve) => {
      announced = resolve;
    });
    const first = migratePipeline({
      ...db,
      transaction: (work) =>
        db.transaction(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          return work({
            query: async (sql, parameters) => {
              const result = await tx.query(sql, parameters);
              if (sql.includes("pg_advisory_xact_lock")) {
                assert.equal(
                  (await tx.query("SHOW transaction_isolation")).rows[0].transaction_isolation,
                  "read committed",
                );
                acquired();
                await gate;
              }
              return result;
            },
          });
        }),
    });
    await Promise.race([held, first]);
    let waitingPid;
    const second = migratePipeline({
      ...db,
      transaction: (work) =>
        db.transaction(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          return work({
            query: async (sql, parameters) => {
              if (sql.includes("pg_advisory_xact_lock")) {
                waitingPid = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                announced();
              }
              return tx.query(sql, parameters);
            },
          });
        }),
    });
    try {
      await Promise.race([requested, second]);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = (
          await db.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [waitingPid])
        ).rows[0];
        if (row?.wait_event_type === "Lock" && row.wait_event === "advisory") {
          waiting = true;
          break;
        }
        await delay(20);
      }
      assert.equal(waiting, true, "second independent connection must actually wait on the migration lock");
    } finally {
      release();
    }
    await Promise.all([first, second]);
    await assertPipelineStorage(db);
    assert.equal(
      (await db.query("SELECT count(*)::int AS count FROM leaderboard_pipeline.storage_migrations")).rows[0].count,
      1,
    );
    assert.deepEqual(await retainedRows(db), original);
  },
);

test(
  "PostgreSQL waits for an in-flight legacy writer and backfills its committed identities atomically",
  { skip: nativeOnly, timeout: 15_000 },
  async () => {
    await seedRetained(db);
    let release, acquired, announced, migrationPid, expected;
    const held = new Promise((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const requested = new Promise((resolve) => {
      announced = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await seedRetained(tx, { ...baseScope, workstream: "SYNTHETIC_DRAINING_WRITER" }, "SYNTHETIC_IN_FLIGHT");
      expected = await retainedRows(tx);
      acquired();
      await gate;
    });
    await Promise.race([held, writer]);
    const migration = migratePipeline({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            query: async (sql, parameters) => {
              if (sql.startsWith("LOCK TABLE")) {
                migrationPid = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                announced();
              }
              return tx.query(sql, parameters);
            },
          }),
        ),
    });
    try {
      await Promise.race([requested, migration]);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = (
          await db.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [migrationPid])
        ).rows[0];
        if (row?.wait_event_type === "Lock" && row.wait_event === "relation") {
          waiting = true;
          break;
        }
        await delay(20);
      }
      assert.equal(waiting, true, "migration must wait for the real legacy writer's table lock");
      assert.equal(
        (await db.query("SELECT to_regclass('leaderboard_pipeline.storage_migrations') AS name")).rows[0].name,
        null,
      );
    } finally {
      release();
    }
    await Promise.all([writer, migration]);
    await assertPipelineStorage(db);
    assert.deepEqual(await retainedRows(db), expected);
  },
);
