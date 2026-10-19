// Synthetic provider input for display-policy tests; never real ranking evidence.
import { canonicalPublicScope, currentRankingPresentationPolicy } from "../../packages/contracts/dist/index.js";
import { createService } from "../../apps/service/dist/app.js";

export const rankingAt = "2026-10-18T00:00:00.000Z";
export function rankingFixture({ values = [9, 8, 8, 3, 0, undefined], policy = true, scope = {} } = {}) {
  const selectedScope = canonicalPublicScope({
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: null,
    end: null,
    ...scope,
  });
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "partial",
    source: "github_rest",
    scopeId: "synthetic-cohort-repo",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: rankingAt,
    knownStart: null,
    lastSuccessfulSync: rankingAt,
    sourceWatermark: rankingAt,
    missingPages: 2,
    permissionsMissing: ["synthetic-history-unavailable"],
    sourceErrors: [],
  };
  const actors = values.map((_, index) => ({
    actorId: `synthetic-cohort-${index + 1}`,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: `SYNTHETIC_COHORT_${index + 1}`,
      login: `synthetic-cohort-${index + 1}`,
      kind: index === 4 ? "bot" : "user",
      executionMode: index === 4 ? "automated" : "unknown",
    },
  }));
  const evidence = values.flatMap((value, index) =>
    value === undefined
      ? []
      : [
          {
            artifact: {
              schemaVersion: "leaderboard/v1",
              source: "github",
              kind: "pull_request",
              stableId: `synthetic-cohort-pr-${index + 1}`,
              repositoryId: "synthetic-cohort-repo",
              publicUrl: `https://github.com/synthetic/example/pull/${index + 1}`,
              visibility: "public",
            },
            contribution: {
              schemaVersion: "leaderboard/v1",
              contributionId: `synthetic-cohort-proof-${index + 1}`,
              canonicalEventId: `synthetic-cohort-event-${index + 1}`,
              artifactId: `synthetic-cohort-pr-${index + 1}`,
              actorId: actors[index].actorId,
              roles: ["author"],
              qualification: "eligible",
              metricIds: ["pr_merged"],
              reasonCodes: ["synthetic_fixture"],
            },
            occurredAt: "2026-10-17T12:00:00.000Z",
            sourceRevision: null,
            sourceRevisionUrl: null,
          },
        ],
  );
  const rows = values.map((value, index) => ({
    actorId: actors[index].actorId,
    result: {
      schemaVersion: "leaderboard/v1",
      metricId: "pr_merged",
      state: value === undefined ? "unknown" : value === 0 ? "zero" : index === 0 ? "measured" : "partial",
      ...(value === undefined ? {} : { value }),
      coverage:
        value === 0 ? { ...coverage, state: "complete", missingPages: 0, permissionsMissing: [] } : { ...coverage },
    },
    evidenceIds: value === undefined ? [] : [`synthetic-cohort-proof-${index + 1}`],
  }));
  return {
    head: { snapshotId: "synthetic-cohort-snapshot", revision: 1, publishedAt: rankingAt },
    controls: {
      version: "synthetic-cohort-controls",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope: selectedScope,
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "synthetic-cohort-snapshot",
        revision: 1,
        generatedAt: rankingAt,
        metricDefinitionVersion: "candidate-0.1.1",
        computationVersion: "synthetic-cohort-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      rows,
      evidence,
      ranking: [{ metricId: "pr_merged", direction: "descending", rank: true }],
      ...(policy ? { rankingPresentationPolicy: structuredClone(currentRankingPresentationPolicy) } : {}),
    },
  };
}
export function createRankingPresentationHarness(options = {}) {
  const input = rankingFixture(options);
  const app = createService({
    now: () => Date.parse(rankingAt),
    source: {
      async read(scope, pin, signal) {
        signal.throwIfAborted();
        if (pin !== null && pin !== input.selected.snapshot.snapshotId) return null;
        return structuredClone(input);
      },
    },
  });
  return { input, app };
}
