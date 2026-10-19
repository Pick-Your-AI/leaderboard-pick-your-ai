import { createHash } from "node:crypto";
import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import { validateMaintenanceSource } from "./maintenance.js";
import { validateGithubReleaseInclusion, type GithubReleaseInclusionRecord } from "./release-inclusion.js";
import type { NormalizedGithubResult } from "./normalizers.js";

export interface GithubReleaseReviewTarget {
  targetFactId: string;
  releaseId: number;
  pullRequestNumber: number;
  proofHash: string;
  policyVersion: string;
}

/** Private policy identity retained with an accepted release membership. */
export interface GithubReleaseMembership {
  version: "release-inclusion-units/v1";
  releaseId: number;
  releaseNodeId: string;
  pullRequestNodeId: string;
  mergeCommitSha: string;
  releaseCommitSha: string;
  publishedAt: string;
  proofHash: string;
}

function fail(): never {
  throw new Error("release_inclusion_source_unverified");
}
const safeInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  sourceEventSchema.shape.observedAt.safeParse(value).success &&
  !/\.\d{4,}(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** A review pin, not a cryptographic source attestation. Recollection alone does not change it. */
export function githubReleaseInclusionHash(value: unknown): string {
  const { observedAt, ...record } = validateGithubReleaseInclusion(value);
  return createHash("sha256").update(canonical(record)).digest("hex");
}

/** Bind collected release ancestry to the exact original observed PR author. */
export function validateReleaseChangesSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
  review: GithubReleaseReviewTarget | undefined,
) {
  try {
    if (
      !review ||
      typeof review !== "object" ||
      Array.isArray(review) ||
      Object.keys(review).sort().join(",") !== "policyVersion,proofHash,pullRequestNumber,releaseId,targetFactId" ||
      review.targetFactId !== targetFactId ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(review.targetFactId) ||
      !/^[A-Za-z0-9_.:-]{1,100}$/.test(review.policyVersion) ||
      !/^[a-f0-9]{64}$/.test(review.proofHash) ||
      !Number.isSafeInteger(review.releaseId) ||
      review.releaseId < 1 ||
      !Number.isSafeInteger(review.pullRequestNumber) ||
      review.pullRequestNumber < 1 ||
      input.isSynthetic === true ||
      input.syntheticFactIds?.includes(targetFactId) ||
      !safeInstant(acceptedAt) ||
      !Array.isArray(input.releaseInclusions) ||
      input.releaseInclusions.length > 1000
    )
      fail();
    const { target, evidence } = validateMaintenanceSource(input, targetFactId, acceptedAt);
    if (
      target.metricId !== "pr_merged" ||
      target.role !== "author" ||
      target.subjectActorId !== target.actorId ||
      !safeInstant(target.occurredAt) ||
      !safeInstant(target.observedAt)
    )
      fail();
    const byIdentity = new Map<string, { record: GithubReleaseInclusionRecord; hash: string }>();
    const releaseIdentities = new Map<string, string>();
    const pullRequestIdentities = new Map<string, string>();
    for (const raw of input.releaseInclusions) {
      const record = validateGithubReleaseInclusion(raw);
      const hash = githubReleaseInclusionHash(record);
      const releaseKey = JSON.stringify([record.repository.id, record.release.id]);
      const releaseValue = canonical([record.release, record.tag]);
      const pullKey = JSON.stringify([record.repository.id, record.pullRequest.number]);
      const pullValue = canonical(record.pullRequest);
      if (
        (releaseIdentities.has(releaseKey) && releaseIdentities.get(releaseKey) !== releaseValue) ||
        (pullRequestIdentities.has(pullKey) && pullRequestIdentities.get(pullKey) !== pullValue)
      )
        fail();
      releaseIdentities.set(releaseKey, releaseValue);
      pullRequestIdentities.set(pullKey, pullValue);
      const identity = JSON.stringify([
        record.request.repositoryId,
        record.request.releaseId,
        record.request.pullRequestNumber,
      ]);
      const previous = byIdentity.get(identity);
      if (previous && previous.hash !== hash) fail();
      if (!previous || compareSourceInstants(record.observedAt, previous.record.observedAt) < 0)
        byIdentity.set(identity, { record, hash });
    }
    const selected = byIdentity.get(
      JSON.stringify([Number(target.repoId), review.releaseId, review.pullRequestNumber]),
    );
    if (!selected || selected.hash !== review.proofHash) fail();
    const record = selected.record;
    const actor = input.actors.find((entry) => entry.id === target.actorId);
    const original = record.pullRequest;
    if (
      target.repoId !== String(record.repository.id) ||
      target.artifactId !== original.nodeId ||
      target.actorId !== String(original.author.id) ||
      !actor ||
      actor.githubDatabaseId !== original.author.id ||
      actor.githubNodeId !== original.author.nodeId ||
      (original.author.type === "Bot"
        ? !["bot", "github_app"].includes(actor.kind)
        : !["user", "service_account"].includes(actor.kind)) ||
      evidence.artifact.publicUrl !== `https://github.com/${record.repository.slug}/pull/${original.number}` ||
      compareSourceInstants(target.occurredAt!, original.mergedAt) !== 0 ||
      compareSourceInstants(target.occurredAt!, target.observedAt) > 0 ||
      (evidence.evidenceMetadata !== undefined &&
        compareSourceInstants(evidence.evidenceMetadata.observedAt, target.observedAt) !== 0) ||
      !safeInstant(record.release.publishedAt) ||
      !safeInstant(record.observedAt) ||
      compareSourceInstants(record.release.publishedAt, acceptedAt) > 0 ||
      (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(evidence.sourceRevision ?? "") &&
        evidence.sourceRevision !== original.mergeCommitSha)
    )
      fail();
    const workUnit = JSON.stringify(["release_changes", target.repoId, original.nodeId, target.actorId]);
    const membershipUnit = JSON.stringify([
      "release_changes",
      target.repoId,
      record.release.nodeId,
      original.nodeId,
      target.actorId,
    ]);
    const membership: GithubReleaseMembership = {
      version: "release-inclusion-units/v1",
      releaseId: record.release.id,
      releaseNodeId: record.release.nodeId,
      pullRequestNodeId: original.nodeId,
      mergeCommitSha: original.mergeCommitSha,
      releaseCommitSha: record.tag.commitSha,
      publishedAt: record.release.publishedAt,
      proofHash: selected.hash,
    };
    return {
      target,
      evidence,
      record,
      workUnit,
      membershipUnit,
      membership,
      observedAt:
        compareSourceInstants(target.observedAt, record.observedAt) >= 0 ? target.observedAt : record.observedAt,
    };
  } catch {
    return fail();
  }
}
