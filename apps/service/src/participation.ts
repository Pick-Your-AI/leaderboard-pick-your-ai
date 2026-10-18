import {
  compareSourceInstants,
  participationWeekDenominator,
  publicParticipationSchema,
} from "@pick-your-ai/contracts";
import type { PublicRead } from "./public-source.js";

/** Call only after projectRead and actor filtering. This never reads private frozen inputs. */
export function publicParticipation(read: PublicRead, actorId: string, category: string | null) {
  const { scope } = read.selected;
  const evidence = new Map(read.selected.evidence.map((entry) => [entry.contribution.contributionId, entry]));
  const metrics = read.selected.rows
    .filter(
      (row) =>
        row.actorId === actorId &&
        (category === null || row.result.metricId === category) &&
        // Decision ratios and readiness durations remain separate, sample-qualified diagnostics.
        !["pr_accepted_rate", "review_wait"].includes(row.result.metricId),
    )
    .map((row) => {
      const entries = row.evidenceIds.map((id) => evidence.get(id)!).filter(Boolean);
      const dated = entries
        .filter((entry) => entry.occurredAt !== null)
        .sort(
          (a, b) =>
            compareSourceInstants(a.occurredAt!, b.occurredAt!) ||
            (a.contribution.contributionId < b.contribution.contributionId ? -1 : 1),
        );
      const coverage = row.result.coverage;
      const complete =
        scope.start !== null &&
        scope.end !== null &&
        coverage.state === "complete" &&
        coverage.knownStart !== null &&
        compareSourceInstants(coverage.knownStart, scope.start) <= 0 &&
        coverage.windowStart !== null &&
        compareSourceInstants(coverage.windowStart, scope.start) <= 0 &&
        coverage.windowEnd !== null &&
        compareSourceInstants(coverage.windowEnd, scope.end) >= 0 &&
        coverage.missingPages === 0 &&
        coverage.permissionsMissing.length === 0 &&
        coverage.sourceErrors.length === 0;
      const unknownDates = entries.length - dated.length;
      const state =
        dated.length === 0
          ? complete && entries.length === 0 && row.result.value === 0
            ? "measured"
            : "unknown"
          : complete && unknownDates === 0
            ? "measured"
            : "partial";
      const first = dated[0];
      return {
        metricId: row.result.metricId,
        state,
        activeWeeks:
          state === "unknown"
            ? null
            : new Set(dated.map((entry) => Math.floor((Date.parse(entry.occurredAt!) - 4 * 86400000) / (7 * 86400000))))
                .size,
        datedEvidenceCount: dated.length,
        unknownDateEvidenceCount: unknownDates,
        earliestDatedEvidence: first
          ? {
              contributionId: first.contribution.contributionId,
              effectiveAt: first.occurredAt!,
              observedAt: first.evidenceMetadata?.observedAt ?? null,
            }
          : null,
      };
    });
  return publicParticipationSchema.parse({
    schemaVersion: "leaderboard-activity-summary/v1",
    basis: "public_metric_evidence",
    timezone: "UTC",
    weekStartsOn: "monday",
    denominatorWeeks: participationWeekDenominator(scope.start, scope.end),
    history: { state: "unavailable", reason: "reviewed_organization_history_unavailable", newcomer: null },
    ranked: false,
    metrics,
  });
}
