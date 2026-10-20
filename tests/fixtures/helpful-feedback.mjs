// Synthetic source/use/consent authority only. No live approval or helpfulness claim.
import {
  normalizeGithubObservation,
  githubDiscussionRevision,
  minimizeDiscussionFeedback,
  discussionFeedbackFingerprint,
  discussionFeedbackRevision,
  discussionFeedbackPublicRevision,
} from "@pick-your-ai/github";
import {
  acceptedFeedbackThreadsVersion,
  discussionFeedbackContentVersion,
  discussionFeedbackFieldScope,
} from "@pick-your-ai/contracts";
import { metricRegistryV1, getMetricDefinition, stableJSON } from "@pick-your-ai/metrics";
import { attachSyntheticEvidenceIntake } from "./evidence-intake.mjs";

export const feedbackRepository = {
  id: 2,
  installationId: 1,
  slug: "synthetic-org/synthetic-repo",
  families: ["discussions"],
};
export const feedbackCreatedAt = "2026-10-10T10:00:00.000Z";
export const feedbackAnswerAt = "2026-10-11T10:00:00.000Z";
export const feedbackChosenAt = "2026-10-12T10:00:00.000Z";
export const feedbackObservedAt = "2026-10-13T10:00:00.000Z";
export const feedbackAcceptedAt = "2026-10-14T10:00:00.000Z";
export const feedbackCutoff = "2026-10-15T10:00:00.000Z";
export const feedbackSentinel = "SYNTHETIC_PRIVATE_BODY_SENTINEL_9b29e377";
export const feedbackTitleSentinel = "SYNTHETIC_PRIVATE_TITLE_SENTINEL_a4bd29";
export const feedbackActor = (id) => ({
  __typename: "User",
  id: `U_SYNTHETIC_${id}`,
  databaseId: id,
  login: `synthetic-${id}`,
});
export const feedbackNode = ({ sameAuthor = false } = {}) => ({
  id: "D_SYNTHETIC_FEEDBACK",
  url: `https://github.com/${feedbackRepository.slug}/discussions/4`,
  title: feedbackTitleSentinel,
  body: feedbackSentinel,
  createdAt: feedbackCreatedAt,
  updatedAt: feedbackChosenAt,
  lastEditedAt: null,
  author: feedbackActor(101),
  answerChosenAt: feedbackChosenAt,
  answerChosenBy: feedbackActor(202),
  answer: {
    id: "DC_SYNTHETIC_FEEDBACK",
    isAnswer: true,
    createdAt: feedbackAnswerAt,
    updatedAt: feedbackAnswerAt,
    lastEditedAt: null,
    deletedAt: null,
    isMinimized: false,
    body: feedbackSentinel + "_ANSWER",
    author: feedbackActor(sameAuthor ? 101 : 303),
  },
});
export const feedbackEnrollment = () => ({
  version: discussionFeedbackContentVersion,
  enrollments: [
    {
      repositoryId: 2,
      installationId: 1,
      fieldScope: [...discussionFeedbackFieldScope],
      sourceUseReceiptId: "synthetic-source-use",
      capabilityReceiptId: "synthetic-field-capability",
      policyVersion: "synthetic-feedback-source/v1",
      retentionPolicyVersion: "synthetic-feedback-retention-v1",
    },
  ],
});
export const feedbackPolicy = () => ({
  metricId: "helpful_feedback",
  version: "synthetic-helpful-feedback/v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition("helpful_feedback").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "canonical",
  groupingPolicyVersion: acceptedFeedbackThreadsVersion,
  sources: ["github_graphql"],
  minimumSamples: 1,
  rank: true,
});
export function feedbackBinding(sourceMetricId = "discussions_started") {
  return {
    category: "other",
    scope: `repository:2:${sourceMetricId}`,
    policyVersion: feedbackPolicy().version,
    metricId: "helpful_feedback",
    sourceMetricId,
    repositoryId: "2",
    reviewerIds: ["202"],
    helpfulFeedback: { version: acceptedFeedbackThreadsVersion },
  };
}
export function feedbackReview(source, target) {
  return {
    schemaVersion: acceptedFeedbackThreadsVersion,
    targetFactId: target.id,
    actorId: target.actorId,
    repositoryId: 2,
    discussionId: source.metadata.descriptor.discussionId,
    threadUrl: source.metadata.descriptor.threadUrl,
    sourceMetricId: target.metricId,
    sourceRevision: source.sourceRevision,
    descriptorFingerprint: source.metadata.fingerprint,
    authorityHash: source.metadata.authorityHash,
    coverageEpoch: source.metadata.coverageEpoch,
    generation: source.metadata.generation,
    observedAt: source.observedAt,
  };
}
export function attachFeedbackIntake(request) {
  const reviewed = JSON.parse(request.detail);
  return attachSyntheticEvidenceIntake(request, {
    sourceUseReview: { references: [{ locator: reviewed.threadUrl, revision: reviewed.sourceRevision }] },
  });
}
export function feedbackRequest(
  source,
  target,
  { id = "synthetic-helpful-review", acceptedAt = feedbackAcceptedAt } = {},
) {
  const binding = feedbackBinding(target.metricId);
  const decision = {
    id: `${id}:decision`,
    actor: "202",
    action: "accepted",
    at: Date.parse(acceptedAt),
    version: 1,
    policyVersion: binding.policyVersion,
  };
  const request = {
    id,
    kind: "evidence",
    status: "accepted",
    owner: target.actorId,
    version: 1,
    category: binding.category,
    scope: binding.scope,
    policyVersion: binding.policyVersion,
    locator: source.metadata.descriptor.threadUrl,
    collaborators: {},
    history: [decision],
    detail: JSON.stringify(feedbackReview(source, target)),
  };
  attachFeedbackIntake(request);
  return { request, decision, binding };
}
export function feedbackScenario(options = {}) {
  const node = feedbackNode(options),
    descriptor = minimizeDiscussionFeedback(node, feedbackRepository, githubDiscussionRevision(node));
  const metadata = {
    version: discussionFeedbackContentVersion,
    descriptor,
    fingerprint: discussionFeedbackFingerprint(descriptor),
    authorityHash: "a".repeat(64),
    coverageEpoch: "b".repeat(64),
    generation: "c".repeat(64),
    scanId: "synthetic-feedback-scan",
  };
  const sourceRevision = discussionFeedbackRevision(metadata);
  const { title: _title, body: _body, ...publicMetadata } = node;
  delete publicMetadata.answer.body;
  const input = normalizeGithubObservation({
    repository: { id: 2, slug: feedbackRepository.slug, visibility: "public" },
    proof: { verified: true, source: "github_graphql", revision: sourceRevision, isSynthetic: true },
    family: "discussion",
    action: "snapshot",
    observedAt: feedbackObservedAt,
    payload: publicMetadata,
    discussionAnswerSelection: { verified: true },
  });
  const source = { metadata, sourceRevision, observedAt: feedbackObservedAt, selectedCurrentState: true };
  input.discussionFeedbackSources = [source];
  input.discussionFeedbackOriginals = [{ ...structuredClone(source), selectedCurrentState: false }];
  input.discussionFeedbackRepositoryIds = [2];
  for (const evidence of input.evidence) evidence.sourceRevision = discussionFeedbackPublicRevision(metadata);
  const target = input.facts.find((fact) => fact.metricId === (options.sourceMetricId ?? "discussions_started"));
  const { request, decision, binding } = feedbackRequest(source, target);
  const policy = feedbackPolicy();
  return {
    input,
    target,
    source,
    request,
    decision,
    binding,
    state: { requests: { [request.id]: request }, profiles: {}, audit: [decision] },
    policies: [{ policy, signature: stableJSON(policy), approvalReceipt: "synthetic-feedback-policy" }],
  };
}
