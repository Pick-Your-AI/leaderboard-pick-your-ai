import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import {
  discussionFeedbackContentVersion as version,
  discussionFeedbackFieldScope,
  discussionFeedbackLimits,
  discussionFeedbackFields as fields,
  feedbackIdentifier,
  feedbackHash,
  feedbackPositive,
  parseDiscussionFeedbackDescriptor,
  parseDiscussionFeedbackSource,
  parseAcceptedFeedbackThreadText,
  parseDiscussionFeedbackCapture,
} from "@pick-your-ai/contracts";
import {
  discussionFeedbackFingerprint,
  discussionFeedbackRevision,
  verifyDiscussionFeedbackObservation,
} from "@pick-your-ai/github";
import { hasReviewedEvidenceIntake } from "../../controls/src/evidence-intake.mjs";
import { hasReviewedParticipantConsent } from "../../controls/src/evidence-consent.mjs";

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
export const discussionFeedbackDigest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const check = (condition, code = "discussion_feedback_coverage_unavailable") => {
  if (!condition) throw new Error(code);
};
const nonce = () => randomBytes(32).toString("hex");
const limitDocument = (value) => {
  check(Buffer.byteLength(canonical(value)) <= 8 * 1024 * 1024, "discussion_feedback_inventory_limit");
  return value;
};
const generation = (value) => {
  check(typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) < 9223372036854775807n);
  return value;
};

/** Disabled unless an exact closed enrollment and a synchronous current host
 * source-use/capability/retention epoch are both present. Strings are locators,
 * never approvals. No default configuration or live source is enrolled here. */
export function createDiscussionFeedbackAuthority(config, dataMode, readEpoch) {
  let enrollments = [];
  if (config.discussionFeedback !== undefined) {
    const selected = fields(config.discussionFeedback, ["version", "enrollments"]);
    check(
      selected.version === version &&
        Array.isArray(selected.enrollments) &&
        selected.enrollments.length > 0 &&
        selected.enrollments.length <= 100,
      "invalid_discussion_feedback_enrollment",
    );
    enrollments = selected.enrollments.map((value) => {
      const entry = fields(value, [
        "repositoryId",
        "installationId",
        "fieldScope",
        "sourceUseReceiptId",
        "capabilityReceiptId",
        "policyVersion",
        "retentionPolicyVersion",
      ]);
      const repositoryId = feedbackPositive(entry.repositoryId),
        installationId = feedbackPositive(entry.installationId);
      const repo = config.repositories.find((item) => item.id === repositoryId);
      check(
        repo?.installationId === installationId &&
          repo.families.includes("discussions") &&
          same(entry.fieldScope, discussionFeedbackFieldScope),
        "invalid_discussion_feedback_enrollment",
      );
      return Object.freeze({
        version,
        repositoryId,
        installationId,
        fieldScope: Object.freeze([...discussionFeedbackFieldScope]),
        sourceUseReceiptId: feedbackIdentifier(entry.sourceUseReceiptId),
        capabilityReceiptId: feedbackIdentifier(entry.capabilityReceiptId),
        policyVersion: feedbackIdentifier(entry.policyVersion),
        retentionPolicyVersion: feedbackIdentifier(entry.retentionPolicyVersion),
        dataMode,
      });
    });
    check(
      new Set(enrollments.map((entry) => entry.repositoryId)).size === enrollments.length,
      "invalid_discussion_feedback_enrollment",
    );
  }
  const current = (repositoryId) => {
    const binding = enrollments.find((entry) => entry.repositoryId === repositoryId);
    if (!binding) return null;
    check(typeof readEpoch === "function", "discussion_feedback_authority_unavailable");
    const epoch = readEpoch(binding);
    if (types.isPromise(epoch)) void epoch.catch(() => undefined);
    check(
      typeof epoch === "string" && epoch.length > 0 && epoch.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(epoch),
      "discussion_feedback_authority_unavailable",
    );
    return Object.freeze({ ...binding, authorityHash: discussionFeedbackDigest([binding, epoch]) });
  };
  return Object.freeze({
    enabled: enrollments.length > 0,
    repositoryIds: Object.freeze(enrollments.map((entry) => entry.repositoryId).sort((a, b) => a - b)),
    current,
    capture() {
      return enrollments.map((entry) => current(entry.repositoryId));
    },
    assert(capture) {
      check(
        same(
          capture,
          enrollments.map((entry) => current(entry.repositoryId)),
        ),
        "discussion_feedback_authority_changed",
      );
    },
  });
}

const headSchema = `CREATE TABLE leaderboard_pipeline.discussion_feedback_heads (
 repository_id bigint PRIMARY KEY REFERENCES leaderboard_ingestion.repository_access(repository_id),
 document jsonb NOT NULL, document_hash text NOT NULL CHECK(document_hash ~ '^[a-f0-9]{64}$')
)`;
const scanSchema = `CREATE TABLE leaderboard_pipeline.discussion_feedback_scans (
 repository_id bigint NOT NULL REFERENCES leaderboard_ingestion.repository_access(repository_id),
 scan_id text NOT NULL, document jsonb NOT NULL, document_hash text NOT NULL CHECK(document_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(repository_id,scan_id)
)`;
const immutableScanFunction = `CREATE FUNCTION leaderboard_pipeline.immutable_discussion_feedback_scan() RETURNS trigger
 LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable_discussion_feedback_scan'; END $$`;
const immutableScanTrigger = `CREATE TRIGGER immutable_discussion_feedback_scan BEFORE UPDATE
 ON leaderboard_pipeline.discussion_feedback_scans FOR EACH ROW EXECUTE FUNCTION leaderboard_pipeline.immutable_discussion_feedback_scan()`;
const migrationHash = discussionFeedbackDigest([
  version,
  headSchema,
  scanSchema,
  immutableScanFunction,
  immutableScanTrigger,
]);
export async function migrateDiscussionFeedback(db) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('pipeline-discussion-feedback-migration/v1',0))");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS leaderboard_pipeline.discussion_feedback_migrations (version text PRIMARY KEY, fingerprint text NOT NULL)",
    );
    const saved = (
      await tx.query("SELECT fingerprint FROM leaderboard_pipeline.discussion_feedback_migrations WHERE version=$1", [
        version,
      ])
    ).rows[0];
    if (saved) {
      check(saved.fingerprint === migrationHash, "discussion_feedback_migration_mismatch");
      for (const name of ["discussion_feedback_heads", "discussion_feedback_scans"])
        check(
          (await tx.query("SELECT to_regclass($1) AS name", [`leaderboard_pipeline.${name}`])).rows[0]?.name,
          "discussion_feedback_migration_incomplete",
        );
    } else {
      await tx.query(headSchema);
      await tx.query(scanSchema);
      await tx.query(immutableScanFunction);
      await tx.query(immutableScanTrigger);
      await tx.query(
        "INSERT INTO leaderboard_pipeline.discussion_feedback_migrations(version,fingerprint) VALUES($1,$2)",
        [version, migrationHash],
      );
    }
  });
}
function savedDocument(row) {
  check(row && discussionFeedbackDigest(row.document) === row.document_hash, "discussion_feedback_integrity_error");
  return limitDocument(row.document);
}
function inventory(values) {
  check(Array.isArray(values) && values.length <= discussionFeedbackLimits.threads);
  const selected = values.map((value) => {
    const entry = fields(value, ["discussionId", "fingerprint", "generation"]);
    return {
      discussionId: feedbackIdentifier(entry.discussionId),
      fingerprint: feedbackHash(entry.fingerprint),
      generation: feedbackHash(entry.generation),
    };
  });
  check(new Set(selected.map((entry) => entry.discussionId)).size === selected.length);
  check(
    same(
      selected,
      [...selected].sort((a, b) => a.discussionId.localeCompare(b.discussionId)),
    ),
  );
  return selected;
}
function head(row) {
  const entry = fields(savedDocument(row), [
    "version",
    "repositoryId",
    "installationId",
    "repositoryGeneration",
    "authorityHash",
    "coverageEpoch",
    "pending",
    "lastScanId",
    "inventory",
  ]);
  check(entry.version === version && entry.repositoryId === Number(row.repository_id));
  if (entry.pending !== null) {
    const pending = fields(entry.pending, ["scanId", "attemptId"]);
    feedbackIdentifier(pending.scanId);
    feedbackHash(pending.attemptId);
  }
  if (entry.lastScanId !== null) feedbackIdentifier(entry.lastScanId);
  return {
    version,
    repositoryId: feedbackPositive(entry.repositoryId),
    installationId: feedbackPositive(entry.installationId),
    repositoryGeneration: generation(entry.repositoryGeneration),
    authorityHash: feedbackHash(entry.authorityHash),
    coverageEpoch: feedbackHash(entry.coverageEpoch),
    pending: entry.pending,
    lastScanId: entry.lastScanId,
    inventory: inventory(entry.inventory),
  };
}
function scan(row) {
  const entry = fields(savedDocument(row), [
    "version",
    "repositoryId",
    "installationId",
    "repositoryGeneration",
    "authorityHash",
    "coverageEpoch",
    "scanId",
    "observations",
  ]);
  check(
    entry.version === version &&
      entry.repositoryId === Number(row.repository_id) &&
      entry.scanId === row.scan_id &&
      Array.isArray(entry.observations) &&
      entry.observations.length <= discussionFeedbackLimits.threads,
  );
  feedbackPositive(entry.installationId);
  generation(entry.repositoryGeneration);
  feedbackHash(entry.authorityHash);
  feedbackHash(entry.coverageEpoch);
  feedbackIdentifier(entry.scanId);
  const observations = entry.observations.map((value) =>
    verifyDiscussionFeedbackObservation(value, discussionFeedbackRevision(value)),
  );
  check(new Set(observations.map((item) => item.descriptor.discussionId)).size === observations.length);
  for (const item of observations)
    check(
      item.descriptor.repositoryId === entry.repositoryId &&
        item.descriptor.installationId === entry.installationId &&
        item.authorityHash === entry.authorityHash &&
        item.coverageEpoch === entry.coverageEpoch &&
        item.scanId === entry.scanId,
    );
  return { ...entry, observations };
}
function coverageHash(value) {
  check(value.pending === null && value.lastScanId !== null);
  const { pending: _pending, lastScanId: _scan, ...coverage } = value;
  return discussionFeedbackDigest(coverage);
}

/** Complete scan receipts replay minimized observations without making another
 * content request. Incomplete resumes start a fresh coverage epoch, even when
 * their run ID is unchanged: a lost checkpoint cannot conceal observed A→B→A. */
export class DiscussionFeedbackStore {
  constructor(db, authority, assertAuthorized) {
    this.db = db;
    this.authority = authority;
    this.assertAuthorized = assertAuthorized;
  }
  async gate(tx, repositoryId, expectedAuthority) {
    this.assertAuthorized();
    const current = this.authority.current(repositoryId);
    check(current && current.authorityHash === expectedAuthority);
    const access = (
      await tx.query(
        "SELECT installation_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 FOR SHARE",
        [repositoryId],
      )
    ).rows[0];
    check(access?.state === "public" && Number(access.installation_id) === current.installationId);
    const confirm = () => {
      this.assertAuthorized();
      check(
        this.authority.current(repositoryId)?.authorityHash === expectedAuthority,
        "discussion_feedback_authority_changed",
      );
    };
    confirm();
    return { current, repositoryGeneration: String(access.generation), confirm };
  }
  async begin(request, authority) {
    const captured = Object.freeze({
      repositoryId: feedbackPositive(request.repositoryId),
      scanId: feedbackIdentifier(request.runId),
      authorityHash: feedbackHash(authority.authorityHash),
    });
    check(
      request.family === "discussions" &&
        request.since === null &&
        ["audit", "backfill", "reconcile"].includes(request.mode),
    );
    return this.db.transaction(async (tx) => {
      const gate = await this.gate(tx, captured.repositoryId, captured.authorityHash);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${version}:${captured.repositoryId}`]);
      const run = (
        await tx.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [captured.scanId])
      ).rows[0];
      check(
        run &&
          Number(run.repository_id) === captured.repositoryId &&
          run.family === "discussions" &&
          run.mode === request.mode &&
          run.since_at === null &&
          new Date(run.until_at).toISOString() === request.until &&
          String(run.access_generation) === gate.repositoryGeneration,
      );
      const headRow = (
        await tx.query(
          "SELECT * FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=$1 FOR UPDATE",
          [captured.repositoryId],
        )
      ).rows[0];
      const prior = headRow ? head(headRow) : null;
      const retained = (
        await tx.query(
          "SELECT * FROM leaderboard_pipeline.discussion_feedback_scans WHERE repository_id=$1 AND scan_id=$2",
          [captured.repositoryId, captured.scanId],
        )
      ).rows[0];
      if (retained) {
        const completed = scan(retained);
        check(
          prior &&
            completed.authorityHash === captured.authorityHash &&
            completed.repositoryGeneration === gate.repositoryGeneration &&
            prior.authorityHash === captured.authorityHash &&
            prior.repositoryGeneration === gate.repositoryGeneration,
        );
        gate.confirm();
        return { completed: completed.observations };
      }
      const continuous =
        prior &&
        prior.pending === null &&
        prior.authorityHash === captured.authorityHash &&
        prior.repositoryGeneration === gate.repositoryGeneration &&
        prior.installationId === gate.current.installationId;
      const next = {
        version,
        repositoryId: captured.repositoryId,
        installationId: gate.current.installationId,
        repositoryGeneration: gate.repositoryGeneration,
        authorityHash: captured.authorityHash,
        coverageEpoch: continuous ? prior.coverageEpoch : nonce(),
        pending: { scanId: captured.scanId, attemptId: nonce() },
        lastScanId: continuous ? prior.lastScanId : null,
        inventory: continuous ? prior.inventory : [],
      };
      await tx.query(
        `INSERT INTO leaderboard_pipeline.discussion_feedback_heads(repository_id,document,document_hash) VALUES($1,$2::jsonb,$3)
        ON CONFLICT(repository_id) DO UPDATE SET document=EXCLUDED.document,document_hash=EXCLUDED.document_hash`,
        [captured.repositoryId, JSON.stringify(next), discussionFeedbackDigest(next)],
      );
      gate.confirm();
      return { ...captured, coverageEpoch: next.coverageEpoch, attemptId: next.pending.attemptId };
    });
  }
  async complete(start, values) {
    check(!start.completed && Array.isArray(values) && values.length <= discussionFeedbackLimits.threads);
    const descriptors = values
      .map(parseDiscussionFeedbackDescriptor)
      .sort((a, b) => a.discussionId.localeCompare(b.discussionId));
    check(new Set(descriptors.map((entry) => entry.discussionId)).size === descriptors.length);
    return this.db.transaction(async (tx) => {
      const gate = await this.gate(tx, start.repositoryId, start.authorityHash);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${version}:${start.repositoryId}`]);
      const current = head(
        (
          await tx.query(
            "SELECT * FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=$1 FOR UPDATE",
            [start.repositoryId],
          )
        ).rows[0],
      );
      check(
        current.pending?.scanId === start.scanId &&
          current.pending.attemptId === start.attemptId &&
          current.coverageEpoch === start.coverageEpoch &&
          current.authorityHash === start.authorityHash &&
          current.repositoryGeneration === gate.repositoryGeneration,
      );
      const prior = new Map(current.inventory.map((entry) => [entry.discussionId, entry]));
      const observations = descriptors.map((descriptor) => {
        check(descriptor.repositoryId === start.repositoryId && descriptor.installationId === current.installationId);
        const fingerprint = discussionFeedbackFingerprint(descriptor),
          retained = prior.get(descriptor.discussionId);
        return {
          version,
          descriptor,
          fingerprint,
          authorityHash: start.authorityHash,
          coverageEpoch: start.coverageEpoch,
          generation: retained?.fingerprint === fingerprint ? retained.generation : nonce(),
          scanId: start.scanId,
        };
      });
      const document = limitDocument({
        version,
        repositoryId: start.repositoryId,
        installationId: current.installationId,
        repositoryGeneration: gate.repositoryGeneration,
        authorityHash: start.authorityHash,
        coverageEpoch: start.coverageEpoch,
        scanId: start.scanId,
        observations,
      });
      await tx.query(
        "INSERT INTO leaderboard_pipeline.discussion_feedback_scans(repository_id,scan_id,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
        [start.repositoryId, start.scanId, JSON.stringify(document), discussionFeedbackDigest(document)],
      );
      const next = {
        ...current,
        pending: null,
        lastScanId: start.scanId,
        inventory: observations.map((entry) => ({
          discussionId: entry.descriptor.discussionId,
          fingerprint: entry.fingerprint,
          generation: entry.generation,
        })),
      };
      await tx.query(
        "UPDATE leaderboard_pipeline.discussion_feedback_heads SET document=$2::jsonb,document_hash=$3 WHERE repository_id=$1",
        [start.repositoryId, JSON.stringify(next), discussionFeedbackDigest(next)],
      );
      gate.confirm();
      return observations;
    });
  }
  async verifyRow(tx, row, { current = false } = {}) {
    const metadata = verifyDiscussionFeedbackObservation(row.document?.discussionFeedback, row.source_revision);
    const descriptor = metadata.descriptor;
    const gate = await this.gate(tx, Number(row.repository_id), metadata.authorityHash);
    fields(row.document, [
      "subjectId",
      "sourceRevision",
      "sourceUrl",
      "evidence",
      "actorId",
      "occurredAt",
      "state",
      "discussionFeedback",
    ]);
    check(
      row.family === "discussions" &&
        row.document.evidence === "current_state" &&
        row.document.actorId === null &&
        row.document.occurredAt === null &&
        row.document.state === "present" &&
        descriptor.repositoryId === Number(row.repository_id) &&
        descriptor.installationId === gate.current.installationId &&
        row.subject_id === descriptor.discussionId &&
        row.document.subjectId === descriptor.discussionId &&
        row.document.sourceUrl === descriptor.threadUrl &&
        row.document.sourceRevision === row.source_revision &&
        row.first_run_id === metadata.scanId,
    );
    const receipt = scan(
      (
        await tx.query(
          "SELECT * FROM leaderboard_pipeline.discussion_feedback_scans WHERE repository_id=$1 AND scan_id=$2",
          [descriptor.repositoryId, metadata.scanId],
        )
      ).rows[0],
    );
    const run = (
      await tx.query(
        `SELECT r.* FROM leaderboard_ingestion.collection_runs r JOIN leaderboard_ingestion.collection_items i USING(run_id)
      WHERE r.run_id=$1 AND i.fact_key=$2`,
        [metadata.scanId, row.fact_key],
      )
    ).rows[0];
    check(
      receipt.repositoryGeneration === gate.repositoryGeneration &&
        receipt.observations.some((entry) => same(entry, metadata)) &&
        run?.state === "complete" &&
        run.family === "discussions" &&
        Number(run.repository_id) === descriptor.repositoryId &&
        String(run.access_generation) === gate.repositoryGeneration &&
        Number(run.item_count) === receipt.observations.length &&
        Number(run.expected_count) === receipt.observations.length,
    );
    if (current) {
      const selected = head(
        (
          await tx.query(
            "SELECT * FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=$1 FOR SHARE",
            [descriptor.repositoryId],
          )
        ).rows[0],
      );
      check(
        selected.pending === null &&
          selected.authorityHash === metadata.authorityHash &&
          selected.coverageEpoch === metadata.coverageEpoch &&
          selected.repositoryGeneration === gate.repositoryGeneration &&
          selected.inventory.some(
            (entry) =>
              entry.discussionId === descriptor.discussionId &&
              entry.fingerprint === metadata.fingerprint &&
              entry.generation === metadata.generation,
          ),
      );
    }
    gate.confirm();
    return parseDiscussionFeedbackSource({
      metadata,
      sourceRevision: row.source_revision,
      observedAt: new Date(row.observed_at).toISOString(),
      selectedCurrentState: current,
    });
  }
  async verifyInput(input) {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [input.factKey])
      ).rows[0];
      check(
        row &&
          Number(row.repository_id) === input.repository.id &&
          row.family === input.family &&
          same(row.document, input.fact) &&
          new Date(row.observed_at).toISOString() === input.observedAt,
      );
      await this.verifyRow(tx, row, { current: input.selectedCurrentState === true });
      this.assertAuthorized();
      return true;
    });
  }
  /** A complete current inventory also establishes absence. Never carry a
   * removed thread forward from an older per-subject row, and never interpret
   * pruned current collection membership as a smaller complete inventory. */
  async currentScanIds(tx, repositoryIds, cutoff = null) {
    const result = [],
      gates = [];
    for (const repositoryId of this.authority.repositoryIds.filter((id) => repositoryIds.includes(id))) {
      const authority = this.authority.current(repositoryId),
        gate = await this.gate(tx, repositoryId, authority.authorityHash);
      gates.push(gate);
      const selected = head(
        (
          await tx.query(
            "SELECT * FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=$1 FOR SHARE",
            [repositoryId],
          )
        ).rows[0],
      );
      coverageHash(selected);
      check(
        selected.authorityHash === authority.authorityHash &&
          selected.repositoryGeneration === gate.repositoryGeneration,
      );
      const receipt = scan(
        (
          await tx.query(
            "SELECT * FROM leaderboard_pipeline.discussion_feedback_scans WHERE repository_id=$1 AND scan_id=$2",
            [repositoryId, selected.lastScanId],
          )
        ).rows[0],
      );
      check(
        receipt.authorityHash === authority.authorityHash &&
          receipt.coverageEpoch === selected.coverageEpoch &&
          receipt.repositoryGeneration === gate.repositoryGeneration &&
          same(
            selected.inventory,
            receipt.observations.map((entry) => ({
              discussionId: entry.descriptor.discussionId,
              fingerprint: entry.fingerprint,
              generation: entry.generation,
            })),
          ),
      );
      const run = (
        await tx.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [selected.lastScanId])
      ).rows[0];
      check(
        run?.state === "complete" &&
          run.family === "discussions" &&
          Number(run.repository_id) === repositoryId &&
          String(run.access_generation) === gate.repositoryGeneration &&
          run.last_success_at !== null &&
          (cutoff === null || new Date(run.last_success_at).toISOString() <= cutoff) &&
          Number(run.item_count) === receipt.observations.length &&
          Number(run.expected_count) === receipt.observations.length,
      );
      const retained = (
        await tx.query(
          `SELECT count(*) AS count FROM leaderboard_ingestion.collection_items i
        JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE i.run_id=$1 AND f.first_run_id=$1
        AND f.repository_id=$2 AND f.family='discussions' AND ($3::timestamptz IS NULL OR f.observed_at<=$3)`,
          [selected.lastScanId, repositoryId, cutoff],
        )
      ).rows[0];
      check(Number(retained.count) === receipt.observations.length);
      result.push(selected.lastScanId);
    }
    for (const gate of gates) gate.confirm();
    this.assertAuthorized();
    return result;
  }
  async capture(tx, repositoryIds) {
    const result = [];
    const gates = [];
    for (const repositoryId of this.authority.repositoryIds.filter((id) => repositoryIds.includes(id))) {
      const authority = this.authority.current(repositoryId),
        gate = await this.gate(tx, repositoryId, authority.authorityHash);
      gates.push(gate);
      const selected = head(
        (
          await tx.query(
            "SELECT * FROM leaderboard_pipeline.discussion_feedback_heads WHERE repository_id=$1 FOR SHARE",
            [repositoryId],
          )
        ).rows[0],
      );
      check(
        selected.authorityHash === authority.authorityHash &&
          selected.repositoryGeneration === gate.repositoryGeneration,
      );
      result.push({ repositoryId, authorityHash: authority.authorityHash, coverageHash: coverageHash(selected) });
    }
    for (const gate of gates) gate.confirm();
    this.assertAuthorized();
    return result;
  }
  async assertCapture(tx, repositoryIds, saved) {
    if (saved !== undefined) saved = parseDiscussionFeedbackCapture(saved);
    const actual = await this.capture(tx, repositoryIds);
    check(
      (saved === undefined && actual.length === 0) || same(saved, actual),
      "discussion_feedback_publication_obsolete",
    );
    await this.currentScanIds(tx, repositoryIds);
  }
  async originals(tx, state, bindings, cutoff = null) {
    const selected = new Map();
    for (const request of Object.values(state.requests ?? {})) {
      if (
        request.status !== "accepted" ||
        state.profiles?.[request.owner]?.suppressed ||
        !hasReviewedEvidenceIntake(request) ||
        !hasReviewedParticipantConsent(request) ||
        !bindings.some(
          (binding) =>
            binding.metricId === "helpful_feedback" &&
            binding.category === request.category &&
            binding.scope === request.scope &&
            binding.policyVersion === request.policyVersion,
        )
      )
        continue;
      let review;
      try {
        review = parseAcceptedFeedbackThreadText(request.detail);
      } catch {
        continue;
      }
      const key = canonical([review.repositoryId, review.discussionId, review.sourceRevision]);
      if (selected.has(key)) continue;
      check(selected.size < 10000, "discussion_feedback_review_limit");
      const rows = (
        await tx.query(
          `SELECT * FROM leaderboard_ingestion.source_facts WHERE repository_id=$1 AND family='discussions'
        AND subject_id=$2 AND source_revision=$3 AND ($4::timestamptz IS NULL OR observed_at<=$4)`,
          [review.repositoryId, review.discussionId, review.sourceRevision, cutoff],
        )
      ).rows;
      check(rows.length === 1);
      selected.set(key, await this.verifyRow(tx, rows[0]));
    }
    return [...selected.values()];
  }
}

export function privateDiscussionFeedbackMetadata(output, row) {
  if (row.document.discussionFeedback === undefined) {
    check(output.discussionFeedbackSources === undefined, "discussion_feedback_producer_unverified");
    return {};
  }
  check(
    Array.isArray(output.discussionFeedbackSources) && output.discussionFeedbackSources.length === 1,
    "discussion_feedback_producer_unverified",
  );
  const source = parseDiscussionFeedbackSource(output.discussionFeedbackSources[0]);
  const metadata = verifyDiscussionFeedbackObservation(row.document.discussionFeedback, row.source_revision);
  check(
    same(source.metadata, metadata) &&
      source.sourceRevision === row.source_revision &&
      source.observedAt === new Date(row.observed_at).toISOString(),
    "discussion_feedback_producer_unverified",
  );
  return {
    discussionFeedbackNormalizationVersion: version,
    discussionFeedbackSources: [{ ...source, selectedCurrentState: false }],
  };
}
