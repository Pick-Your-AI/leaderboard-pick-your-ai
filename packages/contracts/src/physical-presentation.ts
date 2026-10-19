import { z } from "zod";
import {
  githubPhysicalContextReceiptSchema,
  physicalClassifierVersion,
  physicalMetricIds,
  physicalSummarySchema,
} from "./physical-context.js";
import { publicArtifactIdSchema } from "./artifact-identity.js";
import { compareSourceInstants } from "./v1/source-time.js";

export const publicPhysicalContextVersion = "physical-context/v1" as const;
/** A context is complete or unavailable; this budget never truncates samples. */
export const physicalContextLimits = Object.freeze({
  units: 10_000,
  bytes: 128 * 1024,
});
const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const actorId = z.string().regex(/^[1-9]\d{0,19}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const factId = z.string().regex(/^gh:[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const count = z.number().int().min(1).max(physicalContextLimits.units);
const uniqueFacts = z
  .array(factId)
  .min(1)
  .max(physicalContextLimits.units)
  .refine((ids) => new Set(ids).size === ids.length);
const common = z
  .object({
    schemaVersion: z.literal(publicPhysicalContextVersion),
    actorId,
    metricId: z.enum(physicalMetricIds),
    policyVersion: identity,
    policySignature: hash,
  })
  .strict();
export const physicalContextUnknownReasonSchema = z.enum([
  "retained_context_unavailable",
  "selected_units_unbound",
  "current_context_unavailable",
  "context_budget_exceeded",
]);
const unknown = common
  .extend({
    state: z.literal("unknown"),
    reason: physicalContextUnknownReasonSchema,
  })
  .strict();

/** Provider-private inputs. The ordinary public projector never serializes these. */
export const physicalSnapshotContextSchema = z.discriminatedUnion("state", [
  unknown,
  common
    .extend({
      state: z.literal("available"),
      samples: z
        .array(
          z
            .object({
              receipt: githubPhysicalContextReceiptSchema,
              mergedEvidenceId: factId,
            })
            .strict(),
        )
        .min(1)
        .max(physicalContextLimits.units),
    })
    .strict(),
]);

const sample = z
  .object({
    sampleId: hash,
    repositoryId: actorId,
    artifactId: publicArtifactIdSchema,
    sourceUrl: z
      .string()
      .max(2048)
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/),
    before: revision,
    after: revision,
    beforeUrl: z.string().max(2048),
    afterUrl: z.string().max(2048),
    integratedAt: z.string().datetime({ offset: true }),
    evidenceIds: uniqueFacts,
  })
  .strict()
  .superRefine((value, ctx) => {
    const base = value.sourceUrl.replace(/\/pull\/[1-9]\d*$/, "/commit/");
    if (
      value.before === value.after ||
      value.beforeUrl !== base + value.before ||
      value.afterUrl !== base + value.after
    )
      ctx.addIssue({
        code: "custom",
        message: "Physical sample links must identify the exact distinct revision pair",
      });
  });
const available = common
  .extend({
    snapshotId: identity,
    state: z.literal("available"),
    classifierVersion: z.literal(physicalClassifierVersion),
    unitCount: count,
    sampleCount: count,
    summary: physicalSummarySchema,
    samples: z.array(sample).min(1).max(physicalContextLimits.units),
  })
  .strict();
export const publicPhysicalContextSchema = z
  .discriminatedUnion("state", [unknown.extend({ snapshotId: identity }).strict(), available])
  .superRefine((value, ctx) => {
    if (value.state !== "available") return;
    const ids = value.samples.flatMap((entry) => entry.evidenceIds);
    if (
      value.sampleCount !== value.samples.length ||
      new Set(value.samples.map((entry) => entry.sampleId)).size !== value.sampleCount ||
      new Set(
        value.samples.map((entry) => JSON.stringify([entry.repositoryId, entry.artifactId, entry.before, entry.after])),
      ).size !== value.sampleCount ||
      value.unitCount !== ids.length ||
      new Set(ids).size !== ids.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Physical context must cover unique, complete selected units and integration samples",
      });
  });

export type PhysicalSnapshotContext = z.infer<typeof physicalSnapshotContextSchema>;
export type PublicPhysicalContext = z.infer<typeof publicPhysicalContextSchema>;
export type PhysicalContextUnknownReason = z.infer<typeof physicalContextUnknownReasonSchema>;

export function physicalMetricTotal(
  metricId: (typeof physicalMetricIds)[number],
  summary: z.infer<typeof physicalSummarySchema>,
): number {
  if (metricId === "pr_lines_added") return summary.eligible.additions;
  if (metricId === "pr_lines_removed") return summary.eligible.deletions;
  if (metricId === "pr_lines_changed") return summary.eligible.additions + summary.eligible.deletions;
  return summary.eligible.files;
}

/** Response binding only, not source truth or approval. Callers first validate
 * the selected row, current source/privacy projection and exact response scope.
 */
export function bindPublicPhysicalContext(
  input: unknown,
  binding: {
    snapshotId: string;
    actorId: string;
    metricId: string;
    evidenceIds: readonly string[];
    value: number | undefined;
    generatedAt: string;
    start: string | null;
    end: string | null;
    methodology: readonly {
      metricId: string;
      policyVersion: string;
      policySignature: string;
    }[];
  },
): PublicPhysicalContext {
  const context = publicPhysicalContextSchema.parse(input);
  const method = binding.methodology.filter((entry) => entry.metricId === binding.metricId);
  const fail = () => {
    throw new Error("invalid_public_physical_context");
  };
  if (
    context.snapshotId !== binding.snapshotId ||
    context.actorId !== binding.actorId ||
    context.metricId !== binding.metricId ||
    method.length !== 1 ||
    context.policyVersion !== method[0]?.policyVersion ||
    context.policySignature !== method[0]?.policySignature
  )
    return fail();
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > physicalContextLimits.bytes) return fail();
  if (context.state === "unknown") return context;
  const ids = context.samples.flatMap((entry) => entry.evidenceIds).sort();
  if (
    context.unitCount !== binding.evidenceIds.length ||
    JSON.stringify(ids) !== JSON.stringify([...binding.evidenceIds].sort()) ||
    (binding.value !== undefined && physicalMetricTotal(context.metricId, context.summary) !== binding.value)
  )
    return fail();
  for (const item of context.samples)
    if (
      compareSourceInstants(item.integratedAt, binding.generatedAt) > 0 ||
      (binding.start !== null && compareSourceInstants(item.integratedAt, binding.start) < 0) ||
      (binding.end !== null && compareSourceInstants(item.integratedAt, binding.end) >= 0)
    )
      return fail();
  return context;
}
