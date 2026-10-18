import React, { useEffect, useRef, useState } from "react";
import { control, type Session } from "./client.ts";
import { ReplayWindowControls } from "./ReplayWindow.tsx";
import { OperatorHealthView, OperatorReplayResultView } from "./OperationsObserved.tsx";
import {
  checkedOperatorHealth,
  checkedReplayResult,
  type OperatorHealthResponse,
  type OperatorReplayResultResponse,
} from "./operations-observed.ts";
import {
  checkedWindowPreview,
  checkedWindowReceipt,
  type ReplayWindow,
  type WindowPreview,
  type WindowReceipt,
} from "./operations-window.ts";
interface Status {
  repositoryId: number;
  sourceGeneration: string;
  policyVersion: string;
  authorityRevision: string;
  counts: Record<string, number | null>;
  quarantined: Array<{ deliveryId: string; attempts: number; reason: string; revision: string }>;
  runs: Array<{
    sourceGeneration: string | null;
    family: string;
    mode: string;
    state: string;
    pages: number;
    items: number;
    expectedItems: number | null;
    lastSuccessAt: string | null;
  }>;
  receipts: Array<{
    sourceGeneration: string | null;
    id: string;
    deliveryId: string;
    operatorId: string;
    reason: string;
    policyVersion: string;
    beforeRevision: string;
    queuedRevision: string;
    resultingPublicationRevision: null;
    batch?: { id: string; size: number; selectionRevision: string; window: ReplayWindow } | null;
  }>;
  truncated: { quarantined: boolean; runs: boolean; receipts: boolean };
  meaning: string;
}
/** Mount only for authenticated operators. This component never chooses repository grants or reads public API health. */
export function Operations({ session }: { session: Session }) {
  const [repository, setRepository] = useState("");
  const [data, setData] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [windowPreview, setWindowPreview] = useState<WindowPreview | null>(null);
  const [observedHealth, setObservedHealth] = useState<OperatorHealthResponse | null>(null);
  const [replayResult, setReplayResult] = useState<OperatorReplayResultResponse | null>(null);
  const generation = useRef(0);
  const permitted = () => !document.hidden && session.roles.includes("operator") && session.expires > Date.now();
  function clear() {
    setData(null);
    setError("");
    setNotice("");
    setBusy(false);
    setWindowPreview(null);
    setObservedHealth(null);
    setReplayResult(null);
  }
  useEffect(() => {
    clear();
    const hide = () => {
      ++generation.current;
      clear();
    };
    document.addEventListener("visibilitychange", hide);
    const timer = setTimeout(hide, Math.max(0, session.expires - Date.now()));
    return () => {
      ++generation.current;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [session]);
  async function load(repo: string) {
    if (!permitted()) return;
    const current = ++generation.current;
    clear();
    setBusy(true);
    try {
      const value = await control<Status>(`/controls/operations/${repo}`);
      if (current !== generation.current || !permitted()) return;
      if (
        value.repositoryId !== Number(repo) ||
        !Array.isArray(value.quarantined) ||
        !Array.isArray(value.runs) ||
        !Array.isArray(value.receipts) ||
        !value.counts ||
        !value.truncated
      )
        throw Error("Invalid diagnostics response.");
      setData(value);
    } catch {
      if (current === generation.current && permitted())
        setError("Diagnostics unavailable or access changed. No source health is inferred.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function replay(row: Status["quarantined"][number], reason: string) {
    if (!data || busy || !permitted()) return;
    const repo = String(data.repositoryId),
      current = ++generation.current;
    setBusy(true);
    setNotice("");
    setError("");
    setWindowPreview(null);
    setObservedHealth(null);
    setReplayResult(null);
    try {
      const receipt = await control<{ id: string; status: string }>(`/controls/operations/${repo}/replay`, session, {
        deliveryId: row.deliveryId,
        expectedRevision: row.revision,
        reason,
        confirmed: true,
      });
      if (current !== generation.current || !permitted()) return;
      if (receipt.status !== "queued" || typeof receipt.id !== "string") throw Error("Invalid receipt.");
      setData(null);
      setNotice(
        `Replay queued. Receipt ${receipt.id}. This does not confirm collection or publication; reload diagnostics to inspect retained progress.`,
      );
    } catch {
      if (current === generation.current && permitted()) {
        setData(null);
        setError("Replay was not confirmed. Reload diagnostics and receipts before deciding whether to retry.");
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function invalidateWindow() {
    ++generation.current;
    setWindowPreview(null);
    setError("");
    setNotice("");
    setObservedHealth(null);
    setReplayResult(null);
  }
  async function previewWindow(input: ReplayWindow) {
    if (!data || busy || !permitted()) return;
    const current = ++generation.current;
    setBusy(true);
    setWindowPreview(null);
    setError("");
    setNotice("");
    setObservedHealth(null);
    setReplayResult(null);
    try {
      const { repositoryId, ...window } = input;
      const value = await control<WindowPreview>(
        `/controls/operations/${repositoryId}/replay-window/preview`,
        session,
        window,
      );
      if (current !== generation.current || !permitted()) return;
      setWindowPreview(checkedWindowPreview(value, input, data.sourceGeneration, data.authorityRevision));
    } catch {
      if (current === generation.current && permitted()) {
        setData(null);
        setError(
          "Window preview unavailable, larger than its limit, or access changed. Reload diagnostics before choosing a narrower window or retrying. Nothing was queued by this preview.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function replayWindow(reason: string) {
    if (!data || !windowPreview || !windowPreview.deliveries.length || busy || !permitted()) return;
    const preview = windowPreview,
      current = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setObservedHealth(null);
    setReplayResult(null);
    try {
      const { repositoryId, ...window } = preview.window;
      const receipt = await control<WindowReceipt>(`/controls/operations/${repositoryId}/replay-window`, session, {
        ...window,
        expectedRevision: preview.revision,
        reason,
        confirmed: true,
      });
      if (current !== generation.current || !permitted()) return;
      checkedWindowReceipt(receipt, preview);
      setData(null);
      setWindowPreview(null);
      setNotice(
        `Window replay queued. Batch ${receipt.id}, ${receipt.receipts.length} durable delivery receipts. This does not confirm collection or publication; reload diagnostics to inspect receipts and retained progress.`,
      );
    } catch {
      if (current === generation.current && permitted()) {
        setData(null);
        setWindowPreview(null);
        setError(
          "Window replay was not confirmed. Reload diagnostics and receipts before deciding whether another preview and replay are needed.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function readObservation(receipt?: Status["receipts"][number]) {
    if (!data || busy || !permitted()) return;
    const selected = data,
      current = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setWindowPreview(null);
    setObservedHealth(null);
    setReplayResult(null);
    try {
      const path = receipt ? `replays/${receipt.id}` : "health";
      const response = await control<unknown>(`/controls/operations/${selected.repositoryId}/${path}`);
      if (current !== generation.current || !permitted()) return;
      if (receipt)
        setReplayResult(
          checkedReplayResult(response, {
            repositoryId: selected.repositoryId,
            sourceGeneration: selected.sourceGeneration,
            policyVersion: selected.policyVersion,
            authorityRevision: selected.authorityRevision,
            receiptId: receipt.id,
            deliveryId: receipt.deliveryId,
          }),
        );
      else
        setObservedHealth(
          checkedOperatorHealth(response, {
            repositoryId: selected.repositoryId,
            sourceGeneration: selected.sourceGeneration,
            policyVersion: selected.policyVersion,
            authorityRevision: selected.authorityRevision,
          }),
        );
    } catch {
      if (current === generation.current && permitted()) {
        setData(null);
        setObservedHealth(null);
        setReplayResult(null);
        setError(
          "The observed result is unavailable or access changed. Reload protected diagnostics before refreshing. No health or publication success is inferred.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  if (!session.roles.includes("operator")) return null;
  return (
    <section>
      <h2>Collection diagnostics and inbox replay</h2>
      <p>
        Only explicitly authorized repositories are available. Diagnostics describe retained processing, not a live
        connectivity guarantee. Outbox replay is unavailable here.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(repository);
        }}
      >
        <label className="control-field">
          Repository numeric ID
          <input
            value={repository}
            onChange={(e) => {
              ++generation.current;
              clear();
              setRepository(e.target.value);
            }}
            required
            pattern="[1-9][0-9]{0,15}"
          />
        </label>
        <button disabled={busy}>Load protected diagnostics</button>
      </form>
      {busy && <p role="status">Checking authorized operation…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <>
          <p>
            Repository {data.repositoryId}, current source generation {data.sourceGeneration}, authorization revision{" "}
            {data.authorityRevision}, policy {data.policyVersion}.
          </p>
          <p>{data.meaning}</p>
          <button type="button" disabled={busy} onClick={() => void readObservation()}>
            Read current operator health
          </button>
          {observedHealth && <OperatorHealthView health={observedHealth} />}
          <dl>
            {Object.entries(data.counts).map(([key, value]) => (
              <React.Fragment key={key}>
                <dt>{key}</dt>
                <dd>{value ?? "Unknown"}</dd>
              </React.Fragment>
            ))}
          </dl>
          <ReplayWindowControls
            repositoryId={data.repositoryId}
            policyVersion={data.policyVersion}
            busy={busy}
            preview={windowPreview}
            invalidate={invalidateWindow}
            onInvalid={(message) => {
              invalidateWindow();
              setError(message);
            }}
            onPreview={(input) => void previewWindow(input)}
            onReplay={(reason) => void replayWindow(reason)}
          />
          <h3>Recent collection runs</h3>
          {data.runs.length === 0 && <p>No retained collection run is available.</p>}
          {data.runs.map((r, i) => (
            <p key={i}>
              Source generation {r.sourceGeneration ?? "unknown"} · {r.family} · {r.mode} · {r.state} · pages {r.pages},
              items {r.items}, expected {r.expectedItems ?? "unknown"}, last success {r.lastSuccessAt ?? "unknown"}
            </p>
          ))}
          <h3>Quarantined inbox deliveries</h3>
          {data.quarantined.length === 0 && <p>No quarantined deliveries in this retained page.</p>}
          {data.quarantined.map((row) => (
            <form
              key={row.revision}
              onSubmit={(e) => {
                e.preventDefault();
                void replay(row, String(new FormData(e.currentTarget).get("reason")));
              }}
            >
              <p>
                Delivery {row.deliveryId} · attempts {row.attempts} · {row.reason}
              </p>
              <label className="control-field">
                Replay reason
                <select name="reason">
                  <option value="operator_reviewed">Operator reviewed</option>
                  <option value="source_recovered">Source recovered</option>
                  <option value="normalization_corrected">Normalization corrected</option>
                </select>
              </label>
              <label>
                <input type="checkbox" required /> Queue delivery {row.deliveryId} in repository {data.repositoryId},
                revision {row.revision}, under policy {data.policyVersion}
              </label>
              <button disabled={busy}>Queue audited inbox replay</button>
            </form>
          ))}
          <h3>Retained replay receipts</h3>
          {data.receipts.map((r) => (
            <div key={r.id}>
              <p>
                Source generation {r.sourceGeneration ?? "unknown"} · receipt {r.id} · delivery {r.deliveryId} ·
                operator {r.operatorId} · {r.reason} · policy {r.policyVersion} · before {r.beforeRevision} · queued{" "}
                {r.queuedRevision}. Resulting publication revision: unknown in this queued audit.
              </p>
              {r.batch && (
                <p>
                  Batch {r.batch.id} · {r.batch.size} deliveries · received from {r.batch.window.receivedSince}{" "}
                  (inclusive) to {r.batch.window.receivedUntil} (exclusive) · limit {r.batch.window.limit} · reviewed
                  selection {r.batch.selectionRevision}.
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void readObservation(r)}
                aria-label={`Read verified replay result for delivery ${r.deliveryId}`}
              >
                Read verified replay result
              </button>
              {replayResult?.receiptId === r.id && <OperatorReplayResultView result={replayResult} />}
            </div>
          ))}
          {Object.values(data.truncated).some(Boolean) && (
            <p>Results are limited to 50 records per section; this view is not a complete history.</p>
          )}
        </>
      )}
    </section>
  );
}
