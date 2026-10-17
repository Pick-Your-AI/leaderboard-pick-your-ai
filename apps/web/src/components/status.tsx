import React from "react";
import type { Coverage } from "@pick-your-ai/contracts";
import type { EvidenceState, Freshness, SnapshotMeta } from "../data/model.ts";
import type { SnapshotView } from "../data/source.ts";
import { formatDate, formatDateTime } from "../lib/format.ts";
import { ScopedLink } from "../lib/router.tsx";

/** Evidence states always carry a word; the glyph is decoration only. */
export const evidenceLabels: Record<EvidenceState, { label: string; glyph: string; description: string }> = {
  observed: { label: "Observed", glyph: "○", description: "The source recorded this action. Observation is not acceptance." },
  provisional: { label: "Pending verification", glyph: "◐", description: "Seen, but not yet verified or accepted under the stated rule. Not ranked." },
  qualified: { label: "Qualified", glyph: "●", description: "Accepted under the stated, automatic rule." },
  reviewed: { label: "Reviewed", glyph: "◆", description: "Accepted after reviewed evidence." },
  excluded: { label: "Excluded", glyph: "⊘", description: "Not counted under the stated policy." },
  not_measured: { label: "Not measured", glyph: "–", description: "No supported source for this measure." },
};

export function StateLabel({ state }: { state: EvidenceState }) {
  const entry = evidenceLabels[state];
  return (
    <span className={`state state-${state.replace("_", "-")}`}>
      <span aria-hidden="true">{entry.glyph}</span> {entry.label}
    </span>
  );
}

const coverageWords: Record<Coverage["state"], string> = {
  complete: "Complete",
  partial: "Partial",
  unknown: "Unknown",
  unavailable: "Unavailable",
};

const coverageTone: Record<Coverage["state"], "ok" | "warn" | "error"> = {
  complete: "ok",
  partial: "warn",
  unknown: "warn",
  unavailable: "error",
};

export function CoverageLabel({ state }: { state: Coverage["state"] }) {
  const glyph = { complete: "✓", partial: "◑", unknown: "?", unavailable: "✕" }[state];
  return (
    <span className={`health health-${coverageTone[state]}`}>
      <span aria-hidden="true">{glyph}</span> {coverageWords[state]} coverage
    </span>
  );
}

const freshnessTone: Record<Freshness, "ok" | "warn" | "error"> = {
  Fresh: "ok",
  Polling: "ok",
  Delayed: "warn",
  Reconciling: "warn",
  Stale: "error",
  Error: "error",
};

export function FreshnessIndicator({ view, compact = false }: { view: SnapshotView; compact?: boolean }) {
  const { requested, served } = view;
  const tone = freshnessTone[requested.freshness];
  return (
    <div className={`freshness ${compact ? "freshness-compact" : ""}`}>
      <span className={`health health-${tone}`}>
        <span aria-hidden="true">{tone === "ok" ? "●" : tone === "warn" ? "◑" : "✕"}</span> {requested.freshness}
      </span>
      <span>
        Data as of <time dateTime={served.cutoff}>{formatDateTime(served.cutoff)}</time>
      </span>
      {!compact && (
        <>
          <span>Snapshot {served.id} (revision {served.revision}){view.pinned ? ", pinned" : ""}</span>
          <span>Collector {requested.collectorConnected ? "connected" : "disconnected"}</span>
          <span>{requested.reconciliation}</span>
        </>
      )}
    </div>
  );
}

export function SnapshotNotices({ view }: { view: SnapshotView }) {
  const { requested } = view;
  return (
    <>
      {requested.status === "rebuilding" && (
        <Notice tone="warn" title="Rebuilding snapshot">
          Snapshot {requested.id} is being rebuilt after a method change. You are seeing the last complete snapshot, {view.served.id},
          until the rebuild publishes. No partial mixture of the two is shown.
        </Notice>
      )}
      {requested.freshness === "Stale" && (
        <Notice tone="error" title="Stale data">
          This snapshot was generated {formatDateTime(requested.generatedAt)} and has not been refreshed since.
          {!requested.collectorConnected && " The source collector is disconnected, so newer activity is not reflected."} Values are
          not zero for missing days; they are simply not yet observed.
        </Notice>
      )}
    </>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "error"; title: string; children: React.ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role="note">
      <p className="notice-title">
        <span aria-hidden="true">{tone === "info" ? "ⓘ" : tone === "warn" ? "◑" : "✕"}</span> {title}
      </p>
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <div className="muted">{children}</div>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="loading" role="status">
      <span aria-hidden="true" className="spinner" /> Loading {label}…
    </p>
  );
}

export function ErrorState({ error }: { error: Error & { detail?: string } }) {
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">
        <span aria-hidden="true">✕</span> {error.message}
      </p>
      {error.detail && <p>{error.detail}</p>}
      <p>
        Nothing on this page has been replaced with zeros or estimates. Try the latest snapshot, or check <ScopedLink to="/coverage">source
        coverage</ScopedLink>.
      </p>
    </div>
  );
}

export function CoverageNote({ items, windowStart }: { items: Coverage[]; windowStart: Date | null }) {
  const gaps = items.filter((item) => item.state !== "complete");
  if (items.length === 0) {
    return <p className="muted">No source in this scope reports coverage for this measure, so it is unknown.</p>;
  }
  return (
    <details className="coverage-note">
      <summary>
        <CoverageLabel state={gaps.length === 0 ? "complete" : gaps.some((item) => item.state === "unavailable") ? "unavailable" : "partial"} />{" "}
        {gaps.length === 0 ? "for every repository in scope" : `${gaps.length} of ${items.length} source scopes have gaps`}
      </summary>
      <ul>
        {items.map((item) => (
          <li key={`${item.scopeId}-${item.source}`}>
            <span className="mono">{item.scopeId ?? "unknown scope"}</span> · {item.source.replace("_", " ")} ·{" "}
            <CoverageLabel state={item.state} />
            {item.knownStart && <> · history from {formatDate(item.knownStart)}</>}
            {windowStart === null && item.state !== "complete" && " · all-time totals are bounded by this start"}
            {item.missingPages > 0 && <> · {item.missingPages} missing pages</>}
            {item.permissionsMissing.length > 0 && <> · missing permission: {item.permissionsMissing.join(", ")}</>}
            {item.sourceErrors.map((error) => (
              <span key={error}> · {error}</span>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function SnapshotLabel({ snapshot }: { snapshot: SnapshotMeta }) {
  return (
    <span className="mono">
      {snapshot.id} · r{snapshot.revision}
    </span>
  );
}
