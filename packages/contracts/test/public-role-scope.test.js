import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeFilterKey, publicScopeKey, publicScopeParameters } from "../dist/index.js";

const legacy = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };

test("role unions have a detached v3 identity while v1 and membership-v2 bytes stay frozen", () => {
  const membership = canonicalPublicScope({ ...legacy, context: "current", projects: ["PVT_A"] });
  assert.equal(
    JSON.stringify(membership),
    '{"organization":"Pick-Your-AI","repository":null,"workstream":null,"start":null,"end":null,"schemaVersion":"public-scope/v2","context":"current","projects":["PVT_A"]}',
  );
  assert.equal(
    publicScopeKey(membership),
    '["Pick-Your-AI",null,null,null,null,["public-scope/v2","current",["PVT_A"]]]',
  );
  assert.deepEqual(canonicalPublicScope({ ...legacy, roles: [] }), legacy);
  const input = { ...legacy, roles: ["reviewer", "author", "author"], projects: ["PVT_B", "PVT_A"] };
  const scope = canonicalPublicScope(input);
  assert.deepEqual(scope, {
    ...legacy,
    schemaVersion: "public-scope/v3",
    context: "event",
    projects: ["PVT_A", "PVT_B"],
    roles: ["author", "reviewer"],
  });
  assert.equal(
    publicScopeKey(scope),
    '["Pick-Your-AI",null,null,null,null,["public-scope/v3","event",["PVT_A","PVT_B"],["author","reviewer"]]]',
  );
  assert.deepEqual(publicScopeParameters(scope), {
    organization: "Pick-Your-AI",
    context: "event",
    project: "PVT_A,PVT_B",
    role: "author,reviewer",
  });
  input.roles.length = 0;
  input.projects.length = 0;
  assert.deepEqual(scope.roles, ["author", "reviewer"]);
  assert.deepEqual(scope.projects, ["PVT_A", "PVT_B"]);
  assert.deepEqual(canonicalPublicScope(scope), scope);
});

test("role-only selections explicitly retain event context and an empty Project lens", () => {
  const scope = canonicalPublicScope({ ...legacy, roles: ["reporter"] });
  assert.equal(scope.schemaVersion, "public-scope/v3");
  assert.equal(scope.context, "event");
  assert.deepEqual(scope.projects, []);
  assert.deepEqual(publicScopeParameters(scope), { organization: "Pick-Your-AI", context: "event", role: "reporter" });
});

test("role identity joins every existing dimension without merging comparison windows", () => {
  const scope = canonicalPublicScope({
    ...legacy,
    context: "current",
    projects: ["PVT_A"],
    roles: ["author", "reviewer"],
  });
  const window = { ...scope, start: "2026-09-18T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
  assert.notEqual(publicScopeKey(scope), publicScopeKey(window));
  assert.equal(publicScopeFilterKey(scope), publicScopeFilterKey(window));
  assert.equal(publicScopeKey(scope), publicScopeKey({ ...scope, roles: ["reviewer", "author", "author"] }));
  for (const patch of [
    { roles: ["author"] },
    { roles: ["reviewer"] },
    { projects: [] },
    { context: "event" },
    { organization: "Other" },
    { repository: "2" },
    { workstream: "research" },
  ])
    assert.notEqual(publicScopeFilterKey(scope), publicScopeFilterKey({ ...scope, ...patch }));
  assert.notEqual(
    publicScopeFilterKey(scope),
    publicScopeFilterKey({ ...legacy, context: "current", projects: ["PVT_A"] }),
  );
});

test("unknown attribution and control authority are not admitted as contribution-role filters", () => {
  for (const roles of [
    null,
    "author",
    [""],
    ["unknown"],
    ["operator"],
    ["privacy"],
    ["admin"],
    ["AUTHOR"],
    ["author,reviewer"],
    [null],
    Array(1),
    Array(10).fill("author"),
  ])
    assert.throws(() => canonicalPublicScope({ ...legacy, roles }), /invalid_public_scope/);
  assert.throws(
    () => canonicalPublicScope({ ...legacy, projects: Array(1), roles: ["author"] }),
    /invalid_public_scope/,
  );
});

test("explicit versions cannot omit dimensions or smuggle roles into frozen v2", () => {
  for (const patch of [
    { schemaVersion: "public-scope/v2", context: "current", projects: [], roles: [] },
    { schemaVersion: "public-scope/v2", context: "current", projects: [], roles: ["author"] },
    { schemaVersion: "public-scope/v3", context: "current", projects: [] },
    { schemaVersion: "public-scope/v3", context: "current", projects: [], roles: [] },
    { schemaVersion: "public-scope/v3", projects: [], roles: ["author"] },
    { schemaVersion: "public-scope/v3", context: "event", roles: ["author"] },
    { schemaVersion: "public-scope/v4", context: "event", projects: [], roles: ["author"] },
  ])
    assert.throws(() => canonicalPublicScope({ ...legacy, ...patch }), /invalid_public_scope/);
});
