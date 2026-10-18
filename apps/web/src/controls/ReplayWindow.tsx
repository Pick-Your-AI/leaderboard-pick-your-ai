import React from "react";
import { replayWindowInput, type ReplayWindow, type WindowPreview } from "./operations-window.ts";

export function ReplayWindowControls({
  repositoryId,
  policyVersion,
  busy,
  preview,
  invalidate,
  onInvalid,
  onPreview,
  onReplay,
}: {
  repositoryId: number;
  policyVersion: string;
  busy: boolean;
  preview: WindowPreview | null;
  invalidate: () => void;
  onInvalid: (message: string) => void;
  onPreview: (input: ReplayWindow) => void;
  onReplay: (reason: string) => void;
}) {
  return (
    <section aria-label="Replay a receive-time window">
      <h3>Replay a receive-time window</h3>
      <p>
        Choose when deliveries arrived, in UTC. The start is included and the end is excluded. Review at most 50
        quarantined deliveries over at most 31 days. A larger selection fails in full; narrow the window before trying
        again. This does not select contribution dates or establish complete source history.
      </p>
      <form
        onChange={invalidate}
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          try {
            onPreview(
              replayWindowInput(
                repositoryId,
                policyVersion,
                String(values.get("receivedSince")),
                String(values.get("receivedUntil")),
                Number(values.get("limit")),
              ),
            );
          } catch {
            onInvalid("Choose valid UTC dates, a window of at most 31 days, and a delivery limit from 1 to 50.");
          }
        }}
      >
        <label className="control-field">
          Received from (UTC, inclusive)
          <input name="receivedSince" type="datetime-local" step="0.001" required disabled={busy} />
        </label>
        <label className="control-field">
          Received until (UTC, exclusive)
          <input name="receivedUntil" type="datetime-local" step="0.001" required disabled={busy} />
        </label>
        <label className="control-field">
          Maximum selected deliveries
          <input name="limit" type="number" min="1" max="50" step="1" defaultValue="50" required disabled={busy} />
        </label>
        <button disabled={busy}>Preview retained delivery window</button>
      </form>
      {preview && (
        <div>
          <p role="status">
            {preview.deliveries.length} quarantined {preview.deliveries.length === 1 ? "delivery" : "deliveries"}{" "}
            selected for review.
          </p>
          <p>
            Repository {preview.window.repositoryId} · received from {preview.window.receivedSince} (inclusive) to{" "}
            {preview.window.receivedUntil} (exclusive) · limit {preview.window.limit} · source generation{" "}
            {preview.sourceGeneration} · policy {preview.window.policyVersion} · authorization revision{" "}
            {preview.authorityRevision} · selection revision {preview.revision}.
          </p>
          <p>{preview.meaning}</p>
          {preview.deliveries.length === 0 ? (
            <p>No retained quarantined delivery matches this window. No replay is available.</p>
          ) : (
            <>
              <ol aria-label="Deliveries selected for replay">
                {preview.deliveries.map((row) => (
                  <li key={row.deliveryId}>
                    <p>
                      Delivery {row.deliveryId} · attempts {row.attempts ?? "unknown"} · {row.reason} · revision{" "}
                      {row.revision}
                    </p>
                  </li>
                ))}
              </ol>
              <form
                key={preview.revision}
                onSubmit={(event) => {
                  event.preventDefault();
                  onReplay(String(new FormData(event.currentTarget).get("reason")));
                }}
              >
                <label className="control-field">
                  Reason for window replay
                  <select name="reason" disabled={busy}>
                    <option value="operator_reviewed">Operator reviewed</option>
                    <option value="source_recovered">Source recovered</option>
                    <option value="normalization_corrected">Normalization corrected</option>
                  </select>
                </label>
                <label>
                  <input type="checkbox" required disabled={busy} /> Queue{" "}
                  {preview.deliveries.length === 1 ? "this" : "these"} {preview.deliveries.length}{" "}
                  {preview.deliveries.length === 1 ? "delivery" : "deliveries"} in repository{" "}
                  {preview.window.repositoryId} for the reviewed UTC window under policy {preview.window.policyVersion}
                </label>
                <p>
                  New arrivals or changed deliveries require another preview. Queuing is not successful publication.
                </p>
                <button disabled={busy}>Queue reviewed delivery window</button>
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}
