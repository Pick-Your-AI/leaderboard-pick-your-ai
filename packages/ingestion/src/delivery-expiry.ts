import type { SqlDatabase, SqlSession } from "./store.js";

export interface DeliveryExpiryRequest {
  operationId: string;
  repositoryId: number;
  installationId: number;
  /** Exclusive UTC bound for both inbox and outbox completion clocks. */
  completedBefore: string;
  policyVersion: string;
  operatorId: string;
  authorizationId: string;
  batchLimit: number;
}
export interface DeliveryExpiryReceipt extends DeliveryExpiryRequest {
  version: "delivery-payload-expiry/v1";
  coverage: "selected_completed_deliveries_only";
  expiredCount: number;
  recordedAt: string;
}
/** Recheck the current protected-host grant before every readback or mutation. */
export type DeliveryExpiryAuthorize = (request: Readonly<DeliveryExpiryRequest>) => Promise<boolean>;

const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
function request(input: DeliveryExpiryRequest): DeliveryExpiryRequest {
  if (
    !input ||
    [input.operationId, input.policyVersion, input.operatorId, input.authorizationId].some(
      (value) => !identity(value),
    ) ||
    [input.repositoryId, input.installationId].some((value) => !Number.isSafeInteger(value) || value < 1) ||
    typeof input.completedBefore !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.completedBefore) ||
    input.completedBefore.startsWith("0000-") ||
    !Number.isFinite(Date.parse(input.completedBefore)) ||
    new Date(input.completedBefore).toISOString() !== input.completedBefore ||
    !Number.isSafeInteger(input.batchLimit) ||
    input.batchLimit < 1 ||
    input.batchLimit > 100
  )
    throw new Error("invalid_delivery_expiry_request");
  return {
    operationId: input.operationId,
    repositoryId: input.repositoryId,
    installationId: input.installationId,
    completedBefore: input.completedBefore,
    policyVersion: input.policyVersion,
    operatorId: input.operatorId,
    authorizationId: input.authorizationId,
    batchLimit: input.batchLimit,
  };
}
function decode(row: Record<string, unknown>): DeliveryExpiryReceipt {
  return {
    version: "delivery-payload-expiry/v1",
    coverage: "selected_completed_deliveries_only",
    operationId: String(row.operation_id),
    repositoryId: Number(row.repository_id),
    installationId: Number(row.installation_id),
    completedBefore: new Date(row.completed_before as string).toISOString(),
    policyVersion: String(row.policy_version),
    operatorId: String(row.operator_id),
    authorizationId: String(row.authorization_id),
    batchLimit: Number(row.batch_limit),
    expiredCount: Number(row.expired_count),
    recordedAt: new Date(row.recorded_at as string).toISOString(),
  };
}
async function authorized(authorize: DeliveryExpiryAuthorize, input: DeliveryExpiryRequest): Promise<void> {
  if ((await authorize(Object.freeze({ ...input }))) !== true) throw new Error("delivery_expiry_not_authorized");
}

async function requireReadCommitted(tx: SqlSession): Promise<void> {
  const isolation = (await tx.query("SHOW transaction_isolation")).rows[0]?.transaction_isolation;
  // An advisory lock cannot refresh an older repeatable-read/serializable snapshot.
  // The protected host owns isolation policy; never silently change its transaction.
  if (isolation !== "read committed") throw new Error("delivery_expiry_requires_read_committed");
}

/** Shared transaction gate: replay cannot observe one side of a committed expiry. */
export async function lockDeliveryReplay(tx: SqlSession, repositoryId: number): Promise<void> {
  await requireReadCommitted(tx);
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [
    `leaderboard-delivery-expiry:${repositoryId}`,
  ]);
}

/** Protected host primitive. One operation is one bounded atomic batch, never a source purge. */
export class DeliveryPayloadExpiryStore {
  constructor(readonly db: SqlDatabase) {}

  async expireCompleted(
    input: DeliveryExpiryRequest,
    authorize: DeliveryExpiryAuthorize,
  ): Promise<DeliveryExpiryReceipt> {
    const scope = request(input);
    if (typeof authorize !== "function") throw new Error("invalid_delivery_expiry_authorizer");
    await authorized(authorize, scope);
    return this.db.transaction(async (tx) => {
      await requireReadCommitted(tx);
      // Concurrent retries of the same operation read back one immutable receipt.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `leaderboard-delivery-expiry-operation:${scope.operationId}`,
      ]);
      const existing = (
        await tx.query("SELECT * FROM leaderboard_ingestion.delivery_payload_expiry_operations WHERE operation_id=$1", [
          scope.operationId,
        ])
      ).rows[0];
      if (existing) {
        const receipt = decode(existing);
        if (JSON.stringify(request(receipt)) !== JSON.stringify(scope))
          throw new Error("delivery_expiry_operation_conflict");
        await authorized(authorize, scope);
        return receipt;
      }
      const clock = (await tx.query("SELECT $1::timestamptz <= clock_timestamp() AS valid", [scope.completedBefore]))
        .rows[0];
      if (clock?.valid !== true) throw new Error("delivery_expiry_future_cutoff");
      const gate = (
        await tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired", [
          `leaderboard-delivery-expiry:${scope.repositoryId}`,
        ])
      ).rows[0];
      if (gate?.acquired !== true) throw new Error("delivery_expiry_scope_busy");
      const selected = (
        await tx.query(
          `SELECT intake.delivery_id, evidence.event_key, intake.envelope->>'subjectId' AS subject_id
        FROM leaderboard_ingestion.inbox AS intake
        JOIN leaderboard_ingestion.observations AS evidence USING (delivery_id)
        JOIN leaderboard_ingestion.outbox AS notice USING (event_key)
        WHERE intake.state='done' AND notice.state='done' AND intake.envelope IS NOT NULL
          AND intake.envelope->>'repositoryId'=$1 AND intake.envelope->>'installationId'=$2
          AND intake.envelope->>'version'='github-delivery/v1'
          AND intake.envelope->>'deliveryId'=intake.delivery_id::text
          AND intake.envelope->>'subjectId' ~ '^[A-Za-z0-9_=-]{1,200}$'
          AND evidence.event_key='github:delivery:' || intake.delivery_id::text
          AND evidence.normalization_version='delivery-observation/v1'
          AND evidence.observation->>'repositoryId'=$1 AND evidence.observation->>'installationId'=$2
          AND evidence.observation->>'subjectId'=intake.envelope->>'subjectId'
          AND evidence.observation->>'deliveryId'=intake.delivery_id::text
          AND evidence.observation->>'eventKey'=evidence.event_key
          AND (evidence.observation - ARRAY['eventKey','observedAt','ordering','qualification'])=intake.envelope
          AND leaderboard_ingestion.delivery_expiry_completion_valid(notice.operation, notice.completion)
          AND EXISTS (SELECT 1 FROM leaderboard_ingestion.attempt_history WHERE delivery_id=intake.delivery_id AND outcome='done' AND finished_at<$3::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.attempt_history WHERE delivery_id=intake.delivery_id AND outcome='done' AND (finished_at IS NULL OR finished_at>=$3::timestamptz))
          AND EXISTS (SELECT 1 FROM leaderboard_ingestion.outbox_attempts WHERE event_key=notice.event_key AND outcome='done' AND finished_at<$3::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.outbox_attempts WHERE event_key=notice.event_key AND outcome='done' AND (finished_at IS NULL OR finished_at>=$3::timestamptz))
          AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.delivery_payload_expiries WHERE delivery_id=intake.delivery_id)
        ORDER BY intake.received_at, intake.delivery_id LIMIT $4 FOR UPDATE OF intake,evidence,notice SKIP LOCKED`,
          [String(scope.repositoryId), String(scope.installationId), scope.completedBefore, scope.batchLimit],
        )
      ).rows;
      await authorized(authorize, scope);
      const operation = (
        await tx.query(
          `INSERT INTO leaderboard_ingestion.delivery_payload_expiry_operations
        (operation_id,repository_id,installation_id,completed_before,policy_version,operator_id,authorization_id,batch_limit,expired_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            scope.operationId,
            scope.repositoryId,
            scope.installationId,
            scope.completedBefore,
            scope.policyVersion,
            scope.operatorId,
            scope.authorizationId,
            scope.batchLimit,
            selected.length,
          ],
        )
      ).rows[0]!;
      for (const row of selected) {
        await tx.query(
          `INSERT INTO leaderboard_ingestion.delivery_payload_expiries
          (delivery_id,event_key,operation_id,repository_id,installation_id,subject_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [row.delivery_id, row.event_key, scope.operationId, scope.repositoryId, scope.installationId, row.subject_id],
        );
        await tx.query("UPDATE leaderboard_ingestion.inbox SET envelope=NULL WHERE delivery_id=$1", [row.delivery_id]);
        await tx.query("UPDATE leaderboard_ingestion.observations SET observation=NULL WHERE event_key=$1", [
          row.event_key,
        ]);
      }
      await authorized(authorize, scope);
      return decode(operation);
    });
  }
}
