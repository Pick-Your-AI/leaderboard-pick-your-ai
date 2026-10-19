import {
  achievementMilestoneVersion,
  achievementScopeMeaning,
  coContributionMeaning,
  achievementProofSchema,
  compareSourceInstants,
  type AchievementProof,
  type AchievementMilestone,
  type CoContribution,
  type MetricDefinition,
} from "@pick-your-ai/contracts";
import { PublicReadError, type PortfolioEvidence, type PublicRead } from "./public-source.js";
import { acceptedAchievements } from "./achievements.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const conflict = (): never => {
  throw new PublicReadError(503, "achievement_evidence_conflict");
};
const author = (proof: AchievementProof) => proof.roles.some((role) => role === "author" || role === "coauthor");

/** Must receive projectRead/filterPublicActors output: no frozen private facts are read here. */
export function acceptedMilestones(
  read: PublicRead,
  actorId: string,
  category: string | null,
  definitions: readonly MetricDefinition[],
) {
  const actors = new Map(
    read.selected.actors
      .filter((entry) => entry.actor.kind === "user" && entry.actor.executionMode !== "automated")
      .map((entry) => [entry.actorId, entry.actor]),
  );
  const aliases = new Map<string, string>();
  for (const [id, actor] of actors) {
    const keys = [
      ...(actor.githubNodeId ? ["node:" + actor.githubNodeId] : []),
      ...(actor.githubDatabaseId !== undefined ? ["database:" + actor.githubDatabaseId] : []),
    ];
    for (const key of keys) {
      if (aliases.has(key) && aliases.get(key) !== id) conflict();
      aliases.set(key, id);
    }
  }
  const categories = new Set(definitions.map((entry) => entry.id));
  const artifactIdentities = new Map<string, string>();
  const canonicalTimes = new Map<string, string>();
  const entries: PortfolioEvidence[] = [];
  const proofs = new Map<string, AchievementProof>();
  const pendingIds = new Set((read.selected.pendingEvidence ?? []).map((entry) => entry.contribution.contributionId));
  // Validate all visible accepted copies before actor/category shortcuts. A later conflicting
  // representation cannot disappear just because the first copy already provided an award.
  for (const entry of read.selected.portfolioEvidence ?? []) {
    if (
      entry.activityState !== "accepted" ||
      entry.contribution.qualification !== "eligible" ||
      entry.occurredAt === null ||
      entry.contribution.roles.some((role) => role === "unknown" || role === "automation")
    )
      continue;
    // The evidence route prefers an explicitly pending copy. An accepted award
    // must not link to a contradictory pending representation of the same proof.
    if (pendingIds.has(entry.contribution.contributionId)) conflict();
    const proof = achievementProofSchema.parse({
      contributionId: entry.contribution.contributionId,
      canonicalEventId: entry.contribution.canonicalEventId,
      actorId: entry.contribution.actorId,
      artifactId: entry.artifact.stableId,
      artifactKind: entry.artifact.kind,
      repositoryId: entry.artifact.repositoryId ?? null,
      sourceUrl: entry.artifact.publicUrl,
      roles: [...new Set(entry.contribution.roles)].sort(),
      metricIds: [...new Set(entry.contribution.metricIds)].sort(),
      occurredAt: entry.occurredAt,
      activityState: "accepted",
      qualification: "eligible",
    });
    if (
      proof.metricIds.some((id) => !categories.has(id)) ||
      compareSourceInstants(proof.occurredAt, read.selected.snapshot.generatedAt) > 0
    )
      conflict();
    const identity = JSON.stringify([proof.artifactKind, proof.repositoryId, proof.sourceUrl]);
    if (artifactIdentities.has(proof.artifactId) && artifactIdentities.get(proof.artifactId) !== identity) conflict();
    artifactIdentities.set(proof.artifactId, identity);
    const key = JSON.stringify([proof.canonicalEventId, proof.actorId, proof.artifactId]);
    if (canonicalTimes.has(key) && compareSourceInstants(canonicalTimes.get(key)!, proof.occurredAt) !== 0) conflict();
    canonicalTimes.set(key, proof.occurredAt);
    if (!actors.has(proof.actorId) || (category !== null && !proof.metricIds.includes(category))) continue;
    entries.push(entry);
    proofs.set(proof.contributionId, proof);
  }
  entries.sort(
    (a, b) =>
      compareSourceInstants(a.occurredAt!, b.occurredAt!) ||
      compare(a.contribution.contributionId, b.contribution.contributionId),
  );
  const scopedRead = { ...read, selected: { ...read.selected, portfolioEvidence: entries } };
  const existing = acceptedAchievements(scopedRead, actorId);
  const achievements: AchievementMilestone[] = [];
  const add = (
    id: string,
    label: AchievementMilestone["label"],
    proof: AchievementProof,
    categoryId: string | null,
  ) => {
    achievements.push({
      id,
      label,
      categoryId,
      ruleVersion: achievementMilestoneVersion,
      dateBasis: "proven_source_occurrence_in_selected_scope",
      scopeMeaning: achievementScopeMeaning,
      occurredAt: proof.occurredAt,
      evidenceIds: [proof.contributionId],
      artifactIds: [proof.artifactId],
      sourceUrls: [proof.sourceUrl],
      sharedCredit: proof.roles.includes("coauthor"),
      proof,
    });
  };
  // Reuse every v1 history/coverage gate, with the additional v2 snapshot-cutoff check.
  if (
    existing.length &&
    (read.selected.scope.end === null ||
      compareSourceInstants(read.selected.snapshot.generatedAt, read.selected.scope.end) >= 0)
  ) {
    for (const award of existing)
      add(award.id, award.label as AchievementMilestone["label"], proofs.get(award.evidenceIds[0]!)!, null);
    const firstByCategory = new Map<string, AchievementProof>();
    for (const entry of entries) {
      const proof = proofs.get(entry.contribution.contributionId)!;
      if (proof.actorId !== actorId) continue;
      for (const metricId of proof.metricIds) {
        if ((category === null || metricId === category) && !firstByCategory.has(metricId))
          firstByCategory.set(metricId, proof);
      }
    }
    for (const [id, proof] of [...firstByCategory].sort(([a], [b]) => compare(a, b)))
      add("first-category-in-scope:" + id, "First accepted contribution in category", proof, id);
  }
  const artifacts = new Map<string, Map<string, { authored?: AchievementProof; reviewed?: AchievementProof }>>();
  for (const entry of entries) {
    const proof = proofs.get(entry.contribution.contributionId)!;
    if (proof.artifactKind === "unknown") continue;
    const people = artifacts.get(proof.artifactId) ?? new Map();
    const person = people.get(proof.actorId) ?? {};
    if (author(proof)) person.authored ??= proof;
    if (proof.roles.includes("reviewer")) person.reviewed ??= proof;
    people.set(proof.actorId, person);
    artifacts.set(proof.artifactId, people);
  }
  const coContributions: CoContribution[] = [];
  for (const [, people] of [...artifacts].sort(([a], [b]) => compare(a, b))) {
    const subject = people.get(actorId);
    if (!subject) continue;
    for (const [peerId, other] of [...people].sort(([a], [b]) => compare(a, b))) {
      if (peerId === actorId) continue;
      const pair =
        subject.authored && other.authored
          ? {
              relationship: "shared_authorship" as const,
              subject: subject.authored,
              peerProof: other.authored,
            }
          : subject.authored && other.reviewed
            ? {
                relationship: "author_review_pair" as const,
                subject: subject.authored,
                peerProof: other.reviewed,
              }
            : subject.reviewed && other.authored
              ? {
                  relationship: "author_review_pair" as const,
                  subject: subject.reviewed,
                  peerProof: other.authored,
                }
              : null;
      if (!pair) continue;
      const actor = actors.get(peerId)!;
      coContributions.push({
        ...pair,
        peer: { actorId: peerId, login: actor.login ?? null, displayName: actor.displayName ?? null },
      });
    }
  }
  return { ruleVersion: achievementMilestoneVersion, category, achievements, coContributionMeaning, coContributions };
}
