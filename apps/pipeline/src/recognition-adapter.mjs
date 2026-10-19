import { createHash } from "node:crypto";
import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import { domainDateBasis, qualifyDomainRecognition } from "./domain-recognition.mjs";
import { localizationReviewRequest, parseLocalizationReviewTarget } from "../../controls/src/localization-review.mjs";
import { hasRequiredParticipantConsent, hasReviewedParticipantConsent } from "../../controls/src/evidence-consent.mjs";

// Private controls only. Never accept a public claim projection as authentication.
export function recognitionFingerprint(state, bindings = []) {
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
  // Version the target/clock authority and include exact current bindings. An old
  // unbound locale publication cannot remain authorized after this correction.
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  // Retire old authority for participant-bearing or malformed consent records.
  // An explicit empty collaborator set keeps its unchanged prior semantics.
  if (requests.some((request) => !hasRequiredParticipantConsent(request) || Object.keys(request.collaborators).length))
    authority.push("required-participant-consent/v1");
  // Earlier generic data-quality receipts did not qualify correction provenance.
  // Retire their publication authority without changing unaffected bindings.
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  // Generic reproduction receipts had no scenario/environment/result boundary.
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // Earlier generic bug receipts admitted non-issue and explicitly synthetic sources.
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Earlier answer receipts could precede their known source occurrence. Retire
  // only configurations whose destination is affected by that missing bound.
  if (bindings.some((binding) => binding.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
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
  const domainUnits = new Set();
  const domainReasons = new Map();
  const decisionTime = (request) => {
    const at = request.history?.findLast((event) => event.action === "accepted")?.at;
    const time = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
    return Number.isFinite(time) ? time : Infinity;
  };
  // Only eligible request kinds participate in canonical receipt ordering.
  // Invalid accepted clocks sort last and still fail validation below; they
  // cannot make the comparator non-transitive or silently disappear.
  const requests = Object.values(state.requests ?? {})
    .filter(
      (request) =>
        request.status === "accepted" &&
        hasReviewedParticipantConsent(request) &&
        !state.profiles?.[request.owner]?.suppressed,
    )
    .sort((a, b) => {
      const at = decisionTime(a),
        bt = decisionTime(b);
      return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  for (const request of requests) {
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
          (domainDateBasis(binding.metricId) !== null
            ? p.policy.dateBasis === domainDateBasis(binding.metricId) &&
              p.policy.groupBy === "canonical" &&
              p.policy.rankedStates?.length === 1 &&
              p.policy.rankedStates[0] === "qualified"
            : binding.metricId === "localization"
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
    if (
      typeof decision.at === "number" &&
      (!Number.isSafeInteger(decision.at) || decision.at < 0 || !Number.isFinite(new Date(decision.at).getTime()))
    )
      throw new Error("recognition_decision_time_invalid");
    const acceptedAt = typeof decision.at === "number" ? new Date(decision.at).toISOString() : decision.at;
    if (
      typeof acceptedAt !== "string" ||
      !Number.isFinite(Date.parse(acceptedAt)) ||
      new Date(acceptedAt).toISOString() !== acceptedAt
    )
      throw new Error("recognition_decision_time_invalid");
    if (acceptedAt > cutoff) continue;
    let localeTarget = null;
    if (localeReasons !== null) {
      // Earlier generic receipts did not record the reviewed locale/revision.
      // Keep their source observation, but never reinterpret them as locale acceptance.
      if (decision.localization === undefined) continue;
      if (
        decision.receipt !== request.id ||
        !Number.isSafeInteger(request.version) ||
        request.version < 1 ||
        decision.version !== request.version ||
        JSON.stringify(decision.evidenceRequest) !== JSON.stringify(localizationReviewRequest(request))
      )
        throw new Error("recognition_decision_unverified");
      try {
        localeTarget = parseLocalizationReviewTarget(decision.localization);
      } catch {
        throw new Error("recognition_decision_unverified");
      }
      if (
        localeTarget.locale !== binding.localization.locale ||
        localeTarget.category !== binding.localization.category ||
        localeTarget.policyVersion !== binding.localization.policyVersion
      )
        continue;
    }
    const candidates = input.facts.filter(
      (f) =>
        f.actorId === request.owner &&
        f.repoId === binding.repositoryId &&
        f.metricId === binding.sourceMetricId &&
        (localeTarget === null ||
          (f.id === localeTarget.targetFactId &&
            f.state === "observed" &&
            typeof f.occurredAt === "string" &&
            Number.isFinite(Date.parse(f.occurredAt)) &&
            Date.parse(f.occurredAt) <= Date.parse(acceptedAt))) &&
        input.evidence.some(
          (e) =>
            e.contribution.contributionId === f.id &&
            e.artifact.publicUrl === request.locator &&
            e.artifact.visibility === "public" &&
            (localeTarget === null ||
              (e.sourceRevision === localeTarget.sourceRevision && e.occurredAt === f.occurredAt)) &&
            (localeReasons === null || JSON.stringify(publicReasons(e.contribution)) === JSON.stringify(localeReasons)),
        ),
    );
    if (!candidates.length) continue;
    if (candidates.length !== 1) throw new Error("ambiguous_recognition_target");
    // Check after uniqueness: chronology must not silently select one of two
    // matching facts. Unknown source time supplies no invented lower bound.
    const sourceTime = candidates[0].occurredAt;
    if (
      binding.metricId === "issue_answers" &&
      typeof sourceTime === "string" &&
      sourceEventSchema.shape.occurredAt.safeParse(sourceTime).success &&
      compareSourceInstants(sourceTime, acceptedAt) > 0
    )
      throw new Error("recognition_source_time_invalid");
    if (binding.metricId === "confirmed_bugs") {
      const target = candidates[0];
      const evidence = input.evidence.filter((entry) => entry.contribution.contributionId === target.id);
      const proof = evidence[0];
      // Check before calling even a host-supplied receipt adapter. Combined
      // inputs retain synthetic provenance per fact, not as one global flag.
      if (
        input.isSynthetic === true ||
        (input.syntheticFactIds ?? []).includes(target.id) ||
        binding.sourceMetricId !== "issues_opened" ||
        !target.artifactId ||
        evidence.length !== 1 ||
        proof.artifact.kind !== "issue" ||
        proof.artifact.stableId !== target.artifactId ||
        proof.contribution.artifactId !== target.artifactId ||
        proof.artifact.repositoryId !== target.repoId ||
        proof.contribution.actorId !== target.actorId
      )
        throw new Error("recognition_source_unverified");
    }
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
        ...(localeTarget ? { sourceRevision: localeTarget.sourceRevision } : {}),
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
    entry.contribution.reasonCodes = [
      ...(domainReasons.get(entry.contribution.contributionId) ?? ["independent_recognition_receipt"]),
      ...publicReasons(entry.contribution),
    ];
  return output;
}
