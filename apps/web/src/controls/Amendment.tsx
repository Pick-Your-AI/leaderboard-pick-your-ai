import React from "react";
import type { Receipt } from "./client.ts";

/** Uses the parent's session-generation guard and reloads the service receipt after a write. */
export function Amendment({
  receipt,
  categories,
  run,
}: {
  receipt: Receipt;
  categories: string[];
  run: (path: string, input: unknown) => Promise<boolean>;
}) {
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
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          await run(`/controls/requests/${receipt.id}/amend`, {
            version: receipt.version,
            reason: data.get("reason"),
            locator: data.get("locator"),
            category: data.get("category"),
            scope: data.get("scope"),
            detail: data.get("detail"),
            collaborators: String(data.get("collaborators") ?? "")
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          });
        }}
      >
        <label className="control-field">
          Amended public GitHub source URL
          <input name="locator" type="url" required defaultValue={receipt.locator} />
        </label>
        <label className="control-field">
          Amended category
          <select name="category" defaultValue={receipt.category}>
            {categories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </label>
        <label className="control-field">
          Amended contribution scope
          <input name="scope" required maxLength={300} defaultValue={receipt.scope} />
        </label>
        <label className="control-field">
          Amended evidence details
          <textarea name="detail" required maxLength={2000} defaultValue={receipt.detail} />
        </label>
        <label className="control-field">
          Amended collaborator GitHub numeric IDs, comma separated
          <input name="collaborators" defaultValue={Object.keys(receipt.collaborators ?? {}).join(", ")} />
        </label>
        <label className="control-field">
          Private amendment reason
          <textarea name="reason" required maxLength={2000} />
        </label>
        <label>
          <input type="checkbox" required /> Replace this evidence and return it to pending review
        </label>
        <button>Submit evidence amendment</button>
      </form>
    </details>
  );
}
