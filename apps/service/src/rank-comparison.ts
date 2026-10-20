import { publicScopeFilterKey, sourceAdapterSchema, type RankingPresentation } from "@pick-your-ai/contracts";
import { compareRankMovement, resolveMetricWindow, stableJSON, type RankComparisonInput } from "@pick-your-ai/metrics";
import { compareSourceInstants } from "./source-time.js";
import type { PublicRead, PublicScope } from "./public-source.js";
import { rankingPresentation } from "./ranking-presentation.js";

/** Internal provider data. Never enter a public projection or export. */
export interface RankSnapshotHistory {
  snapshotId: string;
  revision: number;
  metrics: (RankComparisonInput & { sources: string[] })[];
}
export type RankMovement = ReturnType<typeof compareRankMovement>[number];
export interface PublicRankComparison {
  rankingPresentation?: RankingPresentation;
  snapshotId: string | null;
  scope: PublicScope | null;
  generatedAt: string | null;
}
export interface ComparedRanks {
  comparison: PublicRankComparison;
  movement: RankMovement[];
}
const sameSet = (a: string[], b: string[]) => stableJSON([...a].sort()) === stableJSON([...b].sort());
const sameTime = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : compareSourceInstants(a, b) === 0;

/** Match receipts to BOTH current privacy projections. Never subtract withheld
 * evidence or reconstruct metric values/ranks from a partial cohort. */
function historyMetric(
  read: PublicRead,
  history: RankSnapshotHistory | null,
  metricId: string,
): RankSnapshotHistory["metrics"][number] | null {
  if (
    !history ||
    history.snapshotId !== read.selected.snapshot.snapshotId ||
    history.revision !== read.selected.snapshot.revision
  )
    return null;
  const metric = history.metrics.find((entry) => entry.metricId === metricId);
  const policy = read.selected.methodology?.find((entry) => entry.metricId === metricId);
  const ranking = read.selected.ranking.find((entry) => entry.metricId === metricId);
  if (
    !metric ||
    !policy ||
    !ranking ||
    metric.policyVersion !== policy.policyVersion ||
    metric.policySignature !== policy.policySignature ||
    metric.definitionVersion !== read.selected.snapshot.metricDefinitionVersion
  )
    return null;
  const scope = read.selected.scope;
  if (
    !sameTime(metric.scope.from, scope.start) ||
    (scope.end !== null && !sameTime(metric.scope.to, scope.end)) ||
    metric.scope.context !== (scope.context ?? "event") ||
    !sameSet(metric.scope.projects, scope.projects ?? []) ||
    !sameSet(metric.scope.workstreams, scope.workstream === null ? [] : [scope.workstream]) ||
    (scope.repository !== null && !sameSet(metric.scope.repos, [scope.repository])) ||
    !sameSet(metric.scope.roles, scope.roles ?? []) ||
    metric.scope.actors !== "all"
  )
    return null;
  if (metric.scope.period && metric.scope.period !== "custom") {
    const expected = resolveMetricWindow(metric.scope.period, metric.scope.to);
    if (!sameTime(metric.scope.from, expected.from)) return null;
  }
  const rows = read.selected.rows.filter((row) => row.result.metricId === metricId);
  if (
    !sameSet(
      rows.map((row) => row.actorId),
      metric.rows.map((row) => row.actorId),
    )
  )
    return null;
  const values = [...new Set(rows.flatMap((row) => (row.result.value === undefined ? [] : [row.result.value])))].sort(
    (a, b) => (ranking.direction === "ascending" ? a - b : b - a),
  );
  const ranks = new Map(values.map((value, index) => [value, index + 1]));
  const savedRows = new Map<string, (typeof metric.rows)[number]>();
  // Keep first-match semantics; the cohort multiset check above still detects
  // duplicate retained rows against the validated, unique public cohort.
  for (const row of metric.rows) if (!savedRows.has(row.actorId)) savedRows.set(row.actorId, row);
  const evidence = new Map(read.selected.evidence.map((entry) => [entry.contribution.contributionId, entry]));
  for (const row of rows) {
    const saved = savedRows.get(row.actorId)!;
    const rank = ranking.rank === false || row.result.value === undefined ? null : ranks.get(row.result.value);
    if (
      saved.value !== (row.result.value ?? null) ||
      saved.rank !== rank ||
      !sameSet(
        saved.evidence.map((item) => item.id),
        row.evidenceIds,
      ) ||
      saved.evidence.some((item) => !sameTime(item.effectiveAt, evidence.get(item.id)?.occurredAt ?? null))
    )
      return null;
  }
  return metric;
}
function completePublicCoverage(read: PublicRead, metric: RankSnapshotHistory["metrics"][number]): boolean {
  if (
    metric.scope.from === null ||
    compareSourceInstants(read.selected.snapshot.generatedAt, metric.scope.to) < 0 ||
    !metric.scope.repos.length ||
    !Array.isArray(metric.sources) ||
    !metric.sources.length ||
    metric.sources.length > sourceAdapterSchema.options.length ||
    new Set(metric.sources).size !== metric.sources.length ||
    metric.sources.some((source) => !sourceAdapterSchema.safeParse(source).success)
  )
    return false;
  const complete = (item: PublicRead["selected"]["snapshot"]["coverage"][number]) =>
    item.state === "complete" &&
    item.knownStart !== null &&
    compareSourceInstants(item.knownStart, metric.scope.from!) <= 0 &&
    item.windowStart !== null &&
    compareSourceInstants(item.windowStart, metric.scope.from!) <= 0 &&
    item.windowEnd !== null &&
    compareSourceInstants(item.windowEnd, metric.scope.to) >= 0 &&
    item.sourceWatermark !== null &&
    compareSourceInstants(item.sourceWatermark, metric.scope.to) >= 0 &&
    item.missingPages === 0 &&
    item.permissionsMissing.length === 0 &&
    item.sourceErrors.length === 0;
  // Every required source/repository pair must be evidenced; unrelated policies
  // and repositories cannot invalidate this metric or fill a missing pair.
  return (
    metric.scope.repos.every((repo) =>
      metric.sources.every((source) => {
        const records = read.selected.snapshot.coverage.filter(
          (item) => item.scopeId === repo && item.source === source,
        );
        return records.length > 0 && records.every(complete);
      }),
    ) &&
    read.selected.rows
      .filter((row) => row.result.metricId === metric.metricId)
      .every((row) => complete(row.result.coverage))
  );
}

/** Arguments are current-authorized and projected. Positive movement uses only
 * retained engine metadata, never subtraction of displayed ranks. */
export function comparePublishedRanks(
  current: PublicRead,
  previous: PublicRead | null,
  currentHistory: RankSnapshotHistory | null,
  previousHistory: RankSnapshotHistory | null,
  metricId: string,
): ComparedRanks {
  const unavailable = (reason: string): ComparedRanks => ({
    comparison: { snapshotId: null, scope: null, generatedAt: null },
    movement: current.selected.rows
      .filter((row) => row.result.metricId === metricId)
      .map((row) => ({ actorId: row.actorId, state: "unavailable", delta: null, reason })),
  });
  if ((current.actorFilter ?? "all") !== "all") return unavailable("filtered_cohort_unavailable");
  if (!previous) return unavailable("comparison_unavailable");
  if (current.controls.version !== previous.controls.version) return unavailable("current_authority_changed");
  if (current.selected.snapshot.computationVersion !== previous.selected.snapshot.computationVersion)
    return unavailable("mixed_computation_versions");
  const currentPresentation = rankingPresentation(current, metricId);
  const previousPresentation = rankingPresentation(previous, metricId);
  if (currentPresentation === null || previousPresentation === null)
    return unavailable("ranking_presentation_policy_unknown");
  if (
    stableJSON(current.selected.rankingPresentationPolicy) !== stableJSON(previous.selected.rankingPresentationPolicy)
  )
    return unavailable("ranking_presentation_policy_changed");
  if (currentPresentation.state !== "ranked" || previousPresentation.state !== "ranked")
    return unavailable("ranking_presentation_cohort_unavailable");
  if (!currentHistory || !previousHistory) return unavailable("insufficient_evidence_history");
  try {
    if (publicScopeFilterKey(current.selected.scope) !== publicScopeFilterKey(previous.selected.scope))
      return unavailable("comparison_scope_changed");
    const before = historyMetric(previous, previousHistory, metricId),
      after = historyMetric(current, currentHistory, metricId);
    if (!before || !after) return unavailable("history_or_visible_cohort_changed");
    return {
      comparison: {
        snapshotId: previous.selected.snapshot.snapshotId,
        scope: previous.selected.scope,
        generatedAt: previous.selected.snapshot.generatedAt,
        rankingPresentation: previousPresentation,
      },
      movement: compareRankMovement(
        {
          ...before,
          coverage:
            before.coverage === "complete" && completePublicCoverage(previous, before) ? "complete" : "incomplete",
        },
        {
          ...after,
          coverage: after.coverage === "complete" && completePublicCoverage(current, after) ? "complete" : "incomplete",
        },
      ),
    };
  } catch {
    return unavailable("insufficient_evidence_history");
  }
}
