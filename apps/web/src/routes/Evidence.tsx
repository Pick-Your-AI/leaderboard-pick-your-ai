import React from "react";
import { PageHeader } from "../components/Layout.tsx";
import { PersonName, ReceiptBody } from "../components/Receipt.tsx";
import { ScopeBar } from "../components/ScopeBar.tsx";
import {
  EmptyState,
  ErrorState,
  FreshnessIndicator,
  Loading,
  Notice,
  SnapshotNotices,
  StateLabel,
} from "../components/status.tsx";
import type { ContributionRecord } from "../data/model.ts";
import {
  getContribution,
  listActivity,
  listCorrections,
  personFor,
  repositories,
  resolveSnapshot,
} from "../data/source.ts";
import { formatDateTime } from "../lib/format.ts";
import { useLatestSnapshotId, useRead, useScope } from "../lib/hooks.ts";
import { ScopedLink } from "../lib/router.tsx";
import { serializeScope, resolveWindow } from "../lib/scope.ts";

export function ContributionPage({ id }: { id: string }) {
  const latest = useLatestSnapshotId();
  const { scope } = useScope();
  const state = useRead(() => {
    const snapshot = resolveSnapshot(scope, latest);
    return { view: getContribution(id, snapshot.served.id), snapshot };
  }, [id, serializeScope(scope), latest]);
  if (state.status === "loading") return <Loading label="contribution" />;
  if (state.status === "error") return <ErrorState error={state.error} />;
  const { view, snapshot } = state.data;
  if (!view) {
    return (
      <>
        <PageHeader title="Contribution not available" />
        <EmptyState title="There is no public contribution with this ID">
          It may have been removed, or it was never public. <ScopedLink to="/activity">Browse activity</ScopedLink>.
        </EmptyState>
      </>
    );
  }
  const { record, person } = view;
  const correctionPreview = new URLSearchParams({
    receipt: record.id,
    snapshot: snapshot.served.id,
    title: `Correction: ${record.id}`,
  }).toString();

  return (
    <>
      <PageHeader eyebrow={`Contribution ${record.id}`} title={record.title}>
        <p>
          <StateLabel state={record.evidence} /> · <span className="mono">{view.repository}</span>
        </p>
      </PageHeader>
      <ScopeBar timeWindow={resolveWindow(scope, new Date(snapshot.served.cutoff))} />
      <FreshnessIndicator view={snapshot} compact />
      <SnapshotNotices view={snapshot} />
      {record.corrections.length > 0 && (
        <Notice tone="info" title="Corrected result">
          This contribution's credit changed after a public correction. The history below shows what changed and when.
        </Notice>
      )}
      {record.visibility !== "public" && (
        <Notice tone="warn" title="Source no longer public">
          The original source is no longer publicly available. The observation is kept for the existing count, but there
          is no link to it.
        </Notice>
      )}
      <ReceiptBody record={record} person={person} />
      <section className="section" aria-labelledby="report">
        <h2 id="report">Report a factual problem</h2>
        <p>
          A real correction form is part of LB 17.03 and does not exist yet. This prototype does not send anything. A
          future form would be prefilled with:
        </p>
        <pre className="mono prefill">{correctionPreview}</pre>
        <p className="muted">
          Privacy requests need a staffed private channel before public launch. No address is invented here.
        </p>
      </section>
    </>
  );
}

interface FeedEntry {
  key: string;
  at: string;
  kind: "Activity" | "Accepted" | "Correction";
  record: ContributionRecord;
  detail?: string | undefined;
}

function feedEntries(records: readonly ContributionRecord[], cutoff: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const record of records) {
    entries.push({ key: `${record.id}-a`, at: record.occurredAt, kind: "Activity", record });
    if (record.acceptedAt && record.acceptedAt <= cutoff)
      entries.push({
        key: `${record.id}-q`,
        at: record.acceptedAt,
        kind: "Accepted",
        record,
        detail: record.acceptanceRule ?? undefined,
      });
    for (const correction of record.corrections) {
      if (correction.at <= cutoff)
        entries.push({
          key: correction.correctionId,
          at: correction.at,
          kind: "Correction",
          record,
          detail: correction.summary,
        });
    }
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export function ActivityPage() {
  const { scope } = useScope();
  const latest = useLatestSnapshotId();
  const state = useRead(() => listActivity(scope, latest), [serializeScope(scope), latest]);
  return (
    <>
      <PageHeader eyebrow="Public feed" title="Activity">
        <p>
          Artifact-level activity in time order. Activity, acceptance and correction are separate entries; a feed entry
          is not a claim that the work was accepted.
        </p>
      </PageHeader>
      <ScopeBar timeWindow={state.status === "ready" ? state.data.window : null} />
      {state.status === "loading" && <Loading label="activity" />}
      {state.status === "error" && <ErrorState error={state.error} />}
      {state.status === "ready" && (
        <>
          <div className="board-meta">
            <FreshnessIndicator view={state.data.snapshot} compact />
          </div>
          <SnapshotNotices view={state.data.snapshot} />
          {state.data.records.length === 0 ? (
            <EmptyState title="No activity in this scope">Nothing was observed in this window.</EmptyState>
          ) : (
            <ol className="feed">
              {feedEntries(state.data.records, state.data.snapshot.served.cutoff)
                .slice(0, 60)
                .map((entry) => (
                  <li key={entry.key} className="feed-entry">
                    <time dateTime={entry.at} className="mono muted">
                      {formatDateTime(entry.at)}
                    </time>
                    <span className="tag">{entry.kind}</span>
                    <span>
                      <PersonName person={personFor(entry.record.actorId)} /> ·{" "}
                      <ScopedLink to={`/contributions/${entry.record.id}`}>{entry.record.title}</ScopedLink>
                      {entry.kind === "Activity" && (
                        <>
                          {" "}
                          · <StateLabel state={entry.record.evidence} />
                        </>
                      )}
                      {entry.detail && <span className="muted"> · {entry.detail}</span>}
                      <span className="muted">
                        {" "}
                        · {repositories.find((repo) => repo.id === entry.record.repoId)?.name}
                      </span>
                    </span>
                  </li>
                ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}

export function CorrectionsPage() {
  const records = listCorrections();
  return (
    <>
      <PageHeader eyebrow="Accountability" title="Corrections">
        <p>A minimized public history of corrections to counted results. Privacy choices are not published here.</p>
      </PageHeader>
      {records.length === 0 ? (
        <EmptyState title="No corrections">No published result has been corrected.</EmptyState>
      ) : (
        <ul className="receipt-list">
          {records.flatMap((record) =>
            record.corrections.map((correction) => (
              <li key={correction.correctionId} className="receipt-row">
                <div className="receipt-row-main">
                  <span className="mono">{correction.correctionId}</span>
                  <ScopedLink to={`/contributions/${record.id}`}>{record.title}</ScopedLink>
                </div>
                <div className="receipt-row-meta muted">
                  <time dateTime={correction.at}>{formatDateTime(correction.at)}</time> · {correction.summary}
                </div>
              </li>
            )),
          )}
        </ul>
      )}
    </>
  );
}
