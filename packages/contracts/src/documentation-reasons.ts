import type { Contribution } from "./v1/schemas.js";

export const documentationPurposeVersion = "documentation-purpose/v1";

const documentationRecognitionReasons = [
  "domain_metric:documentation",
  "domain_clock:merged_at",
  "domain_authorship:authored",
] as const;

/** Preserve the complete fixed explanation of an accepted documentation unit.
 * This projection confers no authority and never invents missing recognition.
 * Keep it separate from the three-label locale classification contract.
 */
export function publicDocumentationRecognitionReasons(
  contribution: Pick<Contribution, "metricIds" | "reasonCodes">,
): string[] {
  const purposes = contribution.reasonCodes.filter((reason) => reason.startsWith("documentation_purpose:"));
  if (purposes.length) {
    const policies = contribution.reasonCodes.filter((reason) => reason.startsWith("documentation_path_policy:"));
    const domainPrefixes = ["domain_metric:", "domain_clock:", "domain_authorship:"];
    if (
      contribution.metricIds.length !== 1 ||
      contribution.metricIds[0] !== "documentation" ||
      purposes.length !== 1 ||
      purposes[0] !== "documentation_purpose:release_notes" ||
      policies.length !== 1 ||
      !/^documentation_path_policy:[A-Za-z0-9_.:-]{1,200}$/.test(policies[0]!) ||
      domainPrefixes.some((prefix, index) => {
        const values = contribution.reasonCodes.filter((reason) => reason.startsWith(prefix));
        return values.length !== 1 || values[0] !== documentationRecognitionReasons[index];
      }) ||
      !contribution.reasonCodes.some((reason) =>
        ["independent_recognition_receipt", "public_accepted_work"].includes(reason),
      ) ||
      contribution.reasonCodes.some((reason) =>
        ["raw_observed_only", "public_observed_work", "public_pending_work", "public_unknown_work"].includes(reason),
      )
    )
      throw new Error("Invalid documentation purpose explanation");
  }
  if (!contribution.metricIds.includes("documentation") || contribution.metricIds.includes("localization")) return [];
  if (contribution.reasonCodes.length > 32) throw new Error("Documentation explanation exceeds reason bound");
  if (
    !contribution.reasonCodes.some((reason) =>
      ["independent_recognition_receipt", "public_accepted_work"].includes(reason),
    ) ||
    !documentationRecognitionReasons.every(
      (reason) => contribution.reasonCodes.filter((value) => value === reason).length === 1,
    )
  )
    return [];
  return [...documentationRecognitionReasons, ...purposes];
}

/** Copy only the bounded, explicit documentation classification into public proof.
 * Internal acceptance, correction and actor-resolution reasons are never copied.
 * Legacy evidence with no classification remains readable without invented labels.
 */
export function publicDocumentationReasons(contribution: Pick<Contribution, "metricIds" | "reasonCodes">): string[] {
  if (!contribution.metricIds.some((metric) => metric === "documentation" || metric === "localization")) return [];
  if (contribution.reasonCodes.length > 32) throw new Error("Documentation classification exceeds reason bound");
  const prefixes = ["documentation_path_policy:", "locale:", "localization_category:"];
  const selected = prefixes.map((prefix) => contribution.reasonCodes.filter((reason) => reason.startsWith(prefix)));
  if (selected.every((reasons) => reasons.length === 0)) return [];
  if (selected.some((reasons) => reasons.length > 1)) throw new Error("Ambiguous documentation classification");
  const [policy, locale, category] = selected.map((reasons) => reasons[0]);
  if (!policy || !/^documentation_path_policy:[A-Za-z0-9_.:-]{1,200}$/.test(policy))
    throw new Error("Invalid documentation classification policy");
  if (!locale && !category && !contribution.metricIds.includes("localization")) return [policy];
  if (
    !contribution.metricIds.includes("localization") ||
    !locale ||
    !category ||
    !/^locale:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale) ||
    locale.length > 71 ||
    !/^localization_category:[a-z][a-z0-9_]{0,39}$/.test(category)
  )
    throw new Error("Invalid locale classification");
  const tag = locale.slice("locale:".length);
  const parsed = new Intl.Locale(tag);
  if (
    parsed.baseName !== tag ||
    Intl.getCanonicalLocales(tag)[0] !== tag ||
    ["und", "mul", "zxx"].includes(tag.split("-")[0]!)
  )
    throw new Error("Invalid locale classification");
  return [policy, locale, category];
}
