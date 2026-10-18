import { metricRegistryV1 } from "@pick-your-ai/metrics";

/** Fictional public receipts only. No source installation or actual recognition is implied. */
export function milestoneFixture() {
  const at = "2026-10-17T12:00:00Z";
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: "synthetic-repo",
    windowStart: "2026-10-01T00:00:00Z",
    windowEnd: at,
    knownStart: "2026-10-01T00:00:00Z",
    lastSuccessfulSync: at,
    sourceWatermark: at,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const actors = ["alex", "bea", "cam", "dev", "eli", "robot"].map((name) => ({
    actorId: name,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: "synthetic-" + name,
      login: "synthetic-" + name,
      displayName: "Synthetic " + name,
      kind: "user",
      executionMode: name === "robot" ? "automated" : "unknown",
    },
  }));
  const proof = (id, actorId, artifact, role, metrics, occurredAt, activityState = "accepted") => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: "synthetic-pr-" + artifact,
      repositoryId: "synthetic-repo",
      publicUrl: "https://github.com/synthetic-milestones/example/pull/" + artifact,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: id,
      canonicalEventId: "event-" + id,
      artifactId: "synthetic-pr-" + artifact,
      actorId,
      roles: [role],
      qualification: "eligible",
      metricIds: metrics,
      reasonCodes: ["synthetic_accepted_receipt"],
    },
    occurredAt,
    observedAt: at,
    activityState,
    sourceRevision: "synthetic-revision",
    sourceRevisionUrl: null,
  });
  const portfolioEvidence = [
    proof("alex-authored", "alex", 1, "author", ["pr_merged", "documentation"], "2026-10-10T10:00:00.0009Z"),
    proof("bea-authored", "bea", 1, "coauthor", ["pr_merged", "documentation"], "2026-10-10T10:00:00Z"),
    proof("cam-reviewed", "cam", 1, "reviewer", ["prs_reviewed"], "2026-10-11T10:00:00Z"),
    proof("alex-reviewed", "alex", 2, "reviewer", ["prs_reviewed"], "2026-10-12T10:00:00Z"),
    proof("dev-authored", "dev", 2, "author", ["pr_merged"], "2026-10-11T10:00:00Z"),
    proof("eli-reviewed", "eli", 2, "reviewer", ["prs_reviewed"], "2026-10-12T11:00:00Z"),
    proof("robot-authored", "robot", 1, "coauthor", ["pr_merged"], "2026-10-10T10:00:00Z"),
    proof("alex-observed", "alex", 3, "author", ["pr_merged"], "2026-10-02T10:00:00Z", "observed"),
    proof("alex-pending", "alex", 4, "author", ["pr_merged"], "2026-10-03T10:00:00Z", "pending"),
  ];
  const evidence = portfolioEvidence.map(({ activityState, observedAt, ...entry }) => entry);
  const metrics = ["pr_merged", "prs_reviewed", "documentation"];
  return {
    head: { snapshotId: "synthetic-milestones", revision: 1, publishedAt: at },
    controls: {
      version: "synthetic-controls-1",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "synthetic-milestones",
        revision: 1,
        generatedAt: at,
        metricDefinitionVersion: metricRegistryV1.policy_version,
        computationVersion: "synthetic-milestones-only",
        coverage: [coverage],
        results: [],
      },
      actors,
      evidence,
      portfolioEvidence,
      rows: actors.flatMap(({ actorId }) =>
        metrics.flatMap((metricId) => {
          const selected = evidence.filter(
            (entry) => entry.contribution.actorId === actorId && entry.contribution.metricIds.includes(metricId),
          );
          return selected.length
            ? [
                {
                  actorId,
                  result: {
                    schemaVersion: "leaderboard/v1",
                    metricId,
                    state: "measured",
                    value: selected.length,
                    coverage,
                  },
                  evidenceIds: selected.map((entry) => entry.contribution.contributionId),
                },
              ]
            : [];
        }),
      ),
      ranking: metrics.map((metricId) => ({ metricId, direction: "descending", rank: false })),
    },
  };
}
