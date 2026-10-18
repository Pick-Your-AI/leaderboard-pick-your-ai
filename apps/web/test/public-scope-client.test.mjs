import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeParameters } from "@pick-your-ai/contracts";
import { createService } from "../../service/dist/app.js";
import { legacyScope, currentScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";
import {
  request,
  exportPage,
  activity,
  activityDetail,
  board,
  directory,
  evidence,
  health,
  metadata,
  parameters,
  portfolioParameters,
  profile,
  selection,
  uiHref,
  validateExport,
} from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";
import { proofHref, readProof } from "../src/remote/proof.ts";
import { cardHref, cardImageHref, supportsEditorialScope } from "../src/remote/recognition-client.ts";
import { readWallQuery, wallHref } from "../src/remote/wall.ts";

const roleScope = canonicalPublicScope({
  ...legacyScope,
  context: "current",
  projects: ["PVT_A", "PVT_B="],
  roles: ["author", "reviewer"],
});
const query = (scope, extra = {}) =>
  new URLSearchParams({ ...publicScopeParameters(scope), metric: "pr_merged", ...extra });
// Bypass the query parser only in response tests: a parser failure must not hide
// an independently broken response boundary on the unchanged implementation.
const selected = (scope, extra = {}) => ({ ...selection("?metric=pr_merged"), ...scope, ...extra });
function harness(t, scope = roleScope, empty = false) {
  const read = scopeFixture(scope);
  if (empty) read.controls.suppressedActorIds = ["101", "102"];
  const calls = [];
  const app = createService({
    source: {
      async read(requested, pin) {
        calls.push({ scope: structuredClone(requested), pin });
        return structuredClone(read);
      },
    },
  });
  t.after(() => app.close());
  const get = async (path, extra = {}) => {
    const params = query(scope, extra);
    if (!["boards", "exports"].includes(path)) params.delete("metric");
    const response = await app.inject(`/api/v1/${path}?${params}`);
    assert.equal(response.statusCode, 200, response.body);
    return response;
  };
  return { app, read, calls, get };
}

test("public scope queries canonicalize Project and role unions and preserve legacy query bytes", () => {
  const legacy = selection("?organization=Pick-Your-AI&repository=2&workstream=w1");
  assert.equal(parameters(legacy).toString(), "organization=Pick-Your-AI&repository=2&workstream=w1");
  assert.equal(selection("?context=event").schemaVersion, undefined);
  const value = selection("?context=current&project=PVT_B%3D,PVT_A,PVT_A&role=reviewer,author,author");
  assert.equal(value.schemaVersion, "public-scope/v3");
  assert.deepEqual(value.projects, ["PVT_A", "PVT_B="]);
  assert.deepEqual(value.roles, ["author", "reviewer"]);
  assert.equal(parameters(value).get("project"), "PVT_A,PVT_B=");
  assert.equal(parameters(value).get("role"), "author,reviewer");
  assert.equal(selection("?project=PVT_A").schemaVersion, "public-scope/v2");
});

test("malformed and excessive scope queries fail before any public request", () => {
  for (const raw of [
    "context=",
    "context=future",
    "context=current&context=event",
    "project=",
    "project=A,",
    "project=A,,B",
    "project=" + "A".repeat(129),
    "project=" + Array(101).fill("A").join(","),
    "project=A&project=B",
    "role=",
    "role=unknown",
    "role=operator",
    "role=AUTHOR",
    "role=author,",
    "role=author,,reviewer",
    "role=author&role=reviewer",
    "role=" + Array(10).fill("author").join(","),
    "schemaVersion=public-scope/v3",
    "project=" + "A".repeat(33000),
  ])
    assert.throws(() => selection(`?${raw}`), undefined, raw.slice(0, 120));
});

test("navigation, proof, cards, portfolios and walls retain the complete scope and local timezone", () => {
  const value = selected(roleScope, { snapshot: "public-1", cursor: "old.signature", timeZone: "Pacific/Honolulu" });
  for (const params of [parameters(value), portfolioParameters(value), portfolioParameters(value, true)]) {
    assert.equal(params.get("context"), "current");
    assert.equal(params.get("project"), "PVT_A,PVT_B=");
    assert.equal(params.get("role"), "author,reviewer");
    assert.equal(params.get("tz"), null);
  }
  const paths = [
    "/contributors",
    "/contributors/101",
    "/activity",
    "/activity/group-1",
    "/contributions/synthetic-101-0",
    "/leaderboards/pr_merged",
    "/health",
    "/projects/w1",
  ];
  for (const path of paths) {
    const url = new URL(uiHref(path, value), "https://synthetic.invalid");
    assert.equal(url.searchParams.get("role"), "author,reviewer", path);
    assert.equal(url.searchParams.get("project"), "PVT_A,PVT_B=", path);
    assert.equal(url.searchParams.get("context"), "current", path);
    assert.equal(url.searchParams.get("snapshot"), "public-1", path);
    assert.equal(url.searchParams.get("cursor"), null, path);
    assert.equal(url.searchParams.get("tz"), "Pacific/Honolulu", path);
    assert.deepEqual(selection(url.search).roles, roleScope.roles);
  }
  for (const href of [
    proofHref("/leaderboards/pr_merged", value, "synthetic-101-0"),
    cardHref("/api/v1", value, "public-1", "101", "pr_merged"),
    cardImageHref("/api/v1", value, "public-1", "101", "pr_merged"),
  ]) {
    const url = new URL(href, "https://synthetic.invalid");
    assert.equal(url.searchParams.get("role"), "author,reviewer");
    assert.equal(url.searchParams.get("project"), "PVT_A,PVT_B=");
  }
  const href = wallHref(
    value,
    { mode: "frozen", boards: ["pr_merged"], interval: 30, format: "landscape" },
    "public-1",
  );
  const restored = readWallQuery(new URL(href, "https://synthetic.invalid").search).selected;
  assert.deepEqual(restored.roles, roleScope.roles);
  assert.deepEqual(restored.projects, roleScope.projects);
  assert.equal(restored.snapshot, "public-1");
  assert.equal(restored.timeZone, "Pacific/Honolulu");
});

for (const scope of [legacyScope, currentScope, roleScope]) {
  test(`actual service reads retain exact detached ${scope.schemaVersion ?? "legacy"} metadata`, async (t) => {
    const h = harness(t, scope),
      value = selected(scope);
    for (const [path, parse] of [
      ["boards", board],
      ["contributors", directory],
      ["contributors/101", profile],
      ["activity", activity],
      ["health", health],
    ]) {
      const raw = (await h.get(path)).json();
      const result = parse(raw, value);
      assert.deepEqual(result.scope, scope, path);
      if (raw.scope.projects) {
        raw.scope.projects.push("PVT_AFTER_PARSE");
        assert.deepEqual(result.scope, scope, path);
      }
      if (raw.scope.roles) {
        raw.scope.roles.push("reporter");
        assert.deepEqual(result.scope, scope, path);
      }
    }
  });
}

test("legacy readers reject extended response scope even when the original five fields match", async (t) => {
  const h = harness(t);
  const body = (await h.get("health")).json();
  assert.throws(() => metadata(body, selected(legacyScope)), /api_scope_mismatch/);
});

test("membership and role response envelopes require canonical retained shape and exact versions", async (t) => {
  for (const scope of [currentScope, roleScope]) {
    const h = harness(t, scope),
      body = (await h.get("health")).json(),
      value = selected(scope);
    const bad = [
      (v) => delete v.schemaVersion,
      (v) => (v.schemaVersion = "leaderboard/v1"),
      (v) => (v.schemaVersion = "public-read/v9"),
      (v) => delete v.snapshotSchemaVersion,
      (v) => (v.snapshotSchemaVersion = "leaderboard/v2"),
      (v) => delete v.scope.schemaVersion,
      (v) => delete v.scope.context,
      (v) => delete v.scope.projects,
      (v) => (v.scope.context = "event"),
      (v) => v.scope.projects.reverse(),
      (v) => v.scope.projects.push(v.scope.projects[0]),
      (v) => (v.scope.extra = "retained-unknown"),
      (v) => (v.scope.projects = ["PVT_OTHER"]),
      ...(scope.roles
        ? [
            (v) => (v.scope.roles = []),
            (v) => (v.scope.roles = ["author"]),
            (v) => delete v.scope.roles,
            (v) => v.scope.roles.reverse(),
            (v) => (v.scope.schemaVersion = "public-scope/v2"),
          ]
        : [(v) => (v.scope.roles = [])]),
    ];
    for (const mutate of bad) {
      const changed = structuredClone(body);
      mutate(changed);
      assert.throws(() => metadata(changed, value), undefined, String(mutate));
    }
    assert.throws(() => metadata(body, { ...value, snapshot: "wrong-pin" }), /api_snapshot_mismatch/);
  }
});

for (const scope of [legacyScope, currentScope, roleScope]) {
  for (const empty of [false, true]) {
    test(`actual ${scope.schemaVersion ?? "legacy"} JSON and CSV exports validate exact metadata (${empty ? "empty" : "rows"})`, async (t) => {
      const h = harness(t, scope, empty),
        body = (await h.get("boards")).json();
      const value = selected(scope, { snapshot: body.snapshotId });
      const exported = (await h.get("exports", { snapshot: body.snapshotId })).json();
      assert.doesNotThrow(() => validateExport(exported, value, body.metric));
      const csv = (await h.get("exports", { snapshot: body.snapshotId, format: "csv" })).body;
      const parsed = parseCSVExport(csv, body.metric, Number(value.limit));
      assert.deepEqual(parsed.scope, scope);
      assert.doesNotThrow(() => validateExport(parsed, value, body.metric));
      assert.equal(parsed.rows.length, empty ? 0 : 2);
      const changed = structuredClone(exported);
      changed.scope.unpublished = "must-not-download";
      assert.throws(() => validateExport(changed, value, body.metric));
      if (scope.schemaVersion) {
        assert.throws(() =>
          parseCSVExport(
            csv.replace('"scope_schema_version"', '"unreviewed_scope_version"'),
            body.metric,
            Number(value.limit),
          ),
        );
        const wrong = structuredClone(exported);
        wrong.exportSchemaVersion = "public-export/v1";
        assert.throws(() => validateExport(wrong, value, body.metric));
        const altered = csv.replace('"current"', '"event"');
        assert.throws(() =>
          validateExport(parseCSVExport(altered, body.metric, Number(value.limit)), value, body.metric),
        );
      }
      if (!empty && scope.roles) {
        const token = '"[""author"",""reviewer""]"';
        const index = csv.lastIndexOf(token);
        assert.ok(index > 0);
        const altered = csv.slice(0, index) + '"[""reviewer""]"' + csv.slice(index + token.length);
        assert.throws(() => parseCSVExport(altered, body.metric, Number(value.limit)));
      }
    });
  }
}

test("proof and profile evidence must intersect the selected contribution role union", async (t) => {
  const h = harness(t),
    value = selected(roleScope);
  const raw = (await h.get("evidence/synthetic-101-0")).json();
  assert.ok(evidence(raw, value).contribution.roles.includes("author"));
  const outOfScope = structuredClone(raw);
  outOfScope.contribution.roles = ["reporter"];
  assert.throws(() => evidence(outOfScope, value), /api_role_filter_mismatch/);
  const multi = structuredClone(raw);
  multi.contribution.roles = ["author", "reporter"];
  assert.doesNotThrow(() => evidence(multi, value));
  const person = (await h.get("contributors/101")).json();
  person.timeline[0].contribution.roles = ["reporter"];
  assert.throws(() => profile(person, value), /api_role_filter_mismatch/);
  const list = (await h.get("activity")).json();
  const detail = (await h.get(`activity/${list.groups[0].groupId}`)).json();
  detail.proofs[0].contribution.roles = ["reporter"];
  assert.throws(() => activityDetail(detail, value), /api_role_filter_mismatch/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(outOfScope), { headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      () => readProof("https://synthetic.invalid/api/v1", "synthetic-101-0", value, new AbortController().signal),
      /api_role_filter_mismatch/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editorial controls cannot certify a Project, current-membership or contribution-role selection", () => {
  assert.equal(supportsEditorialScope(selection(""), "Pick-Your-AI"), true);
  for (const query of ["?context=current", "?project=PVT_A", "?role=author", "?actors=user", "?snapshot=s1"])
    assert.equal(supportsEditorialScope(selection(query), "Pick-Your-AI"), false, query);
});

test("complete public request URLs stay within the service budget before fetch", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("unexpected fetch");
  };
  try {
    const params = new URLSearchParams({ project: "A".repeat(4090) });
    await assert.rejects(
      () => request("https://synthetic.invalid/api/v1", "health", params, new AbortController().signal),
      /query_too_large/,
    );
    const projects = Array.from({ length: 100 }, (_, i) => `PVT_${i}_` + "A".repeat(100));
    const value = selected(canonicalPublicScope({ ...legacyScope, projects }), { snapshot: "s1" });
    await assert.rejects(
      () => exportPage("https://synthetic.invalid/api/v1", value, "json", new AbortController().signal, {}),
      /query_too_large/,
    );
    assert.throws(() => selection("?project=" + Array(100).fill("A".repeat(42)).join(",")), /selection_too_large/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
