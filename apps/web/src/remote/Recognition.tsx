import React, { useEffect, useState } from "react";
import { request, ReadFailure, type Selection } from "./client.ts";
import { achievements, cardHref, recognitionParameters, spotlights } from "./recognition-client.ts";

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
  const pinned = { ...selected, snapshot: snapshotId };
  const params = recognitionParameters(selected, snapshotId);
  const key = JSON.stringify([base, actorId, params.toString()]);
  const state = useCurrentRead(key, async (signal) =>
    achievements(
      await request(base, `contributors/${encodeURIComponent(actorId)}/achievements`, params, signal),
      pinned,
      actorId,
    ),
  );
  return (
    <section aria-labelledby="recognition-title">
      <h2 id="recognition-title">Sharing and accepted achievements</h2>
      <p>Cards describe this dated snapshot and recheck current visibility when opened.</p>
      <ul>
        {[...new Set(metricIds)].map((metric) => (
          <li key={metric}>
            <a href={cardHref(base, selected, snapshotId, actorId, metric)}>Open archived {metric} card</a>
          </li>
        ))}
      </ul>
      <div aria-live="polite">
        {state.error ? (
          <p>Achievements are unavailable. No award or policy approval is implied.</p>
        ) : !state.value ? (
          <p>Checking accepted achievements…</p>
        ) : !state.value.achievements.length ? (
          <p>No qualifying accepted achievements are available in this scope.</p>
        ) : (
          <ul>
            {state.value.achievements.map((award) => (
              <li key={award.id}>
                <h3>{award.label}</h3>
                <p>{award.scopeMeaning}</p>
                <p>
                  Source occurrence: <time dateTime={award.occurredAt}>{award.occurredAt}</time>. Rule:{" "}
                  {award.ruleVersion}.{award.sharedCredit ? " Shared coauthor credit." : ""}
                </p>
                {award.sourceUrls.map((url) => (
                  <a key={url} href={url} rel="noreferrer nofollow">
                    Qualifying public artifact
                  </a>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Controls editorial data has no snapshot/filter protocol. Mount only on the
 * current, unfiltered organization overview, with configured organization scope. */
export function EditorialSpotlights({
  controlsBase,
  organization,
  selected,
}: {
  controlsBase: string;
  organization: string;
  selected: Selection;
}) {
  const supported =
    selected.organization === organization &&
    !selected.repository &&
    !selected.workstream &&
    !selected.start &&
    !selected.end &&
    !selected.snapshot &&
    !selected.category &&
    !selected.search;
  const key = JSON.stringify([controlsBase, organization, selected]);
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
      <div aria-live="polite">
        {!supported || state.error ? (
          <p>Editorial selections are unavailable for this view.</p>
        ) : !state.value ? (
          <p>Checking current selections…</p>
        ) : !state.value.length ? (
          <p>No currently approved, opted-in spotlights are available.</p>
        ) : (
          <ul>
            {state.value.map((item) => (
              <li key={item.id}>
                <h3>{item.category}</h3>
                {item.bio && <p>{item.bio}</p>}
                <p>{item.selectionExplanation}</p>
                <p>
                  Selected <time dateTime={item.selectedAt}>{item.selectedAt}</time>.
                </p>
                <a href={item.sourceUrl} rel="noreferrer nofollow">
                  Reviewed public evidence
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
