import React, { useId, useState } from "react";
import {
  verifiedEvidenceTerms,
  type EvidenceInvitation,
  type EvidencePeriod,
  type EvidenceTerms,
  type FieldErrors,
  type IntakeEligibility,
  type Receipt,
} from "./client.ts";

type InputAccessibility = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };
function currentIntake(receipt?: Receipt) {
  // The server preserves unsupported historical payloads. Only its current derived state establishes a usable shape.
  return receipt?.intake?.schemaVersion === "evidence-intake/v1" &&
    ["participant_consent_required", "awaiting_review", "source_use_review_required", "eligible"].includes(
      receipt.intakeEligibility?.state ?? "",
    )
    ? receipt.intake
    : null;
}
function IntakeField({
  name,
  label,
  errors,
  children,
}: {
  name: string;
  label: string;
  errors: FieldErrors;
  children: (attributes: InputAccessibility) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="control-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(errors[name] ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {}) })}
      {errors[name] && <p id={`${id}-error`}>{errors[name]}</p>}
    </div>
  );
}

/** Focus changes only follow an explicit invalid submission, never an asynchronous receipt refresh. */
export function useControlFormErrors() {
  const [errors, setErrors] = useState<FieldErrors>({});
  function showErrors(form: HTMLFormElement, next: FieldErrors) {
    setErrors(next);
    const first = Array.from(form.elements).find((element) => next[element.getAttribute("name") ?? ""]);
    if (first instanceof HTMLElement) {
      for (let parent = first.parentElement; parent; parent = parent.parentElement)
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      first.focus();
    }
  }
  return { errors, showErrors };
}

export function EvidenceTermsNotice({ terms }: { terms: EvidenceTerms | null }) {
  if (!terms) return <p>Current evidence terms are unavailable. Reload receipts before giving new consent.</p>;
  return (
    <fieldset>
      <legend>Evidence attribution terms</legend>
      <p>
        Terms: {terms.version}. Contributor-rights policy: {terms.rightsPolicyVersion}.
      </p>
      {terms.paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </fieldset>
  );
}

function RoleField({
  name,
  label,
  initial,
  errors,
}: {
  name: string;
  label: string;
  initial: string | null;
  errors: FieldErrors;
}) {
  const [choice, setChoice] = useState(initial === null ? "unknown" : "described");
  return (
    <>
      <IntakeField name={`${name}Choice`} label={`${label} knowledge`} errors={errors}>
        {(attributes) => (
          <select
            {...attributes}
            name={`${name}Choice`}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="unknown">Unknown — no role claimed</option>
            <option value="described">Describe the proposed role</option>
          </select>
        )}
      </IntakeField>
      {choice === "described" && (
        <IntakeField name={name} label={label} errors={errors}>
          {(attributes) => <input {...attributes} name={name} maxLength={200} defaultValue={initial ?? ""} />}
        </IntakeField>
      )}
    </>
  );
}

export function EvidenceIntakeFields({
  actorId,
  terms,
  categories,
  receipt,
  errors,
}: {
  actorId: string;
  terms: EvidenceTerms | null;
  categories: readonly string[];
  receipt?: Receipt;
  errors: FieldErrors;
}) {
  const initial = currentIntake(receipt);
  const [collaborators, setCollaborators] = useState(Object.keys(receipt?.collaborators ?? {}).join(", "));
  const [periodKind, setPeriodKind] = useState(initial?.period.kind ?? "unknown");
  const [sourceUseState, setSourceUseState] = useState(initial?.sourceUseBasis.state ?? "unresolved");
  const participantIds = [...new Set(collaborators.split(",").map((id) => id.trim()))]
    .filter((id) => /^[1-9][0-9]{0,19}$/.test(id) && id !== actorId)
    .slice(0, 20);
  return (
    <>
      {Object.keys(errors).length > 0 && <p role="alert">Check the marked fields. Nothing has been submitted.</p>}
      <p>
        The public source link, category, claim summary and proposed attribution below describe the claim you are
        submitting. Details and the source-use statement stay in the protected review workflow. Do not include private
        source content. Submission alone awards no accepted recognition.
      </p>
      <IntakeField
        name="locator"
        label={receipt ? "Amended public GitHub source URL" : "Public GitHub source URL"}
        errors={errors}
      >
        {(attributes) => (
          <input {...attributes} name="locator" type="url" maxLength={2048} defaultValue={receipt?.locator} />
        )}
      </IntakeField>
      <IntakeField name="category" label={receipt ? "Amended category" : "Category"} errors={errors}>
        {(attributes) => (
          <select {...attributes} name="category" defaultValue={receipt?.category}>
            {categories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        )}
      </IntakeField>
      <IntakeField
        name="scope"
        label={
          receipt ? "Amended contribution scope (public claim summary)" : "Contribution scope (public claim summary)"
        }
        errors={errors}
      >
        {(attributes) => <input {...attributes} name="scope" maxLength={300} defaultValue={receipt?.scope} />}
      </IntakeField>
      <IntakeField
        name="detail"
        label={receipt ? "Amended private review details" : "Private review details"}
        errors={errors}
      >
        {(attributes) => <textarea {...attributes} name="detail" maxLength={2000} defaultValue={receipt?.detail} />}
      </IntakeField>
      <fieldset>
        <legend>Proposed participants and roles</legend>
        <p>
          Your verified GitHub account ID is {actorId}. Unknown roles remain unknown; do not infer another person's
          contribution.
        </p>
        <RoleField
          name="submitterRole"
          label="Your proposed role"
          initial={initial?.roles.submitter ?? null}
          errors={errors}
        />
        <IntakeField
          name="collaborators"
          label={
            receipt
              ? "Amended collaborator GitHub numeric IDs, comma separated"
              : "Collaborator GitHub numeric IDs, comma separated"
          }
          errors={errors}
        >
          {(attributes) => (
            <input
              {...attributes}
              name="collaborators"
              value={collaborators}
              onChange={(event) => setCollaborators(event.target.value)}
            />
          )}
        </IntakeField>
        <p>
          List up to 20 other participants. Each person must independently choose whether to consent to this claim; you
          cannot consent for them.
        </p>
        {participantIds.map((id) => (
          <fieldset key={id}>
            <legend>Participant GitHub ID {id}</legend>
            <RoleField
              name={`participantRole-${id}`}
              label={`Proposed role for GitHub ID ${id}`}
              initial={initial?.roles.collaborators[id] ?? null}
              errors={errors}
            />
          </fieldset>
        ))}
      </fieldset>
      <fieldset>
        <legend>Contribution date or interval</legend>
        <IntakeField name="periodKind" label="Date knowledge" errors={errors}>
          {(attributes) => (
            <select
              {...attributes}
              name="periodKind"
              value={periodKind}
              onChange={(event) => setPeriodKind(event.target.value as EvidencePeriod["kind"])}
            >
              <option value="unknown">Unknown</option>
              <option value="date">One known date</option>
              <option value="interval">Known date interval</option>
            </select>
          )}
        </IntakeField>
        {periodKind === "date" && (
          <IntakeField name="periodDate" label="Contribution date" errors={errors}>
            {(attributes) => (
              <input
                {...attributes}
                name="periodDate"
                type="date"
                defaultValue={initial?.period.kind === "date" ? initial.period.date : ""}
              />
            )}
          </IntakeField>
        )}
        {periodKind === "interval" && (
          <>
            <IntakeField name="periodStart" label="Contribution start date" errors={errors}>
              {(attributes) => (
                <input
                  {...attributes}
                  name="periodStart"
                  type="date"
                  defaultValue={initial?.period.kind === "interval" ? initial.period.start : ""}
                />
              )}
            </IntakeField>
            <IntakeField name="periodEnd" label="Contribution end date" errors={errors}>
              {(attributes) => (
                <input
                  {...attributes}
                  name="periodEnd"
                  type="date"
                  defaultValue={initial?.period.kind === "interval" ? initial.period.end : ""}
                />
              )}
            </IntakeField>
          </>
        )}
      </fieldset>
      <fieldset>
        <legend>Source-use declaration for private review</legend>
        <IntakeField name="sourceUseState" label="Source-use basis" errors={errors}>
          {(attributes) => (
            <select
              {...attributes}
              name="sourceUseState"
              value={sourceUseState}
              onChange={(event) => setSourceUseState(event.target.value as "unresolved" | "declared")}
            >
              <option value="unresolved">Unresolved — I cannot yet establish a basis</option>
              <option value="declared">I can describe a source-use basis</option>
            </select>
          )}
        </IntakeField>
        {sourceUseState === "declared" && (
          <IntakeField name="sourceUseStatement" label="Private source-use statement" errors={errors}>
            {(attributes) => (
              <textarea
                {...attributes}
                name="sourceUseStatement"
                maxLength={1000}
                defaultValue={initial?.sourceUseBasis.state === "declared" ? initial.sourceUseBasis.statement : ""}
              />
            )}
          </IntakeField>
        )}
        <p>
          A declaration is your account of the basis, not verified permission. An unresolved basis stays pending until a
          qualified reviewer can resolve it with appropriate evidence.
        </p>
      </fieldset>
      <EvidenceTermsNotice terms={terms} />
      <IntakeField
        name="consent"
        label="I consent to public attribution of this claim under the displayed evidence terms if independently accepted"
        errors={errors}
      >
        {(attributes) => <input {...attributes} name="consent" type="checkbox" disabled={!terms} />}
      </IntakeField>
    </>
  );
}

export function intakeEligibilityText(eligibility?: IntakeEligibility): string {
  switch (eligibility?.state) {
    case "participant_consent_required":
      return "Participant consent is still required. This claim is not eligible for public recognition.";
    case "awaiting_review":
      return "Current intake and participant choices require an independent review decision.";
    case "source_use_review_required":
      return "This earlier accepted claim is withheld from public recognition until it returns to review and is independently accepted again with a qualified source-use review.";
    case "eligible":
      return "The service reports this intake eligible under its current consent and review checks.";
    default:
      return "Updated intake is required. Earlier records do not establish consent under the current terms; the submitter must amend and consent again before fresh review.";
  }
}

function periodText(period: EvidencePeriod | null): string {
  if (!period || period.kind === "unknown") return "Unknown";
  return period.kind === "date" ? period.date : `${period.start} to ${period.end}`;
}

export function EvidenceIntakeDetails({ receipt }: { receipt: Receipt }) {
  const intake = currentIntake(receipt);
  return (
    <section aria-label="Protected evidence intake">
      <p>{intakeEligibilityText(receipt.intakeEligibility)}</p>
      {(receipt.intakeEligibility?.state === "source_use_review_required" ||
        (receipt.status === "rejected" && receipt.intakeEligibility?.state === "awaiting_review")) && (
        <p>
          To return this receipt to review, the submitter can amend or appeal it, or an eligible independent reviewer
          can roll back the earlier decision.
        </p>
      )}
      {intake?.schemaVersion === "evidence-intake/v1" && (
        <>
          <p>
            Claim revision: {intake.claimRevision}. Consent terms: {intake.termsVersion}. Contributor-rights policy:{" "}
            {intake.rightsPolicyVersion}.
          </p>
          <p>
            Proposed submitter role: {intake.roles.submitter ?? "Unknown"}. Contribution date or interval:{" "}
            {periodText(intake.period)}.
          </p>
          <ul>
            {Object.entries(intake.roles.collaborators).map(([id, role]) => (
              <li key={id}>
                GitHub ID {id}: {role ?? "Unknown role"}. Choice: {receipt.collaborators?.[id] ?? "Unknown"}.
              </li>
            ))}
          </ul>
          <p>Source-use declaration: {intake.sourceUseBasis.state}.</p>
          {intake.sourceUseBasis.state === "declared" && (
            <p>Private source-use statement: {intake.sourceUseBasis.statement}</p>
          )}
        </>
      )}
    </section>
  );
}

export function SourceUseReviewFields({ errors }: { errors: FieldErrors }) {
  const reference = (index: number) => (
    <fieldset key={index}>
      <legend>
        Reviewed reference {index + 1}
        {index > 0 ? " (optional)" : ""}
      </legend>
      <IntakeField name={`reviewLocator-${index}`} label={`Reviewed source reference ${index + 1}`} errors={errors}>
        {(attributes) => <input {...attributes} name={`reviewLocator-${index}`} type="url" maxLength={2048} />}
      </IntakeField>
      <IntakeField name={`reviewRevision-${index}`} label={`Reviewed source revision ${index + 1}`} errors={errors}>
        {(attributes) => <input {...attributes} name={`reviewRevision-${index}`} maxLength={128} />}
      </IntakeField>
    </fieldset>
  );
  return (
    <fieldset>
      <legend>Independent source-use review</legend>
      {Object.keys(errors).length > 0 && (
        <p role="alert">Complete the marked source-use review fields. No decision has been submitted.</p>
      )}
      <p>
        Record the basis you actually reviewed and the exact references and revisions supporting permitted use of this
        claim. A public source or a submitter's declaration alone does not establish permission. These fields stay in
        the protected review record; entering a URL does not fetch or verify it.
      </p>
      <IntakeField name="sourceUseRationale" label="Source-use review rationale" errors={errors}>
        {(attributes) => <textarea {...attributes} name="sourceUseRationale" maxLength={1000} />}
      </IntakeField>
      {reference(0)}
      <details>
        <summary>Additional reviewed references (up to four)</summary>
        {[1, 2, 3, 4].map(reference)}
      </details>
      <IntakeField
        name="sourceUsePermitted"
        label="My independent review establishes permitted source use for this exact claim"
        errors={errors}
      >
        {(attributes) => <input {...attributes} name="sourceUsePermitted" type="checkbox" />}
      </IntakeField>
    </fieldset>
  );
}

export function AttributionInvitation({
  invitation,
  run,
}: {
  invitation: EvidenceInvitation;
  run: (path: string, input: unknown) => Promise<boolean>;
}) {
  const [choice, setChoice] = useState("");
  const { errors, showErrors } = useControlFormErrors();
  let terms: EvidenceTerms | null = null;
  try {
    terms = verifiedEvidenceTerms(invitation.terms);
  } catch {
    /* Decline remains available without usable terms. */
  }
  const canConsent =
    !!terms &&
    Number.isSafeInteger(invitation.claimRevision) &&
    invitation.claimRevision! > 0 &&
    typeof invitation.claimDigest === "string" &&
    /^[a-f0-9]{64}$/.test(invitation.claimDigest) &&
    ["participant_consent_required", "awaiting_review", "source_use_review_required", "eligible"].includes(
      invitation.intakeEligibility?.state ?? "",
    );
  return (
    <article>
      <h3>Attribution invitation {invitation.id}</h3>
      <p>Public GitHub source: {invitation.locator}</p>
      <p>
        Public claim summary: {invitation.scope}. Category: {invitation.category}.
      </p>
      <p>Proposed participant GitHub IDs: {invitation.participantIds?.join(", ") || "Unknown"}.</p>
      <p>
        Your proposed role: {invitation.role ?? "Unknown"}. Contribution date or interval:{" "}
        {periodText(invitation.period)}.
      </p>
      <p>
        Submitter source-use declaration: {invitation.sourceUseState ?? "unknown"}. This is not independent
        verification.
      </p>
      <p>
        Your saved choice: {invitation.consent}. Claim revision: {invitation.claimRevision ?? "Unknown"}.
      </p>
      <p>{intakeEligibilityText(invitation.intakeEligibility)}</p>
      <EvidenceTermsNotice terms={terms} />
      {!canConsent && (
        <p>
          New acceptance is unavailable until the submitter supplies current intake. You can still decline attribution.
        </p>
      )}
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const next: FieldErrors = {};
          if (choice !== "accept" && choice !== "decline")
            next.choice = "Choose whether to accept or decline this attribution.";
          if (choice === "accept" && !canConsent)
            next.choice = "Current claim and terms are required before accepting attribution.";
          if (data.get("confirmChoice") !== "on")
            next.confirmChoice = "Confirm the choice you selected for this claim.";
          showErrors(form, next);
          if (Object.keys(next).length) return;
          await run(`/controls/requests/${invitation.id}/consent`, {
            version: invitation.version,
            consent: choice === "accept",
            ...(choice === "accept"
              ? { claimDigest: invitation.claimDigest, termsVersion: terms!.version, termsDigest: terms!.digest }
              : {}),
          });
        }}
      >
        {Object.keys(errors).length > 0 && (
          <p role="alert">Check the marked choice. No consent change has been submitted.</p>
        )}
        <IntakeField name="choice" label="Attribution consent" errors={errors}>
          {(attributes) => (
            <select {...attributes} name="choice" value={choice} onChange={(event) => setChoice(event.target.value)}>
              <option value="">Choose a response</option>
              <option value="decline">Decline</option>
              <option value="accept" disabled={!canConsent}>
                Accept under the displayed terms
              </option>
            </select>
          )}
        </IntakeField>
        <IntakeField
          key={choice}
          name="confirmChoice"
          label={
            choice === "accept"
              ? "I consent to my attribution in this exact claim under the displayed terms"
              : `Confirm my choice for ${invitation.id}`
          }
          errors={errors}
        >
          {(attributes) => <input {...attributes} name="confirmChoice" type="checkbox" />}
        </IntakeField>
        <button>Save consent</button>
      </form>
    </article>
  );
}
