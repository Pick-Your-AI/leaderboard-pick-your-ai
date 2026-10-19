import React, { useEffect, useRef, useState } from "react";
import type { AchievementProof } from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { request, ReadFailure, uiHref, type Selection } from "./client.ts";
import { EditorialRotation } from "./OverviewDiscovery.tsx";
import { EditorialDimensions } from "./EditorialDimensions.tsx";
import {
  achievements,
  cardHref,
  cardImageHref,
  milestoneParameters,
  recognitionParameters,
  spotlights,
  supportsEditorialScope,
} from "./recognition-client.ts";

type Load<T> = { key: string; value?: T; error?: boolean };
/** A new request clears old evidence; errors never retain a prior successful result. */
function useCurrentRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Load<T>>({ key });
  useEffect(() => {
    let controller: AbortController | undefined;
    let stopped = false;
    const refresh = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      if (document.hidden) {
        setState({ key });
        return;
      }
      setState((previous) => (previous.key === key && previous.value !== undefined ? previous : { key }));
      try {
        const value = await load(current.signal);
        if (!stopped && !current.signal.aborted) setState({ key, value });
      } catch {
        if (!stopped && !current.signal.aborted) setState({ key, error: true });
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    const visibility = () => void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
    };
    // key includes every request input; inline load must not restart on state renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key };
}

function ProofLink({ proof, selected, label }: { proof: AchievementProof; selected: Selection; label: string }) {
  return (
    <p>
      <a
        data-api-nav
        href={uiHref("/contributions/" + encodeURIComponent(proof.contributionId), selected, { cursor: null })}
      >
        {label}
      </a>
      {" — "}
      {proof.roles.join(", ")}; source occurrence: <time dateTime={proof.occurredAt}>{proof.occurredAt}</time>.
    </p>
  );
}

function AchievementResults({
  base,
  selected,
  snapshotId,
  actorId,
}: {
  base: string;
  selected: Selection;
  snapshotId: string;
  actorId: string;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const pageFocus = useRef(false);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const pinned = { ...selected, snapshot: snapshotId, limit: "20", cursor: null };
  const params = milestoneParameters(selected, snapshotId, cursors.at(-1) ?? null);
  const key = JSON.stringify([base, actorId, params.toString()]);
  const state = useCurrentRead(key, async (signal) =>
    achievements(
      await request(base, "contributors/" + encodeURIComponent(actorId) + "/achievements", params, signal),
      pinned,
      actorId,
    ),
  );
  const value = state.value;
  const milestone = value?.ruleVersion === "accepted-evidence/v2" ? value : null;
  useEffect(() => {
    if (pageFocus.current && (value || state.error)) {
      (state.error ? errorMessage.current : pageHeading.current)?.focus();
      pageFocus.current = false;
    }
  }, [key, value, state.error]);
  const movePage = (next: string[]) => {
    pageFocus.current = true;
    setCursors(next);
  };
  return (
    <div aria-live="polite">
      {state.error ? (
        <p ref={errorMessage} tabIndex={-1}>
          {selected.category
            ? "Achievements are unavailable for this category-filtered portfolio. No broader achievements were substituted."
            : "Achievements are unavailable. No award or policy approval is implied."}
          {cursors.length > 0 && " Restart the shared-artifact list to recheck its current evidence."}
        </p>
      ) : !value ? (
        <p>Checking accepted achievements…</p>
      ) : !value.achievements.length ? (
        <p>No qualifying accepted achievements are available in this scope.</p>
      ) : (
        <ul>
          {value.achievements.map((award) => (
            <li key={award.id}>
              <h3>
                {award.label}
                {"categoryId" in award && award.categoryId !== null
                  ? ": " +
                    (metricRegistryV1.metrics.find((metric) => metric.id === award.categoryId)?.name ??
                      award.categoryId)
                  : ""}
              </h3>
              <p>{award.scopeMeaning}</p>
              <p>
                Source occurrence: <time dateTime={award.occurredAt}>{award.occurredAt}</time>. Rule:{" "}
                {award.ruleVersion}.{award.sharedCredit ? " Shared coauthor credit." : ""}
              </p>
              {"proof" in award && (
                <ProofLink proof={award.proof} selected={pinned} label="Inspect qualifying contribution" />
              )}
              {award.sourceUrls.map((url) => (
                <a key={url} href={url} rel="noreferrer nofollow">
                  Qualifying public artifact
                </a>
              ))}
            </li>
          ))}
        </ul>
      )}
      {milestone && (
        <section aria-labelledby="co-contributions-title">
          <h3 ref={pageHeading} tabIndex={-1} id="co-contributions-title">
            Accepted work on shared artifacts
          </h3>
          <p>Rule: {milestone.ruleVersion}. Categories are registered measures, not inferred teams or workstreams.</p>
          <p>{milestone.coContributionMeaning}</p>
          <p>
            {milestone.totalCoContributions} links in the visible evidence for this selection. Page {cursors.length + 1}
            .
          </p>
          {milestone.coContributions.length === 0 ? (
            <p>
              No qualifying shared-artifact links are available on this page. This does not establish that no
              collaboration occurred.
            </p>
          ) : (
            <ul>
              {milestone.coContributions.map((pair) => (
                <li key={JSON.stringify([pair.subject.artifactId, pair.peer.actorId])}>
                  <h4>
                    <a
                      data-api-nav
                      href={uiHref("/contributors/" + encodeURIComponent(pair.peer.actorId), pinned, { cursor: null })}
                    >
                      {pair.peer.displayName ?? pair.peer.login ?? pair.peer.actorId}
                    </a>
                  </h4>
                  <p>
                    {pair.relationship === "shared_authorship"
                      ? "Accepted shared authorship"
                      : "Accepted author and reviewer evidence"}
                  </p>
                  <ProofLink proof={pair.subject} selected={pinned} label="Inspect this contributor's proof" />
                  <ProofLink proof={pair.peerProof} selected={pinned} label="Inspect peer contribution" />
                  <a href={pair.subject.sourceUrl} rel="noreferrer nofollow">
                    Shared public artifact
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {(milestone?.nextCursor || cursors.length > 0) && (
        <nav aria-label="Shared-artifact evidence pages">
          {cursors.length > 0 && (
            <button type="button" onClick={() => movePage(cursors.slice(0, -1))}>
              Previous shared-artifact page
            </button>
          )}
          {milestone?.nextCursor && (
            <button type="button" onClick={() => movePage([...cursors, milestone.nextCursor!])}>
              Next shared-artifact page
            </button>
          )}
          {cursors.length > 0 && (
            <button type="button" onClick={() => movePage([])}>
              Restart shared-artifact list
            </button>
          )}
        </nav>
      )}
    </div>
  );
}

export function ContributorRecognition({
  base,
  selected,
  snapshotId,
  actorId,
  metricIds,
}: {
  base: string;
  selected: Selection;
  snapshotId: string;
  actorId: string;
  metricIds: string[];
}) {
  const params = recognitionParameters(selected, snapshotId);
  const key = JSON.stringify([base, actorId, params.toString(), selected.category]);
  return (
    <section aria-labelledby="recognition-title">
      <h2 id="recognition-title">Sharing and accepted achievements</h2>
      <p>
        Cards describe this dated snapshot and recheck current visibility when opened. Copied images and third-party
        caches cannot be remotely withdrawn.
      </p>
      <ul>
        {[...new Set(metricIds)].map((metric) => (
          <li key={metric}>
            <a href={cardHref(base, selected, snapshotId, actorId, metric)}>Open archived {metric} card</a>
            {" · "}
            <a href={cardImageHref(base, selected, snapshotId, actorId, metric)}>Open {metric} SVG image</a>
            <label>
              README Markdown for {metric}
              <textarea
                readOnly
                rows={3}
                value={`[![Dated ${metric} contribution snapshot](${new URL(cardImageHref(base, selected, snapshotId, actorId, metric), window.location.origin).href})](${new URL(cardHref(base, selected, snapshotId, actorId, metric), window.location.origin).href})`}
              />
            </label>
          </li>
        ))}
      </ul>
      <AchievementResults key={key} base={base} selected={selected} snapshotId={snapshotId} actorId={actorId} />
    </section>
  );
}

/** Controls editorial data has no snapshot/filter protocol. Mount only on the
 * current, unfiltered organization overview, with configured organization scope. */
export function EditorialSpotlights({
  controlsBase,
  publicBase,
  organization,
  selected,
}: {
  controlsBase: string;
  publicBase: string;
  organization: string;
  selected: Selection;
}) {
  const supported = supportsEditorialScope(selected, organization);
  const [dimensions, setDimensions] = useState(false);
  const key = JSON.stringify([controlsBase, organization, selected]);
  useEffect(() => setDimensions(false), [key]);
  const state = useCurrentRead(key, async (signal) => {
    if (!supported) throw new ReadFailure(400, "editorial_scope_unavailable");
    const base = new URL(controlsBase, window.location.origin);
    if (
      base.origin !== window.location.origin ||
      base.search ||
      base.hash ||
      base.username ||
      base.password ||
      base.pathname !== "/controls"
    )
      throw new ReadFailure(500, "invalid_controls_configuration");
    return spotlights(await request(base.href, "spotlights", new URLSearchParams(), signal));
  });
  return (
    <section aria-labelledby="editorial-title">
      <h2 id="editorial-title">Editorial spotlights</h2>
      <p>Current reviewed selections, separate from computed rankings and historical snapshots.</p>
      {supported && (
        <button onClick={() => setDimensions((value) => !value)}>
          {dimensions ? "Return to category-only spotlights" : "Explore editorial dimensions"}
        </button>
      )}
      <div aria-live="polite">
        {supported && dimensions ? (
          <EditorialDimensions
            key={key}
            controlsBase={controlsBase}
            publicBase={publicBase}
            organization={organization}
            selected={selected}
          />
        ) : !supported || state.error ? (
          <p>Editorial selections are unavailable for this view.</p>
        ) : !state.value ? (
          <p>Checking current selections…</p>
        ) : !state.value.length ? (
          <p>No currently approved, opted-in spotlights are available.</p>
        ) : (
          <EditorialRotation items={state.value} />
        )}
      </div>
    </section>
  );
}
