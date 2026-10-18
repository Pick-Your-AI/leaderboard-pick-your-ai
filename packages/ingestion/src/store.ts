import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Delivery, Envelope, IntakeStore } from "./webhook.js";
import { replayTransitions, transitionFromDelivery, type ReplayResult, type Transition } from "./replay.js";
import { assertRepositoryAvailable } from "./collection.js";
import { lockDeliveryReplay } from "./delivery-expiry.js";

export interface SqlSession {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface SqlDatabase extends SqlSession {
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>;
}

export interface RetainedObjectReplay {
  coverage: "retained_observations_only";
  sourceObservationCount: number;
  replay: ReplayResult;
}

export interface ExpiredObjectReplay {
  coverage: "unavailable_expired_observations";
  sourceObservationCount: number;
  expiredObservationCount: number;
  reason: "delivery_payload_expired";
  expiryOperationIds: string[];
  replay: null;
}
export type ObjectReplay = RetainedObjectReplay | ExpiredObjectReplay;

/** Caller owns the transaction; its shared expiry gate covers the full reconstruction/publication. */
export async function readObjectReplay(db: SqlSession, repositoryId: number, subjectId: string): Promise<ObjectReplay> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !/^[A-Za-z0-9_=-]{1,200}$/.test(subjectId)) {
    throw new Error("invalid_replay_scope");
  }
  await assertRepositoryAvailable(db, repositoryId, subjectId);
  await lockDeliveryReplay(db, repositoryId);
  const rows = await db.query(
    `SELECT evidence.normalization_version, evidence.observation, expiry.operation_id
    FROM leaderboard_ingestion.observations AS evidence
    LEFT JOIN leaderboard_ingestion.delivery_payload_expiries AS expiry USING (event_key)
    WHERE COALESCE(evidence.observation->>'repositoryId', expiry.repository_id::text) = $1
      AND COALESCE(evidence.observation->>'subjectId', expiry.subject_id) = $2
    ORDER BY evidence.event_key LIMIT 257`,
    [String(repositoryId), subjectId],
  );
  if (rows.rows.length > 256) throw new Error("replay_limit_exceeded");
  const expired = rows.rows.filter((row) => row.operation_id !== null);
  if (expired.length) {
    return {
      coverage: "unavailable_expired_observations",
      sourceObservationCount: rows.rows.length - expired.length,
      expiredObservationCount: expired.length,
      reason: "delivery_payload_expired",
      expiryOperationIds: [...new Set(expired.map((row) => String(row.operation_id)))].sort(),
      replay: null,
    };
  }
  const transitions: Transition[] = [];
  for (const row of rows.rows) {
    if (row.normalization_version !== "delivery-observation/v1") throw new Error("unsupported_normalization_version");
    const observation = row.observation as Envelope & { observedAt: string };
    const transition = transitionFromDelivery(observation, observation.observedAt);
    if (transition) transitions.push(transition);
  }
  return {
    coverage: "retained_observations_only",
    sourceObservationCount: rows.rows.length,
    replay: replayTransitions(transitions),
  };
}

/** Pool owns connection policy/TLS. Every transaction uses exactly one connection. */
export function postgresDatabase(pool: Pool): SqlDatabase {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface Lease {
  deliveryId: string;
  token: string;
  envelope: Envelope;
  receivedAt: Date | string;
  attempt: number;
}

export type FailureCode = "source_unavailable" | "normalization_failed" | "unsupported_payload";
export interface ReplayAudit {
  operatorId: string;
  reason: "source_recovered" | "normalization_corrected" | "operator_reviewed";
  policyVersion: string;
  /** Null until the protected host has a real resulting publication revision. */
  resultingRevision: string | null;
}
const failureCodes = new Set<FailureCode>(["source_unavailable", "normalization_failed", "unsupported_payload"]);

export class InboxStore implements IntakeStore {
  constructor(
    readonly db: SqlDatabase,
    readonly maxAttempts = 5,
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new RangeError("Invalid maxAttempts");
  }

  async insert(delivery: Delivery): Promise<"accepted" | "duplicate" | "conflict"> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO leaderboard_ingestion.inbox (delivery_id, body_hash, envelope)
        VALUES ($1, $2, $3::jsonb) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
        [delivery.deliveryId, delivery.bodyHash, JSON.stringify(delivery.envelope)],
      );
      if (inserted.rows.length) return "accepted";
      const existing = await tx.query("SELECT body_hash FROM leaderboard_ingestion.inbox WHERE delivery_id = $1", [
        delivery.deliveryId,
      ]);
      return existing.rows[0]?.body_hash === delivery.bodyHash ? "duplicate" : "conflict";
    });
  }

  /** Read-only bounded rebuild from retained delivery receipts, not source coverage certification. */
  async replayObjectState(repositoryId: number, subjectId: string): Promise<ObjectReplay> {
    return this.db.transaction((tx) => readObjectReplay(tx, repositoryId, subjectId));
  }

  async claim(leaseSeconds = 60): Promise<Lease | null> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600)
      throw new RangeError("Invalid leaseSeconds");
    return this.db.transaction(async (tx) => {
      // A crash on the last allowed attempt must not leave a permanently leased row.
      // Lock inbox before history everywhere, and bound the recovery sweep.
      const expired = await tx.query(
        `WITH exhausted AS (
        SELECT delivery_id, lease_token FROM leaderboard_ingestion.inbox
        WHERE state = 'leased' AND lease_until <= clock_timestamp() AND attempts >= $1
        ORDER BY lease_until, delivery_id FOR UPDATE SKIP LOCKED LIMIT 100
      ) UPDATE leaderboard_ingestion.inbox AS inbox SET state = 'quarantined',
        lease_token = NULL, lease_until = NULL, reason_code = 'attempts_exhausted'
        FROM exhausted WHERE inbox.delivery_id = exhausted.delivery_id RETURNING exhausted.lease_token`,
        [this.maxAttempts],
      );
      for (const row of expired.rows) await this.expireHistory(tx, String(row.lease_token));
      const token = randomUUID();
      const claimed = await tx.query(
        `WITH candidate AS (
        SELECT delivery_id, lease_token AS prior_token FROM leaderboard_ingestion.inbox
        WHERE attempts < $1 AND ((state = 'pending' AND available_at <= clock_timestamp())
          OR (state = 'leased' AND lease_until <= clock_timestamp()))
        ORDER BY received_at, delivery_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE leaderboard_ingestion.inbox AS inbox SET state = 'leased', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + $3 * interval '1 second', reason_code = NULL
        FROM candidate WHERE inbox.delivery_id = candidate.delivery_id RETURNING inbox.*, candidate.prior_token`,
        [this.maxAttempts, token, leaseSeconds],
      );
      const row = claimed.rows[0];
      if (!row) return null;
      if (row.prior_token) await this.expireHistory(tx, String(row.prior_token));
      await tx.query(
        `INSERT INTO leaderboard_ingestion.attempt_history (lease_token, delivery_id, attempt, outcome)
        VALUES ($1, $2, $3, 'leased')`,
        [token, row.delivery_id, row.attempts],
      );
      return {
        deliveryId: String(row.delivery_id),
        token,
        envelope: row.envelope as unknown as Envelope,
        receivedAt: row.received_at as Date | string,
        attempt: Number(row.attempts),
      };
    });
  }

  private async expireHistory(tx: SqlSession, token: string): Promise<void> {
    await tx.query(
      `UPDATE leaderboard_ingestion.attempt_history SET outcome = 'expired',
      finished_at = clock_timestamp(), reason_code = 'lease_expired' WHERE lease_token = $1 AND outcome = 'leased'`,
      [token],
    );
  }

  async complete(lease: Lease): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT envelope, received_at, operator_replay_receipt_id FROM leaderboard_ingestion.inbox
        WHERE delivery_id = $1 AND lease_token = $2 AND state = 'leased'
        AND lease_until > clock_timestamp() FOR UPDATE`,
        [lease.deliveryId, lease.token],
      );
      const row = rows.rows[0];
      if (!row) return false;
      // Read persisted data rather than trusting a worker's copy of the lease.
      const envelope = row.envelope as unknown as Envelope;
      const eventKey = `github:delivery:${lease.deliveryId}`;
      const observation = {
        ...envelope,
        eventKey,
        observedAt: new Date(row.received_at as string).toISOString(),
        ordering: "unestablished",
        qualification: "not_evaluated",
      };
      await tx.query(
        `INSERT INTO leaderboard_ingestion.observations
        (event_key, delivery_id, normalization_version, observation) VALUES ($1, $2, 'delivery-observation/v1', $3::jsonb)
        ON CONFLICT (event_key) DO NOTHING`,
        [eventKey, lease.deliveryId, JSON.stringify(observation)],
      );
      const notice = await tx.query(
        `INSERT INTO leaderboard_ingestion.outbox (event_key) VALUES ($1) ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
        [eventKey],
      );
      if (row.operator_replay_receipt_id !== null) {
        // Bind the persisted replay and intake lease in the same transaction.
        // A pre-existing outbox notice is never claimed as this replay's result.
        await tx.query(
          `INSERT INTO leaderboard_ingestion.replay_processing_results(receipt_id,delivery_id,lease_token,event_key)
          VALUES($1,$2,$3,$4)`,
          [row.operator_replay_receipt_id, lease.deliveryId, lease.token, notice.rows.length ? eventKey : null],
        );
      }
      await tx.query(
        `UPDATE leaderboard_ingestion.inbox SET state = 'done', lease_token = NULL, lease_until = NULL
        WHERE delivery_id = $1`,
        [lease.deliveryId],
      );
      await tx.query(
        `UPDATE leaderboard_ingestion.attempt_history SET outcome = 'done', finished_at = clock_timestamp()
        WHERE lease_token = $1`,
        [lease.token],
      );
      return true;
    });
  }

  async fail(lease: Lease, code: FailureCode, permanent = false): Promise<boolean> {
    if (!failureCodes.has(code)) throw new Error("Unknown failure code");
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE leaderboard_ingestion.inbox SET
      state = CASE WHEN $4 OR attempts >= $5 THEN 'quarantined' ELSE 'pending' END,
      available_at = clock_timestamp() + LEAST(300, power(2, attempts)) * interval '1 second',
      lease_token = NULL, lease_until = NULL, reason_code = $3
      WHERE delivery_id = $1 AND lease_token = $2 AND state = 'leased' AND lease_until > clock_timestamp()
      RETURNING state`,
        [lease.deliveryId, lease.token, code, permanent, this.maxAttempts],
      );
      if (!result.rows.length) return false;
      await tx.query(
        `UPDATE leaderboard_ingestion.attempt_history SET outcome = $2,
        finished_at = clock_timestamp(), reason_code = $3 WHERE lease_token = $1`,
        [lease.token, result.rows[0]?.state === "pending" ? "retry" : "quarantined", code],
      );
      return true;
    });
  }

  /** Operator-only primitive. The host must authorize the opaque correction/replay receipt. */
  async replay(deliveryId: string, receiptId: string, audit?: ReplayAudit): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receiptId)) throw new Error("Invalid replay receipt ID");
    if (
      audit &&
      (!/^[A-Za-z0-9_.:-]{1,128}$/.test(audit.operatorId) ||
        !["source_recovered", "normalization_corrected", "operator_reviewed"].includes(audit.reason) ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(audit.policyVersion) ||
        (audit.resultingRevision !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(audit.resultingRevision)))
    )
      throw new Error("Invalid replay audit");
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        `SELECT attempts, reason_code FROM leaderboard_ingestion.inbox
        WHERE delivery_id = $1 AND state = 'quarantined' FOR UPDATE`,
        [deliveryId],
      );
      const prior = result.rows[0];
      if (!prior) return false;
      await tx.query(
        `INSERT INTO leaderboard_ingestion.replay_receipts
        (receipt_id, delivery_id, prior_attempts, prior_reason_code, audit) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          receiptId,
          deliveryId,
          prior.attempts,
          prior.reason_code,
          audit
            ? JSON.stringify({
                operatorId: audit.operatorId,
                reason: audit.reason,
                policyVersion: audit.policyVersion,
                resultingRevision: audit.resultingRevision,
              })
            : null,
        ],
      );
      await tx.query(
        `UPDATE leaderboard_ingestion.inbox SET state = 'pending', attempts = 0,
        available_at = clock_timestamp(), reason_code = NULL, operator_replay_receipt_id = NULL WHERE delivery_id = $1`,
        [deliveryId],
      );
      return true;
    });
  }

  /** Operational metrics describe retained delivery processing, never source connectivity. */
  async health(): Promise<Record<string, unknown>> {
    return (
      await this.db.query(`SELECT
      count(*) FILTER (WHERE state = 'pending')::integer AS pending,
      count(*) FILTER (WHERE state = 'leased')::integer AS leased,
      count(*) FILTER (WHERE state = 'quarantined')::integer AS quarantined,
      count(*) FILTER (WHERE state = 'done')::integer AS completed,
      EXTRACT(EPOCH FROM (clock_timestamp() - min(received_at) FILTER (WHERE state IN ('pending','leased'))))::double precision AS oldest_unfinished_seconds,
      max(received_at) AS latest_received_at,
      (SELECT max(finished_at) FROM leaderboard_ingestion.attempt_history WHERE outcome = 'done') AS last_processed_at
      FROM leaderboard_ingestion.inbox`)
    ).rows[0]!;
  }
}
