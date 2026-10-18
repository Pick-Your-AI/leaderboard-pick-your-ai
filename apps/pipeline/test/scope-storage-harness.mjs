// SYNTHETIC compatibility fixtures; no provider, account or production database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { canonicalPublicScope, publicContributionRoles, publicScopeKey } from "@pick-your-ai/contracts";
import { postgresDatabase } from "@pick-your-ai/ingestion";

export const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
export const baseScope = { organization: "SYNTHETIC", repository: null, workstream: null, start: null, end: null };
export const projects = Array.from({ length: 100 }, (_, index) =>
  createHash("sha512").update(`SYNTHETIC_PIPELINE_SCOPE_${index}`).digest("hex"),
);
export function capacityScope(roles = false) {
  return canonicalPublicScope({
    organization: "S".repeat(200),
    repository: "R".repeat(200),
    workstream: "W".repeat(200),
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-12-31T23:59:59.999Z",
    context: "current",
    projects,
    ...(roles ? { roles: publicContributionRoles } : {}),
  });
}
export const legacySQL = await readFile(
  new URL("../../../tests/fixtures/pipeline-storage-v1.sql", import.meta.url),
  "utf8",
);
const ingestionSQL = await Promise.all(
  ["001_ingestion", "002_snapshots", "003_collection", "004_outbox_dispatch"].map((name) =>
    readFile(new URL(`../../../packages/ingestion/sql/${name}.up.sql`, import.meta.url), "utf8"),
  ),
);

export async function storageDatabase() {
  const external = process.env.PIPELINE_SCOPE_STORAGE_TEST_DATABASE_URL;
  let engine, administration, name, directory;
  if (external) {
    const url = new URL(external);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "test database must be on loopback");
    assert.match(url.pathname, /^\/leaderboard(?:_[a-z0-9]+)*_test$/, "test source must be explicitly disposable");
    assert.equal(url.search, "", "connection overrides are not accepted by this synthetic fixture");
    administration = new Pool({ connectionString: url.href });
    name = `leaderboard_scope_${randomUUID().replaceAll("-", "")}_test`;
    assert.match(name, /^leaderboard_scope_[a-f0-9]{32}_test$/);
    assert.equal((await administration.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rows.length, 0);
    await administration.query(`CREATE DATABASE "${name}"`);
    url.pathname = "/" + name;
    engine = new Pool({ connectionString: url.href });
  } else {
    directory = await mkdtemp(join(tmpdir(), "leaderboard-scope-storage-"));
    engine = new PGlite(join(directory, "postgres"));
  }
  const db = external
    ? postgresDatabase(engine)
    : {
        query: (sql, parameters) => engine.query(sql, parameters),
        transaction: (work) =>
          engine.transaction((tx) => work({ query: (sql, parameters) => tx.query(sql, parameters) })),
      };
  const exec = (sql) => (external ? engine.query(sql) : engine.exec(sql));
  try {
    for (const sql of ingestionSQL) await exec(sql);
  } catch (error) {
    await close();
    throw error;
  }
  async function close() {
    await (external ? engine?.end() : engine?.close());
    engine = null;
    if (administration) {
      // Only the database created by this invocation is ever removed.
      await administration.query(`DROP DATABASE "${name}"`);
      await administration.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return {
    db,
    exec,
    close,
    external: Boolean(external),
    get engine() {
      return engine;
    },
    async reset() {
      await exec("DROP SCHEMA IF EXISTS leaderboard_pipeline CASCADE");
      await exec(legacySQL);
    },
    async reopen() {
      assert.equal(Boolean(external), false, "a file reopen is a PGlite-specific check");
      await engine.close();
      engine = new PGlite(join(directory, "postgres"));
    },
  };
}

export async function retainedRows(db) {
  const names = (
    await db.query(`SELECT tablename FROM pg_tables
    WHERE schemaname='leaderboard_pipeline' AND tablename<>'storage_migrations' ORDER BY tablename`)
  ).rows;
  const result = {};
  for (const { tablename } of names) {
    assert.match(tablename, /^[a-z_]+$/);
    result[tablename] = (
      await db.query(`SELECT to_jsonb(saved)-'scope_hash'-'operation_hash' AS row
      FROM leaderboard_pipeline.${tablename} AS saved ORDER BY (to_jsonb(saved)-'scope_hash'-'operation_hash')::text`)
    ).rows.map(({ row }) => row);
  }
  return result;
}

export async function schemaState(db) {
  return (
    await db.query(`
    SELECT 'column' AS kind,table_name||'.'||column_name AS name,
      concat_ws(':',ordinal_position,data_type,is_nullable,column_default) AS definition
    FROM information_schema.columns WHERE table_schema='leaderboard_pipeline'
    UNION ALL
    SELECT 'constraint',r.relname||'.'||c.conname,pg_get_constraintdef(c.oid)
    FROM pg_constraint AS c JOIN pg_class AS r ON r.oid=c.conrelid
    WHERE r.relnamespace='leaderboard_pipeline'::regnamespace
    UNION ALL
    SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='leaderboard_pipeline'
    ORDER BY kind,name,definition`)
  ).rows;
}

export async function seedRetained(db, scope = baseScope, label = "SYNTHETIC_RETAINED") {
  const key = publicScopeKey(scope);
  const snapshotId = hash(`${label}:snapshot`);
  const dispatchKey = hash(`${label}:dispatch`);
  const document = { synthetic: true, scope, snapshot: { snapshotId, revision: 1 }, label };
  const operation = `publish:${key}:${snapshotId}`;
  const kind = "snapshot_published";
  const receiptId = hash(JSON.stringify([operation, kind]));
  await db.query(
    `INSERT INTO leaderboard_pipeline.snapshots
    (snapshot_id,scope_key,revision,config_version,repository_ids,document,document_hash)
    VALUES($1,$2,1,'SYNTHETIC_CONFIG','[2]'::jsonb,$3::jsonb,$4)`,
    [snapshotId, key, JSON.stringify(document), hash(JSON.stringify(document))],
  );
  const upgraded =
    (
      await db.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='leaderboard_pipeline' AND table_name='heads' AND column_name='scope_hash'`)
    ).rows.length === 1;
  await db.query(
    `INSERT INTO leaderboard_pipeline.heads(scope_key,snapshot_id,revision${upgraded ? ",scope_hash" : ""})
    VALUES($1,$2,1${upgraded ? ",sha256(convert_to($1,'UTF8'))" : ""})`,
    [key, snapshotId],
  );
  await db.query(
    `INSERT INTO leaderboard_pipeline.dispatch_publications(operation_key,scope_key,snapshot_id${upgraded ? ",scope_hash" : ""})
    VALUES($1,$2,$3${upgraded ? ",sha256(convert_to($2,'UTF8'))" : ""})`,
    [dispatchKey, key, snapshotId],
  );
  await db.query(
    `INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash${upgraded ? ",operation_hash" : ""})
    VALUES($1,$2,$3,$4::jsonb,$5${upgraded ? ",sha256(convert_to($2,'UTF8'))" : ""})`,
    [receiptId, operation, kind, JSON.stringify(document), hash(JSON.stringify(document))],
  );
  await db.query(
    `INSERT INTO leaderboard_pipeline.frozen_inputs(snapshot_id,document,document_hash)
    VALUES($1,$2::jsonb,$3)`,
    [snapshotId, JSON.stringify(document), hash(JSON.stringify(document))],
  );
  return { key, snapshotId, dispatchKey, operation, receiptId, document };
}
