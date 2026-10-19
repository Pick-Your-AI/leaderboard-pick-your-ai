import type { Contribution } from "./v1/schemas.js";

export const maintenanceClassificationVersion = "maintenance-classification/v1" as const;
export const maintenanceClassificationKinds = ["accepted_bug_fix", "build_fix", "dependency_maintenance"] as const;
export type MaintenanceClassificationKind = (typeof maintenanceClassificationKinds)[number];

/** A public explanation of already authenticated review, never new recognition authority.
 * Missing classification remains unknown; these positive facets do not add counted units.
 */
export function publicMaintenanceClassificationReasons(
  contribution: Pick<Contribution, "metricIds" | "reasonCodes">,
): string[] {
  const policy = contribution.reasonCodes.filter((reason) => reason.startsWith("maintenance_classification_policy:"));
  const kinds = contribution.reasonCodes.filter((reason) => reason.startsWith("maintenance_kind:"));
  if (!policy.length && !kinds.length) return [];
  const allowed = maintenanceClassificationKinds.map((kind) => `maintenance_kind:${kind}`);
  if (
    contribution.reasonCodes.length > 32 ||
    contribution.metricIds.length !== 1 ||
    contribution.metricIds[0] !== "maintenance" ||
    !contribution.reasonCodes.some((reason) =>
      ["independent_recognition_receipt", "public_accepted_work"].includes(reason),
    ) ||
    contribution.reasonCodes.some((reason) =>
      ["raw_observed_only", "public_observed_work", "public_pending_work", "public_unknown_work"].includes(reason),
    ) ||
    policy.length !== 1 ||
    policy[0] !== `maintenance_classification_policy:${maintenanceClassificationVersion}` ||
    kinds.length < 1 ||
    kinds.length > maintenanceClassificationKinds.length ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((reason) => !allowed.includes(reason))
  )
    throw new Error("Invalid maintenance classification");
  return [policy[0]!, ...kinds.sort()];
}
