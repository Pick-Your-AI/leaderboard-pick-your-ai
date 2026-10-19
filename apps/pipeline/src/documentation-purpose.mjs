import { documentationPurposeVersion } from "@pick-your-ai/contracts";
import { validateDocumentationPurposeSource } from "@pick-your-ai/github";

const invalid = () => {
  throw new Error("documentation_purpose_review_unverified");
};
const object = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    return invalid();
  return value;
};

/** A malformed opt-in cannot retain a previously saved publication fingerprint. */
export function validateDocumentationPurposeBinding(binding) {
  if (binding.documentationPurpose === undefined) return false;
  if (
    binding.metricId !== "documentation" ||
    binding.sourceMetricId !== "documentation" ||
    binding.documentationPurpose !== "release_notes"
  )
    return invalid();
  return true;
}

/** Current controls intake authenticates these exact private detail bytes and references.
 * The existing domain record supplies its separately reviewed documentation category.
 */
export function qualifyDocumentationPurpose({ input, binding, request, decision, candidate, acceptedAt, domain }) {
  if (!validateDocumentationPurposeBinding(binding)) return null;
  if (typeof request.detail !== "string" || !/^\s*[\[{]/.test(request.detail)) return null;
  if (request.detail.length > 2000) return invalid();
  let value;
  try {
    value = JSON.parse(request.detail);
  } catch {
    return invalid();
  }
  object(value, ["schemaVersion", "purpose", "targetFactId", "sourceRevision", "pathPolicyVersion", "details"]);
  const source = validateDocumentationPurposeSource(input, candidate.id, acceptedAt);
  if (
    value.schemaVersion !== documentationPurposeVersion ||
    value.purpose !== "release_notes" ||
    value.targetFactId !== candidate.id ||
    value.sourceRevision !== source.evidence.sourceRevision ||
    value.pathPolicyVersion !== source.pathPolicyVersion ||
    !domain ||
    domain.changesetId !== source.unit
  )
    return invalid();
  object(value.details, ["authorship", "category", "substantiveReview"]);
  if (
    value.details.authorship !== "authored" ||
    value.details.category !== "documentation" ||
    value.details.substantiveReview !== true
  )
    return invalid();
  const records = binding.domainEvidence.records.filter((record) => record.requestId === request.id);
  const record = records[0];
  if (
    records.length !== 1 ||
    !record ||
    record.factId !== candidate.id ||
    record.sourceRevision !== value.sourceRevision ||
    ["authorship", "category", "substantiveReview"].some((key) => record.details[key] !== value.details[key])
  )
    return invalid();
  const references = decision.sourceUseReview?.references;
  if (
    !Array.isArray(references) ||
    !references.some(
      (reference) =>
        reference.locator === source.evidence.sourceRevisionUrl &&
        reference.revision === source.evidence.sourceRevision,
    )
  )
    return invalid();
  return { purpose: "release_notes", sourceRevision: source.evidence.sourceRevision };
}
