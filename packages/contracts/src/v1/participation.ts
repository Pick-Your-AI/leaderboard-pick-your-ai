import { z } from "zod";
import { compareSourceInstants } from "./source-time.js";

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const count = z.number().int().min(0).max(10000);
const time = z.string().datetime({ offset: true });

/** Calendar weeks intersecting a bounded half-open UTC window. All-time has no denominator. */
export function participationWeekDenominator(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const from = Date.parse(start),
    to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || compareSourceInstants(start, end) >= 0)
    throw new Error("Invalid participation window");
  const monday = 4 * 86400000,
    week = 7 * 86400000;
  const last = Math.floor((to - monday) / week);
  const exclusiveBoundary = compareSourceInstants(end, new Date(last * week + monday).toISOString()) === 0;
  return last - Number(exclusiveBoundary) - Math.floor((from - monday) / week) + 1;
}

const metric = z
  .object({
    metricId: identifier,
    state: z.enum(["measured", "partial", "unknown"]),
    activeWeeks: count.nullable(),
    datedEvidenceCount: count,
    unknownDateEvidenceCount: count,
    earliestDatedEvidence: z
      .object({
        contributionId: identifier,
        effectiveAt: time,
        observedAt: time.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** This extension describes permitted metric receipts, never employment tenure or a ranking. */
export const publicParticipationSchema = z
  .object({
    schemaVersion: z.literal("leaderboard-activity-summary/v1"),
    basis: z.literal("public_metric_evidence"),
    timezone: z.literal("UTC"),
    weekStartsOn: z.literal("monday"),
    denominatorWeeks: z.number().int().min(1).max(1000000).nullable(),
    history: z
      .object({
        state: z.literal("unavailable"),
        reason: z.literal("reviewed_organization_history_unavailable"),
        newcomer: z.null(),
      })
      .strict(),
    ranked: z.literal(false),
    metrics: z.array(metric).max(98),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.metrics.map((entry) => entry.metricId)).size !== value.metrics.length)
      ctx.addIssue({ code: "custom", message: "Duplicate participation metric" });
    for (const entry of value.metrics) {
      if (
        (entry.datedEvidenceCount === 0) !== (entry.earliestDatedEvidence === null) ||
        (entry.state === "unknown") !== (entry.activeWeeks === null) ||
        (entry.activeWeeks !== null &&
          (entry.activeWeeks > entry.datedEvidenceCount ||
            (entry.datedEvidenceCount > 0 && entry.activeWeeks === 0) ||
            (value.denominatorWeeks !== null && entry.activeWeeks > value.denominatorWeeks))) ||
        (entry.state === "measured" && entry.unknownDateEvidenceCount !== 0)
      )
        ctx.addIssue({ code: "custom", message: "Inconsistent participation evidence" });
    }
  });
export type PublicParticipation = z.infer<typeof publicParticipationSchema>;
