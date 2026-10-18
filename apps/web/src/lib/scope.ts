/**
 * Canonical URL scope for every public route (LB-13.02).
 *
 * The URL is the only store for scope: back/forward and a copied link restore
 * the same supported scope and snapshot. Unknown or incompatible parameters are
 * never silently substituted; they are reported as visible issues and the
 * documented default is used in their place.
 */

import { defaultDisplayTimeZone, isDisplayTimeZone } from "./display-time-zone.ts";

export const periodPresets = ["7d", "30d", "90d", "all", "month", "quarter", "year", "custom"] as const;
export type PeriodPreset = (typeof periodPresets)[number];

export const actorClasses = ["user", "automation", "all"] as const;
export type ActorClass = (typeof actorClasses)[number];

export const densities = ["comfortable", "compact"] as const;
export type Density = (typeof densities)[number];

export interface Scope {
  period: PeriodPreset;
  /** Inclusive UTC start (YYYY-MM-DD) for custom windows. */
  from: string | null;
  /** Exclusive UTC end (YYYY-MM-DD) for custom windows. */
  to: string | null;
  repos: string[];
  projects: string[];
  actor: ActorClass;
  /** Immutable snapshot pin. Null follows the latest published snapshot. */
  snapshot: string | null;
  density: Density;
  /** Presentation only: counting and custom dates always use UTC. */
  timeZone: string;
}

export interface ScopeIssue {
  param: string;
  value: string;
  message: string;
}

export interface ScopeContext {
  repoIds?: readonly string[];
  projectIds?: readonly string[];
  snapshotIds?: readonly string[];
}

export const defaultScope: Scope = {
  period: "30d",
  from: null,
  to: null,
  repos: [],
  projects: [],
  actor: "user",
  snapshot: null,
  density: "comfortable",
  timeZone: defaultDisplayTimeZone,
};

/** Parameters owned by the scope; route-specific parameters pass through. */
export const scopeParams = ["period", "from", "to", "repo", "project", "actor", "snapshot", "density", "tz"] as const;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function splitList(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseScope(search: string, context: ScopeContext = {}): { scope: Scope; issues: ScopeIssue[] } {
  const params = new URLSearchParams(search);
  const issues: ScopeIssue[] = [];
  const scope: Scope = { ...defaultScope, repos: [], projects: [] };

  const period = params.get("period");
  if (period !== null) {
    if (oneOf(periodPresets, period)) scope.period = period;
    else
      issues.push({
        param: "period",
        value: period,
        message: `Unknown period "${period}". Showing the last 30 days instead.`,
      });
  }

  const from = params.get("from");
  const to = params.get("to");
  if (from !== null || to !== null) {
    const fromOk = from !== null && isValidDate(from);
    const toOk = to !== null && isValidDate(to);
    if (!fromOk || !toOk) {
      issues.push({
        param: "from/to",
        value: `${from ?? ""}..${to ?? ""}`,
        message: "A custom window needs both from and to as YYYY-MM-DD UTC dates. Showing the last 30 days instead.",
      });
      if (scope.period === "custom") scope.period = "30d";
    } else if (from! >= to!) {
      issues.push({
        param: "from/to",
        value: `${from}..${to}`,
        message: "A custom window is half-open and needs from earlier than to. Showing the last 30 days instead.",
      });
      if (scope.period === "custom") scope.period = "30d";
    } else {
      scope.period = "custom";
      scope.from = from;
      scope.to = to;
    }
  } else if (scope.period === "custom") {
    issues.push({
      param: "period",
      value: "custom",
      message: "A custom period needs from and to dates. Showing the last 30 days instead.",
    });
    scope.period = "30d";
  }

  const checkIds = (name: "repo" | "project", known: readonly string[] | undefined, label: string): string[] => {
    const values = [...new Set(splitList(params, name))];
    if (!known) return values.sort();
    const accepted: string[] = [];
    for (const value of values) {
      if (known.includes(value)) accepted.push(value);
      else
        issues.push({
          param: name,
          value,
          message: `No ${label} has the ID "${value}" in this snapshot, so it was left out of the scope.`,
        });
    }
    return accepted.sort();
  };
  scope.repos = checkIds("repo", context.repoIds, "repository");
  scope.projects = checkIds("project", context.projectIds, "program or Project");

  const actor = params.get("actor");
  if (actor !== null) {
    if (oneOf(actorClasses, actor)) scope.actor = actor;
    else
      issues.push({
        param: "actor",
        value: actor,
        message: `Unknown actor class "${actor}". Use user, automation or all. Showing user-account activity.`,
      });
  }

  const snapshot = params.get("snapshot");
  if (snapshot !== null) {
    if (!context.snapshotIds || context.snapshotIds.includes(snapshot)) scope.snapshot = snapshot;
    else
      issues.push({
        param: "snapshot",
        value: snapshot,
        message: `Snapshot "${snapshot}" is not published. Showing the latest published snapshot.`,
      });
  }

  const density = params.get("density");
  if (density !== null) {
    if (oneOf(densities, density)) scope.density = density;
    else
      issues.push({
        param: "density",
        value: density,
        message: `Unknown density "${density}". Using comfortable rows.`,
      });
  }

  const timeZones = params.getAll("tz");
  if (timeZones.length) {
    if (timeZones.length === 1 && isDisplayTimeZone(timeZones[0])) scope.timeZone = timeZones[0];
    else
      issues.push({
        param: "tz",
        value: timeZones.join(","),
        message: "Choose one supported IANA display timezone. Displaying UTC; the selected UTC window is unchanged.",
      });
  }

  return { scope, issues };
}

/**
 * Serialize scope with a stable parameter order and without defaults so the
 * same scope always produces the same shareable URL. Route parameters in
 * `extra` are appended after scope parameters in key order.
 */
export function serializeScope(scope: Scope, extra: Record<string, string | null | undefined> = {}): string {
  const params = new URLSearchParams();
  if (scope.period === "custom" && scope.from && scope.to) {
    params.set("from", scope.from);
    params.set("to", scope.to);
  } else if (scope.period !== defaultScope.period && scope.period !== "custom") {
    params.set("period", scope.period);
  }
  if (scope.repos.length) params.set("repo", [...scope.repos].sort().join(","));
  if (scope.projects.length) params.set("project", [...scope.projects].sort().join(","));
  if (scope.actor !== defaultScope.actor) params.set("actor", scope.actor);
  if (scope.snapshot) params.set("snapshot", scope.snapshot);
  if (scope.density !== defaultScope.density) params.set("density", scope.density);
  if (scope.timeZone !== defaultDisplayTimeZone) params.set("tz", scope.timeZone);
  for (const key of Object.keys(extra).sort()) {
    const value = extra[key];
    // Empty semantic selections are invalid requests, not absent defaults.
    // Preserve them through unrelated scope changes until explicitly corrected.
    const preserveEmpty = key === "state" || key === "date_basis" || key === "boards";
    if (value !== null && value !== undefined && (value !== "" || preserveEmpty)) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Route-specific parameters, with scope parameters removed. */
export function routeParams(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!(scopeParams as readonly string[]).includes(key)) result[key] = value;
  }
  return result;
}

export interface TimeWindow {
  /** Inclusive start, or null for all-time. */
  start: Date | null;
  /** Exclusive end. */
  end: Date;
  label: string;
}

function utcDay(date: Date): Date {
  const day = new Date(date.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function utcMonthStart(date: Date, month: number): Date {
  // Preserve the accepted year: Date.UTC remaps years 0–99 to 1900–1999.
  const start = utcDay(date);
  start.setUTCMonth(month, 1);
  return start;
}

/**
 * Resolve the half-open UTC window for a scope against a snapshot cutoff.
 * Rolling windows end at the cutoff; calendar presets cover the calendar
 * period containing the cutoff, truncated at the cutoff.
 */
export function resolveWindow(scope: Scope, cutoff: Date): TimeWindow {
  const day = 24 * 60 * 60 * 1000;
  switch (scope.period) {
    case "7d":
    case "30d":
    case "90d": {
      const days = Number.parseInt(scope.period, 10);
      return {
        start: new Date(cutoff.getTime() - days * day),
        end: cutoff,
        label: `Last ${days} days`,
      };
    }
    case "all":
      return { start: null, end: cutoff, label: "All time" };
    case "month":
      return {
        start: utcMonthStart(cutoff, cutoff.getUTCMonth()),
        end: cutoff,
        label: "This calendar month",
      };
    case "quarter": {
      const quarterMonth = Math.floor(cutoff.getUTCMonth() / 3) * 3;
      return {
        start: utcMonthStart(cutoff, quarterMonth),
        end: cutoff,
        label: `Q${quarterMonth / 3 + 1} ${cutoff.getUTCFullYear()}`,
      };
    }
    case "year":
      return {
        start: utcMonthStart(cutoff, 0),
        end: cutoff,
        label: `Calendar year ${cutoff.getUTCFullYear()}`,
      };
    case "custom": {
      const start = utcDay(new Date(`${scope.from}T00:00:00Z`));
      const requestedEnd = utcDay(new Date(`${scope.to}T00:00:00Z`));
      const end = requestedEnd.getTime() > cutoff.getTime() ? cutoff : requestedEnd;
      return { start, end, label: `${scope.from} to ${scope.to} (end exclusive)` };
    }
  }
}

export function inWindow(timestamp: string, window: TimeWindow): boolean {
  const time = Date.parse(timestamp);
  return (window.start === null || time >= window.start.getTime()) && time < window.end.getTime();
}

/** Carry only global scope across route changes, leaving local searches behind. */
export function scopedHref(path: string, scope: Scope): string {
  return `${path}${serializeScope(scope)}`;
}

/** Follow updates wait for every form of reader engagement to end. */
export function mayFollowUpdates(pointerInside: boolean, focusInside: boolean, proofOpen: boolean): boolean {
  return !pointerInside && !focusInside && !proofOpen;
}
