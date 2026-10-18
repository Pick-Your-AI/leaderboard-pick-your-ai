import React, { useState } from "react";

export function localizationReviewInput(data: FormData) {
  return data.get("localeReview") === "on"
    ? {
        localization: {
          targetFactId: data.get("localeFact"),
          sourceRevision: data.get("localeRevision"),
          locale: data.get("localeLanguage"),
          category: data.get("localeCategory"),
          policyVersion: data.get("localePolicy"),
        },
      }
    : {};
}

/** A reviewer explicitly selects the exact public proof they inspected. */
export function LocaleReviewFields() {
  const [enabled, setEnabled] = useState(false);
  return (
    <fieldset>
      <legend>Locale contribution review</legend>
      <label>
        <input
          type="checkbox"
          name="localeReview"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Accept one reviewed language and source revision
      </label>
      {enabled && (
        <>
          <p>
            Copy these values from the public contribution proof you reviewed. Acceptance applies only to this language,
            content category, classification policy and merged revision. A later revision needs another independent
            review.
          </p>
          <label className="control-field">
            Contribution ID
            <input name="localeFact" required maxLength={200} />
          </label>
          <label className="control-field">
            Reviewed merge revision
            <input name="localeRevision" required maxLength={64} pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}" />
          </label>
          <label className="control-field">
            Language tag
            <input name="localeLanguage" required maxLength={64} />
          </label>
          <label className="control-field">
            Content category
            <input name="localeCategory" required maxLength={40} />
          </label>
          <label className="control-field">
            Documentation classification policy version
            <input name="localePolicy" required maxLength={200} />
          </label>
        </>
      )}
    </fieldset>
  );
}
