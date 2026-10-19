import { classifyDocumentation, validateDocumentationPolicy, type DocumentationPathPolicy } from "./documentation.js";
import {
  classifyResearchRecords,
  validateResearchPolicy,
  type ResearchPathPolicy,
  type VerifiedResearchRecord,
} from "./research.js";
import { createHash } from "node:crypto";
import {
  compareSourceInstants,
  sourceEventSchema,
  publicDocumentationReasons,
  serviceAccountClassificationSchema,
  type ServiceAccountClassification,
  publicEvidenceActionSchema,
  publicEvidenceHistorySchema,
  publicEvidenceMetadataSchema,
  type PublicEvidenceMetadata,
  type PublicEvidenceHistory,
  type PublicEvidenceAction,
} from "@pick-your-ai/contracts";
import { GithubReadClient } from "./client.js";
import { readGithubCommentSource, readGithubCommentIdentity } from "./comment-identity.js";
import { consistentReviewCohortIdentities, reviewParentMatches, reviewSourceMatches } from "./review-cohort.js";
import {
  hasGithubRestSnapshotPrefix,
  isGithubRestSnapshotFamily,
  githubRestSnapshotSemanticRevision,
  verifyGithubRestSnapshotRevision,
} from "./rest-snapshot.js";
import { validateAutomationSource, validateMaintenanceSource } from "./maintenance.js";
import {
  collectGithubReleaseInclusion,
  validateGithubReleaseInclusion,
  type GithubReleaseInclusionRecord,
} from "./release-inclusion.js";
import {
  validateReleaseChangesSource,
  type GithubReleaseReviewTarget,
  type GithubReleaseMembership,
} from "./release-recognition.js";
import { readTypedIssueHistory, typedHistoryRevision } from "./timeline-history.js";
import { readIssueFieldEvent, issueFieldHistoryRevision } from "./issue-field-history.js";
import { readPublicProjectSnapshot, projectSnapshotRevision } from "./project-snapshots.js";
import {
  readPublicSubjectProjectSnapshot,
  projectSubjectSnapshotRevision,
  projectContextFromSnapshot,
  validateProjectWorkstreamMapping,
  type ProjectWorkstreamMapping,
  type ProjectMembershipContext,
} from "./project-context.js";
import {
  classifyPhysicalDiff,
  pinnedSha,
  type PinnedPhysicalDiff,
  type ClassifiedPhysicalDiff,
} from "./physical-diff.js";

/** Cache generation for separately observed repository default-branch admission. */
export const defaultDeliveryNormalizationVersion = "default-delivery-scope/v1";

/** Hash only explicit source fields; text contributes to revision identity but is never retained. */
export function githubReviewRevision(value: Record<string, unknown>): string {
  const user = value.user !== null && typeof value.user === "object" ? (value.user as Record<string, unknown>) : {};
  // Missing optional source identities are permitted; explicitly malformed ones
  // are not. Preserve that distinction in the collected cache identity as well.
  const supplied = (record: Record<string, unknown>, key: string) => [record[key] !== undefined, record[key] ?? null];
  const links = object(value._links)
    ? ["links", supplied(value._links, "html"), supplied(value._links, "pull_request")]
    : supplied(value, "_links");
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.id ?? null,
        supplied(value, "node_id"),
        value.state ?? null,
        value.submitted_at ?? null,
        value.commit_id ?? null,
        user.id ?? null,
        user.type ?? null,
        value.body ?? null,
        value.html_url ?? null,
        supplied(value, "pull_request_url"),
        supplied(user, "node_id"),
        links,
      ]),
    )
    .digest("hex");
}

/** Native answer selection is bound to source creation and observation clocks. */
export const discussionSourceNormalizationVersion = "discussion-answer-chronology/v1";

export function githubDiscussionRevision(value: Record<string, unknown>): string {
  const identity = (value: unknown) =>
    object(value) ? [value.databaseId ?? value.id ?? null, value.__typename ?? value.type ?? null] : null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.id ?? null,
        value.updatedAt ?? null,
        value.createdAt ?? null,
        identity(value.author),
        value.answerChosenAt ?? null,
        object(value.answer) ? (value.answer.id ?? null) : null,
        object(value.answer) ? (value.answer.isAnswer ?? null) : null,
        object(value.answer) ? (value.answer.createdAt ?? null) : null,
        object(value.answer) ? identity(value.answer.author) : null,
        identity(value.answerChosenBy),
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

function canonicalTriageAction(action: string): string {
  if (action === "issue_type_added") return "issue_typed";
  if (action === "issue_type_removed") return "issue_untyped";
  return action;
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
        // Type targets affect raw-state identity and must survive the same
        // collection/hydration revision check as other credited metadata.
        // Keep existing non-type event fingerprints unchanged.
        ...(["issue_typed", "issue_untyped"].includes(canonicalTriageAction(String(value.event)))
          ? [identity(value.issue_type), value.target_id ?? null]
          : []),
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
  eventContext: {
    projects: string[];
    workstreams: string[];
    workstreamsKnown?: boolean;
    projectScope?: string[];
  } | null;
  currentContext: {
    projects: string[];
    workstreams: string[];
    workstreamsKnown?: boolean;
    projectScope?: string[];
  } | null;
  quantity?: number;
  rawState?: string;
  outcome?: "merged" | "closed_unmerged" | "pending";
  readyAt?: string | null;
  firstReviewAt?: string | null;
  /** Original observed locale unit superseded only in descriptive current activity. */
  recognitionSourceFactId?: string;
  /** Private accepted release membership and conserved work identity. */
  releaseInclusion?: GithubReleaseMembership;
}
export interface NormalizedGithubActor {
  id: string;
  login: string | null;
  kind: "user" | "service_account" | "bot" | "github_app" | "organization" | "system" | "unknown";
  /** Internal authenticated evidence, deliberately absent from the public Actor contract. */
  serviceAccountClassification?: ServiceAccountClassification;
  publicState: "visible" | "deleted" | "suppressed";
  githubDatabaseId: number;
  githubNodeId?: string;
  executionMode: "automated" | "unknown";
}
export interface NormalizedPublicEvidence {
  evidenceMetadata?: PublicEvidenceMetadata;
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
  /** Private provenance retained when the pipeline combines observation results. */
  syntheticFactIds?: readonly string[];
  /** Private output of the bounded authorized release collector. */
  releaseInclusions?: readonly GithubReleaseInclusionRecord[];
  facts: NormalizedGithubFact[];
  actors: NormalizedGithubActor[];
  evidence: NormalizedPublicEvidence[];
  observations: GithubObservation[];
  reasons: string[];
  lineage: GithubLineage[];
  suppressArtifactIds: string[];
  physicalDiff?: ClassifiedPhysicalDiff;
  /** Private current association; it never creates an action or historical attribution. */
  projectContext?: NormalizedProjectContext;
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
    | "pull_request_conversation_comment"
    | "pull_request_review_comment"
    | "revert";
  observedAt: string;
  /** Exact evidenced transition time only. A delivery/observation/updated_at time is not a substitute. */
  occurredAt?: string | null;
  action?: string;
  payload: unknown;
  eventContext?: {
    projects: string[];
    workstreams: string[];
    workstreamsKnown?: boolean;
    projectScope?: string[];
  } | null;
  currentContext?: {
    projects: string[];
    workstreams: string[];
    workstreamsKnown?: boolean;
    projectScope?: string[];
  } | null;
  verifiedCoauthors?: readonly { actor: unknown; verificationReceipt: string }[];
  /** Protected collector input, never copied from API payloads, trailers or public request bodies. */
  reviewedServiceAccounts?: readonly ServiceAccountClassification[];
  authorizedClassifierIds?: readonly string[];
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
  /** Protected host input: individually verified public, minimized records for this artifact.
   * Never populate from private correction receipts, payload fields or a guessed revision log. */
  publicHistory?: { approvedPublic: true; history: PublicEvidenceHistory };
  /** Protected exact-blob identities; never copy these from PR or note text. */
  researchRecords?: readonly VerifiedResearchRecord[];
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
  if (
    databaseId === undefined ||
    new Set([value.databaseId, value.githubDatabaseId, value.id].filter(positive)).size > 1
  )
    return null;
  const sourceKinds: (NormalizedGithubActor["kind"] | null)[] = [
    value.type === "User" || value.__typename === "User" || value.kind === "user" ? "user" : null,
    value.type === "Bot" || value.__typename === "Bot" || value.kind === "bot" ? "bot" : null,
    value.type === "Organization" || value.__typename === "Organization" ? "organization" : null,
    value.type === "GitHubApp" || value.__typename === "App" ? "github_app" : null,
  ];
  const kinds = sourceKinds.filter((kind) => kind !== null);
  const kind = kinds[0];
  if (!kind || kinds.length !== 1) return null;
  const nodeIds = [
    text(value.node_id),
    text(value.githubNodeId),
    typeof value.id === "string" && !/^\d+$/.test(value.id) ? text(value.id) : null,
  ].filter((id) => id !== null);
  if (new Set(nodeIds).size > 1) return null;
  const nodeId = nodeIds[0];
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

function definitionResourceId(
  payload: Record<string, unknown>,
  kind: "label" | "milestone",
  repoId: number,
): string | null {
  const nodeId = text(payload.node_id);
  if (nodeId) return nodeId;
  const providerId = positive(payload.id) ? String(payload.id) : text(payload.id);
  return providerId ? `github:${repoId}:${kind}:${providerId}` : null;
}

/** Names are bounded current-source labels, never historical titles or rendered Markdown. */
function collectedTitle(resource: Record<string, unknown>, kind: string, observedAt: string) {
  const raw = resource.title ?? (kind === "release" || kind === "other" ? resource.name : null);
  if (typeof raw !== "string") return null;
  const value = raw
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .trim();
  return value ? { value, basis: "as_collected" as const, collectedAt: observedAt } : null;
}
function creditedAction(fact: NormalizedGithubFact, family: string, envelopeAction: string): PublicEvidenceAction {
  if (fact.state === "unknown" || fact.state === "excluded") return "unknown";
  const actions: Record<string, PublicEvidenceAction> = {
    pr_opened: "artifact_created",
    issues_opened: "artifact_created",
    pr_ready: "pull_request_ready",
    review_wait: "pull_request_ready",
    pr_merged: "pull_request_merged",
    maintainer_merges: "pull_request_merged",
    issue_closure_stewardship: "issue_closed",
    issue_answers: "comment_created",
    prs_reviewed: "review_submitted",
    review_rounds: "review_submitted",
    first_reviews: "review_submitted",
    review_feedback: "review_feedback_created",
    commits_integrated: "default_branch_integrated",
    direct_changes: "default_branch_integrated",
    pr_lines_added: "default_branch_integrated",
    pr_lines_removed: "default_branch_integrated",
    pr_lines_changed: "default_branch_integrated",
    files_changed: "default_branch_integrated",
    release_stewardship: "release_published",
    review_threads_resolved: "review_thread_resolved",
    title_scope_edits: "title_or_body_edited",
    issue_transfers: "issue_transferred",
    reverted_delivery: "revert_observed",
    documentation: "pull_request_merged",
    localization: "pull_request_merged",
  };
  if (fact.metricId === "review_wait" && !fact.readyAt) return "unknown";
  if (fact.metricId === "pr_accepted_rate")
    return fact.outcome === "merged"
      ? "pull_request_merged"
      : fact.outcome === "closed_unmerged"
        ? "pull_request_closed_unmerged"
        : "unknown";
  if (fact.metricId === "pr_coauthored") return fact.state === "pending" ? "unknown" : "pull_request_merged";
  if (family === "triage" || family === "field_change") {
    const parsed = publicEvidenceActionSchema.safeParse(envelopeAction);
    return parsed.success ? parsed.data : "unknown";
  }
  if (family === "relationship" && fact.metricId !== "issue_transfers") return "relationship_changed";
  return actions[fact.metricId] ?? "unknown";
}

/** Normalize explicit public source facts. No field is taken from arbitrary user text. */
export function normalizeGithubObservation(
  envelope: GithubEvidenceEnvelope,
  documentationPolicy?: DocumentationPathPolicy,
  researchPolicy?: ResearchPathPolicy,
): NormalizedGithubResult {
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
  const prComment = ["pull_request_conversation_comment", "pull_request_review_comment"].includes(envelope.family);
  const observedAction = prComment
    ? envelope.family + "_snapshot"
    : (envelope.action ?? text(payload.action) ?? "snapshot");
  const sourceAction = envelope.family === "triage" ? canonicalTriageAction(observedAction) : observedAction;
  const definitionKind =
    envelope.family === "triage" && sourceAction.startsWith("label_")
      ? "label"
      : envelope.family === "triage" && sourceAction.startsWith("milestone_")
        ? "milestone"
        : null;
  const definitionResource = definitionKind ? payload[definitionKind] : null;
  if (definitionKind && !object(definitionResource)) {
    out.reasons.push("missing_public_artifact_identity");
    return out;
  }
  // A definition event owns the definition, even when an envelope also carries
  // issue context. Attached item membership cannot multiply definition credit.
  const resource =
    definitionKind && object(definitionResource)
      ? definitionResource
      : object(payload.pull_request)
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
            : envelope.family === "discussion" || envelope.family === "comment" || prComment || definitionKind !== null
              ? "other"
              : "issue";
  const id = definitionKind
    ? definitionResourceId(resource, definitionKind, repository.id)
    : resourceId(resource, kind, repository.id);
  if (repository.visibility !== "public" || (object(payload.repository) && payload.repository.private !== false)) {
    if (id) out.suppressArtifactIds.push(id);
    out.reasons.push("public_visibility_unverified_or_revoked");
    return out;
  }
  if (object(payload.repository) && payload.repository.id !== repository.id) {
    out.reasons.push("repository_scope_mismatch");
    return out;
  }
  const commentIdentity = prComment ? readGithubCommentIdentity(repository.slug, resource) : null;
  if (prComment && commentIdentity?.kind !== envelope.family) {
    out.reasons.push("comment_source_identity_unverified");
    return out;
  }
  const publicUrl = prComment
    ? commentIdentity!.sourceUrl
    : (url(resource.html_url ?? resource.url, repository.slug, kind === "project") ??
      url(payload.subject_url, repository.slug, kind === "project"));
  if (!id || !publicUrl) {
    out.reasons.push("missing_public_artifact_identity");
    return out;
  }
  const at = prComment ? null : time(envelope.occurredAt);
  const history =
    envelope.publicHistory?.approvedPublic === true
      ? publicEvidenceHistorySchema.parse(envelope.publicHistory.history)
      : { coverage: "not_supplied" as const, records: [] };
  const artifactTitle = collectedTitle(resource, kind, observedAt);
  const observationId = proof.eventId
    ? stable("event", proof.eventId)
    : stable("observation", id, proof.source, proof.revision, sourceAction);
  const classifications = new Map<number, ServiceAccountClassification>();
  const classifiedNodes = new Set<string>();
  for (const entry of envelope.reviewedServiceAccounts ?? []) {
    const classification = serviceAccountClassificationSchema.parse(entry);
    if (
      !envelope.authorizedClassifierIds?.includes(classification.reviewerActorId) ||
      compareSourceInstants(classification.reviewedAt, observedAt) > 0 ||
      classifications.has(classification.githubDatabaseId) ||
      (classification.githubNodeId && classifiedNodes.has(classification.githubNodeId))
    )
      throw new Error("Unique independently authorized service-account classification is required");
    classifications.set(classification.githubDatabaseId, classification);
    if (classification.githubNodeId) classifiedNodes.add(classification.githubNodeId);
  }
  // A single observation cannot bind one node to multiple database IDs or vice versa.
  // Keep these bindings even when an earlier occurrence lacked one of the IDs;
  // deduplicating the actor list must not hide conflicting evidence in later roles.
  const observedNodes = new Map<number, string>();
  const observedDatabaseIds = new Map<string, number>();
  const registeredActors = new Map<string, NormalizedGithubActor>();
  const register = (value: unknown, automated = false) => {
    const parsed = actor(value, automated);
    if (parsed?.githubNodeId) {
      const previousNode = observedNodes.get(parsed.githubDatabaseId);
      const previousDatabaseId = observedDatabaseIds.get(parsed.githubNodeId);
      if (
        (previousNode !== undefined && previousNode !== parsed.githubNodeId) ||
        (previousDatabaseId !== undefined && previousDatabaseId !== parsed.githubDatabaseId)
      )
        throw new Error("Conflicting observed actor database/node identity bindings");
      observedNodes.set(parsed.githubDatabaseId, parsed.githubNodeId);
      observedDatabaseIds.set(parsed.githubNodeId, parsed.githubDatabaseId);
    }
    const classification = parsed && classifications.get(parsed.githubDatabaseId);
    if (parsed && classification) {
      if (
        parsed.kind !== "user" ||
        classification.reviewerActorId === parsed.githubNodeId ||
        (classification.githubNodeId && classification.githubNodeId !== parsed.githubNodeId)
      )
        throw new Error("Service-account classification conflicts with source actor identity or kind");
      parsed.kind = "service_account";
      parsed.serviceAccountClassification = classification;
    } else if (parsed?.githubNodeId && classifiedNodes.has(parsed.githubNodeId)) {
      throw new Error("Service-account classification conflicts with source actor database ID");
    }
    if (parsed) {
      const previous = registeredActors.get(parsed.id);
      if (previous && previous.kind !== parsed.kind) throw new Error("Conflicting observed actor kinds");
      // Retain a later evidenced node on the same database ID for cross-observation checks.
      if (previous && !previous.githubNodeId && parsed.githubNodeId) previous.githubNodeId = parsed.githubNodeId;
      if (previous) {
        // One account may occupy several roles in the same observation. Unknown
        // execution in another role must not erase positively evidenced automation.
        if (parsed.executionMode === "automated") previous.executionMode = "automated";
        return previous;
      }
      registeredActors.set(parsed.id, parsed);
      out.actors.push(parsed);
    }
    return parsed;
  };
  const author = register(resource.user ?? resource.author);
  const sender = prComment ? null : register(sourceActor(payload), payload.execution_mode === "automated");
  out.observations.push({
    id: observationId,
    source: proof.source,
    action: observedAction,
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
      sourceRevisionUrl:
        kind === "commit" && resource.sha === proof.revision && pinnedSha(proof.revision) ? publicUrl : null,
      evidenceMetadata: publicEvidenceMetadataSchema.parse({
        schemaVersion: "leaderboard-evidence/v1",
        artifactTitle,
        sourceAction: creditedAction(fact, envelope.family, sourceAction),
        sourceOccurredAt: fact.occurredAt,
        observedAt,
        activityState: fact.state === "observed" || fact.state === "pending" ? fact.state : "unknown",
        // An observed ratio decision also has an internal acceptedAt clock. It is not recognition.
        acceptedAt: null,
        history: structuredClone(history),
      }),
    });
    return fact;
  };
  const nativeEventId =
    proof.eventId &&
    (proof.source === "github_graphql" || proof.eventId.startsWith(`github:${repository.id}:issue-event:`))
      ? proof.eventId
      : null;
  const transitionUnit = nativeEventId ? stable(id, nativeEventId) : stable(id, sourceAction, at, sender?.id ?? null);
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
  } else if (prComment) {
    out.reasons.push("pr_comment_snapshot_does_not_prove_submitted_review_or_accepted_answer");
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
      !text(repository.defaultBranch) ||
      integration.defaultBranch !== repository.defaultBranch ||
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
      const discussionCreatedAt = time(resource.createdAt);
      const answerCreatedAt = time(resource.answer.createdAt);
      const answerId = resourceId(resource.answer, "other", repository.id);
      if (!answerId || resource.answer.isAnswer !== true) {
        out.reasons.push("discussion_answer_selection_unverified");
      } else if (!chosenAt || !discussionCreatedAt || !answerCreatedAt) {
        // Never borrow the parent/update/collection clock for an unavailable
        // answer creation or selection. Native source ordering is unverified.
        out.reasons.push("discussion_answer_time_unverified");
      } else if (
        compareSourceInstants(discussionCreatedAt, answerCreatedAt) > 0 ||
        compareSourceInstants(answerCreatedAt, chosenAt) > 0 ||
        compareSourceInstants(chosenAt, observedAt) > 0
      ) {
        out.reasons.push("discussion_answer_chronology_invalid");
      } else {
        emit("discussion_answers", answerAuthor, "author", chosenAt, `${id}:answer:${answerId}`, {
          acceptedAt: chosenAt,
          acceptedBy: chosenBy?.id ?? null,
          rawState: "native_answer_selection",
        });
      }
    }
    if (!envelope.discussionAnswerSelection?.verified)
      out.reasons.push("discussion_answer_requires_selected_current_revision");
    out.reasons.push("discussion_helpfulness_requires_independent_receipt");
  } else if (envelope.family === "release") {
    if (sourceAction === "published" && resource.draft === false)
      emit(
        "release_stewardship",
        sender,
        sender?.kind === "bot" || sender?.kind === "github_app" || sender?.kind === "service_account"
          ? "automation"
          : "author",
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
    const metric = Object.hasOwn(mapping, sourceAction) ? mapping[sourceAction] : undefined;
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
    const metric = Object.hasOwn(mapping, sourceAction) ? mapping[sourceAction] : undefined;
    // Resolve the action's own target, never another field or the issue's current
    // metadata snapshot. Removal and type transitions need the same identity
    // proof as additions before they can participate in raw-state grouping.
    const targetField =
      ["labeled", "unlabeled"].includes(sourceAction) || sourceAction.startsWith("label_")
        ? "label"
        : ["milestoned", "demilestoned"].includes(sourceAction) || sourceAction.startsWith("milestone_")
          ? "milestone"
          : ["assigned", "unassigned"].includes(sourceAction)
            ? "assignee"
            : ["issue_typed", "issue_untyped"].includes(sourceAction)
              ? "issue_type"
              : null;
    const target = targetField ? payload[targetField] : null;
    const targetId = object(target) ? resourceId(target, "metadata", repository.id) : text(payload.target_id);
    if (!metric || !proof.eventId) out.reasons.push("unsupported_or_unproven_triage_action");
    else if (object(payload.change) && JSON.stringify(payload.change.before) === JSON.stringify(payload.change.after))
      out.reasons.push("no_op_metadata_change");
    else {
      const missingTarget = targetField !== null && !targetId;
      if (missingTarget) out.reasons.push("unknown_metadata_target_identity");
      const properties: Partial<NormalizedGithubFact> = {
        ...(missingTarget ? { state: "unknown" } : { rawState: `${sourceAction}:${targetId ?? "unknown"}` }),
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
      const relationshipKind = relationship?.kind;
      const metric =
        typeof relationshipKind === "string" && Object.hasOwn(mapping, relationshipKind)
          ? mapping[relationshipKind]
          : undefined;
      if (
        !relationship ||
        relationship.intentional !== true ||
        !text(relationship.from) ||
        !text(relationship.to) ||
        !metric ||
        !proof.eventId
      ) {
        out.reasons.push("automatic_reference_or_relationship_actor_unverified");
      } else if (relationship.publicEndpointsVerified !== true) {
        out.reasons.push("relationship_endpoint_visibility_unverified");
      } else {
        const endpoints = [String(relationship.from), String(relationship.to)];
        if (["related", "duplicate"].includes(String(relationshipKind))) endpoints.sort();
        emit(
          metric,
          sender,
          "triager",
          at,
          stable(relationshipKind, endpoints, sourceAction, at, sender?.id, nativeEventId),
          { rawState: String(relationshipKind) },
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
      !text(repository.defaultBranch) ||
      integration.defaultBranch !== repository.defaultBranch ||
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
  // Specialist review must bind an immutable delivered revision, never a PR URL
  // or its mutable update timestamp. This does not qualify the source fact.
  const mergedRevisionTime = time(resource.merged_at);
  if (
    envelope.family === "pull_request" &&
    resource.merged === true &&
    mergedRevisionTime &&
    Date.parse(mergedRevisionTime) <= Date.parse(observedAt) &&
    integration?.diff &&
    out.physicalDiff?.complete &&
    pinnedSha(integration.after) &&
    resource.merge_commit_sha === integration.after &&
    object(resource.base) &&
    text(resource.base.ref) &&
    text(repository.defaultBranch) &&
    resource.base.ref === integration.targetBranch &&
    integration.targetBranch === integration.defaultBranch &&
    repository.defaultBranch === integration.defaultBranch &&
    integration.diff.before === integration.before &&
    integration.diff.after === integration.after &&
    text(integration.canonicalChangeId)
  ) {
    for (const evidence of out.evidence.filter((entry) => entry.contribution.metricIds.includes("pr_merged"))) {
      evidence.sourceRevision = integration.after;
      evidence.sourceRevisionUrl = `https://github.com/${repository.slug}/commit/${integration.after}`;
    }
  }
  if (documentationPolicy && envelope.family === "pull_request") {
    validateDocumentationPolicy(documentationPolicy);
    const mergedAt = time(resource.merged_at);
    if (
      documentationPolicy.repositoryId !== repository.id ||
      !integration?.diff ||
      resource.merged !== true ||
      !mergedAt ||
      Date.parse(mergedAt) > Date.parse(observedAt) ||
      resource.merge_commit_sha !== integration.after ||
      !object(resource.base) ||
      !text(resource.base.ref) ||
      !text(integration.targetBranch) ||
      !text(integration.defaultBranch) ||
      !text(repository.defaultBranch) ||
      resource.base.ref !== integration.targetBranch ||
      integration.targetBranch !== integration.defaultBranch ||
      repository.defaultBranch !== integration.defaultBranch ||
      integration.diff.before !== integration.before ||
      integration.diff.after !== integration.after ||
      !text(integration.canonicalChangeId)
    ) {
      out.reasons.push("documentation_merged_revision_unverified");
    } else {
      const classification = classifyDocumentation(integration.diff, documentationPolicy);
      out.reasons.push(...classification.reasons);
      if (classification.eligible) {
        const fact = emit("documentation", author, "author", mergedAt, `${repository.id}:${id}:documentation`, {
          rawState: "merged_documentation_participation_not_reviewed_quality",
        });
        const evidence = out.evidence.find((entry) => entry.contribution.contributionId === fact.id)!;
        evidence.sourceRevision = integration.after;
        evidence.sourceRevisionUrl = `https://github.com/${repository.slug}/commit/${integration.after}`;
        evidence.contribution.reasonCodes.push(`documentation_path_policy:${documentationPolicy.version}`);
      }
      for (const { locale, category } of classification.localizations) {
        const fact = emit(
          "localization",
          author,
          "author",
          mergedAt,
          JSON.stringify([repository.id, id, "localization", locale, category]),
          { rawState: `merged_locale_participation:${locale}:${category}` },
        );
        const evidence = out.evidence.find((entry) => entry.contribution.contributionId === fact.id)!;
        evidence.sourceRevision = integration.after;
        evidence.sourceRevisionUrl = `https://github.com/${repository.slug}/commit/${integration.after}`;
        evidence.contribution.reasonCodes.push(
          `documentation_path_policy:${documentationPolicy.version}`,
          `locale:${locale}`,
          `localization_category:${category}`,
        );
      }
    }
  }
  if (researchPolicy && envelope.family === "pull_request") {
    validateResearchPolicy(researchPolicy);
    const mergedAt = time(resource.merged_at);
    if (
      researchPolicy.repositoryId !== repository.id ||
      !integration?.diff ||
      resource.merged !== true ||
      !mergedAt ||
      Date.parse(mergedAt) > Date.parse(observedAt) ||
      resource.merge_commit_sha !== integration.after ||
      !object(resource.base) ||
      !text(resource.base.ref) ||
      !text(integration.targetBranch) ||
      !text(integration.defaultBranch) ||
      !text(repository.defaultBranch) ||
      resource.base.ref !== integration.targetBranch ||
      integration.targetBranch !== integration.defaultBranch ||
      repository.defaultBranch !== integration.defaultBranch ||
      integration.diff.before !== integration.before ||
      integration.diff.after !== integration.after ||
      !text(integration.canonicalChangeId)
    ) {
      out.reasons.push("research_merged_revision_unverified");
    } else {
      const classification = classifyResearchRecords(integration.diff, envelope.researchRecords ?? [], researchPolicy);
      out.reasons.push(...classification.reasons);
      for (const record of classification.records) {
        const recordId = stable("research-record", repository.id, record.path, record.blobSha);
        const fact = emit("decision_records", author, "author", mergedAt, recordId, {
          artifactId: recordId,
          state: author ? "pending" : "unknown",
          rawState: "research_record_version_pending_independent_review",
        });
        const evidence = out.evidence.find((entry) => entry.contribution.contributionId === fact.id)!;
        evidence.artifact = {
          ...evidence.artifact,
          kind: "other",
          stableId: recordId,
          publicUrl: `https://github.com/${repository.slug}/blob/${record.sourceRevision}/${record.path}`,
        };
        evidence.contribution.artifactId = recordId;
        evidence.contribution.reasonCodes = [
          "research_record_not_accepted",
          `research_path_policy:${researchPolicy.version}`,
        ];
        evidence.sourceRevision = record.sourceRevision;
        evidence.sourceRevisionUrl = `https://github.com/${repository.slug}/commit/${record.sourceRevision}`;
        // The PR title and its history describe a different artifact.
        delete evidence.evidenceMetadata;
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
  /** Exact immutable merge revision reviewed for a localization target. */
  sourceRevision?: string;
  /** Exact target authenticated in the private release acceptance audit. */
  releaseInclusion?: GithubReleaseReviewTarget;
}
const receiptMetrics = new Set([
  "catalog_proposals",
  "pricebook_proposals",
  "compatibility_proposals",
  "primary_sources",
  "freshness_checks",
  "reproduced_measurements",
  "negative_findings",
  "rights_reviews",
  "assumptions_resolved",
  "market_research",
  "evidence_manifests",
  "data_quality",
  "documentation",
  "tests",
  "regressions_prevented",
  "accessibility",
  "design",
  "usability",
  "performance",
  "security",
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
  "governance",
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
  const targetEvidence = input.evidence.find((item) => item.contribution.contributionId === receipt.targetFactId);
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
  // An accepted answer cannot precede its known source occurrence. Preserve
  // unknown clocks and the separate accepted-at ranking rule; a collection or
  // revision time is not a substitute for the original source event.
  if (
    receipt.metricId === "issue_answers" &&
    receipt.decision === "accepted" &&
    typeof target.occurredAt === "string" &&
    sourceEventSchema.shape.occurredAt.safeParse(target.occurredAt).success &&
    compareSourceInstants(target.occurredAt, receipt.acceptedAt) > 0
  )
    throw new Error("Answer acceptance cannot predate its known source occurrence");
  // A generic receipt cannot turn a PR, closing action or synthetic fixture into
  // a confirmed report. The issue proof must identify this exact source fact.
  if (
    receipt.metricId === "confirmed_bugs" &&
    (input.isSynthetic === true ||
      input.syntheticFactIds?.includes(target.id) ||
      target.metricId !== "issues_opened" ||
      !target.artifactId ||
      !targetEvidence ||
      input.evidence.filter((entry) => entry.contribution.contributionId === target.id).length !== 1 ||
      targetEvidence.artifact.kind !== "issue" ||
      targetEvidence.artifact.stableId !== target.artifactId ||
      targetEvidence.contribution.artifactId !== target.artifactId ||
      targetEvidence.artifact.repositoryId !== target.repoId ||
      targetEvidence.contribution.actorId !== target.actorId)
  )
    throw new Error("Confirmed bug recognition requires a nonsynthetic issue source");
  // Localization is one PR/language/category unit. A bulk changeset must never
  // collapse different languages or mint another unit for the same source fact.
  const mergedChange =
    receipt.metricId === "maintenance"
      ? validateMaintenanceSource(input, target.id, receipt.acceptedAt)
      : receipt.metricId === "automation"
        ? validateAutomationSource(input, target.id, receipt.acceptedAt)
        : null;
  const release =
    receipt.metricId === "release_changes"
      ? validateReleaseChangesSource(input, target.id, receipt.acceptedAt, receipt.releaseInclusion)
      : null;
  if (release && (receipt.evidenceIds.length !== 1 || receipt.evidenceIds[0] !== target.id))
    throw new Error("release_inclusion_source_unverified");
  const unit = release
    ? release.membershipUnit
    : mergedChange
      ? mergedChange.unit
      : receipt.metricId === "localization"
        ? target.canonicalKey
        : (receipt.changesetId ?? target.canonicalKey);
  if (receipt.metricId === "localization" && target.state !== "observed")
    throw new Error("Localization acceptance must target its original observed source fact");
  if (
    receipt.metricId === "localization" &&
    (!targetEvidence ||
      !target.canonicalKey ||
      typeof receipt.sourceRevision !== "string" ||
      !pinnedSha(receipt.sourceRevision) ||
      targetEvidence.sourceRevision !== receipt.sourceRevision ||
      !time(target.occurredAt) ||
      Date.parse(target.occurredAt!) > Date.parse(receipt.acceptedAt))
  )
    throw new Error(
      "Localization acceptance requires its reviewed merge revision and a decision no earlier than merge",
    );
  const fact = {
    ...target,
    metricId: receipt.metricId,
    id: stable("recognized", receipt.metricId, unit, receipt.actorId),
    canonicalKey: stable("recognized-unit", receipt.metricId, unit, receipt.actorId),
    state: receipt.decision === "accepted" ? ("qualified" as const) : ("excluded" as const),
    acceptedAt: time(receipt.acceptedAt),
    acceptedBy: receipt.reviewerId,
    acceptanceReceipt: receipt.id,
    ...(receipt.metricId === "localization" ? { recognitionSourceFactId: target.id } : {}),
    ...(release
      ? {
          occurredAt: release.record.release.publishedAt,
          observedAt: release.observedAt,
          releaseInclusion: release.membership,
        }
      : {}),
  };
  out.facts.push(fact);
  const evidence = targetEvidence;
  if (evidence)
    out.evidence.push({
      ...structuredClone(evidence),
      occurredAt: release
        ? release.record.release.publishedAt
        : receipt.metricId === "localization" || mergedChange
          ? target.occurredAt
          : fact.acceptedAt,
      ...(release
        ? {
            sourceRevision: release.record.tag.commitSha,
            sourceRevisionUrl: `https://github.com/${release.record.repository.slug}/commit/${release.record.tag.commitSha}`,
          }
        : {}),
      ...(evidence.evidenceMetadata
        ? {
            evidenceMetadata: {
              ...structuredClone(evidence.evidenceMetadata),
              ...(release
                ? { sourceOccurredAt: release.record.release.publishedAt, observedAt: release.observedAt }
                : {}),
              sourceAction: receipt.decision === "accepted" ? ("recognition_accepted" as const) : ("unknown" as const),
              activityState: receipt.decision === "accepted" ? ("accepted" as const) : ("unknown" as const),
              acceptedAt: receipt.decision === "accepted" ? fact.acceptedAt : null,
            },
          }
        : {}),
      contribution: {
        ...evidence.contribution,
        contributionId: fact.id,
        canonicalEventId: receipt.metricId === "localization" ? target.canonicalKey! : fact.canonicalKey,
        metricIds: [fact.metricId],
        qualification: receipt.decision === "accepted" ? "eligible" : "ineligible",
        reasonCodes: [
          "independent_recognition_receipt",
          ...(receipt.metricId === target.metricId && ["documentation", "localization"].includes(target.metricId)
            ? publicDocumentationReasons(evidence.contribution)
            : []),
        ],
      },
    });
  return out;
}

export interface NormalizedProjectContext {
  schemaVersion: "github-current-project-context/v2";
  repositoryId: string;
  subjectId: string;
  subjectKind: "issue" | "pull_request";
  sourceUrl: string;
  sourceRevision: string;
  observedAt: string;
  mappingVersion: string | null;
  context: ProjectMembershipContext & { projectScope: string[] };
}

export interface CollectionNormalizerInput {
  /** Ephemeral host identity shared only within one native-history normalization batch. */
  issueFieldHistoryBatch?: object;
  /** Trusted host selects the current subject revision at its frozen cutoff. */
  selectedCurrentState?: boolean;
  repository: { id: number; slug: string; allowedProjectIds?: readonly string[] };
  family: string;
  factKey: string;
  observedAt: string;
  policyVersion: string;
  fact: {
    subjectId: string;
    /** Native issue/PR identity retained by the trusted typed-history collector. */
    historySubjectId?: string;
    issueFieldId?: string;
    projectSubjectId?: string;
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
  /** Protected actual clock for new release lookups; original source observation stays unchanged. */
  now?: () => string;
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
  /** Frozen reviewed account classification configuration, selected and authenticated by the host. */
  reviewedServiceAccounts?: readonly ServiceAccountClassification[];
  authorizedClassifierIds?: readonly string[];
  /** Bound the complete review cohort scan; exhaustion never establishes participation. */
  maxReviewPages?: number;
  documentationPolicies?: readonly DocumentationPathPolicy[];
  researchPolicies?: readonly ResearchPathPolicy[];
  projectWorkstreamMappings?: readonly (ProjectWorkstreamMapping & { repositoryId: number })[];
  /** Protected, finite selections; submitted notes cannot nominate release proof. */
  releaseInclusionTargets?: readonly { repositoryId: number; releaseId: number; pullRequestNumber: number }[];
}

/** Read-only collection-to-metric adapter. Lossy snapshots are hydrated rather than guessed. */
export function createGithubEvidenceNormalizer(options: GithubEvidenceNormalizerOptions) {
  const releaseNow = options.now ?? (() => new Date().toISOString());
  const releaseTargets = structuredClone(options.releaseInclusionTargets ?? []);
  if (
    !Array.isArray(releaseTargets) ||
    releaseTargets.length > 1000 ||
    releaseTargets.some(
      (target) =>
        !object(target) ||
        Object.keys(target).sort().join(",") !== "pullRequestNumber,releaseId,repositoryId" ||
        ![target.repositoryId, target.releaseId, target.pullRequestNumber].every(
          (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        ) ||
        typeof target.repositoryId !== "number" ||
        !options.allowedRepositoryIds.includes(target.repositoryId),
    ) ||
    new Set(
      releaseTargets.map((target) => JSON.stringify([target.repositoryId, target.releaseId, target.pullRequestNumber])),
    ).size !== releaseTargets.length ||
    (releaseTargets.length > 0 && typeof options.assertAuthorized !== "function")
  )
    throw new Error("invalid_release_inclusion_targets");
  const projectMappings = structuredClone(options.projectWorkstreamMappings ?? []);
  if (
    !Array.isArray(projectMappings) ||
    projectMappings.length > 1000 ||
    projectMappings.some(
      (mapping) =>
        !object(mapping) ||
        Object.keys(mapping).length !== 3 ||
        !["repositoryId", "version", "projects"].every((key) => Object.hasOwn(mapping, key)) ||
        typeof mapping.repositoryId !== "number" ||
        !Number.isSafeInteger(mapping.repositoryId) ||
        mapping.repositoryId < 1 ||
        !options.allowedRepositoryIds.includes(mapping.repositoryId),
    ) ||
    new Set(projectMappings.map((mapping) => mapping.repositoryId)).size !== projectMappings.length
  )
    throw new Error("invalid_project_workstream_mapping");
  const documentationPolicies = structuredClone(options.documentationPolicies ?? []);
  for (const policy of documentationPolicies) validateDocumentationPolicy(policy);
  if (new Set(documentationPolicies.map((policy) => policy.repositoryId)).size !== documentationPolicies.length)
    throw new Error("Ambiguous documentation repository policy");
  const researchPolicies = structuredClone(options.researchPolicies ?? []);
  for (const policy of researchPolicies) validateResearchPolicy(policy);
  if (new Set(researchPolicies.map((policy) => policy.repositoryId)).size !== researchPolicies.length)
    throw new Error("Ambiguous research repository policy");
  return async (input: CollectionNormalizerInput): Promise<NormalizedGithubResult> => {
    const none = (reason: string) => ({ ...result(), isSynthetic: options.isSynthetic === true, reasons: [reason] });
    if (!options.allowedRepositoryIds.includes(input.repository.id))
      return none("repository_not_authorized_for_normalization");
    if (!text(input.policyVersion) || !time(input.observedAt))
      throw new Error("Pipeline policy and observation time are required");
    if (
      hasGithubRestSnapshotPrefix(input.fact.sourceRevision) &&
      (!isGithubRestSnapshotFamily(input.family) ||
        githubRestSnapshotSemanticRevision(input.fact.sourceRevision) === null)
    )
      return none("hydrated_source_revision_unverified");
    let repositoryClient: GithubReadClient | undefined;
    const client = () => (repositoryClient ??= options.client.forRepository(input.repository.id));
    if (input.family === "issue_field_history") {
      const match = input.fact.sourceUrl.match(
        new RegExp("^https://github\\.com/" + input.repository.slug.replaceAll(".", "\\.") + "/issues/([1-9]\\d*)$"),
      );
      if (
        !match ||
        input.fact.evidence !== "observed_transition" ||
        typeof input.fact.historySubjectId !== "string" ||
        !input.fact.historySubjectId ||
        typeof input.fact.issueFieldId !== "string" ||
        !input.fact.issueFieldId
      )
        return none("issue_field_collected_binding_unverified");
      const record = await readIssueFieldEvent({
        client: options.client,
        source: options.source,
        repository: input.repository,
        number: Number(match[1]),
        subjectId: input.fact.historySubjectId,
        eventId: input.fact.subjectId,
        issueFieldId: input.fact.issueFieldId,
        scanId: input.factKey,
        ...(input.issueFieldHistoryBatch ? { issueFieldHistoryBatch: input.issueFieldHistoryBatch } : {}),
        ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
      });
      if (issueFieldHistoryRevision(record) !== input.fact.sourceRevision)
        return none("issue_field_revision_unverified");
      const nativeActorId = positive(record.event.actor?.databaseId) ? String(record.event.actor.databaseId) : null;
      if (input.fact.actorId !== nativeActorId || input.fact.occurredAt !== time(record.event.createdAt))
        return none("issue_field_collected_attribution_unverified");
      return normalizeGithubObservation({
        repository: { ...input.repository, visibility: "public" },
        proof: {
          verified: true,
          source: "github_graphql",
          eventId: record.event.id,
          revision: input.fact.sourceRevision,
          isSynthetic: options.isSynthetic === true,
        },
        family: "field_change",
        action: "issue_field_changed",
        observedAt: input.observedAt,
        occurredAt: record.event.createdAt,
        payload: {
          issue: { id: record.subject.id, url: record.subject.url },
          sender: record.event.actor,
          change: record.change,
        },
      });
    }
    if (input.family === "relationships" || input.family === "project_history") {
      const match = input.fact.sourceUrl.match(
        new RegExp(`^https://github\\.com/${input.repository.slug.replaceAll(".", "\\.")}/(issues|pull)/([1-9]\\d*)$`),
      );
      if (!match || (match[1] === "pull" && input.family !== "project_history"))
        return none("typed_history_subject_url_unverified");
      if (input.family === "project_history" && input.fact.historySubjectId === undefined)
        return none("project_history_subject_identity_not_collected");
      const records = await readTypedIssueHistory({
        client: client(),
        source: options.source,
        repository: input.repository,
        number: Number(match[2]),
        subjectType: match[1] === "pull" ? "pull_request" : "issue",
        ...(input.family === "project_history" ? { subjectId: input.fact.historySubjectId } : {}),
        family: input.family,
        scanId: input.factKey,
        ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
      });
      const record = records.find((item) => item.event.id === input.fact.subjectId);
      if (!record || typedHistoryRevision(record) !== input.fact.sourceRevision)
        return none("typed_history_revision_unverified");
      const event = record.event;
      const project = object(event.project) ? event.project : null;
      const target = object(event.parent) ? event.parent : object(event.blockingIssue) ? event.blockingIssue : null;
      const isProject = input.family === "project_history";
      if (isProject && event.wasAutomated !== false)
        return none("automated_or_unknown_project_status_not_human_credit");
      return normalizeGithubObservation({
        repository: { ...input.repository, visibility: "public" },
        proof: {
          verified: true,
          source: "github_graphql",
          eventId: input.fact.subjectId,
          revision: input.fact.sourceRevision,
          isSynthetic: options.isSynthetic === true,
        },
        family: isProject ? "field_change" : "relationship",
        observedAt: input.observedAt,
        occurredAt: time(event.createdAt),
        action: isProject
          ? "project_status_changed"
          : String(event.__typename).includes("Removed")
            ? "removed"
            : "added",
        ...(project
          ? {
              eventContext: {
                projects: [String(project.id)],
                projectScope: [String(project.id)],
                workstreams: [],
                workstreamsKnown: false,
              },
            }
          : {}),
        payload: isProject
          ? {
              id: event.id,
              url: record.subject.url,
              sender: event.actor,
              change: { before: event.previousStatus, after: event.status },
            }
          : {
              issue: { id: record.subject.id, url: record.subject.url },
              sender: event.actor,
              relationship: {
                kind: event.parent ? "parent_child" : "blocked_by",
                from: record.subject.id,
                to: target?.id,
                intentional: true,
                publicEndpointsVerified: true,
              },
            },
      });
    }
    if (input.family === "project_current") {
      if (input.fact.projectSubjectId !== undefined) {
        if (
          input.fact.projectSubjectId !== input.fact.subjectId ||
          input.fact.evidence !== "current_state" ||
          input.selectedCurrentState !== true
        )
          return none("project_context_current_selection_unverified");
        const configured = projectMappings.find((mapping) => mapping.repositoryId === input.repository.id);
        const mapping = configured
          ? validateProjectWorkstreamMapping(
              { version: configured.version, projects: configured.projects },
              input.repository.allowedProjectIds ?? [],
            )
          : undefined;
        const snapshot = await readPublicSubjectProjectSnapshot({
          client: client(),
          source: options.source,
          repository: input.repository,
          subjectId: input.fact.projectSubjectId,
          sourceUrl: input.fact.sourceUrl,
          allowedProjectIds: input.repository.allowedProjectIds ?? [],
          scanId: input.factKey,
          ...(options.assertAuthorized ? { assertAuthorized: options.assertAuthorized } : {}),
        });
        if (!matchesSnapshotRevision(input.fact.sourceRevision, projectSubjectSnapshotRevision(snapshot)))
          return none("project_snapshot_revision_or_subject_unverified");
        if (snapshot.items.some((item) => Date.parse(item.updatedAt) > Date.parse(input.observedAt)))
          return none("project_snapshot_after_observation_cutoff");
        return {
          ...result(),
          isSynthetic: options.isSynthetic === true,
          projectContext: {
            schemaVersion: "github-current-project-context/v2",
            repositoryId: String(snapshot.repositoryId),
            subjectId: snapshot.subjectId,
            subjectKind: snapshot.subjectKind,
            sourceUrl: snapshot.sourceUrl,
            sourceRevision: input.fact.sourceRevision,
            observedAt: input.observedAt,
            mappingVersion: mapping?.version ?? null,
            context: {
              ...projectContextFromSnapshot(snapshot, mapping),
              projectScope: [...snapshot.allowedProjectIds],
            },
          },
        };
      }
      const snapshot = await readPublicProjectSnapshot({
        client: client(),
        source: options.source,
        repository: input.repository,
        itemId: input.fact.subjectId,
        allowedProjectIds: input.repository.allowedProjectIds ?? [],
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
      normalized = normalizeGithubObservation(
        {
          ...enriched,
          ...(options.reviewedServiceAccounts === undefined
            ? {}
            : { reviewedServiceAccounts: options.reviewedServiceAccounts }),
          ...(options.authorizedClassifierIds === undefined
            ? {}
            : { authorizedClassifierIds: options.authorizedClassifierIds }),
          proof: {
            ...enriched.proof,
            isSynthetic: options.isSynthetic === true || enriched.proof.isSynthetic === true,
          },
        },
        input.family === "pull_requests"
          ? documentationPolicies.find((policy) => policy.repositoryId === input.repository.id)
          : undefined,
        input.family === "pull_requests"
          ? researchPolicies.find((policy) => policy.repositoryId === input.repository.id)
          : undefined,
      );
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
        const data = await client().graphql<{ repository?: Record<string, unknown> }>(
          options.source,
          `query($owner:String!, $name:String!, $number:Int!) {
            repository(owner:$owner, name:$name) {
              databaseId isPrivate hasDiscussionsEnabled
              discussion(number:$number) {
                id url createdAt updatedAt answerChosenAt
                author { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }
                answerChosenBy { __typename login ... on User { id databaseId } ... on Bot { id databaseId } }
                answer { id isAnswer createdAt author { __typename login ... on User { id databaseId } ... on Bot { id databaseId } } }
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
        pullResource = await client().rest(
          options.source,
          `/repos/${input.repository.slug}/pulls/${pull[1]}`,
          options.assertAuthorized,
        );
      } else if (input.family === "comments" && pull) {
        const comment = readGithubCommentSource(input.repository.slug, input.fact.sourceUrl);
        if (!comment || comment.kind === "issue_comment") return none("comment_source_identity_unverified");
        family = comment.kind;
        endpoint = comment.apiPath;
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
        client().rest(options.source, `/repos/${input.repository.slug}`, options.assertAuthorized),
        discussionPayload ?? client().rest(options.source, endpoint, options.assertAuthorized),
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
      if (["pull_request_conversation_comment", "pull_request_review_comment"].includes(family)) {
        const comment = readGithubCommentIdentity(input.repository.slug, payload);
        if (!comment || comment.kind !== family || comment.sourceUrl !== input.fact.sourceUrl)
          return none("comment_source_identity_unverified");
      }
      if (family === "review" && pull) {
        const parentApiUrl = `https://api.github.com/repos/${input.repository.slug}/pulls/${pull[1]}`;
        if (
          !reviewParentMatches(pullResource, sourceUrl, pull[1]!) ||
          !reviewSourceMatches(payload, sourceUrl, parentApiUrl) ||
          payload.html_url !== input.fact.sourceUrl
        )
          return none("review_parent_or_source_identity_unverified");
      }
      const identities = [payload.node_id, payload.id, payload.sha].filter((value) => value !== undefined).map(String);
      if (!identities.includes(input.fact.subjectId)) return none("hydrated_subject_identity_mismatch");
      const revisionMatches = hasGithubRestSnapshotPrefix(input.fact.sourceRevision)
        ? verifyGithubRestSnapshotRevision(input.family, payload, input.fact.sourceRevision) &&
          (!options.verifyRevision || (await options.verifyRevision(input, payload)))
        : options.verifyRevision
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
        const cohort = await client().scanRest<unknown>({
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
          consistentReviewCohortIdentities(
            cohort,
            payload,
            sourceUrl,
            `https://api.github.com/repos/${input.repository.slug}/pulls/${pull[1]}`,
          ) &&
          cohort.every((review) => {
            if (!object(review)) return false;
            const reviewId = resourceId(review, "review", input.repository.id);
            if (!reviewId || ids.has(reviewId)) return false;
            ids.add(reviewId);
            return (
              review.state === "PENDING" ||
              (typeof review.state === "string" &&
                submittedStates.includes(review.state) &&
                time(review.submitted_at) !== null &&
                object(review.user) &&
                positive(review.user.id) &&
                typeof review.commit_id === "string" &&
                pinnedSha(review.commit_id))
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
          current.id === payload.id &&
          current.state === payload.state &&
          current.submitted_at === payload.submitted_at &&
          current.commit_id === payload.commit_id &&
          current.node_id === payload.node_id &&
          object(current.user) &&
          current.user.id === reviewerId &&
          Number.isSafeInteger(reviewerId)
        ) {
          const submissions = cohort.filter(
            (review): review is Record<string, unknown> =>
              object(review) &&
              typeof review.state === "string" &&
              submittedStates.includes(review.state) &&
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
        ...(options.reviewedServiceAccounts === undefined
          ? {}
          : { reviewedServiceAccounts: options.reviewedServiceAccounts }),
        ...(options.authorizedClassifierIds === undefined
          ? {}
          : { authorizedClassifierIds: options.authorizedClassifierIds }),
        ...(reviewParticipation ? { reviewParticipation } : {}),
        ...(family === "discussion" && input.selectedCurrentState
          ? { discussionAnswerSelection: { verified: true as const } }
          : {}),
      });
    }
    if (input.family === "pull_requests" && normalized.isSynthetic !== true) {
      const candidates = releaseTargets.filter(
        (target) =>
          target.repositoryId === input.repository.id &&
          input.fact.sourceUrl === `https://github.com/${input.repository.slug}/pull/${target.pullRequestNumber}`,
      );
      if (candidates.length) {
        const records: GithubReleaseInclusionRecord[] = [];
        const authorizeRelease = options.assertAuthorized!;
        const readClock = () => {
          if (typeof releaseNow !== "function") throw new Error("release_inclusion_observation_clock_invalid");
          const value = releaseNow();
          if (typeof value !== "string" || !sourceEventSchema.shape.observedAt.safeParse(value).success)
            throw new Error("release_inclusion_observation_clock_invalid");
          return value;
        };
        for (const target of candidates) {
          const startedAt = readClock();
          const record = await collectGithubReleaseInclusion({
            client: client(),
            source: options.source,
            repository: input.repository,
            releaseId: target.releaseId,
            pullRequestNumber: target.pullRequestNumber,
            observedAt: startedAt,
            assertAuthorized: authorizeRelease,
          });
          const completedAt = readClock();
          if (compareSourceInstants(completedAt, startedAt) < 0)
            throw new Error("release_inclusion_observation_clock_invalid");
          authorizeRelease();
          // A retained PR can precede this release. Its original source clock is
          // not the observation time of these new, fully completed proof reads.
          records.push(validateGithubReleaseInclusion({ ...record, observedAt: completedAt }));
        }
        normalized.releaseInclusions = records;
      }
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
    if (!text(event.actorId) || !text(event.artifactId) || !time(event.occurredAt)) {
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
  const artifacts = new Set<string>();
  const byActor = new Map<string, { rawActions: number; sessions: number; artifacts: Set<string> }>();
  for (const session of sessions) {
    artifacts.add(session.artifactId);
    const summary = byActor.get(session.actorId) ?? { rawActions: 0, sessions: 0, artifacts: new Set<string>() };
    summary.rawActions += session.rawActions;
    summary.sessions += 1;
    summary.artifacts.add(session.artifactId);
    byActor.set(session.actorId, summary);
  }
  return {
    policyVersion: policy.version,
    sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)),
    unknownEventIds: unknown.sort(),
    rawActions: byId.size,
    distinctArtifacts: artifacts.size,
    actorSummaries: [...byActor]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([actorId, summary]) => ({
        actorId,
        rawActions: summary.rawActions,
        sessions: summary.sessions,
        distinctArtifacts: summary.artifacts.size,
      })),
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
