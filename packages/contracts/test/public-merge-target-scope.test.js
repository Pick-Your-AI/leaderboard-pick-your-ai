import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeKey, publicScopeFilterKey, publicScopeParameters } from "../dist/index.js";

const legacy = { organization: "Pick-Your-AI", repository: "2", workstream: null, start: null, end: null };
test("historical merge-target scopes use v4 without changing legacy, membership or role identities", () => {
  assert.equal(publicScopeKey(legacy), '["Pick-Your-AI","2",null,null,null]');
  assert.equal(canonicalPublicScope({ ...legacy, context: "current" }).schemaVersion, "public-scope/v2");
  assert.equal(canonicalPublicScope({ ...legacy, roles: ["author"] }).schemaVersion, "public-scope/v3");
  const scope = canonicalPublicScope({
    ...legacy,
    branch: "release/Δ=1",
    roles: ["author"],
    projects: ["PVT_B", "PVT_A"],
  });
  assert.deepEqual(scope, {
    ...legacy,
    schemaVersion: "public-scope/v4",
    context: "event",
    projects: ["PVT_A", "PVT_B"],
    roles: ["author"],
    branch: "release/Δ=1",
  });
  assert.equal(
    publicScopeKey(scope),
    '["Pick-Your-AI","2",null,null,null,["public-scope/v4","event",["PVT_A","PVT_B"],["author"],"release/Δ=1"]]',
  );
  assert.equal(publicScopeParameters(scope).branch, "release/Δ=1");
  assert.notEqual(publicScopeFilterKey(scope), publicScopeFilterKey({ ...scope, branch: "release/δ=1" }));
  assert.equal(
    publicScopeFilterKey(scope),
    publicScopeFilterKey({ ...scope, start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z" }),
  );
});
test("branch identity requires one repository and a complete canonical v4 envelope", () => {
  const valid = canonicalPublicScope({ ...legacy, branch: "main" });
  assert.deepEqual(valid.roles, []);
  for (const patch of [
    { repository: null },
    { branch: "" },
    { branch: "refs/../main" },
    { branch: "main\u0000hidden" },
    { branch: "\ud800" },
    { branch: "a".repeat(256) },
    { schemaVersion: "public-scope/v3" },
  ])
    assert.throws(() => canonicalPublicScope({ ...valid, ...patch }), /invalid_public_scope/);
  for (const key of ["context", "projects", "roles", "branch"]) {
    const missing = { ...valid };
    delete missing[key];
    assert.throws(() => canonicalPublicScope(missing), /invalid_public_scope/);
  }
});
