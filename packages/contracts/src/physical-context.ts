import { z } from "zod";

export const physicalContextVersion = "github-physical-context/v1" as const;
export const physicalClassifierVersion = "github-path-classifier/v1" as const;
export const physicalMetricIds = ["pr_lines_added", "pr_lines_removed", "pr_lines_changed", "files_changed"] as const;
export const physicalFileClasses = [
  "source",
  "tests",
  "docs",
  "generated",
  "vendor",
  "lock",
  "binary",
  "imported",
] as const;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const totals = z
  .object({ files: count, additions: count, deletions: count })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !Number.isSafeInteger(value.additions + value.deletions) ||
      (value.files === 0 && (value.additions !== 0 || value.deletions !== 0))
    )
      ctx.addIssue({ code: "custom", message: "Physical totals require safe arithmetic and actual file records" });
  });
const bucket = z
  .object({ raw: totals, eligible: totals })
  .strict()
  .superRefine((value, ctx) => {
    if (
      ["files", "additions", "deletions"].some(
        (key) => value.eligible[key as keyof typeof value.eligible] > value.raw[key as keyof typeof value.raw],
      )
    )
      ctx.addIssue({ code: "custom", message: "Eligible physical counts cannot exceed the examined inventory" });
  });
const classes = z
  .object({
    source: bucket,
    tests: bucket,
    docs: bucket,
    generated: bucket,
    vendor: bucket,
    lock: bucket,
    binary: bucket,
    imported: bucket,
  })
  .strict();

/** A complete classified inventory; source-history coverage is a separate claim. */
export const physicalSummarySchema = z
  .object({
    raw: totals,
    eligible: totals,
    formattingOnly: totals,
    classes,
  })
  .strict()
  .superRefine((value, ctx) => {
    const invalid = () => ctx.addIssue({ code: "custom", message: "Physical classification totals disagree" });
    for (const field of ["files", "additions", "deletions"] as const) {
      const raw = physicalFileClasses.reduce((sum, kind) => sum + value.classes[kind].raw[field], 0);
      const eligible = physicalFileClasses.reduce((sum, kind) => sum + value.classes[kind].eligible[field], 0);
      const formatting = (["source", "tests", "docs"] as const).reduce(
        (sum, kind) => sum + value.classes[kind].raw[field] - value.classes[kind].eligible[field],
        0,
      );
      if (
        ![raw, eligible, formatting].every(Number.isSafeInteger) ||
        raw !== value.raw[field] ||
        eligible !== value.eligible[field] ||
        formatting !== value.formattingOnly[field]
      )
        invalid();
      for (const kind of ["generated", "vendor", "lock", "binary", "imported"] as const)
        if (value.classes[kind].eligible[field] !== 0) invalid();
    }
  });

const githubId = z.string().regex(/^[1-9]\d{0,19}$/);
const factKey = z.string().regex(/^gh:[a-f0-9]{64}$/);
const pinnedRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sourceText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/.test(value));
const factBinding = z
  .object({
    factId: factKey,
    canonicalKey: factKey,
    metricId: z.enum(physicalMetricIds),
    quantity: count,
  })
  .strict();

/** Private normalized evidence, never a public response or a source-authority grant. */
export const githubPhysicalContextReceiptSchema = z
  .object({
    schemaVersion: z.literal(physicalContextVersion),
    classifierVersion: z.literal(physicalClassifierVersion),
    sourceKind: z.literal("pull_request"),
    repositoryId: githubId,
    artifactId: sourceText,
    actorId: githubId,
    role: z.literal("author"),
    canonicalIntegrationId: sourceText,
    before: pinnedRevision,
    after: pinnedRevision,
    targetBranch: sourceText,
    integratedAt: z.string().datetime({ offset: true }),
    facts: z.array(factBinding).min(3).max(10_003),
    summary: physicalSummarySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: "custom", message: "Physical receipt must bind one complete integration" });
    if (
      value.before === value.after ||
      value.summary.raw.files > 10_000 ||
      new Set(value.facts.map((fact) => fact.factId)).size !== value.facts.length ||
      new Set(value.facts.map((fact) => fact.canonicalKey)).size !== value.facts.length
    )
      invalid();
    const expected = {
      pr_lines_added: value.summary.eligible.additions,
      pr_lines_removed: value.summary.eligible.deletions,
      pr_lines_changed: value.summary.eligible.additions + value.summary.eligible.deletions,
    };
    for (const metricId of ["pr_lines_added", "pr_lines_removed", "pr_lines_changed"] as const) {
      const matching = value.facts.filter((fact) => fact.metricId === metricId);
      if (matching.length !== 1 || matching[0]?.quantity !== expected[metricId]) invalid();
    }
    const files = value.facts.filter((fact) => fact.metricId === "files_changed");
    if (files.length !== value.summary.eligible.files || files.some((fact) => fact.quantity !== 1)) invalid();
  });

export type PhysicalSummary = z.infer<typeof physicalSummarySchema>;
export type GithubPhysicalContextReceipt = z.infer<typeof githubPhysicalContextReceiptSchema>;
