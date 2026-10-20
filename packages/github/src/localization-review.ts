import { consistentReviewCohortIdentities, reviewParentMatches } from "./review-cohort.js";

export const localizationReviewNormalizationVersion = "localization-review-participation/v1";

export interface GithubLocalizationMergeSource {
  schemaVersion: typeof localizationReviewNormalizationVersion;
  repositoryId: string;
  artifactId: string;
  pullRequestId: number;
  publicUrl: string;
  sourceRevision: string;
  headRevision: string;
  mergeRevision: string;
  mergedAt: string;
  observedAt: string;
  authorId: string;
  policyVersion: string;
  units: Array<{ factId: string; locale: string; category: string }>;
}

export interface GithubLocalizationReviewSource {
  schemaVersion: typeof localizationReviewNormalizationVersion;
  repositoryId: string;
  artifactId: string;
  publicUrl: string;
  sourceRevision: string;
  headRevision: string;
  observedAt: string;
  reviewerId: string;
  authorId: string;
  reviewId: string;
  reviewNodeId: string | null;
  submittedAt: string;
}

type ReviewActor = { id: string; kind: string; githubNodeId?: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const revision = (value: unknown): value is string =>
  typeof value === "string" && value.length === 40 && /^[a-f0-9]+$/.test(value);

/** One native first submission per reviewer and exact head. A later review, a
 * copied author fact or an accepting Controls actor cannot establish this proof.
 * Dismissed submissions constrain the first identity without granting credit.
 */
export function readLocalizationReviewSource(input: {
  repositoryId: string;
  artifactId: string;
  sourceRevision: string;
  current: Record<string, unknown>;
  parent: Record<string, unknown>;
  parentUrl: string;
  parentApiUrl: string;
  cohort: readonly unknown[];
  observedAt: string;
  readActor: (value: unknown) => ReviewActor | null;
  readTime: (value: unknown) => string | null;
}): GithubLocalizationReviewSource | null {
  const { current, parent, parentUrl, parentApiUrl, cohort, observedAt, readActor, readTime } = input;
  const actors = new Map<string, ReviewActor>();
  const nodes = new Map<string, string>();
  const bind = (value: unknown) => {
    const who = readActor(value);
    if (!who) return null;
    const previous = actors.get(who.id);
    if (
      (previous &&
        (previous.kind !== who.kind ||
          (previous.githubNodeId && who.githubNodeId && previous.githubNodeId !== who.githubNodeId))) ||
      (who.githubNodeId &&
        (who.githubNodeId.trim() !== who.githubNodeId ||
          (nodes.has(who.githubNodeId) && nodes.get(who.githubNodeId) !== who.id)))
    )
      return null;
    const nodeId = who.githubNodeId ?? previous?.githubNodeId;
    const selected: ReviewActor = { ...who, ...(nodeId ? { githubNodeId: nodeId } : {}) };
    actors.set(who.id, selected);
    if (selected.githubNodeId) nodes.set(selected.githubNodeId, selected.id);
    return selected;
  };
  const author = bind(parent.user ?? parent.author);
  const reviewer = bind(current.user);
  const createdAt = readTime(parent.created_at);
  const submittedAt = readTime(current.submitted_at);
  const headRevision = current.commit_id;
  if (
    !author ||
    author.kind !== "user" ||
    !reviewer ||
    reviewer.kind !== "user" ||
    reviewer.id === author.id ||
    !identity(current.id) ||
    !createdAt ||
    !submittedAt ||
    submittedAt < createdAt ||
    submittedAt > observedAt ||
    !revision(headRevision) ||
    !object(parent.head) ||
    parent.head.sha !== headRevision ||
    !reviewParentMatches(parent, parentUrl, String(parent.number)) ||
    !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(String(current.state)) ||
    cohort.length < 1 ||
    cohort.length > 10000 ||
    !consistentReviewCohortIdentities(cohort, current, parentUrl, parentApiUrl)
  )
    return null;
  let first: { id: number; at: string; state: string } | null = null;
  let matched = false;
  for (const value of cohort) {
    if (!object(value)) return null;
    if (value.state === "PENDING") {
      if (value.submitted_at != null || (value.user != null && !bind(value.user))) return null;
      continue;
    }
    const who = bind(value.user);
    const at = readTime(value.submitted_at);
    if (
      !identity(value.id) ||
      !who ||
      !at ||
      at < createdAt ||
      at > observedAt ||
      !revision(value.commit_id) ||
      !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(String(value.state))
    )
      return null;
    if (value.id === current.id) {
      if (
        value.state !== current.state ||
        value.submitted_at !== current.submitted_at ||
        value.commit_id !== headRevision ||
        value.node_id !== current.node_id ||
        who.id !== reviewer.id ||
        who.kind !== reviewer.kind
      )
        return null;
      matched = true;
    }
    if (
      who.id === reviewer.id &&
      who.kind === "user" &&
      value.commit_id === headRevision &&
      (first === null || at < first.at || (at === first.at && value.id < first.id))
    )
      first = { id: value.id, at, state: String(value.state) };
  }
  if (!matched || first?.id !== current.id || first.state === "DISMISSED") return null;
  return {
    schemaVersion: localizationReviewNormalizationVersion,
    repositoryId: input.repositoryId,
    artifactId: input.artifactId,
    publicUrl: parentUrl,
    sourceRevision: input.sourceRevision,
    headRevision,
    observedAt,
    reviewerId: reviewer.id,
    authorId: author.id,
    reviewId: String(current.id),
    reviewNodeId: typeof current.node_id === "string" ? current.node_id : null,
    submittedAt,
  };
}
