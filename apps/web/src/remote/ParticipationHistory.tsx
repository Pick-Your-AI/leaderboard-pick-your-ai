import React, { useEffect, useRef, useState } from "react";
import type { MetricDefinition, PublicParticipationHistory } from "@pick-your-ai/contracts";
import { request, type Selection } from "./client.ts";
import {
  participationHistory,
  participationHistoryParameters,
  participationHistoryPath,
  participationFirstProof,
  participationFirstProofPath,
  type ContributorHistory,
  type HistoryParent,
} from "./participation-history-client.ts";

const reasons = {
  reviewed_history_unavailable: "Reviewed organization history is unavailable from this provider.",
  history_incomplete: "The required sources do not all cover the reviewed origin through the observation cutoff.",
  history_evidence_unavailable: "Required history evidence is unresolved or unavailable under current visibility.",
  qualifying_policy_unavailable: "The complete qualifying policy set is unavailable for this read.",
  qualifying_actor_unavailable: "The required current contributor identity and account scope are unavailable.",
  no_qualifying_evidence: "The supplied history has no qualifying accepted proof for this contributor.",
};
const literalStyle = { overflowWrap: "anywhere" as const, whiteSpace: "pre-wrap" as const };

/** Pure presentation of a validated result; source admission stays server-side. */
export function OrganizationHistorySummary({
  history,
  metrics,
}: {
  history: PublicParticipationHistory;
  metrics: readonly MetricDefinition[];
}) {
  if (history.state === "unknown")
    return (
      <p>
        First qualifying contribution is unknown. {reasons[history.reason]} Missing history does not establish zero
        activity or newcomer status.
      </p>
    );
  return (
    <>
      <p>
        First qualifying accepted source occurrence in the reviewed organization history:{" "}
        <time dateTime={history.firstProof.proof.occurredAt}>{history.firstProof.proof.occurredAt}</time>. Observed{" "}
        <time dateTime={history.firstProof.observedAt}>{history.firstProof.observedAt}</time>.
      </p>
      <p>
        {history.newcomer === true
          ? "That first qualifying contribution falls within the selected start-inclusive, end-exclusive period."
          : history.newcomer === false
            ? "That first qualifying contribution falls outside the selected start-inclusive, end-exclusive period."
            : history.periodReason === "unbounded_selection"
              ? "The all-time selection has no completed-period newcomer assessment."
              : "The observation cutoff precedes the selected period end, so newcomer status for that complete period is unknown."}
      </p>
      <p>
        Reviewed organization: {history.basis.scope.organization}. History begins{" "}
        <time dateTime={history.basis.origin}>{history.basis.origin}</time>; frozen observation cutoff{" "}
        <time dateTime={history.basis.cutoff}>{history.basis.cutoff}</time>.
      </p>
      <details>
        <summary>Required history sources and qualifying policies</summary>
        <p>Every listed repository/source pair covers the reviewed origin through the cutoff in this admitted read.</p>
        <ul>
          {history.basis.sourceInventory.map((pair) => (
            <li key={pair.repositoryId + ":" + pair.source} style={literalStyle}>
              Repository {pair.repositoryId}; {pair.source}.
            </li>
          ))}
        </ul>
        <ul>
          {history.basis.policies.map((policy) => (
            <li key={policy.metricId} style={literalStyle}>
              {metrics.find((metric) => metric.id === policy.metricId)?.name ?? policy.metricId}; policy{" "}
              {policy.version}; roles {policy.roles.join(", ")}; sources {policy.sources.join(", ")}; signature{" "}
              <code>{policy.signature}</code>.
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function FirstProof({
  base,
  selected,
  value,
  metrics,
  unavailable,
}: {
  base: string;
  selected: Selection;
  value: ContributorHistory;
  metrics: readonly MetricDefinition[];
  unavailable: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [verified, setVerified] = useState<ReturnType<typeof participationFirstProof> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const key = value.history.historyKey;
  const close = () => {
    setExpanded(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!expanded) {
      setVerified(null);
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    setVerified(null);
    void (async () => {
      try {
        const response = await request(
          base,
          participationFirstProofPath(value.actorId, value.history),
          participationHistoryParameters(selected, value.snapshotId),
          controller.signal,
        );
        const proof = participationFirstProof(response, selected, value, metrics);
        if (!stopped && !controller.signal.aborted) setVerified(proof);
      } catch {
        if (!stopped && !controller.signal.aborted) unavailable();
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
    // The immutable key binds the complete history and request; a same-key parent
    // refresh preserves this open region and keyboard focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, key]);
  useEffect(() => {
    if (verified) heading.current?.focus();
  }, [verified]);
  const proof = verified?.history.firstProof.proof;
  return (
    <div data-first-proof-key={key}>
      <button
        ref={button}
        type="button"
        aria-expanded={expanded}
        aria-controls="organization-first-proof"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Close first proof" : "Inspect first proof"}
      </button>
      {expanded && (
        <section
          id="organization-first-proof"
          aria-labelledby="organization-first-proof-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <h4 id="organization-first-proof-title" ref={heading} tabIndex={-1}>
            First qualifying proof
          </h4>
          {!proof ? (
            <p role="status">Checking the exact history proof under current visibility…</p>
          ) : (
            <>
              <p>
                This proof belongs to the complete admitted organization history. Its repository and category can differ
                from this profile selection.
              </p>
              <dl style={literalStyle}>
                <dt>Contributor</dt>
                <dd>{proof.actorId}</dd>
                <dt>Contribution</dt>
                <dd>{proof.contributionId}</dd>
                <dt>Original source event</dt>
                <dd>{proof.canonicalEventId}</dd>
                <dt>Artifact identifier</dt>
                <dd>
                  <code>{JSON.stringify(proof.artifactId)}</code>
                </dd>
                <dt>Artifact kind</dt>
                <dd>{proof.artifactKind}</dd>
                <dt>Repository</dt>
                <dd>{proof.repositoryId}</dd>
                <dt>Recorded roles</dt>
                <dd>{proof.roles.join(", ")}</dd>
                <dt>Recorded categories</dt>
                <dd>
                  {proof.metricIds.map((id) => metrics.find((metric) => metric.id === id)?.name ?? id).join(", ")}
                </dd>
                <dt>Source occurrence</dt>
                <dd>
                  <time dateTime={proof.occurredAt}>{proof.occurredAt}</time>
                </dd>
                <dt>Observed</dt>
                <dd>
                  <time dateTime={verified.history.firstProof.observedAt}>
                    {verified.history.firstProof.observedAt}
                  </time>
                </dd>
              </dl>
              <a href={proof.sourceUrl} rel="noreferrer">
                Open the public first-proof source
              </a>
              <p>
                <button type="button" onClick={close}>
                  Return to organization history
                </button>
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}

type Load = { key: string; value?: ContributorHistory; error?: boolean };
export function ContributorOrganizationHistory({
  base,
  selected,
  parent,
  actorId,
  metrics,
}: {
  base: string;
  selected: Selection;
  parent: HistoryParent;
  actorId: string;
  metrics: readonly MetricDefinition[];
}) {
  const pinned = { ...selected, snapshot: parent.snapshotId, cursor: null };
  const params = participationHistoryParameters(selected, parent.snapshotId);
  const key = JSON.stringify([
    base,
    actorId,
    params.toString(),
    parent.revision,
    parent.generatedAt,
    parent.policyVersion,
    parent.metricDefinitionVersion,
    parent.computationVersion,
  ]);
  const [state, setState] = useState<Load>({ key });
  const [generation, setGeneration] = useState(0);
  const section = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const error = useRef<HTMLParagraphElement>(null);
  const focusAfterChange = useRef<"heading" | "error" | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const retainRemovalFocus = (nextKey: string | null, failed = false) => {
    const inspected = section.current?.querySelector<HTMLElement>("[data-first-proof-key]");
    if (inspected?.contains(document.activeElement) && inspected.dataset.firstProofKey !== nextKey)
      focusAfterChange.current = failed ? "error" : "heading";
  };
  useEffect(() => {
    let controller: AbortController | undefined;
    let stopped = false;
    const refresh = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      activeRequest.current = requestController;
      if (document.hidden) {
        retainRemovalFocus(null);
        setState({ key });
        return;
      }
      setState((previous) => (previous.key === key && previous.value !== undefined ? previous : { key }));
      try {
        const response = await request(base, participationHistoryPath(actorId), params, requestController.signal);
        const value = participationHistory(response, pinned, actorId, parent, metrics);
        if (!stopped && activeRequest.current === requestController && !requestController.signal.aborted) {
          retainRemovalFocus(value.history.historyKey);
          setState({ key, value });
        }
      } catch {
        if (!stopped && activeRequest.current === requestController && !requestController.signal.aborted) {
          retainRemovalFocus(null, true);
          setState({ key, error: true });
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    const visibility = () => void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      if (activeRequest.current === controller) activeRequest.current = null;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
    };
    // Every source and parent binding is in key. Same-selection validation does
    // not restart merely because React received a fresh wrapper object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation]);
  const current = state.key === key ? state : { key };
  useEffect(() => {
    if (focusAfterChange.current === null || document.hidden) return;
    (focusAfterChange.current === "error" ? error.current : title.current)?.focus();
    focusAfterChange.current = null;
  }, [current.value, current.error]);
  return (
    <section ref={section} aria-labelledby="organization-history-title">
      <h3 id="organization-history-title" ref={title} tabIndex={-1}>
        Reviewed organization history
      </h3>
      <p>
        Your profile filters apply to the selected activity summary. This separate read covers the full admitted
        organization universe and its named qualifying policies. It describes accepted source occurrences, with no
        change to ranks.
      </p>
      <p>
        The reviewed origin is the boundary of this history claim. A first qualifying proof does not establish a joining
        date, first-ever work, manual execution or personal quality.
      </p>
      {current.error ? (
        <>
          <p role="status" ref={error} tabIndex={-1}>
            Organization history is unavailable or changed. Previous first-proof details have been cleared.
          </p>
          <button
            type="button"
            onClick={() => {
              focusAfterChange.current = "heading";
              setGeneration((value) => value + 1);
            }}
          >
            Check organization history again
          </button>
        </>
      ) : !current.value ? (
        <p role="status">Checking whether reviewed organization history is available…</p>
      ) : (
        <>
          <OrganizationHistorySummary history={current.value.history} metrics={metrics} />
          {current.value.history.state === "known" && (
            <FirstProof
              key={current.value.history.historyKey}
              base={base}
              selected={pinned}
              value={current.value}
              metrics={metrics}
              unavailable={() => {
                // A newer proof denial also revokes an older parent response
                // that may already be in transport under the same selection.
                const obsoleteRequest = activeRequest.current;
                activeRequest.current = null;
                obsoleteRequest?.abort();
                focusAfterChange.current = "error";
                setState({ key, error: true });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
