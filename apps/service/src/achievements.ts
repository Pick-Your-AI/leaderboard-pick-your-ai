import type { PortfolioEvidence, PublicRead } from "./public-source.js";

export const ACHIEVEMENT_RULE_VERSION = "accepted-evidence/v1";
/** Candidate rules are activated only by an explicit reviewed service policy. */
export function acceptedAchievements(read: PublicRead, actorId: string) {
  if (!read.selected.actors.some((entry) => entry.actorId === actorId && entry.actor.kind === "user")) return [];
  const entries = (read.selected.portfolioEvidence ?? [])
    .filter(
      (entry) =>
        entry.contribution.actorId === actorId &&
        entry.activityState === "accepted" &&
        entry.contribution.qualification === "eligible" &&
        entry.occurredAt !== null &&
        !entry.contribution.roles.includes("unknown") &&
        !entry.contribution.roles.includes("automation"),
    )
    .sort(
      (a, b) =>
        a.occurredAt!.localeCompare(b.occurredAt!) ||
        a.contribution.contributionId.localeCompare(b.contribution.contributionId),
    );
  const award = (id: string, label: string, evidence: PortfolioEvidence | undefined) =>
    evidence
      ? [
          {
            id,
            label,
            ruleVersion: ACHIEVEMENT_RULE_VERSION,
            dateBasis: "proven_source_occurrence_in_selected_scope",
            scopeMeaning:
              "Earliest available accepted evidence in this snapshot and scope; not a claim of first-ever activity.",
            occurredAt: evidence.occurredAt,
            evidenceIds: [evidence.contribution.contributionId],
            artifactIds: [evidence.artifact.stableId],
            sourceUrls: [evidence.artifact.publicUrl],
            sharedCredit: evidence.contribution.roles.includes("coauthor"),
          },
        ]
      : [];
  return [
    ...award("first-accepted-in-scope", "First accepted contribution in available scope", entries[0]),
    ...award(
      "first-review-in-scope",
      "First accepted review in available scope",
      entries.find((entry) => entry.contribution.roles.includes("reviewer")),
    ),
  ];
}
