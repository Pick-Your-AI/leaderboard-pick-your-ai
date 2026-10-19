// Synthetic public projections and engine receipts; no source or release approval.
import { createHash } from "node:crypto";
import {
  canonicalPublicScope,
  publicScopeKey,
  currentRankingPresentationPolicy,
} from "../../packages/contracts/dist/index.js";
import { aggregateMetric, resolveMetricWindow, stableJSON } from "../../packages/metrics/dist/index.js";
import { normalized, policy, readFixture, scope } from "./pending-metric.mjs";

export const legacyScope = scope;
export const currentScope = canonicalPublicScope({ ...scope, context: "current", projects: ["PVT_A", "PVT_B="] });
export function scopeFixture(selectedScope = currentScope) {
  const read = readFixture();
  read.selected.scope = structuredClone(selectedScope);
  const id = `synthetic-scope-${createHash("sha256").update(publicScopeKey(selectedScope)).digest("hex").slice(0, 16)}`;
  read.selected.snapshot.snapshotId = id;
  read.head.snapshotId = id;
  return read;
}

export function comparisonFixture(selectedScope, cutoff, id, revision) {
  // Only paired-history fixtures opt into the captured display policy. Ordinary
  // scope/export fixtures retain their legacy policy absence and two actors.
  const read = readFixture(5);
  read.selected.scope = structuredClone(selectedScope);
  read.selected.rankingPresentationPolicy = structuredClone(currentRankingPresentationPolicy);
  const normalizedInput = normalized(5);
  const engineScope = {
    ...resolveMetricWindow("30d", cutoff),
    repos: ["2"],
    projects: selectedScope.projects ?? [],
    workstreams: selectedScope.workstream === null ? [] : [selectedScope.workstream],
    roles: selectedScope.roles ?? [],
    actors: "all",
    context: selectedScope.context ?? "event",
  };
  for (const fact of normalizedInput.facts) {
    const context = { projects: [...engineScope.projects], workstreams: [...engineScope.workstreams] };
    fact.eventContext = context;
    fact.currentContext = structuredClone(context);
  }
  const coverage = {
    ...read.selected.snapshot.coverage[0],
    state: "complete",
    knownStart: selectedScope.start,
    windowStart: selectedScope.start,
    windowEnd: cutoff,
    lastSuccessfulSync: cutoff,
    sourceWatermark: cutoff,
  };
  const aggregate = aggregateMetric(
    {
      ...normalizedInput,
      datasetId: id,
      cutoff,
      backfillRevision: "synthetic-scope-history-v1",
      repositoryIds: ["2"],
      coverage: [coverage],
    },
    policy,
    engineScope,
  );
  Object.assign(read.head, { snapshotId: id, revision, publishedAt: cutoff });
  Object.assign(read.selected.snapshot, { snapshotId: id, revision, generatedAt: cutoff, coverage: [coverage] });
  for (const row of read.selected.rows) {
    row.result.coverage = coverage;
    row.result.state = "measured";
  }
  const signature = createHash("sha256").update(stableJSON(policy)).digest("hex");
  read.selected.methodology[0].policySignature = signature;
  return {
    read,
    history: {
      snapshotId: id,
      revision,
      metrics: [{ ...aggregate, sources: [...policy.sources], policySignature: signature }],
    },
  };
}
