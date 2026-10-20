import {
  compareSourceInstants,
  workstreamHelpPageSchema,
  type PublicScope,
} from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { metadata, ReadFailure, type Selection } from "./client.ts";
import { milestoneParameters } from "./recognition-client.ts";

const fail = (): never => { throw new ReadFailure(502, "invalid_workstream_help_response"); };
export const workstreamHelpParameters = milestoneParameters;

/** Validate scope and proof consistency; the public client cannot authenticate source review. */
export function workstreamHelpPage(value: unknown, selected: Selection, actorId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  const meta = metadata(data, selected);
  if (data.actorId !== actorId) return fail();
  const parsed = workstreamHelpPageSchema.safeParse({
    ruleVersion: data.ruleVersion,
    category: data.category,
    meaning: data.meaning,
    recognitions: data.recognitions,
    totalRecognitions: data.totalRecognitions,
    pageSize: data.pageSize,
    nextCursor: data.nextCursor,
  });
  if (!parsed.success) return fail();
  const page = parsed.data;
  if (page.category !== selected.category || page.pageSize !== Number(selected.limit)) return fail();
  const known = new Set(metricRegistryV1.metrics.map((metric) => metric.id));
  const disabled = new Set(meta.disabledMetrics.map((metric) => metric.id));
  if (page.category !== null && (!known.has(page.category) || disabled.has(page.category))) return fail();
  const scope: PublicScope = meta.scope;
  const catalogs = new Map<string, string>(), artifacts = new Map<string, string>(), proofs = new Set<string>();
  const statementHashes = new Map<string, string>();
  for (const entry of page.recognitions) {
    const { proof, help } = entry;
    if (proof.actorId !== actorId || help.statement.organization !== selected.organization ||
      selected.actors === "automation" ||
      (selected.repository !== null && proof.repositoryId !== selected.repository) ||
      (selected.category !== null && !proof.metricIds.includes(selected.category)) ||
      (scope.roles?.length && !scope.roles.includes("author")) ||
      proof.metricIds.some((id) => !known.has(id) || disabled.has(id)) ||
      (selected.start !== null && compareSourceInstants(proof.occurredAt, selected.start) < 0) ||
      (selected.end !== null && compareSourceInstants(proof.occurredAt, selected.end) >= 0) ||
      compareSourceInstants(proof.occurredAt, meta.generatedAt) > 0 ||
      compareSourceInstants(help.reviewedAt, meta.generatedAt) > 0 || proofs.has(proof.contributionId)) return fail();
    proofs.add(proof.contributionId);
    if (statementHashes.has(help.statementUrl) && statementHashes.get(help.statementUrl) !== help.statementHash) return fail();
    statementHashes.set(help.statementUrl, help.statementHash);
    const artifact = JSON.stringify([proof.artifactKind, proof.repositoryId, proof.sourceUrl]);
    if (artifacts.has(proof.artifactId) && artifacts.get(proof.artifactId) !== artifact) return fail();
    artifacts.set(proof.artifactId, artifact);
    for (const workstream of [help.statement.from, help.statement.to]) {
      const key = JSON.stringify([help.statement.organization, help.statement.definitionVersion, workstream.id]);
      if (catalogs.has(key) && catalogs.get(key) !== workstream.label) return fail();
      catalogs.set(key, workstream.label);
    }
  }
  return { ...meta, ...page };
}
