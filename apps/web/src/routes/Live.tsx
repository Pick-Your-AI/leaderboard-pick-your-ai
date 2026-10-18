import React, { useEffect, useMemo, useState } from "react";
import { RankCell } from "../components/BoardTable.tsx";
import { PageHeader, SyntheticDataBanner } from "../components/Layout.tsx";
import { ErrorState, FreshnessIndicator, SnapshotNotices } from "../components/status.tsx";
import { getMetric } from "../data/registry.ts";
import { listContributors, SourceError } from "../data/source.ts";
import { formatNumber } from "../lib/format.ts";
import { useLatestSnapshotId, useScope } from "../lib/hooks.ts";
import { prototypeNavigation } from "../lib/prototype-url.ts";
import { cutWithTies } from "../lib/ranking.ts";
import { Link, ScopedLink } from "../lib/router.tsx";
import { serializeScope, type Scope } from "../lib/scope.ts";

import { buildSelectedBoard, resolveWallBoards, wallMetricIds } from "../data/metric-selection.ts";

type WallMode = "frozen" | "single" | "cycle";
type WallFormat = "landscape" | "portrait" | "standard";

const MIN_INTERVAL = 20;
const WALL_ROWS = 8;

function readWallParams(params: Record<string, string>) {
  const mode: WallMode | null =
    params.mode === "frozen" || params.mode === "single" || params.mode === "cycle" ? params.mode : null;
  const boards = resolveWallBoards(params.boards);
  const interval = Math.max(MIN_INTERVAL, Number.parseInt(params.interval ?? "", 10) || 30);
  const format: WallFormat = params.format === "portrait" || params.format === "standard" ? params.format : "landscape";
  return { mode, boards, interval, format };
}

export function LivePage() {
  const { params } = useScope();
  try {
    const wall = readWallParams(params);
    return wall.mode ? <WallPage {...wall} mode={wall.mode} /> : <WallConfigurator />;
  } catch (error) {
    return <ErrorState error={error instanceof Error ? error : new Error("Invalid wall selection")} />;
  }
}

function WallConfigurator() {
  const { scope } = useScope();
  const latest = useLatestSnapshotId();
  const [mode, setMode] = useState<WallMode>("cycle");
  const [boards, setBoards] = useState<string[]>(wallMetricIds().slice(0, 3));
  const [interval, setIntervalSeconds] = useState(30);
  const [format, setFormat] = useState<WallFormat>("landscape");
  const [copied, setCopied] = useState("");

  const wallScope: Scope = mode === "frozen" ? { ...scope, snapshot: scope.snapshot ?? latest } : scope;
  const selected = mode === "single" ? boards.slice(0, 1) : boards;
  const href = prototypeNavigation(
    `/live${serializeScope(wallScope, { mode, boards: selected.join(","), interval: String(interval), format })}`,
  ).href;

  return (
    <>
      <PageHeader eyebrow="Public display" title="Live wall">
        <p>
          Configure a public display URL for a screen or stream. Nothing is launched automatically. Avatars are off and
          only public data is shown.
        </p>
      </PageHeader>
      <form className="wall-config" onSubmit={(event) => event.preventDefault()}>
        <fieldset>
          <legend>Mode</legend>
          {(
            [
              ["frozen", "Frozen snapshot", "Pins the current snapshot. It never changes and says so."],
              [
                "single",
                "Single board, safe auto-refresh",
                "One board; new snapshots apply only between full renders.",
              ],
              ["cycle", "Cycling live boards", "Rotates boards and an unranked credits roll."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="radio-card">
              <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
              <span>
                <strong>{label}</strong>
                <span className="muted"> {hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Boards</legend>
          {wallMetricIds().map((metricId) => (
            <label key={metricId} className="checkbox">
              <input
                type="checkbox"
                checked={boards.includes(metricId)}
                onChange={(event) =>
                  setBoards((current) =>
                    event.target.checked ? [...current, metricId] : current.filter((id) => id !== metricId),
                  )
                }
              />
              <span>{getMetric(metricId)?.name}</span>
            </label>
          ))}
        </fieldset>
        <label>
          <span>Seconds per page (minimum {MIN_INTERVAL})</span>
          <input
            type="number"
            min={MIN_INTERVAL}
            max={300}
            value={interval}
            onChange={(event) => setIntervalSeconds(Math.max(MIN_INTERVAL, Number(event.target.value) || 30))}
          />
        </label>
        <label>
          <span>Format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as WallFormat)}>
            <option value="landscape">16:9 (1920×1080 or 3840×2160)</option>
            <option value="portrait">9:16 portrait</option>
            <option value="standard">4:3</option>
          </select>
        </label>
        <p className="wall-url">
          <span className="mono">{href}</span>
        </p>
        <div className="button-row">
          <Link to={href} className="button">
            Open the wall
          </Link>
          <button
            type="button"
            className="button button-ghost"
            disabled={boards.length === 0}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(new URL(href, window.location.href).toString());
                setCopied("Wall URL copied.");
              } catch {
                setCopied("Copy is unavailable here; select the URL above instead.");
              }
            }}
          >
            Copy URL
          </button>
          <span role="status">{copied}</span>
        </div>
        {boards.length === 0 && <p className="notice notice-warn">Choose at least one board.</p>}
      </form>
    </>
  );
}

function WallPage({
  mode,
  boards,
  interval,
  format,
}: {
  mode: WallMode;
  boards: string[];
  interval: number;
  format: WallFormat;
}) {
  const { scope, params } = useScope();
  const latest = useLatestSnapshotId();
  const [appliedLatest, setAppliedLatest] = useState(latest);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const pages = mode === "cycle" ? [...boards, "__credits"] : boards.slice(0, 1);
  const page = pages[index % pages.length]!;
  const wallScope: Scope = mode === "frozen" ? scope : { ...scope, snapshot: null };

  // Advance pages and apply new snapshots only at page boundaries.
  useEffect(() => {
    if (paused || mode === "frozen") return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "hidden") return;
      if (latest !== appliedLatest) {
        setAppliedLatest(latest);
        setAnnouncement(`Wall updated to snapshot ${latest}.`);
      }
      if (mode === "cycle") setIndex((current) => (current + 1) % pages.length);
    }, interval * 1000);
    return () => window.clearTimeout(timer);
  }, [paused, mode, interval, index, latest, appliedLatest, pages.length]);

  const content = useMemo(() => {
    try {
      if (page === "__credits") return { kind: "credits" as const, data: listContributors(wallScope, appliedLatest) };
      return { kind: "board" as const, data: buildSelectedBoard(page, wallScope, appliedLatest, params)! };
    } catch (error) {
      return { kind: "error" as const, error: error instanceof SourceError ? error : new Error(String(error)) };
    }
  }, [page, serializeScope(wallScope), appliedLatest, params.state, params.date_basis]);

  const snapshotView = content.kind === "error" ? null : content.data.snapshot;

  return (
    <div className={`wall wall-${format}`}>
      <SyntheticDataBanner />
      <div className="wall-frame">
        <header className="wall-header">
          <p className="wall-brand">PickYour.AI Credits</p>
          {snapshotView && <FreshnessIndicator view={snapshotView} compact />}
          <p className="wall-scope">
            {content.kind !== "error" && content.data.window.label} ·{" "}
            {wallScope.actor === "user" ? "User accounts" : wallScope.actor === "all" ? "All activity" : "Automation"}
            {mode === "frozen" && " · Frozen snapshot: this display never changes"}
          </p>
        </header>
        {snapshotView && <SnapshotNotices view={snapshotView} />}
        <div className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </div>
        <main className="wall-body">
          {content.kind === "error" && <ErrorState error={content.error} />}
          {content.kind === "credits" && (
            <>
              <h1>Contributors in this period</h1>
              <p className="wall-sub">Alphabetical and unranked. Everyone with attributable public work.</p>
              <ul className="credits-roll">
                {content.data.entries.map((entry) => (
                  <li key={entry.person.actorId}>
                    {entry.person.publicState === "deleted" ? "Deleted account" : entry.person.displayName}
                  </li>
                ))}
              </ul>
            </>
          )}
          {content.kind === "board" &&
            (() => {
              const board = content.data;
              const { shown, remaining } = cutWithTies(board.rows, WALL_ROWS);
              return (
                <>
                  <h1>{board.metric.name}</h1>
                  <p className="wall-sub">
                    {board.metric.definition.unit} · ties share a rank · pending work is not ranked
                  </p>
                  {shown.length === 0 ? (
                    <p className="wall-sub">No ranked activity in this period.</p>
                  ) : (
                    <table className="wall-table">
                      <caption className="visually-hidden">{board.metric.name}</caption>
                      <thead>
                        <tr>
                          <th scope="col">Rank</th>
                          <th scope="col">Contributor</th>
                          <th scope="col" className="numeric">
                            Value
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((row) => (
                          <tr key={row.person.actorId}>
                            <td className="rank">
                              <RankCell row={row} />
                            </td>
                            <th scope="row">
                              {row.person.publicState === "deleted" ? "Deleted account" : row.person.displayName}
                            </th>
                            <td className="numeric">{formatNumber(row.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {remaining > 0 && <p className="wall-sub">{remaining} more on the full board.</p>}
                </>
              );
            })()}
        </main>
        <footer className="wall-controls" aria-label="Wall controls">
          {mode === "cycle" && (
            <>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setIndex((current) => (current - 1 + pages.length) % pages.length)}
              >
                Previous
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={paused}
                onClick={() => setPaused((current) => !current)}
              >
                {paused ? "Play" : "Pause"}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setIndex((current) => (current + 1) % pages.length)}
              >
                Next
              </button>
              <span className="muted">
                Page {(index % pages.length) + 1} of {pages.length} · {interval}s each
              </span>
            </>
          )}
          {mode === "single" && (
            <button
              type="button"
              className="button"
              aria-pressed={paused}
              onClick={() => setPaused((current) => !current)}
            >
              {paused ? "Resume updates" : "Pause updates"}
            </button>
          )}
          <ScopedLink to="/live" className="button button-ghost">
            Exit wall
          </ScopedLink>
        </footer>
      </div>
    </div>
  );
}
