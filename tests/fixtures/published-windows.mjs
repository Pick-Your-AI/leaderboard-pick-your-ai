// Explicit synthetic publications prepared before reads. Never source or production approval evidence.
import { createHash } from "node:crypto";
import { canonicalPublicScope, publicScopeKey, publicWindowPeriods } from "../../packages/contracts/dist/index.js";
import { aggregateMetric, resolveMetricWindow, stableJSON } from "../../packages/metrics/dist/index.js";
import { normalized, policy, readFixture } from "./pending-metric.mjs";

export const windowCutoff = "2026-10-18T12:00:00.000Z";
export const windowFilter = canonicalPublicScope({
  organization: "Pick-Your-AI",
  repository: "2",
  workstream: "w1",
  start: null,
  end: null,
  context: "current",
  projects: ["PVT_A", "PVT_B="],
  roles: ["author"],
});

function publication(scope, cutoff, revision, boundary = false) {
  const read = readFixture();
  const input = normalized();
  const first = input.facts.filter((fact) => fact.actorId === "101" && fact.state === "qualified");
  input.facts = boundary
    ? first.slice(0, 4)
    : [...first.slice(0, 3), ...input.facts.filter((fact) => fact.actorId === "102").slice(0, 2)];
  const times = boundary
    ? [Date.parse(scope.start) - 1, Date.parse(scope.start), Date.parse(scope.end) - 1, Date.parse(scope.end)]
    : input.facts.map(() => Date.parse(cutoff) - 86_400_000);
  for (let index = 0; index < input.facts.length; index++) {
    const fact = input.facts[index];
    const timestamp = new Date(times[index]).toISOString();
    fact.occurredAt = timestamp;
    fact.acceptedAt = timestamp;
    fact.observedAt = timestamp;
    const context = {
      projects: scope.projects ?? [],
      projectScope: scope.projects ?? [],
      workstreams: scope.workstream === null ? [] : [scope.workstream],
      workstreamsKnown: true,
    };
    fact.eventContext = structuredClone(context);
    fact.currentContext = structuredClone(context);
  }
  const facts = new Map(input.facts.map((fact) => [fact.id, fact]));
  input.evidence = input.evidence.filter((entry) => facts.has(entry.contribution.contributionId));
  for (const entry of input.evidence) entry.occurredAt = facts.get(entry.contribution.contributionId).occurredAt;
  const coverage = {
    ...read.selected.snapshot.coverage[0],
    state: "complete",
    knownStart: scope.start ?? new Date(Math.min(...times)).toISOString(),
    windowStart: scope.start,
    windowEnd: cutoff,
    lastSuccessfulSync: cutoff,
    sourceWatermark: cutoff,
  };
  const id = `synthetic-window-${createHash("sha256").update(stableJSON({ scope, cutoff })).digest("hex").slice(0, 20)}`;
  const aggregate = aggregateMetric(
    {
      ...input,
      cutoff,
      datasetId: id,
      backfillRevision: "synthetic-window-v1",
      repositoryIds: ["2"],
      coverage: [coverage],
    },
    policy,
    {
      timezone: "UTC",
      from: scope.start,
      to: cutoff,
      repos: scope.repository === null ? [] : [scope.repository],
      projects: scope.projects ?? [],
      workstreams: scope.workstream === null ? [] : [scope.workstream],
      roles: scope.roles ?? [],
      actors: "all",
      context: scope.context ?? "event",
    },
  );
  const included = new Set(aggregate.rows.flatMap((row) => row.evidenceIds));
  Object.assign(read.head, { snapshotId: id, revision, publishedAt: cutoff });
  Object.assign(read.selected.snapshot, { snapshotId: id, revision, generatedAt: cutoff, coverage: [coverage] });
  read.selected.scope = structuredClone(scope);
  read.selected.rows = aggregate.rows.map((row) => ({
    actorId: row.actorId,
    result: { schemaVersion: "leaderboard/v1", metricId: "pr_merged", state: "measured", value: row.value, coverage },
    evidenceIds: row.evidenceIds,
    pending: {
      schemaVersion: "leaderboard-pending/v1",
      state: "measured",
      valueClass: "qualified",
      count: 0,
      evidenceIds: [],
    },
  }));
  read.selected.evidence = input.evidence.filter((entry) => included.has(entry.contribution.contributionId));
  read.selected.pendingEvidence = [];
  read.selected.diagnostics = aggregate.rows.map((row, index) => ({
    metricId: "pr_merged",
    actorId: row.actorId,
    numerator: null,
    denominator: null,
    sampleCount: row.sampleCount,
    censored: 0,
    missingReadiness: 0,
    p75: null,
    pending: read.selected.rows[index].pending,
  }));
  read.selected.methodology[0].policySignature = createHash("sha256").update(stableJSON(policy)).digest("hex");
  return read;
}

/** A finite approved map; read/readWindows never construct a scope or consult a clock. */
export function publishedWindowFixture({
  filter = windowFilter,
  cutoff = windowCutoff,
  periods = publicWindowPeriods,
  custom = [],
  revision = 1,
} = {}) {
  filter = canonicalPublicScope(filter);
  const confirmed = new Map();
  const named = new Map();
  for (const period of publicWindowPeriods) {
    const resolved = resolveMetricWindow(period, cutoff);
    if (period !== "all" && resolved.from === resolved.to) continue;
    const scope = canonicalPublicScope({
      ...structuredClone(filter),
      start: resolved.from,
      end: period === "all" ? null : resolved.to,
    });
    const key = publicScopeKey(scope);
    if (!confirmed.has(key)) confirmed.set(key, publication(scope, cutoff, revision));
    named.set(period, key);
  }
  for (const bounds of custom) {
    const scope = canonicalPublicScope({ ...structuredClone(filter), ...bounds });
    confirmed.set(publicScopeKey(scope), publication(scope, scope.end, revision, true));
  }
  let offered = new Set(periods);
  let unavailable = false;
  const calls = { windows: [], reads: [] };
  const source = {
    async readWindows(requested) {
      calls.windows.push(structuredClone(requested));
      if (unavailable || publicScopeKey(requested) !== publicScopeKey(filter)) return null;
      return {
        scope: structuredClone(filter),
        windows: publicWindowPeriods.flatMap((period) => {
          const read = offered.has(period) ? confirmed.get(named.get(period)) : null;
          return read ? [{ period, read: structuredClone(read) }] : [];
        }),
      };
    },
    async read(scope, snapshotId) {
      calls.reads.push({ scope: structuredClone(scope), snapshotId });
      const read = confirmed.get(publicScopeKey(scope));
      return !read || (snapshotId && snapshotId !== read.selected.snapshot.snapshotId) ? null : structuredClone(read);
    },
  };
  return {
    filter: structuredClone(filter),
    source,
    calls,
    descriptor(period) {
      const read = confirmed.get(named.get(period));
      return read
        ? {
            period,
            scope: structuredClone(read.selected.scope),
            snapshotId: read.selected.snapshot.snapshotId,
            revision,
          }
        : null;
    },
    customRead(bounds) {
      return structuredClone(confirmed.get(publicScopeKey(canonicalPublicScope({ ...filter, ...bounds }))));
    },
    offer(periods) {
      offered = new Set(periods);
    },
    unavailable() {
      unavailable = true;
    },
    withdraw(period) {
      confirmed.delete(named.get(period));
    },
  };
}
