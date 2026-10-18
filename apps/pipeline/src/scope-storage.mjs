import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
export const pipelineStorageVersion = "pipeline-storage/v2";

/** SQL parameters remain parameters; the digest is only a bounded lookup key. */
export function pipelineKeySQL(parameter) {
  if (typeof parameter !== "string" || !/^\$[1-9][0-9]*$/.test(parameter))
    throw new Error("invalid_pipeline_key_parameter");
  return `pg_catalog.sha256(pg_catalog.convert_to(${parameter}, 'UTF8'))`;
}

// Preserve existing monitor identities. Longer public keys use a namespaced,
// bounded digest before entering the monitor's existing private-input guard.
export function publicationMonitorIdentity(scopeKey) {
  return scopeKey.length <= 200 ? scopeKey : `pipeline-scope/v1:${hash(scopeKey)}`;
}

const legacyStatements = [
  "CREATE SCHEMA IF NOT EXISTS leaderboard_pipeline",
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.source_modes (fact_key text PRIMARY KEY REFERENCES leaderboard_ingestion.source_facts(fact_key), data_mode text NOT NULL CHECK(data_mode IN ('public','synthetic')))`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.normalizations (
    fact_key text NOT NULL, policy_signature text NOT NULL, document jsonb NOT NULL,
    document_hash text NOT NULL, PRIMARY KEY (fact_key, policy_signature))`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.source_artifacts (
    fact_key text NOT NULL REFERENCES leaderboard_ingestion.source_facts(fact_key),
    artifact_id text NOT NULL, PRIMARY KEY (fact_key, artifact_id))`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.receipts (
    receipt_id text PRIMARY KEY, operation_key text UNIQUE NOT NULL, kind text NOT NULL,
    document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.corrections (
    request_id text PRIMARY KEY, fact_id text NOT NULL, artifact_id text NOT NULL,
    repository_id bigint NOT NULL, document jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.snapshots (
    snapshot_id text PRIMARY KEY, scope_key text NOT NULL, revision bigint NOT NULL,
    config_version text NOT NULL, repository_ids jsonb NOT NULL,
    document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.dispatch_publications (
    operation_key text NOT NULL, scope_key text NOT NULL,
    snapshot_id text NOT NULL REFERENCES leaderboard_pipeline.snapshots(snapshot_id),
    PRIMARY KEY(operation_key,scope_key))`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.frozen_inputs (snapshot_id text PRIMARY KEY REFERENCES leaderboard_pipeline.snapshots(snapshot_id), document jsonb NOT NULL, document_hash text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.policy_comparisons (comparison_id text PRIMARY KEY, document jsonb NOT NULL, document_hash text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.heads (
    scope_key text PRIMARY KEY, snapshot_id text NOT NULL REFERENCES leaderboard_pipeline.snapshots(snapshot_id), revision bigint NOT NULL)`,
];

const upgrades = [
  "ALTER TABLE leaderboard_pipeline.heads ADD COLUMN scope_hash bytea",
  "ALTER TABLE leaderboard_pipeline.dispatch_publications ADD COLUMN scope_hash bytea",
  "ALTER TABLE leaderboard_pipeline.receipts ADD COLUMN operation_hash bytea",
  `UPDATE leaderboard_pipeline.heads SET scope_hash=pg_catalog.sha256(pg_catalog.convert_to(scope_key, 'UTF8'))`,
  `UPDATE leaderboard_pipeline.dispatch_publications SET scope_hash=pg_catalog.sha256(pg_catalog.convert_to(scope_key, 'UTF8'))`,
  `UPDATE leaderboard_pipeline.receipts SET operation_hash=pg_catalog.sha256(pg_catalog.convert_to(operation_key, 'UTF8'))`,
  `ALTER TABLE leaderboard_pipeline.heads ALTER COLUMN scope_hash SET NOT NULL,
    ADD CONSTRAINT heads_scope_hash_valid CHECK (scope_hash=pg_catalog.sha256(pg_catalog.convert_to(scope_key, 'UTF8')))`,
  `ALTER TABLE leaderboard_pipeline.dispatch_publications ALTER COLUMN scope_hash SET NOT NULL,
    ADD CONSTRAINT dispatch_publications_scope_hash_valid CHECK (scope_hash=pg_catalog.sha256(pg_catalog.convert_to(scope_key, 'UTF8')))`,
  `ALTER TABLE leaderboard_pipeline.receipts ALTER COLUMN operation_hash SET NOT NULL,
    ADD CONSTRAINT receipts_operation_hash_valid CHECK (operation_hash=pg_catalog.sha256(pg_catalog.convert_to(operation_key, 'UTF8')))`,
  "ALTER TABLE leaderboard_pipeline.heads DROP CONSTRAINT heads_pkey",
  "ALTER TABLE leaderboard_pipeline.heads ADD CONSTRAINT heads_pkey PRIMARY KEY(scope_hash)",
  "ALTER TABLE leaderboard_pipeline.dispatch_publications DROP CONSTRAINT dispatch_publications_pkey",
  `ALTER TABLE leaderboard_pipeline.dispatch_publications
    ADD CONSTRAINT dispatch_publications_pkey PRIMARY KEY(operation_key,scope_hash)`,
  "ALTER TABLE leaderboard_pipeline.receipts DROP CONSTRAINT receipts_operation_key_key",
  `ALTER TABLE leaderboard_pipeline.receipts
    ADD CONSTRAINT receipts_operation_hash_key UNIQUE(operation_hash)`,
];
const migrationHash = hash(JSON.stringify([pipelineStorageVersion, legacyStatements, upgrades]));
const tables = ["heads", "dispatch_publications", "receipts"];
const invalid = () => {
  throw new Error("pipeline_storage_schema_invalid");
};

async function validateShape(tx, upgraded) {
  const columns = (
    await tx.query(
      `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
       WHERE table_schema='leaderboard_pipeline' AND table_name=ANY($1::text[])`,
      [tables],
    )
  ).rows;
  const expectedColumns = [
    ["heads", "scope_key", "text"],
    ["heads", "snapshot_id", "text"],
    ["heads", "revision", "bigint"],
    ["dispatch_publications", "operation_key", "text"],
    ["dispatch_publications", "scope_key", "text"],
    ["dispatch_publications", "snapshot_id", "text"],
    ["receipts", "receipt_id", "text"],
    ["receipts", "operation_key", "text"],
    ["receipts", "kind", "text"],
    ["receipts", "document", "jsonb"],
    ["receipts", "document_hash", "text"],
    ...(upgraded
      ? [
          ["heads", "scope_hash", "bytea"],
          ["dispatch_publications", "scope_hash", "bytea"],
          ["receipts", "operation_hash", "bytea"],
        ]
      : []),
  ];
  for (const [table, name, type] of expectedColumns) {
    const column = columns.find((row) => row.table_name === table && row.column_name === name);
    if (!column || column.data_type !== type || column.is_nullable !== "NO") invalid();
  }
  if (!upgraded && columns.some((row) => ["scope_hash", "operation_hash"].includes(row.column_name))) invalid();
  // Catalog names must cross the driver boundary as text[], preserving their
  // exact order; pg otherwise returns the unregistered name[] type as a string.
  const constraints = (
    await tx.query(
      `SELECT relation.relname AS table_name,constraint_row.conname AS name,
         constraint_row.contype AS type,constraint_row.convalidated AS validated,
         constraint_row.condeferrable AS deferrable,
          ARRAY(SELECT attribute.attname::text FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum,position)
           JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid=relation.oid AND attribute.attnum=key.attnum
           ORDER BY key.position) AS columns,
         pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_catalog.pg_constraint AS constraint_row
       JOIN pg_catalog.pg_class AS relation ON relation.oid=constraint_row.conrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='leaderboard_pipeline' AND relation.relname=ANY($1::text[])`,
      [tables],
    )
  ).rows;
  const required = [
    ["heads", "heads_pkey", "p", [upgraded ? "scope_hash" : "scope_key"]],
    [
      "dispatch_publications",
      "dispatch_publications_pkey",
      "p",
      ["operation_key", upgraded ? "scope_hash" : "scope_key"],
    ],
    ["receipts", "receipts_pkey", "p", ["receipt_id"]],
    [
      "receipts",
      upgraded ? "receipts_operation_hash_key" : "receipts_operation_key_key",
      "u",
      [upgraded ? "operation_hash" : "operation_key"],
    ],
  ];
  for (const [table, name, type, keys] of required) {
    const constraint = constraints.find((row) => row.table_name === table && row.name === name);
    if (
      !constraint ||
      constraint.type !== type ||
      !constraint.validated ||
      constraint.deferrable ||
      JSON.stringify(constraint.columns) !== JSON.stringify(keys)
    )
      invalid();
  }
  if (!upgraded) return;
  for (const [table, raw, hashed] of [
    ["heads", "scope_key", "scope_hash"],
    ["dispatch_publications", "scope_key", "scope_hash"],
    ["receipts", "operation_key", "operation_hash"],
  ]) {
    const constraint = constraints.find((row) => row.table_name === table && row.name === `${table}_${hashed}_valid`);
    const expression = `CHECK ((${hashed} = sha256(convert_to(${raw}, 'UTF8'::name))))`;
    if (
      !constraint ||
      constraint.type !== "c" ||
      !constraint.validated ||
      constraint.deferrable ||
      constraint.definition.replace(/\s+/g, "") !== expression.replace(/\s+/g, "")
    )
      invalid();
  }
  // A leftover raw B-tree key would still reject large values, including an
  // included column. Hash indexes cannot replace the required uniqueness.
  const rawIndexes = (
    await tx.query(
      `SELECT index_relation.relname AS name FROM pg_catalog.pg_index AS index_row
       JOIN pg_catalog.pg_class AS relation ON relation.oid=index_row.indrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
       JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid=index_row.indexrelid
       JOIN pg_catalog.pg_am AS method ON method.oid=index_relation.relam
       JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid=relation.oid
         AND attribute.attnum=ANY(index_row.indkey)
       WHERE namespace.nspname='leaderboard_pipeline' AND method.amname='btree'
         AND ((relation.relname IN ('heads','dispatch_publications') AND attribute.attname='scope_key')
           OR (relation.relname='receipts' AND attribute.attname='operation_key')) LIMIT 1`,
    )
  ).rows;
  if (rawIndexes.length) invalid();
}

async function validateRetainedIdentities(tx) {
  const broken = (
    await tx.query(
      `SELECT 'head' AS kind FROM leaderboard_pipeline.heads AS head
       LEFT JOIN leaderboard_pipeline.snapshots AS snapshot USING(snapshot_id)
       WHERE snapshot.snapshot_id IS NULL OR head.scope_key<>snapshot.scope_key OR head.revision<>snapshot.revision
       UNION ALL
       SELECT 'dispatch' AS kind FROM leaderboard_pipeline.dispatch_publications AS dispatch
       LEFT JOIN leaderboard_pipeline.snapshots AS snapshot USING(snapshot_id)
       WHERE snapshot.snapshot_id IS NULL OR dispatch.scope_key<>snapshot.scope_key LIMIT 1`,
    )
  ).rows;
  if (broken.length) throw new Error("pipeline_storage_retained_identity_invalid");
  // Bounded batches preserve the original literal key and derived receipt ID.
  // Receipt documents and all frozen/public/private representations stay intact.
  let after = null;
  while (true) {
    const rows = (
      await tx.query(
        `SELECT receipt_id,operation_key,kind FROM leaderboard_pipeline.receipts
         WHERE ($1::text IS NULL OR receipt_id>$1) ORDER BY receipt_id LIMIT 256`,
        [after],
      )
    ).rows;
    for (const row of rows) {
      if (hash(JSON.stringify([row.operation_key, row.kind])) !== row.receipt_id)
        throw new Error("pipeline_storage_retained_identity_invalid");
    }
    if (rows.length < 256) break;
    after = rows.at(-1).receipt_id;
  }
}

async function readVersion(tx) {
  return (await tx.query("SELECT version,migration_hash FROM leaderboard_pipeline.storage_migrations ORDER BY version"))
    .rows;
}
function currentVersion(rows) {
  return rows.length === 1 && rows[0].version === pipelineStorageVersion && rows[0].migration_hash === migrationHash;
}

/** Explicit, serialized upgrade of this application's retained schema only. */
export async function migratePipeline(db) {
  if (typeof db?.transaction !== "function") throw new Error("pipeline_storage_transaction_required");
  return db.transaction(async (tx) => {
    // Each waiter must observe the preceding committed migration after the
    // advisory lock opens, even when a pool has a stricter session default.
    await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('leaderboard-pipeline-storage-migration',0))");
    await tx.query("CREATE SCHEMA IF NOT EXISTS leaderboard_pipeline");
    await tx.query(`CREATE TABLE IF NOT EXISTS leaderboard_pipeline.storage_migrations (
      version text PRIMARY KEY,migration_hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const rows = await readVersion(tx);
    if (rows.length) {
      if (!currentVersion(rows)) throw new Error("unsupported_pipeline_storage_schema");
      await validateShape(tx, true);
      return;
    }
    for (const statement of legacyStatements) await tx.query(statement);
    // ALTER TABLE obtains the writer-excluding locks before any backfill. The
    // caller must stop old binaries; their raw-key ON CONFLICT is incompatible.
    await tx.query(
      "LOCK TABLE leaderboard_pipeline.heads,leaderboard_pipeline.dispatch_publications,leaderboard_pipeline.receipts IN ACCESS EXCLUSIVE MODE",
    );
    await validateShape(tx, false);
    await validateRetainedIdentities(tx);
    for (const statement of upgrades) await tx.query(statement);
    await validateShape(tx, true);
    await tx.query("INSERT INTO leaderboard_pipeline.storage_migrations(version,migration_hash) VALUES($1,$2)", [
      pipelineStorageVersion,
      migrationHash,
    ]);
  });
}

/** New code refuses a legacy, partial, edited or future schema before startup. */
export async function assertPipelineStorage(db) {
  const exists = (await db.query("SELECT to_regclass('leaderboard_pipeline.storage_migrations') AS name")).rows[0];
  if (!exists?.name || !currentVersion(await readVersion(db))) throw new Error("unsupported_pipeline_storage_schema");
  await validateShape(db, true);
}
