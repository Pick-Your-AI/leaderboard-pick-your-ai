import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { comparePublishedRanks } from "../dist/rank-comparison.js";
import { ACHIEVEMENT_RULE_VERSION } from "../dist/achievements.js";
import { canonicalPublicScope, publicScopeParameters } from "../../../packages/contracts/dist/index.js";
import { currentScope, legacyScope, scopeFixture, comparisonFixture } from "../../../tests/fixtures/public-scope.mjs";

const roleScope = canonicalPublicScope({
  ...legacyScope,
  context: "current",
  projects: ["PVT_A", "PVT_B="],
  roles: ["author", "reviewer"],
});
const params = (scope, extra = {}) => new URLSearchParams({ ...publicScopeParameters(scope), ...extra });
function harness(t, selectedScope = roleScope, transform = (read) => read) {
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

test("every public JSON route exposes the exact v3 role union and original snapshot contract", async (t) => {
  const h = harness(t);
  for (const [route, extra] of [
    ["boards", { metric: "pr_merged" }],
    ["contributors", {}],
    ["contributors/101", {}],
    ["contributors/101/achievements", {}],
    ["activity", {}],
    ["evidence/synthetic-101-0", {}],
    ["health", {}],
  ]) {
    const response = await h.app.inject(`/api/v1/${route}?${params(roleScope, extra)}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().schemaVersion, "public-read/v3", route);
    assert.equal(response.json().snapshotSchemaVersion, "leaderboard/v1", route);
    assert.deepEqual(response.json().scope, roleScope, route);
  }
  const query = params(roleScope, { metric: "pr_merged", role: "reviewer,author,author" });
  assert.equal((await h.app.inject(`/api/v1/boards?${query}`)).statusCode, 200);
  assert.ok(h.calls.every((call) => JSON.stringify(call.scope) === JSON.stringify(roleScope)));
});

test("malformed, authority and unresolved role filters fail before accessing a provider", async (t) => {
  const h = harness(t);
  for (const suffix of [
    "role=",
    "role=author,",
    "role=author,,reviewer",
    "role=unknown",
    "role=operator",
    "role=privacy",
    "role=author&role=reviewer",
    "role=AUTHOR",
    `role=${Array(10).fill("author").join(",")}`,
  ]) {
    const response = await h.app.inject(`/api/v1/boards?metric=pr_merged&${suffix}`);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(h.calls.length, 0);
});

test("role cursors preserve aliases and reject changed or omitted roles before provider access", async (t) => {
  const h = harness(t);
  const query = params(roleScope, { metric: "pr_merged", limit: "1" });
  const first = await h.app.inject(`/api/v1/boards?${query}`);
  assert.equal(first.statusCode, 200, first.body);
  query.set("cursor", first.json().nextCursor);
  assert.ok(first.json().nextCursor.length < 2048);
  query.set("role", "reviewer,author,author");
  assert.equal((await h.app.inject(`/api/v1/boards?${query}`)).statusCode, 200);
  const calls = h.calls.length;
  for (const role of [null, "author", "reviewer", "reporter"]) {
    const changed = new URLSearchParams(query);
    if (role === null) changed.delete("role");
    else changed.set("role", role);
    const response = await h.app.inject(`/api/v1/boards?${changed}`);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "cursor_scope_mismatch");
  }
  assert.equal(h.calls.length, calls);
});

test("providers cannot omit role identity, reuse v2 or substitute a different selected role", async (t) => {
  for (const mutate of [
    (scope) => delete scope.schemaVersion,
    (scope) => delete scope.roles,
    (scope) => delete scope.context,
    (scope) => delete scope.projects,
    (scope) => (scope.roles = ["author"]),
    (scope) => (scope.roles = []),
    (scope) => (scope.schemaVersion = "public-scope/v2"),
  ]) {
    const h = harness(t, roleScope, (read) => {
      mutate(read.selected.scope);
      return read;
    });
    const response = await h.app.inject(`/api/v1/boards?${params(roleScope, { metric: "pr_merged" })}`);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, "public_projection_unavailable");
  }
  const old = harness(t, currentScope);
  assert.equal((await old.app.inject(`/api/v1/boards?${params(roleScope, { metric: "pr_merged" })}`)).statusCode, 503);
});

test("ordinary, health and paired callbacks cannot mutate the authoritative requested role set", async (t) => {
  for (const mode of ["read", "health", "comparison"]) {
    const substitute = (scope) => {
      scope.roles = ["author"];
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
    t.after(() => app.close());
    const query = params(roleScope, mode === "health" ? {} : { metric: "pr_merged" });
    if (mode === "comparison") query.set("compare", "synthetic-prior");
    const response = await app.inject(`/api/v1/${mode === "health" ? "health" : "boards"}?${query}`);
    assert.equal(response.statusCode, 503, response.body);
  }
});

test("role projections detach arrays and withhold mixed-role aggregates without recomputing counts", () => {
  const selected = canonicalPublicScope({ ...legacyScope, roles: ["author"] });
  const raw = scopeFixture(selected);
  const requested = structuredClone(selected);
  const projected = projectRead(raw, requested, raw.selected.snapshot.snapshotId);
  requested.roles.push("reviewer");
  raw.selected.scope.roles.push("reviewer");
  assert.deepEqual(projected.selected.scope, selected);
  const conflicting = scopeFixture(selected);
  conflicting.selected.evidence[0].contribution.roles = ["reviewer"];
  const result = projectRead(conflicting, selected, null);
  assert.deepEqual(
    result.selected.rows.map((row) => row.actorId),
    ["102"],
  );
  assert.ok(result.selected.evidence.every((entry) => entry.contribution.roles.includes("author")));
  assert.equal(result.selected.rows[0].result.value, 15);
});

test("out-of-role pending proof becomes unknown and current privacy still suppresses pinned role reads", async (t) => {
  const selected = canonicalPublicScope({ ...legacyScope, roles: ["author"] });
  const h = harness(t, selected, (read) => {
    for (const entry of read.selected.pendingEvidence) entry.contribution.roles = ["reviewer"];
    return read;
  });
  const response = await h.app.inject(`/api/v1/boards?${params(selected, { metric: "pr_merged" })}`);
  assert.equal(response.statusCode, 200, response.body);
  const row = response.json().rows.find((entry) => entry.actorId === "101");
  assert.equal(row.result.value, 14);
  assert.equal(row.pending.state, "unknown");
  assert.equal(row.pending.count, null);
  assert.deepEqual(row.pending.evidenceIds, []);
  h.read.controls.suppressedActorIds = ["101"];
  const hidden = await h.app.inject(
    `/api/v1/exports?${params(selected, { metric: "pr_merged", snapshot: h.read.selected.snapshot.snapshotId })}`,
  );
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.deepEqual(
    hidden.json().rows.map((entry) => entry.actorId),
    ["102"],
  );
  assert.equal(hidden.body.includes("synthetic-101-"), false);
});

test("share, card and update navigation retain role, membership and snapshot identity", async (t) => {
  const h = harness(t);
  const response = await h.app.inject(`/api/v1/boards?${params(roleScope, { metric: "pr_merged" })}`);
  const board = response.json();
  const share = new URL(board.shareUrl, "https://synthetic.invalid").searchParams;
  assert.equal(share.get("role"), "author,reviewer");
  assert.equal(share.get("project"), "PVT_A,PVT_B=");
  assert.equal(share.get("context"), "current");
  assert.equal(share.get("snapshot"), board.snapshotId);
  for (const suffix of ["", "/image"]) {
    const card = await h.app.inject(
      `/api/v1/cards/101${suffix}?${params(roleScope, { metric: "pr_merged", snapshot: board.snapshotId })}`,
    );
    assert.equal(card.statusCode, 200, card.body);
    assert.match(card.body, /Contribution roles/);
    assert.match(card.body, /author, reviewer/);
    if (!suffix) assert.match(card.body, /role=author%2Creviewer/);
  }
  const updates = await h.app.inject(`/api/v1/updates?${params(roleScope)}`);
  assert.equal(updates.statusCode, 200, updates.body);
  const payload = JSON.parse(
    updates.body
      .split("\n")
      .find((line) => line.startsWith("data: "))
      .slice(6),
  );
  assert.equal(payload.schemaVersion, "public-read/v3");
  const polling = new URL(payload.pollingUrl, "https://synthetic.invalid");
  assert.equal(polling.searchParams.get("role"), "author,reviewer");
  assert.equal((await h.app.inject(polling.pathname + polling.search)).statusCode, 200);
});

test("JSON and all CSV records carry v3 role metadata, including an empty filtered export", async (t) => {
  for (const empty of [false, true]) {
    const h = harness(t, roleScope, (read) => {
      if (empty) read.controls.suppressedActorIds = ["101", "102"];
      return read;
    });
    const query = params(roleScope, { metric: "pr_merged" });
    const json = await h.app.inject(`/api/v1/exports?${query}`);
    assert.equal(json.statusCode, 200, json.body);
    assert.equal(json.json().exportSchemaVersion, "public-export/v3");
    assert.equal(json.json().schemaVersion, "leaderboard/v1");
    assert.deepEqual(json.json().scope, roleScope);
    query.set("format", "csv");
    const csv = await h.app.inject(`/api/v1/exports?${query}`);
    assert.equal(csv.statusCode, 200, csv.body);
    const [header, ...rows] = csv.body
      .trimEnd()
      .split("\r\n")
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"')));
    assert.equal(rows.length, empty ? 1 : 3);
    for (const row of rows) {
      assert.equal(row.length, header.length);
      assert.equal(row[header.indexOf("export_schema_version")], "public-export/v3");
      assert.equal(row[header.indexOf("scope_schema_version")], "public-scope/v3");
      assert.deepEqual(JSON.parse(row[header.indexOf("roles")]), roleScope.roles);
      assert.deepEqual(JSON.parse(row[header.indexOf("projects")]), roleScope.projects);
      assert.equal(row[header.indexOf("context")], "current");
      assert.equal(row[header.indexOf("snapshot")], json.json().snapshotId);
    }
  }
});

test("rank comparisons require the exact role union in both projections and retained receipts", () => {
  const make = (start, end, id, revision) => comparisonFixture({ ...roleScope, start, end }, end, id, revision);
  const before = make("2026-09-18T00:00:00.000Z", "2026-10-18T00:00:00.000Z", "synthetic-before-roles", 1);
  const after = make("2026-09-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z", "synthetic-after-roles", 2);
  const compare = (read = before.read, history = before.history) =>
    comparePublishedRanks(after.read, read, after.history, history, "pr_merged");
  assert.ok(compare().movement.every((row) => row.state !== "unavailable"));
  for (const roles of [[], ["author"], ["reviewer"], ["author", "reviewer", "reporter"]]) {
    const history = structuredClone(before.history);
    history.metrics[0].scope.roles = roles;
    assert.ok(
      compare(before.read, history).movement.every((row) => row.reason === "history_or_visible_cohort_changed"),
    );
    const read = structuredClone(before.read);
    const { schemaVersion, ...input } = read.selected.scope;
    read.selected.scope = canonicalPublicScope({ ...input, roles });
    assert.ok(compare(read).movement.every((row) => row.reason === "comparison_scope_changed"));
  }
});
