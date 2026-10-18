import { metricRegistryV1 } from "@pick-your-ai/metrics";

export const at = "2026-10-18T03:00:00.000Z";
export const scope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
export function snapshot(id = "wall-1", revision = 1, timestamp = at) {
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: "synthetic-wall-scope",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-11-01T00:00:00.000Z",
    knownStart: null,
    lastSuccessfulSync: timestamp,
    sourceWatermark: timestamp,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const actors = Array.from({ length: 15 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      actorId: `wall-${suffix}`,
      state: "public",
      actor: {
        schemaVersion: "leaderboard/v1",
        identityState: "resolved",
        githubNodeId: `synthetic-wall-node-${suffix}`,
        login: `synthetic-wall-${suffix}`,
        displayName: `Wall contributor ${suffix}`,
        kind: "user",
        executionMode: "unknown",
      },
    };
  });
  const evidence = actors.map(({ actorId }, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `wall-pr-${index}`,
      repositoryId: "repo-1",
      publicUrl: `https://github.com/synthetic-wall/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `e-${actorId}`,
      canonicalEventId: `event-${actorId}`,
      artifactId: `wall-pr-${index}`,
      actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_merged"],
      reasonCodes: ["public_accepted_source"],
    },
    occurredAt: timestamp,
    sourceRevision: "synthetic-wall-revision",
    sourceRevisionUrl: "https://github.com/synthetic-wall/example/commit/abcdef",
  }));
  return {
    head: { snapshotId: id, revision, publishedAt: timestamp },
    controls: {
      version: "privacy-1",
      suppressedActorIds: [] as string[],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [] as string[],
    },
    selected: {
      approvedPublic: true,
      scope: { ...scope },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: id,
        revision,
        generatedAt: timestamp,
        metricDefinitionVersion: metricRegistryV1.policy_version,
        computationVersion: "synthetic-wall-browser-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      evidence,
      portfolioEvidence: evidence.map((entry) => ({ ...entry, activityState: "observed", observedAt: timestamp })),
      rows: actors.slice(0, 12).map(({ actorId }, index) => ({
        actorId,
        result: {
          schemaVersion: "leaderboard/v1",
          metricId: "pr_merged",
          state: "measured",
          value: index < 7 ? 5 : 1,
          coverage,
        },
        evidenceIds: [`e-${actorId}`],
      })),
      ranking: [{ metricId: "pr_merged", direction: "descending", rank: true }],
      diagnostics: actors.slice(0, 12).map(({ actorId }, index) => ({
        metricId: "pr_merged",
        actorId,
        numerator: index < 7 ? 5 : 1,
        denominator: null,
        sampleCount: index < 7 ? 5 : 1,
        censored: 0,
        missingReadiness: 0,
        p75: null,
      })),
      methodology: [
        {
          metricId: "pr_merged",
          policyVersion: "synthetic-wall-policy",
          policySignature: "a".repeat(64),
          policyLink: "https://github.com/synthetic-wall/example/blob/main/policy.md",
        },
      ],
    },
  };
}
