import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/wall.css";
import { actorFilterLabels, type Actor, type MetricRegistry } from "@pick-your-ai/contracts";
import { getLeadMetrics } from "@pick-your-ai/metrics";
import { PublicScopeProvenance } from "./PublicScope.tsx";
import { WindowBounds } from "../components/DisplayTimeZone.tsx";
import { LastVerifiedSnapshot, type SnapshotReference } from "./LastVerifiedSnapshot.tsx";
import {
  apiBase,
  catalog,
  health,
  parameters,
  request,
  uiHref,
  ReadFailure,
  type Health,
  type Selection,
} from "./client.ts";
import {
  firstWallPage,
  nextWallPage,
  readWallFrame,
  readWallQuery,
  wallBoards,
  wallHref,
  type WallFormat,
  type WallFrame,
  type WallMode,
  type WallOptions,
} from "./wall.ts";

const actorName = (actor: Actor, id: string) => actor.displayName ?? actor.login ?? id;
const number = (value: number | undefined | null) =>
  value == null ? "Unknown" : value.toLocaleString(undefined, { maximumSignificantDigits: 21 });
const oldestSync = (status: Health) => {
  const times = status.sources.map((source) =>
    source.lastSuccessfulSync ? Date.parse(source.lastSuccessfulSync) : NaN,
  );
  return !times.length || times.some((time) => !Number.isFinite(time))
    ? "Unknown for one or more sources"
    : new Date(Math.min(...times)).toISOString();
};
function Scope({ selected }: { selected: Selection }) {
  return (
    <div className="api-wall-scope">
      <p>
        {selected.organization}
        {selected.repository && ` · repository ${selected.repository}`}
        {selected.workstream && ` · workstream ${selected.workstream}`} · {actorFilterLabels[selected.actors ?? "all"]}
        <br />
        {selected.start ? `${selected.start} to ${selected.end} (end exclusive)` : "All-time materialized scope"}
      </p>
      <PublicScopeProvenance scope={selected} />
      <WindowBounds start={selected.start} end={selected.end} timeZone={selected.timeZone ?? "UTC"} />
    </div>
  );
}
function Failure({ error, previousSnapshot }: { error: ReadFailure; previousSnapshot?: SnapshotReference | null }) {
  return (
    <section className="notice notice-error" role="alert">
      <h2>
        {error.status === 410
          ? "Selection expired or revoked"
          : error.status === 429
            ? "Requests temporarily limited"
            : "Public wall unavailable"}
      </h2>
      <p>{error.code}</p>
      {error.status === 429 && <p>Wait before retrying this selection.</p>}
      {previousSnapshot && <LastVerifiedSnapshot value={previousSnapshot} />}
      <p>No saved contributor response or fixture is used after this failure.</p>
    </section>
  );
}

export function RemoteWall() {
  const parsed = useMemo(() => {
    try {
      return {
        ...readWallQuery(location.search),
        base: apiBase(import.meta.env.VITE_PUBLIC_API_BASE || "/api/v1"),
        error: null,
      };
    } catch (error) {
      return { error: error instanceof ReadFailure ? error : new ReadFailure(400, "invalid_wall_selection") };
    }
  }, []);
  useEffect(() => {
    document.title = "Public live wall · PickYour.AI Credits";
  }, []);
  if (parsed.error)
    return (
      <main className="page">
        <h1>Public live wall</h1>
        <Failure error={parsed.error} />
        <a href="/live?ui=api">Configure a public wall</a>
      </main>
    );
  return parsed.options.mode ? (
    <WallDisplay base={parsed.base} selected={parsed.selected} options={parsed.options} mode={parsed.options.mode} />
  ) : (
    <WallConfigurator base={parsed.base} selected={parsed.selected} options={parsed.options} />
  );
}

function WallConfigurator({ base, selected, options }: { base: string; selected: Selection; options: WallOptions }) {
  const [loaded, setLoaded] = useState<{ registry: MetricRegistry; status: Health } | null>(null);
  const [error, setError] = useState<ReadFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<WallMode>(selected.snapshot ? "frozen" : "cycle");
  const [boards, setBoards] = useState<string[]>(options.boards ?? []);
  const [interval, setIntervalSeconds] = useState(options.interval);
  const [format, setFormat] = useState<WallFormat>(options.format);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void Promise.all([
      request(base, "metrics", new URLSearchParams(), controller.signal).then(catalog),
      request(base, "health", parameters(selected), controller.signal).then((value) => health(value, selected)),
    ])
      .then(([registry, status]) => {
        if (controller.signal.aborted) return;
        if (registry.policy_version !== status.metricDefinitionVersion)
          throw new ReadFailure(409, "metric_definition_unavailable");
        wallBoards(registry, options.boards);
        setLoaded({ registry, status });
        if (!options.boards)
          setBoards(
            getLeadMetrics("wall", registry)
              .slice(0, 3)
              .map((metric) => metric.id),
          );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          controller.abort();
          setLoaded(null);
          setError(failure instanceof ReadFailure ? failure : new ReadFailure(503, "public_read_unavailable"));
        }
      });
    return () => controller.abort();
  }, [base, selected, options.boards, retry]);
  const chosen = mode === "cycle" ? boards : boards.slice(0, 1);
  const href =
    loaded && chosen.length
      ? wallHref(selected, { mode, boards: chosen, interval, format }, selected.snapshot ?? loaded.status.snapshotId)
      : null;
  return (
    <div className="remote-app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <a className="wordmark" href={uiHref("/", selected)}>
            PickYour.AI Credits
          </a>
        </div>
      </header>
      <main id="main" className="page">
        <h1>Public live wall</h1>
        <p>
          Build a URL for a screen or stream. Opening the wall stays in this browser; fullscreen requires your button
          press. Avatars are off.
        </p>
        <Scope selected={selected} />
        <p>
          <a href={uiHref(`/leaderboards/${selected.metric}`, selected)}>
            Change the exact source scope on a public board
          </a>
        </p>
        {!loaded && !error && <p role="status">Loading public wall choices…</p>}
        {error && (
          <>
            <Failure error={error} />
            <button type="button" className="button" onClick={() => setRetry((value) => value + 1)}>
              Retry public read
            </button>
          </>
        )}
        {loaded && (
          <>
            <section className="notice notice-info" aria-label="Snapshot provenance">
              Snapshot {loaded.status.snapshotId} · generated{" "}
              <time dateTime={loaded.status.generatedAt}>{loaded.status.generatedAt}</time> ·{" "}
              {loaded.status.status === "recently_reconciled" ? "Recently reconciled" : "Stale or degraded"}
              <p>
                Wall choices come from registry {loaded.registry.policy_version}. A choice does not establish available
                data or source approval for this scope.
              </p>
            </section>
            <form className="wall-config api-wall-config" onSubmit={(event) => event.preventDefault()}>
              <label>
                Mode
                <select value={mode} onChange={(event) => setMode(event.target.value as WallMode)}>
                  <option value="frozen">Frozen snapshot — no automatic advance</option>
                  <option value="single">One board — automatic page boundaries</option>
                  <option value="cycle">Cycle boards and the unranked contributor roll</option>
                </select>
              </label>
              <fieldset>
                <legend>Contribution boards</legend>
                {getLeadMetrics("wall", loaded.registry).map((metric) => (
                  <label key={metric.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={boards.includes(metric.id)}
                      onChange={(event) =>
                        setBoards((current) =>
                          event.target.checked ? [...current, metric.id] : current.filter((id) => id !== metric.id),
                        )
                      }
                    />
                    {metric.name}
                  </label>
                ))}
              </fieldset>
              <p>
                {mode === "cycle"
                  ? "Each board visits all its pages, followed by every unranked contributor page, before a newer snapshot is applied."
                  : "Uses the first selected board. Remaining rows continue on later pages with their original ranks."}{" "}
                Frozen snapshots still enforce current publication and privacy controls.
              </p>
              <label>
                Seconds per page
                <select value={interval} onChange={(event) => setIntervalSeconds(Number(event.target.value))}>
                  {[...new Set([20, 30, 60, 120, 300, interval])]
                    .sort((a, b) => a - b)
                    .map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds} seconds
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Display format
                <select value={format} onChange={(event) => setFormat(event.target.value as WallFormat)}>
                  <option value="landscape">16:9 — 1080p / 4K</option>
                  <option value="portrait">Portrait — 9:16</option>
                  <option value="overlay">Compact stream overlay</option>
                </select>
              </label>
              {href ? (
                <>
                  <p className="wall-url">
                    <a href={href}>{href}</a>
                  </p>
                  <div className="button-row">
                    <a className="button" href={href}>
                      Open the wall
                    </a>
                    <button
                      className="button button-ghost"
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(new URL(href, location.href).href);
                          setCopied("Wall URL copied.");
                        } catch {
                          setCopied("Copy is unavailable; use the URL above.");
                        }
                      }}
                    >
                      Copy URL
                    </button>
                  </div>
                </>
              ) : (
                <p className="notice notice-warn">Choose at least one board.</p>
              )}
              <p role="status">{copied}</p>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

function WallDisplay({
  base,
  selected,
  options,
  mode,
}: {
  base: string;
  selected: Selection;
  options: WallOptions;
  mode: WallMode;
}) {
  const [position, setPosition] = useState(firstWallPage);
  const [frame, setFrame] = useState<WallFrame | null>(null);
  const [error, setError] = useState<ReadFailure | null>(null);
  const [nonce, setNonce] = useState(0);
  const [reading, setReading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [pointerInside, setPointerInside] = useState(false),
    [focusInside, setFocusInside] = useState(false);
  const [interval, setIntervalSeconds] = useState(options.interval);
  const [announcement, setAnnouncement] = useState("");
  const [fullscreenMessage, setFullscreenMessage] = useState("");
  const pin = useRef<string | null>(selected.snapshot);
  const lastVerified = useRef<SnapshotReference | null>(null);
  const active = useRef<AbortController | null>(null);
  const recovery = useRef<"page" | "cycle" | null>(null);
  const automaticDue = useRef(false);
  const region = useRef<HTMLElement>(null);
  const refresh = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    active.current?.abort();
    if (recovery.current) {
      const restartCycle = recovery.current === "cycle";
      recovery.current = null;
      if (restartCycle) pin.current = null;
      setPosition((current) => ({ ...firstWallPage(), stage: restartCycle ? 0 : current.stage }));
    }
    setNonce((value) => value + 1);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const visibility = () => {
      const showing = document.visibilityState === "visible";
      setVisible(showing);
      if (!showing) {
        automaticDue.current = false;
        active.current?.abort();
        setFrame(null);
      } else refresh();
    };
    const timer = setInterval(refresh, 20_000);
    document.addEventListener("visibilitychange", visibility);
    addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    active.current = controller;
    setReading(true);
    void readWallFrame(base, selected, options, position, pin.current, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        // The complete frame and current controls have passed validation.
        // Keep only this historical date/reference if a later read fails.
        lastVerified.current = {
          snapshotId: value.content.value.snapshotId,
          generatedAt: value.content.value.generatedAt,
        };
        pin.current = value.content.value.snapshotId;
        recovery.current = null;
        setFrame(value);
        setError(null);
        setReading(false);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          controller.abort();
          automaticDue.current = false;
          const problem = failure instanceof ReadFailure ? failure : new ReadFailure(503, "public_read_unavailable");
          // Expiring cursors do not revoke a frozen snapshot. Wait for the next
          // bounded recheck, then restart this stage under the same publication.
          if (["cursor_expired_refetch", "cursor_policy_changed_refetch"].includes(problem.code))
            recovery.current = "page";
          else if (mode !== "frozen" && ["snapshot_expired_refetch", "snapshot_revoked_refetch"].includes(problem.code))
            recovery.current = "cycle";
          setFrame(null);
          setReading(false);
          setError(problem);
        }
      });
    return () => controller.abort();
  }, [base, selected, options, mode, position, nonce, visible]);
  useEffect(() => {
    // Removing a focused contributor need not dispatch a bubbling blur event.
    // Keep surviving focus intact, but release a hold whose node is gone.
    if (focusInside && !region.current?.contains(document.activeElement)) setFocusInside(false);
  }, [frame, focusInside]);
  const automatic = mode !== "frozen" && !paused && !reduced && visible && !pointerInside && !focusInside;
  const advance = () => {
    if (!frame || reading || document.visibilityState !== "visible") return;
    automaticDue.current = false;
    const next = nextWallPage(frame, mode);
    pin.current = next.pin;
    active.current?.abort();
    setPosition(next.position);
  };
  const advanceAutomatically = () => {
    if (
      !automatic ||
      !frame ||
      document.visibilityState !== "visible" ||
      region.current?.contains(document.activeElement)
    ) {
      automaticDue.current = false;
      return;
    }
    // Preserve one due page boundary while a coincident privacy read finishes.
    // Only its freshly validated frame may supply the next cursor/page.
    automaticDue.current = true;
    if (!reading) advance();
  };
  const advanceRef = useRef(advanceAutomatically);
  advanceRef.current = advanceAutomatically;
  const displayedPosition = frame?.position;
  // A 20-second privacy recheck must not perpetually reset a slower rotation timer.
  // Only a successfully displayed page starts its full interval. The position
  // object stays stable across privacy reads, but changes for a new page.
  useEffect(() => {
    automaticDue.current = false;
    if (!displayedPosition || displayedPosition !== position) return;
    if (paused || reduced || !visible || pointerInside || focusInside || mode === "frozen") return;
    const timer = setInterval(() => {
      advanceRef.current();
    }, interval * 1000);
    return () => clearInterval(timer);
  }, [paused, reduced, visible, pointerInside, focusInside, mode, interval, position, displayedPosition]);
  useEffect(() => {
    if (!automatic) automaticDue.current = false;
    else if (automaticDue.current && !reading) advanceRef.current();
  }, [automatic, reading, frame]);
  const reset = () => {
    automaticDue.current = false;
    active.current?.abort();
    recovery.current = null;
    pin.current = selected.snapshot;
    setFrame(null);
    setPosition(firstWallPage());
  };
  const content = frame?.content;
  const meta = content?.value;
  const displaySummary = frame
    ? `${frame.content.kind === "board" ? frame.content.value.metric.name : "Contributor roll"} · page ${frame.position.page} · snapshot ${frame.content.value.snapshotId}. Source health: ${frame.health.status === "stale_or_degraded" ? "stale or degraded" : "recently reconciled"}.`
    : "";
  useEffect(() => {
    if (!displaySummary || !visible) {
      setAnnouncement("");
      return;
    }
    // Coalesce displayed page and source-health changes. An unchanged same-page
    // privacy check does not repeat the announcement.
    const timer = setTimeout(() => setAnnouncement(displaySummary), 1_000);
    return () => clearTimeout(timer);
  }, [displaySummary, visible]);
  const controlLabel =
    mode === "frozen"
      ? "Frozen snapshot — automatic advance off"
      : paused
        ? "Paused"
        : reduced
          ? "Paused for reduced motion"
          : !visible
            ? "Paused in background"
            : pointerInside || focusInside
              ? "Paused while reading"
              : "Automatic page boundaries";
  return (
    <div className={`api-wall api-wall-${options.format}`}>
      <a className="skip-link" href="#main">
        Skip to wall content
      </a>
      <div className="api-wall-frame">
        <header className="api-wall-header">
          <a className="wall-brand" href={uiHref("/", selected)}>
            PickYour.AI Credits
          </a>
          <p
            className={`api-wall-health ${error || frame?.health.status === "stale_or_degraded" ? "notice-error" : "notice-info"}`}
          >
            {error
              ? "PUBLIC READ LOST — DISPLAY CLEARED"
              : !frame
                ? "Checking source health"
                : frame.health.status === "stale_or_degraded"
                  ? "STALE OR DEGRADED DATA"
                  : "Recently reconciled"}
          </p>
          <Scope selected={selected} />
          {meta && (
            <section className="api-wall-provenance" aria-label="Snapshot provenance">
              <span>
                Snapshot {meta.snapshotId} · generated <time dateTime={meta.generatedAt}>{meta.generatedAt}</time>
              </span>
              <span>Earliest successful source sync: {oldestSync(frame!.health)}</span>
            </section>
          )}
        </header>
        <main
          id="main"
          ref={region}
          className="api-wall-content"
          onPointerEnter={() => setPointerInside(true)}
          onPointerLeave={() => setPointerInside(false)}
          onFocus={() => setFocusInside(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
          }}
        >
          {!frame && !error && (
            <>
              <h1>Public live wall</h1>
              <p role="status">{visible ? "Loading current public data…" : "Display paused in background."}</p>
            </>
          )}
          {error && (
            <>
              <h1>Public live wall</h1>
              <Failure error={error} previousSnapshot={lastVerified.current} />
            </>
          )}
          {content?.kind === "board" && (
            <>
              <h1>{content.value.metric.name}</h1>
              <p className="api-wall-summary">
                {content.value.metric.definition.unit} ·{" "}
                {content.value.ranking?.rank ? "Equal values share a rank" : "Descriptive values; no rank is assigned"}{" "}
                · pending work is not ranked
              </p>
              <p className="api-wall-page">
                Page {frame!.position.page} · {content.value.totalRows} contributor rows
                {frame!.position.previousRank !== null && content.value.rows[0]?.rank === frame!.position.previousRank
                  ? ` · Rank ${frame!.position.previousRank} continues from the previous page`
                  : ""}
              </p>
              {content.value.rows.length ? (
                <table className="api-wall-table">
                  <caption className="visually-hidden">
                    {content.value.metric.name}, page {frame!.position.page}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Contributor</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.value.rows.map((row) => {
                      const diagnostic = content.value.diagnostics.find((item) => item.actorId === row.actorId);
                      const label = actorName(row.actor, row.actorId);
                      return (
                        <tr key={row.actorId}>
                          <td>{row.rank ?? "Unranked"}</td>
                          <td>
                            <a
                              href={uiHref(`/contributors/${encodeURIComponent(row.actorId)}`, {
                                ...selected,
                                snapshot: content.value.snapshotId,
                              })}
                              title={label}
                            >
                              {label}
                            </a>
                            <span className="api-wall-detail">
                              {row.result.state} · coverage {row.result.coverage.state}
                            </span>
                          </td>
                          <td>
                            <strong>{number(row.result.value)}</strong>
                            <span className="api-wall-detail">
                              {row.pending?.valueClass ?? "Value class unknown"} · {row.pending?.count ?? "Unknown"}{" "}
                              pending
                            </span>
                            {content.value.metric.definition.aggregation === "ratio" && (
                              <span className="api-wall-detail">
                                {number(diagnostic?.numerator)} / {number(diagnostic?.denominator)} · samples{" "}
                                {number(diagnostic?.sampleCount)}
                              </span>
                            )}
                            {content.value.metric.definition.aggregation === "median_and_p75_of_elapsed_hours" && (
                              <span className="api-wall-detail">
                                p75 {number(diagnostic?.p75)} · samples {number(diagnostic?.sampleCount)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p>No measured contributor rows for this board and scope. Unavailable measurements are not zero.</p>
              )}
            </>
          )}
          {content?.kind === "contributors" && (
            <>
              <h1>Contributors in this scope</h1>
              <p className="api-wall-summary">
                Unranked · ordered by GitHub login; unavailable logins first. Includes attributable work that does not
                qualify for a ranking.
              </p>
              <p className="api-wall-page">
                Page {frame!.position.page} · {content.value.totalContributors} contributors
              </p>
              <ul className="api-wall-roll">
                {content.value.contributors.map((entry) => {
                  const label = actorName(entry.actor, entry.actorId);
                  return (
                    <li key={entry.actorId}>
                      <a
                        href={uiHref(`/contributors/${encodeURIComponent(entry.actorId)}`, {
                          ...selected,
                          snapshot: content.value.snapshotId,
                        })}
                        title={label}
                      >
                        {label}
                      </a>
                      <span className="api-wall-detail">
                        {entry.actor.login ? `@${entry.actor.login}` : `Login unavailable · ${entry.actorId}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {!content.value.contributors.length && <p>No attributable public contributors in this scope.</p>}
            </>
          )}
        </main>
        <footer className="api-wall-footer">
          <p className="api-wall-state">
            {controlLabel}
            {automatic ? ` · ${interval} seconds per page` : ""}
            {reading && frame ? " · Rechecking controls…" : ""}
          </p>
          {frame && mode !== "frozen" && frame.health.head.snapshotId !== frame.content.value.snapshotId && (
            <p>Update held: {frame.health.head.snapshotId}. Applies after the full page cycle.</p>
          )}
          <div className="wall-controls">
            {mode !== "frozen" && (
              <button
                type="button"
                className="button"
                aria-pressed={paused}
                onClick={() => setPaused((value) => !value)}
              >
                {paused ? "Resume wall" : "Pause wall"}
              </button>
            )}
            <button type="button" className="button button-ghost" disabled={!frame || reading} onClick={advance}>
              Next page
            </button>
            <button
              type="button"
              className="button button-ghost"
              aria-label="Recheck current publication controls"
              onClick={refresh}
            >
              Recheck controls
            </button>
            {mode !== "frozen" && (
              <label>
                Page speed
                <select value={interval} onChange={(event) => setIntervalSeconds(Number(event.target.value))}>
                  {[...new Set([20, 30, 60, 120, 300, interval])]
                    .sort((a, b) => a - b)
                    .map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds} seconds
                      </option>
                    ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="button button-ghost"
              onClick={async () => {
                try {
                  if (document.fullscreenElement) await document.exitFullscreen();
                  else await document.documentElement.requestFullscreen();
                  setFullscreenMessage("");
                } catch {
                  setFullscreenMessage(
                    "Fullscreen is unavailable. This wall still works in the current browser window.",
                  );
                }
              }}
            >
              Toggle fullscreen
            </button>
            <a href={uiHref("/live", { ...selected, snapshot: null })}>Configure wall</a>
            {error && (
              <button className="button" type="button" onClick={reset}>
                {mode === "frozen" ? "Retry frozen snapshot" : "Restart from current publication"}
              </button>
            )}
          </div>
          <p className="api-wall-policy">
            Avatars off · current publication controls rechecked every 20 seconds while visible · frozen data stays
            pinned
          </p>
          {fullscreenMessage && <p role="status">{fullscreenMessage}</p>}
        </footer>
        <div className="visually-hidden api-wall-announcement" role="status" aria-live="polite">
          {announcement}
        </div>
      </div>
    </div>
  );
}
