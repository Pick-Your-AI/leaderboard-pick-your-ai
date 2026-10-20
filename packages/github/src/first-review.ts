import { consistentReviewCohortIdentities, reviewParentMatches } from "./review-cohort.js";

type ReviewActor = { id: string; kind: string; githubNodeId?: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Derive a first submission from the complete, exact-PR sequence, never its delivery action.
 * The caller supplies the same protected account classification used for other roles.
 * Dismissed submissions constrain the historical first clock; they do not promote a later review.
 */
export function firstReviewSubmission(input: {
  current: Record<string, unknown>;
  parent: Record<string, unknown>;
  parentUrl: string;
  parentApiUrl: string;
  cohort: readonly unknown[];
  observedAt: string;
  readActor: (value: unknown) => ReviewActor | null;
  readTime: (value: unknown) => string | null;
}): string | null {
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
  const created = readTime(parent.created_at);
  const submitted = readTime(current.submitted_at);
  if (
    !author ||
    !reviewer ||
    reviewer.kind !== "user" ||
    reviewer.id === author.id ||
    !created ||
    !submitted ||
    submitted < created ||
    submitted > observedAt ||
    !reviewParentMatches(parent, parentUrl, String(parent.number)) ||
    !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(String(current.state)) ||
    cohort.length < 1 ||
    cohort.length > 10000 ||
    !consistentReviewCohortIdentities(cohort, current, parentUrl, parentApiUrl)
  )
    return null;

  let currentMatched = false;
  let earliest: string | null = null;
  for (const review of cohort) {
    if (!object(review)) return null;
    if (review.state === "PENDING") {
      if (review.submitted_at != null || (review.user != null && !bind(review.user))) return null;
      continue;
    }
    const at = readTime(review.submitted_at);
    const who = bind(review.user);
    if (
      !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(String(review.state)) ||
      !at ||
      at < created ||
      at > observedAt ||
      !who ||
      typeof review.commit_id !== "string" ||
      !/^[a-f0-9]{40}$/.test(review.commit_id)
    )
      return null;
    if (review.id === current.id) {
      if (
        review.state !== current.state ||
        review.submitted_at !== current.submitted_at ||
        review.commit_id !== current.commit_id ||
        review.node_id !== current.node_id ||
        who.id !== reviewer.id
      )
        return null;
      currentMatched = true;
    }
    if (who.kind === "user" && who.id !== author.id && (earliest === null || at < earliest)) earliest = at;
  }
  return currentMatched && earliest === submitted ? submitted : null;
}
