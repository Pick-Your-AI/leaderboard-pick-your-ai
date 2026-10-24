import type { SqlDatabase, SqlSession } from "./store.js";

/** Permanent collection retirement only. This is not an observation-expiry policy. */
export interface RepositoryRetirement {
  operationId: string;
  repositoryId: number;
  expectedGeneration: string;
  policyVersion: string;
  authorizationReceipt: string;
  operatorId: string;
}
export type RetirementAuthorize = (request: Readonly<RepositoryRetirement>) => Promise<boolean>;
const identity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
function request(value: RepositoryRetirement): Readonly<RepositoryRetirement> {
  if (
    !value ||
    !Number.isSafeInteger(value.repositoryId) ||
    value.repositoryId < 1 ||
    typeof value.expectedGeneration !== "string" ||
    !/^[1-9]\d{0,18}$/.test(value.expectedGeneration) ||
    BigInt(value.expectedGeneration) >= 9_223_372_036_854_775_807n ||
    ![value.operationId, value.policyVersion, value.authorizationReceipt, value.operatorId].every(identity)
  )
    throw new Error("invalid_repository_retirement");
  return Object.freeze({
    operationId: value.operationId,
    repositoryId: value.repositoryId,
    expectedGeneration: value.expectedGeneration,
    policyVersion: value.policyVersion,
    authorizationReceipt: value.authorizationReceipt,
    operatorId: value.operatorId,
  });
}
export { request as validateRepositoryRetirement };

export function validateRepositoryErasureBatch(batchId: string, limit: number): void {
  if (!identity(batchId) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_erasure_batch");
}

export interface RepositoryErasureProgress {
  batchId: string;
  limit: number;
  status: "erased" | "blocked";
  attempt: number;
  deletedSourceFacts: number;
  sourceFactsRemaining: boolean;
  completedAt: string;
}

function progress(row: Record<string, unknown>): RepositoryErasureProgress {
  const batchId = row.batch_id;
  const limit = row.batch_limit;
  if (typeof batchId !== "string" || typeof limit !== "number") throw new Error("erasure_receipt_invalid");
  validateRepositoryErasureBatch(batchId, limit);
  if (
    (row.status !== "erased" && row.status !== "blocked") ||
    typeof row.attempt !== "number" ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    typeof row.deleted_count !== "number" ||
    !Number.isSafeInteger(row.deleted_count) ||
    row.deleted_count < 0 ||
    row.deleted_count > limit ||
    typeof row.source_facts_remaining !== "boolean" ||
    (typeof row.completed_at !== "string" && !(row.completed_at instanceof Date)) ||
    !Number.isFinite(new Date(row.completed_at as string).getTime())
  )
    throw new Error("erasure_receipt_invalid");
  return {
    batchId,
    limit,
    status: row.status,
    attempt: Number(row.attempt),
    deletedSourceFacts: Number(row.deleted_count),
    sourceFactsRemaining: row.source_facts_remaining,
    completedAt: new Date(row.completed_at as string).toISOString(),
  };
}

async function authorized(authorize: RetirementAuthorize, value: Readonly<RepositoryRetirement>) {
  if (typeof authorize !== "function" || (await authorize(value)) !== true)
    throw new Error("retirement_not_authorized");
}
function same(row: Record<string, unknown>, value: Readonly<RepositoryRetirement>) {
  if (
    row.operation_id !== value.operationId ||
    String(row.repository_id) !== String(value.repositoryId) ||
    String(row.expected_generation) !== value.expectedGeneration ||
    row.policy_version !== value.policyVersion ||
    row.authorization_receipt !== value.authorizationReceipt ||
    row.operator_id !== value.operatorId
  )
    throw new Error("retirement_operation_conflict");
}
function receipt(row: Record<string, unknown>) {
  return {
    operationId: String(row.operation_id),
    repositoryId: Number(row.repository_id),
    sourceGeneration: String(row.source_generation),
    retiredAt: new Date(row.retired_at as string).toISOString(),
    status: "collection_fenced" as const,
    meaning: "Permanent collection fence; not complete payload deletion.",
  };
}
async function retained(tx: SqlSession, value: Readonly<RepositoryRetirement>) {
  const row = (
    await tx.query("SELECT * FROM leaderboard_ingestion.repository_retirements WHERE operation_id=$1", [
      value.operationId,
    ])
  ).rows[0];
  if (!row) throw new Error("unknown_repository_retirement");
  same(row, value);
  return row;
}

/** Protected host API. Apply migration 005 explicitly; do not call from public intake. */
export class RepositoryRetirementStore {
  constructor(readonly db: SqlDatabase) {}

  async retire(input: RepositoryRetirement, authorize: RetirementAuthorize) {
    const value = request(input);
    await authorized(authorize, value);
    return this.db.transaction(async (tx) => {
      const access = (
        await tx.query(
          "SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR UPDATE",
          [value.repositoryId],
        )
      ).rows[0];
      if (!access) throw new Error("retirement_repository_unknown");
      const prior = (
        await tx.query(
          "SELECT * FROM leaderboard_ingestion.repository_retirements WHERE repository_id=$1 OR operation_id=$2",
          [value.repositoryId, value.operationId],
        )
      ).rows;
      if (prior.length) {
        if (prior.length !== 1) throw new Error("retirement_operation_conflict");
        same(prior[0]!, value);
        await authorized(authorize, value);
        return receipt(prior[0]!);
      }
      if (String(access.generation) !== value.expectedGeneration) throw new Error("retirement_generation_changed");
      await authorized(authorize, value);
      const changed = (
        await tx.query(
          "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1,checked_at=clock_timestamp() WHERE repository_id=$1 RETURNING generation",
          [value.repositoryId],
        )
      ).rows[0]!;
      const saved = (
        await tx.query(
          `INSERT INTO leaderboard_ingestion.repository_retirements
        (operation_id,repository_id,expected_generation,source_generation,policy_version,authorization_receipt,operator_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            value.operationId,
            value.repositoryId,
            value.expectedGeneration,
            changed.generation,
            value.policyVersion,
            value.authorizationReceipt,
            value.operatorId,
          ],
        )
      ).rows[0]!;
      await authorized(authorize, value);
      return receipt(saved);
    });
  }

  /** Protected metadata only. A status hint is not a new deletion receipt. */
  async readProgress(input: RepositoryRetirement, authorize: RetirementAuthorize, batchId?: string) {
    const value = request(input);
    if (batchId !== undefined) validateRepositoryErasureBatch(batchId, 1);
    await authorized(authorize, value);
    return this.db.transaction(async (tx) => {
      const access = (
        await tx.query(
          "SELECT state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR UPDATE",
          [value.repositoryId],
        )
      ).rows[0];
      if (!access) throw new Error("retirement_repository_unknown");
      const rows = (
        await tx.query(
          "SELECT * FROM leaderboard_ingestion.repository_retirements WHERE repository_id=$1 OR operation_id=$2",
          [value.repositoryId, value.operationId],
        )
      ).rows;
      if (!rows.length) {
        if (String(access.generation) !== value.expectedGeneration) throw new Error("retirement_generation_changed");
        await authorized(authorize, value);
        return { fence: null, pending: null, terminal: null, batch: null };
      }
      if (rows.length !== 1) throw new Error("retirement_operation_conflict");
      const saved = rows[0]!;
      same(saved, value);
      if (
        access.state === "public" ||
        BigInt(String(access.generation)) < BigInt(String(saved.source_generation)) ||
        BigInt(String(saved.source_generation)) <= BigInt(value.expectedGeneration)
      )
        throw new Error("retirement_fence_unavailable");
      await authorized(authorize, value);
      const fields = "batch_id,batch_limit,status,attempt,deleted_count,source_facts_remaining,completed_at";
      const pending = (
        await tx.query(
          "SELECT " +
            fields +
            " FROM leaderboard_ingestion.collection_erasure_batches" +
            " WHERE operation_id=$1 AND status<>'erased' ORDER BY batch_id LIMIT 1",
          [value.operationId],
        )
      ).rows[0];
      const terminal = (
        await tx.query(
          "SELECT " +
            fields +
            " FROM leaderboard_ingestion.collection_erasure_batches" +
            " WHERE operation_id=$1 AND status='erased' AND NOT source_facts_remaining LIMIT 1",
          [value.operationId],
        )
      ).rows[0];
      const batch =
        batchId === undefined
          ? undefined
          : (
              await tx.query(
                "SELECT " +
                  fields +
                  " FROM leaderboard_ingestion.collection_erasure_batches WHERE operation_id=$1 AND batch_id=$2",
                [value.operationId, batchId],
              )
            ).rows[0];
      const result = {
        fence: receipt(saved),
        pending: pending ? progress(pending) : null,
        terminal: terminal ? progress(terminal) : null,
        batch: batch ? progress(batch) : null,
      };
      await authorized(authorize, value);
      return result;
    });
  }

  async eraseBatch(input: RepositoryRetirement, batchId: string, limit: number, authorize: RetirementAuthorize) {
    const value = request(input);
    validateRepositoryErasureBatch(batchId, limit);
    await authorized(authorize, value);
    return this.db.transaction(async (tx) => {
      await retained(tx, value);
      await authorized(authorize, value);
      const row = (
        await tx.query("SELECT * FROM leaderboard_ingestion.erase_collected_source_batch($1,$2,$3)", [
          value.operationId,
          batchId,
          limit,
        ])
      ).rows[0]!;
      await authorized(authorize, value);
      return {
        operationId: value.operationId,
        batchId,
        status: String(row.status),
        attempt: Number(row.attempt),
        deletedSourceFacts: Number(row.deleted_count),
        sourceFactsRemaining: row.source_facts_remaining === true,
        completedAt: new Date(row.completed_at as string).toISOString(),
        blockedReason: row.status === "blocked" ? "retained_dependencies" : null,
        meaning: "Collected source facts only; other stores and backup copies require separate deletion evidence.",
      };
    });
  }
}
