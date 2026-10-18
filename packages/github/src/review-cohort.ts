/** Persisted review evidence must have passed this source-identity validation generation. */
export const reviewSourceNormalizationVersion = "review-source-identity/v1";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const node = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

/** REST response identities must describe the exact requested pull, not its repository alone. */
export function reviewParentMatches(value: unknown, parentUrl: string, pullNumber: string): boolean {
  return (
    object(value) &&
    positive(value.id) &&
    (value.node_id === undefined || node(value.node_id)) &&
    positive(value.number) &&
    String(value.number) === pullNumber &&
    value.html_url === parentUrl
  );
}

/** Every supplied source link is evidence to check; none is a substitute for a mismatched link. */
export function reviewSourceMatches(value: unknown, parentUrl: string, parentApiUrl: string): boolean {
  if (!object(value) || !positive(value.id) || (value.node_id !== undefined && !node(value.node_id))) return false;
  const reviewUrl = `${parentUrl}#pullrequestreview-${value.id}`;
  if (value.html_url !== reviewUrl || (value.pull_request_url !== undefined && value.pull_request_url !== parentApiUrl))
    return false;
  if (value._links !== undefined) {
    if (!object(value._links)) return false;
    for (const [key, expected] of [
      ["html", reviewUrl],
      ["pull_request", parentApiUrl],
    ] as const) {
      const link = value._links[key];
      if (link !== undefined && (!object(link) || link.href !== expected)) return false;
    }
  }
  return true;
}

/** A complete review cohort cannot bind one source actor or review to conflicting native identities. */
export function consistentReviewCohortIdentities(
  cohort: readonly unknown[],
  current: Record<string, unknown>,
  parentUrl: string,
  parentApiUrl: string,
): boolean {
  const reviewIds = new Set<number>();
  const reviewNodes = new Set<string>();
  const actorIds = new Map<number, { nodeId: string | undefined; kind: string }>();
  const actorNodes = new Map<string, number>();
  const bindActor = (value: unknown) => {
    if (!object(value) || !positive(value.id) || !["User", "Bot", "Organization"].includes(String(value.type)))
      return false;
    if (value.node_id !== undefined && !node(value.node_id)) return false;
    const nodeId = value.node_id as string | undefined;
    const kind = value.type as string;
    const previous = actorIds.get(value.id);
    if (
      (previous && (previous.kind !== kind || (previous.nodeId && nodeId && previous.nodeId !== nodeId))) ||
      (nodeId && actorNodes.has(nodeId) && actorNodes.get(nodeId) !== value.id)
    )
      return false;
    actorIds.set(value.id, { nodeId: nodeId ?? previous?.nodeId, kind });
    if (nodeId) actorNodes.set(nodeId, value.id);
    return true;
  };
  if (!bindActor(current.user)) return false;
  return cohort.every((value) => {
    if (!object(value) || !reviewSourceMatches(value, parentUrl, parentApiUrl) || !positive(value.id)) return false;
    if (reviewIds.has(value.id) || (node(value.node_id) && reviewNodes.has(value.node_id))) return false;
    reviewIds.add(value.id);
    if (node(value.node_id)) reviewNodes.add(value.node_id);
    // Pending reviews do not establish a first-submission clock, but a supplied
    // identity must still not conflict with an observed submitted actor.
    return value.state === "PENDING" && value.user == null ? true : bindActor(value.user);
  });
}
