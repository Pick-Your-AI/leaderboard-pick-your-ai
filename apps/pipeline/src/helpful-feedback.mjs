import {
  acceptedFeedbackThreadsVersion,
  discussionFeedbackFields,
  parseAcceptedFeedbackThreadText,
} from "@pick-your-ai/contracts";
import { validateHelpfulFeedbackSource } from "@pick-your-ai/github";

/** Selecting this destination requires an explicit version and a single native
 * authorship source. Separate configured categories may select starts/answers. */
export function validateHelpfulFeedbackBinding(binding) {
  if (binding.metricId !== "helpful_feedback" && binding.helpfulFeedback === undefined) return;
  const selected = discussionFeedbackFields(binding.helpfulFeedback, ["version"]);
  if (
    binding.metricId !== "helpful_feedback" ||
    selected.version !== acceptedFeedbackThreadsVersion ||
    !["discussions_started", "discussion_answers"].includes(binding.sourceMetricId) ||
    typeof binding.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(binding.repositoryId) ||
    /[^0-9]/.test(binding.repositoryId) ||
    !Number.isSafeInteger(Number(binding.repositoryId))
  )
    throw new Error("invalid_helpful_feedback_binding");
}
export function qualifyHelpfulFeedback({ input, request, decision, binding, candidate, acceptedAt, cutoff }) {
  if (binding.metricId !== "helpful_feedback") return null;
  validateHelpfulFeedbackBinding(binding);
  let review;
  try {
    review = parseAcceptedFeedbackThreadText(request.detail);
  } catch {
    throw new Error("helpful_feedback_review_unverified");
  }
  if (
    review.actorId !== request.owner ||
    String(review.repositoryId) !== binding.repositoryId ||
    review.sourceMetricId !== binding.sourceMetricId ||
    review.threadUrl !== request.locator ||
    review.targetFactId !== candidate.id ||
    !Array.isArray(decision?.sourceUseReview?.references) ||
    decision.sourceUseReview.references.filter(
      (reference) => reference.locator === review.threadUrl && reference.revision === review.sourceRevision,
    ).length !== 1
  )
    throw new Error("helpful_feedback_review_unverified");
  return validateHelpfulFeedbackSource(input, candidate.id, acceptedAt, review, cutoff);
}
