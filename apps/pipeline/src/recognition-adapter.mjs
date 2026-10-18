import { createHash } from "node:crypto";
import { domainDateBasis, qualifyDomainRecognition } from "./domain-recognition.mjs";

// Private controls only. Never accept a public claim projection as authentication.
export function recognitionFingerprint(state) {
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  const decisionIds = new Set(
    requests.flatMap((r) => (r.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id)),
  );
  // A receipt's current audit entry is part of the authority used below. Fence
  // publication and pinned reads when it disappears, changes or is duplicated.
  const audit = (state.audit ?? [])
    .filter((event) => decisionIds.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([requests, suppressed, audit]))
    .digest("hex");
}

export function materializeRecognition(input, state, bindings, policies, applyReceipt, cutoff) {
  let output = structuredClone(input);
  const domainUnits = new Set();
  const domainReasons = new Map();
  const decisionTime = (request) => {
    const at = request.history?.findLast((event) => event.action === "accepted")?.at;
    return typeof at === "number" ? at : Date.parse(at);
  };
  const requests = Object.values(state.requests ?? {}).sort(
    (a, b) => decisionTime(a) - decisionTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const request of requests) {
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
          (domainDateBasis(binding.metricId) !== null
            ? p.policy.dateBasis === domainDateBasis(binding.metricId) &&
              p.policy.groupBy === "canonical" &&
              p.policy.rankedStates?.length === 1 &&
              p.policy.rankedStates[0] === "qualified"
            : p.policy.dateBasis === "acceptedAt" ||
              (binding.metricId === "decision_records" &&
                binding.sourceMetricId === "decision_records" &&
                p.policy.dateBasis === "occurredAt" &&
                p.policy.groupBy === "actor_artifact")),
      )
    )
      throw new Error("recognition_policy_not_configured");
    const decision = request.history?.findLast((h) => h.action === "accepted");
    const audited = (state.audit ?? []).filter((h) => h.id === decision?.id);
    if (
      !decision ||
      decision.actor === request.owner ||
      Object.hasOwn(request.collaborators ?? {}, decision.actor) ||
      !binding.reviewerIds?.includes(decision.actor) ||
      decision.policyVersion !== binding.policyVersion ||
      audited.length !== 1 ||
      JSON.stringify(audited[0]) !== JSON.stringify(decision)
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
            e.artifact.visibility === "public",
        ),
    );
    if (!candidates.length) continue;
    if (candidates.length !== 1) throw new Error("ambiguous_recognition_target");
    const domain = qualifyDomainRecognition({
      input,
      request,
      decision,
      binding,
      candidate: candidates[0],
      acceptedAt,
      cutoff,
    });
    if (domain) {
      const unit = JSON.stringify([request.owner, domain.changesetId]);
      if (domainUnits.has(unit)) continue;
      domainUnits.add(unit);
    }
    const previousFacts = output.facts.length;
    const previousEvidence = output.evidence.length;
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
        ...(domain ? { changesetId: domain.changesetId } : {}),
      },
      binding.reviewerIds,
    );
    if (domain) {
      // Preserve each registry's event clock; acceptance remains independently
      // recorded. Never substitute the later review time for a merge or recheck.
      if (domain.dateBasis === "occurredAt")
        for (const fact of output.facts.slice(previousFacts)) fact.occurredAt = domain.occurredAt;
      for (const evidence of output.evidence.slice(previousEvidence)) {
        evidence.occurredAt = domain.occurredAt;
        domainReasons.set(evidence.contribution.contributionId, domain.publicReasonCodes);
      }
    }
  }
  // Audit receipt identifiers remain private even when the normalizer annotates evidence.
  for (const entry of output.evidence.slice(input.evidence.length))
    entry.contribution.reasonCodes = domainReasons.get(entry.contribution.contributionId) ?? [
      "independent_recognition_receipt",
    ];
  return output;
}
