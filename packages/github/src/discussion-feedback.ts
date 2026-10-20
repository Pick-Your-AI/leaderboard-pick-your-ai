import { createHash } from "node:crypto";
import {
  discussionFeedbackContentVersion,
  discussionFeedbackLimits,
  encodeDiscussionFeedbackDescriptor,
  parseDiscussionFeedbackDescriptor,
  parseDiscussionFeedbackObservation,
  parseDiscussionFeedbackSource,
  parseAcceptedFeedbackThread,
  feedbackTimestamp,
  type FeedbackActor,
  type DiscussionFeedbackDescriptor,
  type DiscussionFeedbackObservation,
  type AcceptedFeedbackThread,
} from "@pick-your-ai/contracts";
import type { NormalizedGithubResult } from "./normalizers.js";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fail = (): never => {
  throw new Error("discussion_feedback_source_unverified");
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function at(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return fail();
  return new Date(value).toISOString();
}
function actor(value: unknown): FeedbackActor {
  if (value === null) return null;
  if (!object(value) || typeof value.__typename !== "string") return fail();
  if (value.__typename !== "User" && value.__typename !== "Bot") return null;
  if (
    typeof value.id !== "string" ||
    (value.databaseId !== null && (!Number.isSafeInteger(value.databaseId) || Number(value.databaseId) < 1))
  )
    return fail();
  return {
    kind: value.__typename,
    id: value.id,
    databaseId: value.databaseId as number | null,
    login: value.login as string | null,
  };
}
/** No truncation, normalization or replacement-character encoding. Raw text
 * exists only for this bounded read and is discarded before any checkpoint. */
function textDigest(value: unknown, maximum: number): string {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value, "utf8") > maximum)
    return fail();
  return hash(value);
}
export function minimizeDiscussionFeedback(
  value: unknown,
  repository: { id: number; installationId: number; slug: string },
  nativeRevision: string,
): DiscussionFeedbackDescriptor {
  if (
    !object(value) ||
    typeof value.url !== "string" ||
    !value.url.startsWith(`https://github.com/${repository.slug}/discussions/`)
  )
    return fail();
  let answer: DiscussionFeedbackDescriptor["answer"] = null;
  if (value.answer !== null) {
    if (
      !object(value.answer) ||
      value.answer.isAnswer !== true ||
      value.answer.deletedAt !== null ||
      value.answer.isMinimized !== false
    )
      return fail();
    answer = {
      id: value.answer.id as string,
      author: actor(value.answer.author),
      createdAt: at(value.answer.createdAt),
      updatedAt: at(value.answer.updatedAt),
      lastEditedAt: value.answer.lastEditedAt === null ? null : at(value.answer.lastEditedAt),
      deletedAt: null,
      isMinimized: false,
      isAnswer: true,
      bodyDigest: textDigest(value.answer.body, discussionFeedbackLimits.bodyBytes),
    };
  }
  return parseDiscussionFeedbackDescriptor({
    version: discussionFeedbackContentVersion,
    repositoryId: repository.id,
    installationId: repository.installationId,
    discussionId: value.id,
    threadUrl: value.url,
    nativeRevision,
    author: actor(value.author),
    createdAt: at(value.createdAt),
    updatedAt: at(value.updatedAt),
    lastEditedAt: value.lastEditedAt === null ? null : at(value.lastEditedAt),
    titleDigest: textDigest(value.title, discussionFeedbackLimits.titleBytes),
    bodyDigest: textDigest(value.body, discussionFeedbackLimits.bodyBytes),
    answerChosenAt: value.answerChosenAt === null ? null : at(value.answerChosenAt),
    answerChosenBy: actor(value.answerChosenBy),
    answer,
  });
}
export function discussionFeedbackFingerprint(value: unknown): string {
  return hash(encodeDiscussionFeedbackDescriptor(value));
}
export function discussionFeedbackRevision(value: unknown): string {
  const metadata = parseDiscussionFeedbackObservation(value);
  if (metadata.fingerprint !== discussionFeedbackFingerprint(metadata.descriptor)) return fail();
  return `gdf1:${metadata.fingerprint}.${hash(
    JSON.stringify([
      discussionFeedbackContentVersion,
      metadata.authorityHash,
      metadata.coverageEpoch,
      metadata.generation,
      metadata.scanId,
    ]),
  ).slice(0, 32)}`;
}
export function verifyDiscussionFeedbackObservation(value: unknown, revision: unknown): DiscussionFeedbackObservation {
  const metadata = parseDiscussionFeedbackObservation(value);
  if (discussionFeedbackRevision(metadata) !== revision) return fail();
  return metadata;
}
/** Public metadata-only revision: never project the private content fingerprint. */
export function discussionFeedbackPublicRevision(value: unknown): string {
  const metadata = parseDiscussionFeedbackObservation(value);
  return `${metadata.descriptor.nativeRevision}.${hash(metadata.scanId).slice(0, 32)}`;
}

export function validateHelpfulFeedbackSource(
  input: NormalizedGithubResult,
  targetFactId: string,
  acceptedAt: string,
  reviewed: unknown,
  cutoff?: string,
): { unit: string; review: AcceptedFeedbackThread } {
  const review = parseAcceptedFeedbackThread(reviewed);
  feedbackTimestamp(acceptedAt);
  if (cutoff !== undefined) feedbackTimestamp(cutoff);
  const targets = input.facts.filter((fact) => fact.id === targetFactId);
  const target = targets[0];
  const proofs = input.evidence.filter((entry) => entry.contribution.contributionId === targetFactId);
  const evidence = proofs[0];
  const sources = (input.discussionFeedbackSources ?? []).map(parseDiscussionFeedbackSource);
  const current = sources.filter(
    (source) =>
      source.selectedCurrentState &&
      source.metadata.descriptor.repositoryId === review.repositoryId &&
      source.metadata.descriptor.discussionId === review.discussionId,
  );
  const originals = (input.discussionFeedbackOriginals ?? [])
    .map(parseDiscussionFeedbackSource)
    .filter(
      (source) =>
        source.metadata.descriptor.repositoryId === review.repositoryId &&
        source.metadata.descriptor.discussionId === review.discussionId &&
        source.sourceRevision === review.sourceRevision &&
        source.observedAt === review.observedAt,
    );
  if (
    targets.length !== 1 ||
    !target ||
    proofs.length !== 1 ||
    !evidence ||
    current.length !== 1 ||
    originals.length !== 1
  )
    return fail();
  const latest = current[0]!,
    original = originals[0]!;
  if (original.selectedCurrentState || latest.observedAt < original.observedAt) return fail();
  for (const source of [latest, original]) {
    const metadata = verifyDiscussionFeedbackObservation(source.metadata, source.sourceRevision);
    if (
      metadata.fingerprint !== review.descriptorFingerprint ||
      metadata.authorityHash !== review.authorityHash ||
      metadata.coverageEpoch !== review.coverageEpoch ||
      metadata.generation !== review.generation ||
      metadata.descriptor.threadUrl !== review.threadUrl ||
      (cutoff !== undefined && source.observedAt > cutoff)
    )
      return fail();
  }
  const descriptor = latest.metadata.descriptor;
  const author = review.sourceMetricId === "discussions_started" ? descriptor.author : descriptor.answer?.author;
  const occurredAt = review.sourceMetricId === "discussions_started" ? descriptor.createdAt : descriptor.answerChosenAt;
  const nativeUnit =
    review.sourceMetricId === "discussions_started"
      ? `${descriptor.discussionId}:created`
      : `${descriptor.discussionId}:answer:${descriptor.answer?.id}`;
  // Bind the original native emitter identity, not a caller-supplied canonical
  // key merely copied into a matching evidence object.
  const nativeCanonical = `gh:${hash(JSON.stringify(["metric-unit", review.sourceMetricId, nativeUnit, review.actorId, "observed"]))}`;
  const nativeFactId = `gh:${hash(JSON.stringify(["fact", nativeCanonical]))}`;
  const actors = input.actors.filter((actor) => actor.id === review.actorId);
  if (
    review.targetFactId !== targetFactId ||
    target.id !== review.targetFactId ||
    target.actorId !== review.actorId ||
    target.metricId !== review.sourceMetricId ||
    target.artifactId !== review.discussionId ||
    target.repoId !== String(review.repositoryId) ||
    target.state !== "observed" ||
    target.role !== "author" ||
    target.revision !== 0 ||
    target.correctionReceipt !== null ||
    target.acceptanceReceipt !== null ||
    target.recognitionSourceFactId !== undefined ||
    target.canonicalKey !== nativeCanonical ||
    target.id !== nativeFactId ||
    !author ||
    author.databaseId === null ||
    String(author.databaseId) !== review.actorId ||
    actors.length !== 1 ||
    actors[0]!.githubDatabaseId !== author.databaseId ||
    actors[0]!.githubNodeId !== author.id ||
    target.occurredAt !== occurredAt ||
    !occurredAt ||
    occurredAt > acceptedAt ||
    original.observedAt > acceptedAt ||
    latest.observedAt !== target.observedAt ||
    (cutoff !== undefined && acceptedAt > cutoff) ||
    evidence.artifact.source !== "github" ||
    evidence.artifact.kind !== "other" ||
    evidence.artifact.visibility !== "public" ||
    evidence.artifact.stableId !== review.discussionId ||
    evidence.artifact.repositoryId !== target.repoId ||
    evidence.artifact.publicUrl !== review.threadUrl ||
    evidence.contribution.artifactId !== review.discussionId ||
    evidence.contribution.actorId !== review.actorId ||
    evidence.contribution.canonicalEventId !== target.canonicalKey ||
    evidence.contribution.qualification !== "eligible" ||
    evidence.contribution.roles.length !== 1 ||
    evidence.contribution.roles[0] !== "author" ||
    evidence.contribution.metricIds.length !== 1 ||
    evidence.contribution.metricIds[0] !== review.sourceMetricId ||
    evidence.contribution.reasonCodes.length !== 1 ||
    evidence.contribution.reasonCodes[0] !== "raw_observed_only" ||
    evidence.sourceRevisionUrl !== null ||
    target.subjectActorId !== (descriptor.author?.databaseId == null ? null : String(descriptor.author.databaseId)) ||
    evidence.sourceRevision !== discussionFeedbackPublicRevision(latest.metadata) ||
    evidence.occurredAt !== occurredAt ||
    evidence.evidenceMetadata?.activityState !== "observed" ||
    evidence.evidenceMetadata.acceptedAt !== null ||
    evidence.evidenceMetadata.sourceOccurredAt !== occurredAt ||
    evidence.evidenceMetadata.observedAt !== latest.observedAt
  )
    return fail();
  if (
    review.sourceMetricId === "discussions_started"
      ? target.acceptedAt !== null || target.acceptedBy !== null
      : target.rawState !== "native_answer_selection" ||
        target.acceptedAt !== descriptor.answerChosenAt ||
        target.acceptedBy !==
          (descriptor.answerChosenBy?.databaseId === null || !descriptor.answerChosenBy
            ? null
            : String(descriptor.answerChosenBy.databaseId))
  )
    return fail();
  return {
    unit: JSON.stringify(["accepted-feedback-threads/v1", review.repositoryId, review.discussionId, review.actorId]),
    review,
  };
}
