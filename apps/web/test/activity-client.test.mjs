import assert from "node:assert/strict";
import test from "node:test";
import { activity, activityDetail, portfolioParameters, selection, uiHref } from "../src/remote/client.ts";
import { activityBursts, activityBurstDetail } from "../src/remote/activity-bursts.ts";
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

const compactBase = {
  ...base,
  compactionVersion: "actor-state-utc-hour-v1",
  groupPreviewLimit: 5,
};
function burstFixture() {
  const groups = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(group),
    groupId: index.toString(16).padStart(64, "0"),
    repositoryId: `repo-${index}`,
    artifactPreview: [{ ...group.artifactPreview[0], artifactId: `artifact-${index}` }],
  }));
  const burst = {
    burstId: "f".repeat(64),
    actorId: "alice",
    activityState: "observed",
    latestOccurredAt: at,
    earliestOccurredAt: at,
    firstCollectedAt: at,
    lastCollectedAt: at,
    unknownCollectionCount: 0,
    groupCount: groups.length,
    categoryIds: ["pr_opened"],
    previewGroups: groups.slice(0, 5),
  };
  return { groups, burst };
}

test("additive burst decoding preserves bounded original groups, opaque source IDs, clocks, scope and cursor navigation", () => {
  const { burst, groups } = burstFixture();
  groups[0].artifactPreview[0].artifactId = "opaque-source-" + "A".repeat(201);
  const input = { ...compactBase, bursts: [burst], totalBursts: 1 };
  const before = structuredClone(input);
  const result = activityBursts(input, selected);
  assert.deepEqual(result.bursts[0].previewGroups, groups.slice(0, 5));
  assert.deepEqual(input, before);
  const detailSelection = { ...selected, limit: "100" };
  assert.deepEqual(activityBurstDetail({ ...compactBase, burst, groups }, detailSelection).groups, groups);
  assert.deepEqual(
    activityBurstDetail(
      { ...compactBase, burst, groups: groups.slice(5) },
      { ...detailSelection, cursor: "continuation.signature" },
    ).groups,
    groups.slice(5),
  );
  for (const path of ["/activity/bursts", `/activity/bursts/${burst.burstId}`, `/activity/${groups[0].groupId}`]) {
    const href = new URL(uiHref(path, selected), "https://example.invalid");
    assert.equal(href.searchParams.get("snapshot"), "public-1");
    assert.equal(href.searchParams.get("category"), "pr_opened");
    assert.equal(href.searchParams.get("cursor"), null);
  }
  assert.equal(
    new URL(
      uiHref("/activity/bursts", selected, { cursor: "new.signature" }),
      "https://example.invalid",
    ).searchParams.get("cursor"),
    "new.signature",
  );
});

test("burst decoding rejects unknown versions and contradictory wrapper, member, actor, state, repository and date identities", () => {
  const { burst, groups } = burstFixture();
  for (const patch of [
    { compactionVersion: "unknown" },
    { groupPreviewLimit: 6 },
    { groupingVersion: "unknown" },
    { totalBursts: 20001 },
    { totalBursts: 0 },
    { bursts: [burst, burst] },
    { scope: { ...base.scope, repository: "elsewhere" } },
    { snapshotId: "another" },
    { bursts: [], totalBursts: 1 },
    { totalBursts: 2 },
    { nextCursor: "unnecessary.signature" },
  ])
    assert.throws(() => activityBursts({ ...compactBase, bursts: [burst], totalBursts: 1, ...patch }, selected));
  for (const patch of [
    { burstId: "unrecognized" },
    { actorId: "bob" },
    { activityState: "accepted" },
    { groupCount: 0 },
    { groupCount: 4 },
    { groupCount: 20001 },
    { previewGroups: groups.slice(0, 4) },
    { categoryIds: [] },
    { categoryIds: ["documentation"] },
    { categoryIds: ["pr_opened", "pr_opened"] },
    { earliestOccurredAt: "2026-10-17T11:59:59.9999Z" },
    { latestOccurredAt: "2026-10-17T12:00:00.0001Z" },
    { firstCollectedAt: "2026-10-17T12:00:00.0001Z" },
    { lastCollectedAt: null },
    { previewGroups: [groups[0], groups[0], ...groups.slice(2, 5)] },
  ])
    assert.throws(() => activityBursts({ ...compactBase, bursts: [{ ...burst, ...patch }], totalBursts: 1 }, selected));
  for (const patch of [
    { actorId: "bob" },
    { actor: { ...group.actor, login: "different-person" } },
    { activityState: "accepted" },
    { groupId: groups[0].groupId },
    { repositoryId: groups[0].repositoryId },
    { latestOccurredAt: "2026-10-17T13:00:00.000Z", earliestOccurredAt: "2026-10-17T13:00:00.000Z" },
    { categoryIds: ["documentation"] },
    { artifactPreview: [{ ...groups[6].artifactPreview[0], publicUrl: "https://evil.invalid" }] },
  ])
    assert.throws(() => activityBurstDetail({ ...compactBase, burst, groups: [{ ...groups[6], ...patch }] }, selected));
  // Reusing a preview's durable identity with changed content must also fail.
  for (const patch of [
    { proofCount: 2 },
    { artifactPreview: [{ ...groups[0].artifactPreview[0], artifactId: "other" }] },
  ])
    assert.throws(() => activityBurstDetail({ ...compactBase, burst, groups: [{ ...groups[0], ...patch }] }, selected));
});

test("complete burst pages reconcile summaries and never infer a shared hour for unknown source dates", () => {
  const { burst, groups } = burstFixture();
  const detailSelection = { ...selected, limit: "100" };
  for (const patch of [
    { unknownCollectionCount: 1 },
    { categoryIds: ["pr_opened", "documentation"] },
    { firstCollectedAt: "2026-10-16T12:00:00.000Z" },
    { lastCollectedAt: "2026-10-18T12:00:00.000Z" },
    { earliestOccurredAt: "2026-10-17T12:00:00.0000Z", latestOccurredAt: "2026-10-17T12:00:00.0001Z" },
  ])
    assert.throws(() =>
      activityBurstDetail({ ...compactBase, burst: { ...burst, ...patch }, groups }, detailSelection),
    );
  const unknownGroup = { ...groups[0], latestOccurredAt: null, earliestOccurredAt: null };
  const unknown = {
    ...burst,
    latestOccurredAt: null,
    earliestOccurredAt: null,
    groupCount: 1,
    previewGroups: [unknownGroup],
  };
  assert.equal(
    activityBursts({ ...compactBase, bursts: [unknown], totalBursts: 1 }, selected).bursts[0].latestOccurredAt,
    null,
  );
  assert.throws(() =>
    activityBursts(
      {
        ...compactBase,
        bursts: [
          {
            ...unknown,
            groupCount: 2,
            previewGroups: [
              unknownGroup,
              { ...unknownGroup, groupId: groups[1].groupId, repositoryId: groups[1].repositoryId },
            ],
          },
        ],
        totalBursts: 1,
      },
      selected,
    ),
  );
  const preciseGroups = groups.slice(0, 2).map((item, index) => ({
    ...item,
    latestOccurredAt: index ? "2026-10-17T08:00:00.0001-04:00" : "2026-10-17T12:00:00.0009Z",
    earliestOccurredAt: index ? "2026-10-17T08:00:00.0001-04:00" : "2026-10-17T12:00:00.0009Z",
  }));
  const precise = {
    ...burst,
    groupCount: 2,
    latestOccurredAt: preciseGroups[0].latestOccurredAt,
    earliestOccurredAt: preciseGroups[1].earliestOccurredAt,
    previewGroups: preciseGroups,
  };
  assert.equal(
    activityBursts({ ...compactBase, bursts: [precise], totalBursts: 1 }, selected).bursts[0].earliestOccurredAt,
    "2026-10-17T08:00:00.0001-04:00",
  );
  assert.throws(() =>
    activityBursts(
      { ...compactBase, bursts: [{ ...precise, previewGroups: [...preciseGroups].reverse() }], totalBursts: 1 },
      selected,
    ),
  );
  assert.throws(() =>
    activityBurstDetail(
      { ...compactBase, burst, groups: groups.slice(5), nextCursor: "continued.signature" },
      { ...selected, limit: "100" },
    ),
  );
});

test("separate burst states retain one consistent contributor identity on the same public page", () => {
  const { burst, groups } = burstFixture();
  const accepted = {
    ...burst,
    burstId: "e".repeat(64),
    activityState: "accepted",
    previewGroups: groups
      .slice(0, 5)
      .map((item) => ({ ...item, groupId: "1" + item.groupId.slice(1), activityState: "accepted" })),
  };
  const input = { ...compactBase, bursts: [accepted, burst], totalBursts: 2 };
  const pageSelection = { ...selected, limit: "100" };
  assert.equal(activityBursts(input, pageSelection).bursts.length, 2);
  accepted.previewGroups = accepted.previewGroups.map((item) => ({
    ...item,
    actor: { ...item.actor, login: "someone-else" },
  }));
  assert.throws(() => activityBursts(input, pageSelection));
});
