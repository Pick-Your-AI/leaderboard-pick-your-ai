import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { comparePublishedRanks } from "../dist/rank-comparison.js";
import { ACHIEVEMENT_RULE_VERSION } from "../dist/achievements.js";
import { canonicalPublicScope, publicScopeKey, publicScopeParameters } from "../../../packages/contracts/dist/index.js";
import { currentScope, legacyScope, scopeFixture, comparisonFixture } from "../../../tests/fixtures/public-scope.mjs";

const params = (scope, extra = {}) => new URLSearchParams({ ...publicScopeParameters(scope), ...extra });
function harness(t, selectedScope = currentScope, transform = (read) => read) {
  const calls = [];
  const read = transform(scopeFixture(selectedScope));
  const app = createService({
    now: () => Date.parse("2026-10-18T00:00:00.000Z"),
    approvedAchievementRuleVersion: ACHIEVEMENT_RULE_VERSION,
    source: {
      async read(scope, pin) {
        calls.push({ scope: structuredClone(scope), pin });
        return structuredClone(read);
      },
    },
  });
  t.after(() => app.close());
  return { app, calls, read };
}

test("current Project selections are canonical and every JSON route versions its complete scope", async (t) => {
  const h = harness(t);
  const routes = [
    ["boards", { metric: "pr_merged" }],
    ["contributors", {}],
    ["contributors/101", {}],
    ["contributors/101/achievements", {}],
    ["activity", {}],
    ["evidence/synthetic-101-0", {}],
    ["health", {}],
  ];
  for (const [route, extra] of routes) {
    const response = await h.app.inject(`/api/v1/${route}?${params(currentScope, extra)}`);
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.schemaVersion, "public-read/v2", route);
    assert.equal(data.snapshotSchemaVersion, "leaderboard/v1", route);
    assert.deepEqual(data.scope, currentScope, route);
  }
  const response = await h.app.inject("/api/v1/boards?metric=pr_merged&context=current&project=PVT_B%3D,PVT_A,PVT_A");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().scope, currentScope);
  for (const call of h.calls) assert.deepEqual(call.scope, currentScope);
});

test("legacy event aliases retain identical response, cursor and v1 export bytes", async (t) => {
  const h = harness(t, legacyScope);
  for (const path of [
    "/api/v1/boards?metric=pr_merged&limit=1",
    "/api/v1/exports?metric=pr_merged&format=json",
    "/api/v1/exports?metric=pr_merged&format=csv",
    "/api/v1/cards/101?metric=pr_merged",
  ]) {
    const old = await h.app.inject(path);
    const explicit = await h.app.inject(path + "&context=event");
    assert.equal(old.statusCode, 200, old.body);
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(explicit.body, old.body);
    assert.equal(explicit.headers.etag, old.headers.etag);
  }
  const board = (await h.app.inject("/api/v1/boards?metric=pr_merged&limit=1")).json();
  assert.equal(board.schemaVersion, "leaderboard/v1");
  assert.equal("snapshotSchemaVersion" in board, false);
  assert.deepEqual(board.scope, legacyScope);
  const next = await h.app.inject(
    `/api/v1/boards?${params(legacyScope, { metric: "pr_merged", limit: "1", context: "event", cursor: board.nextCursor })}`,
  );
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().rows[0].actorId, "101");
  assert.equal((await h.app.inject("/api/v1/exports?metric=pr_merged")).json().exportSchemaVersion, "public-export/v1");
});

test("cursors bind complete current/event and Project identities before reading a provider", async (t) => {
  const h = harness(t);
  const query = params(currentScope, { metric: "pr_merged", limit: "1" });
  const first = await h.app.inject(`/api/v1/boards?${query}`);
  assert.equal(first.statusCode, 200, first.body);
  const cursor = first.json().nextCursor;
  assert.ok(cursor.length < 2048);
  query.set("cursor", cursor);
  query.set("project", "PVT_B=,PVT_A,PVT_A");
  const next = await h.app.inject(`/api/v1/boards?${query}`);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().snapshotId, first.json().snapshotId);
  const count = h.calls.length;
  for (const patch of [
    { context: "event" },
    { project: "PVT_A" },
    { project: "PVT_C" },
    { snapshot: "synthetic-wrong-pin" },
  ]) {
    const wrong = new URLSearchParams(query);
    for (const [key, value] of Object.entries(patch)) wrong.set(key, value);
    const rejected = await h.app.inject(`/api/v1/boards?${wrong}`);
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error, "cursor_scope_mismatch");
  }
  assert.equal(h.calls.length, count);
});

test("bounded large Project sets remain traversable with a short exact-scope cursor", async (t) => {
  const scope = canonicalPublicScope({
    ...legacyScope,
    context: "current",
    projects: Array.from({ length: 100 }, (_, i) => `PVT_${i.toString().padStart(3, "0")}`),
  });
  const h = harness(t, scope);
  const query = params(scope, { metric: "pr_merged", limit: "1" });
  const first = await h.app.inject(`/api/v1/boards?${query}`);
  assert.equal(first.statusCode, 200, first.body);
  query.set("cursor", first.json().nextCursor);
  assert.ok(query.toString().length < 4096);
  const next = await h.app.inject(`/api/v1/boards?${query}`);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().rows.length, 1);
});

test("provider scopes cannot omit their version or substitute another basis or Project set", async (t) => {
  for (const mutate of [
    (scope) => delete scope.schemaVersion,
    (scope) => delete scope.context,
    (scope) => delete scope.projects,
    (scope) => (scope.context = "event"),
    (scope) => (scope.projects = ["PVT_A"]),
    (scope) => (scope.schemaVersion = "public-scope/v1"),
    (scope) => (scope.privatePayload = "unprojected"),
  ]) {
    const h = harness(t, currentScope, (read) => {
      mutate(read.selected.scope);
      return read;
    });
    const response = await h.app.inject(`/api/v1/boards?${params(currentScope, { metric: "pr_merged" })}`);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, "public_projection_unavailable");
  }
  const h = harness(t, legacyScope);
  const fallback = await h.app.inject(`/api/v1/boards?${params(currentScope, { metric: "pr_merged" })}`);
  assert.equal(fallback.statusCode, 503, fallback.body);
  const wrongPin = await h.app.inject(
    `/api/v1/boards?${params(legacyScope, { metric: "pr_merged", snapshot: "synthetic-other-scope" })}`,
  );
  assert.equal(wrongPin.statusCode, 503, wrongPin.body);
});

test("scope projection detaches Project arrays and preserves current privacy for pinned reads", async (t) => {
  const requested = structuredClone(currentScope);
  const raw = scopeFixture(requested);
  const projected = projectRead(raw, requested, raw.selected.snapshot.snapshotId);
  requested.projects.push("PVT_later");
  raw.selected.scope.projects.push("PVT_provider_mutation");
  assert.deepEqual(projected.selected.scope, currentScope);
  const h = harness(t, currentScope, (read) => {
    read.controls.suppressedActorIds = ["101"];
    return read;
  });
  const response = await h.app.inject(
    `/api/v1/boards?${params(currentScope, { metric: "pr_merged", snapshot: h.read.selected.snapshot.snapshotId })}`,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().rows.map((row) => row.actorId),
    ["102"],
  );
  assert.equal(response.body.includes("synthetic-101-"), false);
});

test("malformed context and Project query input is rejected before source access", async (t) => {
  const h = harness(t);
  for (const suffix of [
    "context=latest",
    "context=",
    "context=current&context=event",
    "project=",
    "project=PVT_A,",
    "project=PVT_A,,PVT_B",
    "project=PVT_A&project=PVT_B",
    "project=PVT%20A",
    `project=${"A".repeat(129)}`,
    `project=${Array.from({ length: 101 }, (_, i) => `PVT_${i}`).join(",")}`,
  ]) {
    const response = await h.app.inject(`/api/v1/boards?metric=pr_merged&${suffix}`);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(h.calls.length, 0);
});

test("provider callbacks cannot rewrite ordinary, health or paired scope expectations", async (t) => {
  for (const mode of ["read", "health", "comparison"]) {
    await t.test(mode, async (subtest) => {
      const substitute = (scope) => {
        scope.context = "event";
        scope.projects.push("PVT_substituted");
        return scopeFixture(scope);
      };
      const app = createService({
        source: {
          async read(scope) {
            return substitute(scope);
          },
          async readHealth(scope) {
            return substitute(scope);
          },
          async readComparison(scope) {
            return { current: substitute(scope), previous: null, currentHistory: null, previousHistory: null };
          },
        },
      });
      subtest.after(() => app.close());
      const query = params(currentScope, mode === "health" ? {} : { metric: "pr_merged" });
      if (mode === "comparison") query.set("compare", "synthetic-prior");
      const response = await app.inject(`/api/v1/${mode === "health" ? "health" : "boards"}?${query}`);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error, "public_projection_unavailable");
    });
  }
});

test("paired providers cannot rewrite comparison pins or windows in shared links", async (t) => {
  const current = scopeFixture(currentScope);
  const app = createService({
    source: {
      async read() {
        return structuredClone(current);
      },
      async readComparison(_scope, _pin, previous) {
        previous.snapshotId = "synthetic-substituted-pin";
        previous.scope.start = "2026-10-01T00:00:00.000Z";
        previous.scope.end = "2026-10-18T00:00:00.000Z";
        previous.scope.projects.push("PVT_substituted");
        return { current: structuredClone(current), previous: null, currentHistory: null, previousHistory: null };
      },
    },
  });
  t.after(() => app.close());
  const response = await app.inject(
    `/api/v1/boards?${params(currentScope, { metric: "pr_merged", compare: "synthetic-original-pin" })}`,
  );
  assert.equal(response.statusCode, 200, response.body);
  const query = new URL(response.json().shareUrl, "https://synthetic.invalid").searchParams;
  assert.equal(query.get("compare"), "synthetic-original-pin");
  assert.equal(query.has("compareStart"), false);
  assert.equal(query.has("compareEnd"), false);
  assert.equal(query.get("project"), "PVT_A,PVT_B=");
});

test("share, card and update URLs retain their exact membership selection and snapshot", async (t) => {
  const h = harness(t);
  const response = await h.app.inject(`/api/v1/boards?${params(currentScope, { metric: "pr_merged" })}`);
  const board = response.json();
  const share = new URL(board.shareUrl, "https://synthetic.invalid").searchParams;
  assert.equal(share.get("context"), "current");
  assert.equal(share.get("project"), "PVT_A,PVT_B=");
  assert.equal(share.get("snapshot"), board.snapshotId);
  for (const suffix of ["", "/image"]) {
    const card = await h.app.inject(
      `/api/v1/cards/101${suffix}?${params(currentScope, { metric: "pr_merged", snapshot: board.snapshotId })}`,
    );
    assert.equal(card.statusCode, 200, card.body);
    assert.match(card.body, /Current at the frozen snapshot/);
    assert.match(card.body, /PVT_A, PVT_B=/);
    if (suffix === "") {
      assert.match(card.body, /context=current/);
      assert.match(card.body, /project=PVT_A%2CPVT_B%3D/);
      assert.ok(card.body.includes(`snapshot=${board.snapshotId}`));
    }
  }
  const updates = await h.app.inject(`/api/v1/updates?${params(currentScope)}`);
  assert.equal(updates.statusCode, 200, updates.body);
  const payload = JSON.parse(
    updates.body
      .split("\n")
      .find((line) => line.startsWith("data: "))
      .slice(6),
  );
  assert.equal(payload.schemaVersion, "public-read/v2");
  const poll = new URL(payload.pollingUrl, "https://synthetic.invalid");
  assert.equal(poll.searchParams.get("context"), "current");
  assert.equal(poll.searchParams.get("project"), "PVT_A,PVT_B=");
  assert.equal((await h.app.inject(poll.pathname + poll.search)).statusCode, 200);
});

test("JSON and every CSV record explicitly version the selected membership basis", async (t) => {
  for (const context of ["current", "event"]) {
    const scope = canonicalPublicScope({ ...legacyScope, context, projects: ["PVT_B=", "PVT_A"] });
    const h = harness(t, scope);
    const query = params(scope, { metric: "pr_merged" });
    const json = await h.app.inject(`/api/v1/exports?${query}`);
    assert.equal(json.statusCode, 200, json.body);
    assert.equal(json.json().exportSchemaVersion, "public-export/v2");
    assert.equal(json.json().schemaVersion, "leaderboard/v1");
    assert.deepEqual(json.json().scope, scope);
    query.set("format", "csv");
    const csv = await h.app.inject(`/api/v1/exports?${query}`);
    assert.equal(csv.statusCode, 200, csv.body);
    const records = csv.body
      .trimEnd()
      .split("\r\n")
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"')));
    const [header, ...rows] = records;
    for (const row of rows) {
      assert.equal(row.length, header.length);
      assert.equal(row[header.indexOf("export_schema_version")], "public-export/v2");
      assert.equal(row[header.indexOf("scope_schema_version")], "public-scope/v2");
      assert.equal(row[header.indexOf("context")], context);
      assert.deepEqual(JSON.parse(row[header.indexOf("projects")]), ["PVT_A", "PVT_B="]);
      assert.equal(row[header.indexOf("snapshot")], json.json().snapshotId);
    }
  }
});

test("rank history is bound to current/event and Project scope before movement is reported", () => {
  const before = comparisonFixture(
    { ...currentScope, start: "2026-09-18T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" },
    "2026-10-18T00:00:00.000Z",
    "synthetic-before",
    1,
  );
  const after = comparisonFixture(
    { ...currentScope, start: "2026-09-19T00:00:00.000Z", end: "2026-10-19T00:00:00.000Z" },
    "2026-10-19T00:00:00.000Z",
    "synthetic-after",
    2,
  );
  const compare = (prior = before.read, priorHistory = before.history) =>
    comparePublishedRanks(after.read, prior, after.history, priorHistory, "pr_merged");
  const valid = compare();
  assert.deepEqual(valid.comparison.scope, before.read.selected.scope);
  assert.ok(
    valid.movement.every((row) => row.state !== "unavailable"),
    JSON.stringify(valid),
  );
  for (const patch of [{ context: "event" }, { projects: ["PVT_A"] }]) {
    const read = structuredClone(before.read);
    Object.assign(read.selected.scope, patch);
    assert.ok(compare(read).movement.every((row) => row.reason === "comparison_scope_changed"));
    const history = structuredClone(before.history);
    Object.assign(history.metrics[0].scope, patch);
    assert.ok(
      compare(before.read, history).movement.every((row) => row.reason === "history_or_visible_cohort_changed"),
    );
  }
  assert.notEqual(publicScopeKey(before.read.selected.scope), publicScopeKey(after.read.selected.scope));
});
