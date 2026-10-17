import React, { useId, useState } from "react";
import { useScope } from "../lib/hooks.ts";
import { formatDateTime } from "../lib/format.ts";
import type { PeriodPreset, Scope, ScopeIssue, TimeWindow } from "../lib/scope.ts";
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
export function ScopeBar({ timeWindow, showSnapshot = true }: { timeWindow: TimeWindow | null; showSnapshot?: boolean }) {
  const { scope, issues, setScope } = useScope();
  const id = useId();
  const [customFrom, setCustomFrom] = useState(scope.from ?? "");
  const [customTo, setCustomTo] = useState(scope.to ?? "");
  const [pendingCustom, setPendingCustom] = useState(scope.period === "custom");
  const update = (patch: Partial<Scope>) => setScope({ ...scope, ...patch });

  return (
    <section className="scope-bar" aria-label="Scope">
      <ScopeIssues issues={issues} />
      <div className="scope-controls">
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
            {scope.repos.length > 1 && <option value="__multiple" disabled>{`${scope.repos.length} selected from link`}</option>}
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
            value={scope.projects[0] ?? ""}
            onChange={(event) => update({ projects: event.target.value ? [event.target.value] : [] })}
          >
            <option value="">All programs</option>
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
              <input type="radio" name={`${id}-actor`} value={value} checked={scope.actor === value} onChange={() => update({ actor: value })} />
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
                  Pin {snapshot.id} ({snapshot.status === "published" ? snapshot.freshness.toLowerCase() : snapshot.status})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {timeWindow && (
        <p className="scope-window">
          <span className="muted">Window:</span> {timeWindow.label} ·{" "}
          {timeWindow.start ? <time dateTime={timeWindow.start.toISOString()}>{formatDateTime(timeWindow.start.toISOString())}</time> : "start of known history"}{" "}
          to <time dateTime={timeWindow.end.toISOString()}>{formatDateTime(timeWindow.end.toISOString())}</time>, end exclusive ·{" "}
          {scope.actor === "user" ? "user accounts" : scope.actor === "automation" ? "automation only" : "all activity"}
        </p>
      )}
    </section>
  );
}
