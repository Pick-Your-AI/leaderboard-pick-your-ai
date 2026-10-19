export interface Session {
  actorId: string;
  csrf: string;
  roles: string[];
  expires: number;
}
export interface EvidenceTerms {
  schemaVersion: "evidence-terms/v1";
  version: string;
  rightsPolicyVersion: string;
  paragraphs: string[];
  digest: string;
}
export type EvidencePeriod =
  { kind: "unknown" } | { kind: "date"; date: string } | { kind: "interval"; start: string; end: string };
export interface EvidenceIntakeInput {
  schemaVersion: "evidence-intake/v1";
  termsVersion: string;
  termsDigest: string;
  sourceUseBasis: { state: "unresolved" } | { state: "declared"; statement: string };
  roles: { submitter: string | null; collaborators: Record<string, string | null> };
  period: EvidencePeriod;
}
export interface EvidenceConsentRecord {
  actorId: string;
  choice: "accepted" | "declined";
  scope: "public-claim-attribution";
  claimRevision: number;
  claimDigest: string;
  role: string | null;
  termsVersion: string;
  termsDigest: string;
  rightsPolicyVersion: string;
  at: number;
}
export interface StoredEvidenceIntake extends EvidenceIntakeInput {
  rightsPolicyVersion: string;
  claimRevision: number;
  claimDigest: string;
  submitterConsent: EvidenceConsentRecord;
  participantConsents: Record<string, EvidenceConsentRecord>;
}
export interface IntakeEligibility {
  state:
    | "updated_intake_required"
    | "participant_consent_required"
    | "awaiting_review"
    | "source_use_review_required"
    | "eligible";
}
export interface EvidenceInvitation {
  id: string;
  version: number;
  locator: string;
  category: string;
  scope: string;
  consent: string;
  claimRevision: number | null;
  claimDigest: string | null;
  participantIds: string[];
  role: string | null;
  period: EvidencePeriod | null;
  sourceUseState: "unresolved" | "declared" | "unknown";
  terms: EvidenceTerms | null;
  intakeEligibility: IntakeEligibility;
}
export interface EvidenceSubmissionFields {
  locator: string;
  category: string;
  scope: string;
  detail: string;
  collaborators: string[];
  consent: true;
  intake: EvidenceIntakeInput;
}
export interface SourceUseReviewInput {
  disposition: "permitted";
  rationale: string;
  references: Array<{ locator: string; revision: string }>;
}
export type FieldErrors = Record<string, string>;
type FormResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };
export interface Receipt {
  id: string;
  owner: string;
  kind: string;
  status: string;
  version: number;
  detail: string;
  locator?: string;
  category?: string;
  scope?: string;
  policyVersion?: string;
  collaborators?: Record<string, string>;
  intake?: StoredEvidenceIntake | null;
  intakeEligibility?: IntakeEligibility;
  history: Array<{ actor: string; action: string; [key: string]: unknown }>;
}
export class ControlsFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401
        ? "Your session ended. Sign in again."
        : status === 403
          ? "Access denied. Your authority or session may have changed."
          : status === 409
            ? "The receipt or policy changed. Reload before trying again."
            : "The controls service could not complete this request. No success has been confirmed.",
    );
    this.status = status;
  }
}
/** Same-origin controls only. Never reuse the public API base URL or persist CSRF tokens. */
export async function control<T>(path: string, session?: Session, input?: unknown): Promise<T> {
  if (
    !/^\/controls\/(evidence-terms|policy-comparisons(?:\/(?:inputs|[a-f0-9]{64}))?|operations\/[1-9][0-9]{0,15}(?:\/(?:replay|replay-window(?:\/preview)?|health|replays\/[A-Za-z0-9_-]{1,128}))?|spotlight-rotation(?:\/(?:queue|[a-f0-9-]{36}))?|spotlights(?:\/(?:queue|[a-f0-9-]{36}))?|session|logout|sessions\/revoke|profile(?:\/suppression)?|requests(?:\/[a-f0-9-]{36}(?:\/(review|appeal|withdraw|consent|amend))?)?|invitations|configuration(?:\/(?:proposals(?:\/[a-f0-9-]{36}(?:\/(?:preview|approve|activate))?)?|rollback))?)$/.test(
      path,
    )
  )
    throw new Error("Unsupported controls route");
  if (input !== undefined && (!session || session.expires <= Date.now())) throw new ControlsFailure(401);
  const response = await fetch(path, {
    method: input === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers:
      input === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": session!.csrf },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  if (!response.ok) throw new ControlsFailure(response.status);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Controls service unavailable.");
  if (!response.body) throw new Error("Missing controls response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error("Controls response exceeds the supported size.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as T;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export function verifiedSession(value: Session): Session {
  if (
    !value ||
    typeof value.actorId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.actorId) ||
    typeof value.csrf !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.csrf) ||
    !Array.isArray(value.roles) ||
    !value.roles.every((r) => ["operator", "reviewer", "privacy"].includes(r)) ||
    !Number.isSafeInteger(value.expires) ||
    value.expires <= Date.now()
  )
    throw new Error("Invalid or expired controls session.");
  return value;
}
export function canReview(receipt: Receipt, session: Session): boolean {
  return (
    receipt.owner !== session.actorId &&
    !Object.hasOwn(receipt.collaborators ?? {}, session.actorId) &&
    session.roles.includes(["privacy", "identity"].includes(receipt.kind) ? "privacy" : "reviewer") &&
    !["withdrawn", "merged", "applied"].includes(receipt.status)
  );
}

export function verifiedEvidenceTerms(value: unknown): EvidenceTerms {
  const terms = value as EvidenceTerms | null;
  if (
    !terms ||
    terms.schemaVersion !== "evidence-terms/v1" ||
    typeof terms.version !== "string" ||
    !terms.version.trim() ||
    typeof terms.rightsPolicyVersion !== "string" ||
    !terms.rightsPolicyVersion.trim() ||
    typeof terms.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(terms.digest) ||
    !Array.isArray(terms.paragraphs) ||
    terms.paragraphs.length === 0 ||
    !terms.paragraphs.every((paragraph) => typeof paragraph === "string" && paragraph.trim())
  )
    throw new Error("Evidence terms are unavailable. Reload before giving new consent.");
  return terms;
}

/** A local affordance only; the service rechecks authority, consent and source-use review on every decision. */
export function canAcceptEvidence(receipt: Receipt): boolean {
  return (
    receipt.kind === "evidence" &&
    ["pending", "appealed"].includes(receipt.status) &&
    receipt.intake?.schemaVersion === "evidence-intake/v1" &&
    Number.isSafeInteger(receipt.intake.claimRevision) &&
    receipt.intake.claimRevision > 0 &&
    /^[a-f0-9]{64}$/.test(receipt.intake.claimDigest) &&
    receipt.intakeEligibility?.state === "awaiting_review"
  );
}

export function safeEvidenceLocator(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate displayed input without fetching a locator or inventing unknown roles, dates or rights. */
export function evidenceSubmissionInput(
  data: FormData,
  terms: EvidenceTerms | null,
  actorId: string,
  categories: readonly string[],
): FormResult<EvidenceSubmissionFields> {
  const errors: FieldErrors = {};
  const value = (name: string) => String(data.get(name) ?? "").trim();
  const required = (name: string, maximum: number, message: string) => {
    const result = value(name);
    if (!result || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result))
      errors[name] = message;
    return result;
  };
  const locator = value("locator");
  if (!safeEvidenceLocator(locator)) errors.locator = "Enter a public HTTPS GitHub artifact URL, without credentials.";
  const category = value("category");
  if (!categories.includes(category)) errors.category = "Choose a contribution category.";
  const scope = required("scope", 300, "Enter a public claim summary of up to 300 characters.");
  const detail = required("detail", 2000, "Enter private review details of up to 2,000 characters.");
  const collaborators = value("collaborators")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (
    collaborators.length > 20 ||
    collaborators.some((id) => !/^[1-9][0-9]{0,19}$/.test(id) || id === actorId) ||
    new Set(collaborators).size !== collaborators.length
  )
    errors.collaborators = "List up to 20 different GitHub numeric IDs. Do not repeat your own verified ID.";
  const role = (name: string) => {
    if (value(`${name}Choice`) === "unknown") return null;
    if (value(`${name}Choice`) !== "described") {
      errors[`${name}Choice`] = "Choose unknown or describe this participant's role.";
      return null;
    }
    return required(name, 200, "Describe the proposed role in up to 200 characters, or choose unknown.");
  };
  const roles = {
    submitter: role("submitterRole"),
    collaborators: Object.fromEntries(collaborators.map((id) => [id, role(`participantRole-${id}`)])),
  };
  let period: EvidencePeriod = { kind: "unknown" };
  if (value("periodKind") === "date") {
    const date = value("periodDate");
    if (!validDate(date)) errors.periodDate = "Enter a real calendar date.";
    period = { kind: "date", date };
  } else if (value("periodKind") === "interval") {
    const start = value("periodStart"),
      end = value("periodEnd");
    if (!validDate(start)) errors.periodStart = "Enter a real start date.";
    if (!validDate(end) || (validDate(start) && end < start))
      errors.periodEnd = "Enter a real end date on or after the start date.";
    period = { kind: "interval", start, end };
  } else if (value("periodKind") !== "unknown") errors.periodKind = "Choose unknown, a date or an interval.";
  let sourceUseBasis: EvidenceIntakeInput["sourceUseBasis"] = { state: "unresolved" };
  if (value("sourceUseState") === "declared")
    sourceUseBasis = {
      state: "declared",
      statement: required("sourceUseStatement", 1000, "Describe your source-use basis in up to 1,000 characters."),
    };
  else if (value("sourceUseState") !== "unresolved")
    errors.sourceUseState = "Choose a declared or unresolved source-use basis.";
  if (!terms) errors.consent = "Current evidence terms are unavailable. Reload before giving new consent.";
  else if (data.get("consent") !== "on") errors.consent = "Review the displayed terms and choose whether to consent.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      locator,
      category,
      scope,
      detail,
      collaborators,
      consent: true,
      intake: {
        schemaVersion: "evidence-intake/v1",
        termsVersion: terms!.version,
        termsDigest: terms!.digest,
        sourceUseBasis,
        roles,
        period,
      },
    },
  };
}

export function sourceUseReviewInput(data: FormData): FormResult<SourceUseReviewInput> {
  const errors: FieldErrors = {};
  const rationale = String(data.get("sourceUseRationale") ?? "").trim();
  if (!rationale || rationale.length > 1000)
    errors.sourceUseRationale = "Record the actual source-use review in up to 1,000 characters.";
  const references: SourceUseReviewInput["references"] = [];
  for (let index = 0; index < 5; index++) {
    const locator = String(data.get(`reviewLocator-${index}`) ?? "").trim();
    const revision = String(data.get(`reviewRevision-${index}`) ?? "").trim();
    if (!locator && !revision && index > 0) continue;
    if (!safeEvidenceLocator(locator))
      errors[`reviewLocator-${index}`] = "Enter the reviewed public HTTPS GitHub artifact URL.";
    if (!revision || revision.length > 128)
      errors[`reviewRevision-${index}`] = "Identify the revision you actually reviewed, in up to 128 characters.";
    references.push({ locator, revision });
  }
  if (data.get("sourceUsePermitted") !== "on")
    errors.sourceUsePermitted = "Confirm your separate source-use decision before accepting evidence.";
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, value: { disposition: "permitted", rationale, references } };
}
