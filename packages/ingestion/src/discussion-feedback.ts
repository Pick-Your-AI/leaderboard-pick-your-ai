import { createHash } from "node:crypto";
import {
  discussionFeedbackContentVersion,
  discussionFeedbackFields,
  encodeDiscussionFeedbackDescriptor,
  parseDiscussionFeedbackObservation,
  type DiscussionFeedbackObservation,
} from "@pick-your-ai/contracts";

/** Validate the closed minimized DTO before CollectionStore writes a source row.
 * Actual source authority and complete-scan coverage belong to the pipeline. */
export function collectionDiscussionFeedback(
  value: unknown,
  family: string,
): DiscussionFeedbackObservation | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const revision = Object.getOwnPropertyDescriptor(value, "sourceRevision")?.value;
  if (!("discussionFeedback" in value) && !(typeof revision === "string" && revision.startsWith("gdf")))
    return undefined;
  const fact = discussionFeedbackFields(value, [
    "subjectId",
    "sourceRevision",
    "sourceUrl",
    "evidence",
    "actorId",
    "occurredAt",
    "state",
    "discussionFeedback",
  ]);
  const metadata = parseDiscussionFeedbackObservation(fact.discussionFeedback);
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const expected = `gdf1:${metadata.fingerprint}.${hash(
    JSON.stringify([
      discussionFeedbackContentVersion,
      metadata.authorityHash,
      metadata.coverageEpoch,
      metadata.generation,
      metadata.scanId,
    ]),
  ).slice(0, 32)}`;
  if (
    family !== "discussions" ||
    fact.evidence !== "current_state" ||
    fact.actorId !== null ||
    fact.occurredAt !== null ||
    fact.state !== "present" ||
    fact.subjectId !== metadata.descriptor.discussionId ||
    fact.sourceUrl !== metadata.descriptor.threadUrl ||
    metadata.fingerprint !== hash(encodeDiscussionFeedbackDescriptor(metadata.descriptor)) ||
    fact.sourceRevision !== expected
  )
    throw new Error("invalid_discussion_feedback_source_fact");
  return metadata;
}
