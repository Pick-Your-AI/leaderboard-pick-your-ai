// Explicit synthetic positive prerequisites for tests of independent boundaries.
// These receipts are never real source-use evidence or public activation authority.
import {
  createEvidenceIntake,
  createSourceUseReview,
  evidenceTerms,
  participantConsent,
} from "../../apps/controls/src/evidence-intake.mjs";

export function syntheticEvidenceIntakeInput(collaboratorIds = [], overrides = {}) {
  const terms = evidenceTerms();
  return {
    schemaVersion: "evidence-intake/v1",
    termsVersion: terms.version,
    termsDigest: terms.digest,
    sourceUseBasis: {
      state: "declared",
      statement: "Synthetic fixture: source-use permission supplied for this reviewed example only.",
    },
    roles: { submitter: null, collaborators: Object.fromEntries(collaboratorIds.map((id) => [id, null])) },
    period: { kind: "unknown" },
    ...overrides,
  };
}

export function syntheticSourceUseReviewInput(overrides = {}) {
  return {
    disposition: "permitted",
    rationale: "Synthetic independent review: the bounded example is permitted for this optional public claim.",
    references: [
      {
        locator: "https://github.com/synthetic-org/synthetic-repo/blob/main/permission.md",
        revision: "synthetic-reviewed-permission-v1",
      },
    ],
    ...overrides,
  };
}

export function attachSyntheticEvidenceIntake(request, options = {}) {
  if (request.kind !== "evidence") return request;
  const decision = request.history?.findLast((event) => event.action === "accepted");
  const rawTime = decision?.at;
  const reviewedAt = typeof rawTime === "number" ? rawTime : typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
  const at =
    options.at ??
    (Number.isFinite(reviewedAt) && reviewedAt >= 2 ? reviewedAt - 2 : Date.parse("2026-10-17T00:00:00Z"));
  request.detail ??= "Synthetic protected review detail.";
  request.version ??= decision?.version ?? 1;
  request.intake = createEvidenceIntake(
    request,
    syntheticEvidenceIntakeInput(Object.keys(request.collaborators), options.intake),
    at,
  );
  for (const [id, choice] of Object.entries(request.collaborators))
    if (["accepted", "declined"].includes(choice))
      request.intake.participantConsents[id] = participantConsent(request, id, choice, at + 1);
  if (decision) {
    decision.version ??= request.version;
    decision.receipt ??= request.id;
    decision.sourceReviewedPublic = true;
    decision.conflict = false;
    decision.sourceUseReview = createSourceUseReview(request, syntheticSourceUseReviewInput(options.sourceUseReview), {
      actorId: decision.actor,
      roleVersion: options.roleVersion ?? "synthetic-reviewer-authority/v1",
      at: Number.isFinite(reviewedAt) ? reviewedAt : at + 2,
      policyVersion: request.policyVersion,
    });
  }
  return request;
}

export function attachSyntheticEvidenceState(state, options = {}) {
  for (const request of Object.values(state.requests ?? {})) {
    attachSyntheticEvidenceIntake(request, options);
    if (request.kind !== "evidence") continue;
    const decision = request.history?.findLast((event) => event.action === "accepted");
    if (!decision) continue;
    state.audit = (state.audit ?? []).map((event) => (event.id === decision.id ? structuredClone(decision) : event));
  }
  return state;
}
