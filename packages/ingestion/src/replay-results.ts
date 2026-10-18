import { createHash } from "node:crypto";
import type { DispatchOperation, DispatchPublication } from "./outbox.js";
import type { SqlSession } from "./store.js";

export interface ReplayPublicationBinding {
  repositoryId: number;
  installationId: string;
  sourceGeneration: string;
  receiptId: string | null;
  eventKey: string;
  operation: DispatchOperation;
  observationCutoff: string;
  sourceGenerations: Array<{ repositoryId: number; generation: string }>;
  publications: DispatchPublication[];
}
/** The publisher verifies its own authoritative receipts under this transaction's
 * source locks. The returned synchronous fence runs after final operator reauth. */
export type VerifyReplayPublications = (
  tx: SqlSession,
  binding: ReplayPublicationBinding,
) => Promise<(() => boolean) | null>;
export interface OperatorReplayResultOptions {
  now?: () => string;
  verifyPublications?: VerifyReplayPublications;
}
export interface OperatorReplayResult {
  receiptId: string;
  deliveryId: string;
  status: "unknown" | "queued" | "processing" | "failed" | "superseded" | "processed" | "published" | "unavailable";
  reason:
    | "legacy_unbound"
    | "awaiting_intake"
    | "intake_in_progress"
    | "intake_failed"
    | "later_replay_queued"
    | "no_new_publication_notice"
    | "awaiting_publication"
    | "publication_in_progress"
    | "publication_failed"
    | "source_generation_changed"
    | "result_binding_unavailable"
    | "publication_verification_unavailable"
    | "verified_publication";
  queuedAt: string | null;
  processedAt: string | null;
  publicationCompletedAt: string | null;
  processingDelaySeconds: number | null;
  publicationDelaySeconds: number | null;
  replayPolicyVersion: string | null;
  publicationPolicyVersion: string | null;
  publications: DispatchPublication[];
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const generation = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const operationTime = (value: unknown): string | null => {
  const text = value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;
  return typeof text === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) &&
    Number.isFinite(Date.parse(text)) &&
    new Date(text).toISOString() === text
    ? text
    : null;
};
const elapsed = (start: string | null, end: string | null) =>
  start !== null && end !== null && end >= start ? (Date.parse(end) - Date.parse(start)) / 1000 : null;

export function parseDispatchOperation(value: unknown, eventKey: string): DispatchOperation | null {
  if (
    !record(value) ||
    !exact(value, [
      "configurationHash",
      "configurationVersion",
      "configurationRevision",
      "normalizationVersion",
      "policyVersion",
      "dataMode",
      "cutoff",
      "operationKey",
    ]) ||
    !hash(value.configurationHash) ||
    !identity(value.configurationVersion) ||
    !Number.isSafeInteger(value.configurationRevision) ||
    Number(value.configurationRevision) < 0 ||
    !identity(value.normalizationVersion) ||
    !identity(value.policyVersion) ||
    value.dataMode !== "synthetic" ||
    operationTime(value.cutoff) === null ||
    !hash(value.operationKey)
  )
    return null;
  const binding = {
    configurationHash: value.configurationHash,
    configurationVersion: value.configurationVersion,
    configurationRevision: Number(value.configurationRevision),
    normalizationVersion: value.normalizationVersion,
    policyVersion: value.policyVersion,
    dataMode: value.dataMode,
    cutoff: value.cutoff as string,
  } as const;
  const key = createHash("sha256")
    .update(JSON.stringify(["outbox-dispatch/v1", eventKey, binding]))
    .digest("hex");
  return key === value.operationKey ? { ...binding, operationKey: key } : null;
}
export function parseDispatchPublications(value: unknown, operationKey: string): DispatchPublication[] | null {
  if (
    !record(value) ||
    !exact(value, ["operationKey", "publications"]) ||
    value.operationKey !== operationKey ||
    !Array.isArray(value.publications) ||
    value.publications.length < 1 ||
    value.publications.length > 100
  )
    return null;
  const result: DispatchPublication[] = [];
  for (const item of value.publications) {
    if (
      !record(item) ||
      !exact(item, ["scopeKey", "snapshotId", "revision"]) ||
      typeof item.scopeKey !== "string" ||
      !item.scopeKey.length ||
      item.scopeKey.length > 2000 ||
      !hash(item.snapshotId) ||
      !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 1 ||
      result.some((prior) => prior.scopeKey === item.scopeKey)
    )
      return null;
    result.push({ scopeKey: item.scopeKey, snapshotId: item.snapshotId, revision: Number(item.revision) });
  }
  return result;
}
export function parseDispatchGenerations(value: unknown): ReplayPublicationBinding["sourceGenerations"] | null {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const result: ReplayPublicationBinding["sourceGenerations"] = [];
  for (const item of value) {
    if (
      !record(item) ||
      !exact(item, ["repositoryId", "generation"]) ||
      !Number.isSafeInteger(item.repositoryId) ||
      Number(item.repositoryId) < 1 ||
      !generation(item.generation) ||
      result.some((prior) => prior.repositoryId === item.repositoryId)
    )
      return null;
    result.push({ repositoryId: Number(item.repositoryId), generation: item.generation });
  }
  return result;
}

/** One retained receipt, one persisted intake lease and at most 100 actual
 * publication references. No source payload or caller-supplied result is read. */
export async function readOperatorReplayResult(
  tx: SqlSession,
  scope: { repositoryId: number; installationId: string; generation: string },
  receiptId: string,
  options: OperatorReplayResultOptions,
): Promise<{ result: OperatorReplayResult; confirmCurrent?: () => boolean }> {
  const row = (
    await tx.query(
      `SELECT replay.delivery_id,replay.audit,replay.replayed_at,inbox.operator_replay_receipt_id,inbox.state AS intake_state,
        processed.receipt_id AS processed_receipt_id,processed.event_key,processed.recorded_at,
        history.outcome AS intake_outcome,history.finished_at AS processed_at,
        notice.state AS publication_state,notice.operation,notice.completion,notice.source_generations,
        notice.observation_cutoff,notice.created_at AS notice_created_at,
        (SELECT max(finished_at) FROM leaderboard_ingestion.outbox_attempts
          WHERE event_key=notice.event_key AND outcome='done') AS publication_completed_at
      FROM leaderboard_ingestion.replay_receipts AS replay
      JOIN leaderboard_ingestion.inbox AS inbox ON inbox.delivery_id=replay.delivery_id
      LEFT JOIN leaderboard_ingestion.replay_processing_results AS processed
        ON processed.receipt_id=replay.receipt_id AND processed.delivery_id=replay.delivery_id
      LEFT JOIN leaderboard_ingestion.attempt_history AS history
        ON history.lease_token=processed.lease_token AND history.delivery_id=processed.delivery_id
      LEFT JOIN leaderboard_ingestion.outbox AS notice ON notice.event_key=processed.event_key
      WHERE replay.receipt_id=$1 AND replay.audit->>'repositoryId'=$2`,
      [receiptId, String(scope.repositoryId)],
    )
  ).rows[0];
  if (!row || typeof row.delivery_id !== "string") throw new Error("operation_result_unavailable");
  const now = operationTime((options.now ?? (() => new Date().toISOString()))());
  if (now === null) throw new Error("invalid_operation_time");
  const observed = (value: unknown) => {
    const time = operationTime(value);
    return time !== null && time <= now ? time : null;
  };
  const audit = record(row.audit) ? row.audit : {};
  const result: OperatorReplayResult = {
    receiptId,
    deliveryId: row.delivery_id,
    status: "unknown",
    reason: "legacy_unbound",
    queuedAt: observed(row.replayed_at),
    processedAt: null,
    publicationCompletedAt: null,
    processingDelaySeconds: null,
    publicationDelaySeconds: null,
    replayPolicyVersion: identity(audit.policyVersion) ? audit.policyVersion : null,
    publicationPolicyVersion: null,
    publications: [],
  };
  const state = (status: OperatorReplayResult["status"], reason: OperatorReplayResult["reason"]) => ({
    result: { ...result, status, reason },
  });
  if (audit.resultBinding !== "operator-replay/v1") return { result };
  if (audit.sourceGeneration !== scope.generation || audit.installationId !== scope.installationId)
    return state("unavailable", "source_generation_changed");
  if (
    audit.repositoryId !== scope.repositoryId ||
    !identity(audit.operatorId) ||
    result.replayPolicyVersion === null ||
    !hash(audit.beforeRevision) ||
    !hash(audit.queuedRevision) ||
    result.queuedAt === null
  )
    return state("unavailable", "result_binding_unavailable");
  if (!row.processed_receipt_id) {
    if (row.operator_replay_receipt_id !== receiptId) return state("superseded", "later_replay_queued");
    if (row.intake_state === "pending") return state("queued", "awaiting_intake");
    if (row.intake_state === "leased") return state("processing", "intake_in_progress");
    if (row.intake_state === "quarantined") return state("failed", "intake_failed");
    return state("unavailable", "result_binding_unavailable");
  }
  result.processedAt = observed(row.processed_at);
  const recordedAt = observed(row.recorded_at);
  if (
    row.intake_outcome !== "done" ||
    result.processedAt === null ||
    recordedAt === null ||
    recordedAt < result.queuedAt ||
    result.processedAt < recordedAt
  )
    return state("unavailable", "result_binding_unavailable");
  result.processingDelaySeconds = elapsed(result.queuedAt, result.processedAt);
  if (row.event_key === null) return state("processed", "no_new_publication_notice");
  const noticeCreatedAt = observed(row.notice_created_at);
  if (
    row.event_key !== `github:delivery:${row.delivery_id}` ||
    noticeCreatedAt === null ||
    noticeCreatedAt < result.queuedAt ||
    noticeCreatedAt > result.processedAt
  )
    return state("unavailable", "result_binding_unavailable");
  if (row.publication_state === "pending") return state("processed", "awaiting_publication");
  if (row.publication_state === "leased") return state("processing", "publication_in_progress");
  if (row.publication_state === "quarantined") return state("failed", "publication_failed");
  const dispatch = parseDispatchOperation(row.operation, row.event_key as string);
  const published = dispatch === null ? null : parseDispatchPublications(row.completion, dispatch.operationKey);
  const sources = parseDispatchGenerations(row.source_generations);
  const cutoff = observed(row.observation_cutoff);
  const completedAt = observed(row.publication_completed_at);
  if (
    row.publication_state !== "done" ||
    dispatch === null ||
    published === null ||
    sources === null ||
    !sources.some((source) => source.repositoryId === scope.repositoryId && source.generation === scope.generation) ||
    cutoff === null ||
    completedAt === null ||
    completedAt < result.processedAt ||
    cutoff > completedAt ||
    dispatch.cutoff > completedAt
  )
    return state("unavailable", "result_binding_unavailable");
  let confirmCurrent: (() => boolean) | null = null;
  try {
    confirmCurrent =
      (await options.verifyPublications?.(tx, {
        repositoryId: scope.repositoryId,
        installationId: scope.installationId,
        sourceGeneration: scope.generation,
        receiptId,
        eventKey: row.event_key as string,
        operation: dispatch,
        sourceGenerations: sources,
        observationCutoff: cutoff,
        publications: structuredClone(published),
      })) ?? null;
  } catch {
    // Fixed result only. The enclosing adapter still reauthenticates after a
    // verifier failure, giving current denial precedence over this projection.
  }
  if (typeof confirmCurrent !== "function") return state("unavailable", "publication_verification_unavailable");
  return {
    result: {
      ...result,
      status: "published",
      reason: "verified_publication",
      publicationCompletedAt: completedAt,
      publicationDelaySeconds: elapsed(result.queuedAt, completedAt),
      publicationPolicyVersion: dispatch.policyVersion,
      publications: published,
    },
    confirmCurrent,
  };
}
