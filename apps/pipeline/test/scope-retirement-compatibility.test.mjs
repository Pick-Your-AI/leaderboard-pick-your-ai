// SYNTHETIC compatibility of retained v1 retirement work with v2 lookup metadata.
// The native branch uses only the existing explicitly disposable CI database.
import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import { components } from "./harness.mjs";
import {
  baseScope,
  capacityScope,
  legacySQL,
  retainedRows,
  schemaState,
  seedRetained,
  storageDatabase,
} from "./scope-storage-harness.mjs";
import { migratePipeline, assertPipelineStorage } from "../src/scope-storage.mjs";
import { PipelineDerivedRetirementStore, migratePipelineDerivedRetirement } from "../src/derived-retirement.mjs";
import { PolicyComparisonStore } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore } from "../src/aggregate-explanations.mjs";

const stable = components.metrics.stableJSON;
const hash = (value) => createHash("sha256").update(stable(value)).digest("hex");
const keyHash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const approved = async () => true;
const input = Object.freeze({
  operationId: "synthetic-scope-retirement",
  repositoryId: 2,
  expectedGeneration: "1",
  policyVersion: "synthetic-retention-v1",
  authorizationReceipt: "synthetic-exact-approval",
  operatorId: "synthetic-operator",
});
let h, db, intercept;
before(async () => {
  if (process.env.PIPELINE_SCOPE_STORAGE_TEST_DATABASE_URL) h = await storageDatabase();
  else {
    const engine = new PGlite();
    h = {
      exec: (sql) => engine.exec(sql),
      close: () => engine.close(),
      db: {
        query: (sql, params) => engine.query(sql, params),
        transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
      },
    };
  }
  db = {
    query: (sql, params) => h.db.query(sql, params),
    transaction: (work) =>
      h.db.transaction((tx) =>
        work({ query: (sql, params) => (intercept ? intercept(tx, sql, params) : tx.query(sql, params)) }),
      ),
  };
});
after(async () => {
  await h?.close();
});
beforeEach(async () => {
  intercept = null;
  // Both schemas belong to this fixture's new database, never a shared service.
  await h.exec(
    "DROP SCHEMA IF EXISTS leaderboard_pipeline CASCADE; DROP SCHEMA IF EXISTS leaderboard_ingestion CASCADE",
  );
  for (const name of [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "005_collection_retirement",
  ])
    await h.exec(await readFile(new URL(`../../../packages/ingestion/sql/${name}.up.sql`, import.meta.url), "utf8"));
  await h.exec(legacySQL);
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(2,1,'public')",
  );
});

async function seed({ scope = baseScope, upgraded = false, causal = true } = {}) {
  if (upgraded) await migratePipeline(db);
  const retained = await seedRetained(db, scope);
  if (!causal) await db.query("DELETE FROM leaderboard_pipeline.dispatch_publications");
  // Minimal explicit publication protocol, not a claim of a collector run.
  await db.query("UPDATE leaderboard_pipeline.snapshots SET document_hash=$1 WHERE snapshot_id=$2", [
    hash(retained.document),
    retained.snapshotId,
  ]);
  const frozen = {
    scope: retained.document.scope,
    engineScope: retained.document.scope,
    identityAuthorization: { sources: [{ repositoryId: "2", generation: "1" }] },
    frozen: { repositoryIds: ["2"] },
  };
  await db.query(
    "UPDATE leaderboard_pipeline.frozen_inputs SET document=$1::jsonb,document_hash=$2 WHERE snapshot_id=$3",
    [stable(frozen), hash(frozen), retained.snapshotId],
  );
  const publication = { snapshotId: retained.snapshotId, revision: 1, comparisonInputHash: hash("SYNTHETIC_CAPTURE") };
  await db.query("UPDATE leaderboard_pipeline.receipts SET document=$1::jsonb,document_hash=$2 WHERE receipt_id=$3", [
    stable(publication),
    hash(publication),
    retained.receiptId,
  ]);
  await migratePipelineDerivedRetirement(db);
  return retained;
}
async function retire() {
  assert.equal(
    (await new components.ingestion.RepositoryRetirementStore(db).retire(input, approved)).status,
    "collection_fenced",
  );
}
async function controls(t) {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-scope-retirement-"));
  let store = new components.controls.ControlStore(join(directory, "controls.sqlite"));
  new PolicyComparisonStore(store, components.metrics);
  new AggregateExplanationStore(store);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new components.controls.ControlStore(join(directory, "controls.sqlite"));
    },
  };
}
async function guards() {
  return (
    await db.query(`SELECT trigger.tgname,trigger.tgenabled,
    pg_get_triggerdef(trigger.oid) AS definition,pg_get_functiondef(trigger.tgfoid) AS function
    FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
    WHERE relation.relnamespace='leaderboard_pipeline'::regnamespace AND NOT trigger.tgisinternal
    ORDER BY trigger.tgname`)
  ).rows;
}
async function deniedUpdates(tables) {
  for (const table of tables) {
    const field = table === "snapshots" ? "document" : "scope_key";
    await assert.rejects(
      db.query(`UPDATE leaderboard_pipeline.${table} SET ${field}=${field}`),
      /pipeline_(repository|snapshot)_retired/,
    );
  }
}
async function lookupDigests() {
  for (const [table, raw, lookup] of [
    ["heads", "scope_key", "scope_hash"],
    ["dispatch_publications", "scope_key", "scope_hash"],
    ["receipts", "operation_key", "operation_hash"],
  ]) {
    const rows = (
      await db.query(`SELECT ${raw} AS raw,encode(${lookup},'hex') AS digest FROM leaderboard_pipeline.${table}`)
    ).rows;
    for (const row of rows) assert.equal(row.digest, keyHash(row.raw));
  }
}
async function pendingHead(t, options = {}) {
  const retained = await seed({ ...options, causal: false });
  const local = await controls(t);
  await retire();
  const eraser = new PipelineDerivedRetirementStore(db, local.store);
  let interrupted = false;
  intercept = async (tx, sql, params) => {
    if (!interrupted && /SELECT \* FROM leaderboard_pipeline\.heads WHERE .* FOR UPDATE/.test(sql)) {
      interrupted = true;
      throw new Error("SYNTHETIC_AFTER_HEAD_MANIFEST");
    }
    return tx.query(sql, params);
  };
  for (let index = 0; index < 12; index++) {
    const batchId = `synthetic-pending-${index}`;
    try {
      assert.equal((await eraser.eraseBatch(input, batchId, 1, approved)).status, "applied");
    } catch (error) {
      if (error.message !== "SYNTHETIC_AFTER_HEAD_MANIFEST") throw error;
      intercept = null;
      const saved = (
        await db.query(
          "SELECT document,document_hash FROM leaderboard_pipeline.derived_retirement_manifests WHERE operation_id=$1 AND batch_id=$2",
          [input.operationId, batchId],
        )
      ).rows[0];
      const { scope_hash: _lookup, ...legacyHead } = (await db.query("SELECT * FROM leaderboard_pipeline.heads"))
        .rows[0];
      assert.equal(saved.document.stage, "heads");
      assert.deepEqual(
        saved.document.records,
        [{ keys: [retained.key], hash: hash(legacyHead) }],
        "exact pre-v2 selected-row identity",
      );
      assert.equal(hash(saved.document), saved.document_hash);
      return { retained, local, batchId, saved };
    }
  }
  assert.fail("exact legacy heads manifest was not durably selected");
}
async function savedManifest(batchId) {
  return (
    await db.query(
      "SELECT document,document_hash FROM leaderboard_pipeline.derived_retirement_manifests WHERE operation_id=$1 AND batch_id=$2",
      [input.operationId, batchId],
    )
  ).rows[0];
}
async function noCompletion(batchId) {
  assert.deepEqual(
    (
      await db.query(
        "SELECT 1 FROM leaderboard_pipeline.derived_retirement_receipts WHERE operation_id=$1 AND batch_id=$2",
        [input.operationId, batchId],
      )
    ).rows,
    [],
  );
}

for (const onlyDispatch of [false, true]) {
  test(`metadata rewrite preserves retired ${onlyDispatch ? "dispatch-only" : "head and dispatch"} causal rows and unchanged write guards`, async () => {
    await seed();
    if (onlyDispatch) await db.query("DELETE FROM leaderboard_pipeline.heads");
    await retire();
    const tables = ["snapshots", "dispatch_publications", ...(onlyDispatch ? [] : ["heads"])];
    const originalRows = await retainedRows(db),
      originalGuards = await guards();
    await deniedUpdates(tables);
    await migratePipeline(db);
    await assertPipelineStorage(db);
    await lookupDigests();
    assert.deepEqual(await retainedRows(db), originalRows);
    assert.deepEqual(await guards(), originalGuards);
    await deniedUpdates(tables);
    await migratePipeline(db);
    assert.deepEqual(await retainedRows(db), originalRows);
  });
}

test("the same unretired scope upgrades and retains its ordinary authorized update behavior", async () => {
  await seed();
  const originalRows = await retainedRows(db),
    originalGuards = await guards();
  await migratePipeline(db);
  await lookupDigests();
  await db.query("UPDATE leaderboard_pipeline.heads SET revision=revision");
  await db.query("UPDATE leaderboard_pipeline.dispatch_publications SET scope_key=scope_key");
  assert.deepEqual(await retainedRows(db), originalRows);
  assert.deepEqual(await guards(), originalGuards);
});

test("each retired metadata rewrite rolls back atomically and leaves all original fences effective on retry", async () => {
  await seed();
  await retire();
  const originalRows = await retainedRows(db),
    originalSchema = await schemaState(db),
    originalGuards = await guards();
  for (const table of ["heads", "dispatch_publications", "receipts"]) {
    let injected = false;
    intercept = async (tx, sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.startsWith(`ALTER TABLE leaderboard_pipeline.${table} ALTER COLUMN`) && sql.includes("TYPE bytea")) {
        injected = true;
        throw new Error("SYNTHETIC_METADATA_REWRITE_INTERRUPTION");
      }
      return result;
    };
    await assert.rejects(migratePipeline(db), /SYNTHETIC_METADATA_REWRITE_INTERRUPTION/);
    intercept = null;
    assert.equal(injected, true, table);
    assert.deepEqual(await retainedRows(db), originalRows);
    assert.deepEqual(await schemaState(db), originalSchema);
    assert.deepEqual(await guards(), originalGuards);
    await deniedUpdates(["heads", "dispatch_publications", "snapshots"]);
  }
  await migratePipeline(db);
  await lookupDigests();
  assert.deepEqual(await retainedRows(db), originalRows);
});

for (const upgrade of [false, true]) {
  test(`a committed legacy heads manifest retries exactly after ${upgrade ? "the full v2 metadata upgrade" : "an ordinary interrupted handoff"}`, async (t) => {
    const { local, batchId, saved } = await pendingHead(t);
    const originalRows = await retainedRows(db),
      originalGuards = await guards();
    await deniedUpdates(["heads", "snapshots"]);
    if (upgrade) {
      await migratePipeline(db);
      await lookupDigests();
      assert.deepEqual(await retainedRows(db), originalRows);
      assert.deepEqual(await guards(), originalGuards);
      await deniedUpdates(["heads", "snapshots"]);
    }
    local.reopen();
    const restarted = new PipelineDerivedRetirementStore(db, local.store);
    const result = await restarted.eraseBatch(input, batchId, 1, approved);
    assert.equal(result.stage, "heads");
    assert.equal(result.removed, 1);
    assert.equal(result.alreadyAbsent, 0);
    assert.equal(result.manifestHash, saved.document_hash);
    assert.deepEqual(await savedManifest(batchId), saved);
    assert.deepEqual(await restarted.eraseBatch(input, batchId, 1, approved), result);
    assert.deepEqual((await db.query("SELECT * FROM leaderboard_pipeline.heads")).rows, []);
  });
}

test("only validated lookup metadata is excluded from a legacy manifest; a new payload field still blocks deletion", async (t) => {
  const { local, batchId, saved } = await pendingHead(t);
  await migratePipeline(db);
  await db.query(
    "ALTER TABLE leaderboard_pipeline.heads ADD COLUMN synthetic_payload text DEFAULT 'SYNTHETIC_NEW_PAYLOAD'",
  );
  const rows = await retainedRows(db);
  await assert.rejects(
    new PipelineDerivedRetirementStore(db, local.store).eraseBatch(input, batchId, 1, approved),
    /derived_row_changed/,
  );
  assert.deepEqual(await retainedRows(db), rows);
  assert.deepEqual(await savedManifest(batchId), saved);
  await noCompletion(batchId);
});

test("an edited v2 digest constraint cannot authorize an old pending manifest", async (t) => {
  const { local, batchId, saved } = await pendingHead(t);
  await migratePipeline(db);
  await db.query("ALTER TABLE leaderboard_pipeline.heads DROP CONSTRAINT heads_scope_hash_valid");
  const rows = await retainedRows(db);
  await assert.rejects(
    new PipelineDerivedRetirementStore(db, local.store).eraseBatch(input, batchId, 1, approved),
    /pipeline_storage_schema_invalid/,
  );
  assert.deepEqual(await retainedRows(db), rows);
  assert.deepEqual(await savedManifest(batchId), saved);
  await noCompletion(batchId);
});

for (const roles of [false, true]) {
  test(`maximum v${roles ? 3 : 2} retirement uses bounded receipt and head indexes with exact original keys`, async (t) => {
    const retained = await seed({ scope: capacityScope(roles), upgraded: true, causal: false });
    assert.equal(retained.key.length, roles ? 13895 : 13796);
    const local = await controls(t);
    await retire();
    const queries = [];
    intercept = async (tx, sql, params) => {
      if (
        (sql.includes("FROM leaderboard_pipeline.receipts") && sql.includes("kind='snapshot_published'")) ||
        (/^(SELECT \* FROM|DELETE FROM) leaderboard_pipeline\.heads WHERE /.test(sql) && sql.includes("scope_key=$1"))
      ) {
        await tx.query("SET LOCAL enable_seqscan=off");
        const plan = (await tx.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows;
        const expected = sql.includes("pipeline.receipts") ? "receipts_operation_hash_key" : "heads_pkey";
        assert.match(JSON.stringify(plan), new RegExp(expected), "the actual query must retain a bounded lookup plan");
        assert.ok(sql.includes(sql.includes("pipeline.receipts") ? "operation_key=$1" : "scope_key=$1"));
        queries.push({ sql, params: [...params] });
      }
      return tx.query(sql, params);
    };
    const eraser = new PipelineDerivedRetirementStore(db, local.store);
    const results = [];
    for (let index = 0; index < 12; index++) {
      const result = await eraser.eraseBatch(input, `synthetic-long-${index}`, 1, approved);
      results.push(result);
      if (result.status !== "applied") break;
    }
    intercept = null;
    assert.equal(results.at(-1).status, "owned_scope_erased");
    assert.ok(
      queries.some(({ sql, params }) => sql.includes("kind='snapshot_published'") && params[0] === retained.operation),
    );
    assert.ok(
      queries.some(
        ({ sql, params }) => sql.startsWith("SELECT * FROM leaderboard_pipeline.heads") && params[0] === retained.key,
      ),
    );
    assert.ok(
      queries.some(
        ({ sql, params }) => sql.startsWith("DELETE FROM leaderboard_pipeline.heads") && params[0] === retained.key,
      ),
    );
    assert.deepEqual((await db.query("SELECT receipt_id,operation_key FROM leaderboard_pipeline.receipts")).rows, [
      { receipt_id: retained.receiptId, operation_key: retained.operation },
    ]);
    local.reopen();
    assert.deepEqual(
      await new PipelineDerivedRetirementStore(db, local.store).eraseBatch(input, results.at(-1).batchId, 1, approved),
      results.at(-1),
    );
  });
}

test(
  "PostgreSQL: the exclusive metadata upgrade waits for an actual retirement schema observation and preserves its pending retry",
  {
    skip: process.env.PIPELINE_SCOPE_STORAGE_TEST_DATABASE_URL
      ? false
      : "independent PostgreSQL connections require the dedicated disposable service",
    timeout: 30000,
  },
  async (t) => {
    const { local, batchId, saved } = await pendingHead(t);
    let entered, release, started;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    let readerPid,
      writerPid,
      held = false;
    intercept = async (tx, sql, params) => {
      const result = await tx.query(sql, params);
      if (!held && sql.startsWith("LOCK TABLE leaderboard_pipeline.heads,") && sql.endsWith("IN ACCESS SHARE MODE")) {
        held = true;
        readerPid = Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        entered();
        await releasePromise;
      }
      return result;
    };
    const erasing = new PipelineDerivedRetirementStore(db, local.store).eraseBatch(input, batchId, 1, approved).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let migrating, erased, migrated;
    try {
      await Promise.race([
        enteredPromise,
        erasing.then(({ error }) => {
          throw error ?? new Error("SYNTHETIC_RETIREMENT_ENDED_BEFORE_LOCK");
        }),
      ]);
      migrating = migratePipeline({
        transaction: (work) =>
          h.db.transaction(async (tx) => {
            writerPid = Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            started();
            return work(tx);
          }),
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await startedPromise;
      assert.notEqual(writerPid, readerPid);
      let observedWait = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const row = (
          await h.db.query(
            "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1",
            [writerPid],
          )
        ).rows[0];
        if (row?.wait_event_type === "Lock" && row.blockers.map(Number).includes(readerPid)) {
          observedWait = true;
          break;
        }
        await delay(20);
      }
      assert.equal(observedWait, true, "actual different backend waits on the retirement transaction's table lock");
    } finally {
      release();
      [erased, migrated] = await Promise.all([erasing, migrating]);
      intercept = null;
    }
    assert.ifError(erased.error);
    assert.ifError(migrated?.error);
    assert.equal(erased.value.removed, 1);
    assert.equal(erased.value.manifestHash, saved.document_hash);
    assert.deepEqual(await savedManifest(batchId), saved);
    await assertPipelineStorage(db);
    await lookupDigests();
  },
);
