import type { Contribution } from "./v1/schemas.js";

const reasons = [
  "domain_metric:reproductions",
  "domain_clock:accepted_at",
  "accepted_reproduction_scenario_not_bug_confirmation",
] as const;
const outcomes = ["domain_outcome:reproduced", "domain_outcome:not_reproduced", "domain_outcome:inconclusive"];

/** Copy the complete fixed explanation of an accepted reproduction scenario.
 * This confers no review authority and never certifies that a bug is confirmed.
 * Accepted/ranked projections require the explanation; raw work does not invent it.
 * An explicit nonaccepted context forbids retained acceptance markers; only an
 * omitted context may infer acceptance from the contribution's existing marker.
 */
export function publicReproductionRecognitionReasons(
  contribution: Pick<Contribution, "metricIds" | "reasonCodes">,
  accepted?: boolean,
): string[] {
  if (!contribution.metricIds.includes("reproductions")) return [];
  if (contribution.reasonCodes.length > 32) throw new Error("Reproduction explanation exceeds reason bound");
  const values = contribution.reasonCodes;
  const markedAccepted = values.some((value) =>
    ["independent_recognition_receipt", "public_accepted_work"].includes(value),
  );
  if (accepted === false && markedAccepted) throw new Error("Invalid accepted reproduction explanation");
  if (accepted !== true && !markedAccepted) return [];
  const outcome = values.filter((value) => value.startsWith("domain_outcome:"));
  if (
    contribution.metricIds.length !== 1 ||
    values.some((value) =>
      ["raw_observed_only", "public_observed_work", "public_pending_work", "public_unknown_work"].includes(value),
    ) ||
    !reasons.every((reason) => values.filter((value) => value === reason).length === 1) ||
    values.filter((value) => value.startsWith("domain_metric:")).length !== 1 ||
    values.filter((value) => value.startsWith("domain_clock:")).length !== 1 ||
    outcome.length !== 1 ||
    !outcomes.includes(outcome[0]!)
  )
    throw new Error("Invalid accepted reproduction explanation");
  return [...reasons, outcome[0]!];
}
