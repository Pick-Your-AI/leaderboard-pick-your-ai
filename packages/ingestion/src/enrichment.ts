import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { sourceFamilies, type SourceFact, type SourceFamily } from "./collection.js";
import type { SqlDatabase, SqlSession } from "./store.js";

export interface SourceMetadata {
  sourceRevision: string;
  acceptedOutcome: boolean | null;
  reviewState: "approved" | "changes_requested" | "commented" | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}
export interface EnrichmentSource {
  readMetadata(request: {
    repositoryId: number;
    family: SourceFamily;
    fact: SourceFact;
    signal: AbortSignal;
    assertAuthorized(): void;
  }): Promise<SourceMetadata>;
}

/** Trusted host authority, captured anew for each bounded worker/read operation. */
export interface EnrichmentScope {
  repositoryId: number;
  installationId: number;
  accessGeneration: string;
  family: SourceFamily;
  policyVersion: string;
  authorize(transaction: SqlSession): Promise<boolean>;
  current(): boolean;
  signal?: AbortSignal;
}

function capturedScope(value?: EnrichmentScope): EnrichmentScope | null {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.repositoryId) ||
    value.repositoryId < 1 ||
    !Number.isSafeInteger(value.installationId) ||
    value.installationId < 1 ||
    typeof value.accessGeneration !== "string" ||
    !/^[1-9]\d{0,18}$/.test(value.accessGeneration) ||
    BigInt(value.accessGeneration) > 9_223_372_036_854_775_807n ||
    !sourceFamilies.includes(value.family) ||
    typeof value.policyVersion !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.policyVersion) ||
    typeof value.authorize !== "function" ||
    typeof value.current !== "function" ||
    (value.signal !== undefined && !(value.signal instanceof AbortSignal))
  )
    throw new Error("invalid_enrichment_scope");
  return {
    repositoryId: value.repositoryId,
    installationId: value.installationId,
    accessGeneration: value.accessGeneration,
    family: value.family,
    policyVersion: value.policyVersion,
    authorize: value.authorize,
    current: value.current,
    signal: value.signal,
  };
}

function drainUnexpectedPromise(value: unknown, seen = new WeakSet<object>()): void {
  // Invalid authority values must not execute foreign then getters or methods.
  if (!types.isPromise(value) || seen.has(value)) return;
  seen.add(value);
  try {
    // Observe native rejection reasons once, including cycles; discard fulfilled
    // values. Promise constructor/species behavior remains trusted host code.
    void Promise.prototype.then.call(
      value,
      () => undefined,
      (reason) => drainUnexpectedPromise(reason, seen),
    );
  } catch {}
}

function current(scope: EnrichmentScope | null): void {
  if (!scope) return;
  if (scope.signal?.aborted) throw new Error("enrichment_authorization_changed");
  try {
    const result: unknown = scope.current();
    if (result === true) return;
    // Supplied host functions are synchronous; a promise is not authorization.
    drainUnexpectedPromise(result);
  } catch (error) {
    drainUnexpectedPromise(error);
  }
  throw new Error("enrichment_authorization_changed");
}

async function authorize(scope: EnrichmentScope | null, tx: SqlSession): Promise<void> {
  if (!scope) return;
  current(scope);
  let allowed = false;
  try {
    allowed = (await scope.authorize(tx)) === true;
  } catch {
    /* fixed denial */
  }
  current(scope);
  if (!allowed) throw new Error("enrichment_authorization_changed");
}

const values = (scope: EnrichmentScope | null) =>
  scope ? [scope.repositoryId, scope.installationId, scope.family, scope.policyVersion, scope.accessGeneration] : [];
const scoped = (scope: EnrichmentScope | null, start: number) =>
  scope
    ? `
  AND fact.repository_id=$${start} AND access.installation_id=$${start + 1}
  AND fact.family=$${start + 2} AND job.policy_version=$${start + 3}
  AND access.generation=$${start + 4}::bigint
  AND (job.access_generation IS NULL OR job.access_generation=access.generation)
  AND EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS item
    JOIN leaderboard_ingestion.collection_runs AS run USING(run_id)
    WHERE item.fact_key=fact.fact_key AND run.repository_id=fact.repository_id
      AND run.family=fact.family AND run.access_generation=access.generation)`
    : "";
const unsuppressed = `NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions AS removed
  WHERE removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id)`;

async function readMetadata(
  source: EnrichmentSource,
  request: { repositoryId: number; family: SourceFamily; fact: SourceFact },
  scope: EnrichmentScope | null,
  leaseSeconds: number,
): Promise<SourceMetadata> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  scope?.signal?.addEventListener("abort", abort, { once: true });
  // Leave half the SQL lease for completion; never await one adapter beyond 30 seconds.
  const timer = setTimeout(abort, Math.min(30_000, leaseSeconds * 500));
  let rejectAbort: (() => void) | undefined;
  try {
    const assertAuthorized = () => {
      current(scope);
      if (controller.signal.aborted) throw new Error("enrichment_read_aborted");
    };
    assertAuthorized();
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error("enrichment_read_aborted"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const pending = Promise.resolve().then(() => {
      assertAuthorized();
      return source.readMetadata({
        ...request,
        fact: structuredClone(request.fact),
        signal: controller.signal,
        assertAuthorized,
      });
    });
    // A late adapter rejection is observed by race; a late value has no write path.
    const result = await Promise.race([pending, aborted]);
    assertAuthorized();
    return result;
  } finally {
    clearTimeout(timer);
    scope?.signal?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}

function metadata(value: SourceMetadata, revision: string): SourceMetadata {
  // Read each allowed value once, so accessor-backed adapter responses cannot
  // change a field between validation and persistence. Untrusted text is omitted.
  value = {
    sourceRevision: value.sourceRevision,
    acceptedOutcome: value.acceptedOutcome,
    reviewState: value.reviewState,
    additions: value.additions,
    deletions: value.deletions,
    changedFiles: value.changedFiles,
  };
  if (
    value.sourceRevision !== revision ||
    typeof value.acceptedOutcome !== "boolean" ||
    ![null, "approved", "changes_requested", "commented"].includes(value.reviewState)
  )
    throw new Error("unproven_enrichment");
  for (const count of [value.additions, value.deletions, value.changedFiles]) {
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error("invalid_file_statistics");
  }
  return {
    sourceRevision: value.sourceRevision,
    acceptedOutcome: value.acceptedOutcome,
    reviewState: value.reviewState,
    additions: value.additions,
    deletions: value.deletions,
    changedFiles: value.changedFiles,
  };
}

/** Durable asynchronous metadata classification. Neither state nor metadata awards contribution credit. */
export class EnrichmentStore {
  constructor(
    readonly db: SqlDatabase,
    readonly maxAttempts = 5,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new Error("invalid_enrichment_budget");
  }

  async enqueue(factKey: string, policyVersion: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(factKey) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(policyVersion))
      throw new Error("invalid_enrichment_scope");
    await this.db.query(
      `INSERT INTO leaderboard_ingestion.enrichment_jobs (fact_key, policy_version) VALUES ($1,$2)
      ON CONFLICT (fact_key, policy_version) DO NOTHING`,
      [factKey, policyVersion],
    );
  }

  /** A bounded host-selected batch; recheck retained source admission inside the write transaction. */
  async enqueueScoped(factKeys: readonly string[], authority: EnrichmentScope): Promise<number> {
    const scope = capturedScope(authority)!;
    if (!scope) throw new Error("invalid_enrichment_scope");
    const keys = [...factKeys];
    if (
      !keys.length ||
      keys.length > 100 ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
    )
      throw new Error("invalid_enrichment_batch");
    const count = await this.db.transaction(async (tx) => {
      await authorize(scope, tx);
      const access = (
        await tx.query(
          `SELECT state,generation,installation_id FROM
        leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE`,
          [scope.repositoryId],
        )
      ).rows[0];
      if (
        access?.state !== "public" ||
        Number(access.installation_id) !== scope.installationId ||
        String(access.generation) !== scope.accessGeneration
      )
        throw new Error("source_access_changed");
      const result = await tx.query(
        `INSERT INTO leaderboard_ingestion.enrichment_jobs (fact_key,policy_version,access_generation)
        SELECT fact.fact_key,$4,$5 FROM leaderboard_ingestion.source_facts AS fact
        WHERE fact.fact_key=ANY($1::text[]) AND fact.repository_id=$2 AND fact.family=$3
          AND ${unsuppressed}
          AND EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_items AS item
            JOIN leaderboard_ingestion.collection_runs AS run USING(run_id)
            WHERE item.fact_key=fact.fact_key AND run.repository_id=fact.repository_id
              AND run.family=fact.family AND run.access_generation=$5)
        ON CONFLICT (fact_key,policy_version) DO NOTHING RETURNING fact_key`,
        [keys, scope.repositoryId, scope.family, scope.policyVersion, access.generation],
      );
      await authorize(scope, tx);
      return result.rows.length;
    });
    current(scope);
    return count;
  }

  /** Private host inspection only. Never returns adapter text or metadata. */
  async readStates(authority: EnrichmentScope, limit = 100) {
    const scope = capturedScope(authority)!;
    if (!scope) throw new Error("invalid_enrichment_scope");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_enrichment_limit");
    const result = await this.db.transaction(async (tx) => {
      await authorize(scope, tx);
      const access = (
        await tx.query(
          `SELECT state,installation_id,generation FROM
        leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE`,
          [scope.repositoryId],
        )
      ).rows[0];
      if (
        access?.state !== "public" ||
        Number(access.installation_id) !== scope.installationId ||
        String(access.generation) !== scope.accessGeneration
      )
        throw new Error("source_access_changed");
      const rows = (
        await tx.query(
          `SELECT job.fact_key,job.state,job.attempts,job.reason,fact.source_revision
        FROM leaderboard_ingestion.enrichment_jobs AS job
        JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key)
        JOIN leaderboard_ingestion.repository_access AS access ON access.repository_id=fact.repository_id
        WHERE access.state='public' AND ${unsuppressed} ${scoped(scope, 2)}
        ORDER BY job.updated_at,job.fact_key LIMIT $1`,
          [limit, ...values(scope)],
        )
      ).rows;
      const records = rows.map((row) => ({
        factKey: String(row.fact_key),
        sourceRevision: String(row.source_revision),
        state: String(row.state),
        attempts: Number(row.attempts),
        reason: ["enrichment_unavailable", "attempts_exhausted"].includes(String(row.reason))
          ? String(row.reason)
          : null,
      }));
      await authorize(scope, tx);
      return records;
    });
    current(scope);
    return result;
  }

  async processOne(
    source: EnrichmentSource,
    leaseSeconds = 60,
    authority?: EnrichmentScope,
  ): Promise<"idle" | "classified" | "excluded" | "failed" | "lease_lost"> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600)
      throw new Error("invalid_enrichment_lease");
    const scope = capturedScope(authority);
    const token = randomUUID();
    const job = await this.db.transaction(async (tx) => {
      await authorize(scope, tx);
      if (scope) {
        const access = (
          await tx.query(
            `SELECT state,installation_id,generation FROM
          leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE`,
            [scope.repositoryId],
          )
        ).rows[0];
        if (
          access?.state !== "public" ||
          Number(access.installation_id) !== scope.installationId ||
          String(access.generation) !== scope.accessGeneration
        ) {
          await authorize(scope, tx);
          return null;
        }
      }
      await tx.query(
        `UPDATE leaderboard_ingestion.enrichment_jobs AS job SET state = 'failed', lease_token = NULL,
        lease_until = NULL, reason = 'attempts_exhausted', updated_at = clock_timestamp()
        FROM leaderboard_ingestion.source_facts AS fact, leaderboard_ingestion.repository_access AS access
        WHERE job.fact_key=fact.fact_key AND access.repository_id=fact.repository_id
        AND access.state='public' AND ${unsuppressed}
        AND (job.access_generation IS NULL OR job.access_generation=access.generation)
        AND job.state = 'leased' AND job.lease_until <= clock_timestamp() AND job.attempts >= $1 ${scoped(scope, 2)}`,
        [this.maxAttempts, ...values(scope)],
      );
      const result = await tx.query(
        `WITH candidate AS (
        SELECT job.fact_key, job.policy_version, access.generation FROM leaderboard_ingestion.enrichment_jobs AS job
        JOIN leaderboard_ingestion.source_facts AS fact ON fact.fact_key = job.fact_key
        JOIN leaderboard_ingestion.repository_access AS access ON access.repository_id = fact.repository_id
        WHERE access.state = 'public' AND ${unsuppressed} ${scoped(scope, 4)}
          AND job.attempts < $1 AND ((job.state IN ('pending','failed') AND job.available_at <= clock_timestamp())
          OR (job.state = 'leased' AND job.lease_until <= clock_timestamp()))
        ORDER BY job.updated_at, job.fact_key FOR UPDATE OF job SKIP LOCKED LIMIT 1
      ) UPDATE leaderboard_ingestion.enrichment_jobs AS job SET state = 'leased', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + $3 * interval '1 second',
        access_generation = candidate.generation, reason = NULL, updated_at = clock_timestamp()
        FROM candidate WHERE job.fact_key = candidate.fact_key AND job.policy_version = candidate.policy_version RETURNING job.*`,
        [this.maxAttempts, token, leaseSeconds, ...values(scope)],
      );
      const lease = result.rows[0];
      if (!lease) {
        await authorize(scope, tx);
        return null;
      }
      const fact = (
        await tx.query(
          "SELECT repository_id, family, document FROM leaderboard_ingestion.source_facts WHERE fact_key = $1",
          [lease.fact_key],
        )
      ).rows[0]!;
      await authorize(scope, tx);
      return {
        fact_key: String(lease.fact_key),
        policy_version: String(lease.policy_version),
        access_generation: String(lease.access_generation),
        repositoryId: Number(fact.repository_id),
        family: fact.family as SourceFamily,
        fact: fact.document as unknown as SourceFact,
      };
    });
    current(scope);
    if (!job) return "idle";
    try {
      const details = metadata(
        // Adapter-local edits cannot replace the retained revision checked after the await.
        await readMetadata(
          source,
          {
            repositoryId: job.repositoryId,
            family: job.family,
            fact: job.fact,
          },
          scope,
          leaseSeconds,
        ),
        job.fact.sourceRevision,
      );
      const result = await this.db.transaction(async (tx) => {
        await authorize(scope, tx);
        const access = (
          await tx.query(
            "SELECT state, generation, installation_id FROM leaderboard_ingestion.repository_access WHERE repository_id = $1 FOR SHARE",
            [job.repositoryId],
          )
        ).rows[0];
        if (
          access?.state !== "public" ||
          String(access.generation) !== String(job.access_generation) ||
          (scope && Number(access.installation_id) !== scope.installationId)
        )
          throw new Error("source_access_changed");
        if (
          (
            await tx.query(
              `SELECT 1 FROM leaderboard_ingestion.object_suppressions
          WHERE repository_id=$1 AND subject_id=$2`,
              [job.repositoryId, job.fact.subjectId],
            )
          ).rows.length
        )
          throw new Error("source_access_changed");
        const state = details.acceptedOutcome ? "classified" : "excluded";
        const saved = await tx.query(
          `UPDATE leaderboard_ingestion.enrichment_jobs SET state = $4,
          metadata = $5::jsonb, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
          WHERE fact_key = $1 AND policy_version = $2 AND lease_token = $3 AND state = 'leased'
          AND lease_until > clock_timestamp() RETURNING fact_key`,
          [job.fact_key, job.policy_version, token, state, JSON.stringify(details)],
        );
        await authorize(scope, tx);
        return saved.rows.length ? state : "lease_lost";
      });
      current(scope);
      return result;
    } catch {
      // A failure is also a write. Revoked hosts leave their lease for authorized
      // recovery instead of writing a failure record after losing authority.
      const markFailed = async (tx: SqlSession) => {
        await authorize(scope, tx);
        const denied = () => {
          if (scope) throw new Error("enrichment_authorization_changed");
          return { rows: [] };
        };
        const access = (
          await tx.query(
            "SELECT state,generation,installation_id FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE",
            [job.repositoryId],
          )
        ).rows[0];
        if (
          access?.state !== "public" ||
          String(access.generation) !== job.access_generation ||
          (scope && Number(access.installation_id) !== scope.installationId)
        )
          return denied();
        if (
          (
            await tx.query(
              "SELECT 1 FROM leaderboard_ingestion.object_suppressions WHERE repository_id=$1 AND subject_id=$2",
              [job.repositoryId, job.fact.subjectId],
            )
          ).rows.length
        )
          return denied();
        const failed = await tx.query(
          `UPDATE leaderboard_ingestion.enrichment_jobs SET state = 'failed',
          reason = 'enrichment_unavailable', lease_token = NULL, lease_until = NULL,
          available_at = clock_timestamp() + LEAST(300, power(2, attempts)) * interval '1 second', updated_at = clock_timestamp()
          WHERE fact_key = $1 AND policy_version = $2 AND lease_token = $3 AND state = 'leased'
          AND lease_until > clock_timestamp() RETURNING fact_key`,
          [job.fact_key, job.policy_version, token],
        );
        await authorize(scope, tx);
        return failed;
      };
      const failed = await this.db.transaction(markFailed);
      current(scope);
      return failed.rows.length ? "failed" : "lease_lost";
    }
  }
}
