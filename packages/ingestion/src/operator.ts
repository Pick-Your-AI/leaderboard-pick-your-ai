import { createHash, randomUUID } from "node:crypto";
import { sourceFamilies } from "./collection.js";
import type { SqlDatabase, SqlSession } from "./store.js";

type Authority = { policyVersion: string; revision: string };
export type OperatorAuthorize = (repositoryId: number) => Promise<Authority>;
const identity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const reasons = ["source_recovered", "normalization_corrected", "operator_reviewed"];
const failure = (v: unknown) =>
  ["source_unavailable", "normalization_failed", "unsupported_payload"].includes(String(v)) ? v : "unknown";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const count = (v: unknown) =>
  v !== null && v !== undefined && v !== "" && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
function scope(repositoryId: number) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new Error("invalid_operation_scope");
}
async function access(tx: SqlSession, repositoryId: number) {
  const row = (
    await tx.query(
      "SELECT generation,installation_id FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 AND state='public' FOR SHARE",
      [repositoryId],
    )
  ).rows[0];
  if (!row || count(row.generation) === null) throw new Error("operation_source_unavailable");
  return { generation: String(row.generation), installationId: String(row.installation_id) };
}
async function authority(authorize: OperatorAuthorize, repositoryId: number) {
  const a = await authorize(repositoryId);
  if (!a || !identity(a.policyVersion) || !identity(a.revision)) throw new Error("operation_not_authorized");
  return a;
}
const revision = (repositoryId: number, generation: string, a: Authority, row: Record<string, unknown>) =>
  digest([
    repositoryId,
    generation,
    a.policyVersion,
    a.revision,
    row.delivery_id,
    row.body_hash,
    row.attempts,
    row.reason_code,
    row.attempt_revision,
  ]);
/** Privileged host adapter. Authorization must recheck the current session and explicit repository grant on every call. */
export class OperatorInbox {
  constructor(readonly db: SqlDatabase) {}
  async read(repositoryId: number, authorize: OperatorAuthorize) {
    scope(repositoryId);
    return this.db.transaction(async (tx) => {
      const a = await authority(authorize, repositoryId),
        accessState = await access(tx, repositoryId);
      const { generation, installationId } = accessState;
      const counts = (
        await tx.query(
          `SELECT count(*) FILTER(WHERE state='pending')::integer AS pending,
        count(*) FILTER(WHERE state='leased')::integer AS leased,count(*) FILTER(WHERE state='quarantined')::integer AS quarantined,
        count(*) FILTER(WHERE state='done')::integer AS completed FROM leaderboard_ingestion.inbox WHERE envelope->>'repositoryId'=$1 AND envelope->>'installationId'=$2`,
          [String(repositoryId), installationId],
        )
      ).rows[0]!;
      const quarantined = (
        await tx.query(
          `SELECT delivery_id,body_hash,attempts,reason_code,available_at::text AS attempt_revision FROM leaderboard_ingestion.inbox
        WHERE envelope->>'repositoryId'=$1 AND envelope->>'installationId'=$2 AND state='quarantined' ORDER BY received_at,delivery_id LIMIT 51`,
          [String(repositoryId), installationId],
        )
      ).rows;
      const runs = (
        await tx.query(
          `SELECT family,mode,state,page_count,item_count,expected_count,last_success_at,access_generation FROM leaderboard_ingestion.collection_runs
        WHERE repository_id=$1 ORDER BY until_at DESC,run_id LIMIT 51`,
          [repositoryId],
        )
      ).rows;
      const receipts = (
        await tx.query(
          `SELECT receipt_id,delivery_id,audit FROM leaderboard_ingestion.replay_receipts
        WHERE audit->>'repositoryId'=$1 ORDER BY replayed_at DESC,receipt_id LIMIT 51`,
          [String(repositoryId)],
        )
      ).rows;
      if (JSON.stringify(a) !== JSON.stringify(await authority(authorize, repositoryId)))
        throw new Error("operation_authority_changed");
      return {
        repositoryId,
        sourceGeneration: generation,
        policyVersion: a.policyVersion,
        authorityRevision: a.revision,
        counts: Object.fromEntries(["pending", "leased", "quarantined", "completed"].map((k) => [k, count(counts[k])])),
        quarantined: quarantined.slice(0, 50).map((r) => ({
          deliveryId: r.delivery_id,
          attempts: count(r.attempts),
          reason: failure(r.reason_code),
          revision: revision(repositoryId, generation, a, r),
        })),
        runs: runs.slice(0, 50).map((r) => ({
          sourceGeneration: count(r.access_generation) === null ? null : String(r.access_generation),
          family: (sourceFamilies as readonly unknown[]).includes(r.family) ? r.family : "unknown",
          mode: ["backfill", "reconcile", "audit"].includes(String(r.mode)) ? r.mode : "unknown",
          state: ["pending", "complete", "failed"].includes(String(r.state)) ? r.state : "unknown",
          pages: count(r.page_count),
          items: count(r.item_count),
          expectedItems: r.expected_count === null ? null : count(r.expected_count),
          lastSuccessAt: r.last_success_at instanceof Date ? r.last_success_at.toISOString() : null,
        })),
        receipts: receipts.slice(0, 50).map((r) => {
          const audit = r.audit as Record<string, unknown>;
          return {
            sourceGeneration: count(audit.sourceGeneration) === null ? null : String(audit.sourceGeneration),
            id: r.receipt_id,
            deliveryId: r.delivery_id,
            operatorId: identity(audit.operatorId) ? audit.operatorId : null,
            reason: reasons.includes(String(audit.reason)) ? audit.reason : "unknown",
            policyVersion: identity(audit.policyVersion) ? audit.policyVersion : null,
            beforeRevision: /^[a-f0-9]{64}$/.test(String(audit.beforeRevision)) ? audit.beforeRevision : null,
            queuedRevision: /^[a-f0-9]{64}$/.test(String(audit.queuedRevision)) ? audit.queuedRevision : null,
            resultingPublicationRevision: null,
          };
        }),
        truncated: { quarantined: quarantined.length > 50, runs: runs.length > 50, receipts: receipts.length > 50 },
        meaning:
          "Retained inbox processing and bounded collection runs; not proof of source connectivity or successful publication.",
      };
    });
  }
  async replay(
    input: { repositoryId: number; deliveryId: string; expectedRevision: string; reason: string; operatorId: string },
    authorize: OperatorAuthorize,
  ) {
    scope(input.repositoryId);
    if (
      !/^[a-f0-9-]{36}$/.test(input.deliveryId) ||
      !/^[a-f0-9]{64}$/.test(input.expectedRevision) ||
      !identity(input.operatorId) ||
      !reasons.includes(input.reason)
    )
      throw new Error("invalid_replay_request");
    return this.db.transaction(async (tx) => {
      const a = await authority(authorize, input.repositoryId),
        accessState = await access(tx, input.repositoryId);
      const { generation, installationId } = accessState;
      const row = (
        await tx.query(
          `SELECT delivery_id,body_hash,attempts,reason_code,available_at::text AS attempt_revision FROM leaderboard_ingestion.inbox
        WHERE delivery_id=$1 AND envelope->>'repositoryId'=$2 AND envelope->>'installationId'=$3 AND state='quarantined' FOR UPDATE`,
          [input.deliveryId, String(input.repositoryId), installationId],
        )
      ).rows[0];
      if (!row || revision(input.repositoryId, generation, a, row) !== input.expectedRevision)
        throw new Error("replay_selection_changed");
      if (JSON.stringify(a) !== JSON.stringify(await authority(authorize, input.repositoryId)))
        throw new Error("operation_authority_changed");
      const receiptId = randomUUID(),
        queuedRevision = digest([input.expectedRevision, receiptId, "pending", 0]);
      const audit = {
        operatorId: input.operatorId,
        reason: input.reason,
        policyVersion: a.policyVersion,
        repositoryId: input.repositoryId,
        sourceGeneration: generation,
        authorityRevision: a.revision,
        beforeRevision: input.expectedRevision,
        queuedRevision,
        resultingRevision: null,
      };
      await tx.query(
        `INSERT INTO leaderboard_ingestion.replay_receipts(receipt_id,delivery_id,prior_attempts,prior_reason_code,audit) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [receiptId, input.deliveryId, row.attempts, row.reason_code, JSON.stringify(audit)],
      );
      await tx.query(
        `UPDATE leaderboard_ingestion.inbox SET state='pending',attempts=0,available_at=clock_timestamp(),reason_code=NULL WHERE delivery_id=$1`,
        [input.deliveryId],
      );
      // A role/session/grant may change during either database write. Reject
      // before the transaction commits so the receipt and queue roll back together.
      if (JSON.stringify(a) !== JSON.stringify(await authority(authorize, input.repositoryId)))
        throw new Error("operation_authority_changed");
      return {
        id: receiptId,
        repositoryId: input.repositoryId,
        deliveryId: input.deliveryId,
        status: "queued",
        beforeRevision: input.expectedRevision,
        queuedRevision,
        resultingPublicationRevision: null,
      };
    });
  }
}
