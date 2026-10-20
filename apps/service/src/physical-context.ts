import { createHash } from "node:crypto";
import {
  bindPublicPhysicalContext,
  physicalContextLimits,
  physicalFileClasses,
  physicalMetricIds,
  physicalSnapshotContextSchema,
  physicalSummarySchema,
  publicPhysicalContextVersion,
  type PhysicalSnapshotContext,
  type PublicPhysicalContext,
  type PhysicalSummary,
  type Snapshot,
} from "@pick-your-ai/contracts";
import type { PublicEvidence, PublicRow, PublicScope } from "./public-source.js";
import { compareSourceInstants } from "./source-time.js";

type Methodology = { metricId: string; policyVersion: string; policySignature: string };
const equalIds = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Called only after all supplied evidence copies pass global identity checks
 * and every dependency has been projected through current source/privacy scope.
 * Original merge proof is private provenance, never additional metric credit.
 */
export function projectPhysicalContext({
  candidate,
  row,
  evidence,
  dependencies,
  snapshot,
  scope,
  methodology,
}: {
  candidate: PhysicalSnapshotContext | undefined;
  row: PublicRow;
  evidence: ReadonlyMap<string, PublicEvidence>;
  dependencies: ReadonlyMap<string, PublicEvidence>;
  snapshot: Snapshot;
  scope: PublicScope;
  methodology: readonly Methodology[];
}): PublicPhysicalContext | undefined {
  if (!physicalMetricIds.some((id) => id === row.result.metricId)) return undefined;
  const method = methodology.filter((entry) => entry.metricId === row.result.metricId);
  // Legacy inputs can lack methodology. Do not invent a policy binding for them.
  if (method.length !== 1) return undefined;
  const common = {
    schemaVersion: publicPhysicalContextVersion,
    snapshotId: snapshot.snapshotId,
    actorId: row.actorId,
    metricId: row.result.metricId as (typeof physicalMetricIds)[number],
    policyVersion: method[0]!.policyVersion,
    policySignature: method[0]!.policySignature,
  };
  const unknown = (
    reason: "retained_context_unavailable" | "current_context_unavailable" | "context_budget_exceeded",
  ) => ({ ...common, state: "unknown", reason }) as const;
  if (candidate === undefined) return unknown("retained_context_unavailable");
  const parsed = physicalSnapshotContextSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.actorId !== common.actorId ||
    parsed.data.metricId !== common.metricId ||
    parsed.data.policyVersion !== common.policyVersion ||
    parsed.data.policySignature !== common.policySignature ||
    parsed.data.state === "unknown"
  )
    return unknown("current_context_unavailable");
  // Complete dependency checks precede every public count, revision and budget
  // reason. An unavailable copy cannot turn into a smaller surviving subtotal.
  const admitted = [];
  for (const item of parsed.data.samples) {
    const receipt = item.receipt;
    const merged = dependencies.get(item.mergedEvidenceId);
    const facts = receipt.facts.filter((fact) => fact.metricId === common.metricId);
    if (
      receipt.actorId !== row.actorId ||
      !merged ||
      merged.contribution.actorId !== receipt.actorId ||
      merged.contribution.artifactId !== receipt.artifactId ||
      merged.artifact.stableId !== receipt.artifactId ||
      merged.artifact.repositoryId !== receipt.repositoryId ||
      merged.artifact.kind !== "pull_request" ||
      merged.contribution.metricIds.length !== 1 ||
      merged.contribution.metricIds[0] !== "pr_merged" ||
      merged.contribution.roles.length !== 1 ||
      merged.contribution.roles[0] !== "author" ||
      merged.sourceRevision?.toLowerCase() !== receipt.after ||
      merged.sourceRevisionUrl !==
        merged.artifact.publicUrl?.replace(/\/pull\/[1-9]\d*$/, "/commit/") + merged.sourceRevision ||
      merged.occurredAt === null ||
      compareSourceInstants(merged.occurredAt, receipt.integratedAt) !== 0 ||
      !facts.length ||
      !facts.every((fact) => {
        const proof = evidence.get(fact.factId);
        return (
          row.evidenceIds.includes(fact.factId) &&
          proof?.contribution.canonicalEventId === fact.canonicalKey &&
          proof.contribution.actorId === receipt.actorId &&
          proof.contribution.artifactId === receipt.artifactId &&
          proof.contribution.roles.length === 1 &&
          proof.contribution.roles[0] === "author" &&
          proof.contribution.metricIds.includes(common.metricId) &&
          proof.artifact.repositoryId === receipt.repositoryId &&
          proof.artifact.publicUrl === merged.artifact.publicUrl &&
          proof.occurredAt !== null &&
          compareSourceInstants(proof.occurredAt, receipt.integratedAt) === 0 &&
          (proof.evidenceMetadata === undefined || proof.evidenceMetadata.activityState === "observed")
        );
      })
    )
      return unknown("current_context_unavailable");
    admitted.push({ receipt, merged, facts });
  }
  const ids = admitted.flatMap((item) => item.facts.map((fact) => fact.factId));
  if (!equalIds(ids, row.evidenceIds) || new Set(ids).size !== ids.length)
    return unknown("current_context_unavailable");
  if (admitted.length > physicalContextLimits.units || ids.length > physicalContextLimits.units)
    return unknown("context_budget_exceeded");
  try {
    const summary: PhysicalSummary = structuredClone(admitted[0]!.receipt.summary);
    for (const { receipt } of admitted.slice(1)) {
      for (const field of ["files", "additions", "deletions"] as const) {
        for (const bucket of ["raw", "eligible", "formattingOnly"] as const)
          summary[bucket][field] += receipt.summary[bucket][field];
        for (const kind of physicalFileClasses)
          for (const bucket of ["raw", "eligible"] as const)
            summary.classes[kind][bucket][field] += receipt.summary.classes[kind][bucket][field];
      }
    }
    // Safe integer and class arithmetic apply to the combined summary too.
    physicalSummarySchema.parse(summary);
    const context = {
      ...common,
      state: "available" as const,
      classifierVersion: admitted[0]!.receipt.classifierVersion,
      sampleCount: admitted.length,
      unitCount: ids.length,
      summary,
      samples: admitted.map(({ receipt, merged, facts }) => ({
        sampleId: createHash("sha256")
          .update(
            JSON.stringify([
              publicPhysicalContextVersion,
              receipt.repositoryId,
              receipt.canonicalIntegrationId,
              receipt.actorId,
            ]),
          )
          .digest("hex"),
        repositoryId: receipt.repositoryId,
        artifactId: receipt.artifactId,
        sourceUrl: merged.artifact.publicUrl!,
        before: receipt.before,
        after: receipt.after,
        beforeUrl: merged.artifact.publicUrl!.replace(/\/pull\/[1-9]\d*$/, "/commit/") + receipt.before,
        afterUrl: merged.artifact.publicUrl!.replace(/\/pull\/[1-9]\d*$/, "/commit/") + receipt.after,
        integratedAt: receipt.integratedAt,
        evidenceIds: facts.map((fact) => fact.factId),
      })),
    };
    if (Buffer.byteLength(JSON.stringify(context)) > physicalContextLimits.bytes)
      return unknown("context_budget_exceeded");
    return bindPublicPhysicalContext(context, {
      ...common,
      evidenceIds: row.evidenceIds,
      value: row.result.value,
      generatedAt: snapshot.generatedAt,
      start: scope.start,
      end: scope.end,
      methodology,
    });
  } catch {
    return unknown("current_context_unavailable");
  }
}
