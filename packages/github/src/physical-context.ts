import {
  githubPhysicalContextReceiptSchema,
  physicalClassifierVersion,
  physicalContextVersion,
  physicalFileClasses,
  type GithubPhysicalContextReceipt,
  type PhysicalSummary,
} from "@pick-your-ai/contracts";
import type { ClassifiedPhysicalDiff } from "./physical-diff.js";
import type { NormalizedGithubFact } from "./normalizers.js";

const emptyTotals = () => ({ files: 0, additions: 0, deletions: 0 });

/** Consume the existing classifier result without reclassifying paths or changing facts. */
export function physicalContextReceipt(input: {
  repositoryId: string;
  artifactId: string;
  actorId: string;
  canonicalIntegrationId: string;
  before: string;
  after: string;
  targetBranch: string;
  integratedAt: string;
  diff: ClassifiedPhysicalDiff;
  facts: readonly NormalizedGithubFact[];
}): GithubPhysicalContextReceipt | undefined {
  if (!input.diff.complete) return undefined;
  const summary: PhysicalSummary = {
    raw: emptyTotals(),
    eligible: emptyTotals(),
    formattingOnly: emptyTotals(),
    classes: Object.fromEntries(
      physicalFileClasses.map((kind) => [kind, { raw: emptyTotals(), eligible: emptyTotals() }]),
    ) as PhysicalSummary["classes"],
  };
  const add = (totals: ReturnType<typeof emptyTotals>, file: ClassifiedPhysicalDiff["files"][number]) => {
    totals.files++;
    totals.additions += file.additions;
    totals.deletions += file.deletions;
  };
  for (const file of input.diff.files) {
    const bucket = summary.classes[file.classification];
    if (!bucket) return undefined;
    add(summary.raw, file);
    add(bucket.raw, file);
    if (file.eligible) {
      add(summary.eligible, file);
      add(bucket.eligible, file);
    } else if (file.reason === "formatting_only") add(summary.formattingOnly, file);
  }
  if (
    summary.raw.additions !== input.diff.rawAdditions ||
    summary.raw.deletions !== input.diff.rawDeletions ||
    summary.eligible.additions !== input.diff.additions ||
    summary.eligible.deletions !== input.diff.deletions ||
    summary.eligible.files !== input.diff.filesChanged ||
    summary.eligible.additions + summary.eligible.deletions !== input.diff.changed ||
    summary.eligible.additions - summary.eligible.deletions !== input.diff.net
  )
    return undefined;
  if (
    input.facts.some(
      (fact) =>
        fact.repoId !== input.repositoryId ||
        fact.artifactId !== input.artifactId ||
        fact.actorId !== input.actorId ||
        fact.role !== "author" ||
        fact.state !== "observed" ||
        fact.occurredAt !== input.integratedAt ||
        fact.acceptedAt !== null ||
        fact.correctionReceipt !== null ||
        fact.acceptanceReceipt !== null,
    )
  )
    return undefined;
  const parsed = githubPhysicalContextReceiptSchema.safeParse({
    schemaVersion: physicalContextVersion,
    classifierVersion: physicalClassifierVersion,
    sourceKind: "pull_request",
    repositoryId: input.repositoryId,
    artifactId: input.artifactId,
    actorId: input.actorId,
    role: "author",
    canonicalIntegrationId: input.canonicalIntegrationId,
    before: input.before.toLowerCase(),
    after: input.after.toLowerCase(),
    targetBranch: input.targetBranch,
    integratedAt: input.integratedAt,
    facts: input.facts.map((fact) => ({
      factId: fact.id,
      canonicalKey: fact.canonicalKey,
      metricId: fact.metricId,
      quantity: fact.quantity ?? 1,
    })),
    summary,
  });
  return parsed.success ? parsed.data : undefined;
}
