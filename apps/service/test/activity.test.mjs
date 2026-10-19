import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";

const at = "2026-10-17T12:00:00.000Z";
const scope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
const coverage = {
  schemaVersion: "leaderboard/v1",
  state: "complete",
  source: "github_rest",
  scopeId: "public-org",
  windowStart: "2026-10-01T00:00:00.000Z",
  windowEnd: "2026-11-01T00:00:00.000Z",
  knownStart: null,
  lastSuccessfulSync: at,
  sourceWatermark: at,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
};
function fixture(snapshotId = "public-1", revision = 1) {
  const actors = ["alice", "bob", "carol"].map((actorId) => ({
    actorId,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: actorId,
      login: actorId,
      kind: "user",
      executionMode: "unknown",
    },
  }));
  const evidence = actors.map(({ actorId }, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `pr-${index}`,
      repositoryId: "repo-1",
      publicUrl: `https://github.com/synthetic/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `e-${actorId}`,
      canonicalEventId: `event-${actorId}`,
      artifactId: `pr-${index}`,
      actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_opened"],
      reasonCodes: ["public_accepted_source"],
    },
    occurredAt: at,
    sourceRevision: "revision-1",
    sourceRevisionUrl: "https://github.com/synthetic/example/commit/abcdef",
  }));
  const rows = actors.map(({ actorId }, index) => ({
    actorId,
    result: {
      schemaVersion: "leaderboard/v1",
      metricId: "pr_opened",
      state: "measured",
      value: index === 2 ? 1 : 2,
      coverage: structuredClone(coverage),
    },
    evidenceIds: [`e-${actorId}`],
  }));
  return {
    head: { snapshotId, revision, publishedAt: at },
    controls: { version: "policy-1", suppressedActorIds: [], suppressedArtifactIds: [], revokedSnapshotIds: [] },
    selected: {
      approvedPublic: true,
      scope: structuredClone(scope),
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId,
        revision,
        generatedAt: at,
        metricDefinitionVersion: "candidate-0.1.1",
        computationVersion: "synthetic-test-only",
        coverage: [structuredClone(coverage)],
        results: [],
      },
      actors,
      rows,
      evidence,
      ranking: [{ metricId: "pr_opened", direction: "descending", rank: false }],
    },
  };
}
function harness(t, data = fixture(), extra = {}) {
  const snapshots = new Map([[data.selected.snapshot.snapshotId, data]]);
  let current = data;
  const calls = [];
  const source = {
    async read(requestScope, pin, signal) {
      calls.push({ scope: requestScope, pin, signal });
      const selected = pin ? snapshots.get(pin) : current;
      if (!selected) return null;
      const copy = structuredClone(selected);
      copy.head = structuredClone(current.head);
      copy.controls = structuredClone(current.controls);
      return copy;
    },
  };
  const app = createService({ source, now: () => Date.parse(at), ...extra });
  t.after(() => app.close());
  return {
    app,
    calls,
    data,
    set(value) {
      current = value;
      snapshots.set(value.selected.snapshot.snapshotId, value);
    },
    expire(id) {
      snapshots.delete(id);
    },
  };
}

function portfolioFixture() {
  const data = fixture();
  data.selected.portfolioEvidence = data.selected.evidence.map((entry) => ({
    ...structuredClone(entry),
    activityState: "observed",
    observedAt: at,
  }));
  data.selected.rows = [];
  data.selected.evidence = [];
  return data;
}
function many(data, count, { repositories = false, oneArtifact = false } = {}) {
  const first = data.selected.portfolioEvidence[0];
  data.selected.portfolioEvidence = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(first),
    artifact: {
      ...first.artifact,
      stableId: oneArtifact ? "artifact-burst" : `artifact-${index}`,
      repositoryId: repositories ? `repo-${index}` : "repo-1",
      publicUrl: `https://github.com/synthetic/example/pull/${oneArtifact ? 1 : index + 1}`,
    },
    contribution: {
      ...first.contribution,
      contributionId: `proof-${String(index).padStart(5, "0")}`,
      canonicalEventId: `event-${index}`,
      artifactId: oneArtifact ? "artifact-burst" : `artifact-${index}`,
    },
  }));
  return data;
}
async function pages(app, route, key, params = "limit=100") {
  const entries = [];
  let cursor = null,
    first;
  do {
    const response = await app.inject(`${route}?${params}${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    first ??= body;
    assert.ok(body[key].length <= Number(new URLSearchParams(params).get("limit") ?? 100));
    entries.push(...body[key]);
    cursor = body.nextCursor;
    assert.ok(entries.length <= 20000, "pagination must terminate within the source bound");
  } while (cursor);
  return { entries, first };
}

test("activity reads observed-only, pending and independently accepted evidence without ranking or inferred clocks", async (t) => {
  const data = portfolioFixture();
  data.selected.portfolioEvidence[0].occurredAt = "2026-10-15T12:00:00.000Z";
  data.selected.portfolioEvidence[0].observedAt = "2026-10-18T12:00:00.000Z";
  data.selected.portfolioEvidence[1].activityState = "pending";
  data.selected.portfolioEvidence[2].activityState = "accepted";
  data.selected.portfolioEvidence[2].occurredAt = null;
  data.selected.portfolioEvidence[2].observedAt = null;
  const { app } = harness(t, data);
  const response = await app.inject("/api/v1/activity");
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(
    body.groups.map((group) => group.actorId),
    ["bob", "alice", "carol"],
  );
  assert.deepEqual(
    body.groups.map((group) => group.activityState),
    ["pending", "observed", "accepted"],
  );
  assert.equal(body.groups[1].latestOccurredAt, "2026-10-15T12:00:00.000Z");
  assert.equal(body.groups[1].lastCollectedAt, "2026-10-18T12:00:00.000Z");
  assert.equal(body.groups[2].latestOccurredAt, null);
  assert.equal(body.groups[2].lastCollectedAt, null);
  assert.equal(body.groups[2].unknownCollectionCount, 1);
  assert.equal(body.correctionHistory, "per_proof");
  assert.ok(!/("rank"|"value"|"score"|"engagement")/.test(response.body));
  assert.deepEqual((await app.inject("/api/v1/boards?metric=pr_opened")).json().rows, []);
  const legacy = fixture();
  legacy.selected.evidence[0].occurredAt = null;
  const legacyApp = harness(t, legacy).app;
  const old = (await legacyApp.inject("/api/v1/activity")).json();
  assert.ok(old.groups.every((group) => group.activityState === "unknown" && group.lastCollectedAt === null));
  assert.equal(old.groups.at(-1).latestOccurredAt, null);
});

test("equal-time streams traverse more than 100 artifact groups in stable order, pinned after publication advances", async (t) => {
  const data = many(portfolioFixture(), 205, { repositories: true });
  const h = harness(t, data);
  const first = (await h.app.inject("/api/v1/activity?limit=100")).json();
  const newer = fixture("public-2", 2);
  h.set(newer);
  const second = await h.app.inject(`/api/v1/activity?limit=100&cursor=${first.nextCursor}`);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().snapshotId, "public-1");
  assert.equal(second.json().head.snapshotId, "public-2");
  assert.equal((await h.app.inject(`/api/v1/activity?limit=100&cursor=${first.nextCursor}`)).body, second.body);
  const third = (await h.app.inject(`/api/v1/activity?limit=100&cursor=${second.json().nextCursor}`)).json();
  const ids = [...first.groups, ...second.json().groups, ...third.groups].map((group) => group.groupId);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(third.nextCursor, null);
});

test("a 1000-artifact burst occupies one bounded card and all canonical facts and duplicate proof representations remain navigable", async (t) => {
  const data = many(portfolioFixture(), 1000);
  const other = portfolioFixture().selected.portfolioEvidence[1];
  const originals = [...data.selected.portfolioEvidence];
  data.selected.ranking.push({ metricId: "documentation", direction: "descending", rank: false });
  data.selected.portfolioEvidence.push(
    ...originals.map((entry) => ({
      ...structuredClone(entry),
      contribution: {
        ...entry.contribution,
        contributionId: `duplicate-${entry.contribution.contributionId}`,
        metricIds: ["documentation"],
      },
    })),
    other,
  );
  const h = harness(t, data);
  const result = await h.app.inject("/api/v1/activity");
  assert.equal(result.statusCode, 200, result.body);
  const body = result.json();
  assert.equal(body.totalGroups, 2);
  const burst = body.groups.find((group) => group.actorId === "alice");
  assert.equal(burst.artifactCount, 1000);
  assert.equal(burst.factCount, 1000);
  assert.equal(burst.proofCount, 2000);
  assert.equal(burst.artifactPreview.length, 5);
  assert.ok(result.body.length < 20000);
  assert.deepEqual(burst.categoryIds, ["documentation", "pr_opened"]);
  const detail = await pages(h.app, `/api/v1/activity/${burst.groupId}`, "proofs");
  assert.equal(detail.entries.length, 2000);
  assert.equal(new Set(detail.entries.map((entry) => entry.contribution.contributionId)).size, 2000);
  assert.equal(new Set(detail.entries.map((entry) => entry.canonicalFactId)).size, 1000);
  assert.deepEqual(
    detail.entries.map((entry) => entry.contribution.contributionId).sort(),
    data.selected.portfolioEvidence
      .filter((entry) => entry.contribution.actorId === "alice")
      .map((entry) => entry.contribution.contributionId)
      .sort(),
  );
  const filtered = (await h.app.inject("/api/v1/activity?category=documentation")).json();
  assert.equal(filtered.groups.length, 1);
  assert.equal(filtered.groups[0].factCount, 1000);
  assert.equal(filtered.groups[0].proofCount, 1000);
  const categoryProofs = await pages(
    h.app,
    `/api/v1/activity/${burst.groupId}`,
    "proofs",
    "category=documentation&limit=100",
  );
  assert.equal(categoryProofs.entries.length, 1000);
});

test("1000 same-artifact facts group once; clock boundaries and explicit states never coalesce", async (t) => {
  const data = many(portfolioFixture(), 1000, { oneArtifact: true });
  data.selected.portfolioEvidence.forEach((entry, index) => {
    entry.occurredAt = new Date(Date.parse(at) + index * 1000).toISOString();
  });
  const { app } = harness(t, data);
  let body = (await app.inject("/api/v1/activity")).json();
  assert.equal(body.totalGroups, 1);
  assert.equal(body.groups[0].artifactCount, 1);
  assert.equal(body.groups[0].factCount, 1000);
  const proofPages = await pages(app, `/api/v1/activity/${body.groups[0].groupId}`, "proofs");
  assert.ok(
    proofPages.entries.every(
      (entry, index, list) => !index || Date.parse(list[index - 1].occurredAt) >= Date.parse(entry.occurredAt),
    ),
  );
  data.selected.portfolioEvidence[0].occurredAt = "2026-10-17T13:00:00.000Z";
  data.selected.portfolioEvidence[1].activityState = "accepted";
  data.selected.portfolioEvidence[2].activityState = "pending";
  body = (await app.inject("/api/v1/activity")).json();
  assert.equal(body.totalGroups, 4);
  assert.equal(body.groups[0].latestOccurredAt, "2026-10-17T13:00:00.000Z");
});

test("activity and proof cursors bind route, group, scope, category, size and snapshot; tamper and expiry fail closed", async (t) => {
  let clock = Date.parse(at);
  const h = harness(t, many(portfolioFixture(), 3, { repositories: true }), { now: () => clock });
  const first = (await h.app.inject("/api/v1/activity?limit=1")).json();
  const route = `/api/v1/activity?limit=1&cursor=${first.nextCursor}`;
  for (const change of [
    "&category=pr_opened",
    "&repository=repo-1",
    "&workstream=other",
    "&snapshot=other",
    "&organization=other",
  ])
    assert.equal((await h.app.inject(route + change)).json().error, "cursor_scope_mismatch");
  assert.equal((await h.app.inject(route.replace("limit=1", "limit=2"))).statusCode, 400);
  assert.equal((await h.app.inject(`/api/v1/contributors?limit=1&cursor=${first.nextCursor}`)).statusCode, 400);
  assert.equal(
    (await h.app.inject(`/api/v1/activity/${first.groups[0].groupId}?limit=1&cursor=${first.nextCursor}`)).statusCode,
    400,
  );
  const raw = JSON.parse(Buffer.from(first.nextCursor.split(".")[0], "base64url"));
  raw.offset = 2;
  const tampered = `${Buffer.from(JSON.stringify(raw)).toString("base64url")}.${first.nextCursor.split(".")[1]}`;
  assert.equal((await h.app.inject(`/api/v1/activity?limit=1&cursor=${tampered}`)).statusCode, 410);
  clock += 16 * 60000;
  assert.equal((await h.app.inject(route)).statusCode, 410);
  const detailHarness = harness(t, many(portfolioFixture(), 3));
  const group = (await detailHarness.app.inject("/api/v1/activity")).json().groups[0];
  const details = (await detailHarness.app.inject(`/api/v1/activity/${group.groupId}?limit=1`)).json();
  assert.equal(
    (await detailHarness.app.inject(`/api/v1/activity/${"f".repeat(64)}?limit=1&cursor=${details.nextCursor}`))
      .statusCode,
    400,
  );
  assert.equal(
    (await detailHarness.app.inject(`/api/v1/activity?limit=1&cursor=${details.nextCursor}`)).statusCode,
    400,
  );
});

test("current hidden actors, suppressed artifacts, disabled categories and revocation apply to pinned midstream reads", async (t) => {
  const data = many(portfolioFixture(), 3);
  const h = harness(t, data);
  const group = (await h.app.inject("/api/v1/activity")).json().groups[0];
  const first = (await h.app.inject(`/api/v1/activity/${group.groupId}?limit=1`)).json();
  const page = `/api/v1/activity/${group.groupId}?limit=1&cursor=${first.nextCursor}`;
  data.controls.version = "privacy-2";
  data.controls.suppressedArtifactIds = ["artifact-1"];
  assert.equal((await h.app.inject(page)).json().error, "cursor_policy_changed_refetch");
  const fresh = (await h.app.inject(`/api/v1/activity/${group.groupId}?snapshot=public-1`)).json();
  assert.equal(fresh.group.artifactCount, 2);
  assert.ok(fresh.proofs.every((entry) => entry.artifact.stableId !== "artifact-1"));
  data.controls.suppressedActorIds = ["alice"];
  assert.equal((await h.app.inject(`/api/v1/activity/${group.groupId}?snapshot=public-1`)).statusCode, 404);
  assert.deepEqual((await h.app.inject("/api/v1/activity?snapshot=public-1")).json().groups, []);
  data.controls.suppressedActorIds = [];
  data.selected.actors[0].state = "hidden";
  assert.deepEqual((await h.app.inject("/api/v1/activity?snapshot=public-1")).json().groups, []);
  data.selected.actors[0].state = "public";
  data.selected.disabledMetrics = [
    { id: "pr_opened", reason: "withdrawn", policyVersion: "review-2", policyLink: null },
  ];
  assert.deepEqual((await h.app.inject("/api/v1/activity")).json().groups, []);
  assert.equal((await h.app.inject("/api/v1/activity?category=pr_opened")).json().error, "metric_disabled");
  data.controls.revokedSnapshotIds = ["public-1"];
  assert.equal((await h.app.inject("/api/v1/activity?snapshot=public-1")).json().error, "snapshot_revoked_refetch");
});

test("exact date/category/repository scope filters use action time and never collection time", async (t) => {
  const data = many(portfolioFixture(), 5);
  const [old, unknown, wrongRepo, unapproved, keep] = data.selected.portfolioEvidence;
  old.occurredAt = "2026-09-01T00:00:00.000Z";
  unknown.occurredAt = null;
  wrongRepo.artifact.repositoryId = "other";
  unapproved.contribution.metricIds = ["documentation"];
  keep.observedAt = "2026-12-01T00:00:00.000Z";
  data.selected.scope = {
    ...scope,
    repository: "repo-1",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
  };
  const h = harness(t, data);
  const query = new URLSearchParams(Object.entries(data.selected.scope).filter(([, value]) => value !== null));
  const body = (await h.app.inject(`/api/v1/activity?${query}&category=pr_opened`)).json();
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0].factCount, 1);
  assert.equal(body.groups[0].artifactPreview[0].artifactId, keep.artifact.stableId);
  const mismatched = await h.app.inject("/api/v1/activity?repository=other");
  assert.equal(mismatched.statusCode, 503);
});

test("malformed activity, ambiguous canonical state, unsupported requests and over-budget projections fail explicitly", async (t) => {
  const data = portfolioFixture();
  const h = harness(t, data);
  for (const query of [
    "metric=pr_opened",
    "search=alice",
    "format=csv",
    "category=missing",
    "limit=101",
    "limit=1&limit=2",
  ])
    assert.equal((await h.app.inject(`/api/v1/activity?${query}`)).statusCode, 400);
  assert.equal((await h.app.inject("/api/v1/activity/invalid")).statusCode, 400);
  const duplicate = structuredClone(data.selected.portfolioEvidence[0]);
  duplicate.contribution.contributionId = "conflicting-proof";
  duplicate.activityState = "accepted";
  data.selected.portfolioEvidence.push(duplicate);
  assert.equal((await h.app.inject("/api/v1/activity")).json().error, "activity_fact_conflict");
  data.selected.portfolioEvidence.pop();
  data.selected.portfolioEvidence[0].observedAt = "invalid";
  assert.equal((await h.app.inject("/api/v1/activity")).statusCode, 503);
  data.selected.portfolioEvidence[0].observedAt = at;
  data.selected.portfolioEvidence = [data.selected.portfolioEvidence[0]];
  data.selected.actors[0].actor.displayName = "x".repeat(1_000_001);
  assert.equal((await h.app.inject("/api/v1/activity")).json().error, "activity_item_too_large");
  data.selected.actors[0].actor.displayName = "alice";
  data.selected.portfolioEvidence = Array.from({ length: 20001 }, () => duplicate);
  assert.equal((await h.app.inject("/api/v1/activity")).statusCode, 503);
});

test("byte-bounded pages preserve continuation without dropping groups", async (t) => {
  const data = many(portfolioFixture(), 3, { repositories: true });
  data.selected.actors[0].actor.displayName = "a".repeat(510_000);
  const { app } = harness(t, data);
  const first = await app.inject("/api/v1/activity?limit=100");
  assert.equal(first.statusCode, 200, first.body.slice(0, 300));
  assert.equal(first.json().groups.length, 1);
  assert.ok(first.json().nextCursor);
  const all = await pages(app, "/api/v1/activity", "groups");
  assert.equal(all.entries.length, 3);
  assert.equal(new Set(all.entries.map((entry) => entry.groupId)).size, 3);
});

test("metric-specific acceptance preserves separate states for one canonical fact without cross-category promotion or blocking", async (t) => {
  const data = many(portfolioFixture(), 1);
  data.selected.ranking.push({ metricId: "documentation", direction: "descending", rank: false });
  const observed = data.selected.portfolioEvidence[0];
  const accepted = {
    ...structuredClone(observed),
    activityState: "accepted",
    contribution: {
      ...observed.contribution,
      contributionId: "accepted-documentation-proof",
      metricIds: ["documentation"],
    },
  };
  data.selected.portfolioEvidence.push(accepted);
  const h = harness(t, data);
  const result = await h.app.inject("/api/v1/activity");
  assert.equal(result.statusCode, 200, result.body);
  const groups = result.json().groups;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.activityState).sort(), ["accepted", "observed"]);
  const ids = [];
  for (const group of groups) {
    assert.equal(group.factCount, 1);
    assert.equal(group.proofCount, 1);
    const detail = (await h.app.inject(`/api/v1/activity/${group.groupId}`)).json();
    ids.push(detail.proofs[0].canonicalFactId);
    assert.equal(detail.proofs[0].activityState, group.activityState);
  }
  assert.equal(new Set(ids).size, 1, "shared source fact stays identifiable across distinct policy states");
  const compact = (await h.app.inject("/api/v1/activity-bursts")).json().bursts;
  assert.deepEqual(compact.map((burst) => burst.activityState).sort(), ["accepted", "observed"]);
  assert.deepEqual(
    compact.flatMap((burst) => burst.previewGroups.map((group) => group.groupId)).sort(),
    groups.map((group) => group.groupId).sort(),
  );
  assert.equal((await h.app.inject("/api/v1/activity?category=pr_opened")).json().groups[0].activityState, "observed");
  assert.equal(
    (await h.app.inject("/api/v1/activity?category=documentation")).json().groups[0].activityState,
    "accepted",
  );
  // An invalid conflict within pr_opened fails that selection, not a separately valid category.
  data.selected.portfolioEvidence.push({
    ...structuredClone(observed),
    activityState: "pending",
    contribution: {
      ...observed.contribution,
      contributionId: "conflicting-pr-policy-proof",
    },
  });
  assert.equal((await h.app.inject("/api/v1/activity?category=pr_opened")).json().error, "activity_fact_conflict");
  const unaffected = await h.app.inject("/api/v1/activity?category=documentation");
  assert.equal(unaffected.statusCode, 200, unaffected.body);
  assert.equal(unaffected.json().groups[0].activityState, "accepted");
});

test("conditional activity reads recheck current controls before returning 304 or public proofs", async (t) => {
  const h = harness(t, portfolioFixture());
  const first = await h.app.inject("/api/v1/activity");
  const group = first.json().groups.find((entry) => entry.actorId === "alice");
  const request = { url: "/api/v1/activity?snapshot=public-1", headers: { "if-none-match": first.headers.etag } };
  assert.equal((await h.app.inject(request)).statusCode, 304);
  h.data.controls.version = "privacy-next";
  h.data.controls.suppressedActorIds = ["alice"];
  const changed = await h.app.inject(request);
  assert.equal(changed.statusCode, 200);
  assert.doesNotMatch(changed.body, /alice/);
  assert.equal((await h.app.inject(`/api/v1/activity/${group.groupId}?snapshot=public-1`)).statusCode, 404);
  h.expire("public-1");
  const expired = await h.app.inject(request);
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.headers["cache-control"], "no-store");
});

test("cross-repository metadata bursts leave other work on the first page and retain every v1 group and proof", async (t) => {
  const data = many(portfolioFixture(), 205, { repositories: true });
  data.selected.ranking.push({ metricId: "labels_applied", direction: "descending", rank: false });
  for (const entry of data.selected.portfolioEvidence) {
    entry.artifact.kind = "issue";
    entry.artifact.publicUrl = entry.artifact.publicUrl.replace("/pull/", "/issues/");
    entry.contribution.roles = ["triager"];
    entry.contribution.metricIds = ["labels_applied"];
    entry.occurredAt = "2026-10-17T08:00:00.0009-04:00";
    entry.observedAt = "2026-10-18T12:00:00.000Z";
  }
  const accepted = portfolioFixture().selected.portfolioEvidence[1];
  accepted.activityState = "accepted";
  accepted.occurredAt = "2026-10-17T12:00:00.0001Z";
  data.selected.portfolioEvidence.push(accepted);
  const before = structuredClone(data);
  const { app } = harness(t, data);
  const legacy = await app.inject("/api/v1/activity?limit=20");
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(legacy.json().totalGroups, 206);
  assert.ok(legacy.json().groups.every((group) => group.actorId === "alice"));
  const response = await app.inject("/api/v1/activity-bursts?limit=20");
  assert.equal(response.statusCode, 200, response.body);
  const compact = response.json();
  assert.equal(compact.compactionVersion, "actor-state-utc-hour-v1");
  assert.equal(compact.groupingVersion, "actor-repository-state-utc-hour-v1");
  assert.equal(compact.groupPreviewLimit, 5);
  assert.equal(compact.totalBursts, 2);
  assert.deepEqual(
    compact.bursts.map((burst) => [burst.actorId, burst.activityState]),
    [
      ["alice", "observed"],
      ["bob", "accepted"],
    ],
  );
  const burst = compact.bursts[0];
  assert.equal(burst.groupCount, 205);
  assert.equal(burst.previewGroups.length, 5);
  assert.equal(burst.latestOccurredAt, "2026-10-17T08:00:00.0009-04:00");
  assert.equal(burst.lastCollectedAt, "2026-10-18T12:00:00.000Z");
  assert.ok(response.body.length < 15000, "metadata across repositories occupies one bounded entry");
  assert.equal((await app.inject("/api/v1/activity?limit=20")).body, legacy.body);
  const expanded = await pages(app, `/api/v1/activity-bursts/${burst.burstId}`, "groups");
  const original = await pages(app, "/api/v1/activity", "groups");
  assert.equal(expanded.entries.length, 205);
  assert.deepEqual(
    expanded.entries,
    original.entries.filter((group) => group.actorId === "alice"),
  );
  const proofIds = [];
  for (const group of expanded.entries) {
    const detail = await pages(app, `/api/v1/activity/${group.groupId}`, "proofs");
    proofIds.push(...detail.entries.map((proof) => proof.contribution.contributionId));
  }
  assert.deepEqual(
    proofIds.sort(),
    data.selected.portfolioEvidence
      .slice(0, 205)
      .map((proof) => proof.contribution.contributionId)
      .sort(),
  );
  assert.deepEqual(data, before, "compaction must not alter source groups, facts, dates or identities");
});

test("burst wrappers preserve policy-specific states, exact hour boundaries and unknown action singletons", async (t) => {
  const data = many(portfolioFixture(), 8, { repositories: true });
  const entries = data.selected.portfolioEvidence;
  entries[0].occurredAt = "2026-10-17T12:00:00.0009Z";
  entries[1].occurredAt = "2026-10-17T08:00:00.0001-04:00";
  entries[0].observedAt = null;
  entries[1].observedAt = "2026-10-19T12:00:00.0001Z";
  entries[2].activityState = "pending";
  entries[3].activityState = "accepted";
  entries[4].occurredAt = "2026-10-17T13:00:00.0000Z";
  entries[5].occurredAt = "2026-10-17T11:59:59.9999Z";
  entries[6].occurredAt = entries[7].occurredAt = null;
  const { app } = harness(t, data);
  const response = await app.inject("/api/v1/activity-bursts");
  assert.equal(response.statusCode, 200, response.body);
  const bursts = response.json().bursts;
  assert.equal(bursts.length, 7);
  assert.equal(bursts[0].latestOccurredAt, entries[4].occurredAt);
  const compact = bursts.find((burst) => burst.groupCount === 2);
  assert.equal(compact.activityState, "observed");
  assert.equal(compact.latestOccurredAt, entries[0].occurredAt);
  assert.equal(compact.earliestOccurredAt, entries[1].occurredAt);
  assert.equal(compact.unknownCollectionCount, 1);
  assert.equal(compact.lastCollectedAt, entries[1].observedAt);
  assert.deepEqual(
    bursts.slice(-2).map((burst) => [burst.groupCount, burst.latestOccurredAt]),
    [
      [1, null],
      [1, null],
    ],
  );
  assert.deepEqual(
    bursts.filter((burst) => ["accepted", "pending"].includes(burst.activityState)).map((burst) => burst.groupCount),
    [1, 1],
  );
});

test("burst and subgroup cursors stay pinned and bind every scope field, category, actor filter, version and route", async (t) => {
  let clock = Date.parse(at);
  const data = many(portfolioFixture(), 3, { repositories: true });
  const other = portfolioFixture().selected.portfolioEvidence[1];
  other.occurredAt = "2026-10-17T11:59:59.999Z";
  data.selected.portfolioEvidence.push(other);
  const h = harness(t, data, { now: () => clock });
  const root = (await h.app.inject("/api/v1/activity-bursts?limit=1")).json();
  const burst = root.bursts[0];
  const detail = (await h.app.inject(`/api/v1/activity-bursts/${burst.burstId}?limit=1`)).json();
  assert.ok(root.nextCursor);
  assert.ok(detail.nextCursor);
  const routes = [
    [`/api/v1/activity-bursts`, root.nextCursor],
    [`/api/v1/activity-bursts/${burst.burstId}`, detail.nextCursor],
  ];
  for (const [route, cursor] of routes) {
    const continuation = `${route}?limit=1&cursor=${cursor}`;
    for (const changed of [
      "&category=pr_opened",
      "&repository=repo-1",
      "&workstream=other",
      "&organization=other",
      "&start=2026-10-17T12:00:00Z",
      "&end=2026-10-18T00:00:00Z",
      "&actors=user",
      "&snapshot=other",
    ])
      assert.equal((await h.app.inject(continuation + changed)).statusCode, 400, changed);
    assert.equal((await h.app.inject(continuation.replace("limit=1", "limit=2"))).statusCode, 400);
    for (const other of ["/api/v1/activity", `/api/v1/activity/${burst.previewGroups[0].groupId}`])
      assert.equal((await h.app.inject(`${other}?limit=1&cursor=${cursor}`)).statusCode, 400);
    const payload = JSON.parse(Buffer.from(cursor.split(".")[0], "base64url"));
    assert.match(payload.binding, /actor-state-utc-hour-v1/);
    assert.match(payload.binding, /actor-repository-state-utc-hour-v1/);
  }
  assert.equal((await h.app.inject(`/api/v1/activity-bursts?limit=1&cursor=${detail.nextCursor}`)).statusCode, 400);
  assert.equal(
    (await h.app.inject(`/api/v1/activity-bursts/${burst.burstId}?limit=1&cursor=${root.nextCursor}`)).statusCode,
    400,
  );
  assert.equal(
    (await h.app.inject(`/api/v1/activity-bursts/${"f".repeat(64)}?limit=1&cursor=${detail.nextCursor}`)).statusCode,
    400,
  );
  h.set(fixture("public-2", 2));
  const next = await h.app.inject(`/api/v1/activity-bursts/${burst.burstId}?limit=1&cursor=${detail.nextCursor}`);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().snapshotId, "public-1");
  assert.equal(next.json().head.snapshotId, "public-2");
  clock += 16 * 60000;
  assert.equal((await h.app.inject(`/api/v1/activity-bursts?limit=1&cursor=${root.nextCursor}`)).statusCode, 410);
});

test("burst compaction projects date, repository and category scope before grouping and reapplies current withdrawal", async (t) => {
  const data = many(portfolioFixture(), 6, { repositories: true });
  data.selected.scope = { ...scope, repository: "repo-0", start: at, end: "2026-10-18T00:00:00.000Z" };
  data.selected.portfolioEvidence[0].observedAt = "2026-12-01T00:00:00.000Z";
  const { app } = harness(t, data);
  const query = new URLSearchParams(Object.entries(data.selected.scope).filter(([, value]) => value !== null));
  const route = `/api/v1/activity-bursts?${query}&category=pr_opened&snapshot=public-1`;
  const first = await app.inject(route);
  assert.equal(first.statusCode, 200, first.body);
  const burst = first.json().bursts[0];
  assert.equal(burst.groupCount, 1);
  assert.equal(burst.previewGroups[0].repositoryId, "repo-0");
  assert.equal(burst.lastCollectedAt, "2026-12-01T00:00:00.000Z");
  const detailRoute = `/api/v1/activity-bursts/${burst.burstId}?${query}&category=pr_opened&snapshot=public-1`;
  assert.equal((await app.inject(detailRoute)).json().groups.length, 1);
  assert.equal((await app.inject({ url: route, headers: { "if-none-match": first.headers.etag } })).statusCode, 304);
  data.controls.version = "privacy-2";
  data.controls.suppressedArtifactIds = ["artifact-0"];
  const hidden = await app.inject({ url: route, headers: { "if-none-match": first.headers.etag } });
  assert.equal(hidden.statusCode, 200);
  assert.deepEqual(hidden.json().bursts, []);
  assert.equal((await app.inject(detailRoute)).statusCode, 404);
  data.controls.suppressedArtifactIds = [];
  data.selected.disabledMetrics = [
    { id: "pr_opened", reason: "withdrawn", policyVersion: "review-2", policyLink: null },
  ];
  assert.equal((await app.inject(route)).json().error, "metric_disabled");
  data.selected.disabledMetrics = [];
  data.controls.revokedSnapshotIds = ["public-1"];
  assert.equal((await app.inject(route)).json().error, "snapshot_revoked_refetch");
});

test("burst page byte limits reserve the repeated wrapper and traverse every member before rejecting oversized items", async (t) => {
  const data = many(portfolioFixture(), 10, { repositories: true });
  for (const [index, entry] of data.selected.portfolioEvidence.entries())
    if (index >= 5) entry.contribution.actorId = "bob";
  data.selected.actors[0].actor.displayName = data.selected.actors[1].actor.displayName = "a".repeat(180000);
  const { app } = harness(t, data);
  const first = await app.inject("/api/v1/activity-bursts?limit=100");
  assert.equal(first.statusCode, 200, first.body.slice(0, 300));
  assert.equal(first.json().bursts.length, 1);
  assert.ok(first.json().nextCursor);
  const all = await pages(app, "/api/v1/activity-bursts", "bursts");
  assert.equal(all.entries.length, 2);
  const burst = all.entries[0];
  const members = await pages(app, `/api/v1/activity-bursts/${burst.burstId}`, "groups");
  assert.equal(members.entries.length, 5);
  assert.equal(members.first.groups.length, 3);
  assert.ok(members.first.nextCursor);
  assert.deepEqual(members.entries, burst.previewGroups);
  const tail = await app.inject(
    `/api/v1/activity-bursts/${burst.burstId}?limit=100&cursor=${members.first.nextCursor}`,
  );
  assert.equal(tail.statusCode, 200);
  assert.equal(tail.json().groups.length, 2);
  assert.equal(tail.json().nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(members.first)) <= 1_500_000);
  assert.ok(Buffer.byteLength(tail.body) <= 1_500_000);
  const { activityBurstDetail } = await import("../../web/src/remote/activity-bursts.ts");
  const { selection } = await import("../../web/src/remote/client.ts");
  assert.deepEqual(activityBurstDetail(members.first, selection("?limit=100")).groups, members.first.groups);
  assert.deepEqual(
    activityBurstDetail(tail.json(), selection(`?limit=100&cursor=${members.first.nextCursor}`)).groups,
    tail.json().groups,
  );
  data.selected.actors[0].actor.displayName = "x".repeat(210000);
  assert.equal((await app.inject("/api/v1/activity-bursts")).json().error, "activity_item_too_large");
});
