import { createHash } from "node:crypto";
import { GithubReadClient } from "./client.js";
import { readPublicProjectSnapshot, projectSnapshotRevision } from "./project-snapshots.js";
import {
  classifyPhysicalDiff,
  pinnedSha,
  type PinnedPhysicalDiff,
  type ClassifiedPhysicalDiff,
} from "./physical-diff.js";

/** Hash only explicit source fields; text contributes to revision identity but is never retained. */
export function githubReviewRevision(value: Record<string, unknown>): string {
  const user = value.user !== null && typeof value.user === "object" ? (value.user as Record<string, unknown>) : {};
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.id ?? null,
        value.node_id ?? null,
        value.state ?? null,
        value.submitted_at ?? null,
        value.commit_id ?? null,
        user.id ?? null,
        user.type ?? null,
        value.body ?? null,
      ]),
    )
    .digest("hex");
}

export function githubDiscussionRevision(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.id ?? null,
        value.updatedAt ?? null,
        value.answerChosenAt ?? null,
        object(value.answer) ? (value.answer.id ?? null) : null,
        object(value.answer) ? (value.answer.isAnswer ?? null) : null,
        object(value.answer) && object(value.answer.author)
          ? (value.answer.author.databaseId ?? value.answer.author.id ?? null)
          : null,
        object(value.answerChosenBy) ? (value.answerChosenBy.databaseId ?? value.answerChosenBy.id ?? null) : null,
      ]),
    )
    .digest("hex");
}

/** Each completed observation scan retains its own revision even after A → B → A. */
export function githubSnapshotRevision(fingerprint: string, scanId: string): string {
  return `${fingerprint}.${createHash("sha256").update(scanId).digest("hex").slice(0, 32)}`;
}
function matchesSnapshotRevision(revision: string, fingerprint: string): boolean {
  return (
    revision === fingerprint || (/^[a-f0-9]{64}\.[a-f0-9]{32}$/.test(revision) && revision.slice(0, 64) === fingerprint)
  );
}

export function githubTimelineRevision(value: Record<string, unknown>): string {
  const identity = (item: unknown) =>
    object(item) ? [item.id ?? null, item.node_id ?? null, item.name ?? null] : null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.id ?? null,
        value.event ?? null,
        value.created_at ?? null,
        identity(value.actor),
        identity(value.label),
        identity(value.milestone),
        identity(value.assignee),
      ]),
    )
    .digest("hex");
}

export type GithubRole =
  | "author"
  | "coauthor"
  | "reviewer"
  | "merger"
  | "triager"
  | "reporter"
  | "resolver"
  | "nominator"
  | "automation"
  | "unknown";
export interface NormalizedGithubFact {
  id: string;
  canonicalKey: string | null;
  metricId: string;
  actorId: string | null;
  artifactId: string | null;
  repoId: string;
  role: GithubRole;
  state: "observed" | "qualified" | "reviewed" | "pending" | "excluded" | "unknown";
  occurredAt: string | null;
  acceptedAt: string | null;
  observedAt: string;
  revision: number;
  correctionReceipt: string | null;
  acceptanceReceipt: string | null;
  acceptedBy: string | null;
  subjectActorId: string | null;
  eventContext: { projects: string[]; workstreams: string[] } | null;
  currentContext: { projects: string[]; workstreams: string[] } | null;
  quantity?: number;
  rawState?: string;
  outcome?: "merged" | "closed_unmerged" | "pending";
  readyAt?: string | null;
  firstReviewAt?: string | null;
}
export interface NormalizedGithubActor {
  id: string;
  login: string | null;
  kind: "user" | "bot" | "github_app" | "organization" | "system" | "unknown";
  publicState: "visible" | "deleted" | "suppressed";
  githubDatabaseId: number;
  githubNodeId?: string;
  executionMode: "automated" | "unknown";
}
export interface NormalizedPublicEvidence {
  artifact: {
    schemaVersion: "leaderboard/v1";
    source: "github";
    kind: "issue" | "pull_request" | "commit" | "release" | "project" | "other";
    stableId: string;
    repositoryId: string;
    publicUrl: string;
    visibility: "public";
  };
  contribution: {
    schemaVersion: "leaderboard/v1";
    contributionId: string;
    canonicalEventId: string;
    artifactId: string;
    actorId: string | null;
    roles: GithubRole[];
    qualification: "eligible" | "ineligible" | "pending" | "unknown";
    metricIds: string[];
    reasonCodes: string[];
  };
  occurredAt: string | null;
  sourceRevision: string | null;
  sourceRevisionUrl: string | null;
}
export interface GithubObservation {
  id: string;
  source: string;
  action: string;
  actorId: string | null;
  artifactId: string;
  occurredAt: string | null;
  observedAt: string;
  sourceRevision: string;
  sourceUrl: string;
  reasonCodes: string[];
}
export interface GithubLineage {
  relation: "squash_of" | "cherry_pick_of" | "mirror_of" | "imported_from" | "reverted_by" | "transferred_to";
  sourceIds: string[];
  targetId: string;
  evidenceIds: string[];
}
export interface NormalizedGithubResult {
  isSynthetic: boolean;
  facts: NormalizedGithubFact[];
  actors: NormalizedGithubActor[];
  evidence: NormalizedPublicEvidence[];
  observations: GithubObservation[];
  reasons: string[];
  lineage: GithubLineage[];
  suppressArtifactIds: string[];
  physicalDiff?: ClassifiedPhysicalDiff;
  participation: Array<{
    artifactId: string;
    actorId: string;
    role: "author" | "committer" | "coauthor";
    conservedUnit: string;
  }>;
  assistance: Array<{ artifactId: string; model: string; version: string | null }>;
  decisions: Array<{
    artifactId: string;
    outcome: "merged" | "closed_unmerged" | "pending";
    decisionAt: string | null;
    selectedAsOf: string | null;
  }>;
}
export interface GithubEvidenceEnvelope {
  repository: { id: number; slug: string; visibility: "public" | "private" | "unknown"; defaultBranch?: string };
  /** Set by the authorized collector after scope/visibility checks, never from payload text. */
  proof: {
    verified: true;
    source: "github_rest" | "github_graphql" | "github_webhook";
    revision: string;
    eventId?: string;
    isSynthetic?: boolean;
  };
  family:
    | "pull_request"
    | "issue"
    | "review"
    | "discussion"
    | "commit"
    | "release"
    | "triage"
    | "relationship"
    | "field_change"
    | "body_edit"
    | "project_snapshot"
    | "thread_resolution"
    | "comment"
    | "revert";
  observedAt: string;
  /** Exact evidenced transition time only. A delivery/observation/updated_at time is not a substitute. */
  occurredAt?: string | null;
  action?: string;
  payload: unknown;
  eventContext?: { projects: string[]; workstreams: string[] } | null;
  currentContext?: { projects: string[]; workstreams: string[] } | null;
  verifiedCoauthors?: readonly { actor: unknown; verificationReceipt: string }[];
  assistance?: readonly { model: string; version: string | null }[];
  integration?: {
    before: string;
    after: string;
    targetBranch: string;
    defaultBranch: string;
    canonicalChangeId: string;
    commitShas: readonly string[];
    diff?: PinnedPhysicalDiff;
  };
  lineage?: readonly GithubLineage[];
  /** Host has selected this current Discussion revision and excluded superseded answer snapshots. */
  discussionAnswerSelection?: { verified: true };
  reviewCohort?: { verified: true; firstReadyAt: string | null; firstSubmittedReviewAt: string | null };
  reviewParticipation?: { verified: true; firstSubmittedAt: string | null; roundFirstSubmittedAt: string | null };
  /** Host-selected current decision at one frozen cutoff, not a latest-field guess. */
  decisionCohort?: {
    verified: true;
    asOf: string;
    outcome: "merged" | "closed_unmerged" | "pending";
    decisionAt: string | null;
  };
  frozenCutoff?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const stable = (...parts: unknown[]) => `gh:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
const result = (): NormalizedGithubResult => ({
  isSynthetic: false,
  facts: [],
  actors: [],
  evidence: [],
  observations: [],
  reasons: [],
  lineage: [],
  suppressArtifactIds: [],
  participation: [],
  assistance: [],
  decisions: [],
});
function time(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    ? date.toISOString()
    : null;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function actor(value: unknown, automated = false): NormalizedGithubActor | null {
  if (!object(value)) return null;
  const databaseId = positive(value.databaseId)
    ? value.databaseId
    : positive(value.githubDatabaseId)
      ? value.githubDatabaseId
      : positive(value.id)
        ? value.id
        : undefined;
  if (databaseId === undefined) return null;
  const kind =
    value.type === "User" || value.__typename === "User" || value.kind === "user"
      ? "user"
      : value.type === "Bot" || value.__typename === "Bot" || value.kind === "bot"
        ? "bot"
        : value.type === "Organization" || value.__typename === "Organization"
          ? "organization"
          : value.type === "GitHubApp" || value.__typename === "App"
            ? "github_app"
            : "unknown";
  if (kind === "unknown") return null;
  const nodeId =
    text(value.node_id) ??
    text(value.githubNodeId) ??
    (typeof value.id === "string" && !/^\d+$/.test(value.id) ? text(value.id) : null);
  return {
    id: String(databaseId),
    githubDatabaseId: databaseId,
    ...(nodeId ? { githubNodeId: nodeId } : {}),
    login: text(value.login),
    kind,
    publicState: "visible",
    executionMode: automated ? "automated" : "unknown",
  };
}
function url(value: unknown, slug: string, allowProject = false): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (/^#(?:issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+|r\d+)$/.test(parsed.hash)) parsed.hash = "";
    if (parsed.origin !== "https://github.com" || parsed.username || parsed.password || parsed.search || parsed.hash)
      return null;
    if (
      !parsed.pathname.startsWith(`/${slug}/`) &&
      !(allowProject && /^\/orgs\/[A-Za-z0-9-]+\/projects\/\d+$/.test(parsed.pathname))
    )
      return null;
    if (!/^\/[A-Za-z0-9_.\/-]+$/.test(parsed.pathname) || parsed.pathname.includes("..")) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
function sourceActor(payload: Record<string, unknown>): unknown {
  return payload.sender ?? payload.actor;
}
function resourceId(payload: Record<string, unknown>, kind: string, repoId: number): string | null {
  return (
    text(payload.node_id) ??
    (typeof payload.id === "string" ? text(payload.id) : null) ??
    (positive(payload.id)
      ? `github:${kind}:${payload.id}`
      : kind === "commit" && pinnedSha(String(payload.sha))
        ? `github:commit:${repoId}:${payload.sha}`
        : null)
  );
}

/** Normalize explicit public source facts. No field is taken from arbitrary user text. */
export function normalizeGithubObservation(envelope: GithubEvidenceEnvelope): NormalizedGithubResult {
  const out = result();
  const { repository, proof } = envelope;
  out.isSynthetic = proof.isSynthetic === true;
  if (
    !positive(repository.id) ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository.slug) ||
    proof?.verified !== true ||
    !text(proof.revision)
  ) {
    throw new Error("Verified repository/source envelope is required");
  }
  const observedAt = time(envelope.observedAt);
  if (!observedAt) throw new Error("Explicit observation time is required");
  if (!object(envelope.payload)) {
    out.reasons.push("missing_source_payload");
    return out;
  }
  const payload = envelope.payload;
  const resource = object(payload.pull_request)
    ? payload.pull_request
    : object(payload.issue)
      ? payload.issue
      : object(payload.review)
        ? payload.review
        : object(payload.release)
          ? payload.release
          : envelope.action?.startsWith("label_") && object(payload.label)
            ? payload.label
            : envelope.action?.startsWith("milestone_") && object(payload.milestone)
              ? payload.milestone
              : payload;
  const kind: NormalizedPublicEvidence["artifact"]["kind"] =
    envelope.family === "pull_request" || envelope.family === "review" || envelope.family === "revert"
      ? "pull_request"
      : envelope.family === "commit"
        ? "commit"
        : envelope.family === "release"
          ? "release"
          : envelope.family === "project_snapshot" ||
              (envelope.family === "field_change" && envelope.action?.startsWith("project"))
            ? "project"
            : envelope.family === "discussion" ||
                envelope.family === "comment" ||
                (envelope.family === "triage" && /^(?:label|milestone)_/.test(envelope.action ?? ""))
              ? "other"
              : "issue";
  const id = resourceId(resource, kind, repository.id);
  if (repository.visibility !== "public" || (object(payload.repository) && payload.repository.private !== false)) {
    if (id) out.suppressArtifactIds.push(id);
    out.reasons.push("public_visibility_unverified_or_revoked");
    return out;
  }
  if (object(payload.repository) && payload.repository.id !== repository.id) {
    out.reasons.push("repository_scope_mismatch");
    return out;
  }
  const publicUrl =
    url(resource.html_url ?? resource.url, repository.slug, kind === "project") ??
    url(payload.subject_url, repository.slug, kind === "project");
  if (!id || !publicUrl) {
    out.reasons.push("missing_public_artifact_identity");
    return out;
  }
  const at = time(envelope.occurredAt);
  const sourceAction = envelope.action ?? text(payload.action) ?? "snapshot";
  const observationId = proof.eventId
    ? stable("event", proof.eventId)
    : stable("observation", id, proof.source, proof.revision, sourceAction);
  const register = (value: unknown, automated = false) => {
    const parsed = actor(value, automated);
    if (parsed && !out.actors.some((candidate) => candidate.id === parsed.id)) out.actors.push(parsed);
    return parsed;
  };
  const author = register(resource.user ?? resource.author);
  const sender = register(sourceActor(payload), payload.execution_mode === "automated");
  out.observations.push({
    id: observationId,
    source: proof.source,
    action: sourceAction,
    actorId: sender?.id ?? null,
    artifactId: id,
    occurredAt: at,
    observedAt,
    sourceRevision: proof.revision,
    sourceUrl: publicUrl,
    reasonCodes: [],
  });
  const emit = (
    metricId: string,
    who: NormalizedGithubActor | null,
    role: GithubRole,
    occurredAt: string | null,
    unit: string,
    extra: Partial<NormalizedGithubFact> = {},
  ) => {
    const evidenceClass = extra.state ?? (who && occurredAt ? "observed" : "unknown");
    const canonicalKey = stable("metric-unit", metricId, unit, who?.id ?? "unknown", evidenceClass);
    const fact: NormalizedGithubFact = {
      id: stable("fact", canonicalKey),
      canonicalKey,
      metricId,
      actorId: who?.id ?? null,
      artifactId: id,
      repoId: String(repository.id),
      role,
      state: evidenceClass,
      occurredAt,
      acceptedAt: null,
      observedAt,
      revision: 0,
      correctionReceipt: null,
      acceptanceReceipt: null,
      acceptedBy: null,
      subjectActorId: author?.id ?? null,
      eventContext: envelope.eventContext ?? null,
      currentContext: envelope.currentContext ?? null,
      ...extra,
    };
    if (!who) out.reasons.push("unknown_actor");
    if (!occurredAt) out.reasons.push("unknown_event_time");
    out.facts.push(fact);
    out.evidence.push({
      artifact: {
        schemaVersion: "leaderboard/v1",
        source: "github",
        kind,
        stableId: id,
        repositoryId: String(repository.id),
        publicUrl,
        visibility: "public",
      },
      contribution: {
        schemaVersion: "leaderboard/v1",
        contributionId: fact.id,
        canonicalEventId: canonicalKey,
        artifactId: id,
        actorId: fact.actorId,
        roles: [role],
        qualification: fact.state === "observed" || fact.state === "pending" ? "eligible" : "unknown",
        metricIds: [metricId],
        reasonCodes: ["raw_observed_only"],
      },
      occurredAt: fact.occurredAt,
      sourceRevision: proof.revision,
      sourceRevisionUrl: null,
    });
    return fact;
  };
  const transitionUnit = stable(id, sourceAction, at, sender?.id ?? null);
  if (envelope.family === "project_snapshot") {
    out.reasons.push("current_project_context_does_not_prove_editor_or_time");
  } else if (envelope.family === "pull_request") {
    const created = time(resource.created_at ?? resource.createdAt);
    emit("pr_opened", author, "author", created, `${id}:opened`);
    if (envelope.reviewCohort?.verified && time(envelope.reviewCohort.firstReadyAt)) {
      emit("pr_ready", author, "author", time(envelope.reviewCohort.firstReadyAt), `${id}:ready`);
    } else if (sourceAction === "ready_for_review") out.reasons.push("first_ready_milestone_not_proven_by_a_toggle");
    const merged = resource.merged === true && time(resource.merged_at ?? resource.mergedAt);
    const decision =
      merged ||
      (resource.state === "closed" && resource.merged === false && time(resource.closed_at ?? resource.closedAt));
    if (merged) {
      const branch = object(resource.base) ? text(resource.base.ref) : null;
      emit("pr_merged", author, "author", merged, `${id}:merged`, {
        rawState: branch ? `target:${branch}` : "target:unknown",
      });
      emit("maintainer_merges", register(resource.merged_by ?? resource.mergedBy), "merger", merged, `${id}:merged`);
    }
    const outcome = merged ? "merged" : decision ? "closed_unmerged" : "pending";
    const selectedDecision = envelope.decisionCohort;
    out.decisions.push({
      artifactId: id,
      outcome,
      decisionAt: decision || null,
      selectedAsOf: selectedDecision?.verified ? time(selectedDecision.asOf) : null,
    });
    if (
      selectedDecision?.verified &&
      time(selectedDecision.asOf) &&
      time(selectedDecision.asOf) === time(envelope.frozenCutoff) &&
      Date.parse(selectedDecision.asOf) <= Date.parse(observedAt) &&
      selectedDecision.outcome === outcome &&
      time(selectedDecision.decisionAt) === (decision || null)
    ) {
      emit(
        "pr_accepted_rate",
        author,
        "author",
        decision || created,
        `${id}:decision:${outcome}:${decision ?? "pending"}`,
        {
          outcome,
          acceptedAt: decision || null,
          ...(!decision ? { state: author && created ? ("pending" as const) : ("unknown" as const) } : {}),
        },
      );
    } else out.reasons.push("decided_share_requires_verified_selected_as_of_history");
    const coauthors = envelope.verifiedCoauthors ?? [];
    if (author)
      out.participation.push({ artifactId: id, actorId: author.id, role: "author", conservedUnit: `${id}:merged` });
    for (const entry of coauthors) {
      const coauthor = entry.verificationReceipt.trim() ? register(entry.actor) : null;
      if (
        coauthor &&
        coauthor.id !== author?.id &&
        !out.participation.some((item) => item.artifactId === id && item.actorId === coauthor.id)
      ) {
        out.participation.push({
          artifactId: id,
          actorId: coauthor.id,
          role: "coauthor",
          conservedUnit: `${id}:merged`,
        });
        emit(
          "pr_coauthored",
          coauthor,
          "coauthor",
          merged || null,
          `${id}:participation`,
          !merged ? { state: "pending" } : {},
        );
      }
    }
  } else if (envelope.family === "issue") {
    emit("issues_opened", author, "reporter", time(resource.created_at ?? resource.createdAt), `${id}:opened`);
    if (sourceAction === "closed")
      emit("issue_closure_stewardship", sender, "triager", at, transitionUnit, { rawState: "closed" });
    // Closed, assignee and closer never manufacture implementing contributors.
  } else if (envelope.family === "comment") {
    emit("issue_answers", author, "author", time(resource.created_at), `${id}:comment-evidence`, {
      state: author && time(resource.created_at) ? "pending" : "unknown",
    });
    out.reasons.push("comment_is_not_an_accepted_answer_or_substantive_response");
  } else if (envelope.family === "review") {
    const review = object(payload.review) ? payload.review : resource;
    const reviewer = register(review.user ?? review.author);
    const reviewId = resourceId(review, "review", repository.id);
    const submitted = time(review.submitted_at ?? review.submittedAt);
    const state = text(review.state)?.toUpperCase();
    if (!reviewId || !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(state ?? ""))
      out.reasons.push("unsupported_review_state");
    else if (state === "PENDING") out.reasons.push("pending_review_not_submitted");
    else if (state === "DISMISSED" || sourceAction === "dismissed") {
      emit("review_rounds", reviewer, "reviewer", at, `${reviewId}:dismissed`, {
        state: "excluded",
        rawState: "dismissed",
      });
    } else {
      const firstSubmitted = envelope.reviewParticipation?.verified
        ? time(envelope.reviewParticipation.firstSubmittedAt)
        : null;
      if (reviewer?.kind === "user" && author && reviewer.id !== author.id && firstSubmitted) {
        emit("prs_reviewed", reviewer, "reviewer", firstSubmitted, `${id}:reviewer-participation`, {
          rawState: "submitted_review_participation",
        });
      } else
        out.reasons.push(
          !firstSubmitted ? "first_submitted_review_milestone_unverified" : "self_or_non_user_review_excluded",
        );
      const head = text(review.commit_id ?? review.commitOid);
      const firstInRound = envelope.reviewParticipation?.verified
        ? time(envelope.reviewParticipation.roundFirstSubmittedAt)
        : null;
      if (head && pinnedSha(head) && firstInRound)
        emit("review_rounds", reviewer, "reviewer", firstInRound, `${id}:head:${head}`, {
          rawState: `submitted_head:${head}`,
        });
      else out.reasons.push("review_head_round_or_first_submission_unverified");
      emit(
        "review_feedback",
        reviewer,
        "reviewer",
        time(review.created_at ?? review.createdAt),
        `${reviewId}:feedback`,
        { rawState: state! },
      );
      if (envelope.action === "first_submitted_review_verified")
        emit("first_reviews", reviewer, "reviewer", submitted, `${id}:first-review`);
    }
    out.reasons.push("review_quality_requires_independent_receipt");
  } else if (envelope.family === "commit") {
    const sha = text(resource.sha);
    const commitAuthor = register(resource.author),
      committer = register(resource.committer);
    if (commitAuthor)
      out.participation.push({ artifactId: id, actorId: commitAuthor.id, role: "author", conservedUnit: id });
    if (committer)
      out.participation.push({ artifactId: id, actorId: committer.id, role: "committer", conservedUnit: id });
    for (const linked of envelope.verifiedCoauthors ?? []) {
      const coauthor = linked.verificationReceipt.trim() ? register(linked.actor) : null;
      if (
        coauthor &&
        coauthor.id !== commitAuthor?.id &&
        !out.participation.some((item) => item.role === "coauthor" && item.actorId === coauthor.id)
      ) {
        out.participation.push({ artifactId: id, actorId: coauthor.id, role: "coauthor", conservedUnit: id });
      }
    }
    const integration = envelope.integration;
    if (
      !sha ||
      !pinnedSha(sha) ||
      !integration ||
      integration.targetBranch !== integration.defaultBranch ||
      !integration.commitShas.includes(sha)
    ) {
      out.reasons.push("default_branch_integration_unverified");
    } else {
      emit("commits_integrated", commitAuthor, "author", at, `${repository.id}:${sha}:integrated`);
      if (sourceAction === "direct_default_branch_integration")
        emit("direct_changes", commitAuthor, "author", at, `${repository.id}:${sha}:integrated`);
    }
  } else if (envelope.family === "discussion") {
    emit("discussions_started", author, "author", time(resource.createdAt), `${id}:created`);
    // Native answer selection is public source evidence, not an independent
    // quality review. The selector never receives the answer author's credit.
    if (object(resource.answer) && envelope.discussionAnswerSelection?.verified) {
      const answerAuthor = register(resource.answer.author);
      const chosenBy = register(resource.answerChosenBy);
      const chosenAt = time(resource.answerChosenAt);
      const answerId = resourceId(resource.answer, "other", repository.id);
      if (answerId && resource.answer.isAnswer === true && chosenAt) {
        emit("discussion_answers", answerAuthor, "author", chosenAt, `${id}:answer:${answerId}`, {
          acceptedAt: chosenAt,
          acceptedBy: chosenBy?.id ?? null,
          rawState: "native_answer_selection",
        });
      } else out.reasons.push("discussion_answer_selection_unverified");
    }
    if (!envelope.discussionAnswerSelection?.verified)
      out.reasons.push("discussion_answer_requires_selected_current_revision");
    out.reasons.push("discussion_helpfulness_requires_independent_receipt");
  } else if (envelope.family === "release") {
    if (sourceAction === "published" && resource.draft === false)
      emit(
        "release_stewardship",
        sender,
        sender?.kind === "bot" || sender?.kind === "github_app" ? "automation" : "author",
        at,
        `${id}:published`,
      );
    out.reasons.push("release_notes_maintenance_deployment_require_receipt");
  } else if (envelope.family === "thread_resolution") {
    if (sourceAction !== "resolved_transition" || !proof.eventId)
      out.reasons.push("current_resolvedBy_is_not_a_timestamped_resolution");
    else emit("review_threads_resolved", sender, "resolver", at, transitionUnit);
  } else if (envelope.family === "body_edit") {
    const changes = payload.changes;
    const hasDiff =
      object(changes) &&
      Object.entries(changes).some(
        ([field, change]) =>
          ["title", "body"].includes(field) &&
          object(change) &&
          typeof change.from === "string" &&
          typeof resource[field] === "string" &&
          change.from !== resource[field],
      );
    if (!hasDiff || !proof.eventId || !at) out.reasons.push("edit_history_actor_or_diff_unverified");
    else emit("title_scope_edits", sender, "triager", at, transitionUnit, { rawState: "evidenced_edit" });
    out.reasons.push("clarification_or_correction_requires_receipt");
  } else if (envelope.family === "field_change") {
    const mapping: Record<string, string> = {
      issue_field_changed: "issue_field_updates",
      project_item_field_changed: "project_field_updates",
      project_status_changed: "project_status_updates",
      project_progress_published: "project_updates",
    };
    const metric = mapping[sourceAction];
    if (
      !metric ||
      !proof.eventId ||
      !object(payload.change) ||
      payload.change.before === undefined ||
      payload.change.after === undefined
    )
      out.reasons.push("unsupported_or_unproven_field_subtype");
    else if (JSON.stringify(payload.change.before) === JSON.stringify(payload.change.after))
      out.reasons.push("no_op_field_change");
    else emit(metric, sender, "triager", at, transitionUnit, { rawState: sourceAction });
  } else if (envelope.family === "triage") {
    const mapping: Record<string, string> = {
      labeled: "labels_applied",
      unlabeled: "items_triaged",
      assigned: "assignments_coordinated",
      unassigned: "assignments_coordinated",
      milestoned: "milestones_curated",
      demilestoned: "milestones_curated",
      issue_typed: "items_triaged",
      issue_untyped: "items_triaged",
      label_created: "label_taxonomy",
      label_edited: "label_taxonomy",
      label_deleted: "label_taxonomy",
      label_archived: "label_taxonomy",
      label_unarchived: "label_taxonomy",
      milestone_created: "milestone_definitions",
      milestone_edited: "milestone_definitions",
      milestone_closed: "milestone_definitions",
      milestone_reopened: "milestone_definitions",
      milestone_deleted: "milestone_definitions",
      pinned: "public_moderation",
      unpinned: "public_moderation",
      locked: "public_moderation",
      unlocked: "public_moderation",
    };
    const metric = mapping[sourceAction];
    const target = object(payload.label)
      ? payload.label
      : object(payload.milestone)
        ? payload.milestone
        : object(payload.assignee)
          ? payload.assignee
          : null;
    const targetId = target ? resourceId(target, "metadata", repository.id) : text(payload.target_id);
    if (!metric || !proof.eventId) out.reasons.push("unsupported_or_unproven_triage_action");
    else if (object(payload.change) && JSON.stringify(payload.change.before) === JSON.stringify(payload.change.after))
      out.reasons.push("no_op_metadata_change");
    else {
      const missingTarget =
        ["labels_applied", "assignments_coordinated", "milestones_curated"].includes(metric) && !targetId;
      if (missingTarget) out.reasons.push("unknown_metadata_target_identity");
      const properties: Partial<NormalizedGithubFact> = {
        rawState: `${sourceAction}:${targetId ?? "unknown"}`,
        ...(missingTarget ? { state: "unknown" } : {}),
      };
      const metadataUnit = stable(transitionUnit, targetId ?? id);
      emit(metric, sender, "triager", at, metadataUnit, properties);
      if (["labels_applied", "assignments_coordinated", "milestones_curated"].includes(metric))
        emit("items_triaged", sender, "triager", at, metadataUnit, properties);
    }
  } else if (envelope.family === "relationship") {
    if (sourceAction === "transferred") {
      const destination = object(payload.destination) ? payload.destination : null;
      if (!destination || destination.visibility !== "public" || destination.allowed !== true) {
        out.suppressArtifactIds.push(id);
        out.reasons.push("transfer_destination_private_unknown_or_unapproved");
      } else if (
        !positive(destination.repositoryId) ||
        !text(destination.stableId) ||
        !url(destination.url, String(destination.slug))
      )
        out.reasons.push("transfer_lineage_incomplete");
      else {
        const targetId = String(destination.stableId);
        out.lineage.push({ relation: "transferred_to", sourceIds: [id], targetId, evidenceIds: [observationId] });
        emit("issue_transfers", sender, "triager", at, stable(id, targetId, at, sender?.id), {
          rawState: "public_transfer",
        });
      }
    } else {
      const relationship = object(payload.relationship) ? payload.relationship : null;
      const mapping: Record<string, string> = {
        parent_child: "parent_child_links",
        blocked_by: "blocker_links",
        related: "related_links",
        closing: "closing_links",
        reference: "reference_links",
        duplicate: "duplicate_resolution",
      };
      if (
        !relationship ||
        relationship.intentional !== true ||
        !text(relationship.from) ||
        !text(relationship.to) ||
        !mapping[String(relationship.kind)] ||
        !proof.eventId
      ) {
        out.reasons.push("automatic_reference_or_relationship_actor_unverified");
      } else if (relationship.publicEndpointsVerified !== true) {
        out.reasons.push("relationship_endpoint_visibility_unverified");
      } else {
        const endpoints = [String(relationship.from), String(relationship.to)];
        if (["related", "duplicate"].includes(String(relationship.kind))) endpoints.sort();
        emit(
          mapping[String(relationship.kind)]!,
          sender,
          "triager",
          at,
          stable(relationship.kind, endpoints, sourceAction, at, sender?.id),
          { rawState: String(relationship.kind) },
        );
      }
    }
  }
  if (envelope.family === "revert") {
    const verifiedRevert = envelope.lineage?.find(
      (link) => link.relation === "reverted_by" && link.sourceIds.includes(id) && link.evidenceIds.length > 0,
    );
    if (verifiedRevert && proof.eventId)
      emit("reverted_delivery", author, "author", at, `${id}:revert:${verifiedRevert.targetId}`, {
        rawState: "reverted_annotation_no_penalty",
      });
    else out.reasons.push("revert_requires_explicit_source_lineage");
  }
  if (envelope.family === "pull_request" && envelope.reviewCohort?.verified === true) {
    emit("review_wait", author, "author", time(envelope.reviewCohort.firstReadyAt), `${id}:readiness-cohort`, {
      readyAt: time(envelope.reviewCohort.firstReadyAt),
      firstReviewAt: time(envelope.reviewCohort.firstSubmittedReviewAt),
      state: author ? "observed" : "unknown",
    });
  }
  const integration = envelope.integration;
  if (integration?.diff) {
    if (
      integration.targetBranch !== integration.defaultBranch ||
      integration.diff.before !== integration.before ||
      integration.diff.after !== integration.after ||
      !text(integration.canonicalChangeId)
    ) {
      out.reasons.push("physical_change_is_not_verified_default_branch_integration");
    } else {
      out.physicalDiff = classifyPhysicalDiff(integration.diff);
      if (!out.physicalDiff.complete) out.reasons.push(...out.physicalDiff.reasons);
      else {
        for (const [metric, quantity] of [
          ["pr_lines_added", out.physicalDiff.additions],
          ["pr_lines_removed", out.physicalDiff.deletions],
          ["pr_lines_changed", out.physicalDiff.changed],
        ] as const) {
          emit(metric, author, "author", at, `${repository.id}:${integration.canonicalChangeId}:default-integration`, {
            quantity: quantity!,
            rawState: "physical_change_not_effort",
          });
        }
        for (const file of out.physicalDiff.files.filter((file) => file.eligible)) {
          emit(
            "files_changed",
            author,
            "author",
            at,
            `${repository.id}:${integration.canonicalChangeId}:path:${file.path}`,
            { rawState: `eligible_${file.classification}_path` },
          );
        }
      }
    }
  }
  for (const link of envelope.lineage ?? []) {
    if (link.sourceIds.length && link.evidenceIds.length && text(link.targetId))
      out.lineage.push(structuredClone(link));
  }
  for (const declared of envelope.assistance ?? [])
    if (text(declared.model)) out.assistance.push({ artifactId: id, model: declared.model, version: declared.version });
  out.reasons = [...new Set(out.reasons)].sort();
  return out;
}

export interface VerifiedRecognitionReceipt {
  id: string;
  verified: true;
  metricId: string;
  actorId: string;
  reviewerId: string;
  acceptedAt: string;
  decision: "accepted" | "rejected";
  targetFactId: string;
  evidenceIds: readonly string[];
  /** One changeset for e.g. ordering/configuration; not one credit per affected child/item. */
  changesetId?: string;
}
const receiptMetrics = new Set([
  "accepted_findings",
  "confirmed_bugs",
  "issue_resolution",
  "duplicate_resolution",
  "labels_corrected",
  "issue_clarifications",
  "accepted_suggestions",
  "release_changes",
  "automation",
  "deployment_work",
  "incidents",
  "maintenance",
  "reproductions",
  "issue_answers",
  "routing_handoffs",
  "mentorship",
  "onboarding",
  "project_configuration",
  "issue_ordering",
]);
/** The host authenticates receipts. Source payload approval text is never a receipt. */
export function applyRecognitionReceipt(
  input: NormalizedGithubResult,
  receipt: VerifiedRecognitionReceipt,
  authorizedReviewerIds: readonly string[],
): NormalizedGithubResult {
  const out = structuredClone(input);
  const target = input.facts.find((fact) => fact.id === receipt.targetFactId);
  if (
    receipt.verified !== true ||
    !text(receipt.id) ||
    !time(receipt.acceptedAt) ||
    !receipt.evidenceIds.length ||
    !authorizedReviewerIds.includes(receipt.reviewerId) ||
    receipt.reviewerId === receipt.actorId ||
    !target ||
    target.actorId !== receipt.actorId ||
    !input.actors.some((candidate) => candidate.id === receipt.actorId) ||
    !(receiptMetrics.has(receipt.metricId) || receipt.metricId === target.metricId)
  ) {
    throw new Error("Independent verified recognition receipt is required");
  }
  const fact = {
    ...target,
    metricId: receipt.metricId,
    id: stable("recognized", receipt.metricId, receipt.changesetId ?? target.canonicalKey, receipt.actorId),
    canonicalKey: stable(
      "recognized-unit",
      receipt.metricId,
      receipt.changesetId ?? target.canonicalKey,
      receipt.actorId,
    ),
    state: receipt.decision === "accepted" ? ("qualified" as const) : ("excluded" as const),
    acceptedAt: time(receipt.acceptedAt),
    acceptedBy: receipt.reviewerId,
    acceptanceReceipt: receipt.id,
  };
  out.facts.push(fact);
  const evidence = input.evidence.find((item) => item.contribution.contributionId === target.id);
  if (evidence)
    out.evidence.push({
      ...structuredClone(evidence),
      occurredAt: fact.acceptedAt,
      contribution: {
        ...evidence.contribution,
        contributionId: fact.id,
        canonicalEventId: fact.canonicalKey,
        metricIds: [fact.metricId],
        qualification: receipt.decision === "accepted" ? "eligible" : "ineligible",
        reasonCodes: ["independent_recognition_receipt", receipt.id],
      },
    });
  return out;
}

export interface CollectionNormalizerInput {
  /** Trusted host selects the current subject revision at its frozen cutoff. */
  selectedCurrentState?: boolean;
  repository: { id: number; slug: string };
  family: string;
  factKey: string;
  observedAt: string;
  policyVersion: string;
  fact: {
    subjectId: string;
    sourceRevision: string;
    sourceUrl: string;
    evidence: "current_state" | "observed_transition";
    actorId: string | null;
    occurredAt: string | null;
    state: string;
  };
}
export interface GithubEvidenceNormalizerOptions {
  client: GithubReadClient;
  /** Synchronous host authorization rechecked by the transport before every HTTP attempt. */
  assertAuthorized?: () => void;
  source: string;
  allowedRepositoryIds: readonly number[];
  isSynthetic?: boolean;
  /** Rich authorized event/diff enrichment. It cannot be supplied by public input. */
  enrich?: (input: CollectionNormalizerInput) => Promise<GithubEvidenceEnvelope | null>;
  /** Collection adapters may use opaque revisions; verify those through their trusted provenance store. */
  verifyRevision?: (input: CollectionNormalizerInput, payload: unknown) => Promise<boolean>;
  acceptance?: (
    input: CollectionNormalizerInput,
    normalized: NormalizedGithubResult,
  ) => Promise<readonly VerifiedRecognitionReceipt[]>;
  authorizedReviewerIds?: readonly string[];
  /** Bound the complete review cohort scan; exhaustion never establishes participation. */
  maxReviewPages?: number;
}

/** Read-only collection-to-metric adapter. Lossy snapshots are hydrated rather than guessed. */
export function createGithubEvidenceNormalizer(options: GithubEvidenceNormalizerOptions) {
  return async (input: CollectionNormalizerInput): Promise<NormalizedGithubResult> => {
    const none = (reason: string) => ({ ...result(), isSynthetic: options.isSynthetic === true, reasons: [reason] });
    if (!options.allowedRepositoryIds.includes(input.repository.id))
      return none("repository_not_authorized_for_normalization");
    if (!text(input.policyVersion) || !time(input.observedAt))
      throw new Error("Pipeline policy and observation time are required");
    if (input.family === "project_current") {
      const snapshot = await readPublicProjectSnapshot({
        client: options.client,
        source: options.source,
        repository: input.repository,
        itemId: input.fact.subjectId,
        scanId: input.factKey,
        ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
      });
      if (
        snapshot.sourceUrl !== input.fact.sourceUrl ||
        !matchesSnapshotRevision(input.fact.sourceRevision, projectSnapshotRevision(snapshot))
      )
        return none("project_snapshot_revision_or_subject_unverified");
      return normalizeGithubObservation({
        repository: { ...input.repository, visibility: "public" },
        proof: {
          verified: true,
          source: "github_graphql",
          revision: input.fact.sourceRevision,
          isSynthetic: options.isSynthetic === true,
        },
        family: "project_snapshot",
        action: "snapshot",
        observedAt: input.observedAt,
        payload: { id: snapshot.id, url: snapshot.sourceUrl },
        currentContext: { projects: [snapshot.projectId], workstreams: [] },
      });
    }
    const enriched = options.enrich ? await options.enrich(input) : null;
    let normalized: NormalizedGithubResult;
    if (enriched) {
      if (
        enriched.repository.id !== input.repository.id ||
        enriched.repository.slug !== input.repository.slug ||
        enriched.proof.revision !== input.fact.sourceRevision
      )
        return none("enrichment_scope_or_revision_mismatch");
      normalized = normalizeGithubObservation({
        ...enriched,
        proof: { ...enriched.proof, isSynthetic: options.isSynthetic === true || enriched.proof.isSynthetic === true },
      });
    } else {
      const sourceUrl = url(input.fact.sourceUrl.split("#")[0], input.repository.slug);
      if (!sourceUrl) return none("untrusted_collection_source_url");
      const parsed = new URL(sourceUrl);
      const suffix = parsed.pathname.slice(input.repository.slug.length + 2);
      const pull = suffix.match(/^pull\/(\d+)$/),
        issue = suffix.match(/^issues\/(\d+)$/),
        commit = suffix.match(/^commit\/([a-f0-9]{40,64})$/i),
        release = suffix.match(/^releases\/tag\/([A-Za-z0-9_.-]+)$/);
      const discussion = suffix.match(/^discussions\/(\d+)$/);
      const fragment = input.fact.sourceUrl.includes("#") ? input.fact.sourceUrl.split("#")[1] : "";
      let family: GithubEvidenceEnvelope["family"];
      let endpoint: string;
      let discussionPayload: Record<string, unknown> | undefined;
      let timeline = false;
      let pullResource: unknown;
      let reviewParticipation: GithubEvidenceEnvelope["reviewParticipation"];
      if (input.family === "timelines" && (issue || pull) && /^[1-9]\d*$/.test(input.fact.subjectId)) {
        family = "triage";
        timeline = true;
        endpoint = `/repos/${input.repository.slug}/issues/events/${input.fact.subjectId}`;
      } else if (input.family === "discussions" && discussion) {
        const [owner, name] = input.repository.slug.split("/");
        const data = await options.client.graphql<{ repository?: Record<string, unknown> }>(
          options.source,
          `query($owner:String!, $name:String!, $number:Int!) {
            repository(owner:$owner, name:$name) {
              databaseId isPrivate hasDiscussionsEnabled
              discussion(number:$number) {
                id url createdAt updatedAt answerChosenAt
                author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
                answerChosenBy { __typename login ... on User { databaseId } ... on Bot { databaseId } }
                answer { id isAnswer author { __typename login ... on User { databaseId } ... on Bot { databaseId } } }
              }
            }
          }`,
          { owner, name, number: Number(discussion[1]) },
          options.assertAuthorized,
        );
        if (
          data.repository?.databaseId !== input.repository.id ||
          data.repository.isPrivate !== false ||
          data.repository.hasDiscussionsEnabled !== true ||
          !object(data.repository.discussion)
        )
          return none("discussion_public_source_unavailable");
        discussionPayload = data.repository.discussion;
        family = "discussion";
        endpoint = "";
      } else if (input.family === "reviews" && pull && /^pullrequestreview-\d+$/.test(fragment ?? "")) {
        family = "review";
        endpoint = `/repos/${input.repository.slug}/pulls/${pull[1]}/reviews/${fragment!.slice("pullrequestreview-".length)}`;
        pullResource = await options.client.rest(
          options.source,
          `/repos/${input.repository.slug}/pulls/${pull[1]}`,
          options.assertAuthorized,
        );
      } else if (input.family === "comments" && issue && /^issuecomment-\d+$/.test(fragment ?? "")) {
        family = "comment";
        endpoint = `/repos/${input.repository.slug}/issues/comments/${fragment!.slice("issuecomment-".length)}`;
      } else if (input.family === "pull_requests" && pull) {
        family = "pull_request";
        endpoint = `/repos/${input.repository.slug}/pulls/${pull[1]}`;
      } else if (input.family === "issues" && issue) {
        family = "issue";
        endpoint = `/repos/${input.repository.slug}/issues/${issue[1]}`;
      } else if (input.family === "commits" && commit) {
        family = "commit";
        endpoint = `/repos/${input.repository.slug}/commits/${commit[1]}`;
      } else if (input.family === "releases" && release) {
        family = "release";
        endpoint = `/repos/${input.repository.slug}/releases/tags/${release[1]}`;
      } else return none("source_family_requires_exact_event_enrichment");
      const [repositoryPayload, payload] = await Promise.all([
        options.client.rest(options.source, `/repos/${input.repository.slug}`, options.assertAuthorized),
        discussionPayload ?? options.client.rest(options.source, endpoint, options.assertAuthorized),
      ]);
      if (
        !object(repositoryPayload) ||
        repositoryPayload.id !== input.repository.id ||
        repositoryPayload.private !== false
      ) {
        const revoked = none("repository_public_scope_unverified_or_revoked");
        const subject = family === "review" && object(pullResource) ? pullResource : payload;
        const artifact = object(subject) ? resourceId(subject, family, input.repository.id) : null;
        if (artifact) revoked.suppressArtifactIds.push(artifact);
        return revoked;
      }
      if (!object(payload)) return none("missing_hydrated_source_object");
      const identities = [payload.node_id, payload.id, payload.sha].filter((value) => value !== undefined).map(String);
      if (!identities.includes(input.fact.subjectId)) return none("hydrated_subject_identity_mismatch");
      const revisionMatches = options.verifyRevision
        ? await options.verifyRevision(input, payload)
        : timeline
          ? input.fact.sourceRevision === githubTimelineRevision(payload)
          : family === "review"
            ? matchesSnapshotRevision(input.fact.sourceRevision, githubReviewRevision(payload))
            : family === "discussion"
              ? matchesSnapshotRevision(input.fact.sourceRevision, githubDiscussionRevision(payload))
              : [
                  payload.sha,
                  payload.updated_at,
                  payload.created_at,
                  payload.submitted_at,
                  payload.published_at,
                  payload.updatedAt,
                ].some(
                  (value) =>
                    value === input.fact.sourceRevision ||
                    (time(value) !== null && time(value) === time(input.fact.sourceRevision)),
                );
      if (!revisionMatches) return none("hydrated_source_revision_unverified");
      if (family === "issue" && "pull_request" in payload) return none("pull_request_is_not_an_issue_creation_unit");
      // Hydration proves immutable creation/submission fields. It does not prove
      // any current-state field editor, closer, resolver or body-edit history.
      if (family === "review" && pull) {
        const cohort = await options.client.scanRest<unknown>({
          source: options.source,
          key: `review-cohort:${input.repository.id}:${input.factKey}:${input.fact.sourceRevision}`,
          url: `/repos/${input.repository.slug}/pulls/${pull[1]}/reviews?per_page=100`,
          maxPages: options.maxReviewPages ?? 100,
          ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
          select(body) {
            if (!Array.isArray(body)) throw new Error("Review cohort must be an array");
            return body;
          },
        });
        const submittedStates = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];
        const ids = new Set<string>();
        const complete =
          cohort.length <= 10000 &&
          cohort.every((review) => {
            if (!object(review)) return false;
            const reviewId = resourceId(review, "review", input.repository.id);
            if (!reviewId || ids.has(reviewId)) return false;
            ids.add(reviewId);
            return (
              review.state === "PENDING" ||
              (submittedStates.includes(String(review.state)) &&
                time(review.submitted_at) !== null &&
                object(review.user) &&
                positive(review.user.id) &&
                pinnedSha(String(review.commit_id)))
            );
          });
        const currentId = resourceId(payload, "review", input.repository.id);
        const current = cohort.find(
          (review) => object(review) && resourceId(review, "review", input.repository.id) === currentId,
        );
        const reviewerId = object(payload.user) ? payload.user.id : null;
        if (
          complete &&
          object(current) &&
          current.state === payload.state &&
          current.submitted_at === payload.submitted_at &&
          current.commit_id === payload.commit_id &&
          object(current.user) &&
          current.user.id === reviewerId &&
          Number.isSafeInteger(reviewerId)
        ) {
          const submissions = cohort.filter(
            (review): review is Record<string, unknown> =>
              object(review) &&
              submittedStates.includes(String(review.state)) &&
              object(review.user) &&
              review.user.id === reviewerId,
          );
          const earliest = (reviews: Record<string, unknown>[]) =>
            reviews.map((review) => time(review.submitted_at)!).sort()[0] ?? null;
          reviewParticipation = {
            verified: true,
            firstSubmittedAt: earliest(submissions),
            roundFirstSubmittedAt: earliest(submissions.filter((review) => review.commit_id === payload.commit_id)),
          };
        }
      }
      if (timeline && (!object(payload.issue) || payload.issue.html_url !== sourceUrl))
        return none("timeline_subject_scope_unverified");
      const hydrated = family === "review" ? { review: payload, pull_request: pullResource } : payload;
      normalized = normalizeGithubObservation({
        repository: {
          id: input.repository.id,
          slug: input.repository.slug,
          visibility: "public",
          ...(typeof repositoryPayload.default_branch === "string"
            ? { defaultBranch: repositoryPayload.default_branch }
            : {}),
        },
        proof: {
          verified: true,
          source: family === "discussion" ? "github_graphql" : "github_rest",
          ...(timeline ? { eventId: `github:${input.repository.id}:issue-event:${input.fact.subjectId}` } : {}),
          revision: input.fact.sourceRevision,
          isSynthetic: options.isSynthetic === true,
        },
        family,
        action: timeline ? String(payload.event) : "snapshot",
        ...(timeline ? { occurredAt: time(payload.created_at) } : {}),
        observedAt: input.observedAt,
        payload: hydrated,
        ...(reviewParticipation ? { reviewParticipation } : {}),
        ...(family === "discussion" && input.selectedCurrentState
          ? { discussionAnswerSelection: { verified: true as const } }
          : {}),
      });
    }
    if (options.acceptance)
      for (const receipt of await options.acceptance(input, normalized)) {
        normalized = applyRecognitionReceipt(normalized, receipt, options.authorizedReviewerIds ?? []);
      }
    return normalized;
  };
}

export interface TriageTransition {
  id: string;
  artifactId: string;
  actorId: string | null;
  facet: string;
  targetId: string;
  occurredAt: string | null;
  before: string | null;
  after: string | null;
}
/** Explicit policy intervals, not an inferred curation-quality classifier. */
export function groupTriageTransitions(
  events: readonly TriageTransition[],
  policy: { version: string; intervalSeconds: number; cooldownSeconds: number },
) {
  if (
    !text(policy.version) ||
    ![policy.intervalSeconds, policy.cooldownSeconds].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error("Reviewed grouping interval/cooldown required");
  const unknown: string[] = [];
  const units = new Map<string, TriageTransition[]>();
  const byId = new Map<string, TriageTransition>();
  for (const event of events) {
    const previous = byId.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event))
      throw new Error("Conflicting triage source identity");
    byId.set(event.id, event);
  }
  for (const event of byId.values()) {
    if (!event.actorId || !time(event.occurredAt)) {
      unknown.push(event.id);
      continue;
    }
    const key = stable(event.artifactId, event.actorId, event.facet, event.targetId);
    const bucket = units.get(key) ?? [];
    bucket.push(event);
    units.set(key, bucket);
  }
  const sessions: Array<{
    id: string;
    artifactId: string;
    actorId: string;
    eventIds: string[];
    rawActions: number;
    qualifiedCandidate: false;
    reversalSuppressed: boolean;
    repeatedStateSuppressed: boolean;
  }> = [];
  for (const bucket of units.values()) {
    bucket.sort((a, b) => time(a.occurredAt)!.localeCompare(time(b.occurredAt)!) || a.id.localeCompare(b.id));
    const groups: TriageTransition[][] = [];
    for (const event of bucket) {
      const last = groups.at(-1);
      if (!last || Date.parse(event.occurredAt!) - Date.parse(last.at(-1)!.occurredAt!) > policy.intervalSeconds * 1000)
        groups.push([event]);
      else last.push(event);
    }
    const seenStates = new Map<string, number>();
    for (const group of groups) {
      const first = group[0]!,
        last = group.at(-1)!;
      const stateKey = JSON.stringify(last.after),
        prior = seenStates.get(stateKey);
      const repeated = prior !== undefined && Date.parse(last.occurredAt!) - prior <= policy.cooldownSeconds * 1000;
      seenStates.set(stateKey, Date.parse(last.occurredAt!));
      sessions.push({
        id: stable(
          "triage-session",
          policy.version,
          first.artifactId,
          first.actorId,
          first.facet,
          first.targetId,
          first.id,
        ),
        artifactId: first.artifactId,
        actorId: first.actorId!,
        eventIds: group.map((event) => event.id),
        rawActions: group.length,
        qualifiedCandidate: false,
        reversalSuppressed: first.before === last.after,
        repeatedStateSuppressed: repeated,
      });
    }
  }
  return {
    policyVersion: policy.version,
    sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)),
    unknownEventIds: unknown.sort(),
    rawActions: byId.size,
    qualifiedOutcomes: 0,
    caveat:
      "Grouping and persistence do not prove curation correctness; independent recognition receipts are required.",
  };
}

/** A declared model is assistance metadata. Unverified human trailer names remain unresolved. */
export function parseDeclaredCoauthorTrailers(
  message: string,
  options: {
    verifiedPeople: readonly { trailerName: string; actor: unknown; verificationReceipt: string }[];
    declaredModels: readonly { trailerName: string; model: string; version: string | null }[];
  },
) {
  if (message.length > 1024 * 1024) throw new Error("Commit message exceeds bounded trailer parser");
  const names = [...message.matchAll(/^Co-authored-by:\s*([^<\r\n]+?)(?:\s*<[^>\r\n]*>)?\s*$/gim)].map((match) =>
    match[1]!.trim(),
  );
  const coauthors: Array<{ actor: NormalizedGithubActor; verificationReceipt: string }> = [];
  const assistance: Array<{ model: string; version: string | null }> = [];
  let unresolved = 0;
  for (const name of new Set(names)) {
    const model = options.declaredModels.find((item) => item.trailerName === name);
    if (model) {
      assistance.push({ model: model.model, version: model.version });
      continue;
    }
    const person = options.verifiedPeople.find((item) => item.trailerName === name && text(item.verificationReceipt));
    const parsed = person ? actor(person.actor) : null;
    if (person && parsed) coauthors.push({ actor: parsed, verificationReceipt: person.verificationReceipt });
    else unresolved++;
  }
  return { coauthors, assistance, unresolvedCount: unresolved };
}
