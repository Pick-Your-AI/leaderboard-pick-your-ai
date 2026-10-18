import React, { useEffect, useId, useState } from "react";
import { useScope } from "../lib/hooks.ts";
import { TimeZoneOptions, WindowBounds } from "./DisplayTimeZone.tsx";
import type { PeriodPreset, Scope, ScopeIssue, TimeWindow } from "../lib/scope.ts";
import { getMetricUi } from "../data/registry.ts";
import { projects, repositories, snapshots } from "../data/source.ts";

const periodLabels: Record<PeriodPreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
  month: "This calendar month",
  quarter: "This calendar quarter",
  year: "This calendar year",
  custom: "Custom UTC dates",
};

export function ScopeIssues({ issues }: { issues: ScopeIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="notice notice-warn" role="alert">
      <p className="notice-title">
        <span aria-hidden="true">◑</span> Some link parameters could not be used
      </p>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.param}-${issue.value}`}>
            <span className="mono">
              {issue.param}={issue.value}
            </span>
            : {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Scope controls shared by every scoped route. Each change writes the URL, so
 * the scope survives navigation and can be copied.
 */
export function ScopeBar({
  timeWindow,
  showSnapshot = true,
  metricId,
}: {
  timeWindow: TimeWindow | null;
  showSnapshot?: boolean;
  metricId?: string;
}) {
  const { scope, issues, params, setScope } = useScope();
  const id = useId();
  const [customFrom, setCustomFrom] = useState(scope.from ?? "");
  const [customTo, setCustomTo] = useState(scope.to ?? "");
  const [pendingCustom, setPendingCustom] = useState(scope.period === "custom");

  // A restored URL replaces the applied interval, including its editable fields.
  useEffect(() => {
    setCustomFrom(scope.from ?? "");
    setCustomTo(scope.to ?? "");
    setPendingCustom(scope.period === "custom");
  }, [scope.period, scope.from, scope.to]);
  const ui = metricId ? getMetricUi(metricId) : undefined;
  const requestedView = `${params.state ?? ui?.default_combination?.state ?? ""}:${params.date_basis ?? ui?.default_combination?.date_basis ?? ""}`;
  const knownView = ui?.supported_combinations.some((pair) => `${pair.state}:${pair.date_basis}` === requestedView);
  const update = (patch: Partial<Scope>) => setScope({ ...scope, ...patch });

  return (
    <section className="scope-bar" aria-label="Scope">
      <ScopeIssues issues={issues} />
      <div className="scope-controls">
        {metricId && (
          <label>
            <span>Evidence and date basis</span>
            <select
              value={requestedView}
              disabled={!ui?.supported_combinations.length}
              onChange={(event) => {
                const [state, date_basis] = event.target.value.split(":");
                setScope(scope, { ...params, state: state!, date_basis: date_basis! });
              }}
            >
              {!knownView && (
                <option value={requestedView} disabled>
                  {params.state !== undefined || params.date_basis !== undefined
                    ? `Unsupported: ${requestedView}`
                    : "No selectable view"}
                </option>
              )}
              {ui?.supported_combinations.map((pair) => (
                <option key={`${pair.state}:${pair.date_basis}`} value={`${pair.state}:${pair.date_basis}`}>
                  {pair.state} · {pair.date_basis}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Period</span>
          <select
            value={pendingCustom ? "custom" : scope.period}
            onChange={(event) => {
              const value = event.target.value as PeriodPreset;
              if (value === "custom") setPendingCustom(true);
              else {
                setPendingCustom(false);
                update({ period: value, from: null, to: null });
              }
            }}
          >
            {(Object.keys(periodLabels) as PeriodPreset[]).map((period) => (
              <option key={period} value={period}>
                {periodLabels[period]}
              </option>
            ))}
          </select>
        </label>
        {pendingCustom && (
          <form
            className="custom-range"
            onSubmit={(event) => {
              event.preventDefault();
              setScope({ ...scope, period: "custom", from: customFrom, to: customTo });
            }}
          >
            <label>
              <span>From (UTC, inclusive)</span>
              <input type="date" value={customFrom} required onChange={(event) => setCustomFrom(event.target.value)} />
            </label>
            <label>
              <span>To (UTC, exclusive)</span>
              <input type="date" value={customTo} required onChange={(event) => setCustomTo(event.target.value)} />
            </label>
            <button type="submit" className="button">
              Apply dates
            </button>
          </form>
        )}
        <label>
          <span>Repository</span>
          <select
            value={scope.repos.length === 1 ? scope.repos[0] : scope.repos.length > 1 ? "__multiple" : ""}
            onChange={(event) => update({ repos: event.target.value ? [event.target.value] : [] })}
          >
            <option value="">All repositories</option>
            {scope.repos.length > 1 && (
              <option value="__multiple" disabled>{`${scope.repos.length} selected from link`}</option>
            )}
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Program</span>
          <select
            value={scope.projects.length === 1 ? scope.projects[0] : scope.projects.length > 1 ? "__multiple" : ""}
            onChange={(event) => update({ projects: event.target.value ? [event.target.value] : [] })}
          >
            <option value="">All programs</option>
            {scope.projects.length > 1 && (
              <option value="__multiple" disabled>{`${scope.projects.length} selected from link`}</option>
            )}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="segmented">
          <legend>Actors</legend>
          {(
            [
              ["user", "User accounts"],
              ["automation", "Automation"],
              ["all", "All activity"],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name={`${id}-actor`}
                value={value}
                checked={scope.actor === value}
                onChange={() => update({ actor: value })}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {showSnapshot && (
          <label>
            <span>Snapshot</span>
            <select value={scope.snapshot ?? ""} onChange={(event) => update({ snapshot: event.target.value || null })}>
              <option value="">Latest published</option>
              {snapshots.map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  Pin {snapshot.id} (
                  {snapshot.status === "published" ? snapshot.freshness.toLowerCase() : snapshot.status})
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Display timezone</span>
          <select value={scope.timeZone} onChange={(event) => update({ timeZone: event.target.value })}>
            <TimeZoneOptions selected={scope.timeZone} />
          </select>
        </label>
      </div>
      {timeWindow && (
        <div className="scope-window">
          <p>
            <span className="muted">Window:</span> {timeWindow.label} ·{" "}
            {scope.actor === "user"
              ? "user accounts"
              : scope.actor === "automation"
                ? "automation only"
                : "all activity"}
          </p>
          <WindowBounds
            start={timeWindow.start?.toISOString() ?? null}
            end={timeWindow.end.toISOString()}
            timeZone={scope.timeZone}
          />
        </div>
      )}
      <p className="small">
        Display timezone changes the clock labels. Date inputs, calendar periods and counting boundaries use UTC.
      </p>
    </section>
  );
}

/** Reference pages expose carried scope without implying their content is filtered. */
export function ReferenceScope({
  children = "Scope travels with contribution links. Definitions and policy notes below describe the current registry.",
}: {
  children?: React.ReactNode;
}) {
  return (
    <>
      <ScopeBar timeWindow={null} />
      <p className="muted">{children}</p>
    </>
  );
}
