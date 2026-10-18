import type { PortfolioEvidence, PublicRead } from "./public-source.js";

export const ACHIEVEMENT_RULE_VERSION = "accepted-evidence/v1";
/** The source contract permits sub-millisecond fractions; Date.parse alone loses them. */
function compareInstants(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const leftFraction = left.match(/\.(\d+)/)?.[1] ?? "";
  const rightFraction = right.match(/\.(\d+)/)?.[1] ?? "";
  const precision = Math.max(leftFraction.length, rightFraction.length);
  const a = leftFraction.padEnd(precision, "0");
  const b = rightFraction.padEnd(precision, "0");
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Candidate rules are activated only by an explicit reviewed service policy. */
export function acceptedAchievements(read: PublicRead, actorId: string) {
  if (
    !read.selected.actors.some(
      (entry) => entry.actorId === actorId && entry.actor.kind === "user" && entry.actor.executionMode !== "automated",
    )
  )
    return [];
  const { scope, snapshot } = read.selected;
  const through = scope.end ?? snapshot.generatedAt;
  if (
    !snapshot.coverage.length ||
    snapshot.coverage.some(
      (coverage) =>
        coverage.state !== "complete" ||
        coverage.missingPages !== 0 ||
        coverage.permissionsMissing.length > 0 ||
        coverage.sourceErrors.length > 0 ||
        !coverage.windowStart ||
        !coverage.windowEnd ||
        !coverage.sourceWatermark ||
        !(compareInstants(coverage.windowEnd, through) >= 0) ||
        !(compareInstants(coverage.sourceWatermark, through) >= 0) ||
        (scope.start
          ? !(compareInstants(coverage.windowStart, scope.start) <= 0)
          : !coverage.knownStart || !(compareInstants(coverage.windowStart, coverage.knownStart) <= 0)),
    )
  )
    return [];
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
        compareInstants(a.occurredAt!, b.occurredAt!) ||
        (a.contribution.contributionId < b.contribution.contributionId
          ? -1
          : a.contribution.contributionId > b.contribution.contributionId
            ? 1
            : 0),
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
