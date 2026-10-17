import { randomUUID } from "node:crypto";
import type { SourceFact } from "./collection.js";
import type { SqlDatabase } from "./store.js";

export interface SourceMetadata {
  sourceRevision: string;
  acceptedOutcome: boolean | null;
  reviewState: "approved" | "changes_requested" | "commented" | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}
export interface EnrichmentSource {
  readMetadata(request: { repositoryId: number; fact: SourceFact }): Promise<SourceMetadata>;
}

function metadata(value: SourceMetadata, revision: string): SourceMetadata {
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

  async processOne(
    source: EnrichmentSource,
    leaseSeconds = 60,
  ): Promise<"idle" | "classified" | "excluded" | "failed" | "lease_lost"> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600)
      throw new Error("invalid_enrichment_lease");
    const token = randomUUID();
    const job = await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE leaderboard_ingestion.enrichment_jobs SET state = 'failed', lease_token = NULL,
        lease_until = NULL, reason = 'attempts_exhausted', updated_at = clock_timestamp()
        WHERE state = 'leased' AND lease_until <= clock_timestamp() AND attempts >= $1`,
        [this.maxAttempts],
      );
      const result = await tx.query(
        `WITH candidate AS (
        SELECT job.fact_key, job.policy_version, access.generation FROM leaderboard_ingestion.enrichment_jobs AS job
        JOIN leaderboard_ingestion.source_facts AS fact ON fact.fact_key = job.fact_key
        JOIN leaderboard_ingestion.repository_access AS access ON access.repository_id = fact.repository_id
        WHERE access.state = 'public' AND job.attempts < $1 AND ((job.state IN ('pending','failed') AND job.available_at <= clock_timestamp())
          OR (job.state = 'leased' AND job.lease_until <= clock_timestamp()))
        ORDER BY job.updated_at, job.fact_key FOR UPDATE OF job SKIP LOCKED LIMIT 1
      ) UPDATE leaderboard_ingestion.enrichment_jobs AS job SET state = 'leased', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + $3 * interval '1 second',
        access_generation = candidate.generation, reason = NULL, updated_at = clock_timestamp()
        FROM candidate WHERE job.fact_key = candidate.fact_key AND job.policy_version = candidate.policy_version RETURNING job.*`,
        [this.maxAttempts, token, leaseSeconds],
      );
      const lease = result.rows[0];
      if (!lease) return null;
      const fact = (
        await tx.query("SELECT repository_id, document FROM leaderboard_ingestion.source_facts WHERE fact_key = $1", [
          lease.fact_key,
        ])
      ).rows[0]!;
      return {
        fact_key: String(lease.fact_key),
        policy_version: String(lease.policy_version),
        access_generation: String(lease.access_generation),
        repositoryId: Number(fact.repository_id),
        fact: fact.document as unknown as SourceFact,
      };
    });
    if (!job) return "idle";
    try {
      const details = metadata(
        await source.readMetadata({ repositoryId: job.repositoryId, fact: job.fact }),
        job.fact.sourceRevision,
      );
      return await this.db.transaction(async (tx) => {
        const access = (
          await tx.query(
            "SELECT state, generation FROM leaderboard_ingestion.repository_access WHERE repository_id = $1 FOR SHARE",
            [job.repositoryId],
          )
        ).rows[0];
        if (access?.state !== "public" || String(access.generation) !== String(job.access_generation))
          throw new Error("source_access_changed");
        const state = details.acceptedOutcome ? "classified" : "excluded";
        const saved = await tx.query(
          `UPDATE leaderboard_ingestion.enrichment_jobs SET state = $4,
          metadata = $5::jsonb, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
          WHERE fact_key = $1 AND policy_version = $2 AND lease_token = $3 AND state = 'leased'
          AND lease_until > clock_timestamp() RETURNING fact_key`,
          [job.fact_key, job.policy_version, token, state, JSON.stringify(details)],
        );
        return saved.rows.length ? state : "lease_lost";
      });
    } catch {
      const failed = await this.db.query(
        `UPDATE leaderboard_ingestion.enrichment_jobs SET state = 'failed',
        reason = 'enrichment_unavailable', lease_token = NULL, lease_until = NULL,
        available_at = clock_timestamp() + LEAST(300, power(2, attempts)) * interval '1 second', updated_at = clock_timestamp()
        WHERE fact_key = $1 AND policy_version = $2 AND lease_token = $3 AND state = 'leased'
        AND lease_until > clock_timestamp() RETURNING fact_key`,
        [job.fact_key, job.policy_version, token],
      );
      return failed.rows.length ? "failed" : "lease_lost";
    }
  }
}
