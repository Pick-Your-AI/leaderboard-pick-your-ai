// Fictional reviewed classifications only; these inputs establish no real account authority.
export const cutoff = "2026-10-03T00:00:00.123Z";
export const classificationTimes = [
  ["one nanosecond earlier", "2026-10-03T00:00:00.122999999Z", true],
  ["exact endpoint with extra zeroes", "2026-10-03T00:00:00.123000000Z", true],
  ["equivalent positive offset", "2026-10-03T01:30:00.123000000+01:30", true],
  ["equivalent negative offset across midnight", "2026-10-02T20:00:00.123000000-04:00", true],
  ["one nanosecond later", "2026-10-03T00:00:00.123000001Z", false],
  ["one nanosecond later with an offset", "2026-10-03T01:30:00.123000001+01:30", false],
  ["a later fraction beyond nanosecond precision", "2026-10-03T00:00:00.12300000000000000001Z", false],
];

export const classification = (reviewedAt = cutoff) => ({
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-classification-time-review",
  githubDatabaseId: 101,
  githubNodeId: "U_synthetic_101",
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-classification-time-evidence"],
  reviewerActorId: "202",
  reviewedAt,
});

export function observation(reviewedAt = cutoff, source = "github_rest") {
  const actor =
    source === "github_graphql"
      ? { databaseId: 101, id: "U_synthetic_101", __typename: "User", login: "synthetic-service" }
      : { id: 101, node_id: "U_synthetic_101", type: "User", login: "synthetic-service" };
  return {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public" },
    proof: { verified: true, source, revision: cutoff, isSynthetic: true },
    family: "pull_request",
    observedAt: cutoff,
    payload: {
      id: 10,
      node_id: "PR_synthetic_10",
      html_url: "https://github.com/synthetic-owner/repository/pull/10",
      user: actor,
      created_at: "2026-10-02T00:00:00Z",
      updated_at: cutoff,
      state: "open",
    },
    reviewedServiceAccounts: [classification(reviewedAt)],
    authorizedClassifierIds: ["202"],
  };
}

export function frozenInput(reviewedAt = cutoff) {
  return {
    datasetId: "synthetic-classification-time-dataset",
    cutoff,
    backfillRevision: "synthetic-classification-time/v1",
    repositoryIds: ["2"],
    coverage: [],
    actors: [
      {
        id: "101",
        login: "synthetic-service",
        kind: "service_account",
        publicState: "visible",
        executionMode: "unknown",
        githubDatabaseId: 101,
        githubNodeId: "U_synthetic_101",
        serviceAccountClassification: classification(reviewedAt),
      },
    ],
    facts: [
      {
        id: "synthetic-classification-time-fact",
        canonicalKey: "synthetic-classification-time-action",
        metricId: "pr_merged",
        actorId: "101",
        artifactId: "synthetic-pr",
        repoId: "2",
        role: "author",
        state: "qualified",
        occurredAt: "2026-10-02T00:00:00Z",
        acceptedAt: "2026-10-02T00:00:00Z",
        observedAt: "2026-10-02T00:00:00Z",
        revision: 0,
        correctionReceipt: null,
        acceptanceReceipt: "synthetic-classification-time-acceptance",
        acceptedBy: "202",
        subjectActorId: "101",
        eventContext: null,
        currentContext: null,
      },
    ],
  };
}
