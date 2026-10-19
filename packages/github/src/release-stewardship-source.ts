import { compareSourceInstants, publicEvidenceMetadataSchema, sourceEventSchema } from "@pick-your-ai/contracts";
import type { NormalizedGithubFact, NormalizedGithubResult, NormalizedPublicEvidence } from "./normalizers.js";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  sourceEventSchema.shape.observedAt.safeParse(value).success &&
  Number.isFinite(Date.parse(value));

export interface VerifiedReleaseStewardshipSource {
  target: NormalizedGithubFact;
  evidence: NormalizedPublicEvidence;
  unit: string;
}

/** A protected checklist review qualifies an original publisher; it cannot create a publication or participant. */
export function validateReleaseStewardshipSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
): VerifiedReleaseStewardshipSource {
  const targets = input.facts.filter((fact) => fact.id === targetFactId);
  const target = targets[0];
  const proofs = input.evidence.filter((entry) => entry.contribution.contributionId === targetFactId);
  const evidence = proofs[0];
  const publishers = input.actors.filter((actor) => actor.id === target?.actorId);
  const publisher = publishers[0];
  if (
    targets.length !== 1 ||
    !target ||
    target.metricId !== "release_stewardship" ||
    target.state !== "observed" ||
    target.acceptedAt != null ||
    target.acceptedBy != null ||
    target.acceptanceReceipt != null ||
    !["author", "automation"].includes(target.role) ||
    !nonEmpty(target.canonicalKey) ||
    !nonEmpty(target.actorId) ||
    !nonEmpty(target.artifactId) ||
    !nonEmpty(target.repoId) ||
    publishers.length !== 1 ||
    !publisher ||
    // Match the existing publication normalizer; do not invent a new kind allowlist.
    target.role !== (["bot", "github_app", "service_account"].includes(publisher.kind) ? "automation" : "author") ||
    !instant(target.occurredAt) ||
    !instant(acceptedAt) ||
    compareSourceInstants(target.occurredAt, acceptedAt) > 0 ||
    proofs.length !== 1 ||
    !evidence ||
    evidence.artifact.source !== "github" ||
    evidence.artifact.kind !== "release" ||
    evidence.artifact.visibility !== "public" ||
    evidence.artifact.stableId !== target.artifactId ||
    evidence.artifact.repositoryId !== target.repoId ||
    evidence.contribution.artifactId !== target.artifactId ||
    evidence.contribution.actorId !== target.actorId ||
    evidence.contribution.qualification !== "eligible" ||
    evidence.contribution.canonicalEventId !== target.canonicalKey ||
    evidence.contribution.metricIds.length !== 1 ||
    evidence.contribution.metricIds[0] !== "release_stewardship" ||
    evidence.contribution.roles.length !== 1 ||
    evidence.contribution.roles[0] !== target.role ||
    !nonEmpty(evidence.sourceRevision) ||
    !instant(evidence.occurredAt) ||
    compareSourceInstants(evidence.occurredAt, target.occurredAt) !== 0 ||
    (evidence.evidenceMetadata !== undefined &&
      (!publicEvidenceMetadataSchema.safeParse(evidence.evidenceMetadata).success ||
        evidence.evidenceMetadata.sourceAction !== "release_published" ||
        evidence.evidenceMetadata.activityState !== "observed" ||
        evidence.evidenceMetadata.acceptedAt !== null ||
        !instant(evidence.evidenceMetadata.sourceOccurredAt) ||
        compareSourceInstants(evidence.evidenceMetadata.sourceOccurredAt, target.occurredAt) !== 0))
  )
    throw new Error("Release stewardship recognition requires an observed release publication participant");

  // Preserve the established default recognized identity. A caller's bulk
  // changeset alias cannot multiply one original publisher/release event.
  return { target, evidence, unit: target.canonicalKey };
}
