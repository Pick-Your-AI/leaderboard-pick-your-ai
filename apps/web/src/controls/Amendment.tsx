import React from "react";
import { evidenceSubmissionInput, type EvidenceTerms, type Receipt } from "./client.ts";
import { EvidenceIntakeFields, useControlFormErrors } from "./EvidenceIntake.tsx";

/** Uses the parent's session-generation guard and reloads the service receipt after a write. */
export function Amendment({
  receipt,
  categories,
  terms,
  tutorialTerms = null,
  run,
}: {
  receipt: Receipt;
  categories: string[];
  terms: EvidenceTerms | null;
  tutorialTerms?: EvidenceTerms | null;
  run: (path: string, input: unknown) => Promise<boolean>;
}) {
  const { errors, showErrors } = useControlFormErrors();
  return (
    <details>
      <summary>Amend evidence</summary>
      <p>
        Amending returns this evidence to pending independent review and removes its prior accepted claim from public
        recognition. Collaborators must consent again; a previous decline remains declined.
      </p>
      <p>
        The amendment reason and audit history stay in the protected controls service. Source, scope and attribution may
        become public if independently accepted. Do not include private source content.
      </p>
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const evidence = evidenceSubmissionInput(data, terms, receipt.owner, categories, tutorialTerms);
          showErrors(form, evidence.ok ? {} : evidence.errors);
          if (!evidence.ok || !form.reportValidity()) return;
          await run(`/controls/requests/${receipt.id}/amend`, {
            version: receipt.version,
            reason: data.get("reason"),
            ...evidence.value,
          });
        }}
      >
        <EvidenceIntakeFields
          actorId={receipt.owner}
          terms={terms}
          tutorialTerms={tutorialTerms}
          categories={categories}
          receipt={receipt}
          errors={errors}
        />
        <label className="control-field">
          Private amendment reason
          <textarea name="reason" required maxLength={2000} />
        </label>
        <label>
          <input type="checkbox" required /> Replace this evidence and return it to pending review
        </label>
        <button disabled={!terms}>Submit evidence amendment</button>
      </form>
    </details>
  );
}
