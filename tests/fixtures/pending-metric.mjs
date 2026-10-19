// Synthetic facts and publication inputs only. Never source capability or policy approval evidence.
import { aggregateMetric, getMetricDefinition, stableJSON } from "../../packages/metrics/dist/index.js";
export const at = "2026-10-17T12:00:00.000Z";
export const scope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
export const policy = {
  metricId: "pr_merged",
  version: "synthetic-pending-v1",
  definitionVersion: "candidate-0.1.1",
  unit: getMetricDefinition("pr_merged").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
export function normalized(actorCount = 2) {
  const actors = Array.from({ length: actorCount }, (_, index) => 101 + index).map((n) => ({
    id: String(n),
    login: `synthetic-pending-${n}`,
    kind: "user",
    publicState: "visible",
    githubDatabaseId: n,
    githubNodeId: `SYNTHETIC_${n}`,
    executionMode: "unknown",
  }));
  const facts = actors.flatMap((actor, index) =>
    Array.from({ length: index === 0 ? 17 : 15 }, (_, n) => {
      const id = `synthetic-${actor.id}-${n}`,
        pending = index === 0 && n >= 14;
      return {
        id,
        canonicalKey: id,
        metricId: "pr_merged",
        actorId: actor.id,
        artifactId: `artifact-${id}`,
        repoId: "2",
        role: "author",
        state: pending ? "pending" : "qualified",
        occurredAt: at,
        acceptedAt: pending ? null : at,
        observedAt: at,
        revision: 0,
        correctionReceipt: null,
        acceptanceReceipt: pending ? null : "synthetic-independent-acceptance",
        acceptedBy: pending ? null : "201",
        subjectActorId: actor.id,
        eventContext: { projects: [], workstreams: [] },
        currentContext: { projects: [], workstreams: [] },
      };
    }),
  );
  const evidence = facts.map((fact, n) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: fact.artifactId,
      repositoryId: "2",
      publicUrl: `https://github.com/synthetic-org/synthetic-repo/pull/${n + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: fact.id,
      canonicalEventId: fact.id,
      artifactId: fact.artifactId,
      actorId: fact.actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: [fact.metricId],
      reasonCodes: [],
    },
    occurredAt: at,
    sourceRevision: "synthetic-revision",
    sourceRevisionUrl: null,
  }));
  return { actors, facts, evidence, reasons: [], isSynthetic: true };
}
export function readFixture(actorCount = 2) {
  const input = normalized(actorCount);
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "partial",
    source: "github_rest",
    scopeId: "2",
    windowStart: null,
    windowEnd: at,
    knownStart: null,
    lastSuccessfulSync: at,
    sourceWatermark: at,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const aggregate = aggregateMetric(
    {
      ...input,
      cutoff: "2026-10-18T00:00:00.000Z",
      datasetId: "synthetic-pending",
      backfillRevision: "synthetic-v1",
      repositoryIds: ["2"],
      coverage: [coverage],
    },
    policy,
    {
      timezone: "UTC",
      from: null,
      to: "2026-10-18T00:00:00.000Z",
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
  );
  const rows = aggregate.rows.map((row) => ({
    actorId: row.actorId,
    result: { schemaVersion: "leaderboard/v1", metricId: "pr_merged", state: "partial", value: row.value, coverage },
    evidenceIds: row.evidenceIds,
    pending: {
      schemaVersion: "leaderboard-pending/v1",
      state: row.pending ? "partial" : "unknown",
      valueClass: "qualified",
      count: row.pending || null,
      evidenceIds: row.pendingEvidence.map((fact) => fact.id),
    },
  }));
  const pendingIds = new Set(rows.flatMap((row) => row.pending.evidenceIds));
  return {
    head: { snapshotId: "synthetic-pending-1", revision: 1, publishedAt: at },
    controls: {
      version: "synthetic-controls-1",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope: { ...scope },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "synthetic-pending-1",
        revision: 1,
        generatedAt: at,
        metricDefinitionVersion: "candidate-0.1.1",
        computationVersion: "synthetic-pending-v1",
        coverage: [coverage],
        results: [],
      },
      actors: input.actors.map((actor) => ({
        actorId: actor.id,
        state: "public",
        actor: {
          schemaVersion: "leaderboard/v1",
          identityState: "resolved",
          githubNodeId: actor.githubNodeId,
          login: actor.login,
          kind: actor.kind,
          executionMode: actor.executionMode,
        },
      })),
      rows,
      evidence: input.evidence.filter((entry) => !pendingIds.has(entry.contribution.contributionId)),
      pendingEvidence: input.evidence
        .filter((entry) => pendingIds.has(entry.contribution.contributionId))
        .map((entry) => ({ ...entry, activityState: "pending", observedAt: at })),
      ranking: [{ metricId: "pr_merged", direction: "descending", rank: true }],
      diagnostics: aggregate.rows.map((row, n) => ({
        metricId: "pr_merged",
        actorId: row.actorId,
        numerator: null,
        denominator: null,
        sampleCount: row.sampleCount,
        censored: 0,
        missingReadiness: 0,
        p75: null,
        pending: rows[n].pending,
      })),
      methodology: [
        { metricId: "pr_merged", policyVersion: policy.version, policySignature: "a".repeat(64), policyLink: null },
      ],
    },
  };
}
export const configuration = {
  version: "synthetic-configuration-v1",
  organization: "Pick-Your-AI",
  approvalReceipt: "synthetic-config-approval",
  repositories: [
    {
      id: 2,
      installationId: 1,
      slug: "synthetic-org/synthetic-repo",
      families: ["issues"],
      approvalReceipt: "synthetic-source-approval",
    },
  ],
  policies: [{ policy, signature: stableJSON(policy), approvalReceipt: "synthetic-metric-approval" }],
  scopes: [scope],
};
