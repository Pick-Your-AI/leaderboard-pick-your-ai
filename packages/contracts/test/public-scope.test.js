import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeFilterKey, publicScopeKey, publicScopeParameters } from "../dist/index.js";

const legacy = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
test("legacy event scopes retain their exact five-field document and key bytes", () => {
  const bytes = '{"organization":"Pick-Your-AI","repository":null,"workstream":null,"start":null,"end":null}';
  const key = '["Pick-Your-AI",null,null,null,null]';
  for (const input of [legacy, { ...legacy, context: "event" }, { ...legacy, context: "event", projects: [] }]) {
    assert.equal(JSON.stringify(canonicalPublicScope(input)), bytes);
    assert.equal(publicScopeKey(input), key);
    assert.deepEqual(publicScopeParameters(input), { organization: "Pick-Your-AI" });
  }
});
test("new scopes carry an explicit basis and detached canonical Project union", () => {
  const input = { ...legacy, context: "current", projects: ["PVT_B=", "PVT_A", "PVT_A"] };
  const current = canonicalPublicScope(input);
  assert.deepEqual(current, {
    ...legacy,
    schemaVersion: "public-scope/v2",
    context: "current",
    projects: ["PVT_A", "PVT_B="],
  });
  input.projects.length = 0;
  assert.deepEqual(current.projects, ["PVT_A", "PVT_B="]);
  assert.equal(
    publicScopeKey(current),
    '["Pick-Your-AI",null,null,null,null,["public-scope/v2","current",["PVT_A","PVT_B="]]]',
  );
  assert.deepEqual(publicScopeParameters(current), {
    organization: "Pick-Your-AI",
    context: "current",
    project: "PVT_A,PVT_B=",
  });
  assert.deepEqual(canonicalPublicScope({ ...legacy, projects: ["PVT_A"] }), {
    ...legacy,
    schemaVersion: "public-scope/v2",
    context: "event",
    projects: ["PVT_A"],
  });
  assert.deepEqual(canonicalPublicScope({ ...legacy, context: "current" }).projects, []);
});
test("scope and comparison identities bind all membership dimensions", () => {
  const current = canonicalPublicScope({ ...legacy, context: "current", projects: ["PVT_A", "PVT_B"] });
  const nextWindow = { ...current, start: "2026-10-01T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
  assert.notEqual(publicScopeKey(current), publicScopeKey(nextWindow));
  assert.equal(publicScopeFilterKey(current), publicScopeFilterKey(nextWindow));
  for (const patch of [
    { context: "event" },
    { projects: ["PVT_A"] },
    { repository: "2" },
    { workstream: "engineering" },
    { organization: "Other" },
  ])
    assert.notEqual(publicScopeFilterKey(current), publicScopeFilterKey({ ...current, ...patch }));
});
test("scope parsing rejects malformed, ambiguous and over-budget configurations", () => {
  for (const patch of [
    { context: "latest" },
    { context: null },
    { projects: "PVT_A" },
    { projects: null },
    { projects: [""] },
    { projects: ["PVT_A,PVT_B"] },
    { projects: ["PVT with spaces"] },
    { projects: ["A".repeat(129)] },
    { projects: Array.from({ length: 101 }, (_, i) => `PVT_${i}`) },
    { schemaVersion: "public-scope/v3", context: "current", projects: [] },
    { schemaVersion: "public-scope/v2", context: "current" },
    { schemaVersion: "public-scope/v2", context: "event", projects: [] },
    { raw: "private payload" },
    { start: "2026-02-30T00:00:00.000Z", end: "2026-03-02T00:00:00.000Z" },
  ])
    assert.throws(() => canonicalPublicScope({ ...legacy, ...patch }), /invalid_public_scope/);
  for (const key of Object.keys(legacy)) {
    const value = { ...legacy };
    delete value[key];
    assert.throws(() => canonicalPublicScope(value), /invalid_public_scope/);
  }
});
