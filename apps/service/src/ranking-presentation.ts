import { rankingPresentationSchema, type RankingPresentation } from "@pick-your-ai/contracts";
import type { PublicRead } from "./public-source.js";

/** Call only after projectRead and actor filtering, on the full unpaginated read.
 * That boundary validates unique actor/metric rows and finite contract values.
 * Missing retained policy is legacy/unknown, never an implicit current policy.
 */
export function rankingPresentation(read: PublicRead, metricId: string): RankingPresentation | null {
  const policy = read.selected.rankingPresentationPolicy;
  if (policy === undefined) return null;
  const rows = read.selected.rows.filter((row) => row.result.metricId === metricId);
  const enabled = read.selected.ranking.find((entry) => entry.metricId === metricId)?.rank === true;
  // Reuse the existing approved ranking's numeric admission: measured, zero and
  // partial values. Unknown-valued rows are unrankable, not unknown enumeration.
  // This is not a new historical source-coverage or collection-completeness gate.
  const comparableContributors = enabled ? rows.filter(({ result }) => result.value !== undefined).length : 0;
  return rankingPresentationSchema.parse({
    ...policy,
    snapshotId: read.selected.snapshot.snapshotId,
    metricId,
    enumeration: "complete",
    totalContributors: rows.length,
    comparableContributors,
    unrankableContributors: rows.length - comparableContributors,
    state: !enabled
      ? "not_ranked"
      : comparableContributors < policy.minimumComparableContributors
        ? "small_cohort"
        : "ranked",
  });
}
