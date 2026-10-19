import {
  compareSourceInstants,
  publicProjectContextSchema,
  publicProjectContextVersion,
} from "@pick-your-ai/contracts";

const key = (repositoryId, artifactId) => JSON.stringify([repositoryId, artifactId]);
const fail = () => {
  throw new Error("invalid_public_project_context_source");
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Only validated persisted native receipts may supply public Project context.
 * Current rows already belong to the latest completed full native-subject scan.
 * Transient recognition and raw/legacy Project arrays are not membership receipts.
 */
export function createPublicProjectContextProjector(normalized, basis, observationCutoff) {
  const current = new Map();
  const events = new Map();
  for (const entry of normalized) {
    const receipt = entry.document.projectContext;
    if (entry.family === "project_current" && receipt) {
      const identity = key(receipt.repositoryId, receipt.subjectId);
      if (current.has(identity)) fail();
      current.set(identity, receipt);
    }
    if (
      entry.family === "project_history" &&
      entry.document.projectHistoryNormalizationVersion === "collected-subject/v2"
    ) {
      for (const fact of entry.document.facts) {
        const proof = entry.document.evidence.find((item) => item.contribution.contributionId === fact.id);
        if (!proof || !fact.eventContext?.projectScope?.length) continue;
        const identity = JSON.stringify([fact.repoId, fact.artifactId, fact.id]);
        const candidates = events.get(identity) ?? [];
        candidates.push({ fact, proof, observedAt: entry.source.observedAt });
        events.set(identity, candidates);
      }
    }
  }
  return (original, fact) => {
    const artifact = original.artifact;
    const contribution = original.contribution;
    if (!artifact.repositoryId || !artifact.stableId) return {};
    if (
      fact.id !== contribution.contributionId ||
      fact.repoId !== artifact.repositoryId ||
      fact.artifactId !== artifact.stableId ||
      contribution.artifactId !== artifact.stableId
    )
      fail();
    let context = null;
    let observedAt = null;
    if (basis === "current") {
      const receipt = current.get(key(fact.repoId, fact.artifactId));
      if (receipt) {
        if (receipt.subjectKind !== artifact.kind || receipt.sourceUrl !== artifact.publicUrl) fail();
        context = receipt.context;
        observedAt = receipt.observedAt;
      }
    } else {
      const candidates = events.get(JSON.stringify([fact.repoId, fact.artifactId, fact.id])) ?? [];
      for (const candidate of candidates) {
        if (
          candidate.proof.sourceRevision !== original.sourceRevision ||
          candidate.proof.artifact.publicUrl !== artifact.publicUrl ||
          candidate.proof.contribution.canonicalEventId !== contribution.canonicalEventId ||
          !same(candidate.fact.eventContext, fact.eventContext)
        )
          continue;
        if (observedAt === null || compareSourceInstants(candidate.observedAt, observedAt) > 0) {
          context = candidate.fact.eventContext;
          observedAt = candidate.observedAt;
        }
      }
    }
    const value = publicProjectContextSchema.parse({
      schemaVersion: publicProjectContextVersion,
      binding: {
        repositoryId: artifact.repositoryId,
        artifactId: artifact.stableId,
        contributionId: contribution.contributionId,
      },
      basis,
      state: context === null ? "unknown" : "known",
      projects: context?.projects ?? [],
      projectScope: context?.projectScope ?? [],
      observedAt,
    });
    if (observedAt !== null) {
      const comparison = compareSourceInstants(observedAt, observationCutoff);
      if (!Number.isFinite(comparison) || comparison > 0) fail();
    }
    return { projectContext: value };
  };
}
