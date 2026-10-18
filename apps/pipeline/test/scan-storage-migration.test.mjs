import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { migratePipeline } from "../src/index.mjs";
import { migratePipeline as migrateScopeStorage, assertPipelineStorage } from "../src/scope-storage.mjs";
import { scanContinuationSchema } from "../src/scan-continuation.mjs";
import { retainedRows, schemaState, seedRetained, storageDatabase } from "./scope-storage-harness.mjs";

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
const version = async () => (await db.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows;
const scanTable = async () =>
  (await db.query("SELECT to_regclass('leaderboard_pipeline.scan_continuations') AS name")).rows[0].name;

test("worker initialization preserves the exact completed v2 migration receipt and retained scan across retries", async () => {
  const retained = await seedRetained(db);
  await migrateScopeStorage(db);
  const originalVersion = await version();
  const originalRows = await retainedRows(db);
  assert.equal(await scanTable(), null);
  await migratePipeline(db);
  await assertPipelineStorage(db);
  assert.equal(await scanTable(), "leaderboard_pipeline.scan_continuations");
  assert.deepEqual(await version(), originalVersion);
  assert.deepEqual(await retainedRows(db), { ...originalRows, scan_continuations: [] });
  await db.query(
    `INSERT INTO leaderboard_pipeline.scan_continuations
     (configuration_key,context_hash,cycle_token,scope_heads,event_cutoff,observation_cutoff)
     VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
    [
      "a".repeat(64),
      "b".repeat(64),
      "00000000-0000-4000-8000-000000000001",
      JSON.stringify({ [retained.key]: retained.snapshotId }),
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:01.000Z",
    ],
  );
  const withScan = await retainedRows(db);
  const shape = await schemaState(db);
  await migratePipeline(db);
  assert.deepEqual(await version(), originalVersion);
  assert.deepEqual(await retainedRows(db), withScan);
  assert.deepEqual(await schemaState(db), shape);
});

test("future or edited storage versions prevent worker schema initialization without changing retained state", async () => {
  for (const mutation of ["version", "checksum"]) {
    await h.reset();
    await seedRetained(db);
    await migrateScopeStorage(db);
    await db.query(
      mutation === "version"
        ? "UPDATE leaderboard_pipeline.storage_migrations SET version='pipeline-storage/v999'"
        : "UPDATE leaderboard_pipeline.storage_migrations SET migration_hash='SYNTHETIC_EDITED_CHECKSUM'",
    );
    const originalVersion = await version();
    const rows = await retainedRows(db);
    const shape = await schemaState(db);
    await assert.rejects(migratePipeline(db), /unsupported_pipeline_storage_schema/);
    assert.equal(await scanTable(), null);
    assert.deepEqual(await version(), originalVersion);
    assert.deepEqual(await retainedRows(db), rows);
    assert.deepEqual(await schemaState(db), shape);
  }
});

test("interrupted worker schema creation retains the committed v2 upgrade and retries without a new fingerprint", async () => {
  await seedRetained(db);
  const rows = await retainedRows(db);
  let injected = false;
  let committedVersion;
  const interrupted = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: async (sql, parameters) => {
            const result = await tx.query(sql, parameters);
            if (sql === scanContinuationSchema) {
              committedVersion = (await tx.query("SELECT * FROM leaderboard_pipeline.storage_migrations")).rows;
              injected = true;
              throw new Error("SYNTHETIC_SCAN_SCHEMA_INTERRUPTION");
            }
            return result;
          },
        }),
      ),
  };
  await assert.rejects(migratePipeline(interrupted), /SYNTHETIC_SCAN_SCHEMA_INTERRUPTION/);
  assert.equal(injected, true, "the actual scan-table DDL must run after the storage upgrade commits");
  await assertPipelineStorage(db);
  assert.equal(await scanTable(), null, "the interrupted scan-table transaction must roll back");
  assert.deepEqual(await version(), committedVersion);
  assert.deepEqual(await retainedRows(db), rows);
  await migratePipeline(db);
  assert.deepEqual(await version(), committedVersion);
  assert.deepEqual(await retainedRows(db), { ...rows, scan_continuations: [] });
});
