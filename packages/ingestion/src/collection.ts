import { createHash } from "node:crypto";
import type { SqlDatabase, SqlSession } from "./store.js";
import {
  collectionContentEditMetadata,
  type ContentEditMetadata,
  type CommentEditMetadata,
} from "./content-edit-metadata.js";
import { collectionDiscussionFeedback } from "./discussion-feedback.js";
import type { DiscussionFeedbackObservation } from "@pick-your-ai/contracts";
import {
  collectionPullRequestDecisionObservation,
  assertPullRequestDecisionPersistence,
  pullRequestDecisionProducerBinding,
  type PullRequestDecisionObservation,
} from "./pull-request-decision-observation.js";

export const sourceFamilies = [
  "issues",
  "pull_requests",
  "commits",
  "reviews",
  "comments",
  "releases",
  "discussions",
  "timelines",
  "content_edits",
  "project_history",
  "project_curation_history",
  "issue_field_history",
  "relationships",
  "project_current",
] as const;
export type SourceFamily = (typeof sourceFamilies)[number];
export interface ScanRequest {
  runId: string;
  repositoryId: number;
  family: SourceFamily;
  mode: "backfill" | "reconcile" | "audit";
  since: string | null;
  until: string;
}
export interface SourceFact {
  subjectId: string;
  /** Collected native issue/PR node ID for a typed history event. */
  historySubjectId?: string;
  /** Project of one native add/remove event; never a fabricated ProjectV2Item ID. */
  projectCurationProjectId?: string;
  /** Native issue field identity; field content is never retained in collection facts. */
  issueFieldId?: string;
  /** Native issue/PR identity for a complete current Project membership snapshot. */
  projectSubjectId?: string;
  /** Private native-parent or published-comment metadata, never transition or recognition evidence. */
  contentEditMetadata?: ContentEditMetadata | CommentEditMetadata;
  /** Private content fingerprints and complete-observation generation; never raw text. */
  discussionFeedback?: DiscussionFeedbackObservation;
  /** Private native decision observation; never a public contribution or current-state transition. */
  pullRequestDecisionHistory?: PullRequestDecisionObservation;
  sourceRevision: string;
  sourceUrl: string;
  /** Snapshot state never establishes a transition's actor or occurrence time. */
  evidence: "current_state" | "observed_transition";
  actorId: string | null;
  occurredAt: string | null;
  state: "open" | "closed" | "merged" | "deleted" | "reverted" | "present" | "unavailable";
}
export interface SourcePage {
  repositoryId: number;
  visibility: "public";
  facts: SourceFact[];
  nextCursor: string | null;
  /** Exact count for this fixed scan, or null when the source cannot establish it. */
  expectedCount: number | null;
}
/** Adapter performs only read requests and must fully traverse nested pagination via its opaque cursor. */
export interface ReadOnlySource {
  /** Optional synchronous host-authorization fence, rechecked inside the write transaction. */
  assertAuthorized?(): void;
  readPage(request: ScanRequest & { cursor: string | null; limit: number }): Promise<SourcePage>;
}

function id(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_=.:\-]{1,128}$/.test(value)) throw new Error("invalid_collection_id");
}
function repository(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_repository_id");
}
function timestamp(value: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("invalid_collection_time");
}
function cursor(value: string | null): void {
  if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9_=.:/-]{1,1024}$/.test(value)))
    throw new Error("invalid_collection_cursor");
}
function validateScanRequest(request: ScanRequest): void {
  id(request.runId);
  repository(request.repositoryId);
  timestamp(request.until);
  if (request.since !== null) {
    timestamp(request.since);
    if (request.since >= request.until) throw new Error("invalid_scan_window");
  }
  if (!sourceFamilies.includes(request.family) || !["backfill", "reconcile", "audit"].includes(request.mode))
    throw new Error("invalid_scan_scope");
  if (request.family === "project_curation_history" && request.since !== null)
    throw new Error("project_curation_full_scan_required");
}
function normalizeFact(value: SourceFact, family: SourceFamily, repositoryId: number): SourceFact {
  // Reject proxy facts and prototype chains before the legacy optional readers.
  const pullRequestDecisionHistory = collectionPullRequestDecisionObservation(value, family, repositoryId);
  const contentEditMetadata = collectionContentEditMetadata(value, family, repositoryId);
  const discussionFeedback = collectionDiscussionFeedback(value, family);
  id(value.subjectId);
  if (value.historySubjectId !== undefined) id(value.historySubjectId);
  if (value.projectCurationProjectId !== undefined) id(value.projectCurationProjectId);
  if (value.issueFieldId !== undefined) {
    id(value.issueFieldId);
    if (value.historySubjectId === undefined || value.evidence !== "observed_transition")
      throw new Error("invalid_issue_field_subject");
  }
  if (value.projectSubjectId !== undefined) {
    id(value.projectSubjectId);
    if (value.projectSubjectId !== value.subjectId || value.evidence !== "current_state")
      throw new Error("invalid_current_project_subject");
  }
  id(value.sourceRevision);
  const url = new URL(value.sourceUrl);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    (url.hash !== "" &&
      !/^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+|discussioncomment-\d+)$/.test(url.hash)) ||
    !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/(issues|pull|commit|releases(?:\/tag)?|discussions)\/[A-Za-z0-9_.-]+$/.test(
      url.pathname,
    )
  )
    throw new Error("invalid_source_url");
  if (
    !["current_state", "observed_transition"].includes(value.evidence) ||
    !["open", "closed", "merged", "deleted", "reverted", "present", "unavailable"].includes(value.state)
  )
    throw new Error("invalid_source_fact");
  if (value.actorId !== null) id(value.actorId);
  if (value.occurredAt !== null) timestamp(value.occurredAt);
  if (value.evidence === "current_state" && (value.actorId !== null || value.occurredAt !== null))
    throw new Error("snapshot_attribution_forbidden");
  // Pick fields explicitly. Repository text and adapter extras are never retained or executed.
  const normalized: SourceFact = {
    subjectId: value.subjectId,
    ...(value.historySubjectId !== undefined ? { historySubjectId: value.historySubjectId } : {}),
    ...(value.projectCurationProjectId === undefined
      ? {}
      : { projectCurationProjectId: value.projectCurationProjectId }),
    ...(value.issueFieldId !== undefined ? { issueFieldId: value.issueFieldId } : {}),
    ...(value.projectSubjectId !== undefined ? { projectSubjectId: value.projectSubjectId } : {}),
    sourceRevision: value.sourceRevision,
    sourceUrl: url.href,
    evidence: value.evidence,
    actorId: value.actorId,
    occurredAt: value.occurredAt,
    state: value.state,
    ...(contentEditMetadata !== undefined ? { contentEditMetadata } : {}),
    ...(discussionFeedback !== undefined ? { discussionFeedback } : {}),
    ...(pullRequestDecisionHistory !== undefined ? { pullRequestDecisionHistory } : {}),
  };
  if (discussionFeedback === undefined && normalized.sourceRevision.startsWith("gdf"))
    throw new Error("invalid_discussion_feedback_source_fact");
  // Check the captured value, including legacy inherited/accessor properties, without rereading the input.
  if (
    contentEditMetadata === undefined &&
    typeof normalized.sourceRevision === "string" &&
    normalized.sourceRevision.startsWith("gh-content-edit-")
  )
    throw new TypeError("invalid_content_edit_metadata");
  return normalized;
}

export async function assertRepositoryAvailable(
  db: SqlSession,
  repositoryId: number,
  subjectId: string | null = null,
): Promise<void> {
  const access = await db.query(
    "SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id = $1 AND state = 'public' FOR SHARE",
    [repositoryId],
  );
  if (!access.rows.length) throw new Error("repository_unavailable");
  const denied = await db.query(
    "SELECT repository_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id = $1 AND subject_id = $2",
    [repositoryId, subjectId],
  );
  if (denied.rows.length) throw new Error("repository_unavailable");
}

/** Trusted construction only; this binding is never accepted from a scan or page. */
export interface DecisionHistoryCollectionProducer {
  sourceId: string;
  dataMode: "public" | "synthetic";
  repositoryIds: readonly number[];
  source: ReadOnlySource;
}

export class CollectionStore {
  readonly #decisionProducer: string | null;
  readonly #decisionRepositories: readonly number[];
  readonly #decisionSource: ReadOnlySource | null;
  readonly #decisionReadPage: ReadOnlySource["readPage"] | null;
  readonly #decisionAuthorize: (() => void) | null;
  readonly #decisionAuthorizationMethod: ReadOnlySource["assertAuthorized"] | null;

  constructor(
    readonly db: SqlDatabase,
    decisionProducer?: DecisionHistoryCollectionProducer,
  ) {
    this.#decisionProducer =
      decisionProducer === undefined
        ? null
        : pullRequestDecisionProducerBinding(decisionProducer.sourceId, decisionProducer.dataMode);
    const repositories = decisionProducer === undefined ? [] : [...decisionProducer.repositoryIds];
    if (
      repositories.length > 1000 ||
      repositories.some((value) => !Number.isSafeInteger(value) || value < 1) ||
      new Set(repositories).size !== repositories.length ||
      (decisionProducer !== undefined &&
        (!repositories.length ||
          typeof decisionProducer.source?.readPage !== "function" ||
          typeof decisionProducer.source.assertAuthorized !== "function"))
    )
      throw new TypeError("invalid_pull_request_decision_producer");
    this.#decisionRepositories = Object.freeze(repositories);
    this.#decisionSource = decisionProducer?.source ?? null;
    this.#decisionReadPage = this.#decisionSource?.readPage ?? null;
    const authorize = this.#decisionSource?.assertAuthorized ?? null;
    this.#decisionAuthorizationMethod = authorize;
    this.#decisionAuthorize = authorize
      ? () => {
          const result: unknown = authorize.call(this.#decisionSource);
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("pull_request_decision_authorization_invalid");
          }
        }
      : null;
  }

  #producerFor(request: { repositoryId: number; family: string }): string | null {
    return request.family === "pull_requests" && this.#decisionRepositories.includes(request.repositoryId)
      ? this.#decisionProducer
      : null;
  }

  #assertProducer(row: Record<string, unknown>, source?: ReadOnlySource): string | null {
    const expected = this.#producerFor({ repositoryId: Number(row.repository_id), family: String(row.family) });
    if ((row.decision_producer ?? null) !== expected) throw new Error("pull_request_decision_producer_binding_changed");
    if (expected !== null) {
      if (
        (source !== undefined && source !== this.#decisionSource) ||
        this.#decisionSource?.readPage !== this.#decisionReadPage ||
        this.#decisionSource?.assertAuthorized !== this.#decisionAuthorizationMethod
      )
        throw new Error("pull_request_decision_producer_changed");
      this.#decisionAuthorize!();
    }
    return expected;
  }

  /** Host supplies a fresh read-only visibility probe. A stale probe cannot undo a revocation. */
  async verifyPublic(
    repositoryId: number,
    installationId: number,
    expectedGeneration: string | null,
  ): Promise<boolean> {
    repository(repositoryId);
    repository(installationId);
    if (expectedGeneration !== null && !/^[1-9]\d{0,18}$/.test(expectedGeneration))
      throw new Error("invalid_access_generation");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [installationId]);
      const revoked = await tx.query(
        "SELECT installation_id FROM leaderboard_ingestion.lifecycle_receipts WHERE installation_id = $1 AND reason = 'revoked' LIMIT 1",
        [installationId],
      );
      if (revoked.rows.length) return false;
      if (expectedGeneration !== null) {
        const updated = await tx.query(
          `UPDATE leaderboard_ingestion.repository_access SET state = 'public',
        installation_id = $2, generation = generation + 1, checked_at = clock_timestamp()
        WHERE repository_id = $1 AND generation::text = $3 RETURNING repository_id`,
          [repositoryId, installationId, expectedGeneration],
        );
        return updated.rows.length > 0;
      }
      const result = await tx.query(
        `INSERT INTO leaderboard_ingestion.repository_access (repository_id, installation_id, state)
        VALUES ($1, $2, 'public') ON CONFLICT (repository_id) DO NOTHING RETURNING repository_id`,
        [repositoryId, installationId],
      );
      return result.rows.length > 0;
    });
  }

  /** Verified webhook delivery. Suppression is monotonic until a fresh visibility/access probe. */
  async suppress(
    deliveryId: string,
    bodyHash: string,
    installationId: number,
    repositoryIds: number[],
    reason: "private" | "removed" | "revoked",
  ): Promise<"accepted" | "duplicate" | "conflict"> {
    if (!/^[a-f0-9-]{36}$/i.test(deliveryId) || !/^[a-f0-9]{64}$/.test(bodyHash))
      throw new Error("invalid_lifecycle_receipt");
    repository(installationId);
    if (
      !Array.isArray(repositoryIds) ||
      repositoryIds.length > 1000 ||
      !["private", "removed", "revoked"].includes(reason)
    )
      throw new Error("invalid_lifecycle_scope");
    repositoryIds.forEach(repository);
    return this.db.transaction(async (tx) => {
      // Installation lock serializes repository discovery and revocation in this API.
      await tx.query("SELECT pg_advisory_xact_lock($1)", [installationId]);
      const receipt = await tx.query(
        `INSERT INTO leaderboard_ingestion.lifecycle_receipts
        (delivery_id, body_hash, installation_id, repository_ids, reason) VALUES ($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
        [deliveryId, bodyHash, installationId, JSON.stringify(repositoryIds), reason],
      );
      if (!receipt.rows.length) {
        const prior = await tx.query(
          "SELECT body_hash FROM leaderboard_ingestion.lifecycle_receipts WHERE delivery_id = $1",
          [deliveryId],
        );
        return prior.rows[0]?.body_hash === bodyHash ? "duplicate" : "conflict";
      }
      if (reason === "revoked")
        await tx.query(
          `UPDATE leaderboard_ingestion.repository_access SET state = 'unavailable',
        generation = generation + 1, checked_at = clock_timestamp() WHERE installation_id = $1`,
          [installationId],
        );
      for (const repositoryId of new Set(repositoryIds))
        await tx.query(
          `INSERT INTO leaderboard_ingestion.repository_access
        (repository_id, installation_id, state) VALUES ($1,$2,'unavailable') ON CONFLICT (repository_id)
        DO UPDATE SET state = 'unavailable', generation = repository_access.generation + 1, checked_at = clock_timestamp()`,
          [repositoryId, installationId],
        );
      return "accepted";
    });
  }

  async start(request: ScanRequest): Promise<void> {
    validateScanRequest(request);
    await this.db.transaction((tx) => this.startInTransaction(tx, request));
  }

  /** Materialize a whole authorized plan in its caller's existing transaction. */
  async startInTransaction(tx: SqlSession, request: ScanRequest): Promise<void> {
    validateScanRequest(request);
    const access = await tx.query(
      "SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id = $1 AND state = 'public' FOR SHARE",
      [request.repositoryId],
    );
    if (!access.rows[0]) throw new Error("repository_unverified");
    const producer = this.#producerFor(request);
    if (producer !== null) this.#decisionAuthorize!();
    await tx.query(
      producer === null
        ? `INSERT INTO leaderboard_ingestion.collection_runs
          (run_id, repository_id, family, mode, since_at, until_at, access_generation) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (run_id) DO NOTHING`
        : `INSERT INTO leaderboard_ingestion.collection_runs
          (run_id, repository_id, family, mode, since_at, until_at, access_generation,decision_producer)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id) DO NOTHING`,
      [
        request.runId,
        request.repositoryId,
        request.family,
        request.mode,
        request.since,
        request.until,
        access.rows[0].generation,
        ...(producer === null ? [] : [producer]),
      ],
    );
    const prior = (
      await tx.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id = $1", [request.runId])
    ).rows[0]!;
    this.#assertProducer(prior);
    if (
      String(prior.repository_id) !== String(request.repositoryId) ||
      prior.family !== request.family ||
      prior.mode !== request.mode ||
      new Date(prior.until_at as string).toISOString() !== request.until ||
      (prior.since_at === null ? null : new Date(prior.since_at as string).toISOString()) !== request.since
    )
      throw new Error("scan_id_conflict");
  }

  /** One network page per call. Concurrent workers converge through the locked checkpoint. */
  async step(
    runId: string,
    source: ReadOnlySource,
    limit = 100,
  ): Promise<"complete" | "progress" | "superseded" | "failed"> {
    id(runId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_page_limit");
    const run = (await this.db.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id = $1", [runId]))
      .rows[0];
    if (!run) throw new Error("unknown_scan");
    const decisionProducer = this.#assertProducer(run, source);
    if (run.state === "complete") return "complete";
    const assertSourceAuthorized = () => {
      if (decisionProducer !== null) this.#assertProducer(run, source);
      else source.assertAuthorized?.();
    };
    const request: ScanRequest = {
      runId,
      repositoryId: Number(run.repository_id),
      family: run.family as SourceFamily,
      mode: run.mode as ScanRequest["mode"],
      since: run.since_at === null ? null : new Date(run.since_at as string).toISOString(),
      until: new Date(run.until_at as string).toISOString(),
    };
    let failureCode = "source_read_failed";
    try {
      if (Number(run.page_count) >= 10_000) throw new Error("scan_page_budget_exceeded");
      await assertRepositoryAvailable(this.db, request.repositoryId);
      if (decisionProducer !== null) assertSourceAuthorized();
      const pageRequest = { ...request, cursor: run.cursor as string | null, limit };
      const page =
        decisionProducer === null
          ? await source.readPage(pageRequest)
          : await this.#decisionReadPage!.call(source, pageRequest);
      if (decisionProducer !== null) assertSourceAuthorized();
      failureCode = "source_schema_drift";
      if (
        page.repositoryId !== request.repositoryId ||
        page.visibility !== "public" ||
        !Array.isArray(page.facts) ||
        page.facts.length > limit
      )
        throw new Error("invalid_source_page");
      // Validate and commit the same scalars even if the source retains its page.
      const { nextCursor, expectedCount } = page;
      cursor(nextCursor);
      if (nextCursor !== null && (nextCursor === run.cursor || page.facts.length === 0))
        throw new Error("nonadvancing_source_page");
      if (expectedCount !== null && (!Number.isSafeInteger(expectedCount) || expectedCount < 0))
        throw new Error("invalid_source_count");
      if (request.family === "project_curation_history" && expectedCount !== null)
        throw new Error("project_curation_history_count_unknown");
      let decisionBytes = 0;
      const facts = page.facts.map((fact) => {
        const normalized = normalizeFact(fact, request.family, request.repositoryId);
        if ((normalized.pullRequestDecisionHistory !== undefined) !== (decisionProducer !== null))
          throw new Error("pull_request_decision_producer_binding_changed");
        if (normalized.pullRequestDecisionHistory !== undefined) {
          decisionBytes += Buffer.byteLength(JSON.stringify(normalized));
          if (decisionBytes > 8_000_000) throw new Error("pull_request_decision_page_budget_exceeded");
        }
        return normalized;
      });
      if (expectedCount !== null && facts.some((fact) => fact.contentEditMetadata !== undefined))
        throw new Error("content_edit_history_count_unknown");
      if (
        facts.some(
          (fact) =>
            fact.occurredAt !== null &&
            (fact.occurredAt > request.until || (request.since !== null && fact.occurredAt < request.since)),
        )
      )
        throw new Error("source_event_outside_window");
      if (
        request.family === "issue_field_history" &&
        facts.some(
          (fact) =>
            fact.evidence !== "observed_transition" ||
            fact.historySubjectId === undefined ||
            fact.issueFieldId === undefined ||
            !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/.test(fact.sourceUrl),
        )
      )
        throw new Error("invalid_issue_field_evidence");
      if (request.family !== "issue_field_history" && facts.some((fact) => fact.issueFieldId !== undefined))
        throw new Error("invalid_issue_field_subject");
      if (
        request.family === "project_curation_history" &&
        facts.some(
          (fact) =>
            fact.evidence !== "observed_transition" ||
            fact.historySubjectId === undefined ||
            fact.projectCurationProjectId === undefined ||
            fact.occurredAt === null ||
            fact.state !== "present" ||
            !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*$/.test(
              fact.sourceUrl,
            ),
        )
      )
        throw new Error("invalid_project_curation_evidence");
      if (
        request.family !== "project_curation_history" &&
        facts.some((fact) => fact.projectCurationProjectId !== undefined)
      )
        throw new Error("invalid_project_curation_subject");
      if (request.family === "project_current" && facts.some((fact) => fact.evidence !== "current_state"))
        throw new Error("invalid_current_project_evidence");
      if (request.family !== "project_current" && facts.some((fact) => fact.projectSubjectId !== undefined))
        throw new Error("invalid_current_project_subject");
      failureCode = "source_commit_failed";
      const status = await this.db.transaction(async (tx): Promise<"complete" | "progress" | "superseded"> => {
        // Public readers share this repository gate while reading current controls.
        // Suppression writes must exclude them; ordinary collection remains concurrent.
        const gateLock = facts.some((fact) => fact.state === "deleted" || fact.state === "unavailable")
          ? "FOR UPDATE"
          : "FOR SHARE";
        const access = (
          await tx.query(
            `SELECT state, generation FROM leaderboard_ingestion.repository_access WHERE repository_id = $1 ${gateLock}`,
            [request.repositoryId],
          )
        ).rows[0];
        if (access?.state !== "public" || String(access.generation) !== String(run.access_generation))
          throw new Error("source_access_changed");
        const current = (
          await tx.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id = $1 FOR UPDATE", [runId])
        ).rows[0]!;
        assertSourceAuthorized();
        this.#assertProducer(current, source);
        if (current.page_count !== run.page_count || current.state === "complete") return "superseded";
        if (current.expected_count !== null && current.expected_count !== expectedCount)
          throw new Error("source_count_changed");
        const count = Number(current.item_count) + facts.length;
        if (nextCursor === null && expectedCount !== null && count !== expectedCount)
          throw new Error("source_count_mismatch");
        let changed = 0;
        for (const fact of facts) {
          const document = JSON.stringify(fact);
          const key = createHash("sha256")
            .update(
              JSON.stringify([request.repositoryId, request.family, fact.subjectId, fact.sourceRevision, document]),
            )
            .digest("hex");
          const inserted = await tx.query(
            `INSERT INTO leaderboard_ingestion.source_facts
            (fact_key, repository_id, family, subject_id, source_revision, document, first_run_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
            ON CONFLICT (fact_key) DO NOTHING RETURNING fact_key,first_run_id,
              to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decision_observed_at`,
            [key, request.repositoryId, request.family, fact.subjectId, fact.sourceRevision, document, runId],
          );
          changed += inserted.rows.length;
          if (fact.pullRequestDecisionHistory !== undefined) {
            const saved =
              inserted.rows[0] ??
              (
                await tx.query(
                  `SELECT first_run_id,
                    to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decision_observed_at
                  FROM leaderboard_ingestion.source_facts WHERE fact_key=$1`,
                  [key],
                )
              ).rows[0];
            if (!saved) throw new Error("pull_request_decision_source_unavailable");
            assertPullRequestDecisionPersistence(
              fact.pullRequestDecisionHistory,
              request,
              saved.decision_observed_at as string,
              String(saved.first_run_id),
            );
            assertSourceAuthorized();
          }
          if (fact.state === "deleted" || fact.state === "unavailable")
            await tx.query(
              `INSERT INTO leaderboard_ingestion.object_suppressions
            (repository_id, subject_id, reason) VALUES ($1,$2,$3) ON CONFLICT (repository_id, subject_id) DO NOTHING`,
              [request.repositoryId, fact.subjectId, fact.state],
            );
          // A repeated page or duplicate item cannot inflate reconciled source totals.
          await tx.query("INSERT INTO leaderboard_ingestion.collection_items (run_id, fact_key) VALUES ($1,$2)", [
            runId,
            key,
          ]);
        }
        if (decisionBytes) {
          const footprint = (
            await tx.query(
              `SELECT COALESCE(sum(octet_length(f.document::text)),0) AS bytes
              FROM leaderboard_ingestion.collection_items AS item
              JOIN leaderboard_ingestion.source_facts AS f USING(fact_key)
              WHERE item.run_id=$1`,
              [runId],
            )
          ).rows[0];
          if (
            !footprint ||
            !Number.isSafeInteger(Number(footprint.bytes)) ||
            Number(footprint.bytes) < 0 ||
            Number(footprint.bytes) > 8_000_000
          )
            throw new Error("pull_request_decision_run_budget_exceeded");
          assertSourceAuthorized();
        }
        await tx.query(
          `INSERT INTO leaderboard_ingestion.collection_pages (run_id,page_number,item_count,changed_count,cursor_hash) VALUES ($1,$2,$3,$4,$5)`,
          [
            runId,
            Number(current.page_count) + 1,
            facts.length,
            changed,
            createHash("sha256").update(JSON.stringify(run.cursor)).digest("hex"),
          ],
        );
        await tx.query(
          `UPDATE leaderboard_ingestion.collection_runs SET cursor = $2, page_count = page_count + 1,
          item_count = $3, expected_count = $4, state = $5, reason = NULL,
          last_success_at = clock_timestamp(), attempted_at = clock_timestamp() WHERE run_id = $1`,
          [runId, nextCursor, count, expectedCount, nextCursor === null ? "complete" : "pending"],
        );
        assertSourceAuthorized();
        return nextCursor === null ? "complete" : "progress";
      });
      if (decisionProducer !== null) assertSourceAuthorized();
      return status;
    } catch {
      // Never retain adapter exceptions, URLs with credentials, or source payloads.
      await this.db.query(
        `UPDATE leaderboard_ingestion.collection_runs SET state = 'failed', reason = $3,
        attempted_at = clock_timestamp() WHERE run_id = $1 AND page_count = $2 AND state <> 'complete'`,
        [runId, run.page_count, failureCode],
      );
      return "failed";
    }
  }

  async diagnostics(repositoryId: number, staleSeconds = 3600): Promise<Record<string, unknown>[]> {
    repository(repositoryId);
    if (!Number.isInteger(staleSeconds) || staleSeconds < 1 || staleSeconds > 86400)
      throw new Error("invalid_stale_threshold");
    return (
      await this.db.query(
        `SELECT family, mode, run.state, reason, since_at, until_at, page_count, item_count,
      expected_count, last_success_at, attempted_at,
      access.state AS access_state,
      (SELECT count(*)::integer FROM leaderboard_ingestion.object_suppressions AS removed WHERE removed.repository_id = run.repository_id) AS suppressed_objects,
      expected_count IS NOT NULL AND expected_count = item_count AND run.state = 'complete' AS historical_counts_reconciled,
      access.state = 'public' AND expected_count IS NOT NULL AND expected_count = item_count AND run.state = 'complete' AS counts_reconciled,
      EXTRACT(EPOCH FROM (clock_timestamp() - last_success_at))::double precision AS source_age_seconds,
      CASE WHEN access.state <> 'public' THEN 'unavailable' WHEN last_success_at IS NULL THEN 'unproven' ELSE 'bounded_source_read' END AS coverage,
      CASE WHEN access.state <> 'public' THEN 'unavailable' WHEN run.state = 'failed' OR last_success_at < clock_timestamp() - $2 * interval '1 second' THEN 'disconnected'
      WHEN last_success_at IS NULL THEN 'unproven' WHEN run.state = 'complete' AND item_count = 0 THEN 'no_activity_in_window'
      ELSE 'observed_progress' END AS health
      FROM leaderboard_ingestion.collection_runs AS run JOIN leaderboard_ingestion.repository_access AS access USING (repository_id)
      WHERE repository_id = $1 ORDER BY family, until_at DESC, run_id`,
        [repositoryId, staleSeconds],
      )
    ).rows;
  }
}
