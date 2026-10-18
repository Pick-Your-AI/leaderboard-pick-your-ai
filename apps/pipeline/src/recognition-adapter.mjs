import { createHash } from "node:crypto";

// Private controls only. Never accept a public claim projection as authentication.
export function recognitionFingerprint(state) {
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([requests, suppressed]))
    .digest("hex");
}

export function materializeRecognition(
  input,
  state,
  bindings,
  policies,
  applyReceipt,
  cutoff,
  publicReasons = () => [],
) {
  let output = structuredClone(input);
  for (const request of Object.values(state.requests ?? {})) {
    if (request.kind !== "evidence" || request.status !== "accepted" || state.profiles?.[request.owner]?.suppressed)
      continue;
    const matches = bindings.filter(
      (b) => b.category === request.category && b.scope === request.scope && b.policyVersion === request.policyVersion,
    );
    if (!matches.length) continue;
    if (matches.length !== 1) throw new Error("ambiguous_recognition_binding");
    const binding = matches[0];
    let localeReasons = null;
    if (
      binding.metricId === "localization" ||
      binding.sourceMetricId === "localization" ||
      binding.localization !== undefined
    ) {
      const locale = binding.localization;
      if (
        binding.metricId !== "localization" ||
        binding.sourceMetricId !== "localization" ||
        !locale ||
        typeof locale !== "object" ||
        Array.isArray(locale) ||
        Object.keys(locale).sort().join(",") !== "category,locale,policyVersion" ||
        ![locale.policyVersion, locale.locale, locale.category].every((value) => typeof value === "string")
      )
        throw new Error("invalid_localization_binding");
      localeReasons = publicReasons({
        metricIds: ["localization"],
        reasonCodes: [
          `documentation_path_policy:${locale.policyVersion}`,
          `locale:${locale.locale}`,
          `localization_category:${locale.category}`,
        ],
      });
      if (localeReasons.length !== 3) throw new Error("invalid_localization_binding");
    }
    if (
      !policies.some(
        (p) =>
          p.policy.metricId === binding.metricId &&
          p.policy.version === binding.policyVersion &&
          (binding.metricId === "localization"
            ? p.policy.dateBasis === "occurredAt"
            : p.policy.dateBasis === "acceptedAt" ||
              (binding.metricId === "decision_records" &&
                binding.sourceMetricId === "decision_records" &&
                p.policy.dateBasis === "occurredAt" &&
                p.policy.groupBy === "actor_artifact")),
      )
    )
      throw new Error("recognition_policy_not_configured");
    const decision = request.history?.findLast((h) => h.action === "accepted");
    if (
      !decision ||
      decision.actor === request.owner ||
      Object.hasOwn(request.collaborators ?? {}, decision.actor) ||
      !binding.reviewerIds?.includes(decision.actor) ||
      decision.policyVersion !== binding.policyVersion ||
      !state.audit?.some((h) => h.id === decision.id && JSON.stringify(h) === JSON.stringify(decision))
    )
      throw new Error("recognition_decision_unverified");
    // Controls records epoch milliseconds; normalizers require canonical UTC strings.
    const acceptedAt =
      typeof decision.at === "number" && Number.isSafeInteger(decision.at) && decision.at >= 0
        ? new Date(decision.at).toISOString()
        : decision.at;
    if (
      typeof acceptedAt !== "string" ||
      !Number.isFinite(Date.parse(acceptedAt)) ||
      new Date(acceptedAt).toISOString() !== acceptedAt
    )
      throw new Error("recognition_decision_time_invalid");
    if (acceptedAt > cutoff) continue;
    const candidates = input.facts.filter(
      (f) =>
        f.actorId === request.owner &&
        f.repoId === binding.repositoryId &&
        f.metricId === binding.sourceMetricId &&
        input.evidence.some(
          (e) =>
            e.contribution.contributionId === f.id &&
            e.artifact.publicUrl === request.locator &&
            e.artifact.visibility === "public" &&
            (localeReasons === null || JSON.stringify(publicReasons(e.contribution)) === JSON.stringify(localeReasons)),
        ),
    );
    if (!candidates.length) continue;
    if (candidates.length !== 1) throw new Error("ambiguous_recognition_target");
    output = applyReceipt(
      output,
      {
        id: decision.id,
        verified: true,
        targetFactId: candidates[0].id,
        metricId: binding.metricId,
        actorId: request.owner,
        reviewerId: decision.actor,
        acceptedAt,
        decision: "accepted",
        evidenceIds: [candidates[0].id],
      },
      binding.reviewerIds,
    );
  }
  // Audit receipt identifiers remain private even when the normalizer annotates evidence.
  for (const entry of output.evidence.slice(input.evidence.length))
    entry.contribution.reasonCodes = ["independent_recognition_receipt", ...publicReasons(entry.contribution)];
  return output;
}
