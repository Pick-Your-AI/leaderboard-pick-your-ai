import { createHash } from "node:crypto";
import { compareSourceInstants, publicEvidenceMetadataSchema, sourceEventSchema } from "@pick-your-ai/contracts";
import type { NormalizedGithubFact, NormalizedGithubResult, NormalizedPublicEvidence } from "./normalizers.js";

const invalid = (): never => {
  throw new Error("documentation_purpose_source_unverified");
};
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  sourceEventSchema.shape.observedAt.safeParse(value).success &&
  Number.isFinite(Date.parse(value));

export interface VerifiedDocumentationPurposeSource {
  target: NormalizedGithubFact;
  evidence: NormalizedPublicEvidence;
  pathPolicyVersion: string;
  unit: string;
}

function documentationCategoryUnit(
  target: NormalizedGithubFact,
  category: "documentation" | "example" | "guide",
): string {
  return (
    "domain:" +
    createHash("sha256")
      .update(JSON.stringify(["domain-evidence/v1", "documentation", target.repoId, [target.artifactId, category]]))
      .digest("hex")
  );
}

/** Generic and purpose reviews share the existing documentation category unit.
 * Preserve separately qualified example/guide categories, but not caller aliases.
 */
export function documentationRecognitionUnit(
  source: VerifiedDocumentationPurposeSource,
  changesetId: string | undefined,
): string {
  for (const category of ["example", "guide"] as const) {
    const unit = documentationCategoryUnit(source.target, category);
    if (changesetId === unit) return unit;
  }
  return source.unit;
}

/** A private purpose review can qualify only the original pinned documentation author.
 * A source path is a candidate; neither that path nor a publisher is an authorship review.
 */
export function validateDocumentationPurposeSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
): VerifiedDocumentationPurposeSource {
  const targets = input.facts.filter((fact) => fact.id === targetFactId);
  const proofs = input.evidence.filter((entry) => entry.contribution.contributionId === targetFactId);
  const target = targets[0],
    evidence = proofs[0];
  if (
    input.isSynthetic === true ||
    input.syntheticFactIds?.includes(targetFactId) ||
    targets.length !== 1 ||
    !target ||
    target.metricId !== "documentation" ||
    target.role !== "author" ||
    target.state !== "observed" ||
    target.acceptedAt != null ||
    target.acceptedBy != null ||
    target.acceptanceReceipt != null ||
    target.rawState !== "merged_documentation_participation_not_reviewed_quality" ||
    !nonempty(target.canonicalKey) ||
    !nonempty(target.actorId) ||
    !nonempty(target.artifactId) ||
    !nonempty(target.repoId) ||
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
    evidence.contribution.metricIds[0] !== "documentation" ||
    evidence.contribution.roles.length !== 1 ||
    evidence.contribution.roles[0] !== "author" ||
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
    return invalid();
  const repository = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(
    evidence.artifact.publicUrl,
  )?.[1];
  const revision = evidence.sourceRevision;
  if (
    !repository ||
    typeof revision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) ||
    evidence.sourceRevisionUrl !== "https://github.com/" + repository + "/commit/" + revision
  )
    return invalid();
  const reasons = evidence.contribution.reasonCodes;
  const candidates = reasons.filter((reason) => reason.startsWith("documentation_purpose_candidate:"));
  const policies = reasons.filter((reason) => reason.startsWith("documentation_path_policy:"));
  if (
    reasons.length > 32 ||
    candidates.length !== 1 ||
    candidates[0] !== "documentation_purpose_candidate:release_notes" ||
    policies.length !== 1 ||
    !/^documentation_path_policy:[A-Za-z0-9_.:-]{1,200}$/.test(policies[0]!)
  )
    return invalid();
  // Exactly the established domain-evidence documentation unit. Receipt IDs,
  // files and caller-supplied bulk changesets cannot create a second unit.
  const unit = documentationCategoryUnit(target, "documentation");
  return { target, evidence, pathPolicyVersion: policies[0]!.slice("documentation_path_policy:".length), unit };
}
