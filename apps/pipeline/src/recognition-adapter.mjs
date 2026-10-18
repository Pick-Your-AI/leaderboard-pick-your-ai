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

export function materializeRecognition(input, state, bindings, policies, applyReceipt, cutoff) {
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
    if (
      !policies.some(
        (p) =>
          p.policy.metricId === binding.metricId &&
          p.policy.version === binding.policyVersion &&
          p.policy.dateBasis === "acceptedAt",
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
    if (decision.at > cutoff) continue;
    const candidates = input.facts.filter(
      (f) =>
        f.actorId === request.owner &&
        f.repoId === binding.repositoryId &&
        f.metricId === binding.sourceMetricId &&
        input.evidence.some(
          (e) =>
            e.contribution.contributionId === f.id &&
            e.artifact.publicUrl === request.locator &&
            e.artifact.visibility === "public",
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
        acceptedAt: decision.at,
        decision: "accepted",
        evidenceIds: [candidates[0].id],
      },
      binding.reviewerIds,
    );
  }
  // Audit receipt identifiers remain private even when the normalizer annotates evidence.
  for (const entry of output.evidence.slice(input.evidence.length))
    entry.contribution.reasonCodes = ["independent_recognition_receipt"];
  return output;
}
