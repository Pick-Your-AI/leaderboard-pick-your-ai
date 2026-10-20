import {
  isPullRequestMergeTargetBranch,
  supportsPullRequestMergeTarget,
  validatePullRequestMergeTarget,
  verifyGithubPullRequestMergeTargetCapture,
} from "@pick-your-ai/contracts";

export const mergeTargetNormalizationVersion = "pr-merge-target-normalization/v1";
const evidenceVersion = "pipeline-merge-target-evidence/v1";
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = () => {
  throw new Error("merge_target_normalization_binding_unavailable");
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** A fresh collection owns a new immutable generation, including negative proof.
 * A frozen retry supplies the same generation; it cannot trigger recollection. */
export function mergeTargetGenerationSignature(baseSignature, generation, digest) {
  if (!hash(baseSignature) || !hash(generation)) fail();
  return digest([mergeTargetNormalizationVersion, baseSignature, generation]);
}

export function validateMergeTargetGeneration(document, signature, baseSignature, digest, deliverySignature) {
  const marker = document.pullRequestMergeTargetNormalization;
  if (
    !marker ||
    Object.keys(marker).sort().join(",") !== "baseSignature,generation,schemaVersion" ||
    marker.schemaVersion !== mergeTargetNormalizationVersion ||
    marker.baseSignature !== baseSignature
  )
    fail();
  const expected = mergeTargetGenerationSignature(baseSignature, marker.generation, digest);
  if (signature !== expected && signature !== deliverySignature(expected)) fail();
  return marker;
}

const mergedFact = (fact) => supportsPullRequestMergeTarget(fact.metricId) && fact.occurredAt !== null;
const projection = (capture) => ({
  schemaVersion: "pr-merge-target/v1",
  repositoryId: String(capture.repository.id),
  pullRequestId: capture.pullRequest.id,
  eventId: capture.event.id,
  mergedAt: capture.mergedAt,
  branch: capture.event.mergeRefName,
  proofHash: capture.proofHash,
});

/** Recheck fact authority after reading saved bytes, not merely its hash shape. */
export function assertMergeTargetFacts(facts, captures, { complete = true, unverifiedSource = false } = {}) {
  for (const fact of facts) {
    const matches = captures.filter(
      (capture) =>
        String(capture.repository.id) === fact.repoId &&
        capture.pullRequest.id === fact.artifactId &&
        capture.mergedAt === fact.occurredAt,
    );
    if (fact.mergeTarget !== undefined) {
      const selected = validatePullRequestMergeTarget(fact.mergeTarget);
      if (
        !mergedFact(fact) ||
        matches.length !== 1 ||
        matches[0].status !== "known" ||
        !same(selected, projection(matches[0]))
      )
        fail();
    } else if (
      complete &&
      mergedFact(fact) &&
      !(unverifiedSource && matches.length === 0) &&
      (matches.length !== 1 || matches[0].status === "known")
    )
      fail();
  }
}

/** Every capture binds the exact collected PR revision and native merge clock.
 * Hash verification detaches before awaiting; no source callback participates. */
export async function readMergeTargetNormalization(document, row, repository, cutoff = null) {
  const input = structuredClone(document);
  const source = structuredClone(row.source_document ?? row.document);
  const binding = {
    family: row.family,
    repositoryId: String(row.repository_id),
    observedAt: new Date(row.observed_at).toISOString(),
    id: repository.id,
    slug: repository.slug,
  };
  const records = input.pullRequestMergeTargets;
  if (
    binding.family !== "pull_requests" ||
    !Array.isArray(records) ||
    records.length > 1 ||
    !Array.isArray(input.facts)
  )
    fail();
  const captures = [];
  for (const record of Array.from(records)) {
    const capture = await verifyGithubPullRequestMergeTargetCapture(record);
    if (
      capture.repository.id !== binding.id ||
      String(binding.id) !== binding.repositoryId ||
      capture.repository.slug !== binding.slug ||
      capture.pullRequest.id !== source.subjectId ||
      capture.pullRequest.url !== source.sourceUrl ||
      capture.sourceRevision !== source.sourceRevision ||
      capture.observedAt < binding.observedAt ||
      (cutoff !== null && capture.observedAt > cutoff) ||
      !input.facts.some(
        (fact) =>
          mergedFact(fact) &&
          fact.repoId === String(binding.id) &&
          fact.artifactId === capture.pullRequest.id &&
          fact.occurredAt === capture.mergedAt,
      )
    )
      fail();
    captures.push(capture);
  }
  assertMergeTargetFacts(input.facts, captures, {
    unverifiedSource: captures.length === 0 && input.reasons?.includes("merge_target_selected_source_unverified"),
  });
  return captures;
}

/** Private frozen authorization; public metadata remains leaderboard-evidence/v1. */
export function captureMergeTargetAuthorization(authorization) {
  if (authorization.mergeTargetEvidence === undefined) return {};
  const value = authorization.mergeTargetEvidence;
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "branch,cutoff,repositoryId,schemaVersion" ||
    value.schemaVersion !== evidenceVersion ||
    !isPullRequestMergeTargetBranch(value.branch) ||
    typeof value.repositoryId !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value.repositoryId) ||
    !Number.isSafeInteger(Number(value.repositoryId)) ||
    typeof value.cutoff !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.cutoff) ||
    !Number.isFinite(Date.parse(value.cutoff)) ||
    new Date(value.cutoff).toISOString() !== value.cutoff
  )
    fail();
  return { mergeTargetEvidence: structuredClone(value) };
}

export function mergeTargetAuthorization(scope, cutoff) {
  return scope.branch === undefined
    ? {}
    : captureMergeTargetAuthorization({
        mergeTargetEvidence: {
          schemaVersion: evidenceVersion,
          repositoryId: scope.repository,
          branch: scope.branch,
          cutoff,
        },
      });
}
