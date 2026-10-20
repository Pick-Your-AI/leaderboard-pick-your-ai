import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertPipelineStorage, pipelineKeySQL } from "./scope-storage.mjs";
import { lockIssueTransferRetirementDependencies, retireIssueTransferMetadata } from "./issue-transfer-store.mjs";

// Private host API. These are work/memory bounds, not retention windows.
export const derivedRetirementLimits = Object.freeze({ records: 100, documentBytes: 16 * 1024 * 1024 });
const stable = (value) =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const hash = (value) => createHash("sha256").update(stable(value)).digest("hex");
const same = (a, b) => stable(a) === stable(b);
const fail = (code) => {
  throw new Error(code);
};
const check = (value, code = "derived_retirement_integrity_error") => {
  if (!value) fail(code);
};
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const schema = "pipeline-derived-retirement/v1";

function request(value) {
  check(
    value &&
      positive(value.repositoryId) &&
      typeof value.expectedGeneration === "string" &&
      /^[1-9]\d{0,18}$/.test(value.expectedGeneration) &&
      BigInt(value.expectedGeneration) < 9223372036854775807n &&
      [value.operationId, value.policyVersion, value.authorizationReceipt, value.operatorId].every(token),
    "invalid_repository_retirement",
  );
  return Object.freeze({
    operationId: value.operationId,
    repositoryId: value.repositoryId,
    expectedGeneration: value.expectedGeneration,
    policyVersion: value.policyVersion,
    authorizationReceipt: value.authorizationReceipt,
    operatorId: value.operatorId,
  });
}
export function validateDerivedErasureBatch(batchId, limit) {
  check(
    token(batchId) && Number.isInteger(limit) && limit >= 1 && limit <= derivedRetirementLimits.records,
    "invalid_derived_erasure_batch",
  );
}

async function authorized(authorize, value) {
  check(typeof authorize === "function" && (await authorize(value)) === true, "retirement_not_authorized");
}
function repositoryIds(value) {
  check(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 10000 &&
      value.every(positive) &&
      new Set(value).size === value.length,
    "derived_source_binding_invalid",
  );
  return [...value].sort((a, b) => a - b);
}
function sourceIds(authorization) {
  check(Array.isArray(authorization?.sources) && authorization.sources.length > 0, "derived_source_binding_invalid");
  return repositoryIds(
    authorization.sources.map((source) => {
      check(
        typeof source?.repositoryId === "string" &&
          /^[1-9]\d{0,15}$/.test(source.repositoryId) &&
          typeof source.generation === "string" &&
          /^[1-9]\d{0,18}$/.test(source.generation),
        "derived_source_binding_invalid",
      );
      return Number(source.repositoryId);
    }),
  );
}
function stringRepositoryIds(ids) {
  check(
    Array.isArray(ids) && ids.every((id) => typeof id === "string" && /^[1-9]\d{0,15}$/.test(id)),
    "derived_source_binding_invalid",
  );
  return repositoryIds(ids.map(Number));
}
function document(value, expected) {
  if (typeof value === "string") {
    check(Buffer.byteLength(value) <= derivedRetirementLimits.documentBytes, "derived_document_limit");
    try {
      value = JSON.parse(value);
    } catch {
      fail("derived_retirement_integrity_error");
    }
  }
  const encoded = stable(value);
  check(encoded && Buffer.byteLength(encoded) <= derivedRetirementLimits.documentBytes, "derived_document_limit");
  if (expected !== undefined) check(isHash(expected) && hash(value) === expected);
  return value;
}
function boundSnapshot(doc, binding) {
  check(
    doc?.snapshot?.snapshotId === binding.snapshot_id && String(doc.snapshot.revision) === String(binding.revision),
  );
}
function boundAuthorization(doc, binding) {
  check(
    same(sourceIds(doc.authorization), repositoryIds(binding.repository_ids)) &&
      hash(doc.scope) === binding.engine_scope_hash,
    "derived_source_binding_invalid",
  );
  if (doc.input)
    check(
      same(stringRepositoryIds(doc.input.repositoryIds), repositoryIds(binding.repository_ids)) &&
        hash(doc.input) === binding.input_hash,
    );
  else check(doc.inputHash === binding.capture_hash && doc.scopeKey === binding.scope_key);
}

/** Apply once, after migratePipeline and ingestion 005. Never called by public requests. */
export async function migratePipelineDerivedRetirement(db) {
  const sql = await readFile(new URL("../sql/001_derived_retirement.up.sql", import.meta.url), "utf8");
  // Delimiters belong to this checked-in migration; semicolons inside PL/pgSQL
  // bodies stay intact. Both PG and embedded adapters execute one statement.
  return db.transaction(async (tx) => {
    for (const statement of sql.split("\n-- statement\n")) await tx.query(statement);
  });
}

/** Synchronous: must run inside the confirmation's existing SQLite transaction. */
export function assertPipelineSourcesNotRetired(controlsStore, ids) {
  const db = controlsStore.db;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_derived_retirements'").get())
    return;
  const query = db.prepare("SELECT 1 FROM pipeline_derived_retirements WHERE repository_id=?");
  for (const id of repositoryIds(ids)) check(!query.get(id), "pipeline_repository_retired");
}

function installSqlite(db) {
  // The owning runtime creates these payload tables. Absence is a capability
  // failure, never an empty-store deletion receipt.
  for (const name of ["policy_preview_inputs", "policy_previews", "pipeline_aggregate_explanations"])
    check(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
      "derived_sqlite_store_unavailable",
    );
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_derived_retirements (
      operation_id TEXT PRIMARY KEY,repository_id INTEGER NOT NULL UNIQUE,
      authority_hash TEXT NOT NULL,source_generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_derived_retirement_snapshots (
      snapshot_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,binding_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_derived_retirement_batches (
      operation_id TEXT NOT NULL,batch_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,
      document TEXT NOT NULL,document_hash TEXT NOT NULL,PRIMARY KEY(operation_id,batch_id));
    CREATE TRIGGER IF NOT EXISTS pipeline_retirement_input_fence BEFORE INSERT ON policy_preview_inputs
    BEGIN SELECT RAISE(ABORT,'pipeline_repository_retired') WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.document,'$.authorization.sources') AS source
      JOIN pipeline_derived_retirements AS retired
        ON CAST(json_extract(source.value,'$.repositoryId') AS TEXT)=CAST(retired.repository_id AS TEXT));
    SELECT RAISE(ABORT,'pipeline_snapshot_retired') WHERE EXISTS (
      SELECT 1 FROM pipeline_derived_retirement_snapshots
      WHERE snapshot_id=json_extract(NEW.document,'$.snapshot.snapshotId')); END;
    CREATE TRIGGER IF NOT EXISTS pipeline_retirement_input_update_fence BEFORE UPDATE ON policy_preview_inputs
    BEGIN SELECT RAISE(ABORT,'pipeline_repository_retired') WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.document,'$.authorization.sources') AS source
      JOIN pipeline_derived_retirements AS retired
        ON CAST(json_extract(source.value,'$.repositoryId') AS TEXT)=CAST(retired.repository_id AS TEXT));
    SELECT RAISE(ABORT,'pipeline_snapshot_retired') WHERE EXISTS (
      SELECT 1 FROM pipeline_derived_retirement_snapshots
      WHERE snapshot_id=json_extract(NEW.document,'$.snapshot.snapshotId')); END;
    CREATE TRIGGER IF NOT EXISTS pipeline_retirement_explanation_fence BEFORE INSERT ON pipeline_aggregate_explanations
    BEGIN SELECT RAISE(ABORT,'pipeline_repository_retired') WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.document,'$.authorization.sources') AS source
      JOIN pipeline_derived_retirements AS retired
        ON CAST(json_extract(source.value,'$.repositoryId') AS TEXT)=CAST(retired.repository_id AS TEXT));
    SELECT RAISE(ABORT,'pipeline_snapshot_retired') WHERE EXISTS (
      SELECT 1 FROM pipeline_derived_retirement_snapshots WHERE snapshot_id=NEW.snapshot_id); END;
    CREATE TRIGGER IF NOT EXISTS pipeline_retirement_explanation_update_fence BEFORE UPDATE ON pipeline_aggregate_explanations
    BEGIN SELECT RAISE(ABORT,'pipeline_repository_retired') WHERE EXISTS (
      SELECT 1 FROM json_each(NEW.document,'$.authorization.sources') AS source
      JOIN pipeline_derived_retirements AS retired
        ON CAST(json_extract(source.value,'$.repositoryId') AS TEXT)=CAST(retired.repository_id AS TEXT));
    SELECT RAISE(ABORT,'pipeline_snapshot_retired') WHERE EXISTS (
      SELECT 1 FROM pipeline_derived_retirement_snapshots WHERE snapshot_id=NEW.snapshot_id); END;
    CREATE TRIGGER IF NOT EXISTS pipeline_retirement_preview_fence BEFORE INSERT ON policy_previews
    BEGIN SELECT RAISE(ABORT,'derived_preview_input_missing') WHERE NOT EXISTS (
      SELECT 1 FROM policy_preview_inputs WHERE id=NEW.input_id);
    SELECT RAISE(ABORT,'pipeline_repository_retired') WHERE EXISTS (
      SELECT 1 FROM policy_preview_inputs AS input,json_each(input.document,'$.authorization.sources') AS source
      JOIN pipeline_derived_retirements AS retired
        ON CAST(json_extract(source.value,'$.repositoryId') AS TEXT)=CAST(retired.repository_id AS TEXT)
      WHERE input.id=NEW.input_id);
    SELECT RAISE(ABORT,'pipeline_snapshot_retired') WHERE EXISTS (
      SELECT 1 FROM pipeline_derived_retirement_snapshots
      WHERE snapshot_id=json_extract(NEW.document,'$.snapshot.snapshotId')); END;
    CREATE TRIGGER IF NOT EXISTS pipeline_retirement_preview_update_fence BEFORE UPDATE ON policy_previews
    BEGIN SELECT RAISE(ABORT,'derived_preview_input_missing') WHERE NOT EXISTS (
      SELECT 1 FROM policy_preview_inputs WHERE id=NEW.input_id);
    SELECT RAISE(ABORT,'pipeline_repository_retired') WHERE EXISTS (
      SELECT 1 FROM policy_preview_inputs AS input,json_each(input.document,'$.authorization.sources') AS source
      JOIN pipeline_derived_retirements AS retired
        ON CAST(json_extract(source.value,'$.repositoryId') AS TEXT)=CAST(retired.repository_id AS TEXT)
      WHERE input.id=NEW.input_id);
    SELECT RAISE(ABORT,'pipeline_snapshot_retired') WHERE EXISTS (
      SELECT 1 FROM pipeline_derived_retirement_snapshots
      WHERE snapshot_id=json_extract(NEW.document,'$.snapshot.snapshotId')); END;
  `);
  for (const table of [
    "pipeline_derived_retirements",
    "pipeline_derived_retirement_snapshots",
    "pipeline_derived_retirement_batches",
  ])
    for (const action of ["UPDATE", "DELETE"])
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT,'immutable_pipeline_retirement_record'); END;`);
}

const postgresStages = Object.freeze({
  comparisons: { table: "policy_comparisons", keys: ["comparison_id"], doc: true },
  frozen: { table: "frozen_inputs", keys: ["snapshot_id"], doc: true },
  heads: { table: "heads", keys: ["scope_key"] },
  snapshots: { table: "snapshots", keys: ["snapshot_id"], doc: true },
  artifacts: { table: "source_artifacts", keys: ["fact_key", "artifact_id"] },
  modes: { table: "source_modes", keys: ["fact_key"] },
  normalizations: { table: "normalizations", keys: ["fact_key", "policy_signature"], doc: true },
  corrections: { table: "corrections", keys: ["request_id"], doc: true },
  discussion_feedback_scans: { table: "discussion_feedback_scans", keys: ["repository_id", "scan_id"], doc: true },
  discussion_feedback_heads: { table: "discussion_feedback_heads", keys: ["repository_id"], doc: true },
});
// Read only source metadata while resolving legacy scope, in bounded pages.
const snapshotScopeQuery = `SELECT s.snapshot_id,s.scope_key,s.revision,s.repository_ids,s.document_hash,
  f.snapshot_id AS frozen_id,f.document_hash AS frozen_hash,
  f.document->'identityAuthorization'->'sources' AS sources,
  f.document->'frozen'->'repositoryIds' AS frozen_repository_ids,
  to_jsonb(r) AS registration
  FROM leaderboard_pipeline.snapshots s
  LEFT JOIN leaderboard_pipeline.frozen_inputs f USING(snapshot_id)
  LEFT JOIN leaderboard_pipeline.derived_retirement_snapshots r USING(snapshot_id)`;

const sqliteStages = Object.freeze({
  previews: { table: "policy_previews", key: "id" },
  preview_inputs: { table: "policy_preview_inputs", key: "id" },
  explanations: { table: "pipeline_aggregate_explanations", key: "snapshot_id" },
});
const progressColumns = `m.batch_id,m.batch_limit,m.document_hash AS manifest_hash,
  r.document_hash AS receipt_hash,
  LEFT(r.document->>'schemaVersion',129) AS receipt_schema,
  LEFT(r.document->>'operationId',129) AS receipt_operation,
  LEFT(r.document->>'repositoryId',17) AS receipt_repository,
  LEFT(r.document->>'batchId',129) AS receipt_batch,
  LEFT(r.document->>'manifestHash',65) AS receipt_manifest,
  LEFT(r.document->>'stage',65) AS receipt_stage,
  LEFT(r.document->>'status',33) AS receipt_status`;
const progressStages = new Set([
  ...Object.keys(postgresStages),
  ...Object.keys(sqliteStages),
  "register_snapshot",
  "confirmations",
  "complete",
  "retained_dispatch_authority",
]);
function progressBatch(row, value) {
  validateDerivedErasureBatch(row.batch_id, row.batch_limit);
  check(isHash(row.manifest_hash));
  let receipt = null;
  if (row.receipt_hash !== null) {
    check(
      isHash(row.receipt_hash) &&
        row.receipt_schema === schema &&
        row.receipt_operation === value.operationId &&
        row.receipt_repository === String(value.repositoryId) &&
        row.receipt_batch === row.batch_id &&
        row.receipt_manifest === row.manifest_hash &&
        progressStages.has(row.receipt_stage) &&
        row.receipt_status ===
          (row.receipt_stage === "complete"
            ? "owned_scope_erased"
            : row.receipt_stage === "retained_dispatch_authority"
              ? "blocked"
              : "applied"),
    );
    receipt = { hash: row.receipt_hash, stage: row.receipt_stage, status: row.receipt_status };
  }
  return { batchId: row.batch_id, limit: row.batch_limit, manifestHash: row.manifest_hash, receipt };
}

async function indexedStorage(tx) {
  // Keep this transaction's legacy/v2 decision valid through manifest selection
  // and application. The migrator holds the conflicting exclusive table locks.
  await tx.query(
    "LOCK TABLE leaderboard_pipeline.heads,leaderboard_pipeline.dispatch_publications,leaderboard_pipeline.receipts IN ACCESS SHARE MODE",
  );
  const versioned = (await tx.query("SELECT to_regclass('leaderboard_pipeline.storage_migrations') AS name")).rows[0];
  if (!versioned?.name) return false;
  await assertPipelineStorage(tx);
  return true;
}

function pgRecord(stage, row, indexed) {
  const spec = postgresStages[stage];
  if (spec.doc) document(row.document, row.document_hash);
  if (stage === "comparisons") check(row.comparison_id === row.document_hash);
  // Keep the original selected-row identity across the metadata-only upgrade.
  // Validate the new lookup digest before excluding it; every original field,
  // including opaque keys and scope metadata, still binds the legacy manifest.
  // Database timestamps are not payload-selection authority.
  const { created_at: _created, ...content } = row;
  if (stage === "heads" && indexed) {
    check(
      content.scope_hash instanceof Uint8Array &&
        Buffer.from(content.scope_hash).equals(createHash("sha256").update(content.scope_key, "utf8").digest()),
      "derived_scope_lookup_invalid",
    );
    delete content.scope_hash;
  }
  return { keys: spec.keys.map((key) => String(row[key])), hash: hash(content) };
}
function sqliteRecord(stage, row, binding, db) {
  const doc = document(row.document, row.digest);
  boundSnapshot(doc, binding);
  if (stage !== "previews") boundAuthorization(doc, binding);
  if (stage === "previews") {
    check(doc.inputId === row.input_id && doc.comparisonId === row.id);
    const inputRow = db.prepare("SELECT * FROM policy_preview_inputs WHERE id=?").get(row.input_id);
    check(inputRow, "derived_preview_input_missing");
    const input = document(inputRow.document, inputRow.digest);
    boundSnapshot(input, binding);
    boundAuthorization(input, binding);
    check(
      inputRow.id === inputRow.digest &&
        doc.inputHash === binding.input_hash &&
        doc.scopeHash === binding.engine_scope_hash,
      "derived_source_binding_invalid",
    );
  }
  if (stage === "preview_inputs") check(row.id === row.digest);
  if (stage === "explanations") check(row.snapshot_id === binding.snapshot_id);
  return { keys: [row[sqliteStages[stage].key]], hash: hash(row) };
}

/**
 * Erases only pipeline-owned derived rows. PostgreSQL plans precede deletion;
 * SQLite commits have their own immutable acknowledgement before the PG receipt.
 * A missing final receipt means pending work, including a possibly committed
 * SQLite stage. Exact retries inspect that acknowledgement, never count twice.
 */
export class PipelineDerivedRetirementStore {
  #db;
  #controlsStore;
  constructor(db, controlsStore) {
    this.#db = db;
    this.#controlsStore = controlsStore;
  }

  async #authority(tx, value) {
    const access = (
      await tx.query(
        "SELECT state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR UPDATE",
        [value.repositoryId],
      )
    ).rows[0];
    const row = (
      await tx.query("SELECT * FROM leaderboard_ingestion.repository_retirements WHERE operation_id=$1", [
        value.operationId,
      ])
    ).rows[0];
    check(row, "unknown_repository_retirement");
    check(
      String(row.repository_id) === String(value.repositoryId) &&
        String(row.expected_generation) === value.expectedGeneration &&
        row.policy_version === value.policyVersion &&
        row.authorization_receipt === value.authorizationReceipt &&
        row.operator_id === value.operatorId,
      "retirement_operation_conflict",
    );
    check(
      access &&
        access.state !== "public" &&
        BigInt(access.generation) >= BigInt(row.source_generation) &&
        BigInt(row.source_generation) > BigInt(value.expectedGeneration),
      "retirement_fence_unavailable",
    );
    return {
      operationId: value.operationId,
      repositoryId: value.repositoryId,
      sourceGeneration: String(row.source_generation),
      authorityHash: hash(value),
    };
  }

  async #transact(value, authorize, work) {
    await authorized(authorize, value);
    return this.#db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('pipeline-derived-retirement:v1'))");
      await lockIssueTransferRetirementDependencies(tx, value.repositoryId);
      const authority = await this.#authority(tx, value);
      await authorized(authorize, value);
      const result = await work(tx, authority, await indexedStorage(tx));
      await authorized(authorize, value);
      return result;
    });
  }

  async admit(input, authorize) {
    const value = request(input);
    const authority = await this.#transact(value, authorize, async (tx, binding) => {
      await tx.query(
        `INSERT INTO leaderboard_pipeline.derived_retirements
        (operation_id,repository_id,authority_hash,source_generation) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [binding.operationId, binding.repositoryId, binding.authorityHash, binding.sourceGeneration],
      );
      const saved = (
        await tx.query("SELECT * FROM leaderboard_pipeline.derived_retirements WHERE operation_id=$1", [
          value.operationId,
        ])
      ).rows[0];
      check(
        saved &&
          saved.authority_hash === binding.authorityHash &&
          String(saved.repository_id) === String(value.repositoryId) &&
          String(saved.source_generation) === binding.sourceGeneration,
        "retirement_operation_conflict",
      );
      return binding;
    });
    await authorized(authorize, value);
    this.#controlsStore.transaction(() => {
      const db = this.#controlsStore.db;
      installSqlite(db);
      db.prepare(
        `INSERT INTO pipeline_derived_retirements(operation_id,repository_id,authority_hash,source_generation)
        VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,
      ).run(authority.operationId, authority.repositoryId, authority.authorityHash, authority.sourceGeneration);
      const saved = db
        .prepare("SELECT * FROM pipeline_derived_retirements WHERE operation_id=?")
        .get(value.operationId);
      check(
        saved &&
          saved.repository_id === value.repositoryId &&
          saved.authority_hash === authority.authorityHash &&
          saved.source_generation === authority.sourceGeneration,
        "retirement_operation_conflict",
      );
    });
    return { ...authority, status: "derived_writes_fenced", meaning: "Admission is not a payload-removal receipt." };
  }

  /** Exact-operation metadata only; replay eraseBatch to obtain a verified receipt. */
  async readProgress(input, authorize, options = {}) {
    const value = request(input);
    check(
      options !== null &&
        typeof options === "object" &&
        !Array.isArray(options) &&
        Object.keys(options).length <= 1 &&
        Object.keys(options).every((key) => key === "batchId" || key === "afterBatchId"),
      "invalid_derived_progress_cursor",
    );
    const exact = Object.hasOwn(options, "batchId");
    const after = Object.hasOwn(options, "afterBatchId");
    if (exact) validateDerivedErasureBatch(options.batchId, 1);
    if (after) validateDerivedErasureBatch(options.afterBatchId, 1);
    return this.#transact(value, authorize, async (tx, authority) => {
      const admission = (
        await tx.query(
          "SELECT repository_id,authority_hash,source_generation FROM leaderboard_pipeline.derived_retirements" +
            " WHERE operation_id=$1",
          [value.operationId],
        )
      ).rows[0];
      if (admission)
        check(
          String(admission.repository_id) === String(value.repositoryId) &&
            admission.authority_hash === authority.authorityHash &&
            String(admission.source_generation) === authority.sourceGeneration,
          "retirement_operation_conflict",
        );
      if (exact) {
        const row = (
          await tx.query(
            "SELECT " +
              progressColumns +
              " FROM leaderboard_pipeline.derived_retirement_manifests m" +
              " LEFT JOIN leaderboard_pipeline.derived_retirement_receipts r USING(operation_id,batch_id)" +
              " WHERE m.operation_id=$1 AND m.batch_id=$2",
            [value.operationId, options.batchId],
          )
        ).rows[0];
        check(!row || admission, "retirement_operation_conflict");
        return {
          ...authority,
          admitted: Boolean(admission),
          batch: row ? progressBatch(row, value) : null,
          entries: [],
          nextCursor: null,
        };
      }
      // Select the bounded primary-key page before the receipt join. Filtering
      // for pending work before LIMIT would scan an unbounded completed history.
      const page = (
        await tx.query(
          "WITH page AS MATERIALIZED (" +
            "SELECT operation_id,batch_id,batch_limit,document_hash" +
            " FROM leaderboard_pipeline.derived_retirement_manifests WHERE operation_id=$1" +
            (after ? " AND batch_id>$2" : "") +
            " ORDER BY batch_id LIMIT 65)" +
            " SELECT " +
            progressColumns +
            " FROM page m LEFT JOIN leaderboard_pipeline.derived_retirement_receipts r" +
            " USING(operation_id,batch_id) ORDER BY m.batch_id",
          after ? [value.operationId, options.afterBatchId] : [value.operationId],
        )
      ).rows;
      check(!page.length || admission, "retirement_operation_conflict");
      const entries = page.slice(0, 64).map((row) => progressBatch(row, value));
      return {
        ...authority,
        admitted: Boolean(admission),
        batch: null,
        entries,
        nextCursor: page.length > 64 ? entries.at(-1).batchId : null,
      };
    });
  }

  async eraseBatch(input, batchId, limit, authorize) {
    const value = request(input);
    validateDerivedErasureBatch(batchId, limit);
    await this.admit(value, authorize);
    const retained = await this.#transact(value, authorize, async (tx, _authority, indexed) => {
      const prior = (
        await tx.query(
          `SELECT * FROM leaderboard_pipeline.derived_retirement_manifests
        WHERE operation_id=$1 AND batch_id=$2`,
          [value.operationId, batchId],
        )
      ).rows[0];
      if (prior) {
        check(prior.batch_limit === limit, "derived_batch_conflict");
        return { manifest: document(prior.document, prior.document_hash), digest: prior.document_hash };
      }
      const pending = (
        await tx.query(
          `SELECT m.batch_id FROM leaderboard_pipeline.derived_retirement_manifests m
        LEFT JOIN leaderboard_pipeline.derived_retirement_receipts r USING(operation_id,batch_id)
        WHERE m.operation_id=$1 AND r.batch_id IS NULL LIMIT 1`,
          [value.operationId],
        )
      ).rows[0];
      check(!pending, "derived_batch_pending");
      const complete = (
        await tx.query(
          `SELECT 1 FROM leaderboard_pipeline.derived_retirement_receipts
        WHERE operation_id=$1 AND document->>'stage' IN ('complete','retained_dispatch_authority') LIMIT 1`,
          [value.operationId],
        )
      ).rows[0];
      check(!complete, "derived_scope_disposition_already_recorded");
      const selected = await this.#select(tx, value, limit, indexed);
      const manifest = {
        schemaVersion: schema,
        operationId: value.operationId,
        repositoryId: value.repositoryId,
        authorityHash: hash(value),
        batchId,
        limit,
        ...selected,
      };
      check(
        manifest.records.length <= limit && Buffer.byteLength(stable(manifest)) <= 256 * 1024,
        "derived_manifest_limit",
      );
      const digest = hash(manifest);
      await tx.query(
        `INSERT INTO leaderboard_pipeline.derived_retirement_manifests
        (operation_id,batch_id,batch_limit,document,document_hash) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [value.operationId, batchId, limit, JSON.stringify(manifest), digest],
      );
      return { manifest, digest };
    });
    return this.#apply(value, authorize, retained.manifest, retained.digest);
  }

  async #checkSnapshotScope(tx, row) {
    let ids;
    try {
      check(
        row &&
          typeof row.snapshot_id === "string" &&
          row.snapshot_id.length > 0 &&
          row.snapshot_id.length <= 256 &&
          typeof row.scope_key === "string" &&
          row.scope_key.length > 0 &&
          /^[1-9]\d{0,15}$/.test(String(row.revision)) &&
          isHash(row.document_hash),
      );
      ids = repositoryIds(row.repository_ids);
      if (row.registration) {
        this.#checkBinding(row.registration, ids[0]);
        check(
          row.registration.snapshot_id === row.snapshot_id &&
            row.registration.scope_key === row.scope_key &&
            String(row.registration.revision) === String(row.revision) &&
            row.registration.document_hash === row.document_hash &&
            same(repositoryIds(row.registration.repository_ids), ids),
        );
      }
      if (row.frozen_id !== null) {
        check(
          row.frozen_id === row.snapshot_id &&
            isHash(row.frozen_hash) &&
            same(sourceIds({ sources: row.sources }), ids) &&
            same(stringRepositoryIds(row.frozen_repository_ids), ids),
        );
        if (row.registration) check(row.frozen_hash === row.registration.frozen_hash);
        return;
      }
      check(row.registration);
    } catch {
      fail("derived_unbound_payload");
    }
    // An absent frozen input is valid only after its exact stage was durably
    // acknowledged. A different authorized repository may have consumed the
    // shared snapshot: bind the stage/snapshot, not the registration's operator.
    const saved = (
      await tx.query(
        `SELECT m.operation_id,m.document AS manifest,m.document_hash AS manifest_hash,
      r.document AS receipt,r.document_hash AS receipt_hash
      FROM leaderboard_pipeline.derived_retirement_manifests m
      JOIN leaderboard_pipeline.derived_retirement_receipts r USING(operation_id,batch_id)
      WHERE m.document->>'stage'='frozen' AND m.document->>'snapshotId'=$1
      ORDER BY m.operation_id,m.batch_id LIMIT 1`,
        [row.snapshot_id],
      )
    ).rows[0];
    try {
      check(saved);
      const manifest = document(saved.manifest, saved.manifest_hash);
      const receipt = document(saved.receipt, saved.receipt_hash);
      check(
        manifest.schemaVersion === schema &&
          manifest.operationId === saved.operation_id &&
          manifest.snapshotId === row.snapshot_id &&
          ids.includes(manifest.repositoryId) &&
          manifest.stage === "frozen" &&
          manifest.records.length === 1 &&
          same(manifest.records[0].keys, [row.snapshot_id]) &&
          isHash(manifest.records[0].hash) &&
          receipt.schemaVersion === schema &&
          receipt.operationId === saved.operation_id &&
          receipt.repositoryId === manifest.repositoryId &&
          receipt.batchId === manifest.batchId &&
          receipt.manifestHash === saved.manifest_hash &&
          receipt.stage === "frozen" &&
          receipt.status === "applied" &&
          receipt.selected === 1 &&
          [0, 1].includes(receipt.removed) &&
          [0, 1].includes(receipt.alreadyAbsent) &&
          receipt.removed + receipt.alreadyAbsent === 1,
      );
    } catch {
      fail("derived_unbound_payload");
    }
  }

  async #checkResolvedSqlScope(tx) {
    // Numeric containment alone cannot exclude a malformed legacy source list.
    // Establish all remaining SQL scope before removing even its support rows.
    let cursor = null;
    for (;;) {
      const rows = (
        await tx.query(
          `${snapshotScopeQuery}
        WHERE ($1::text IS NULL OR s.snapshot_id>$1) ORDER BY s.snapshot_id LIMIT 100`,
          [cursor],
        )
      ).rows;
      if (rows.length === 0) break;
      for (const row of rows) await this.#checkSnapshotScope(tx, row);
      cursor = rows.at(-1).snapshot_id;
    }
    const state = this.#controlsStore.read();
    for (const table of ["pipelinePublications", "pipelineHeads"])
      for (const [key, entry] of Object.entries(state[table] ?? {})) {
        check(
          entry &&
            typeof entry.snapshotId === "string" &&
            entry.snapshotId.length > 0 &&
            entry.snapshotId.length <= 256,
          "derived_unbound_payload",
        );
        const row = (await tx.query(`${snapshotScopeQuery} WHERE s.snapshot_id=$1`, [entry.snapshotId])).rows[0];
        check(
          row &&
            entry.scopeKey === row.scope_key &&
            String(entry.revision) === String(row.revision) &&
            key === (table === "pipelinePublications" ? row.snapshot_id : row.scope_key),
          "derived_unbound_payload",
        );
        await this.#checkSnapshotScope(tx, row);
      }
  }

  async #select(tx, value, limit, indexed) {
    await this.#checkResolvedSqlScope(tx);
    const active = (
      await tx.query(
        `SELECT s.*,r.snapshot_id AS registered
      FROM leaderboard_pipeline.snapshots s LEFT JOIN leaderboard_pipeline.derived_retirement_snapshots r USING(snapshot_id)
      WHERE s.repository_ids @> $1::jsonb AND NOT EXISTS (
        SELECT 1 FROM leaderboard_pipeline.dispatch_publications d WHERE d.snapshot_id=s.snapshot_id)
      ORDER BY s.snapshot_id LIMIT 1 FOR UPDATE OF s`,
        [JSON.stringify([value.repositoryId])],
      )
    ).rows[0];
    if (active) {
      const ids = repositoryIds(active.repository_ids);
      check(ids.includes(value.repositoryId), "derived_source_binding_invalid");
      let binding;
      if (!active.registered) {
        // Two repositories can share one immutable snapshot. Do not mint two
        // conflicting registrations while the first SQLite/PG handoff is pending.
        const pending = (
          await tx.query(
            `SELECT 1 FROM leaderboard_pipeline.derived_retirement_manifests m
          LEFT JOIN leaderboard_pipeline.derived_retirement_receipts r USING(operation_id,batch_id)
          WHERE m.document->>'stage'='register_snapshot' AND m.document->>'snapshotId'=$1
          AND r.batch_id IS NULL LIMIT 1`,
            [active.snapshot_id],
          )
        ).rows[0];
        check(!pending, "derived_snapshot_batch_pending");
        const doc = document(active.document, active.document_hash);
        boundSnapshot(doc, active);
        const frozen = (
          await tx.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [active.snapshot_id])
        ).rows[0];
        check(frozen, "derived_frozen_binding_missing");
        const input = document(frozen.document, frozen.document_hash);
        check(
          same(sourceIds(input.identityAuthorization), ids) &&
            same(stringRepositoryIds(input.frozen?.repositoryIds), ids) &&
            same(input.scope, doc.scope),
          "derived_source_binding_invalid",
        );
        const publication = (
          await tx.query(
            `SELECT document,document_hash FROM leaderboard_pipeline.receipts
          WHERE ${indexed ? `operation_hash=${pipelineKeySQL("$1")} AND ` : ""}operation_key=$1 AND kind='snapshot_published'`,
            [`publish:${active.scope_key}:${active.snapshot_id}`],
          )
        ).rows[0];
        check(publication, "derived_publication_binding_missing");
        const published = document(publication.document, publication.document_hash);
        check(
          published.snapshotId === active.snapshot_id &&
            String(published.revision) === String(active.revision) &&
            isHash(published.comparisonInputHash),
          "derived_publication_binding_missing",
        );
        binding = {
          snapshot_id: active.snapshot_id,
          operation_id: value.operationId,
          scope_key: active.scope_key,
          revision: String(active.revision),
          repository_ids: ids,
          document_hash: active.document_hash,
          frozen_hash: frozen.document_hash,
          input_hash: hash(input.frozen),
          engine_scope_hash: hash(input.engineScope),
          capture_hash: published.comparisonInputHash,
        };
        return {
          stage: "register_snapshot",
          snapshotId: active.snapshot_id,
          records: [{ binding, hash: hash(binding) }],
        };
      }
      binding = (
        await tx.query("SELECT * FROM leaderboard_pipeline.derived_retirement_snapshots WHERE snapshot_id=$1", [
          active.snapshot_id,
        ])
      ).rows[0];
      this.#checkBinding(binding, value.repositoryId);
      check(
        active.document_hash === binding.document_hash &&
          String(active.revision) === String(binding.revision) &&
          active.scope_key === binding.scope_key &&
          same(ids, repositoryIds(binding.repository_ids)),
      );
      document(active.document, binding.document_hash);
      const local = this.#selectSqlite(binding, limit);
      if (local) return { snapshotId: active.snapshot_id, ...local };
      for (const [stage, sql] of [
        [
          "comparisons",
          "SELECT * FROM leaderboard_pipeline.policy_comparisons WHERE document->>'snapshotId'=$1 ORDER BY comparison_id LIMIT $2",
        ],
        ["frozen", "SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1 LIMIT $2"],
        ["heads", "SELECT * FROM leaderboard_pipeline.heads WHERE snapshot_id=$1 ORDER BY scope_key LIMIT $2"],
      ]) {
        const rows = (await tx.query(sql, [active.snapshot_id, postgresStages[stage].doc ? 1 : limit])).rows;
        if (rows.length) {
          for (const row of rows) this.#checkPgScope(stage, row, binding, value.repositoryId);
          return { stage, snapshotId: active.snapshot_id, records: rows.map((row) => pgRecord(stage, row, indexed)) };
        }
      }
      // The registration alias is not a retained payload column.
      const { registered: _registered, ...row } = active;
      return { stage: "snapshots", snapshotId: active.snapshot_id, records: [pgRecord("snapshots", row)] };
    }
    const causal = (
      await tx.query(
        `SELECT s.snapshot_id,s.document_hash FROM leaderboard_pipeline.snapshots s
      WHERE s.repository_ids @> $1::jsonb AND EXISTS (
        SELECT 1 FROM leaderboard_pipeline.dispatch_publications d WHERE d.snapshot_id=s.snapshot_id)
      ORDER BY s.snapshot_id LIMIT 1`,
        [JSON.stringify([value.repositoryId])],
      )
    ).rows[0];
    if (causal)
      return {
        stage: "retained_dispatch_authority",
        snapshotId: causal.snapshot_id,
        retainedSnapshotHash: causal.document_hash,
        records: [],
      };
    // Coverage receipts contain protected source descriptors. Include their
    // actual rows in the authorized manifest; a completed erasure cannot leave
    // a private feedback generation behind or claim an invented retention TTL.
    for (const stage of ["discussion_feedback_scans", "discussion_feedback_heads"]) {
      const spec = postgresStages[stage];
      if (!(await tx.query("SELECT to_regclass($1) AS name", [`leaderboard_pipeline.${spec.table}`])).rows[0]?.name)
        continue;
      const rows = (
        await tx.query(
          `SELECT * FROM leaderboard_pipeline.${spec.table} WHERE repository_id=$1
        ORDER BY ${spec.keys.join(",")} LIMIT 1`,
          [value.repositoryId],
        )
      ).rows;
      if (rows.length) return { stage, snapshotId: null, records: rows.map((row) => pgRecord(stage, row)) };
    }
    // Normalizations precede their source references, while this migration's
    // FK prevents ingestion's independent source eraser from stranding them.
    for (const stage of ["normalizations", "artifacts", "modes"]) {
      const spec = postgresStages[stage];
      const rows = (
        await tx.query(
          `SELECT d.* FROM leaderboard_pipeline.${spec.table} d
        JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=$1
        ORDER BY ${spec.keys.map((key) => `d.${key}`).join(",")} LIMIT $2`,
          [value.repositoryId, spec.doc ? 1 : limit],
        )
      ).rows;
      if (rows.length) return { stage, snapshotId: null, records: rows.map((row) => pgRecord(stage, row)) };
    }
    const corrections = (
      await tx.query(
        `SELECT * FROM leaderboard_pipeline.corrections
      WHERE repository_id=$1 ORDER BY request_id LIMIT $2`,
        [value.repositoryId, 1],
      )
    ).rows;
    if (corrections.length)
      return {
        stage: "corrections",
        snapshotId: null,
        records: corrections.map((row) => pgRecord("corrections", row)),
      };
    await this.#checkNoUnboundPayload(tx, value.repositoryId);
    return { stage: "complete", snapshotId: null, records: [] };
  }

  #checkBinding(binding, repositoryId) {
    check(
      binding &&
        repositoryIds(binding.repository_ids).includes(repositoryId) &&
        isHash(binding.document_hash) &&
        isHash(binding.frozen_hash) &&
        isHash(binding.input_hash) &&
        isHash(binding.engine_scope_hash) &&
        isHash(binding.capture_hash) &&
        typeof binding.snapshot_id === "string" &&
        binding.snapshot_id.length <= 256 &&
        typeof binding.scope_key === "string" &&
        /^[1-9]\d{0,15}$/.test(String(binding.revision)),
      "derived_source_binding_invalid",
    );
  }

  #selectSqlite(binding, limit) {
    const db = this.#controlsStore.db;
    for (const [stage, sql] of [
      [
        "previews",
        `SELECT preview.* FROM policy_previews AS preview
        LEFT JOIN policy_preview_inputs AS input ON input.id=preview.input_id
        WHERE ? IN (json_extract(preview.document,'$.snapshot.snapshotId'),
          json_extract(input.document,'$.snapshot.snapshotId')) ORDER BY preview.id LIMIT ?`,
      ],
      [
        "preview_inputs",
        "SELECT * FROM policy_preview_inputs WHERE json_extract(document,'$.snapshot.snapshotId')=? ORDER BY id LIMIT ?",
      ],
      ["explanations", "SELECT * FROM pipeline_aggregate_explanations WHERE snapshot_id=? LIMIT ?"],
    ]) {
      const rows = db.prepare(sql).all(binding.snapshot_id, 1);
      if (rows.length) return { stage, records: rows.map((row) => sqliteRecord(stage, row, binding, db)) };
    }
    const state = this.#controlsStore.read();
    const records = [];
    if (state.pipelinePublications?.[binding.snapshot_id]) {
      const item = state.pipelinePublications[binding.snapshot_id];
      check(
        item.snapshotId === binding.snapshot_id &&
          item.scopeKey === binding.scope_key &&
          String(item.revision) === String(binding.revision),
      );
      records.push({ keys: ["pipelinePublications", binding.snapshot_id], hash: hash(item) });
    }
    for (const [key, item] of Object.entries(state.pipelineHeads ?? {})) {
      if (item.snapshotId !== binding.snapshot_id) continue;
      check(
        key === binding.scope_key &&
          item.scopeKey === binding.scope_key &&
          String(item.revision) === String(binding.revision),
      );
      records.push({ keys: ["pipelineHeads", key], hash: hash(item) });
    }
    return records.length ? { stage: "confirmations", records: records.slice(0, limit) } : null;
  }

  #checkPgScope(stage, row, binding, repositoryId) {
    if (stage === "comparisons") check(document(row.document, row.document_hash).snapshotId === binding.snapshot_id);
    else if (stage === "frozen") {
      const doc = document(row.document, binding.frozen_hash);
      check(
        row.snapshot_id === binding.snapshot_id &&
          row.document_hash === binding.frozen_hash &&
          same(sourceIds(doc.identityAuthorization), repositoryIds(binding.repository_ids)) &&
          same(stringRepositoryIds(doc.frozen?.repositoryIds), repositoryIds(binding.repository_ids)) &&
          hash(doc.frozen) === binding.input_hash &&
          hash(doc.engineScope) === binding.engine_scope_hash,
        "derived_source_binding_invalid",
      );
    } else if (["heads", "snapshots"].includes(stage)) {
      check(row.snapshot_id === binding.snapshot_id && row.scope_key === binding.scope_key);
      if (stage === "heads") check(String(row.revision) === String(binding.revision));
      if (stage === "snapshots") {
        const doc = document(row.document, binding.document_hash);
        boundSnapshot(doc, binding);
        check(
          row.document_hash === binding.document_hash &&
            same(repositoryIds(row.repository_ids), repositoryIds(binding.repository_ids)),
        );
      }
    } else if (stage === "corrections")
      check(String(row.repository_id) === String(repositoryId), "derived_source_binding_invalid");
  }

  async #checkNoUnboundPayload(tx, repositoryId) {
    // Unknown legacy bindings cannot be assigned to a repository by text search.
    // They prevent a complete component receipt until separately reconciled.
    const orphan = (
      await tx.query(`SELECT 1 FROM leaderboard_pipeline.policy_comparisons p
      LEFT JOIN leaderboard_pipeline.snapshots s ON s.snapshot_id=p.document->>'snapshotId'
      WHERE s.snapshot_id IS NULL LIMIT 1`)
    ).rows[0];
    check(!orphan, "derived_unbound_payload");
    const db = this.#controlsStore.db;
    for (const table of ["policy_preview_inputs", "pipeline_aggregate_explanations"]) {
      // Stream only typed source bindings, not retained contribution payloads.
      // A malformed legacy binding cannot silently mean "another repository".
      for (const row of db
        .prepare(`SELECT json_extract(document,'$.authorization.sources') AS sources FROM ${table}`)
        .iterate()) {
        let ids;
        try {
          ids = sourceIds({ sources: JSON.parse(row.sources) });
        } catch {
          fail("derived_unbound_payload");
        }
        check(!ids.includes(repositoryId), "derived_unbound_payload");
      }
    }
    const preview = db
      .prepare(
        `SELECT 1 FROM policy_previews AS preview LEFT JOIN policy_preview_inputs AS input
      ON input.id=preview.input_id WHERE input.id IS NULL LIMIT 1`,
      )
      .get();
    check(!preview, "derived_unbound_payload");
    const confirmations = this.#controlsStore.read();
    for (const table of ["pipelinePublications", "pipelineHeads"])
      for (const entry of Object.values(confirmations[table] ?? {})) {
        check(entry && typeof entry.snapshotId === "string", "derived_unbound_payload");
        const removed = db
          .prepare("SELECT 1 FROM pipeline_derived_retirement_snapshots WHERE snapshot_id=?")
          .get(entry.snapshotId);
        check(!removed, "derived_unbound_payload");
      }
  }

  #applySqlite(manifest, digest, binding) {
    let result;
    this.#controlsStore.transaction((state) => {
      const db = this.#controlsStore.db;
      const old = db
        .prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE operation_id=? AND batch_id=?")
        .get(manifest.operationId, manifest.batchId);
      if (old) {
        check(old.manifest_hash === digest, "derived_batch_conflict");
        result = document(old.document, old.document_hash);
        return;
      }
      let removed = 0,
        alreadyAbsent = 0;
      if (manifest.stage === "register_snapshot") {
        const savedBinding = manifest.records[0].binding;
        db.prepare(
          `INSERT INTO pipeline_derived_retirement_snapshots(snapshot_id,operation_id,binding_hash)
          VALUES(?,?,?) ON CONFLICT DO NOTHING`,
        ).run(savedBinding.snapshot_id, savedBinding.operation_id, hash(savedBinding));
        const row = db
          .prepare("SELECT * FROM pipeline_derived_retirement_snapshots WHERE snapshot_id=?")
          .get(savedBinding.snapshot_id);
        check(
          row.operation_id === savedBinding.operation_id && row.binding_hash === hash(savedBinding),
          "derived_batch_conflict",
        );
      } else if (manifest.stage === "confirmations") {
        for (const record of manifest.records) {
          const [table, key] = record.keys;
          check(["pipelinePublications", "pipelineHeads"].includes(table));
          const current = state[table]?.[key];
          if (!current || (table === "pipelineHeads" && current.snapshotId !== binding.snapshot_id)) {
            // A new head is outside this manifest's exact snapshot/version.
            alreadyAbsent++;
            continue;
          }
          check(
            hash(current) === record.hash &&
              current.snapshotId === binding.snapshot_id &&
              current.scopeKey === binding.scope_key,
            "derived_row_changed",
          );
          delete state[table][key];
          removed++;
        }
      } else {
        const spec = sqliteStages[manifest.stage];
        check(spec);
        for (const record of manifest.records) {
          if (manifest.stage === "preview_inputs")
            check(
              !db.prepare("SELECT 1 FROM policy_previews WHERE input_id=? LIMIT 1").get(record.keys[0]),
              "derived_preview_reference_remaining",
            );
          const current = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key}=?`).get(record.keys[0]);
          if (!current) {
            alreadyAbsent++;
            continue;
          }
          check(same(sqliteRecord(manifest.stage, current, binding, db), record), "derived_row_changed");
          const deleted = db
            .prepare(`DELETE FROM ${spec.table} WHERE ${spec.key}=? AND digest=?`)
            .run(record.keys[0], current.digest);
          check(deleted.changes === 1, "derived_row_changed");
          removed++;
        }
      }
      result = { schemaVersion: schema, manifestHash: digest, stage: manifest.stage, removed, alreadyAbsent };
      db.prepare(
        `INSERT INTO pipeline_derived_retirement_batches(operation_id,batch_id,manifest_hash,document,document_hash)
        VALUES(?,?,?,?,?)`,
      ).run(manifest.operationId, manifest.batchId, digest, stable(result), hash(result));
    });
    return result;
  }

  async #apply(value, authorize, manifest, digest) {
    check(
      manifest.schemaVersion === schema &&
        manifest.operationId === value.operationId &&
        manifest.repositoryId === value.repositoryId &&
        manifest.authorityHash === hash(value) &&
        hash(manifest) === digest &&
        manifest.records.length <= manifest.limit,
      "derived_batch_conflict",
    );
    return this.#transact(value, authorize, async (tx, _authority, indexed) => {
      const prior = (
        await tx.query(
          `SELECT * FROM leaderboard_pipeline.derived_retirement_receipts
        WHERE operation_id=$1 AND batch_id=$2`,
          [value.operationId, manifest.batchId],
        )
      ).rows[0];
      if (prior) {
        const saved = document(prior.document, prior.document_hash);
        check(saved.manifestHash === digest, "derived_batch_conflict");
        return saved;
      }
      // Revalidate even when resuming a manifest selected by an older process.
      // Unknown scope cannot authorize deletion across an interrupted handoff.
      await this.#checkResolvedSqlScope(tx);
      let binding = null;
      if (manifest.stage === "register_snapshot") binding = manifest.records[0].binding;
      else if (manifest.snapshotId && manifest.stage !== "retained_dispatch_authority")
        binding = (
          await tx.query("SELECT * FROM leaderboard_pipeline.derived_retirement_snapshots WHERE snapshot_id=$1", [
            manifest.snapshotId,
          ])
        ).rows[0];
      if (binding) this.#checkBinding(binding, value.repositoryId);
      let removed = 0,
        alreadyAbsent = 0;
      if (manifest.stage === "register_snapshot") {
        check(manifest.records.length === 1 && hash(binding) === manifest.records[0].hash);
        const current = (
          await tx.query("SELECT * FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1 FOR UPDATE", [
            binding.snapshot_id,
          ])
        ).rows[0];
        check(current, "derived_snapshot_binding_missing");
        this.#checkPgScope("snapshots", current, binding, value.repositoryId);
        const frozen = (
          await tx.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [binding.snapshot_id])
        ).rows[0];
        check(frozen, "derived_frozen_binding_missing");
        this.#checkPgScope("frozen", frozen, binding, value.repositoryId);
        await authorized(authorize, value);
        this.#applySqlite(manifest, digest, binding);
        await tx.query(
          `INSERT INTO leaderboard_pipeline.derived_retirement_snapshots
          (snapshot_id,operation_id,scope_key,revision,repository_ids,document_hash,frozen_hash,input_hash,engine_scope_hash,capture_hash)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
          [
            binding.snapshot_id,
            binding.operation_id,
            binding.scope_key,
            binding.revision,
            JSON.stringify(binding.repository_ids),
            binding.document_hash,
            binding.frozen_hash,
            binding.input_hash,
            binding.engine_scope_hash,
            binding.capture_hash,
          ],
        );
      } else if (sqliteStages[manifest.stage] || manifest.stage === "confirmations") {
        check(binding);
        await authorized(authorize, value);
        ({ removed, alreadyAbsent } = this.#applySqlite(manifest, digest, binding));
      } else if (["complete", "retained_dispatch_authority"].includes(manifest.stage)) {
        check(manifest.records.length === 0);
        const selected = await this.#select(tx, value, manifest.limit, indexed);
        check(
          selected.stage === manifest.stage &&
            selected.snapshotId === manifest.snapshotId &&
            selected.retainedSnapshotHash === manifest.retainedSnapshotHash,
          "derived_scope_changed",
        );
      } else {
        const spec = postgresStages[manifest.stage];
        check(spec);
        for (const record of manifest.records) {
          check(record.keys.length === spec.keys.length && isHash(record.hash));
          const predicate =
            (manifest.stage === "heads" && indexed ? `scope_hash=${pipelineKeySQL("$1")} AND ` : "") +
            spec.keys.map((key, index) => `${key}=$${index + 1}`).join(" AND ");
          const row = (
            await tx.query(
              `SELECT * FROM leaderboard_pipeline.${spec.table} WHERE ${predicate} FOR UPDATE`,
              record.keys,
            )
          ).rows[0];
          if (!row || (manifest.stage === "heads" && row.snapshot_id !== binding.snapshot_id)) {
            // A concurrent, unretired publication may replace the scope's head.
            // Its payload must survive; the selected old version is absent.
            alreadyAbsent++;
            continue;
          }
          check(same(pgRecord(manifest.stage, row, indexed), record), "derived_row_changed");
          if (binding) this.#checkPgScope(manifest.stage, row, binding, value.repositoryId);
          else if (manifest.stage === "corrections") this.#checkPgScope(manifest.stage, row, null, value.repositoryId);
          else if (["discussion_feedback_scans", "discussion_feedback_heads"].includes(manifest.stage))
            check(
              Number(row.repository_id) === value.repositoryId && row.document.repositoryId === value.repositoryId,
              "derived_source_binding_invalid",
            );
          else {
            const fact = (
              await tx.query("SELECT repository_id FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [
                row.fact_key,
              ])
            ).rows[0];
            check(fact && String(fact.repository_id) === String(value.repositoryId), "derived_source_binding_invalid");
          }
          if (manifest.stage === "normalizations") await retireIssueTransferMetadata(tx, row);
          const deleted = await tx.query(
            `DELETE FROM leaderboard_pipeline.${spec.table} WHERE ${predicate} RETURNING ${spec.keys[0]}`,
            record.keys,
          );
          check(deleted.rows.length === 1, "derived_row_changed");
          removed++;
        }
      }
      const result = {
        schemaVersion: schema,
        operationId: value.operationId,
        batchId: manifest.batchId,
        repositoryId: value.repositoryId,
        manifestHash: digest,
        stage: manifest.stage,
        selected: manifest.records.length,
        removed,
        alreadyAbsent,
        status:
          manifest.stage === "complete"
            ? "owned_scope_erased"
            : manifest.stage === "retained_dispatch_authority"
              ? "blocked"
              : "applied",
        retainedReason: manifest.stage === "retained_dispatch_authority" ? "retained_dispatch_authority" : null,
        meaning:
          "Pipeline-derived tables only; protected audit, ingestion ledgers, other stores and backups are separate.",
      };
      await authorized(authorize, value);
      await tx.query(
        `INSERT INTO leaderboard_pipeline.derived_retirement_receipts
        (operation_id,batch_id,document,document_hash) VALUES($1,$2,$3::jsonb,$4)`,
        [value.operationId, manifest.batchId, JSON.stringify(result), hash(result)],
      );
      return result;
    });
  }
}
