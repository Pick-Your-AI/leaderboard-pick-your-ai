import React, { useEffect, useRef } from "react";
import type { ContributionRecord, Person } from "../data/model.ts";
import { getMetric } from "../data/registry.ts";
import { repositories } from "../data/source.ts";
import { formatDateTime } from "../lib/format.ts";
import { Link } from "../lib/router.tsx";
import { StateLabel } from "./status.tsx";

const roleLabels: Record<ContributionRecord["role"], string> = {
  author: "Author",
  coauthor: "Co-author",
  reviewer: "Reviewer",
  merger: "Merger",
  triager: "Triager",
  reporter: "Reporter",
  resolver: "Resolver",
  automation: "Automation",
};

const adapterLabels: Record<ContributionRecord["adapter"], string> = {
  github_webhook: "GitHub webhook",
  github_rest: "GitHub REST read",
  github_graphql: "GitHub GraphQL read",
  reviewed_receipt: "Reviewed receipt",
};

export function PersonName({ person, link = true }: { person: Person | null; link?: boolean }) {
  if (!person) return <span className="muted">Unknown actor</span>;
  if (person.publicState === "deleted") return <span className="muted">Deleted account</span>;
  const label = (
    <>
      {person.displayName} <span className="mono muted">@{person.login}</span>
      {person.actor.kind !== "user" && <span className="tag">Automation</span>}
    </>
  );
  return link ? <Link to={`/contributors/${encodeURIComponent(person.login)}`}>{label}</Link> : <span>{label}</span>;
}

export function SourceLink({ record }: { record: ContributionRecord }) {
  if (record.visibility !== "public" || !record.sourceUrl) {
    return <span className="muted">Source no longer public; the link was removed.</span>;
  }
  return (
    <a href={record.sourceUrl} rel="noreferrer nofollow">
      Synthetic source link <span aria-hidden="true">↗</span>
      <span className="visually-hidden"> (points at the reserved synthetic.example domain)</span>
    </a>
  );
}

/** One evidence row: what happened, its state and where to verify it. */
export function ReceiptRow({ record }: { record: ContributionRecord }) {
  const repo = repositories.find((candidate) => candidate.id === record.repoId)?.name ?? record.repoId;
  return (
    <li className="receipt-row">
      <div className="receipt-row-main">
        <Link to={`/contributions/${record.id}`}>{record.title}</Link>
        <StateLabel state={record.evidence} />
      </div>
      <div className="receipt-row-meta muted">
        <span className="mono">{repo}</span> · {roleLabels[record.role]} ·{" "}
        <time dateTime={record.occurredAt}>{formatDateTime(record.occurredAt)}</time>
        {record.exclusionReason && <> · {record.exclusionReason}</>}
      </div>
    </li>
  );
}

/** The full proof for a single contribution, shared by the drawer and the page. */
export function ReceiptBody({ record, person }: { record: ContributionRecord; person: Person | null }) {
  const repo = repositories.find((candidate) => candidate.id === record.repoId)?.name ?? record.repoId;
  return (
    <dl className="receipt">
      <dt>State</dt>
      <dd>
        <StateLabel state={record.evidence} />
        {record.acceptanceRule && <span className="muted"> under rule: {record.acceptanceRule}</span>}
      </dd>
      <dt>Actor and role</dt>
      <dd>
        <PersonName person={person} /> · {roleLabels[record.role]}
      </dd>
      <dt>Activity time</dt>
      <dd>
        <time dateTime={record.occurredAt}>{formatDateTime(record.occurredAt)}</time>
      </dd>
      <dt>Accepted</dt>
      <dd>{record.acceptedAt ? <time dateTime={record.acceptedAt}>{formatDateTime(record.acceptedAt)}</time> : "Not accepted (no acceptance time is invented)"}</dd>
      <dt>Counts toward</dt>
      <dd>
        <ul className="inline-list">
          {record.metricIds.map((metricId) => (
            <li key={metricId}>
              <Link to={`/leaderboards/${metricId}`}>{getMetric(metricId)?.name ?? metricId}</Link>
            </li>
          ))}
        </ul>
      </dd>
      {record.exclusionReason && (
        <>
          <dt>Exclusion</dt>
          <dd>{record.exclusionReason}</dd>
        </>
      )}
      {record.lines && (
        <>
          <dt>Lines changed</dt>
          <dd>
            source {record.lines.source}, docs {record.lines.docs}, tests {record.lines.tests}, other {record.lines.other}; excluded:
            generated {record.lines.generated}, vendor {record.lines.vendor}, lockfile {record.lines.lockfile}
          </dd>
        </>
      )}
      <dt>Repository</dt>
      <dd className="mono">{repo}</dd>
      <dt>Public source</dt>
      <dd>
        <SourceLink record={record} />
      </dd>
      <dt>Ingestion</dt>
      <dd>
        {adapterLabels[record.adapter]}, first observed <time dateTime={record.observedAt}>{formatDateTime(record.observedAt)}</time>
      </dd>
      <dt>Corrections</dt>
      <dd>
        {record.corrections.length === 0
          ? "None"
          : record.corrections.map((correction) => (
              <p key={correction.correctionId}>
                <span className="mono">{correction.correctionId}</span> ·{" "}
                <time dateTime={correction.at}>{formatDateTime(correction.at)}</time>: {correction.summary}
              </p>
            ))}
      </dd>
      <dt>Fixture explanation</dt>
      <dd>{record.fixtureNote}</dd>
    </dl>
  );
}

/**
 * Supplementary evidence panel. Opening and closing are URL changes, so the
 * browser Back button closes it. Focus moves to its heading on open and back
 * to the opener on close; Escape closes it. Below 1024px it is a full-screen
 * modal dialog that keeps focus inside.
 */
export function ReceiptDrawer({
  title,
  onClose,
  children,
  fullPageHref,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  fullPageHref?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);
  const modal = typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;

  useEffect(() => {
    openerRef.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!modal || event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>("a[href], button, [tabindex='-1'], input, select");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal, onClose]);

  return (
    <>
      {modal && <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />}
      <div
        ref={panelRef}
        className="drawer"
        role="dialog"
        aria-modal={modal ? "true" : "false"}
        aria-labelledby="drawer-title"
      >
        <div className="drawer-header">
          <h2 id="drawer-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Close <span className="visually-hidden">evidence panel</span>
            <span aria-hidden="true"> ✕</span>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {fullPageHref && (
          <p className="drawer-footer">
            <Link to={fullPageHref}>Open as a full page</Link>
          </p>
        )}
      </div>
    </>
  );
}
