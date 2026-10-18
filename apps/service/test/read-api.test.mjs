import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";
import { startLiveUpdates } from "../dist/live-client.js";
import { selection, validateExport, board as parseBoard } from "../../web/src/remote/client.ts";
import { parseCSVExport } from "../../web/src/remote/csv-export.ts";

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
function fixture(snapshotId = "public-1", revision = 1, metricId = "pr_merged") {
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
      metricIds: [metricId],
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
      metricId,
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
      ranking: [{ metricId, direction: "descending" }],
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

function mixedActors() {
  const data = fixture();
  data.selected.actors[1].actor.executionMode = "automated";
  data.selected.actors[2].actor.kind = "bot";
  data.selected.actors[2].actor.executionMode = "automated";
  data.selected.portfolioEvidence = data.selected.evidence.map((entry) => ({
    ...structuredClone(entry),
    activityState: "observed",
    observedAt: at,
  }));
  return data;
}

test("actor selections narrow all public views without treating user accounts as manual execution", async (t) => {
  const { app, data, calls } = harness(t, mixedActors());
  const original = structuredClone(data);
  for (const [actors, ids] of [
    ["all", ["alice", "bob", "carol"]],
    ["user", ["alice", "bob"]],
    ["automation", ["bob", "carol"]],
  ]) {
    const read = async (path) => {
      const response = await app.inject(`/api/v1/${path}${path.includes("?") ? "&" : "?"}actors=${actors}`);
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      assert.equal(result.actorFilter, actors);
      return result;
    };
    const board = await read("boards?metric=pr_merged");
    assert.deepEqual(
      board.rows.map((row) => row.actorId),
      ids,
    );
    assert.equal(board.totalRows, ids.length);
    assert.equal(board.rows.find((row) => row.actorId === "bob").actor.executionMode, "automated");
    assert.equal(new URL(board.shareUrl, "https://example.invalid").searchParams.get("actors"), actors);
    assert.deepEqual(
      (await read("contributors")).contributors.map((entry) => entry.actorId),
      ids,
    );
    assert.deepEqual((await read("activity")).groups.map((entry) => entry.actorId).sort(), [...ids].sort());
    assert.equal((await read("contributors/bob")).actor.executionMode, "automated");
    assert.equal((await read("evidence/e-bob")).contribution.actorId, "bob");
    assert.equal((await read("health")).snapshotId, "public-1");
    const json = await read("exports?metric=pr_merged&format=json");
    assert.deepEqual(
      json.rows.map((entry) => entry.actorId),
      ids,
    );
    assert.equal(json.evidence.length, ids.length);
    assert.equal(json.rows.find((row) => row.actorId === "bob").executionMode, "automated");
    const selected = selection(`?actors=${actors}&metric=pr_merged&snapshot=public-1`);
    assert.doesNotThrow(() => validateExport(json, selected, json.metric));
    const missingLabels = structuredClone(json);
    delete missingLabels.rows[0].actorKind;
    delete missingLabels.rows[0].executionMode;
    if (actors === "all") assert.doesNotThrow(() => validateExport(missingLabels, selected, missingLabels.metric));
    else
      assert.throws(() => validateExport(missingLabels, selected, missingLabels.metric), /api_actor_filter_mismatch/);
    const invalidKind = structuredClone(json);
    invalidKind.rows[0].actorKind = "manual";
    assert.throws(() => validateExport(invalidKind, selected, invalidKind.metric));
    const csv = await app.inject(`/api/v1/exports?metric=pr_merged&actors=${actors}&format=csv`);
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.headers["x-leaderboard-actor-filter"], actors);
    assert.ok(csv.body.split("\r\n")[0].includes('"actor_filter"'));
  }
  assert.deepEqual(data, original, "a filtered request must not mutate the stored publication");
  assert.ok(
    calls.every((call) => !Object.hasOwn(call.scope, "actors")),
    "actor selection is not a new or broader source grant",
  );
});

test("actor filtering is consistent for direct proof, card, activity and historical privacy routes", async (t) => {
  const { app, data } = harness(t, mixedActors());
  for (const path of [
    "contributors/carol",
    "evidence/e-carol",
    "cards/carol?metric=pr_merged",
    "cards/carol/image?metric=pr_merged",
  ]) {
    const response = await app.inject(`/api/v1/${path}${path.includes("?") ? "&" : "?"}actors=user&snapshot=public-1`);
    assert.equal(response.statusCode, 404, path);
  }
  const all = (await app.inject("/api/v1/activity")).json();
  const carol = all.groups.find((entry) => entry.actorId === "carol");
  assert.equal((await app.inject(`/api/v1/activity/${carol.groupId}?actors=user`)).statusCode, 404);
  const allowedCard = await app.inject("/api/v1/cards/bob?metric=pr_merged&actors=automation");
  assert.equal(allowedCard.statusCode, 200);
  assert.match(allowedCard.body, /actors=automation/);
  assert.match(allowedCard.body, /Activity selection<\/dt><dd>Automation/);
  data.controls.suppressedActorIds = ["bob"];
  data.controls.version = "privacy-2";
  const board = (await app.inject("/api/v1/boards?metric=pr_merged&actors=automation&snapshot=public-1")).json();
  assert.deepEqual(
    board.rows.map((row) => row.actorId),
    ["carol"],
  );
  assert.equal(board.rows[0].rank, 1);
  assert.equal((await app.inject("/api/v1/evidence/e-bob?actors=automation&snapshot=public-1")).statusCode, 404);
});

test("actor selection is bound into every paginated endpoint and rejected before source reads when invalid", async (t) => {
  const { app, calls } = harness(t, mixedActors());
  for (const path of ["boards?metric=pr_merged", "contributors", "activity"]) {
    const url = `/api/v1/${path}${path.includes("?") ? "&" : "?"}limit=1`;
    const first = (await app.inject(`${url}&actors=user`)).json();
    assert.ok(first.nextCursor);
    const cursor = encodeURIComponent(first.nextCursor);
    assert.equal((await app.inject(`${url}&actors=user&cursor=${cursor}`)).statusCode, 200);
    const mismatch = await app.inject(`${url}&actors=automation&cursor=${cursor}`);
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json().error, "cursor_scope_mismatch");
  }
  const count = calls.length;
  for (const suffix of ["actors=", "actors=human", "actors=manual", "actors=ai", "actors=user&actors=all"])
    assert.equal((await app.inject(`/api/v1/boards?metric=pr_merged&${suffix}`)).statusCode, 400);
  assert.equal(calls.length, count);
});

test("actor-filter stream receipts and polling retain the selected view", async (t) => {
  const { app } = harness(t, mixedActors());
  const response = await app.inject("/api/v1/updates?actors=automation");
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /id: 1:public-1:policy-1:automation/);
  const payload = JSON.parse(response.body.split("data: ")[1].trim());
  assert.equal(payload.actorFilter, "automation");
  assert.equal(new URL(payload.pollingUrl, "https://example.invalid").searchParams.get("actors"), "automation");
  const changed = await app.inject({
    url: "/api/v1/updates?actors=user",
    headers: { "last-event-id": "1:public-1:policy-1:automation" },
  });
  assert.match(changed.body, /event: reset/);
});
const boardUrl = "/api/v1/boards?metric=pr_merged";

test("anonymous public board, complete metric discovery and snapshot metadata", async (t) => {
  const { app, calls } = harness(t);
  const catalog = await app.inject("/api/v1/metrics");
  assert.equal(catalog.json().metrics.length, 98);
  const result = await app.inject(boardUrl);
  assert.equal(result.statusCode, 200, result.body);
  const body = result.json();
  assert.equal(body.snapshotId, "public-1");
  assert.equal(body.policyVersion, "policy-1");
  assert.deepEqual(
    body.rows.map((row) => [row.actorId, row.rank]),
    [
      ["alice", 1],
      ["bob", 1],
      ["carol", 2],
    ],
  );
  assert.equal(body.metric.id, "pr_merged");
  assert.equal(body.ranking.direction, "descending");
  assert.equal(calls.length, 1);
  assert.equal(result.headers["cache-control"], "public, max-age=0, must-revalidate");
});

test("stable cursor pages pin old snapshot after head advances and bind scope", async (t) => {
  const h = harness(t);
  const first = (await h.app.inject(`${boardUrl}&limit=1`)).json();
  const next = fixture("public-2", 2);
  next.selected.rows.reverse();
  next.selected.rows[0].result.value = 99;
  h.set(next);
  const second = await h.app.inject(`${boardUrl}&limit=1&cursor=${first.nextCursor}`);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().snapshotId, "public-1");
  assert.equal(second.json().head.snapshotId, "public-2");
  assert.equal(second.json().rows[0].actorId, "bob");
  const third = (await h.app.inject(`${boardUrl}&limit=1&cursor=${second.json().nextCursor}`)).json();
  assert.equal(third.rows[0].actorId, "carol");
  assert.equal(third.nextCursor, null);
  assert.equal((await h.app.inject(`${boardUrl}&limit=2&cursor=${first.nextCursor}`)).statusCode, 400);
  assert.equal(
    (await h.app.inject(`${boardUrl}&limit=1&repository=repo-1&cursor=${first.nextCursor}`)).statusCode,
    400,
  );
  assert.equal((await h.app.inject(`${boardUrl}&limit=1&cursor=${first.nextCursor}x`)).statusCode, 410);
});

test("cursor expiry, missing snapshot and current policy change force full refetch", async (t) => {
  let now = Date.parse(at);
  const h = harness(t, fixture(), { now: () => now });
  const first = (await h.app.inject(`${boardUrl}&limit=1`)).json();
  now += 16 * 60 * 1000;
  assert.equal((await h.app.inject(`${boardUrl}&limit=1&cursor=${first.nextCursor}`)).statusCode, 410);
  now = Date.parse(at);
  h.data.controls.version = "policy-2";
  assert.equal(
    (await h.app.inject(`${boardUrl}&limit=1&cursor=${first.nextCursor}`)).json().error,
    "cursor_policy_changed_refetch",
  );
  h.expire("public-1");
  assert.equal((await h.app.inject(`${boardUrl}&snapshot=public-1`)).statusCode, 410);
});

test("canonical query order supports conditional responses, exports preserve exact board totals", async (t) => {
  const { app } = harness(t);
  const first = await app.inject(`${boardUrl}&limit=100`);
  const repeated = await app.inject({
    url: "/api/v1/boards?limit=100&metric=pr_merged",
    headers: { "if-none-match": first.headers.etag },
  });
  assert.equal(repeated.statusCode, 304);
  const exported = await app.inject("/api/v1/exports?metric=pr_merged&limit=100");
  assert.equal(exported.json().snapshotId, first.json().snapshotId);
  assert.deepEqual(exported.json().scope, first.json().scope);
  assert.deepEqual(
    exported.json().rows.map(({ actorId, rank, result, evidenceIds }) => ({ actorId, rank, result, evidenceIds })),
    first.json().rows.map(({ actorId, rank, result, evidenceIds }) => ({ actorId, rank, result, evidenceIds })),
  );
  const shared = await app.inject(first.json().shareUrl);
  assert.deepEqual(shared.json().rows, first.json().rows);
});

test("profile and evidence reconcile with the same pinned snapshot and retain eligibility/provenance", async (t) => {
  const { app } = harness(t);
  const board = (await app.inject(boardUrl)).json();
  const profile = (await app.inject("/api/v1/contributors/alice?snapshot=public-1")).json();
  assert.equal(profile.snapshotId, board.snapshotId);
  assert.deepEqual(profile.results[0], board.rows[0].result);
  assert.deepEqual(profile.roleBreakdown, [{ role: "author", contributions: 1 }]);
  const detail = (await app.inject("/api/v1/evidence/e-alice?snapshot=public-1")).json();
  assert.equal(detail.contribution.qualification, "eligible");
  assert.equal(detail.artifact.publicUrl, "https://github.com/synthetic/example/pull/1");
  assert.equal(detail.sourceRevisionUrl, "https://github.com/synthetic/example/commit/abcdef");
  assert.deepEqual(profile.timeline[0].contribution, detail.contribution);
});

test("public projection omits private, unknown, unsafe URLs, unlinked and suppressed evidence on all paths", async (t) => {
  const h = harness(t);
  const initial = await h.app.inject(boardUrl);
  h.data.controls.version = "policy-2";
  h.data.controls.suppressedActorIds = ["alice"];
  h.data.selected.evidence[1].artifact.visibility = "private";
  delete h.data.selected.evidence[1].artifact.publicUrl;
  h.data.selected.actors[2].state = "unlinked";
  const response = await h.app.inject({ url: boardUrl, headers: { "if-none-match": initial.headers.etag } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().rows, []);
  assert.equal((await h.app.inject("/api/v1/contributors/alice")).statusCode, 404);
  assert.equal((await h.app.inject("/api/v1/contributors/carol")).statusCode, 404);
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice")).statusCode, 404);
  assert.equal((await h.app.inject("/api/v1/evidence/e-bob")).statusCode, 404);
  assert.deepEqual((await h.app.inject("/api/v1/exports?metric=pr_merged&snapshot=public-1")).json().rows, []);
  assert.doesNotMatch((await h.app.inject("/api/v1/exports?metric=pr_merged&format=csv")).body, /alice|bob|carol/);
});

test("artifact correction suppresses dependent aggregates without corrupting other totals", async (t) => {
  const h = harness(t);
  h.data.controls.suppressedArtifactIds = ["pr-0"];
  const board = (await h.app.inject(boardUrl)).json();
  assert.deepEqual(
    board.rows.map((row) => row.actorId),
    ["bob", "carol"],
  );
  assert.equal((await h.app.inject("/api/v1/contributors/alice")).json().results.length, 0);
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice")).statusCode, 404);
  h.data.controls.revokedSnapshotIds = ["public-1"];
  assert.equal((await h.app.inject(`${boardUrl}&snapshot=public-1`)).json().error, "snapshot_revoked_refetch");
});

test("health sanitizes operational failures and preserves unknown lag", async (t) => {
  const h = harness(t);
  const clean = (await h.app.inject("/api/v1/health")).json();
  assert.equal(clean.status, "recently_reconciled");
  assert.equal(clean.sources[0].webhookLagSeconds, null);
  h.data.selected.snapshot.coverage[0] = {
    ...coverage,
    state: "partial",
    permissionsMissing: ["admin-private-capability"],
    sourceErrors: ["token SECRET internal-host:5432 stack trace"],
    lastSuccessfulSync: "2026-10-01T00:00:00.000Z",
  };
  const degraded = await h.app.inject("/api/v1/health");
  assert.equal(degraded.json().status, "stale_or_degraded");
  assert.equal(degraded.json().sources[0].collectionState, "degraded");
  assert.doesNotMatch(degraded.body, /SECRET|internal-host|admin-private|stack trace/);
});

test("current repository health overrides fresh status without rewriting frozen coverage or publication", async (t) => {
  const h = harness(t);
  const current = {
    scopeId: coverage.scopeId,
    state: "reconciled",
    lastAttemptAt: at,
    lastSuccessfulSync: at,
    reconciledThrough: at,
    webhookLagSeconds: null,
    webhookState: "unknown",
    exception: "SECRET internal-host stack trace",
    installationId: "private-installation",
  };
  h.data.currentSourceHealth = [current];
  const first = await h.app.inject("/api/v1/health");
  assert.equal(first.json().status, "recently_reconciled");
  assert.equal(first.json().sources[0].currentCollection.scope, "repository");
  assert.doesNotMatch(first.body, /SECRET|internal-host|exception|installationId|private-installation/);
  for (const change of [
    { state: "degraded" },
    { state: "collecting" },
    { state: "unknown" },
    { webhookLagSeconds: 301, webhookState: "pending" },
    { webhookLagSeconds: 1, webhookState: "degraded" },
    { lastSuccessfulSync: "2026-10-17T11:00:00.000Z" },
    { lastSuccessfulSync: "2026-10-17T12:01:00.000Z" },
    { reconciledThrough: "2026-10-17T11:00:00.000Z" },
    { reconciledThrough: null },
  ]) {
    h.data.currentSourceHealth = [{ ...current, ...change }];
    const result = await h.app.inject({
      url: "/api/v1/health?snapshot=public-1",
      headers: { "if-none-match": first.headers.etag },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, "stale_or_degraded");
    assert.deepEqual(result.json().coverage, first.json().coverage);
    assert.deepEqual(result.json().lastSuccessfulPublish, first.json().lastSuccessfulPublish);
    assert.equal(result.json().sources[0].state, "complete");
    assert.equal(result.json().sources[0].lastSuccessfulSync, at);
  }
  h.data.currentSourceHealth = [
    { ...current, state: "no_activity_in_window", webhookLagSeconds: 0, webhookState: "idle" },
  ];
  assert.equal((await h.app.inject("/api/v1/health")).json().status, "recently_reconciled");
  h.data.selected.snapshot.coverage[0].state = "partial";
  assert.equal((await h.app.inject("/api/v1/health")).json().status, "stale_or_degraded");
});

test("current health rejects unbound scopes, malformed clocks, unbounded lag and duplicate sources", async (t) => {
  const h = harness(t);
  const current = {
    scopeId: coverage.scopeId,
    state: "unknown",
    lastAttemptAt: null,
    lastSuccessfulSync: null,
    reconciledThrough: null,
    webhookLagSeconds: null,
    webhookState: "unknown",
  };
  for (const change of [
    { scopeId: "private-repository" },
    { state: "SECRET" },
    { lastAttemptAt: "SECRET" },
    { lastSuccessfulSync: undefined },
    { webhookLagSeconds: -1 },
    { webhookLagSeconds: Infinity },
    { webhookLagSeconds: 1.5 },
    { webhookLagSeconds: 0 },
    { webhookState: "SECRET" },
  ]) {
    h.data.currentSourceHealth = [{ ...current, ...change }];
    const result = await h.app.inject("/api/v1/health");
    assert.equal(result.statusCode, 503, JSON.stringify(change));
    assert.doesNotMatch(result.body, /SECRET|private-repository/);
  }
  h.data.currentSourceHealth = [current, current];
  assert.equal((await h.app.inject("/api/v1/health")).statusCode, 503);
  h.data.currentSourceHealth = Array(101).fill(current);
  assert.equal((await h.app.inject("/api/v1/health")).statusCode, 503);
});

test("optional health reads retain the normal source boundary and leave ordinary reads unchanged", async (t) => {
  let reads = 0,
    healthReads = 0;
  const source = {
    async read() {
      reads++;
      return fixture();
    },
    async readHealth(_scope, _pin, signal) {
      healthReads++;
      assert.equal(signal.aborted, false);
      throw new Error("SECRET health storage failure");
    },
  };
  const app = createService({ source, now: () => Date.parse(at) });
  t.after(() => app.close());
  assert.equal((await app.inject(boardUrl)).statusCode, 200);
  const response = await app.inject("/api/v1/health");
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /SECRET|storage/);
  assert.equal(reads, 1);
  assert.equal(healthReads, 1);
  source.readHealth = async () => {
    healthReads++;
    const data = fixture();
    data.controls.revokedSnapshotIds = ["public-1"];
    return data;
  };
  assert.equal((await app.inject("/api/v1/health")).statusCode, 410);
});

test("missing sources and exceptions fail closed without secrets or fabricated zero/live data", async (t) => {
  const none = createService();
  t.after(() => none.close());
  assert.equal((await none.inject(boardUrl)).statusCode, 503);
  assert.equal((await none.inject("/api/v1/health")).statusCode, 503);
  const broken = createService({
    source: {
      async read() {
        throw new Error("SECRET_TOKEN private-db");
      },
    },
  });
  t.after(() => broken.close());
  const failure = await broken.inject(boardUrl);
  assert.equal(failure.statusCode, 503);
  assert.doesNotMatch(failure.body, /SECRET|private-db/);
});

test("invalid and costly queries are rejected before source I/O", async (t) => {
  const { app, calls } = harness(t);
  for (const url of [
    "/api/v1/boards",
    `${boardUrl}&limit=101`,
    `${boardUrl}&metric=pr_merged`,
    `${boardUrl}&unknown=private`,
    "/api/v1/boards?metric=does-not-exist",
    `${boardUrl}&start=2026-02-30T00:00:00.000Z&end=2026-03-02T00:00:00.000Z`,
    `${boardUrl}&start=2025-01-01T00:00:00.000Z&end=2026-10-17T00:00:00.000Z`,
    "/api/v1/exports?metric=pr_merged&format=markdown",
    `${boardUrl}&cursor=bad`,
  ]) {
    assert.equal((await app.inject(url)).statusCode, 400, url);
  }
  assert.equal((await app.inject(`${boardUrl}&repository=${"a".repeat(5000)}`)).statusCode, 414);
  assert.equal(calls.length, 0);
});

test("resource budgets time out and do not release slots for a noncooperative source", async (t) => {
  const app = createService({
    sourceTimeoutMs: 10,
    maxConcurrentReads: 1,
    source: { read: () => new Promise(() => {}) },
  });
  t.after(() => app.close());
  const timeout = await app.inject(boardUrl);
  assert.equal(timeout.statusCode, 503);
  assert.equal(timeout.json().error, "snapshot_source_timeout");
  assert.equal((await app.inject(boardUrl)).statusCode, 429);
});

test("provider scope mismatch, invalid schema and excessive rows never publish", async (t) => {
  const h = harness(t);
  assert.equal((await h.app.inject(`${boardUrl}&repository=other-repo`)).statusCode, 503);
  h.data.selected.rows = Array.from({ length: 10001 }, () => h.data.selected.rows[0]);
  assert.equal((await h.app.inject(boardUrl)).statusCode, 503);
});

test("CSV escapes formulas, quotes, newlines and includes metric, dates, source and snapshot", async (t) => {
  const h = harness(t);
  h.data.selected.actors[0].actor.login = ' =HYPERLINK("evil")\nmore';
  const csv = await h.app.inject("/api/v1/exports?metric=pr_merged&format=csv");
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers["content-type"], /^text\/csv/);
  assert.match(csv.body, /"'=HYPERLINK\(""evil""\)\nmore"/);
  assert.match(csv.body, /public-1/);
  assert.match(csv.body, /https:\/\/github.com\/synthetic\/example\/pull\/1/);
  assert.match(csv.body, /one per merged PR in window/);
});

test("SSE reconnect after missed notices resets to current snapshot; unchanged cursor gets heartbeat", async (t) => {
  const h = harness(t);
  const initial = await h.app.inject("/api/v1/updates");
  assert.match(initial.headers["content-type"], /^text\/event-stream/);
  assert.match(initial.body, /event: snapshot/);
  const id = initial.body.match(/id: (.+)/)[1];
  const unchanged = await h.app.inject({ url: "/api/v1/updates", headers: { "last-event-id": id } });
  assert.match(unchanged.body, /heartbeat/);
  h.set(fixture("public-8", 8));
  const reset = await h.app.inject({ url: "/api/v1/updates", headers: { "last-event-id": id } });
  assert.match(reset.body, /event: reset/);
  assert.match(reset.body, /"snapshotId":"public-8"/);
  assert.match(reset.body, /"action":"refetch_snapshot"/);
  h.data.controls.version = "policy-9";
  h.set(h.data);
  const controlReset = await h.app.inject({ url: "/api/v1/updates", headers: { "last-event-id": id } });
  assert.match(controlReset.body, /policy-9/);
});

test("conditional polling helper pauses when hidden, resumes and reports actual stale freshness", async (t) => {
  const listeners = new Map();
  const document = {
    hidden: false,
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  let calls = 0;
  const states = [],
    notices = [];
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const stop = startLiveUpdates({
    document,
    intervalMs: 50,
    onState: (value) => states.push(value),
    onSnapshot: (value) => notices.push(value),
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.credentials, "omit");
      if (calls === 1) {
        resolveFirst();
        return new Response(
          JSON.stringify({
            snapshotId: "public-1",
            revision: 1,
            policyVersion: "policy-1",
            status: "stale_or_degraded",
          }),
          { headers: { ETag: '"one"' } },
        );
      }
      assert.equal(init.headers["If-None-Match"], '"one"');
      return new Response(null, { status: 304 });
    },
  });
  t.after(stop);
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.at(-1).freshness, "stale_or_degraded");
  assert.equal(notices.length, 1);
  document.hidden = true;
  listeners.get("visibilitychange")();
  const pausedCalls = calls;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, pausedCalls);
  assert.equal(states.at(-1).transport, "paused");
  document.hidden = false;
  listeners.get("visibilitychange")();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, pausedCalls + 1);
  assert.equal(notices.length, 1);
  assert.equal(
    states.at(-1).freshness,
    "stale_or_degraded",
    "304 restores the last verified health state after visibility pause",
  );
});

test("polling errors cannot report fake live freshness", async (t) => {
  const states = [];
  const stop = startLiveUpdates({
    intervalMs: 50,
    onState: (value) => states.push(value),
    onSnapshot() {
      assert.fail("no snapshot on outage");
    },
    fetch: async () => new Response("unavailable", { status: 503 }),
  });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.at(-1).transport, "unavailable");
  assert.equal(states.at(-1).freshness, "unknown");
});

test("unsafe public URLs, unknown evidence, attribution mismatch and deleted actors fail closed", async (t) => {
  const h = harness(t);
  h.data.selected.evidence[0].artifact.publicUrl = "https://github.com@evil.invalid/private";
  h.data.selected.evidence[1].contribution.qualification = "unknown";
  h.data.selected.actors[2].actor.identityState = "deleted";
  const response = await h.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().rows.length, 0);
  for (const actor of ["alice", "bob", "carol"]) {
    assert.equal((await h.app.inject(`/api/v1/evidence/e-${actor}`)).statusCode, 404);
  }
});

test("approved sort direction handles unknown separately and method version mismatch cannot mislabel data", async (t) => {
  const h = harness(t);
  h.data.selected.ranking[0].direction = "ascending";
  h.data.selected.rows[1].result.state = "unknown";
  delete h.data.selected.rows[1].result.value;
  const body = (await h.app.inject(boardUrl)).json();
  assert.deepEqual(
    body.rows.map((row) => [row.actorId, row.rank]),
    [
      ["carol", 1],
      ["alice", 2],
      ["bob", null],
    ],
  );
  assert.equal(body.rows[2].result.value, undefined);
  h.data.selected.snapshot.metricDefinitionVersion = "candidate-0.1.0";
  // The prior daily-unit candidate cannot be relabeled with the corrected registry.
  assert.equal((await h.app.inject(boardUrl)).json().error, "metric_definition_unavailable");
});

test("exact filtered scope is passed once to provider; CSV and share URL preserve that scope", async (t) => {
  const h = harness(t);
  const filtered = {
    ...scope,
    repository: "repo-1",
    workstream: "delivery",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
  };
  h.data.selected.scope = filtered;
  const params = new URLSearchParams({ ...filtered, metric: "pr_merged" });
  const board = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(board.statusCode, 200, board.body);
  assert.deepEqual(h.calls[0].scope, filtered);
  assert.deepEqual((await h.app.inject(board.json().shareUrl)).json().rows, board.json().rows);
  params.set("format", "csv");
  const csv = await h.app.inject(`/api/v1/exports?${params}`);
  assert.match(csv.body, /repo-1/);
  assert.match(csv.body, /delivery/);
  assert.match(csv.body, /2026-10-01T00:00:00.000Z/);
});

test("stream failure falls back to polling and missed notices request a current refetch", async (t) => {
  const events = new Map();
  let connection,
    fetches = 0;
  const states = [],
    notices = [];
  const stop = startLiveUpdates({
    intervalMs: 50,
    onState: (value) => states.push(value),
    onSnapshot: (value) => notices.push(value),
    eventSource: () => {
      connection = {
        close() {},
        addEventListener(name, listener) {
          events.set(name, listener);
        },
        onopen: null,
        onerror: null,
      };
      return connection;
    },
    fetch: async () => {
      fetches++;
      return new Response(
        JSON.stringify({ snapshotId: "public-1", revision: 1, policyVersion: "policy-1", status: "stale_or_degraded" }),
      );
    },
  });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 10));
  connection.onopen();
  assert.equal(states.at(-1).transport, "stream");
  events.get("reset")({ data: JSON.stringify({ snapshotId: "public-8", revision: 8, policyVersion: "policy-8" }) });
  assert.equal(notices.at(-1).revision, 8);
  connection.onerror();
  assert.equal(states.at(-1).transport, "polling");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(fetches >= 2);
  assert.equal(notices.length, 2, "out-of-order old polling response cannot undo newer stream notice");
});

test("approved descriptive-only metrics publish facts with no implied ranking", async (t) => {
  const h = harness(t, fixture("public-1", 1, "pr_opened"));
  h.data.selected.ranking[0].rank = false;
  h.data.selected.rows[2].result.value = 100;
  const body = (await h.app.inject("/api/v1/boards?metric=pr_opened")).json();
  assert.equal(body.ranking.rank, false);
  assert.deepEqual(
    body.rows.map((row) => [row.actorId, row.rank]),
    [
      ["alice", null],
      ["bob", null],
      ["carol", null],
    ],
  );
  assert.equal(body.rows[2].result.value, 100);
});

test("public source URLs reject alternate ports and unapproved fragments but retain exact public review anchors", async (t) => {
  const h = harness(t);
  h.data.selected.evidence[0].artifact.publicUrl = "https://github.com:8443/synthetic/example/pull/1";
  h.data.selected.evidence[1].artifact.publicUrl = "https://github.com/synthetic/example/pull/2#private-token";
  h.data.selected.evidence[2].artifact.publicUrl = "https://github.com/synthetic/example/pull/3#pullrequestreview-123";
  const body = (await h.app.inject(boardUrl)).json();
  assert.deepEqual(
    body.rows.map((row) => row.actorId),
    ["carol"],
  );
  const detail = (await h.app.inject("/api/v1/evidence/e-carol")).json();
  assert.match(detail.artifact.publicUrl, /#pullrequestreview-123$/);
});

test("malformed live identifiers never trigger snapshot replacement", async (t) => {
  const states = [];
  const stop = startLiveUpdates({
    intervalMs: 50,
    onState: (value) => states.push(value),
    onSnapshot() {
      assert.fail("missing identifiers must not be accepted");
    },
    fetch: async () => new Response(JSON.stringify({ revision: 2, status: "recently_reconciled" })),
  });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.at(-1).freshness, "unknown");
  assert.equal(states.at(-1).transport, "unavailable");
});

test("disabled policy overlay explains unavailable metrics and removes pinned evidence/profile totals", async (t) => {
  const h = harness(t);
  h.data.selected.disabledMetrics = [
    {
      id: "pr_merged",
      reason: "policy_withdrawn",
      policyVersion: "review-v2",
      policyLink: "https://github.com/synthetic/example/blob/main/policy.md",
    },
  ];
  h.data.selected.methodology = [
    { metricId: "pr_merged", policyVersion: "review-v1", policySignature: "a".repeat(64), policyLink: null },
  ];
  const response = await h.app.inject(`${boardUrl}&snapshot=public-1`);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "metric_disabled");
  assert.equal(response.json().metric.reason, "policy_withdrawn");
  assert.equal((await h.app.inject("/api/v1/exports?metric=pr_merged&format=csv&snapshot=public-1")).statusCode, 503);
  assert.deepEqual((await h.app.inject("/api/v1/contributors/alice?snapshot=public-1")).json().results, []);
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice?snapshot=public-1")).statusCode, 404);
  const health = (await h.app.inject("/api/v1/health")).json();
  assert.equal(health.disabledMetrics[0].id, "pr_merged");
  assert.equal(health.methodology[0].policySignature, "a".repeat(64));
});

test("public evidence times use the frozen source timestamp contract and reject impossible dates", async (t) => {
  const h = harness(t);
  h.data.selected.evidence[0].occurredAt = "2026-02-30T00:00:00.000Z";
  const response = await h.app.inject(boardUrl);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "public_projection_unavailable");
});

test("diagnostic denominators/samples stay bound to visible selected rows and retain null unknowns", async (t) => {
  const h = harness(t);
  h.data.selected.diagnostics = ["alice", "bob", "carol"].map((actorId) => ({
    metricId: "pr_merged",
    actorId,
    numerator: 2,
    denominator: 3,
    sampleCount: 3,
    censored: 1,
    missingReadiness: 0,
    p75: null,
  }));
  const page = (await h.app.inject(`${boardUrl}&limit=1`)).json();
  assert.equal(page.diagnostics.length, 1);
  assert.equal(page.diagnostics[0].actorId, "alice");
  assert.equal(page.diagnostics[0].denominator, 3);
  assert.equal(page.diagnostics[0].p75, null);
  const profile = (await h.app.inject("/api/v1/contributors/bob")).json();
  assert.equal(profile.diagnostics.length, 1);
  assert.equal(profile.diagnostics[0].actorId, "bob");
  const exported = await h.app.inject("/api/v1/exports?metric=pr_merged&format=csv&limit=1");
  assert.match(exported.body, /"numerator","denominator","sample_count","censored","missing_readiness","p75"/);
  assert.match(exported.body, /"2","3","3","1","0","","","\[\]"\r\n/);
  h.data.controls.suppressedActorIds = ["alice"];
  assert.ok((await h.app.inject(boardUrl)).json().diagnostics.every((entry) => entry.actorId !== "alice"));
  h.data.selected.diagnostics[0].sampleCount = -1;
  assert.equal((await h.app.inject(boardUrl)).statusCode, 503);
});

function withPortfolio(data = fixture()) {
  data.selected.portfolioEvidence = data.selected.evidence.map((entry) => ({
    ...structuredClone(entry),
    activityState: "observed",
    observedAt: at,
  }));
  return data;
}

function withLocalization() {
  const data = fixture();
  data.selected.ranking = [{ metricId: "localization", direction: "descending", rank: false }];
  for (const row of data.selected.rows) row.result.metricId = "localization";
  for (const entry of data.selected.evidence) {
    entry.contribution.metricIds = ["localization"];
    entry.contribution.reasonCodes = [
      "documentation_path_policy:synthetic-locales-v1",
      "locale:fr",
      "localization_category:documentation",
    ];
  }
  return withPortfolio(data);
}

test("locale proof retains explicit labels in public views and rejects conflicting copies", async (t) => {
  const h = harness(t, withLocalization());
  h.data.selected.portfolioEvidence[0].contribution.reasonCodes.push("private reviewer context SECRET");
  const proof = await h.app.inject("/api/v1/evidence/e-alice");
  assert.equal(proof.statusCode, 200, proof.body);
  assert.deepEqual(
    proof.json().contribution.reasonCodes.filter((reason) => !reason.startsWith("public_")),
    ["documentation_path_policy:synthetic-locales-v1", "locale:fr", "localization_category:documentation"],
  );
  const profile = await h.app.inject("/api/v1/contributors/alice");
  assert.equal(profile.statusCode, 200, profile.body);
  assert.doesNotMatch(proof.body + profile.body, /SECRET/);
  h.data.selected.portfolioEvidence[0].contribution.reasonCodes[1] = "locale:de";
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice")).statusCode, 503);
  assert.equal((await h.app.inject("/api/v1/boards?metric=localization")).statusCode, 503);
  h.data.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_observed_work"];
  assert.equal((await h.app.inject("/api/v1/contributors/alice")).statusCode, 503);
});

test("primary-only locale proof cannot expose internal reason strings", async (t) => {
  const data = withLocalization();
  delete data.selected.portfolioEvidence;
  data.selected.evidence[0].contribution.reasonCodes.push("private reviewer context SECRET email@example.invalid");
  const { app } = harness(t, data);
  for (const path of ["evidence/e-alice", "contributors/alice", "boards?metric=localization"]) {
    const response = await app.inject(`/api/v1/${path}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /SECRET|email@example/);
  }
  assert.ok((await app.inject("/api/v1/evidence/e-alice")).json().contribution.reasonCodes.includes("locale:fr"));
});

test("malformed locale proof fails closed while historical documentation without portfolio labels remains readable", async (t) => {
  const h = harness(t, withLocalization());
  for (const entry of [h.data.selected.evidence[0], h.data.selected.portfolioEvidence[0]])
    entry.contribution.reasonCodes[1] = "locale:und";
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice")).statusCode, 503);
  const data = fixture();
  data.selected.ranking = [{ metricId: "documentation", direction: "descending", rank: false }];
  for (const row of data.selected.rows) row.result.metricId = "documentation";
  for (const entry of data.selected.evidence) {
    entry.contribution.metricIds = ["documentation"];
    entry.contribution.reasonCodes = ["documentation_path_policy:synthetic-historical-v1"];
  }
  withPortfolio(data);
  for (const entry of data.selected.portfolioEvidence) entry.contribution.reasonCodes = ["public_observed_work"];
  h.set(data);
  assert.equal((await h.app.inject("/api/v1/contributors/alice")).statusCode, 200);
  const detail = await h.app.inject("/api/v1/evidence/e-alice");
  assert.equal(detail.statusCode, 200, detail.body);
  assert.doesNotMatch(detail.body, /locale:|localization_category:/);
});

test("documentation proof rejects conflicting present classifications while retaining legacy absent labels", async (t) => {
  const documentationCopies = () => {
    const data = fixture();
    data.selected.ranking = [{ metricId: "documentation", direction: "descending", rank: false }];
    for (const row of data.selected.rows) row.result.metricId = "documentation";
    for (const entry of data.selected.evidence) {
      entry.contribution.metricIds = ["documentation"];
      entry.contribution.reasonCodes = ["documentation_path_policy:synthetic-docs-v1"];
    }
    return withPortfolio(data);
  };
  const h = harness(t, documentationCopies());
  for (const path of ["boards?metric=documentation", "evidence/e-alice", "contributors/alice"])
    assert.equal(
      (await h.app.inject(`/api/v1/${path}`)).statusCode,
      200,
      "Matching nonempty classifications remain readable",
    );
  h.data.selected.portfolioEvidence[0].contribution.reasonCodes = ["documentation_path_policy:synthetic-docs-v2"];
  for (const path of ["boards?metric=documentation", "evidence/e-alice", "contributors/alice"])
    assert.equal(
      (await h.app.inject(`/api/v1/${path}`)).statusCode,
      503,
      "One contribution cannot carry contradictory policy proof",
    );
  for (const missing of ["evidence", "portfolioEvidence"]) {
    const legacy = documentationCopies();
    legacy.selected[missing][0].contribution.reasonCodes = ["public_observed_work"];
    h.set(legacy);
    assert.equal(
      (await h.app.inject("/api/v1/evidence/e-alice")).statusCode,
      200,
      "Absent historical labels do not invent a conflicting classification",
    );
  }
  const separated = documentationCopies();
  separated.selected.portfolioEvidence[0].contribution.reasonCodes = ["public_observed_work"];
  separated.selected.pendingEvidence = [
    {
      ...structuredClone(separated.selected.evidence[0]),
      activityState: "pending",
      observedAt: at,
    },
  ];
  separated.selected.pendingEvidence[0].contribution.reasonCodes = ["documentation_path_policy:synthetic-docs-v2"];
  h.set(separated);
  assert.equal(
    (await h.app.inject("/api/v1/boards?metric=documentation")).statusCode,
    503,
    "An intervening legacy copy cannot erase the earlier nonempty classification",
  );
});

test("directory includes observed-only public contributors without ranking, membership or identity leakage", async (t) => {
  const h = harness(t, withPortfolio());
  h.data.selected.rows = [];
  h.data.selected.evidence = [];
  h.data.selected.actors.push({
    ...structuredClone(h.data.selected.actors[0]),
    actorId: "assigned-only",
    actor: { ...h.data.selected.actors[0].actor, login: "assigned-only" },
  });
  h.data.selected.actors[1].state = "hidden";
  h.data.selected.actors[2].state = "deleted";
  h.data.selected.portfolioEvidence[0].contribution.reasonCodes = ["private request SECRET email@example.invalid"];
  const response = await h.app.inject("/api/v1/contributors");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().contributors.map((entry) => entry.actorId),
    ["alice"],
  );
  assert.deepEqual(response.json().contributors[0].categories, [
    { metricId: "pr_merged", observed: 1, pending: 0, accepted: 0, unknown: 0 },
  ]);
  for (const search of ["bob", "carol", "assigned-only"])
    assert.deepEqual((await h.app.inject(`/api/v1/contributors?search=${search}`)).json().contributors, []);
  const profile = await h.app.inject("/api/v1/contributors/alice");
  assert.deepEqual(profile.json().results, []);
  assert.equal(profile.json().timeline[0].activityState, "observed");
  const detail = await h.app.inject("/api/v1/evidence/e-alice");
  assert.equal(detail.statusCode, 200);
  assert.doesNotMatch(response.body + profile.body + detail.body, /SECRET|email@example|assigned-only|bob|carol/);
  assert.equal((await h.app.inject("/api/v1/contributors?search=ALICE")).json().contributors.length, 1);
});

test("directory cursors bind search, category, scope, size, route and current controls; same-page replay is stable", async (t) => {
  const h = harness(t, withPortfolio());
  const first = (await h.app.inject("/api/v1/contributors?limit=1")).json();
  const url = `/api/v1/contributors?limit=1&cursor=${first.nextCursor}`;
  const second = await h.app.inject(url);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().contributors[0].actorId, "bob");
  assert.equal((await h.app.inject(url)).body, second.body);
  for (const change of ["&search=a", "&category=pr_merged", "&repository=repo-1", "&snapshot=other"])
    assert.equal((await h.app.inject(url + change)).json().error, "cursor_scope_mismatch");
  assert.equal((await h.app.inject(url.replace("limit=1", "limit=2"))).statusCode, 400);
  assert.equal((await h.app.inject(`/api/v1/contributors/alice?limit=1&cursor=${first.nextCursor}`)).statusCode, 400);
  assert.equal((await h.app.inject(`${boardUrl}&limit=1&cursor=${first.nextCursor}`)).statusCode, 400);
  h.data.controls.version = "privacy-next";
  h.data.controls.suppressedActorIds = ["alice"];
  assert.equal((await h.app.inject(url)).json().error, "cursor_policy_changed_refetch");
  assert.deepEqual((await h.app.inject("/api/v1/contributors?search=alice&snapshot=public-1")).json().contributors, []);
});

test("profile traverses more than 100 equal-time records without loss and reconciles overlapping category totals", async (t) => {
  const data = withPortfolio();
  const first = data.selected.portfolioEvidence[0];
  data.selected.ranking.push({ metricId: "documentation", direction: "descending", rank: false });
  data.selected.portfolioEvidence = Array.from({ length: 205 }, (_, index) => ({
    ...structuredClone(first),
    artifact: {
      ...first.artifact,
      stableId: `many-${index}`,
      publicUrl: `https://github.com/synthetic/example/pull/${index + 1}`,
    },
    contribution: {
      ...first.contribution,
      contributionId: `many-${String(index).padStart(3, "0")}`,
      artifactId: `many-${index}`,
      metricIds: ["pr_merged", "documentation"],
    },
    activityState: index % 2 ? "pending" : "observed",
  }));
  data.selected.portfolioEvidence[204].activityState = "accepted";
  const h = harness(t, data);
  const ids = [];
  let cursor = null,
    categories;
  do {
    const url = `/api/v1/contributors/alice?category=documentation&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await h.app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    categories ??= body.categories;
    assert.deepEqual(body.categories, categories);
    assert.equal(body.evidenceCount, 205);
    assert.equal(body.timeline.length <= 100, true);
    assert.equal(body.evidenceIds.length, body.timeline.length, "IDs must not bypass page bounds");
    ids.push(...body.timeline.map((item) => item.contribution.contributionId));
    cursor = body.nextCursor;
    if (cursor) {
      assert.equal(
        (await h.app.inject(`/api/v1/contributors/bob?category=documentation&limit=100&cursor=${cursor}`)).statusCode,
        400,
      );
      assert.equal((await h.app.inject(`/api/v1/contributors/alice?limit=100&cursor=${cursor}`)).statusCode, 400);
    }
  } while (cursor);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(
    categories,
    ["documentation", "pr_merged"].map((metricId) => ({
      metricId,
      observed: 102,
      pending: 102,
      accepted: 1,
      unknown: 0,
    })),
  );
  const directory = (await h.app.inject("/api/v1/contributors?category=documentation")).json();
  assert.deepEqual(directory.contributors[0].categories, categories);
});

test("portfolio evidence fails closed for unsafe source, missing attribution, unknown role, dates, disabled category and bounds", async (t) => {
  const h = harness(t, withPortfolio());
  h.data.selected.portfolioEvidence[0].artifact.publicUrl = "https://evil.invalid/public";
  h.data.selected.portfolioEvidence[1].contribution.actorId = null;
  assert.deepEqual(
    (await h.app.inject("/api/v1/contributors")).json().contributors.map((item) => item.actorId),
    ["carol"],
  );
  h.data.selected.disabledMetrics = [
    { id: "pr_merged", reason: "withdrawn", policyVersion: "policy-2", policyLink: null },
  ];
  assert.deepEqual((await h.app.inject("/api/v1/contributors")).json().contributors, []);
  h.data.selected.portfolioEvidence[2].activityState = "accepted_by_guess";
  assert.equal((await h.app.inject("/api/v1/contributors")).statusCode, 503);
  h.data.selected.portfolioEvidence[2].activityState = "observed";
  h.data.selected.portfolioEvidence[2].observedAt = "not-a-date";
  assert.equal((await h.app.inject("/api/v1/contributors")).statusCode, 503);
  h.data.selected.portfolioEvidence = Array.from({ length: 20001 }, () => h.data.selected.portfolioEvidence[0]);
  assert.equal((await h.app.inject("/api/v1/contributors")).statusCode, 503);
  const before = h.calls.length;
  for (const query of [
    "search=",
    "search=private%40example.invalid",
    "search=" + "a".repeat(40),
    "category=does-not-exist",
    "limit=101",
  ])
    assert.equal((await h.app.inject(`/api/v1/contributors?${query}`)).statusCode, 400);
  assert.equal(h.calls.length, before);
});

test("portfolio projection cannot enable an unapproved metric or retain suppressed artifacts in historic pages", async (t) => {
  const h = harness(t, withPortfolio());
  h.data.selected.portfolioEvidence[0].contribution.metricIds.push("documentation");
  let response = (await h.app.inject("/api/v1/contributors?search=alice")).json();
  assert.deepEqual(
    response.contributors[0].categories.map((item) => item.metricId),
    ["pr_merged"],
  );
  h.data.controls.suppressedArtifactIds = ["pr-0"];
  response = (await h.app.inject("/api/v1/contributors?search=alice&snapshot=public-1")).json();
  assert.deepEqual(response.contributors, []);
  assert.deepEqual((await h.app.inject("/api/v1/contributors/alice?snapshot=public-1")).json().timeline, []);
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice?snapshot=public-1")).statusCode, 404);
});

test("portfolio cursors expire and tampering cannot select arbitrary offsets", async (t) => {
  let clock = Date.parse(at);
  const h = harness(t, withPortfolio(), { now: () => clock });
  const first = (await h.app.inject("/api/v1/contributors?limit=1")).json();
  const [body, signature] = first.nextCursor.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url").toString());
  forged.offset = 2;
  const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
  assert.equal((await h.app.inject(`/api/v1/contributors?limit=1&cursor=${tampered}`)).statusCode, 410);
  clock += 900001;
  assert.equal(
    (await h.app.inject(`/api/v1/contributors?limit=1&cursor=${first.nextCursor}`)).json().error,
    "cursor_expired_refetch",
  );
});

test("legacy portfolio and detail routes also restrict categories to published policies without inventing acceptance", async (t) => {
  const h = harness(t);
  h.data.selected.evidence[0].contribution.metricIds.push("documentation");
  const directory = (await h.app.inject("/api/v1/contributors?search=alice")).json();
  assert.deepEqual(directory.contributors[0].categories, [
    { metricId: "pr_merged", observed: 0, pending: 0, accepted: 0, unknown: 1 },
  ]);
  assert.deepEqual((await h.app.inject("/api/v1/contributors?category=documentation")).json().contributors, []);
  assert.deepEqual((await h.app.inject("/api/v1/contributors/alice?category=documentation")).json().timeline, []);
  assert.deepEqual((await h.app.inject("/api/v1/evidence/e-alice")).json().contribution.metricIds, ["pr_merged"]);
});

test("service-account classification survives public projection without private review evidence", async (t) => {
  const h = harness(t);
  h.data.selected.actors[0].actor.kind = "service_account";
  h.data.selected.actors[0].serviceAccountClassification = {
    classificationId: "PRIVATE_CLASSIFICATION_ID",
    reviewerActorId: "PRIVATE_REVIEWER",
    evidenceIds: ["PRIVATE_CONFIG_EVIDENCE"],
  };
  const board = await h.app.inject(boardUrl);
  assert.equal(board.statusCode, 200, board.body);
  const serviceAccount = board.json().rows.find((row) => row.actorId === "alice");
  assert.equal(serviceAccount.actor.kind, "service_account");
  assert.equal(serviceAccount.actor.executionMode, "unknown");
  const profile = await h.app.inject("/api/v1/contributors/alice");
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().actor.kind, "service_account");
  assert.doesNotMatch(board.body + profile.body, /PRIVATE_|serviceAccountClassification|manual/);
  const automated = (await h.app.inject(`${boardUrl}&actors=automation`)).json();
  assert.deepEqual(
    automated.rows.map((row) => row.actorId),
    ["alice"],
  );
  assert.equal(automated.rows[0].actor.executionMode, "unknown");
  const users = (await h.app.inject(`${boardUrl}&actors=user`)).json();
  assert.deepEqual(
    users.rows.map((row) => row.actorId),
    ["bob", "carol"],
  );
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice?actors=user")).statusCode, 404);
  assert.equal((await h.app.inject("/api/v1/evidence/e-alice?actors=automation")).statusCode, 200);
  // A raw actor cannot accidentally serialize internal receipt fields as public profile fields.
  h.data.selected.actors[0].actor.serviceAccountClassification = h.data.selected.actors[0].serviceAccountClassification;
  assert.equal((await h.app.inject(boardUrl)).statusCode, 503);
});

test("share cards are scoped, dated, source-linked and deny external framing", async (t) => {
  const value = fixture();
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const current = await app.inject({ url: "/api/v1/cards/alice?metric=pr_merged" });
  assert.equal(current.statusCode, 200);
  assert.match(current.headers["content-type"], /text\/html/);
  assert.equal(current.headers["cache-control"], "no-store");
  assert.match(current.headers["content-security-policy"], /frame-ancestors 'self'/);
  assert.match(current.body, /Current snapshot card/);
  assert.match(current.body, /2026-10-17T12:00:00.000Z/);
  assert.match(current.body, /https:\/\/github.com\/synthetic\/example\/pull\/1/);
  assert.match(
    current.body,
    /href="\/contributors\/alice\?organization=Pick-Your-AI&amp;snapshot=public-1&amp;metric=pr_merged&amp;ui=api"/,
  );
  const pinned = await app.inject({ url: "/api/v1/cards/alice?metric=pr_merged&snapshot=public-1" });
  assert.equal(pinned.statusCode, 200);
  assert.match(pinned.body, /Archived snapshot card/);
  assert.equal((await app.inject({ url: "/api/v1/cards/alice" })).statusCode, 400);
  value.controls.suppressedActorIds.push("alice");
  const hidden = await app.inject({
    url: "/api/v1/cards/alice?metric=pr_merged&snapshot=public-1",
    headers: { "if-none-match": pinned.headers.etag },
  });
  assert.equal(hidden.statusCode, 404);
  assert.doesNotMatch(hidden.body, /alice|synthetic\/example/);
});

test("card output escapes publisher text and does not include suppressed source evidence", async (t) => {
  const value = fixture();
  value.selected.actors[0].actor.login = '<script>alert("x")</script>';
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const response = await app.inject({ url: "/api/v1/cards/alice?metric=pr_merged" });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /<script>/);
  assert.match(response.body, /&lt;script&gt;/);
  value.controls.suppressedArtifactIds.push("pr-0");
  const hidden = await app.inject({ url: "/api/v1/cards/alice?metric=pr_merged&snapshot=public-1" });
  assert.equal(hidden.statusCode, 404);
  assert.doesNotMatch(hidden.body, /synthetic\/example\/pull\/1/);
});

test("achievement rules require approval and use only dated accepted evidence within the visible scope", async (t) => {
  const value = fixture();
  value.selected.portfolioEvidence = value.selected.evidence.map((entry) => ({
    ...entry,
    activityState: "accepted",
    observedAt: at,
  }));
  value.selected.portfolioEvidence[0].contribution.roles = ["reviewer", "coauthor"];
  value.selected.snapshot.coverage[0].knownStart = value.selected.snapshot.coverage[0].windowStart;
  const source = { read: async () => structuredClone(value) };
  const blocked = createService({ source });
  const app = createService({ source, approvedAchievementRuleVersion: "accepted-evidence/v1" });
  t.after(() => Promise.all([blocked.close(), app.close()]));
  const url = "/api/v1/contributors/alice/achievements?snapshot=public-1";
  assert.equal((await blocked.inject({ url })).statusCode, 503);
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200);
  const awards = response.json().achievements;
  assert.equal(awards.length, 2);
  assert.deepEqual(awards[0].evidenceIds, ["e-alice"]);
  assert.equal(awards[0].sharedCredit, true);
  assert.equal(awards[0].ruleVersion, "accepted-evidence/v1");
  assert.match(awards[0].scopeMeaning, /not a claim of first-ever/);
  value.selected.snapshot.coverage[0].knownStart = null;
  assert.deepEqual((await app.inject({ url })).json().achievements, []);
  value.selected.snapshot.coverage[0].knownStart = value.selected.snapshot.coverage[0].windowStart;
  value.selected.snapshot.coverage[0].state = "partial";
  assert.deepEqual((await app.inject({ url })).json().achievements, []);
  value.selected.snapshot.coverage[0].state = "complete";
  for (const state of ["observed", "pending", "unknown"]) {
    value.selected.portfolioEvidence[0].activityState = state;
    assert.deepEqual((await app.inject({ url })).json().achievements, []);
  }
  value.selected.portfolioEvidence[0].activityState = "accepted";
  value.selected.portfolioEvidence[0].occurredAt = null;
  const undated = await app.inject({ url });
  assert.equal(undated.statusCode, 200);
  assert.deepEqual(undated.json().achievements, []);
  value.selected.portfolioEvidence[0].occurredAt = at;
  value.controls.suppressedArtifactIds.push("pr-0");
  assert.deepEqual((await app.inject({ url })).json().achievements, []);
  value.controls.suppressedActorIds.push("alice");
  assert.equal((await app.inject({ url })).statusCode, 404);
});

test("achievement exclusions preserve positively evidenced automated execution on user accounts", async (t) => {
  const value = fixture();
  value.selected.actors[0].actor.executionMode = "automated";
  value.selected.portfolioEvidence = value.selected.evidence.map((entry) => ({
    ...entry,
    activityState: "accepted",
    observedAt: at,
  }));
  value.selected.portfolioEvidence[0].contribution.roles = ["reviewer", "coauthor"];
  value.selected.snapshot.coverage[0].knownStart = value.selected.snapshot.coverage[0].windowStart;
  const app = createService({
    source: { read: async () => structuredClone(value) },
    approvedAchievementRuleVersion: "accepted-evidence/v1",
  });
  t.after(() => app.close());
  for (const filter of ["all", "user", "automation"]) {
    const query = `snapshot=public-1&actors=${filter}`;
    const response = await app.inject(`/api/v1/contributors/alice/achievements?${query}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().achievements, [], `${filter} cannot award automated execution`);
    const board = (await app.inject(`/api/v1/boards?metric=pr_merged&${query}`)).json();
    const row = board.rows.find((row) => row.actorId === "alice");
    assert.equal(row.actor.kind, "user", "execution evidence does not reclassify the account");
    assert.equal(row.actor.executionMode, "automated");
    assert.equal(row.result.value, 2, "withholding an award does not erase measured activity");
  }
  value.selected.actors[0].actor.executionMode = "unknown";
  const unknown = await app.inject("/api/v1/contributors/alice/achievements?snapshot=public-1&actors=user");
  assert.equal(unknown.statusCode, 200);
  assert.equal(unknown.json().achievements.length, 2, "unknown execution stays eligible without claiming manual work");
});

test("README SVG images are bounded passive dated output and enforce current pinned suppression", async (t) => {
  const value = fixture();
  value.selected.actors[0].actor.login = '<script>alert("unsafe")</script>';
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const url = "/api/v1/cards/alice/image?metric=pr_merged&snapshot=public-1";
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /image\/svg\+xml/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.body, /Archived snapshot: 2026-10-17/);
  assert.match(response.body, /&lt;script&gt;/);
  assert.doesNotMatch(response.body, /<script|<foreignObject|<image|href=|onload=/);
  assert.ok(Buffer.byteLength(response.body) < 16384);
  assert.equal((await app.inject({ url })).body, response.body);
  value.controls.suppressedActorIds.push("alice");
  assert.equal((await app.inject({ url, headers: { "if-none-match": response.headers.etag } })).statusCode, 404);
});

test("descriptive and spotlight metrics reject ranked provider policies across boards, profiles and exports", async (t) => {
  for (const metricId of [
    "pr_accepted_rate",
    "review_wait",
    "active_periods",
    "appreciation",
    "incidents",
    "first_contribution",
  ]) {
    for (const rank of [true, undefined, false]) {
      const value = fixture();
      for (const row of value.selected.rows) row.result.metricId = metricId;
      for (const item of value.selected.evidence) item.contribution.metricIds = [metricId];
      value.selected.ranking = [{ metricId, direction: "descending", ...(rank === undefined ? {} : { rank }) }];
      const { app } = harness(t, value);
      for (const path of [
        `boards?metric=${metricId}`,
        `contributors/alice?metric=${metricId}`,
        `exports?metric=${metricId}&format=json`,
        `exports?metric=${metricId}&format=csv`,
      ]) {
        const response = await app.inject(`/api/v1/${path}`);
        assert.equal(
          response.statusCode,
          rank === false ? 200 : 503,
          `${metricId} ${String(rank)} ${path}: ${response.body}`,
        );
        if (rank !== false) {
          assert.equal(response.headers.etag, undefined);
          assert.doesNotMatch(response.body, /alice|bob|carol/);
        }
      }
      if (rank !== false) continue;
      const selected = selection(`?metric=${metricId}&snapshot=public-1`);
      const boardData = (await app.inject(`/api/v1/boards?metric=${metricId}&snapshot=public-1`)).json();
      assert.ok(boardData.rows.length > 0);
      assert.ok(boardData.rows.every((row) => row.rank === null));
      assert.doesNotThrow(() => parseBoard(boardData, selected));
      const exported = (await app.inject(`/api/v1/exports?metric=${metricId}&snapshot=public-1&format=json`)).json();
      assert.doesNotThrow(() => validateExport(exported, selected, exported.metric));
      for (const data of [boardData, exported]) {
        const parse =
          data === boardData ? parseBoard : (value, selected) => validateExport(value, selected, exported.metric);
        const contradictory = structuredClone(data);
        contradictory.ranking.rank = true;
        assert.throws(() => parse(contradictory, selected));
        delete contradictory.ranking.rank;
        assert.throws(() => parse(contradictory, selected));
        contradictory.ranking = null;
        contradictory.rows[0].rank = 1;
        assert.throws(() => parse(contradictory, selected));
      }
    }
  }
});

test("spotlight board and JSON/CSV clients retain proof and reject invented ranking", async (t) => {
  for (const metricId of ["appreciation", "incidents", "first_contribution"]) {
    const value = fixture("public-1", 1, metricId);
    value.selected.ranking[0].rank = false;
    const original = structuredClone(value);
    const { app } = harness(t, value);
    const selected = selection(`?metric=${metricId}&snapshot=public-1`);
    const boardResponse = await app.inject(`/api/v1/boards?metric=${metricId}&snapshot=public-1`);
    assert.equal(boardResponse.statusCode, 200);
    const boardData = boardResponse.json();
    assert.doesNotThrow(() => parseBoard(boardData, selected));
    const jsonResponse = await app.inject(`/api/v1/exports?metric=${metricId}&snapshot=public-1&format=json`);
    assert.equal(jsonResponse.statusCode, 200);
    const exported = jsonResponse.json();
    const csvResponse = await app.inject(`/api/v1/exports?metric=${metricId}&snapshot=public-1&format=csv`);
    assert.equal(csvResponse.statusCode, 200);
    const csv = parseCSVExport(csvResponse.body, exported.metric, Number(selected.limit));
    for (const data of [boardData, exported, csv]) {
      const parse =
        data === boardData ? parseBoard : (value, selected) => validateExport(value, selected, exported.metric);
      assert.doesNotThrow(() => parse(data, selected));
      assert.deepEqual(
        data.rows.map((row) => [row.actorId, row.rank, row.result.value, row.evidenceIds]),
        value.selected.rows.map((row) => [row.actorId, null, row.result.value, row.evidenceIds]),
      );
      const forged = structuredClone(data);
      forged.ranking.rank = true;
      assert.throws(() => parse(forged, selected), `${metricId}: ranked metadata must not enable a spotlight`);
      forged.ranking = null;
      forged.rows[0].rank = 1;
      assert.throws(() => parse(forged, selected), `${metricId}: an absent policy must not authorize a numeric rank`);
    }
    assert.deepEqual(value, original, "reads must preserve the stored unranked evidence");
  }
});
