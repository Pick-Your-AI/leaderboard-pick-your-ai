import React from "react";
import type { Session } from "./client.ts";
export interface Nomination {
  id: string;
  owner: string;
  claimId: string;
  claimVersion: number;
  status: string;
  version: number;
  history: unknown[];
}
export function Spotlights({
  nominations,
  session,
  run,
  admin,
}: {
  nominations: Nomination[];
  session: Session;
  admin: boolean;
  run: (path: string, input: unknown) => Promise<boolean>;
}) {
  return (
    <section>
      <h2>Editorial spotlight nominations</h2>
      <p>
        Spotlights require an accepted evidence receipt, separate opt-in consent and independent editorial review.
        Selection is not a leaderboard rank.
      </p>
      {nominations.length === 0 && <p>No visible nominations.</p>}
      {nominations.map((n) => (
        <article key={`${n.id}:${n.version}`}>
          <h3>Nomination {n.id}</h3>
          <p>
            Evidence receipt {n.claimId} · {n.status} · version {n.version}
          </p>
          <details>
            <summary>Nomination history</summary>
            <pre>{JSON.stringify(n.history, null, 2)}</pre>
          </details>
          {(n.owner === session.actorId || (admin && session.roles.includes("reviewer") && n.status === "pending")) && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                await run(`/controls/spotlights/${n.id}`, {
                  version: n.version,
                  action: d.get("action"),
                  reason: d.get("reason"),
                  conflict: false,
                });
              }}
            >
              <label className="control-field">
                Nomination action
                <select name="action">
                  {n.owner === session.actorId ? (
                    <option value="withdraw">Withdraw consent</option>
                  ) : (
                    <>
                      <option value="reject">Reject nomination</option>
                      <option value="accept">Accept spotlight</option>
                    </>
                  )}
                </select>
              </label>
              <label className="control-field">
                Public selection explanation
                <textarea name="reason" required maxLength={2000} />
              </label>
              <p>This explanation is public if the spotlight is selected. Do not include private request content.</p>
              <label>
                <input type="checkbox" required />
                {n.owner === session.actorId
                  ? "I confirm withdrawal of this nomination"
                  : "I independently reviewed this nomination and have no conflict of interest"}
              </label>
              <button>Record nomination decision</button>
            </form>
          )}
        </article>
      ))}
    </section>
  );
}
