import { maintenanceClassificationVersion } from "@pick-your-ai/contracts";
import { validateMaintenanceClassification } from "@pick-your-ai/github";

const invalid = () => {
  throw new Error("maintenance_classification_unverified");
};

/** Validate every defined opt-in before either qualification or saved-read authority. */
export function validateMaintenanceClassificationBinding(binding) {
  const option = binding.maintenanceClassification;
  if (option === undefined) return false;
  if (
    binding.metricId !== "maintenance" ||
    !option ||
    typeof option !== "object" ||
    Array.isArray(option) ||
    Object.keys(option).join(",") !== "schemaVersion" ||
    option.schemaVersion !== maintenanceClassificationVersion
  )
    return invalid();
  return true;
}

/** Existing current intake authenticates the exact detail and review reference pairs.
 * This opt-in policy adds positive review facets, not automatic source classification.
 */
export function qualifyMaintenanceClassification({ input, binding, request, decision, candidate, acceptedAt }) {
  if (!validateMaintenanceClassificationBinding(binding)) return null;
  const detail = request.detail;
  // An existing narrative carries no positive subtype claim. Supplied JSON must be valid.
  if (typeof detail !== "string" || !/^[\s]*[\[{]/.test(detail)) return null;
  let value;
  try {
    value = JSON.parse(detail);
  } catch {
    return invalid();
  }
  const record = validateMaintenanceClassification(input, candidate.id, acceptedAt, value);
  if (
    detail.length > 2000 ||
    record.policyVersion !== binding.policyVersion ||
    record.policyVersion !== request.policyVersion ||
    record.policyVersion !== decision.policyVersion
  )
    return invalid();
  const reviewed = decision.sourceUseReview?.references;
  if (
    !Array.isArray(reviewed) ||
    record.classifications.some(({ references }) =>
      references.some(
        (reference) =>
          !reviewed.some((item) => item.locator === reference.locator && item.revision === reference.revision),
      ),
    )
  )
    return invalid();
  return record;
}
