/**
 * Prototype read layer over the synthetic fixture. Screens depend only on the
 * functions here, so the read API (LB-12.01/12.02) can replace this module
 * without changing components. Nothing here talks to GitHub.
 */
import type {
  Contribution,
  Coverage,
  MetricDefinition,
  MetricResult,
  SourceEvent,
} from "@pick-your-ai/contracts";
import type {
  ContributionRecord,
  FixtureMetric,
  LineBreakdown,
  Person,
  SnapshotMeta,
} from "./model.ts";
import { excludedLineCategories } from "./model.ts";
import {
  contributions,
  coverage,
  fixtureMetrics,
  people,
  projects,
  repositories,
  snapshots,
} from "./synthetic.ts";
import { getMetric, metrics } from "./registry.ts";
import { denseRank } from "../lib/ranking.ts";
import { inWindow, resolveWindow, type Scope, type ScopeContext, type TimeWindow } from "../lib/scope.ts";

export class SourceError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "SourceError";
    this.detail = detail;
  }
}

export const scopeContext: ScopeContext = {
  repoIds: repositories.map((repo) => repo.id),
  projectIds: projects.map((project) => project.id),
  snapshotIds: snapshots.map((snapshot) => snapshot.id),
};

export { coverage, repositories, projects, snapshots };

const peopleById = new Map(people.map((person) => [person.actorId, person]));

export function personFor(actorId: string | null): Person | null {
  return actorId ? peopleById.get(actorId) ?? null : null;
}

export function isAutomation(person: Person | null): boolean {
  return person !== null && person.actor.kind !== "user";
}

export function getSnapshot(id: string): SnapshotMeta | undefined {
  return snapshots.find((snapshot) => snapshot.id === id);
}

export interface SnapshotView {
  /** The snapshot the reader asked for (or the latest). */
  requested: SnapshotMeta;
  /** The snapshot whose data is shown; differs while rebuilding. */
  served: SnapshotMeta;
  pinned: boolean;
}

export function resolveSnapshot(scope: Scope, latestId: string): SnapshotView {
  const requested = getSnapshot(scope.snapshot ?? latestId);
  if (!requested) throw new SourceError("Snapshot not found", `No snapshot ${scope.snapshot ?? latestId}.`);
  if (requested.status === "failed") {
    throw new SourceError(
      "This snapshot could not be read",
      `Snapshot ${requested.id} failed validation and is not served. Earlier snapshots remain available.`,
    );
  }
  const served = getSnapshot(requested.servesSnapshotId) ?? requested;
  return { requested, served, pinned: scope.snapshot !== null };
}

/** The time a record is placed in a period for a given board. */
function basisTime(record: ContributionRecord, fixture: FixtureMetric | null): string {
  if (fixture && record.acceptedAt && fixture.rankStates.some((state) => state === "qualified" || state === "reviewed")) {
    return record.acceptedAt;
  }
  return record.occurredAt;
}

export interface ScopedRecords {
  snapshot: SnapshotView;
  window: TimeWindow;
  records: ContributionRecord[];
}

/** Records visible in a snapshot and scope, with suppressed people removed. */
export function scopedRecords(scope: Scope, latestId: string, fixture: FixtureMetric | null = null): ScopedRecords {
  const snapshot = resolveSnapshot(scope, latestId);
  const cutoff = new Date(snapshot.served.cutoff);
  const window = resolveWindow(scope, cutoff);
  const projectRepos = new Set(
    projects.filter((project) => scope.projects.includes(project.id)).flatMap((project) => project.repoIds),
  );
  const records = contributions.filter((record) => {
    if (Date.parse(record.observedAt) > cutoff.getTime()) return false;
    const person = personFor(record.actorId);
    if (person?.publicState === "suppressed") return false;
    if (scope.repos.length && !scope.repos.includes(record.repoId)) return false;
    if (scope.projects.length && !projectRepos.has(record.repoId)) return false;
    const automation = isAutomation(person);
    if (scope.actor === "user" && automation) return false;
    if (scope.actor === "automation" && !automation) return false;
    return inWindow(basisTime(record, fixture), window);
  });
  return { snapshot, window, records };
}

export function eligibleLines(breakdown: LineBreakdown): number {
  return (Object.keys(breakdown) as (keyof LineBreakdown)[])
    .filter((key) => !(excludedLineCategories as readonly string[]).includes(key))
    .reduce((sum, key) => sum + breakdown[key], 0);
}

export function sumLines(records: readonly ContributionRecord[]): LineBreakdown {
  const total: LineBreakdown = { source: 0, docs: 0, tests: 0, generated: 0, vendor: 0, lockfile: 0, other: 0 };
  for (const record of records) {
    if (!record.lines) continue;
    for (const key of Object.keys(total) as (keyof LineBreakdown)[]) total[key] += record.lines[key];
  }
  return total;
}

export function coverageFor(repoIds: readonly string[], adapters: readonly Coverage["source"][]): Coverage[] {
  const ids = repoIds.length ? repoIds : repositories.map((repo) => repo.id);
  return coverage
    .filter((entry) => ids.includes(entry.repoId))
    .flatMap((entry) => entry.coverage.filter((item) => adapters.includes(item.source)));
}

const coverageRankOrder: Coverage["state"][] = ["unavailable", "unknown", "partial", "complete"];

/** The weakest coverage state across the scope; complete only when everything is complete. */
export function combinedCoverageState(items: readonly Coverage[]): Coverage["state"] {
  if (items.length === 0) return "unknown";
  return items.reduce<Coverage["state"]>(
    (worst, item) => (coverageRankOrder.indexOf(item.state) < coverageRankOrder.indexOf(worst) ? item.state : worst),
    "complete",
  );
}

export function adaptersForMetric(metric: MetricDefinition): Coverage["source"][] {
  const release = metric.definition.release_eligibility;
  if (release === "evidence-reviewed") return ["reviewed_receipt"];
  if (metric.family === "triage" && metric.id.startsWith("project_")) return ["github_graphql"];
  return ["github_rest"];
}

export interface BoardRow {
  person: Person;
  rank: number;
  tied: boolean;
  value: number;
  pending: number;
  ranked: ContributionRecord[];
  pendingRecords: ContributionRecord[];
  lines: LineBreakdown | null;
  result: MetricResult;
}

export interface Board {
  metric: MetricDefinition;
  fixture: FixtureMetric | null;
  snapshot: SnapshotView;
  window: TimeWindow;
  rows: BoardRow[];
  /** Contributors with only pending work: listed, never ranked. */
  pendingOnly: { person: Person; records: ContributionRecord[] }[];
  excluded: ContributionRecord[];
  coverage: Coverage[];
  coverageState: Coverage["state"];
  status: "measured" | "not_measured" | "empty_complete" | "empty_incomplete";
}

function windowCoverage(items: Coverage[], window: TimeWindow): Coverage[] {
  // Coverage that starts after the requested window start only partly covers it.
  return items.map((item) => {
    if (item.state !== "complete" || !item.knownStart) return item;
    const startsLate = window.start === null || Date.parse(item.knownStart) > window.start.getTime();
    return startsLate
      ? { ...item, state: "partial" as const, sourceErrors: [`Source history starts ${item.knownStart.slice(0, 10)}, after the requested window start.`] }
      : item;
  });
}

export function buildBoard(metricId: string, scope: Scope, latestId: string): Board | null {
  const metric = getMetric(metricId);
  if (!metric) return null;
  const fixture = fixtureMetrics[metric.id] ?? null;
  const { snapshot, window, records } = scopedRecords(scope, latestId, fixture);
  const scopeRepos = scope.repos.length
    ? scope.repos
    : scope.projects.length
      ? projects.filter((project) => scope.projects.includes(project.id)).flatMap((project) => project.repoIds)
      : [];
  const boardCoverage = windowCoverage(coverageFor(scopeRepos, adaptersForMetric(metric)), window);
  const coverageState = combinedCoverageState(boardCoverage);

  if (!fixture) {
    return { metric, fixture, snapshot, window, rows: [], pendingOnly: [], excluded: [], coverage: boardCoverage, coverageState, status: "not_measured" };
  }

  const relevant = records.filter((record) => record.metricIds.includes(metric.id));
  const excluded = relevant.filter((record) => record.evidence === "excluded");
  const byPerson = new Map<string, { person: Person; ranked: ContributionRecord[]; pending: ContributionRecord[] }>();
  for (const record of relevant) {
    const person = personFor(record.actorId);
    if (!person || record.evidence === "excluded") continue;
    const entry = byPerson.get(person.actorId) ?? { person, ranked: [], pending: [] };
    if (fixture.rankStates.includes(record.evidence)) entry.ranked.push(record);
    else entry.pending.push(record);
    byPerson.set(person.actorId, entry);
  }

  const valueOf = (entry: { ranked: ContributionRecord[] }) =>
    fixture.valueKind === "lines" ? eligibleLines(sumLines(entry.ranked)) : entry.ranked.length;
  const withRanked = [...byPerson.values()].filter((entry) => entry.ranked.length > 0);
  const pendingOnly = [...byPerson.values()]
    .filter((entry) => entry.ranked.length === 0)
    .map((entry) => ({ person: entry.person, records: entry.pending }))
    .sort((a, b) => a.person.login.localeCompare(b.person.login));

  const resultCoverage: Coverage = boardCoverage[0] ?? {
    schemaVersion: "leaderboard/v1",
    state: "unknown",
    source: "unknown",
    scopeId: null,
    windowStart: null,
    windowEnd: null,
    knownStart: null,
    lastSuccessfulSync: null,
    sourceWatermark: null,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };

  const rows: BoardRow[] = denseRank(withRanked, valueOf, (entry) => entry.person.login).map(({ rank, tied, item }) => {
    const value = valueOf(item);
    return {
      person: item.person,
      rank,
      tied,
      value,
      pending: fixture.valueKind === "lines" ? eligibleLines(sumLines(item.pending)) : item.pending.length,
      ranked: item.ranked,
      pendingRecords: item.pending,
      lines: fixture.valueKind === "lines" ? sumLines(item.ranked) : null,
      result: {
        schemaVersion: "leaderboard/v1",
        metricId: metric.id,
        state: coverageState === "complete" ? "measured" : "partial",
        value,
        coverage: { ...resultCoverage, state: coverageState === "complete" ? "complete" : resultCoverage.state === "complete" ? "partial" : resultCoverage.state },
      },
    };
  });

  const status = rows.length || pendingOnly.length ? "measured" : coverageState === "complete" ? "empty_complete" : "empty_incomplete";
  return { metric, fixture, snapshot, window, rows, pendingOnly, excluded, coverage: boardCoverage, coverageState, status };
}

export interface DirectoryEntry {
  person: Person;
  families: string[];
  firstObservedAt: string;
  observedCount: number;
}

/** Inclusive alphabetical directory: anyone with attributable public work in scope. */
export function listContributors(scope: Scope, latestId: string): { entries: DirectoryEntry[]; snapshot: SnapshotView; window: TimeWindow } {
  const { records, snapshot, window } = scopedRecords(scope, latestId);
  const map = new Map<string, DirectoryEntry>();
  for (const record of records) {
    if (record.evidence === "excluded") continue;
    const person = personFor(record.actorId);
    if (!person) continue;
    const entry = map.get(person.actorId) ?? { person, families: [], firstObservedAt: record.observedAt, observedCount: 0 };
    entry.observedCount += 1;
    if (record.observedAt < entry.firstObservedAt) entry.firstObservedAt = record.observedAt;
    for (const metricId of record.metricIds) {
      const family = getMetric(metricId)?.family;
      if (family && !entry.families.includes(family)) entry.families.push(family);
    }
    map.set(person.actorId, entry);
  }
  const entries = [...map.values()].sort((a, b) => a.person.login.localeCompare(b.person.login));
  return { entries, snapshot, window };
}

export function findPublicPerson(login: string): Person | null {
  const person = people.find((candidate) => candidate.login.toLowerCase() === login.toLowerCase());
  if (!person || person.publicState === "suppressed") return null;
  return person;
}

export interface ProfileMeasure {
  metric: MetricDefinition;
  value: number;
  pending: number;
  rank: string | null;
}

export interface Profile {
  person: Person;
  snapshot: SnapshotView;
  window: TimeWindow;
  measures: Map<string, ProfileMeasure[]>;
  records: ContributionRecord[];
  firstObserved: ContributionRecord | null;
}

export function buildProfile(login: string, scope: Scope, latestId: string): Profile | null {
  const person = findPublicPerson(login);
  if (!person) return null;
  const { records, snapshot, window } = scopedRecords(scope, latestId);
  const own = records
    .filter((record) => record.actorId === person.actorId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const personScope: Scope = { ...scope, actor: isAutomation(person) ? "automation" : "user" };
  const measures = new Map<string, ProfileMeasure[]>();
  for (const metricId of Object.keys(fixtureMetrics)) {
    const board = buildBoard(metricId, personScope, latestId);
    if (!board) continue;
    const row = board.rows.find((candidate) => candidate.person.actorId === person.actorId);
    const pendingOnly = board.pendingOnly.find((candidate) => candidate.person.actorId === person.actorId);
    if (!row && !pendingOnly) continue;
    const list = measures.get(board.metric.family) ?? [];
    list.push({
      metric: board.metric,
      value: row?.value ?? 0,
      pending: row?.pending ?? pendingOnly?.records.length ?? 0,
      rank: row ? `${row.tied ? "=" : ""}${row.rank}` : null,
    });
    measures.set(board.metric.family, list);
  }
  const everything = contributions
    .filter((record) => record.actorId === person.actorId && record.evidence !== "excluded" && Date.parse(record.observedAt) <= Date.parse(snapshot.served.cutoff))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  return { person, snapshot, window, measures, records: own, firstObserved: everything[0] ?? null };
}

export interface ContributionView {
  record: ContributionRecord;
  person: Person | null;
  metrics: MetricDefinition[];
  repository: string;
}

export function getContribution(id: string): ContributionView | null {
  const record = contributions.find((candidate) => candidate.id === id);
  if (!record) return null;
  const person = personFor(record.actorId);
  if (person?.publicState === "suppressed") return null;
  return {
    record,
    person,
    metrics: record.metricIds.map((metricId) => getMetric(metricId)).filter((metric): metric is MetricDefinition => Boolean(metric)),
    repository: repositories.find((repo) => repo.id === record.repoId)?.name ?? record.repoId,
  };
}

export function listActivity(scope: Scope, latestId: string): ScopedRecords {
  const scoped = scopedRecords(scope, latestId);
  return { ...scoped, records: [...scoped.records].sort((a, b) => b.observedAt.localeCompare(a.observedAt)) };
}

export function listCorrections(): ContributionRecord[] {
  return contributions.filter(
    (record) => record.corrections.length > 0 && personFor(record.actorId)?.publicState !== "suppressed",
  );
}

/** Metrics with fixture data, for the wall configurator and overview. */
export function fixtureMetricIds(): string[] {
  return metrics.filter((metric) => fixtureMetrics[metric.id]).map((metric) => metric.id);
}

// Contract mapping: the prototype record expressed as v1 contract objects.

export function toSourceEvent(record: ContributionRecord): SourceEvent {
  const person = personFor(record.actorId);
  return {
    schemaVersion: "leaderboard/v1",
    eventId: `${record.id}-event`,
    adapter: record.adapter,
    action: record.metricIds[0] ?? "unknown",
    actor: person?.actor ?? {
      schemaVersion: "leaderboard/v1",
      identityState: "unavailable",
      kind: "unknown",
      executionMode: "unknown",
    },
    role: record.role,
    subject: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: record.metricIds.some((id) => id.startsWith("issue")) ? "issue" : "pull_request",
      stableId: `${record.id}-subject`,
      repositoryId: record.repoId,
      ...(record.sourceUrl ? { publicUrl: record.sourceUrl } : {}),
      visibility: record.visibility,
    },
    occurredAt: record.occurredAt,
    observedAt: record.observedAt,
    dedupeKey: `${record.id}-dedupe`,
    deduplicationState: record.exclusionReason?.startsWith("Duplicate") ? "duplicate" : "unique",
    observationIds: [`${record.id}-obs`],
  };
}

export function toContribution(record: ContributionRecord): Contribution {
  const qualification: Contribution["qualification"] =
    record.evidence === "excluded"
      ? "ineligible"
      : record.evidence === "provisional"
        ? "pending"
        : record.evidence === "not_measured"
          ? "unavailable"
          : "eligible";
  return {
    schemaVersion: "leaderboard/v1",
    contributionId: record.id,
    canonicalEventId: `${record.id}-event`,
    artifactId: `${record.id}-subject`,
    actorId: record.actorId,
    roles: [record.role],
    qualification,
    metricIds: record.metricIds,
    reasonCodes: record.exclusionReason ? ["excluded_by_policy"] : [],
  };
}
