import {
  selectAcceptedActivityFacts,
  stableJSON,
  type AuditEntry,
  type FrozenInput,
  type MetricFact,
  type MetricPolicy,
  type MetricScope,
} from "./engine.js";
import { getMetricDefinition } from "./v1/index.js";

export type ActivityCalendarUnit = "week" | "month";
export interface ActivityPeriodPolicy {
  version: string;
  definitionVersion: string;
  calendarUnit: ActivityCalendarUnit;
  /** Explicit accepted source policies, never an inferred universal activity policy. */
  sourcePolicies: readonly MetricPolicy[];
}
export type ActivityPeriodShareUnavailableReason =
  "unbounded_window" | "source_or_qualification_incomplete" | "no_fully_covered_periods";
export interface ActivityPeriodRow {
  actorId: string;
  login: string | null;
  /** Known active periods in the selection; partial is a lower bound, not an exact total. */
  value: number;
  state: "measured" | "partial";
  periods: Array<{ start: string; end: string; evidenceIds: string[] }>;
  evidenceIds: string[];
  /** Both share terms exclude calendar periods crossing either selection boundary. */
  numerator: number | null;
  denominator: number | null;
  share: number | null;
  rank: null;
}
export interface ActivityPeriodAggregate {
  metricId: "active_periods";
  unit: string;
  calendarUnit: ActivityCalendarUnit;
  timezone: "UTC";
  weekStartsOn: "monday" | null;
  sourceClock: "occurredAt";
  policyVersion: string;
  policySignature: string;
  definitionVersion: string;
  sourcePolicySignatures: string[];
  evidenceClass: "qualified" | "reviewed";
  datasetId: string;
  cutoff: string;
  backfillRevision: string;
  scope: MetricScope;
  coverage: "complete" | "incomplete";
  /** Null means coverage cannot certify a denominator; zero means no complete period fits. */
  fullyCoveredCalendarPeriods: number | null;
  shareUnavailableReason: ActivityPeriodShareUnavailableReason | null;
  publicEnabled: false;
  rows: ActivityPeriodRow[];
  /** Internal only; excluded identities and private source receipts are not public output. */
  audit: AuditEntry[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const required = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const unique = (values: string[]) => [...new Set(values)].sort(compare);
const weekMilliseconds = 7 * 86400000;

function startOfPeriod(instant: string, unit: ActivityCalendarUnit): Date {
  const date = new Date(instant);
  date.setUTCHours(0, 0, 0, 0);
  if (unit === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  else date.setUTCDate(1);
  return date;
}
function followingPeriod(start: Date, unit: ActivityCalendarUnit): Date {
  const next = new Date(start);
  if (unit === "week") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}
function wholePeriodWindow(scope: MetricScope, unit: ActivityCalendarUnit) {
  if (scope.from === null) return null;
  let start = startOfPeriod(scope.from, unit);
  if (start.getTime() < Date.parse(scope.from)) start = followingPeriod(start, unit);
  const end = startOfPeriod(scope.to, unit);
  const count =
    unit === "week"
      ? (end.getTime() - start.getTime()) / weekMilliseconds
      : (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  // Arithmetic stays bounded by the validated four-digit input years; no walk
  // over every day, week or month is needed for a long selected interval.
  return { start: start.getTime(), end: end.getTime(), count: Math.max(0, count) };
}

/** Private calendar context from source-qualified activity, with an optional covered share.
 * Source authenticity, authorization and completeness are the protected caller's
 * responsibility. This does not activate a registry adapter or public route.
 */
export function aggregateActivityPeriods(
  input: FrozenInput,
  policy: ActivityPeriodPolicy,
  requestedScope: MetricScope,
): ActivityPeriodAggregate {
  if (
    !required(policy.version) ||
    !required(policy.definitionVersion) ||
    !["week", "month"].includes(policy.calendarUnit) ||
    !Array.isArray(policy.sourcePolicies) ||
    !policy.sourcePolicies.length
  )
    throw new Error("Activity periods require a versioned calendar unit and explicit accepted source policies");
  const sourcePolicies: MetricPolicy[] = [];
  for (let index = 0; index < policy.sourcePolicies.length; index++) {
    if (!Object.hasOwn(policy.sourcePolicies, index) || !policy.sourcePolicies[index])
      throw new Error("Every source policy must be an explicit own array entry");
    sourcePolicies.push(policy.sourcePolicies[index]!);
  }
  sourcePolicies.sort((a, b) => compare(a.metricId, b.metricId));
  if (
    new Set(sourcePolicies.map((source) => source.metricId)).size !== sourcePolicies.length ||
    sourcePolicies.some((source) => source.definitionVersion !== policy.definitionVersion) ||
    new Set(sourcePolicies.map((source) => source.rankedStates[0])).size !== 1
  )
    throw new Error("Activity periods require unique source policies with one definition and accepted evidence class");

  const selections = sourcePolicies.map((source) => selectAcceptedActivityFacts(input, source, requestedScope));
  const scope = selections[0]!.scope;
  // The shared selector rejects a scope beyond the frozen cutoff before any
  // period is admitted. Preserve that stricter input boundary.
  const complete = selections.every((selection) => selection.complete);
  const wholeWindow = wholePeriodWindow(scope, policy.calendarUnit);
  let denominator: number | null = null;
  let unavailableReason: ActivityPeriodShareUnavailableReason | null = null;
  if (wholeWindow === null) unavailableReason = "unbounded_window";
  else if (!complete) unavailableReason = "source_or_qualification_incomplete";
  else {
    denominator = wholeWindow.count;
    if (denominator === 0) unavailableReason = "no_fully_covered_periods";
  }

  const byActor = new Map<string, MetricFact[]>();
  const seenFacts = new Set<string>();
  for (const fact of selections.flatMap((selection) => selection.facts)) {
    if (seenFacts.has(fact.id)) throw new Error("Accepted source fact identity conflicts across policies");
    seenFacts.add(fact.id);
    const facts = byActor.get(fact.actorId!) ?? [];
    facts.push(fact);
    byActor.set(fact.actorId!, facts);
  }
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const rows: ActivityPeriodRow[] = [];
  for (const [actorId, facts] of byActor) {
    const actor = actors.get(actorId)!;
    const periods = new Map<number, { start: string; end: string; evidenceIds: string[] }>();
    for (const fact of facts) {
      const start = startOfPeriod(fact.occurredAt!, policy.calendarUnit);
      const period = periods.get(start.getTime()) ?? {
        start: start.toISOString(),
        end: followingPeriod(start, policy.calendarUnit).toISOString(),
        evidenceIds: [],
      };
      period.evidenceIds.push(fact.id);
      periods.set(start.getTime(), period);
    }
    const ordered = [...periods].sort(([a], [b]) => a - b);
    const numerator =
      denominator === null
        ? null
        : ordered.filter(([start]) => start >= wholeWindow!.start && start < wholeWindow!.end).length;
    rows.push({
      actorId,
      login: actor.publicState === "deleted" ? null : actor.login,
      value: periods.size,
      state: complete ? "measured" : "partial",
      periods: ordered.map(([, period]) => ({ ...period, evidenceIds: unique(period.evidenceIds) })),
      evidenceIds: unique(facts.map((fact) => fact.id)),
      numerator,
      denominator,
      share: denominator !== null && denominator > 0 ? numerator! / denominator : null,
      rank: null,
    });
  }
  rows.sort((a, b) => compare(a.login ?? a.actorId, b.login ?? b.actorId) || compare(a.actorId, b.actorId));
  return {
    metricId: "active_periods",
    unit: getMetricDefinition("active_periods")!.definition.unit,
    calendarUnit: policy.calendarUnit,
    timezone: "UTC",
    weekStartsOn: policy.calendarUnit === "week" ? "monday" : null,
    sourceClock: "occurredAt",
    policyVersion: policy.version,
    policySignature: stableJSON({ ...policy, sourcePolicies }),
    definitionVersion: policy.definitionVersion,
    sourcePolicySignatures: sourcePolicies.map(stableJSON),
    evidenceClass: sourcePolicies[0]!.rankedStates[0] as "qualified" | "reviewed",
    datasetId: input.datasetId,
    cutoff: input.cutoff,
    backfillRevision: input.backfillRevision,
    scope,
    coverage: complete ? "complete" : "incomplete",
    fullyCoveredCalendarPeriods: denominator,
    shareUnavailableReason: unavailableReason,
    publicEnabled: false,
    rows,
    audit: selections.flatMap((selection) => selection.audit).sort((a, b) => compare(stableJSON(a), stableJSON(b))),
  };
}
