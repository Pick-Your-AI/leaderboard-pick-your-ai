import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { publicWindowPeriods, type PublicWindowPeriod, type PublicWindows } from "@pick-your-ai/contracts";
import { apiBase, ReadFailure, uiHref, type Selection } from "./client.ts";
import { PublicScopeProvenance } from "./PublicScope.tsx";
import {
  choosePublishedWindow,
  readPublishedWindows,
  windowParameters,
  windowStartIntent,
} from "./published-windows.ts";

const labels: Record<PublicWindowPeriod, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "Month to date (UTC)",
  quarter: "Quarter to date (UTC)",
  year: "Year to date (UTC)",
  all: "All time",
};

type Discovery =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; value: PublicWindows }
  | { key: string; status: "error"; error: ReadFailure };

function failure(error: unknown): ReadFailure {
  return error instanceof ReadFailure ? error : new ReadFailure(503, "public_windows_unavailable");
}

function WindowFailure({ error, period }: { error: ReadFailure; period?: PublicWindowPeriod }) {
  const message =
    error.code === "public_window_unavailable" && period
      ? `${labels[period]} is unavailable for this selection. Choose an available window.`
      : error.status === 414
        ? "This selection is too large for a link. Reduce the selected filters before choosing a window."
        : error.status === 400
          ? "This date-window request is invalid. Check the link's filters and requested period."
          : error.status === 502
            ? "The published windows could not be verified for this selection."
            : "Published date windows are currently unavailable for this selection.";
  return <p role="alert">{message}</p>;
}

/** Ordinary readers choose explicitly. Only the separate /start entry supplies an automatic initial period. */
export function PublishedWindowPicker({
  base,
  selected,
  path,
  navigate,
  initialPeriod,
}: {
  base: string;
  selected: Selection;
  path: string;
  navigate: (href: string) => void;
  initialPeriod?: PublicWindowPeriod;
}) {
  const id = useId();
  const requestKey = JSON.stringify([base, windowParameters(selected).toString()]);
  const [attempt, setAttempt] = useState(0);
  const loadingKey = JSON.stringify([requestKey, attempt]);
  const [discovery, setDiscovery] = useState<Discovery>({ key: loadingKey, status: "loading" });
  const [choice, setChoice] = useState<{ key: string; period: PublicWindowPeriod } | null>(null);
  const [applicationError, setApplicationError] = useState<{ key: string; error: ReadFailure } | null>(null);
  const automaticAttempt = useRef<string | null>(null);
  const intentKey = JSON.stringify([loadingKey, initialPeriod, path, selected]);

  useEffect(() => {
    const controller = new AbortController();
    setDiscovery({ key: loadingKey, status: "loading" });
    void readPublishedWindows(base, selected, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setDiscovery({ key: loadingKey, status: "ready", value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDiscovery({ key: loadingKey, status: "error", error: failure(error) });
      },
    );
    return () => controller.abort();
    // The request key contains every source filter. Actor, metric and display intent do not change discovery.
  }, [loadingKey]);

  // A result for an older filter never supplies choices during a new render, even before effect cleanup.
  const current = discovery.key === loadingKey ? discovery : null;
  const available = current?.status === "ready" ? current.value : null;
  const chosenPeriod = choice?.key === requestKey ? choice.period : (initialPeriod ?? "");
  const chosen = available?.windows.find((item) => item.period === chosenPeriod);
  const apply = useCallback(
    (period: PublicWindowPeriod) => {
      if (!available) return;
      try {
        const next = choosePublishedWindow(selected, available, period);
        const href = uiHref(path, next);
        if (href.length > 48 * 1024) throw new ReadFailure(414, "query_too_large");
        setApplicationError(null);
        navigate(href);
      } catch (error) {
        setApplicationError({ key: intentKey, error: failure(error) });
      }
    },
    [available, selected, path, navigate, intentKey],
  );
  useEffect(() => {
    if (!initialPeriod || !available || automaticAttempt.current === intentKey) return;
    automaticAttempt.current = intentKey;
    apply(initialPeriod);
  }, [initialPeriod, available, intentKey, apply]);

  const error =
    current?.status === "error" ? current.error : applicationError?.key === intentKey ? applicationError.error : null;
  const loading = current === null || current.status === "loading";
  return (
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Published date windows</h2>
      <p>
        Presets use the latest confirmed publication for these filters. Each choice opens its exact UTC dates and
        snapshot. Custom dates remain available through Exact scope and snapshot.
      </p>
      {loading && <p role="status">Checking published date windows…</p>}
      {error && <WindowFailure error={error} {...(initialPeriod ? { period: initialPeriod } : {})} />}
      {available?.windows.length === 0 && <p>No date windows are published for this selection.</p>}
      <form
        className="remote-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (!chosen) return;
          automaticAttempt.current = intentKey;
          apply(chosen.period);
        }}
      >
        <label htmlFor={`${id}-period`}>Date window</label>
        <select
          id={`${id}-period`}
          value={chosenPeriod}
          disabled={!available}
          onChange={(event) => {
            const value = event.target.value;
            if (!publicWindowPeriods.includes(value as PublicWindowPeriod)) return;
            automaticAttempt.current = intentKey;
            setChoice({ key: requestKey, period: value as PublicWindowPeriod });
            setApplicationError(null);
          }}
        >
          <option value="">Choose a published window</option>
          {publicWindowPeriods.map((period) => {
            const offered = available?.windows.some((item) => item.period === period) ?? false;
            return (
              <option key={period} value={period} disabled={!offered}>
                {labels[period]}
                {available && !offered ? " — unavailable" : ""}
              </option>
            );
          })}
        </select>
        <button className="button" type="submit" disabled={!chosen}>
          Open published window
        </button>
      </form>
      {chosen && (
        <p className="small">
          {chosen.scope.start ?? "All time"}
          {chosen.scope.end ? ` to ${chosen.scope.end} (exclusive)` : ""}. Snapshot {chosen.snapshotId}, revision{" "}
          {chosen.revision}.
        </p>
      )}
      <button className="button" type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>
        Check published windows again
      </button>
    </section>
  );
}

const replaceLocation = (href: string) => window.location.replace(href);

/** Mount this entry instead of a snapshot reader, before any board, health or live effects can run. */
export function PublishedWindowStart({
  base,
  search,
  navigate = replaceLocation,
}: {
  base: string;
  search: string;
  navigate?: (href: string) => void;
}) {
  const parsed = useMemo(() => {
    try {
      const intent = windowStartIntent("/start", search)!;
      const customHref = uiHref("/leaderboards", intent.selected);
      if (customHref.length > 48 * 1024) throw new ReadFailure(414, "query_too_large");
      return { intent, base: apiBase(base), customHref, error: null };
    } catch (error) {
      return { intent: null, base: "", customHref: "", error: failure(error) };
    }
  }, [base, search]);
  return (
    <main id="main" className="page">
      <h1>Browse public contribution evidence</h1>
      {parsed.error ? (
        <WindowFailure error={parsed.error} />
      ) : (
        <>
          <p>Requested window: {labels[parsed.intent.period]}.</p>
          <p>
            Organization: {parsed.intent.selected.organization}. Repository:{" "}
            {parsed.intent.selected.repository ?? "all"}. Workstream: {parsed.intent.selected.workstream ?? "all"}.
            Display timezone: {parsed.intent.selected.timeZone ?? "UTC"}.
          </p>
          <PublicScopeProvenance scope={parsed.intent.selected} />
          <p>
            <a href={parsed.customHref}>Browse measures or enter custom UTC dates</a>
          </p>
          <PublishedWindowPicker
            base={parsed.base}
            selected={parsed.intent.selected}
            path={`/leaderboards/${encodeURIComponent(parsed.intent.selected.metric)}`}
            navigate={navigate}
            initialPeriod={parsed.intent.period}
          />
        </>
      )}
    </main>
  );
}
