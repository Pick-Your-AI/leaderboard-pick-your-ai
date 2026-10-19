import { z } from "zod";
import { achievementProofSchema } from "./achievements.js";
import { sourceAdapterSchema, sourceEventSchema, contributionRoleSchema } from "./schemas.js";
import { compareSourceInstants } from "./source-time.js";

export const participationHistoryVersion = "accepted-organization-history/v1" as const;
export const participationHistoryResponseByteLimit = 1_500_000;
const id = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,200}$/)
  .refine((value) => value !== "." && value !== "..");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = sourceEventSchema.shape.observedAt;
const source = sourceAdapterSchema.exclude(["unknown"]);
const role = contributionRoleSchema.exclude(["unknown", "automation"]);
const pair = z.object({ repositoryId: id, source }).strict();
const policy = z
  .object({
    metricId: id,
    version: id,
    signature: hash,
    roles: z
      .array(role)
      .min(1)
      .max(8)
      .refine((values) => new Set(values).size === values.length),
    sources: z
      .array(source)
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

/** These are public descriptions of a provider's admitted basis, not authentication receipts. */
export const participationHistoryBasisSchema = z
  .object({
    scope: z
      .object({ organization: id, repository: z.null(), workstream: z.null(), start: z.null(), end: z.null() })
      .strict(),
    origin: time,
    cutoff: time,
    sourceInventory: z.array(pair).min(1).max(500),
    policies: z.array(policy).min(1).max(98),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (compareSourceInstants(value.origin, value.cutoff) >= 0)
      ctx.addIssue({ code: "custom", message: "A history basis requires origin before the observation cutoff" });
    if (
      new Set(value.sourceInventory.map((entry) => JSON.stringify([entry.repositoryId, entry.source]))).size !==
      value.sourceInventory.length
    )
      ctx.addIssue({ code: "custom", message: "Required source pairs must be unique" });
    if (new Set(value.policies.map((entry) => entry.metricId)).size !== value.policies.length)
      ctx.addIssue({ code: "custom", message: "Qualifying metric policies must be unique" });
    if (
      value.policies.some((entry) =>
        entry.sources.some((adapter) => !value.sourceInventory.some((pair) => pair.source === adapter)),
      )
    )
      ctx.addIssue({ code: "custom", message: "Every qualifying source must belong to the required inventory" });
  });
export type ParticipationHistoryBasis = z.infer<typeof participationHistoryBasisSchema>;

export const participationHistoryUnknownReasonSchema = z.enum([
  "reviewed_history_unavailable",
  "history_incomplete",
  "history_evidence_unavailable",
  "qualifying_policy_unavailable",
  "qualifying_actor_unavailable",
  "no_qualifying_evidence",
]);
export type ParticipationHistoryUnknownReason = z.infer<typeof participationHistoryUnknownReasonSchema>;

const first = z.object({ proof: achievementProofSchema, observedAt: time, source }).strict();
const known = z
  .object({
    schemaVersion: z.literal("leaderboard-participation-history/v1"),
    ruleVersion: z.literal(participationHistoryVersion),
    dateBasis: z.literal("accepted_source_occurrence"),
    ranked: z.literal(false),
    state: z.literal("known"),
    reason: z.null(),
    historyKey: hash,
    basis: participationHistoryBasisSchema,
    firstProof: first,
    newcomer: z.boolean().nullable(),
    periodReason: z.enum(["unbounded_selection", "history_cutoff_before_selection_end"]).nullable(),
  })
  .strict();
const unknown = z
  .object({
    schemaVersion: z.literal("leaderboard-participation-history/v1"),
    ruleVersion: z.literal(participationHistoryVersion),
    dateBasis: z.literal("accepted_source_occurrence"),
    ranked: z.literal(false),
    state: z.literal("unknown"),
    reason: participationHistoryUnknownReasonSchema,
    historyKey: z.null(),
    basis: z.null(),
    firstProof: z.null(),
    newcomer: z.null(),
    periodReason: z.null(),
  })
  .strict();

export const publicParticipationHistorySchema = z
  .discriminatedUnion("state", [known, unknown])
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > participationHistoryResponseByteLimit)
      ctx.addIssue({ code: "custom", message: "Participation history exceeds its complete response budget" });
    if (value.state !== "known") return;
    const { proof, observedAt, source: adapter } = value.firstProof;
    if (
      compareSourceInstants(proof.occurredAt, value.basis.origin) < 0 ||
      compareSourceInstants(proof.occurredAt, observedAt) > 0 ||
      compareSourceInstants(observedAt, value.basis.cutoff) > 0 ||
      !value.basis.sourceInventory.some(
        (pair) => pair.repositoryId === proof.repositoryId && pair.source === adapter,
      ) ||
      !value.basis.policies.some(
        (policy) =>
          proof.metricIds.includes(policy.metricId) &&
          policy.sources.includes(adapter) &&
          policy.roles.some((role) => proof.roles.includes(role)),
      ) ||
      (value.newcomer === null) !== (value.periodReason !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "First proof must match its complete admitted basis and period assessment",
      });
  });
export type PublicParticipationHistory = z.infer<typeof publicParticipationHistorySchema>;

/** A future selected end or an all-time lens has no completed-period newcomer Boolean. */
export function participationHistoryPeriod(start: string | null, end: string | null, cutoff: string, first: string) {
  if (start === null || end === null) return { newcomer: null, periodReason: "unbounded_selection" as const };
  if (compareSourceInstants(end, cutoff) > 0)
    return { newcomer: null, periodReason: "history_cutoff_before_selection_end" as const };
  return {
    newcomer: compareSourceInstants(first, start) >= 0 && compareSourceInstants(first, end) < 0,
    periodReason: null,
  };
}
