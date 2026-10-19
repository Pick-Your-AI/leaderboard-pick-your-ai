import { compareSourceInstants, publicEvidenceMetadataSchema, sourceEventSchema } from "@pick-your-ai/contracts";
import type { NormalizedGithubFact, NormalizedGithubResult, NormalizedPublicEvidence } from "./normalizers.js";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  sourceEventSchema.shape.observedAt.safeParse(value).success &&
  Number.isFinite(Date.parse(value));

export interface VerifiedMaintenanceSource {
  target: NormalizedGithubFact;
  evidence: NormalizedPublicEvidence;
  unit: string;
}

/** A category receipt qualifies original merged participation; it cannot create that source fact. */
export function validateMaintenanceSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
): VerifiedMaintenanceSource {
  const targets = input.facts.filter((fact) => fact.id === targetFactId);
  const target = targets[0];
  const proofs = input.evidence.filter((entry) => entry.contribution.contributionId === targetFactId);
  const evidence = proofs[0];
  if (
    targets.length !== 1 ||
    !target ||
    target.state !== "observed" ||
    target.acceptedAt != null ||
    target.acceptedBy != null ||
    target.acceptanceReceipt != null ||
    !(
      (target.metricId === "pr_merged" && target.role === "author") ||
      (target.metricId === "pr_coauthored" && target.role === "coauthor")
    ) ||
    !nonEmpty(target.canonicalKey) ||
    !nonEmpty(target.actorId) ||
    !nonEmpty(target.artifactId) ||
    !nonEmpty(target.repoId) ||
    input.actors.filter((actor) => actor.id === target.actorId).length !== 1 ||
    !instant(target.occurredAt) ||
    !instant(acceptedAt) ||
    compareSourceInstants(target.occurredAt, acceptedAt) > 0 ||
    proofs.length !== 1 ||
    !evidence ||
    evidence.artifact.source !== "github" ||
    evidence.artifact.kind !== "pull_request" ||
    evidence.artifact.visibility !== "public" ||
    evidence.artifact.stableId !== target.artifactId ||
    evidence.artifact.repositoryId !== target.repoId ||
    evidence.contribution.artifactId !== target.artifactId ||
    evidence.contribution.actorId !== target.actorId ||
    evidence.contribution.qualification !== "eligible" ||
    evidence.contribution.canonicalEventId !== target.canonicalKey ||
    evidence.contribution.metricIds.length !== 1 ||
    evidence.contribution.metricIds[0] !== target.metricId ||
    evidence.contribution.roles.length !== 1 ||
    evidence.contribution.roles[0] !== target.role ||
    !nonEmpty(evidence.sourceRevision) ||
    !instant(evidence.occurredAt) ||
    compareSourceInstants(evidence.occurredAt, target.occurredAt) !== 0 ||
    (evidence.evidenceMetadata !== undefined &&
      (!publicEvidenceMetadataSchema.safeParse(evidence.evidenceMetadata).success ||
        evidence.evidenceMetadata.sourceAction !== "pull_request_merged" ||
        evidence.evidenceMetadata.activityState !== "observed" ||
        evidence.evidenceMetadata.acceptedAt !== null ||
        !instant(evidence.evidenceMetadata.sourceOccurredAt) ||
        compareSourceInstants(evidence.evidenceMetadata.sourceOccurredAt, target.occurredAt) !== 0))
  )
    throw new Error("Maintenance recognition requires an observed merged pull-request participant");

  // One maintenance-category participation per repository, PR and contributor.
  // Receipt aliases and caller-supplied bulk changesets cannot change this unit.
  return { target, evidence, unit: JSON.stringify(["maintenance", target.repoId, target.artifactId, target.actorId]) };
}
