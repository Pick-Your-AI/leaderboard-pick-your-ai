import { isProxy } from "node:util/types";
import {
  boundDocumentationReviewData,
  documentationReviewVersion,
  parseDocumentationReviewConfiguration,
  parseDocumentationReview,
  validateDocumentationReviewSource,
} from "@pick-your-ai/github";
import { compareSourceInstants, sourceEventSchema } from "@pick-your-ai/contracts";
import { hasReviewedParticipantConsent } from "../../controls/src/evidence-consent.mjs";
import { hasConsentedEvidenceIntake, hasReviewedEvidenceIntake } from "../../controls/src/evidence-intake.mjs";

const fail = () => {
  throw new TypeError("documentation_review_unverified");
};
const require = (condition) => {
  if (!condition) fail();
};

/** No extension means no new authority or fingerprint component. */
export function validateDocumentationReviewBindings(bindings) {
  const selected = [];
  for (const binding of bindings) {
    require(binding && typeof binding === "object" && !isProxy(binding));
    const descriptor = Object.getOwnPropertyDescriptor(binding, "documentationReview");
    if (!descriptor) continue;
    require(Object.hasOwn(descriptor, "value") && descriptor.enumerable);
    selected.push(binding);
  }
  if (!selected.length) return new Map();
  boundDocumentationReviewData(selected);
  const configured = new Map();
  for (const binding of selected) {
    const config = parseDocumentationReviewConfiguration(binding.documentationReview);
    require(
      binding.metricId === "evidence_reviews" &&
        binding.sourceMetricId === "review_rounds" &&
        binding.repositoryId === String(config.pathPolicy.repositoryId) &&
        Array.isArray(binding.reviewerIds) &&
        binding.reviewerIds.length > 0 &&
        binding.reviewerIds.length <= 100 &&
        binding.reviewerIds.every((id) => typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id)) &&
        new Set(binding.reviewerIds).size === binding.reviewerIds.length,
    );
    configured.set(binding, config);
  }
  return configured;
}

const time = (value) => {
  if (typeof value === "number") {
    require(Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()));
    return new Date(value).toISOString();
  }
  require(typeof value === "string" && sourceEventSchema.shape.observedAt.safeParse(value).success);
  require(new Date(value).toISOString() === value);
  return value;
};

/** Validate every current alias before any host receipt or public-reason callback. */
export function prepareDocumentationReviewJobs(input, state, bindings, configured, policies, cutoff) {
  if (!configured.size) return [];
  time(cutoff);
  const jobs = [];
  const meanings = new Map();
  for (const request of Object.values(state.requests ?? {})) {
    if (
      request.kind !== "evidence" ||
      request.status !== "accepted" ||
      state.profiles?.[request.owner]?.suppressed ||
      !hasReviewedParticipantConsent(request) ||
      !hasConsentedEvidenceIntake(request)
    )
      continue;
    const matches = bindings.filter(
      (binding) =>
        binding.category === request.category &&
        binding.scope === request.scope &&
        binding.policyVersion === request.policyVersion,
    );
    if (!matches.length) continue;
    require(matches.length === 1);
    const binding = matches[0];
    const config = configured.get(binding);
    if (!config) continue;
    const record = config.records.find((entry) => entry.requestId === request.id);
    if (!record) continue;
    // No exact current source means no participation, including another selected
    // repository scope. Present targets and all their aliases are checked below.
    if (!input.facts.some((fact) => fact.id === record.targetFactId)) continue;
    require(
      policies.some(
        ({ policy }) =>
          policy.metricId === "evidence_reviews" &&
          policy.version === binding.policyVersion &&
          policy.aggregation === "count" &&
          policy.dateBasis === "acceptedAt" &&
          policy.groupBy === "canonical" &&
          policy.rankedStates?.length === 1 &&
          policy.rankedStates[0] === "qualified" &&
          policy.roles?.length === 1 &&
          policy.roles[0] === "reviewer",
      ),
    );
    const decision = request.history?.findLast((entry) => entry.action === "accepted");
    const audits = (state.audit ?? []).filter((entry) => entry.id === decision?.id);
    require(
      decision &&
        decision.actor !== request.owner &&
        !Object.hasOwn(request.collaborators ?? {}, decision.actor) &&
        binding.reviewerIds.includes(decision.actor) &&
        decision.policyVersion === binding.policyVersion &&
        audits.length === 1 &&
        JSON.stringify(audits[0]) === JSON.stringify(decision),
    );
    const acceptedAt = time(decision.at);
    if (compareSourceInstants(acceptedAt, cutoff) > 0) continue;
    // A legacy generic approval has no current reviewed detail/consent authority.
    if (!hasReviewedEvidenceIntake(request)) continue;
    require(
      record.requestVersion === request.version &&
        record.decisionId === decision.id &&
        decision.version === request.version &&
        decision.receipt === request.id &&
        request.intake.roles.submitter === "reviewer" &&
        Object.keys(request.collaborators).length === 0 &&
        typeof request.detail === "string" &&
        request.detail.length <= 2000,
    );
    let review;
    try {
      review = parseDocumentationReview(JSON.parse(request.detail));
    } catch {
      fail();
    }
    const source = validateDocumentationReviewSource(input, record.targetFactId, acceptedAt, {
      pathPolicy: config.pathPolicy,
      checklist: config.checklist,
      record,
      review,
    });
    require(
      source.target.actorId === request.owner &&
        source.source.artifact.publicUrl === request.locator &&
        compareSourceInstants(source.target.observedAt, cutoff) <= 0 &&
        decision.sourceUseReview.references.filter(
          (reference) => reference.locator === source.revisionUrl && reference.revision === record.head,
        ).length === 1,
    );
    const previous = meanings.get(source.unit);
    require(previous === undefined || previous === source.sourceMeaning);
    meanings.set(source.unit, source.sourceMeaning);
    jobs.push({ source, request, decision, binding, acceptedAt });
  }
  jobs.sort(
    (left, right) =>
      compareSourceInstants(left.acceptedAt, right.acceptedAt) ||
      (left.request.id < right.request.id ? -1 : left.request.id > right.request.id ? 1 : 0),
  );
  const units = new Set();
  return jobs.filter(({ source }) => {
    if (units.has(source.unit)) return false;
    units.add(source.unit);
    return true;
  });
}

export { documentationReviewVersion };
