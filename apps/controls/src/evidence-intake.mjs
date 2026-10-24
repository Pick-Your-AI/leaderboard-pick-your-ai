import { createHash } from "node:crypto";
import { bindOrderingReview } from "@pick-your-ai/github";
import { hasRequiredParticipantConsent } from "./evidence-consent.mjs";
import {
  externalTutorialIntakeVersion,
  externalTutorialTerms,
  isExternalTutorialIntake,
  parseExternalTutorialDeclaration,
} from "./external-tutorial-intake.mjs";

const schemaVersion = "evidence-intake/v1";
const consentScope = "public-claim-attribution";
const rightsPolicyVersion = "2026-10-18";
const termsContent = Object.freeze({
  schemaVersion: "evidence-terms/v1",
  version: "evidence-terms/2026-10-19",
  rightsPolicyVersion,
  paragraphs: Object.freeze([
    "This choice covers only the optional claim shown here. After independent acceptance, its source reference, category, public claim summary and permitted account attribution may appear in public recognition.",
    "The proposed roles and contribution dates are review inputs. Unknown roles or dates stay unknown. Submitting evidence or agreeing to attribution does not itself award credit, verify source-use permission or approve an editorial spotlight.",
    "Private evidence details, source-use statements and review references, individual roles, consent records and private decision reasons remain in the protected review workflow. They are not part of this form's public claim projection.",
    "Each listed participant makes their own choice. You may decline or withdraw this optional attribution. Withdrawal removes the affected optional claim and derived recognition from service-controlled public views; retained-data deletion is a separate process and can remain pending. Account-level privacy choices still apply.",
    "These terms do not promise a retention duration or a deletion deadline. The service needs its approved retention settings and responsible operator before it accepts real evidence in a public deployment. Missing settings do not authorize indefinite retention.",
    "Withdrawal from this service cannot delete the upstream GitHub artifact or copies already downloaded by third parties. Separate eligible source facts and editorial participation keep their own rules and choices.",
  ]),
});
const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    return item;
  });
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const terms = Object.freeze({ ...termsContent, digest: digest(termsContent) });
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  plain(value) && Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
const boundedText = (value, maximum) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const isActor = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const decisionTime = (value) =>
  time(value) ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const same = (a, b) => canonical(a) === canonical(b);
const validDate = (value) => {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000"))
    return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const validPeriod = (period) =>
  (keys(period, ["kind"]) && period.kind === "unknown") ||
  (keys(period, ["kind", "date"]) && period.kind === "date" && validDate(period.date)) ||
  (keys(period, ["kind", "start", "end"]) &&
    period.kind === "interval" &&
    validDate(period.start) &&
    validDate(period.end) &&
    period.start <= period.end);

/** A fresh copy prevents callers from changing the reviewed display terms. */
export function evidenceTerms() {
  return structuredClone(terms);
}

/** This authority deliberately includes legacy manual records, including owner-only claims. */
export function evidenceIntakeAuthority() {
  return ["manual-evidence-intake/v1", terms.version, terms.digest, rightsPolicyVersion];
}

const inputKeys = ["schemaVersion", "termsVersion", "termsDigest", "sourceUseBasis", "roles", "period"];
export function parseEvidenceIntake(value, participantIds, context) {
  const external = isExternalTutorialIntake(value);
  const selectedTerms = external ? externalTutorialTerms() : terms;
  if (
    !keys(value, external ? [...inputKeys, "externalTutorial"] : inputKeys) ||
    value.schemaVersion !== (external ? externalTutorialIntakeVersion : schemaVersion) ||
    value.termsVersion !== selectedTerms.version ||
    value.termsDigest !== selectedTerms.digest ||
    !Array.isArray(participantIds) ||
    participantIds.length > 20 ||
    participantIds.some((id) => !isActor(id)) ||
    new Set(participantIds).size !== participantIds.length ||
    !keys(value.roles, ["submitter", "collaborators"]) ||
    !keys(value.roles.collaborators, participantIds) ||
    ![value.roles.submitter, ...Object.values(value.roles.collaborators)].every(
      (role) => role === null || boundedText(role, 200),
    ) ||
    !validPeriod(value.period)
  )
    return null;
  const basis = value.sourceUseBasis;
  if (!(
    (keys(basis, ["state"]) && basis.state === "unresolved") ||
    (keys(basis, ["state", "statement"]) && basis.state === "declared" && boundedText(basis.statement, 1000))
  ))
    return null;
  const parsed = {
    schemaVersion: external ? externalTutorialIntakeVersion : schemaVersion,
    termsVersion: selectedTerms.version,
    termsDigest: selectedTerms.digest,
    sourceUseBasis:
      basis.state === "unresolved" ? { state: "unresolved" } : { state: "declared", statement: basis.statement.trim() },
    roles: {
      submitter: value.roles.submitter?.trim() ?? null,
      collaborators: Object.fromEntries(
        [...participantIds].sort().map((id) => [id, value.roles.collaborators[id]?.trim() ?? null]),
      ),
    },
    period: structuredClone(value.period),
  };
  if (external) {
    const declaration = parseExternalTutorialDeclaration(value.externalTutorial, {
      ...context,
      participantIds,
      roles: parsed.roles,
    });
    if (!declaration) return null;
    parsed.externalTutorial = declaration;
  }
  return parsed;
}

function claimDigest(request, intake) {
  if (isExternalTutorialIntake(intake))
    return digest([
      "evidence-claim/external-tutorial/v1",
      request.id,
      request.owner,
      request.locator,
      request.category,
      request.scope,
      Object.keys(request.collaborators).sort(),
      intake.period,
      intake.termsVersion,
      intake.termsDigest,
      rightsPolicyVersion,
      intake.claimRevision,
      intake.externalTutorial,
    ]);
  return digest([
    "evidence-claim/v1",
    request.id,
    request.owner,
    request.locator,
    request.category,
    request.scope,
    Object.keys(request.collaborators).sort(),
    intake.period,
    intake.termsVersion,
    intake.termsDigest,
    rightsPolicyVersion,
    intake.claimRevision,
  ]);
}

function reviewedInputDigest(request) {
  return digest([
    "evidence-reviewed-input/v1",
    request.intake.claimDigest,
    request.detail,
    request.intake.sourceUseBasis,
    request.intake.roles,
  ]);
}

/** Receipt identities and clocks come from authenticated server state, never the input body. */
export function participantConsent(request, actor, choice, at) {
  const intake = request.intake;
  return {
    actorId: actor,
    choice,
    scope: consentScope,
    claimRevision: intake.claimRevision,
    claimDigest: intake.claimDigest,
    role: actor === request.owner ? intake.roles.submitter : intake.roles.collaborators[actor],
    termsVersion: intake.termsVersion,
    termsDigest: intake.termsDigest,
    rightsPolicyVersion,
    at,
  };
}

export function createEvidenceIntake(request, input, at, previousIntake) {
  const parsed = parseEvidenceIntake(input, Object.keys(request.collaborators), request);
  if (!parsed || !isActor(request.owner) || !time(at)) throw new TypeError("Invalid evidence intake authority");
  const previousRevision =
    Number.isSafeInteger(previousIntake?.claimRevision) && previousIntake.claimRevision > 0
      ? previousIntake.claimRevision
      : 0;
  if (previousRevision === Number.MAX_SAFE_INTEGER) throw new TypeError("Evidence claim revision exhausted");
  const intake = { ...parsed, rightsPolicyVersion, claimRevision: previousRevision + 1, participantConsents: {} };
  intake.claimDigest = claimDigest(request, intake);
  const current = { ...request, intake };
  intake.submitterConsent = participantConsent(current, request.owner, "accepted", at);
  // A carried decline stays the same historical choice, with its original scope/time.
  // Prior affirmative receipts remain only in the protected amendment history.
  for (const [id, choice] of Object.entries(request.collaborators))
    if (choice === "declined" && previousIntake?.participantConsents?.[id]?.choice === "declined")
      intake.participantConsents[id] = structuredClone(previousIntake.participantConsents[id]);
  return intake;
}

function supportedIntake(request) {
  const intake = request?.intake;
  if (
    request?.kind !== "evidence" ||
    !isActor(request.owner) ||
    !plain(request.collaborators) ||
    !boundedText(request.id, 200) ||
    !boundedText(request.locator, 2048) ||
    !boundedText(request.category, 100) ||
    !boundedText(request.scope, 300) ||
    !boundedText(request.detail, 2000) ||
    Object.hasOwn(request.collaborators, request.owner) ||
    !Object.values(request.collaborators).every((choice) => ["pending", "accepted", "declined"].includes(choice)) ||
    !keys(intake, [
      ...inputKeys,
      ...(isExternalTutorialIntake(intake) ? ["externalTutorial"] : []),
      "rightsPolicyVersion",
      "claimRevision",
      "claimDigest",
      "submitterConsent",
      "participantConsents",
    ]) ||
    intake.rightsPolicyVersion !== rightsPolicyVersion ||
    !Number.isSafeInteger(intake.claimRevision) ||
    intake.claimRevision < 1 ||
    !plain(intake.participantConsents) ||
    Object.keys(intake.participantConsents).some((id) => !Object.hasOwn(request.collaborators, id))
  )
    return false;
  const selectedKeys = isExternalTutorialIntake(intake) ? [...inputKeys, "externalTutorial"] : inputKeys;
  const input = Object.fromEntries(selectedKeys.map((key) => [key, intake[key]]));
  const parsed = parseEvidenceIntake(input, Object.keys(request.collaborators), request);
  return parsed !== null && same(parsed, input) && intake.claimDigest === claimDigest(request, intake);
}

const consentKeys = [
  "actorId",
  "choice",
  "scope",
  "claimRevision",
  "claimDigest",
  "role",
  "termsVersion",
  "termsDigest",
  "rightsPolicyVersion",
  "at",
];
function validConsent(request, actor, record, choice = "accepted") {
  return (
    keys(record, consentKeys) && time(record.at) && same(record, participantConsent(request, actor, choice, record.at))
  );
}

export function hasCurrentEvidenceConsent(request, actor, choice = "accepted") {
  return (
    supportedIntake(request) &&
    (actor === request.owner || Object.hasOwn(request.collaborators, actor)) &&
    validConsent(
      request,
      actor,
      actor === request.owner ? request.intake.submitterConsent : request.intake.participantConsents[actor],
      choice,
    )
  );
}

export function hasConsentedEvidenceIntake(request) {
  return (
    supportedIntake(request) &&
    hasRequiredParticipantConsent(request) &&
    validConsent(request, request.owner, request.intake.submitterConsent) &&
    Object.keys(request.collaborators).every((id) => validConsent(request, id, request.intake.participantConsents[id]))
  );
}

function referenceLocator(value) {
  if (!boundedText(value, 2048)) return null;
  try {
    const url = new URL(value.trim());
    // The same bounded GitHub-only, no-fetch shape as the existing evidence locator.
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.+/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseSourceUseReview(value) {
  if (
    !keys(value, ["disposition", "rationale", "references"]) ||
    value.disposition !== "permitted" ||
    !boundedText(value.rationale, 1000) ||
    !Array.isArray(value.references) ||
    value.references.length < 1 ||
    value.references.length > 5 ||
    value.references.some(
      (reference) =>
        !keys(reference, ["locator", "revision"]) ||
        referenceLocator(reference.locator) === null ||
        !boundedText(reference.revision, 128),
    )
  )
    return null;
  return {
    disposition: "permitted",
    rationale: value.rationale.trim(),
    references: value.references.map((reference) => ({
      locator: referenceLocator(reference.locator),
      revision: reference.revision.trim(),
    })),
  };
}

export function createSourceUseReview(request, input, { actorId, roleVersion, at, policyVersion }) {
  const parsed = parseSourceUseReview(input);
  if (!parsed) throw new TypeError("Invalid source-use review");
  return {
    ...parsed,
    reviewerId: actorId,
    roleVersion,
    reviewedAt: at,
    scope: consentScope,
    claimRevision: request.intake.claimRevision,
    claimDigest: request.intake.claimDigest,
    reviewedInputDigest: reviewedInputDigest(request),
    termsVersion: request.intake.termsVersion,
    termsDigest: request.intake.termsDigest,
    rightsPolicyVersion,
    policyVersion,
    sourceReviewedPublic: true,
    conflict: false,
  };
}

export function hasReviewedEvidenceIntake(request) {
  // Consent capture cannot activate an unimplemented tutorial qualifier, even for a forged accepted record.
  if (isExternalTutorialIntake(request?.intake)) return false;
  if (!hasConsentedEvidenceIntake(request) || !Number.isSafeInteger(request.version) || request.version < 1)
    return false;
  const decision = Array.isArray(request.history)
    ? request.history.findLast((event) => event?.action === "accepted")
    : null;
  const review = decision?.sourceUseReview;
  const at = decisionTime(decision?.at);
  if (
    !decision ||
    decision.version !== request.version ||
    decision.receipt !== request.id ||
    !isActor(decision.actor) ||
    decision.actor === request.owner ||
    Object.hasOwn(request.collaborators, decision.actor) ||
    decision.policyVersion !== request.policyVersion ||
    !boundedText(request.policyVersion, 100) ||
    decision.sourceReviewedPublic !== true ||
    decision.conflict !== false ||
    !plain(review) ||
    !time(at) ||
    !boundedText(review.roleVersion, 200) ||
    request.intake.submitterConsent.at > at ||
    Object.values(request.intake.participantConsents).some((consent) => consent.at > at)
  )
    return false;
  const parsed = parseSourceUseReview({
    disposition: review.disposition,
    rationale: review.rationale,
    references: review.references,
  });
  if (request.category === "ordering") {
    try {
      if (!parsed) return false;
      bindOrderingReview(decision.ordering, request, parsed.references);
    } catch {
      return false;
    }
  } else if (decision.ordering !== undefined) return false;
  return (
    parsed !== null &&
    same(
      review,
      createSourceUseReview(request, parsed, {
        actorId: decision.actor,
        roleVersion: review.roleVersion,
        at,
        policyVersion: request.policyVersion,
      }),
    )
  );
}

export function evidenceIntakeEligibility(request) {
  if (!supportedIntake(request) || !validConsent(request, request.owner, request.intake.submitterConsent))
    return { state: "updated_intake_required" };
  if (!hasConsentedEvidenceIntake(request)) return { state: "participant_consent_required" };
  if (isExternalTutorialIntake(request.intake)) return { state: "external_tutorial_qualification_unavailable" };
  if (request.status !== "accepted") return { state: "awaiting_review" };
  return { state: hasReviewedEvidenceIntake(request) ? "eligible" : "source_use_review_required" };
}

/** Malformed legacy containers cannot grant another account invitation access. */
export function isEvidenceParticipant(request, actor) {
  return (
    request?.kind === "evidence" &&
    isActor(actor) &&
    plain(request.collaborators) &&
    Object.hasOwn(request.collaborators, actor)
  );
}

/** Invitees see their proposed claim and role, not the full protected receipt. */
export function projectEvidenceInvitation(request, actor, externalTutorialConsent = false) {
  const supported = supportedIntake(request);
  const external = isExternalTutorialIntake(request.intake);
  return {
    id: request.id,
    version: request.version,
    locator: request.locator,
    category: request.category,
    scope: request.scope,
    consent: request.collaborators[actor],
    claimRevision: supported ? request.intake.claimRevision : null,
    claimDigest: supported ? request.intake.claimDigest : null,
    participantIds: [request.owner, ...Object.keys(request.collaborators)].sort(),
    role: supported ? request.intake.roles.collaborators[actor] : null,
    period: supported ? structuredClone(request.intake.period) : null,
    sourceUseState: supported ? request.intake.sourceUseBasis.state : "unknown",
    terms: supported ? (external ? externalTutorialTerms() : evidenceTerms()) : null,
    intakeEligibility: evidenceIntakeEligibility(request),
    ...(external
      ? {
          externalTutorial: supported ? structuredClone(request.intake.externalTutorial) : null,
          externalTutorialConsentEnabled: externalTutorialConsent === true,
        }
      : {}),
  };
}

/** This derived view does not rewrite legacy status or historical audit. */
export function protectedEvidenceRequest(request) {
  return request.kind === "evidence" ? { ...request, intakeEligibility: evidenceIntakeEligibility(request) } : request;
}
