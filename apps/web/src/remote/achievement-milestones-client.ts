import {
  achievementMilestonesPageSchema,
  compareSourceInstants,
  canonicalPublicScope,
  publicScopeKey,
  type AchievementProof,
  type PublicScope,
} from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { metadata, ReadFailure, type Selection } from "./client.ts";

const fail = (): never => {
  throw new ReadFailure(502, "invalid_recognition_response");
};

/** Structural consistency and exact public scope, never authentication of the underlying source. */
export function milestonePage(
  data: Record<string, unknown>,
  meta: ReturnType<typeof metadata>,
  selected: Selection,
  actorId: string,
) {
  const parsed = achievementMilestonesPageSchema.safeParse({
    ruleVersion: data.ruleVersion,
    category: data.category,
    achievements: data.achievements,
    coContributionMeaning: data.coContributionMeaning,
    coContributions: data.coContributions,
    totalCoContributions: data.totalCoContributions,
    pageSize: data.pageSize,
    nextCursor: data.nextCursor,
  });
  if (!parsed.success) return fail();
  const value = parsed.data;
  const requested = selected as Selection & Partial<PublicScope>;
  let scope: PublicScope;
  try {
    scope = canonicalPublicScope(data.scope);
    const expected = canonicalPublicScope({
      organization: selected.organization,
      repository: selected.repository,
      workstream: selected.workstream,
      start: selected.start,
      end: selected.end,
      ...(requested.context !== undefined ? { context: requested.context } : {}),
      ...(requested.projects !== undefined ? { projects: requested.projects } : {}),
      ...(requested.roles !== undefined ? { roles: requested.roles } : {}),
      ...(requested.branch !== undefined ? { branch: requested.branch } : {}),
    });
    if (publicScopeKey(scope) !== publicScopeKey(expected)) fail();
  } catch {
    return fail();
  }
  if (
    value.category !== (selected.category ?? null) ||
    value.pageSize !== Number(selected.limit) ||
    (value.achievements.length > 0 &&
      selected.end !== null &&
      compareSourceInstants(meta.generatedAt, selected.end) < 0)
  )
    fail();
  const known = new Set(metricRegistryV1.metrics.map((metric) => metric.id));
  const disabled = new Set(meta.disabledMetrics.map((metric) => metric.id));
  if (value.category !== null && (!known.has(value.category) || disabled.has(value.category))) fail();
  const identities = new Map<string, string>(),
    artifacts = new Map<string, string>(),
    times = new Map<string, string>();
  const proof = (entry: AchievementProof) => {
    if (
      selected.actors === "automation" ||
      (selected.repository !== null && entry.repositoryId !== selected.repository) ||
      (selected.category !== null && !entry.metricIds.includes(selected.category)) ||
      (scope.roles?.length && !scope.roles.some((role) => entry.roles.includes(role))) ||
      entry.metricIds.some((id) => !known.has(id) || disabled.has(id)) ||
      (selected.start !== null && compareSourceInstants(entry.occurredAt, selected.start) < 0) ||
      (selected.end !== null && compareSourceInstants(entry.occurredAt, selected.end) >= 0) ||
      compareSourceInstants(entry.occurredAt, meta.generatedAt) > 0
    )
      fail();
    const identity = JSON.stringify(entry);
    if (identities.has(entry.contributionId) && identities.get(entry.contributionId) !== identity) fail();
    identities.set(entry.contributionId, identity);
    const artifact = JSON.stringify([entry.artifactKind, entry.repositoryId, entry.sourceUrl]);
    if (artifacts.has(entry.artifactId) && artifacts.get(entry.artifactId) !== artifact) fail();
    artifacts.set(entry.artifactId, artifact);
    const key = JSON.stringify([entry.canonicalEventId, entry.actorId, entry.artifactId]);
    if (times.has(key) && compareSourceInstants(times.get(key)!, entry.occurredAt) !== 0) fail();
    times.set(key, entry.occurredAt);
  };
  for (const award of value.achievements) {
    if (
      award.proof.actorId !== actorId ||
      (award.categoryId !== null &&
        (!known.has(award.categoryId) || (value.category !== null && award.categoryId !== value.category)))
    )
      fail();
    proof(award.proof);
  }
  for (const pair of value.coContributions) {
    if (pair.subject.actorId !== actorId) fail();
    proof(pair.subject);
    proof(pair.peerProof);
  }
  return { ...meta, ...value };
}
