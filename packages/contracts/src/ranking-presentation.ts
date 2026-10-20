import { z } from "zod";

/** A versioned display convention, not source eligibility or a privacy guarantee. */
export const rankingPresentationVersion = "ranking-presentation/v1" as const;
export const rankingPresentationPolicySchema = z
  .object({
    version: z.literal(rankingPresentationVersion),
    minimumComparableContributors: z.literal(5),
    cohort: z.literal("current_public_metric_rows"),
    purpose: z.literal("display_convention"),
  })
  .strict();

export const currentRankingPresentationPolicy = Object.freeze(
  rankingPresentationPolicySchema.parse({
    version: rankingPresentationVersion,
    minimumComparableContributors: 5,
    cohort: "current_public_metric_rows",
    purpose: "display_convention",
  }),
);

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const count = z.number().int().min(0).max(10_000);

/** A successful receipt covers the complete projected cohort before pagination.
 * Missing values do not make enumeration incomplete. Historical source coverage
 * remains separate. Missing policy or unavailable projection supplies no receipt.
 * Consumers additionally bind snapshot, metric, totalRows and ranking descriptor.
 */
export const rankingPresentationSchema = rankingPresentationPolicySchema
  .extend({
    snapshotId: identity,
    metricId: identity,
    enumeration: z.literal("complete"),
    totalContributors: count,
    comparableContributors: count,
    unrankableContributors: count,
    state: z.enum(["ranked", "small_cohort", "not_ranked"]),
  })
  .superRefine((value, ctx) => {
    if (
      value.comparableContributors + value.unrankableContributors !== value.totalContributors ||
      (value.state === "ranked" && value.comparableContributors < value.minimumComparableContributors) ||
      (value.state === "small_cohort" && value.comparableContributors >= value.minimumComparableContributors) ||
      (value.state === "not_ranked" && value.comparableContributors !== 0)
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent ranking presentation cohort" });
  });

export type RankingPresentationPolicy = z.infer<typeof rankingPresentationPolicySchema>;
export type RankingPresentation = z.infer<typeof rankingPresentationSchema>;
