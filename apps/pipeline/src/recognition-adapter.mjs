import {
  validateWorkstreamHelpBindings,
  qualifyWorkstreamHelp,
  verifyWorkstreamHelpConsistency,
  bindWorkstreamHelp,
  materializedWorkstreamHelp,
} from "./workstream-help.mjs";
import { createHash } from "node:crypto";
import {
  compareSourceInstants,
  sourceEventSchema,
  maintenanceClassificationVersion,
  documentationPurposeVersion,
  acceptedFeedbackThreadsVersion,
  workstreamHelpVersion,
} from "@pick-your-ai/contracts";
import {
  validateAutomationSource,
  validateMaintenanceSource,
  validateReleaseChangesSource,
  registerOrderingPlan,
  validateReleaseStewardshipSource,
} from "@pick-your-ai/github";
import {
  qualifyMaintenanceClassification,
  validateMaintenanceClassificationBinding,
} from "./maintenance-classification.mjs";
import { qualifyDocumentationPurpose, validateDocumentationPurposeBinding } from "./documentation-purpose.mjs";
import { qualifyHelpfulFeedback, validateHelpfulFeedbackBinding } from "./helpful-feedback.mjs";
import {
  domainDateBasis,
  qualifyDomainRecognition,
  hasSparseDomainIdentifierAuthority,
} from "./domain-recognition.mjs";
import { verifyProjectConfigurationConsistency } from "./project-configuration-recognition.mjs";
import { localizationReviewRequest, parseLocalizationReviewTarget } from "../../controls/src/localization-review.mjs";
import { releaseReviewRequest, parseReleaseReviewTarget } from "../../controls/src/release-review.mjs";
import { hasRequiredParticipantConsent, hasReviewedParticipantConsent } from "../../controls/src/evidence-consent.mjs";
import {
  evidenceIntakeAuthority,
  hasConsentedEvidenceIntake,
  hasReviewedEvidenceIntake,
} from "../../controls/src/evidence-intake.mjs";

// Private controls only. Never accept a public claim projection as authentication.
export function recognitionFingerprint(state, bindings = []) {
  const helpBindings = validateWorkstreamHelpBindings(bindings);
  // An unsupported opt-in cannot keep an old saved hash current without rematerialization.
  for (const binding of bindings) {
    validateMaintenanceClassificationBinding(binding);
    validateDocumentationPurposeBinding(binding);
    validateHelpfulFeedbackBinding(binding);
  }
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
  if (helpBindings.size) authority.push(workstreamHelpVersion);
  // Retire old authority for participant-bearing or malformed consent records.
  // An explicit empty collaborator set keeps its unchanged prior semantics.
  if (requests.some((request) => !hasRequiredParticipantConsent(request) || Object.keys(request.collaborators).length))
    authority.push("required-participant-consent/v1");
  // Earlier generic data-quality receipts did not qualify correction provenance.
  // Retire their publication authority without changing unaffected bindings.
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  // Generic reproduction receipts had no scenario/environment/result boundary.
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // Earlier generic Project receipts did not bind a typed before/after change set.
  // Without a manual request there is no receipt to retire; preserve automatic authority.
  if (requests.length && bindings.some((binding) => binding.metricId === "project_configuration"))
    authority.push("project-configuration-evidence/v1");
  // Earlier generic bug receipts admitted non-issue and explicitly synthetic sources.
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Earlier answer receipts could precede their known source occurrence. Retire
  // only configurations whose destination is affected by that missing bound.
  if (bindings.some((binding) => binding.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  // Prior maintenance receipts lacked merged-participant, clock and unit admission.
  if (bindings.some((binding) => binding.metricId === "maintenance"))
    authority.push("maintenance-merged-participant/v1");
  // Retire only explicitly opted-in classification authority. Generic maintenance
  // and every unrelated binding keep their exact established fingerprint format.
  if (bindings.some((binding) => binding.metricId === "maintenance" && binding.maintenanceClassification !== undefined))
    authority.push(maintenanceClassificationVersion);
  if (bindings.some((binding) => binding.documentationPurpose !== undefined))
    authority.push(documentationPurposeVersion);
  // Tooling receipts independently require verified merged participation as well.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  // Older generic operations receipts lack the current source, public artifact
  // and affected-owner evidence boundary. Unrelated configurations stay exact.
  if (bindings.some((binding) => ["governance", "deployment_work", "incidents"].includes(binding.metricId)))
    authority.push("operations-contribution-evidence/v1");
  // Retire generic receipts and the earlier pre-collection release observation authority.
  if (bindings.some((binding) => binding.metricId === "release_changes"))
    authority.push("release-inclusion-recognition/v2");
  // Even an empty current intake must retire the former generic ordering authority.
  if (bindings.some((binding) => binding.metricId === "issue_ordering")) authority.push("reviewed-ordering-plan/v1");
  if (bindings.some((binding) => binding.metricId === "helpful_feedback"))
    authority.push(acceptedFeedbackThreadsVersion);
  // Earlier same-metric receipts lacked original publication/clock/unit admission.
  // Retire only this destination; unrelated source and receipt authority stay exact.
  if (bindings.some((binding) => binding.metricId === "release_stewardship"))
    authority.push("release-stewardship-publication/v1");
  // Missing legacy intake cannot keep manual recognition current, even without collaborators.
  // No-manual-request automatic source authority keeps its existing exact format.
  if (requests.length) authority.push(evidenceIntakeAuthority());
  // A validator-only upgrade cannot revoke a previously confirmed result. Fence
  // only selected unsafe lists; valid and unrelated authority bytes stay exact.
  if (
    bindings.some((binding) =>
      requests.some(
        (request) =>
          request.status === "accepted" &&
          !state.profiles?.[request.owner]?.suppressed &&
          binding.category === request.category &&
          binding.scope === request.scope &&
          binding.policyVersion === request.policyVersion &&
          hasSparseDomainIdentifierAuthority(binding, request) &&
          hasReviewedParticipantConsent(request) &&
          hasConsentedEvidenceIntake(request) &&
          hasReviewedEvidenceIntake(request),
      ),
    )
  )
    authority.push("domain-id-list-admission/v1");
  // Earlier comparison receipts allowed mutable or equivalent before/after revisions.
  // Require recomputation for these destinations while unrelated authority stays exact.
  if (bindings.some((binding) => ["performance", "regressions_prevented"].includes(binding.metricId)))
    authority.push("comparison-revision-pins/v1");
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
  let helpBindings = validateWorkstreamHelpBindings(bindings);
  if (
    helpBindings.size ||
    bindings.some((binding) => ["issue_ordering", "helpful_feedback"].includes(binding.metricId))
  ) {
    // Freeze the invocation before any host receipt callback can change a later
    // source, claim, scope enrollment or policy used by this same evaluation.
    input = structuredClone(input);
    state = structuredClone(state);
    bindings = structuredClone(bindings);
    policies = structuredClone(policies);
    if (helpBindings.size) helpBindings = validateWorkstreamHelpBindings(bindings);
  }
  for (const binding of bindings) validateDocumentationPurposeBinding(binding);
  for (const binding of bindings) validateHelpfulFeedbackBinding(binding);
  // Invocation snapshots may preserve aliases between bindings or source
  // records. A callback gets detached arguments, never an authority reference
  // that it could mutate before a later request is admitted.
  const invokeReceipt = (current, receipt, reviewers) =>
    applyReceipt(current, structuredClone(receipt), structuredClone(reviewers));
  const recognitionReasons = (contribution) => structuredClone(publicReasons(structuredClone(contribution)));
  let output = structuredClone(input);
  const workstreamHelpJobs = [];
  const workstreamHelpUnits = new Map();
  const domainUnits = new Set();
  const projectChangesets = new Map();
  const projectArtifacts = new Map();
  const mergedChangeUnits = new Set();
  const releaseMemberships = new Set();
  const stewardshipUnits = new Set();
  const domainReasons = new Map();
  const reviewedOperationArtifacts = new Map();
  const orderingPlans = new Map();
  const orderingJobs = [];
  const feedbackJobs = [];
  const feedbackUnits = new Set();
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
        hasConsentedEvidenceIntake(request) &&
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
      localeReasons = recognitionReasons({
        metricIds: ["localization"],
        reasonCodes: [
          `documentation_path_policy:${locale.policyVersion}`,
          `locale:${locale.locale}`,
          `localization_category:${locale.category}`,
        ],
      });
      if (localeReasons.length !== 3) throw new Error("invalid_localization_binding");
    }
    const requiredDateBasis = ["maintenance", "automation", "release_changes", "release_stewardship"].includes(
      binding.metricId,
    )
      ? "occurredAt"
      : binding.metricId === "helpful_feedback"
        ? "acceptedAt"
        : domainDateBasis(binding.metricId);
    if (
      !policies.some(
        (p) =>
          p.policy.metricId === binding.metricId &&
          p.policy.version === binding.policyVersion &&
          (binding.metricId !== "helpful_feedback" ||
            (p.policy.aggregation === "count" &&
              p.policy.groupingPolicyVersion === acceptedFeedbackThreadsVersion &&
              p.policy.roles?.length === 1 &&
              p.policy.roles[0] === "author")) &&
          (binding.metricId !== "release_changes" ||
            (p.policy.groupingPolicyVersion === "release-inclusion-units/v1" &&
              p.policy.roles?.length === 1 &&
              p.policy.roles[0] === "author")) &&
          (requiredDateBasis !== null
            ? p.policy.dateBasis === requiredDateBasis &&
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
    if (!hasReviewedEvidenceIntake(request)) continue;
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
    let releaseTarget = null;
    if (binding.metricId === "release_changes") {
      try {
        releaseTarget = parseReleaseReviewTarget(decision.releaseInclusion);
        const configured = parseReleaseReviewTarget(binding.releaseInclusion);
        if (
          JSON.stringify(releaseTarget) !== JSON.stringify(configured) ||
          releaseTarget.policyVersion !== binding.policyVersion ||
          binding.sourceMetricId !== "pr_merged" ||
          decision.receipt !== request.id ||
          !Number.isSafeInteger(request.version) ||
          request.version < 1 ||
          decision.version !== request.version ||
          JSON.stringify(decision.evidenceRequest) !== JSON.stringify(releaseReviewRequest(request))
        )
          throw new Error();
      } catch {
        throw new Error("release_inclusion_review_unverified");
      }
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
            (localeReasons === null ||
              JSON.stringify(recognitionReasons(e.contribution)) === JSON.stringify(localeReasons)),
        ),
    );
    if (!candidates.length) {
      if (
        binding.metricId === "helpful_feedback" &&
        input.discussionFeedbackRepositoryIds?.includes(Number(binding.repositoryId))
      )
        throw new Error("discussion_feedback_source_unverified");
      continue;
    }
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
    const feedback = qualifyHelpfulFeedback({
      input,
      request,
      decision,
      binding,
      candidate: candidates[0],
      acceptedAt,
      cutoff,
    });
    if (feedback) {
      // Every alias has passed the original/current observation, audit, policy,
      // consent and clock boundary before any helpful-feedback host callback.
      // Only then does accepted-time ordering choose one author/thread receipt.
      if (!feedbackUnits.has(feedback.unit)) {
        feedbackUnits.add(feedback.unit);
        feedbackJobs.push({ feedback, decision, binding, request, target: candidates[0], acceptedAt });
      }
      continue;
    }
    // Validate source authority before even a host-supplied receipt callback.
    const mergedChange =
      binding.metricId === "maintenance"
        ? validateMaintenanceSource(input, candidates[0].id, acceptedAt)
        : binding.metricId === "automation"
          ? validateAutomationSource(input, candidates[0].id, acceptedAt)
          : null;
    const stewardship =
      binding.metricId === "release_stewardship"
        ? validateReleaseStewardshipSource(input, candidates[0].id, acceptedAt)
        : null;
    const maintenanceClassification = qualifyMaintenanceClassification({
      input,
      binding,
      request,
      decision,
      candidate: candidates[0],
      acceptedAt,
    });
    const release = releaseTarget
      ? validateReleaseChangesSource(input, candidates[0].id, acceptedAt, releaseTarget)
      : null;
    if (release && compareSourceInstants(release.observedAt, cutoff) > 0)
      throw new Error("release_inclusion_source_unverified");
    const domain = qualifyDomainRecognition({
      input,
      request,
      decision,
      binding,
      candidate: candidates[0],
      acceptedAt,
      cutoff,
    });
    const documentationPurpose = qualifyDocumentationPurpose({
      input,
      binding,
      request,
      decision,
      candidate: candidates[0],
      acceptedAt,
      domain,
    });
    if (documentationPurpose) domain.publicReasonCodes.push("documentation_purpose:release_notes");
    const workstreamHelp = qualifyWorkstreamHelp({
      input,
      state,
      request,
      decision,
      binding,
      candidate: candidates[0],
      acceptedAt,
      cutoff,
      configured: helpBindings.get(binding),
    });
    verifyWorkstreamHelpConsistency(workstreamHelp, workstreamHelpUnits);
    if (workstreamHelp) workstreamHelpJobs.push({ help: workstreamHelp, metricId: binding.metricId });
    if (domain?.reviewedArtifact) {
      const { url, hash } = domain.reviewedArtifact;
      const previous = reviewedOperationArtifacts.get(url);
      if (previous !== undefined && previous !== hash) throw new Error("domain_recognition_evidence_unverified");
      reviewedOperationArtifacts.set(url, hash);
    }
    if (domain?.ordering) {
      // Validate every plan and alias before awarding any ordering unit. A
      // conflicting later alias cannot hide behind an earlier deduplication.
      if (!registerOrderingPlan(orderingPlans, domain.ordering))
        orderingJobs.push({ domain, decision, binding, request, target: candidates[0], acceptedAt });
      continue;
    }
    if (domain) {
      verifyProjectConfigurationConsistency(domain, projectChangesets, projectArtifacts);
      const unit = JSON.stringify([request.owner, domain.changesetId]);
      if (domainUnits.has(unit)) continue;
      domainUnits.add(unit);
    }
    if (mergedChange) {
      // Every repeated receipt still passes policy, audit and source validation.
      // Deterministic accepted-time ordering retains the earliest valid authority.
      if (mergedChangeUnits.has(mergedChange.unit)) continue;
      mergedChangeUnits.add(mergedChange.unit);
    }
    if (stewardship) {
      // Each request has passed current intake, audit and original-source checks.
      // Accepted-time ordering keeps the earliest valid receipt for this unit.
      if (stewardshipUnits.has(stewardship.unit)) continue;
      stewardshipUnits.add(stewardship.unit);
    }
    if (release) {
      // Validate each review and proof before selecting a repeated membership.
      if (releaseMemberships.has(release.membershipUnit)) continue;
      releaseMemberships.add(release.membershipUnit);
    }
    const previousFacts = output.facts.length;
    const previousEvidence = output.evidence.length;
    output = invokeReceipt(
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
        ...(releaseTarget ? { releaseInclusion: releaseTarget } : {}),
        ...(maintenanceClassification ? { maintenanceClassification } : {}),
        ...(documentationPurpose
          ? { documentationPurpose: documentationPurpose.purpose, sourceRevision: documentationPurpose.sourceRevision }
          : {}),
      },
      binding.reviewerIds,
    );
    if (maintenanceClassification) {
      const reasons = [
        "independent_recognition_receipt",
        `maintenance_classification_policy:${maintenanceClassificationVersion}`,
        ...maintenanceClassification.classifications.map(({ kind }) => `maintenance_kind:${kind}`),
      ];
      for (const evidence of output.evidence.slice(previousEvidence))
        domainReasons.set(evidence.contribution.contributionId, reasons);
    }
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
    if (workstreamHelp && workstreamHelp.sourceAcceptance.decisionId === decision.id)
      bindWorkstreamHelp(workstreamHelp, output.facts.slice(previousFacts), output.evidence.slice(previousEvidence));
  }
  for (const { feedback, decision, binding, request, target, acceptedAt } of feedbackJobs) {
    output = invokeReceipt(
      output,
      {
        id: decision.id,
        verified: true,
        targetFactId: target.id,
        metricId: "helpful_feedback",
        actorId: request.owner,
        reviewerId: decision.actor,
        acceptedAt,
        decision: "accepted",
        evidenceIds: [target.id],
        helpfulFeedback: feedback.review,
      },
      binding.reviewerIds,
    );
  }
  for (const { domain, decision, binding, request, target, acceptedAt } of orderingJobs) {
    const previousEvidence = output.evidence.length;
    output = invokeReceipt(
      output,
      {
        id: decision.id,
        verified: true,
        targetFactId: target.id,
        metricId: "issue_ordering",
        actorId: request.owner,
        reviewerId: decision.actor,
        acceptedAt,
        decision: "accepted",
        evidenceIds: [target.id],
        ordering: domain.ordering,
        orderingAuthority: domain.orderingAuthority,
      },
      binding.reviewerIds,
    );
    for (const evidence of output.evidence.slice(previousEvidence))
      domainReasons.set(evidence.contribution.contributionId, domain.publicReasonCodes);
  }
  // Audit receipt identifiers remain private even when the normalizer annotates evidence.
  for (const entry of output.evidence.slice(input.evidence.length))
    entry.contribution.reasonCodes = [
      ...(domainReasons.get(entry.contribution.contributionId) ?? ["independent_recognition_receipt"]),
      ...recognitionReasons(entry.contribution),
    ];
  if (helpBindings.size) {
    const help = materializedWorkstreamHelp(
      workstreamHelpJobs,
      output.facts.slice(input.facts.length),
      output.evidence.slice(input.evidence.length),
    );
    output.reviewedWorkstreamHelp = help.records;
    // Private, invocation-local dependencies; the runtime never publishes these identifiers.
    output.workstreamHelpSourceDecisions = help.sourceDecisions;
  }
  return output;
}
