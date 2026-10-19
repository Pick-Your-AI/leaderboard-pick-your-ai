import { createHash } from "node:crypto";

const fail = () => {
  throw new Error("invalid_retained_physical_context");
};
// The v1 receipt names existing stock normalization units, not new credit units.
const unitId = (...parts) => `gh:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;

/** Retain an optional private receipt only with its original source/fact bindings.
 * Cache absence remains absence. Shape-valid IDs and hashes are not authority.
 */
export function retainPhysicalContext(output, source, repository, contracts, dataMode) {
  if (output.physicalContext === undefined) return {};
  const parsed = contracts.githubPhysicalContextReceiptSchema.safeParse(output.physicalContext);
  if (!parsed.success) return fail();
  const receipt = parsed.data;
  const observedAt = source.observed_at instanceof Date ? source.observed_at.toISOString() : source.observed_at;
  const subjectIds = new Set([source.subject_id]);
  if (/^[1-9]\d*$/.test(source.subject_id)) subjectIds.add(`github:pull_request:${source.subject_id}`);
  if (
    source.family !== "pull_requests" ||
    String(source.repository_id) !== String(repository.id) ||
    receipt.repositoryId !== String(repository.id) ||
    !subjectIds.has(receipt.artifactId) ||
    output.isSynthetic !== (dataMode === "synthetic") ||
    !contracts.sourceEventSchema.shape.observedAt.safeParse(observedAt).success ||
    !(contracts.compareSourceInstants(receipt.integratedAt, observedAt) <= 0) ||
    !Array.isArray(output.facts) ||
    !Array.isArray(output.evidence) ||
    !Array.isArray(output.actors) ||
    output.actors.filter((actor) => actor.id === receipt.actorId).length !== 1
  )
    return fail();

  const facts = new Map();
  const evidence = new Map();
  for (const fact of output.facts) {
    if (facts.has(fact.id)) return fail();
    facts.set(fact.id, fact);
  }
  for (const entry of output.evidence) {
    const id = entry?.contribution?.contributionId;
    if (evidence.has(id)) return fail();
    evidence.set(id, entry);
  }
  const original = (fact, metricId) =>
    fact &&
    fact.metricId === metricId &&
    fact.repoId === receipt.repositoryId &&
    fact.artifactId === receipt.artifactId &&
    fact.actorId === receipt.actorId &&
    fact.role === receipt.role &&
    fact.state === "observed" &&
    fact.occurredAt === receipt.integratedAt &&
    contracts.sourceEventSchema.shape.observedAt.safeParse(fact.observedAt).success &&
    contracts.compareSourceInstants(fact.observedAt, observedAt) === 0 &&
    fact.revision === 0 &&
    fact.correctionReceipt === null &&
    fact.acceptanceReceipt === null &&
    fact.acceptedAt === null &&
    fact.acceptedBy === null &&
    fact.subjectActorId === receipt.actorId;
  const proofFor = (fact) => {
    const entry = evidence.get(fact.id);
    const contribution = contracts.contributionSchema.safeParse(entry?.contribution);
    const artifact = contracts.artifactSchema.safeParse(entry?.artifact);
    if (
      !contribution.success ||
      !artifact.success ||
      contribution.data.canonicalEventId !== fact.canonicalKey ||
      contribution.data.actorId !== receipt.actorId ||
      contribution.data.artifactId !== receipt.artifactId ||
      contribution.data.qualification !== "eligible" ||
      contribution.data.roles.length !== 1 ||
      contribution.data.roles[0] !== "author" ||
      contribution.data.metricIds.length !== 1 ||
      contribution.data.metricIds[0] !== fact.metricId ||
      artifact.data.kind !== "pull_request" ||
      artifact.data.stableId !== receipt.artifactId ||
      artifact.data.repositoryId !== receipt.repositoryId ||
      artifact.data.visibility !== "public" ||
      artifact.data.publicUrl !== source.document?.sourceUrl ||
      !artifact.data.publicUrl?.startsWith(`https://github.com/${repository.slug}/pull/`) ||
      entry.occurredAt !== receipt.integratedAt
    )
      return fail();
    return entry;
  };
  const physical = output.facts.filter((fact) => contracts.physicalMetricIds.includes(fact.metricId));
  if (physical.length !== receipt.facts.length) return fail();
  for (const binding of receipt.facts) {
    const fact = facts.get(binding.factId);
    if (
      !original(fact, binding.metricId) ||
      fact.canonicalKey !== binding.canonicalKey ||
      (fact.quantity ?? 1) !== binding.quantity ||
      fact.id !== unitId("fact", fact.canonicalKey)
    )
      return fail();
    if (binding.metricId !== "files_changed") {
      const canonical = unitId(
        "metric-unit",
        binding.metricId,
        `${receipt.repositoryId}:${receipt.canonicalIntegrationId}:default-integration`,
        receipt.actorId,
        "observed",
      );
      if (fact.canonicalKey !== canonical || fact.rawState !== "physical_change_not_effort") return fail();
    } else if (!/^eligible_(?:source|tests|docs)_path$/.test(fact.rawState)) return fail();
    proofFor(fact);
  }
  for (const kind of ["source", "tests", "docs"])
    if (
      physical.filter((fact) => fact.metricId === "files_changed" && fact.rawState === `eligible_${kind}_path`)
        .length !== receipt.summary.classes[kind].eligible.files
    )
      return fail();
  const merged = output.facts.filter((fact) => fact.metricId === "pr_merged");
  if (
    merged.length !== 1 ||
    !original(merged[0], "pr_merged") ||
    merged[0].rawState !== `target:${receipt.targetBranch}`
  )
    return fail();
  const mergedProof = proofFor(merged[0]);
  if (
    typeof mergedProof.sourceRevision !== "string" ||
    mergedProof.sourceRevision.toLowerCase() !== receipt.after ||
    mergedProof.sourceRevisionUrl !== `https://github.com/${repository.slug}/commit/${mergedProof.sourceRevision}`
  )
    return fail();
  return { physicalContext: receipt };
}
