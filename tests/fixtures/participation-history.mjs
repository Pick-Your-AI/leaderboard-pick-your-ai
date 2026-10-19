// Synthetic trusted-provider protocol fixture. No real source, origin or approval receipt.
import { readFixture } from "./pending-metric.mjs";

export const historyStart = "2026-10-01T00:00:00.000Z";
export const historyCutoff = "2026-10-18T00:00:00.000Z";
export const historyOrigin = "2026-01-01T00:00:00.000Z";
export const historyQuery = `repository=2&start=${historyStart}&end=${historyCutoff}`;
export const historyPath = `/api/v1/contributors/101/participation-history?${historyQuery}`;

export function participationHistoryFixture() {
  const template = readFixture();
  const policies = [
    {
      metricId: "pr_merged",
      version: "synthetic-history-author-v1",
      signature: "a".repeat(64),
      roles: ["author"],
      sources: ["github_rest"],
    },
    {
      metricId: "prs_reviewed",
      version: "synthetic-history-review-v1",
      signature: "b".repeat(64),
      roles: ["reviewer"],
      sources: ["github_rest"],
    },
  ];
  const inventory = ["2", "3"].map((repositoryId) => ({ repositoryId, source: "github_rest" }));
  const coverage = (repositoryId, start = historyOrigin) => ({
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: repositoryId,
    windowStart: start,
    windowEnd: historyCutoff,
    knownStart: historyOrigin,
    sourceWatermark: historyCutoff,
    lastSuccessfulSync: historyCutoff,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  });
  const proof = (id, repositoryId, role, metricId, occurredAt) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `synthetic-opaque:${id}==`,
      repositoryId,
      publicUrl: `https://github.com/synthetic-history/repository-${repositoryId}/pull/${repositoryId}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: id,
      canonicalEventId: "event-" + id,
      artifactId: `synthetic-opaque:${id}==`,
      actorId: "101",
      roles: [role],
      qualification: "eligible",
      metricIds: [metricId],
      reasonCodes: [],
    },
    occurredAt,
    observedAt: "2026-10-17T00:00:00.000Z",
    activityState: "accepted",
    sourceRevision: "synthetic-history-revision",
    sourceRevisionUrl: null,
  });
  const recent = proof("synthetic-recent-author", "2", "author", "pr_merged", "2026-10-10T00:00:00.000Z");
  const first = proof("synthetic-earlier-review", "3", "reviewer", "prs_reviewed", "2026-02-01T00:00:00.000000001Z");
  const methodology = policies.map((policy) => ({
    metricId: policy.metricId,
    policyVersion: policy.version,
    policySignature: policy.signature,
    policyLink: null,
  }));
  const current = {
    head: { snapshotId: "synthetic-history-selected", revision: 3, publishedAt: historyCutoff },
    controls: structuredClone(template.controls),
    selected: {
      approvedPublic: true,
      scope: {
        organization: "Pick-Your-AI",
        repository: "2",
        workstream: null,
        start: historyStart,
        end: historyCutoff,
      },
      snapshot: {
        ...template.selected.snapshot,
        snapshotId: "synthetic-history-selected",
        revision: 3,
        generatedAt: historyCutoff,
        coverage: [coverage("2", historyStart)],
        results: [],
      },
      actors: structuredClone(template.selected.actors),
      rows: [
        {
          actorId: "101",
          result: {
            schemaVersion: "leaderboard/v1",
            metricId: "pr_merged",
            state: "measured",
            value: 1,
            coverage: coverage("2", historyStart),
          },
          evidenceIds: [recent.contribution.contributionId],
        },
      ],
      evidence: [structuredClone(recent)],
      portfolioEvidence: [structuredClone(recent)],
      pendingEvidence: [],
      ranking: policies.map(({ metricId }) => ({ metricId, direction: "descending", rank: true })),
      methodology: structuredClone(methodology),
      disabledMetrics: [],
      diagnostics: [],
    },
  };
  const selectedInput = {
    snapshotId: current.selected.snapshot.snapshotId,
    revision: 3,
    sha256: "c".repeat(64),
    cutoff: historyCutoff,
  };
  const publication = structuredClone(current);
  publication.head = { snapshotId: "synthetic-organization-history", revision: 1, publishedAt: historyCutoff };
  publication.selected.scope = {
    organization: "Pick-Your-AI",
    repository: null,
    workstream: null,
    start: null,
    end: null,
  };
  Object.assign(publication.selected.snapshot, {
    snapshotId: publication.head.snapshotId,
    revision: 1,
    coverage: inventory.map((pair) => coverage(pair.repositoryId)),
  });
  publication.selected.rows = [];
  publication.selected.evidence = [];
  publication.selected.portfolioEvidence = [first, structuredClone(recent)];
  const history = {
    schemaVersion: "participation-history-provider/v1",
    selectedInput: structuredClone(selectedInput),
    admission: {
      decisionId: "synthetic-protected-admission",
      organization: "Pick-Your-AI",
      origin: historyOrigin,
      reviewedAt: "2026-10-17T12:00:00.000Z",
      sourceInventory: structuredClone(inventory),
      policies,
    },
    dataset: {
      id: "synthetic-full-history",
      sha256: "d".repeat(64),
      backfillRevision: "synthetic-history-1",
      cutoff: historyCutoff,
      sourceInventory: structuredClone(inventory),
    },
    publication,
    proofSources: publication.selected.portfolioEvidence.map((entry) => ({
      contributionId: entry.contribution.contributionId,
      repositoryId: entry.artifact.repositoryId,
      source: "github_rest",
    })),
    unresolved: [],
  };
  return { current, selectedInput, history };
}

/** In-memory authority stands in for an authenticated provider, never a public request field. */
export function participationHistorySource(pair = participationHistoryFixture()) {
  const state = { authorized: true, available: true, calls: 0, pair };
  const current = (scope) => {
    if (!state.available) return null;
    const read = structuredClone(pair.current);
    read.selected.scope = scope;
    return read;
  };
  const source = {
    read: async (scope) => current(scope),
    readParticipationHistory: async (scope, _pin, _actor, signal) => {
      state.calls++;
      if (signal.aborted || !state.available) return null;
      const value = structuredClone(pair);
      value.current = current(scope);
      if (!state.authorized) value.history = null;
      return value;
    },
  };
  return { state, source };
}
