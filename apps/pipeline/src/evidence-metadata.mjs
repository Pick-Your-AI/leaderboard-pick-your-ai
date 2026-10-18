import { publicEvidenceMetadataSchema } from "@pick-your-ai/contracts";

/** Materialize only from the selected metric fact. Private receipt IDs/reviewers stay upstream. */
export function materializeEvidenceMetadata(original, fact) {
  if (original.evidenceMetadata === undefined) return {};
  const metadata = publicEvidenceMetadataSchema.parse(original.evidenceMetadata);
  const accepted =
    ["qualified", "reviewed"].includes(fact.state) &&
    typeof fact.acceptanceReceipt === "string" &&
    fact.acceptanceReceipt.trim() &&
    typeof fact.acceptedBy === "string" &&
    fact.acceptedBy.trim() &&
    fact.acceptedBy !== fact.actorId &&
    !(fact.subjectActorId === fact.actorId && fact.role === "reviewer");
  if (["qualified", "reviewed"].includes(fact.state) && (!accepted || !fact.acceptedAt))
    throw new Error("public_acceptance_requires_independent_receipt");
  const activityState = accepted ? "accepted" : ["observed", "pending"].includes(fact.state) ? fact.state : "unknown";
  return {
    evidenceMetadata: publicEvidenceMetadataSchema.parse({
      ...metadata,
      sourceOccurredAt: fact.occurredAt,
      observedAt: fact.observedAt,
      activityState,
      acceptedAt: accepted ? fact.acceptedAt : null,
      sourceAction: accepted
        ? "recognition_accepted"
        : metadata.sourceAction === "recognition_accepted"
          ? "unknown"
          : metadata.sourceAction,
    }),
  };
}

/** Same fact may be recollected under a new title/revision. Select deterministically;
 * never call the chosen label the event-time title, or synthesize a revision log. */
export function selectEvidenceMetadata(previous, entry) {
  if (!previous) return entry;
  const before =
    previous.evidenceMetadata === undefined ? null : publicEvidenceMetadataSchema.parse(previous.evidenceMetadata);
  const after =
    entry.evidenceMetadata === undefined ? null : publicEvidenceMetadataSchema.parse(entry.evidenceMetadata);
  if (!before) return after ? entry : previous;
  if (!after) return previous;
  const semantic = (value) =>
    JSON.stringify([value.sourceAction, value.sourceOccurredAt, value.activityState, value.acceptedAt]);
  if (semantic(before) !== semantic(after)) throw new Error("conflicting_evidence_metadata");
  const difference = Date.parse(after.observedAt) - Date.parse(before.observedAt);
  if (difference === 0 && JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("conflicting_evidence_metadata");
  return difference > 0 ? entry : previous;
}
