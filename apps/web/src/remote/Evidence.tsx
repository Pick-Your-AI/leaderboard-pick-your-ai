import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { publicLink, ReadFailure, uiHref, type Evidence, type Selection } from "./client.ts";
import { readProof, type PublicProof } from "./proof.ts";

function Source({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  const safe = publicLink(href);
  return safe ? (
    <a href={safe} rel="noreferrer nofollow">
      {children}
    </a>
  ) : (
    <span>Public source link unavailable</span>
  );
}
function Time({ value, unknown }: { value: string | null; unknown: string }) {
  // A collection clock or snapshot publication clock is never substituted for an event clock.
  return value && Number.isFinite(Date.parse(value)) ? <time dateTime={value}>{value}</time> : <span>{unknown}</span>;
}

/** Only the strict public metadata projection, shared by drawer, route and activity proofs. */
export function Receipt({ value, selected }: { value: Evidence; selected: Selection }) {
  const metadata = value.evidenceMetadata;
  return (
    <dl className="receipt" data-evidence-body>
      <dt>Contribution</dt>
      <dd>{value.contribution.contributionId}</dd>
      <dt>Artifact title</dt>
      <dd>
        {metadata?.artifactTitle ? (
          <>
            {metadata.artifactTitle.value}
            <br />
            Label as collected at <Time value={metadata.artifactTitle.collectedAt} unknown="Unknown" />; not an
            event-time title.
          </>
        ) : (
          "Not supplied by the public evidence API"
        )}
      </dd>
      <dt>Artifact</dt>
      <dd>
        {value.artifact.kind} · {value.artifact.stableId ?? "Unknown artifact ID"}
      </dd>
      <dt>Action</dt>
      <dd>
        {metadata && metadata.sourceAction !== "unknown"
          ? metadata.sourceAction.replaceAll("_", " ")
          : metadata
            ? "Action unknown; no envelope action is inferred"
            : "Action details are not supplied by this evidence contract"}
      </dd>
      <dt>Work state</dt>
      <dd>{value.activityState === "unknown" ? "Acceptance state unknown" : value.activityState}</dd>
      <dt>Qualification</dt>
      <dd>{value.contribution.qualification}. Eligibility is not independent acceptance.</dd>
      <dt>Participant roles</dt>
      <dd>{value.contribution.roles.join(", ")}</dd>
      <dt>Actor</dt>
      <dd>
        {value.contribution.actorId ? (
          <a data-api-nav href={uiHref(`/contributors/${encodeURIComponent(value.contribution.actorId)}`, selected)}>
            {value.contribution.actorId}
          </a>
        ) : (
          "Unknown"
        )}
      </dd>
      <dt>Occurrence time</dt>
      <dd>
        <Time value={value.occurredAt} unknown="Unknown; no event time is inferred" />
      </dd>
      <dt>Source occurrence time</dt>
      <dd>
        <Time value={metadata?.sourceOccurredAt ?? null} unknown="Unknown original source time" />. The occurrence time
        above follows this evidence period; acceptance can use a different clock.
      </dd>
      <dt>Collected at</dt>
      <dd>
        <Time value={value.observedAt} unknown="Unknown collection time" />. Collection time can be later than the
        contribution.
      </dd>
      <dt>Acceptance time</dt>
      <dd>
        {metadata?.acceptedAt ? (
          <>
            <Time value={metadata.acceptedAt} unknown="Unknown acceptance time" /> · Independent recognition receipt
          </>
        ) : value.activityState === "accepted" ? (
          "Unknown; the API supplies no acceptance timestamp"
        ) : value.activityState === "unknown" ? (
          "Unknown; neither acceptance nor its time can be inferred"
        ) : (
          "No acceptance time is supplied for observed or in-progress work"
        )}
      </dd>
      <dt>Eligibility reasons</dt>
      <dd>{value.contribution.reasonCodes.join(", ") || "No additional reason code supplied"}</dd>
      <dt>Exclusion and uncertainty limits</dt>
      <dd>
        Only the published qualification and reason codes above are available. Generated, imported or reverted
        exclusions are not inferred from an artifact type, title or missing history.
      </dd>
      <dt>Repository</dt>
      <dd>{value.artifact.repositoryId ?? "Unknown"}</dd>
      <dt>Source</dt>
      <dd>
        <Source href={value.artifact.publicUrl}>Open public source artifact</Source>
      </dd>
      <dt>Source revision</dt>
      <dd>
        {value.sourceRevision ?? "Unknown"} · <Source href={value.sourceRevisionUrl}>Revision source</Source>
      </dd>
      <dt>Revision and correction history</dt>
      <dd>
        {metadata?.history.coverage === "partial" ? (
          <>
            Partial public history only; missing records do not establish that no revisions or corrections occurred.
            <ul>
              {metadata.history.records.map((record, index) => (
                <li key={index}>
                  {record.kind === "correction" ? "Public correction" : `Source revision ${record.revision}`} ·{" "}
                  <Time value={record.occurredAt} unknown="Unknown record time" /> ·{" "}
                  <Source href={record.publicUrl}>Open public record</Source>
                </li>
              ))}
            </ul>
          </>
        ) : (
          "Not supplied by the public evidence API. The current source revision above does not establish a complete history."
        )}
      </dd>
      <dt>Measures</dt>
      <dd>
        {value.contribution.metricIds.map((id) => (
          <p key={id}>
            <a data-api-nav href={uiHref(`/leaderboards/${encodeURIComponent(id)}`, selected, { metric: id })}>
              {id}
            </a>
          </p>
        ))}
      </dd>
    </dl>
  );
}

/** Identical permitted evidence and provenance, used by permanent and overlay routes. */
export function EvidenceProof({ value, selected }: { value: PublicProof; selected: Selection }) {
  return (
    <section aria-label="Permitted contribution proof" data-proof-projection>
      <p>
        Snapshot {value.snapshotId} · revision {value.revision} · current publication controls {value.policyVersion}
      </p>
      <p>
        Scope: {selected.organization}
        {selected.repository ? ` · repository ${selected.repository}` : ""}
        {selected.workstream ? ` · workstream ${selected.workstream}` : ""} ·{" "}
        {selected.start ?? "All-time materialized scope"}
        {selected.end ? ` to ${selected.end} (exclusive)` : ""}
      </p>
      <Receipt value={value} selected={{ ...selected, snapshot: value.snapshotId }} />
    </section>
  );
}

const withdrawnProof = new ReadFailure(404, "evidence_no_longer_in_displayed_count");

type ProofState =
  { status: "loading" } | { status: "error"; error: ReadFailure } | { status: "ready"; value: PublicProof };

export function EvidenceDrawer({
  base,
  id,
  selected,
  recheck,
  onRecheck,
  boardIncludesProof,
  parentError,
  onClose,
  opener,
}: {
  base: string;
  id: string;
  selected: Selection;
  recheck: number;
  onRecheck: () => void;
  boardIncludesProof: boolean | null;
  parentError: ReadFailure | null;
  onClose: () => void;
  opener: HTMLElement | null;
}) {
  const [state, setState] = useState<ProofState>({ status: "loading" });
  const [modal, setModal] = useState(() => matchMedia("(max-width: 1023px)").matches);
  const [hidden, setHidden] = useState(() => document.visibilityState !== "visible");
  const panel = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const active = useRef<AbortController | null>(null);
  const lastSelection = useRef<string | null>(null);
  const wasReferenced = useRef(false);
  if (boardIncludesProof === true) wasReferenced.current = true;
  // A completed board recheck can withdraw this counted proof before its own read finishes.
  const blocked = parentError ?? (wasReferenced.current && boardIncludesProof === false ? withdrawnProof : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openerRef = useRef(opener);
  const headingId = useId();
  const identity = uiHref(`/contributions/${encodeURIComponent(id)}`, selected);

  useEffect(() => {
    const media = matchMedia("(max-width: 1023px)");
    const change = () => setModal(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const change = () => {
      const hidden = document.visibilityState !== "visible";
      setHidden(hidden);
      if (hidden) {
        active.current?.abort();
        setState({ status: "loading" });
      }
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    if (lastSelection.current !== identity) {
      setState({ status: "loading" });
      lastSelection.current = identity;
    }
    if (hidden || blocked) {
      setState({ status: "loading" });
      return () => controller.abort();
    }
    void readProof(base, id, selected, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState({ status: "ready", value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            error: error instanceof ReadFailure ? error : new ReadFailure(503, "public_read_unavailable"),
          });
      });
    return () => controller.abort();
    // identity captures every request-relevant scope field, pin and contribution ID.
  }, [base, identity, recheck, hidden, blocked]);

  useEffect(() => {
    heading.current?.focus();
    return () => {
      // DOM removals and inert cleanup must finish before restoring keyboard focus.
      queueMicrotask(() => {
        // StrictMode replay or a replacement proof must keep the new dialog's focus.
        if (document.querySelector(".remote-proof-drawer")) return;
        const original = openerRef.current;
        const target = original?.isConnected
          ? original
          : [...document.querySelectorAll<HTMLAnchorElement>("a[data-api-proof]")].find(
              (link) => original && link.getAttribute("href") === original.getAttribute("href"),
            );
        if (target && !target.closest("[inert]")) target.focus();
        else document.querySelector<HTMLElement>(".remote-app h1")?.focus();
      });
    };
  }, []);
  useEffect(() => {
    if (!modal) return;
    const background = document.querySelector<HTMLElement>(".remote-app");
    const wasInert = background?.inert ?? false,
      overflow = document.body.style.overflow;
    if (background) background.inert = true;
    document.body.style.overflow = "hidden";
    return () => {
      if (background) background.inert = wasInert;
      document.body.style.overflow = overflow;
    };
  }, [modal]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !modal || !panel.current) return;
      const nodes = [
        ...panel.current.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']",
        ),
      ].filter((node) => node.getClientRects().length > 0 && !node.closest("[inert]"));
      const first = nodes[0],
        last = nodes.at(-1);
      if (!first || !last) {
        event.preventDefault();
        heading.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === heading.current ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (modal && !panel.current?.contains(event.target as Node)) heading.current?.focus();
    };
    document.addEventListener("keydown", keyboard);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", keyboard);
      document.removeEventListener("focusin", containFocus);
    };
  }, [modal]);
  const error = blocked ?? (state.status === "error" ? state.error : null);
  // Clearing failed or withdrawn proof must not replace the close control or focused heading.
  useEffect(() => {
    if ((error || hidden) && panel.current && !panel.current.contains(document.activeElement)) heading.current?.focus();
  }, [error, hidden]);
  return createPortal(
    <>
      {modal && <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />}
      <div
        ref={panel}
        className="drawer remote-proof-drawer"
        role="dialog"
        aria-modal={modal ? "true" : "false"}
        aria-labelledby={headingId}
      >
        <div className="drawer-header">
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            Contribution evidence
          </h2>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Close <span className="visually-hidden">evidence panel</span>
          </button>
        </div>
        <div className="drawer-body">
          <p>
            <button type="button" className="button button-ghost" onClick={onRecheck}>
              Recheck evidence permissions
            </button>
          </p>
          {error ? (
            <section role="alert" className="notice notice-error">
              <h3>
                {error.status === 404
                  ? "Public record unavailable"
                  : error.status === 410
                    ? "Selection expired or revoked"
                    : "Public read unavailable"}
              </h3>
              <p>{error.code}</p>
              <p>This proof is no longer displayed. No fixture or retained personal content replaces it.</p>
            </section>
          ) : hidden || state.status === "loading" ? (
            <p role="status">Checking current public evidence…</p>
          ) : state.status === "ready" ? (
            <EvidenceProof value={state.value} selected={selected} />
          ) : null}
        </div>
        <p className="drawer-footer">
          <a data-api-nav href={identity}>
            Open as a full page
          </a>
        </p>
      </div>
    </>,
    document.body,
  );
}
