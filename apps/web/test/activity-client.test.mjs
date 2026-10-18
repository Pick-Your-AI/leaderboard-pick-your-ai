import assert from "node:assert/strict";
import test from "node:test";
import { activity, activityDetail, portfolioParameters, selection, uiHref } from "../src/remote/client.ts";
const at = "2026-10-17T12:00:00.000Z";
const selected = selection("?ui=api&category=pr_opened&snapshot=public-1&limit=1");
const group = {
  groupId: "a".repeat(64),
  actorId: "alice",
  actor: {
    schemaVersion: "leaderboard/v1",
    identityState: "resolved",
    githubNodeId: "alice",
    login: "alice",
    kind: "user",
    executionMode: "unknown",
  },
  repositoryId: "repo-1",
  activityState: "observed",
  latestOccurredAt: at,
  earliestOccurredAt: at,
  firstCollectedAt: at,
  lastCollectedAt: at,
  unknownCollectionCount: 0,
  artifactCount: 1,
  factCount: 1,
  proofCount: 1,
  categoryIds: ["pr_opened"],
  artifactPreview: [
    { artifactId: "artifact-1", kind: "pull_request", publicUrl: "https://github.com/synthetic/example/pull/1" },
  ],
};
const base = {
  schemaVersion: "leaderboard/v1",
  snapshotId: "public-1",
  revision: 1,
  generatedAt: at,
  metricDefinitionVersion: "candidate-0.1.1",
  computationVersion: "synthetic",
  policyVersion: "privacy-1",
  head: { snapshotId: "public-1", revision: 1, publishedAt: at },
  scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
  coverage: [],
  category: "pr_opened",
  groupingVersion: "actor-repository-state-utc-hour-v1",
  previewLimit: 5,
  correctionHistory: "not_supplied",
  nextCursor: null,
};
const proof = {
  canonicalFactId: "b".repeat(64),
  activityState: "observed",
  observedAt: at,
  occurredAt: at,
  sourceRevision: null,
  sourceRevisionUrl: null,
  artifact: {
    schemaVersion: "leaderboard/v1",
    source: "github",
    stableId: "artifact-1",
    repositoryId: "repo-1",
    kind: "pull_request",
    visibility: "public",
    publicUrl: "https://github.com/synthetic/example/pull/1",
  },
  contribution: {
    schemaVersion: "leaderboard/v1",
    contributionId: "proof-1",
    canonicalEventId: "event-1",
    artifactId: "artifact-1",
    actorId: "alice",
    roles: ["author"],
    qualification: "eligible",
    metricIds: ["pr_opened"],
    reasonCodes: ["public_observed_work"],
  },
};

test("activity navigation binds category, exact scope and pin without board metric API filtering or stale cursor carryover", () => {
  const value = selection(
    "?category=pr_opened&repository=repo-1&snapshot=public-1&cursor=old.signature&metric=documentation&limit=1",
  );
  const params = portfolioParameters(value);
  assert.equal(params.get("metric"), null);
  assert.equal(params.get("category"), "pr_opened");
  for (const path of ["/activity", `/activity/${group.groupId}`]) {
    const href = new URL(uiHref(path, value), "https://example.invalid");
    assert.equal(href.searchParams.get("category"), "pr_opened");
    assert.equal(href.searchParams.get("repository"), "repo-1");
    assert.equal(href.searchParams.get("snapshot"), "public-1");
    assert.equal(href.searchParams.get("cursor"), null);
  }
});

test("activity client validates bounded versioned groups and explicit null clocks", () => {
  assert.equal(activity({ ...base, groups: [group], totalGroups: 1 }, selected).groups[0].activityState, "observed");
  const unknown = {
    ...group,
    latestOccurredAt: null,
    earliestOccurredAt: null,
    firstCollectedAt: null,
    lastCollectedAt: null,
    unknownCollectionCount: 1,
  };
  assert.equal(activity({ ...base, groups: [unknown], totalGroups: 1 }, selected).groups[0].latestOccurredAt, null);
  for (const patch of [
    { artifactCount: 2 },
    { factCount: 0 },
    { proofCount: 0 },
    { proofCount: 20001 },
    { unknownCollectionCount: 2 },
    { activityState: "implicitly_accepted" },
    { categoryIds: ["documentation"] },
    { latestOccurredAt: "not-a-date" },
    { earliestOccurredAt: "2026-10-17T11:59:59.000Z" },
    { lastCollectedAt: "2026-10-16T12:00:00.000Z" },
    { artifactPreview: [{ ...group.artifactPreview[0], publicUrl: "https://evil.invalid/private" }] },
  ])
    assert.throws(() => activity({ ...base, groups: [{ ...group, ...patch }], totalGroups: 1 }, selected));
  for (const patch of [
    { category: "documentation" },
    { groupingVersion: "unreviewed" },
    { totalGroups: 0 },
    { totalGroups: 20001 },
    { correctionHistory: "invented" },
  ])
    assert.throws(() => activity({ ...base, groups: [group], totalGroups: 1, ...patch }, selected));
  assert.throws(() => activity({ ...base, groups: [group, group], totalGroups: 2 }, selected));
  assert.throws(
    () => activity({ ...base, groups: [group], totalGroups: 1, snapshotId: "other" }, selected),
    /api_snapshot_mismatch/,
  );
  assert.throws(
    () =>
      activity({ ...base, groups: [group], totalGroups: 1, scope: { ...base.scope, repository: "other" } }, selected),
    /api_scope_mismatch/,
  );
});

test("activity proof details reject cross-actor, artifact, category, state and date mismatches", () => {
  assert.equal(activityDetail({ ...base, group, proofs: [proof] }, selected).proofs[0].canonicalFactId, "b".repeat(64));
  for (const patch of [
    { canonicalFactId: "unknown" },
    { activityState: "accepted" },
    { occurredAt: null },
    { observedAt: "invalid" },
    { occurredAt: "2026-10-17T13:00:00.000Z" },
    { contribution: { ...proof.contribution, actorId: "bob" } },
    { contribution: { ...proof.contribution, artifactId: "other" } },
    { contribution: { ...proof.contribution, metricIds: ["documentation"] } },
    { contribution: { ...proof.contribution, roles: ["unknown"] } },
    { artifact: { ...proof.artifact, repositoryId: "other" } },
  ])
    assert.throws(() => activityDetail({ ...base, group, proofs: [{ ...proof, ...patch }] }, selected));
});

test("activity validates fractional bounds and proof inclusion without rounding the source clocks", () => {
  const early = "2026-10-17T12:00:00.0001Z";
  const late = "2026-10-17T08:00:00.0009-04:00";
  const precise = {
    ...group,
    earliestOccurredAt: early,
    latestOccurredAt: late,
    firstCollectedAt: early,
    lastCollectedAt: late,
  };
  assert.equal(activity({ ...base, groups: [precise], totalGroups: 1 }, selected).groups[0].latestOccurredAt, late);
  for (const patch of [
    { earliestOccurredAt: late, latestOccurredAt: early },
    { firstCollectedAt: late, lastCollectedAt: early },
  ]) {
    assert.throws(() => activity({ ...base, groups: [{ ...precise, ...patch }], totalGroups: 1 }, selected));
  }
  for (const occurredAt of ["2026-10-17T12:00:00.0000Z", "2026-10-17T12:00:00.00091Z"]) {
    assert.throws(() => activityDetail({ ...base, group: precise, proofs: [{ ...proof, occurredAt }] }, selected));
  }
  for (const occurredAt of [early, late, "2026-10-17T12:00:00.00090Z"]) {
    assert.equal(
      activityDetail({ ...base, group: precise, proofs: [{ ...proof, occurredAt }] }, selected).proofs[0].occurredAt,
      occurredAt,
    );
  }
});
