import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SqlDatabase, SqlSession } from "./store.js";
import type { Envelope } from "./webhook.js";

export interface DispatchBinding {
  configurationHash: string;
  configurationVersion: string;
  configurationRevision: number;
  normalizationVersion: string;
  policyVersion: string;
  dataMode: "synthetic";
  cutoff: string;
}
export interface DispatchOperation extends DispatchBinding {
  operationKey: string;
}
export interface OutboxLease {
  eventKey: string;
  token: string;
  attempt: number;
  collectionRevision: number;
  normalizationVersion: string;
  observation: Envelope;
  operation: DispatchOperation;
}
export interface DispatchPublication {
  scopeKey: string;
  snapshotId: string;
  revision: number;
}
/** Bounds retained references while admitting canonical scopes with all 100
 * maximum-length Project identities, all roles and maximum-length base fields. */
export const dispatchPublicationScopeKeyLimit = 16_384;
export type DispatchFailure =
  | "unsupported_observation"
  | "configuration_changed"
  | "source_unavailable"
  | "enrichment_unavailable"
  | "publication_unavailable";
export type DispatchStatus = "idle" | "processed" | "lease_lost" | "retry_scheduled" | "quarantined" | "blocked";
const failures = new Set<DispatchFailure>([
  "unsupported_observation",
  "configuration_changed",
  "source_unavailable",
  "enrichment_unavailable",
  "publication_unavailable",
]);
function time(value: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("invalid_dispatch_time");
}
function binding(value: DispatchBinding): DispatchBinding {
  time(value.cutoff);
  if (
    !/^[a-f0-9]{64}$/.test(value.configurationHash) ||
    value.dataMode !== "synthetic" ||
    !Number.isSafeInteger(value.configurationRevision) ||
    value.configurationRevision < 0 ||
    [value.configurationVersion, value.normalizationVersion, value.policyVersion].some(
      (item) => typeof item !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item),
    )
  )
    throw new Error("invalid_dispatch_binding");
  return {
    configurationHash: value.configurationHash,
    configurationVersion: value.configurationVersion,
    configurationRevision: value.configurationRevision,
    normalizationVersion: value.normalizationVersion,
    policyVersion: value.policyVersion,
    dataMode: value.dataMode,
    cutoff: value.cutoff,
  };
}

/** Durable invalidation notices. Only a protected host can supply publication proof. */
export class OutboxStore {
  constructor(
    readonly db: SqlDatabase,
    readonly maxAttempts = 5,
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new Error("invalid_dispatch_budget");
  }

  async claim(requested: DispatchBinding, leaseSeconds = 60): Promise<OutboxLease | null> {
    const requestedBinding = binding(requested);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600)
      throw new Error("invalid_dispatch_lease");
    return this.db.transaction(async (tx) => {
      const exhausted = await tx.query(
        `WITH expired AS (
        SELECT event_key,lease_token FROM leaderboard_ingestion.outbox
        WHERE state='leased' AND lease_until<=clock_timestamp() AND attempts >= $1
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100)
        UPDATE leaderboard_ingestion.outbox AS item SET state='quarantined',lease_token=NULL,lease_until=NULL,reason_code='attempts_exhausted'
        FROM expired WHERE item.event_key=expired.event_key RETURNING expired.lease_token`,
        [this.maxAttempts],
      );
      for (const row of exhausted.rows) await this.expire(tx, String(row.lease_token));
      const prior = (
        await tx.query(
          `SELECT * FROM leaderboard_ingestion.outbox
        WHERE attempts < $1 AND ((state='pending' AND available_at<=clock_timestamp()) OR (state='leased' AND lease_until<=clock_timestamp()))
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [this.maxAttempts],
        )
      ).rows[0];
      if (!prior) return null;
      if (prior.lease_token) await this.expire(tx, String(prior.lease_token));
      const token = randomUUID();
      const operation = prior.operation ?? {
        ...requestedBinding,
        operationKey: createHash("sha256")
          .update(JSON.stringify(["outbox-dispatch/v1", prior.event_key, requestedBinding]))
          .digest("hex"),
      };
      await tx.query(
        `UPDATE leaderboard_ingestion.outbox SET state='leased',attempts=attempts+1,
        lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 second',reason_code=NULL,operation=$4::jsonb
        WHERE event_key=$1`,
        [prior.event_key, token, leaseSeconds, JSON.stringify(operation)],
      );
      await tx.query(
        `INSERT INTO leaderboard_ingestion.outbox_attempts(lease_token,event_key,attempt,outcome) VALUES($1,$2,$3,'leased')`,
        [token, prior.event_key, Number(prior.attempts) + 1],
      );
      const observation = (
        await tx.query(
          `SELECT normalization_version,observation FROM leaderboard_ingestion.observations WHERE event_key=$1`,
          [prior.event_key],
        )
      ).rows[0]!;
      return {
        eventKey: String(prior.event_key),
        token,
        attempt: Number(prior.attempts) + 1,
        collectionRevision: Number(prior.collection_revision),
        operation: operation as DispatchOperation,
        normalizationVersion: String(observation.normalization_version),
        observation: observation.observation as unknown as Envelope,
      };
    });
  }

  private async expire(tx: SqlSession, token: string): Promise<void> {
    await tx.query(
      `UPDATE leaderboard_ingestion.outbox_attempts SET outcome='expired',finished_at=clock_timestamp(),reason_code='lease_expired' WHERE lease_token=$1 AND outcome='leased'`,
      [token],
    );
  }

  /** Fence every durable publication against the current persisted operation and lease. */
  async assertLease(tx: SqlSession, lease: OutboxLease): Promise<void> {
    const row = (
      await tx.query(
        `SELECT operation,collection_revision FROM leaderboard_ingestion.outbox WHERE event_key=$1 AND lease_token=$2 AND state='leased' AND lease_until>clock_timestamp() FOR UPDATE`,
        [lease.eventKey, lease.token],
      )
    ).rows[0];
    if (
      !row ||
      (row.operation as DispatchOperation)?.operationKey !== lease.operation.operationKey ||
      Number(row.collection_revision) !== lease.collectionRevision
    )
      throw new Error("dispatch_lease_lost");
  }

  /** A complete, eventually consistent listing may not contain the trigger yet.
   * Only an unfrozen operation can refresh its collector/cache key. */
  async refreshCollection(lease: OutboxLease): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx, lease);
      const saved = await tx.query(
        `UPDATE leaderboard_ingestion.outbox SET collection_revision=collection_revision+1
        WHERE event_key=$1 AND lease_token=$2 AND observation_cutoff IS NULL RETURNING event_key`,
        [lease.eventKey, lease.token],
      );
      if (!saved.rows.length) throw new Error("dispatch_collection_already_frozen");
    });
  }

  /** Freeze after collection, before normalization. Restarts never admit later facts. */
  async freeze(
    lease: OutboxLease,
    cutoff: string,
    generations: Array<{ repositoryId: number; generation: string }>,
  ): Promise<{ cutoff: string; generations: Array<{ repositoryId: number; generation: string }> }> {
    time(cutoff);
    if (
      !generations.length ||
      generations.length > 100 ||
      generations.some(
        (item) =>
          !Number.isSafeInteger(item.repositoryId) || item.repositoryId < 1 || !/^[1-9]\d{0,18}$/.test(item.generation),
      )
    )
      throw new Error("invalid_dispatch_generations");
    return this.db.transaction(async (tx) => {
      await this.assertLease(tx, lease);
      const saved = (
        await tx.query(
          `UPDATE leaderboard_ingestion.outbox SET observation_cutoff=COALESCE(observation_cutoff,$3::timestamptz), source_generations=COALESCE(source_generations,$4::jsonb)
        WHERE event_key=$1 AND lease_token=$2 RETURNING observation_cutoff,source_generations`,
          [lease.eventKey, lease.token, cutoff, JSON.stringify(generations)],
        )
      ).rows[0]!;
      return {
        cutoff: new Date(saved.observation_cutoff as string).toISOString(),
        generations: saved.source_generations as Array<{ repositoryId: number; generation: string }>,
      };
    });
  }

  async complete(
    lease: OutboxLease,
    publications: DispatchPublication[],
    confirm: (tx: SqlSession) => Promise<void>,
    assertAuthorized: () => void = () => {},
  ): Promise<boolean> {
    if (
      !publications.length ||
      publications.length > 100 ||
      publications.some(
        (item) =>
          typeof item.scopeKey !== "string" ||
          item.scopeKey.length > dispatchPublicationScopeKeyLimit ||
          !/^[a-f0-9]{64}$/.test(item.snapshotId) ||
          !Number.isSafeInteger(item.revision) ||
          item.revision < 1,
      )
    )
      throw new Error("invalid_dispatch_publication");
    return this.db.transaction(async (tx) => {
      try {
        await this.assertLease(tx, lease);
      } catch (error) {
        if (error instanceof Error && error.message === "dispatch_lease_lost") return false;
        throw error;
      }
      await confirm(tx);
      await this.assertLease(tx, lease);
      assertAuthorized();
      await tx.query(
        `UPDATE leaderboard_ingestion.outbox SET state='done',lease_token=NULL,lease_until=NULL,reason_code=NULL,completion=$3::jsonb
        WHERE event_key=$1 AND lease_token=$2`,
        [lease.eventKey, lease.token, JSON.stringify({ operationKey: lease.operation.operationKey, publications })],
      );
      await tx.query(
        `UPDATE leaderboard_ingestion.outbox_attempts SET outcome='done',finished_at=clock_timestamp() WHERE lease_token=$1`,
        [lease.token],
      );
      assertAuthorized();
      return true;
    });
  }

  async fail(lease: OutboxLease, reason: DispatchFailure, permanent = false): Promise<DispatchStatus> {
    if (!failures.has(reason)) throw new Error("invalid_dispatch_failure");
    return this.db.transaction(async (tx) => {
      const saved = (
        await tx.query(
          `UPDATE leaderboard_ingestion.outbox SET
        state=CASE WHEN $4 OR attempts >= $5 THEN 'quarantined' ELSE 'pending' END,
        available_at=clock_timestamp()+LEAST(300,power(2,attempts))*interval '1 second',
        lease_token=NULL,lease_until=NULL,reason_code=$3
        WHERE event_key=$1 AND lease_token=$2 AND state='leased' AND lease_until>clock_timestamp() RETURNING state`,
          [lease.eventKey, lease.token, reason, permanent, this.maxAttempts],
        )
      ).rows[0];
      if (!saved) return "lease_lost";
      await tx.query(
        `UPDATE leaderboard_ingestion.outbox_attempts SET outcome=$2,reason_code=$3,finished_at=clock_timestamp() WHERE lease_token=$1`,
        [lease.token, saved.state === "pending" ? "retry" : "quarantined", reason],
      );
      return saved.state === "pending" ? "retry_scheduled" : "quarantined";
    });
  }

  /** Protected operator primitive: same frozen operation, fresh bounded attempt budget. */
  async replay(eventKey: string, receiptId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receiptId)) throw new Error("invalid_dispatch_replay_receipt");
    return this.db.transaction(async (tx) => {
      const prior = (
        await tx.query(
          `SELECT attempts,reason_code FROM leaderboard_ingestion.outbox WHERE event_key=$1 AND state='quarantined' FOR UPDATE`,
          [eventKey],
        )
      ).rows[0];
      if (!prior) return false;
      await tx.query(
        `INSERT INTO leaderboard_ingestion.outbox_replays(receipt_id,event_key,prior_attempts,prior_reason_code) VALUES($1,$2,$3,$4)`,
        [receiptId, eventKey, prior.attempts, prior.reason_code],
      );
      await tx.query(
        `UPDATE leaderboard_ingestion.outbox SET state='pending',attempts=0,reason_code=NULL,available_at=clock_timestamp() WHERE event_key=$1`,
        [eventKey],
      );
      return true;
    });
  }

  async health(): Promise<Record<string, unknown>> {
    return (
      await this.db.query(`SELECT count(*) FILTER(WHERE state='pending')::integer AS pending,
      count(*) FILTER(WHERE state='leased')::integer AS leased, count(*) FILTER(WHERE state='quarantined')::integer AS quarantined,
      count(*) FILTER(WHERE state='done')::integer AS completed FROM leaderboard_ingestion.outbox`)
    ).rows[0]!;
  }
}

/** One bounded dispatch at a time. Shutdown awaits in-flight work; errors never leak payloads. */
export async function runOutboxWorker(
  dispatch: () => Promise<DispatchStatus>,
  options: {
    signal: AbortSignal;
    idleMs?: number;
    failureBackoffMs?: number;
    onStatus?: (status: DispatchStatus | "store_unavailable") => void;
  },
): Promise<void> {
  const idle = options.idleMs ?? 1000,
    backoff = options.failureBackoffMs ?? 5000;
  if ([idle, backoff].some((value) => !Number.isInteger(value) || value < 1 || value > 60000))
    throw new Error("invalid_dispatch_delay");
  while (!options.signal.aborted) {
    let status: DispatchStatus | "store_unavailable";
    try {
      status = await dispatch();
    } catch {
      status = "store_unavailable";
    }
    try {
      options.onStatus?.(status);
    } catch {
      /* telemetry cannot change durable outcomes */
    }
    if (status === "processed" || status === "quarantined" || status === "lease_lost") continue;
    try {
      await delay(status === "idle" ? idle : backoff, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
