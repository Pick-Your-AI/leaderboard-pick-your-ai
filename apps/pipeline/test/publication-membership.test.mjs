import assert from "node:assert/strict";
import test from "node:test";
import { publicScopeKey } from "@pick-your-ai/contracts";
import { resolveMetricWindow } from "@pick-your-ai/metrics";
import {
  approvedPublicationScope,
  resolvePublicationWindow,
  resolvePublicationWindows,
  validatePublicationPeriods,
} from "../src/publication-windows.mjs";

const base = { organization: "synthetic-org", repository: null, workstream: null, start: null, end: null };
const cutoff = "2026-11-02T12:00:00.000Z";
const resolve = (template) => resolvePublicationWindow(template, cutoff, resolveMetricWindow);
const bases = [
  base,
  { ...base, context: "current", projects: [] },
  { ...base, context: "event", projects: ["PVT_synthetic_A"] },
  { ...base, context: "current", projects: ["PVT_synthetic_A"] },
  { ...base, context: "current", projects: ["PVT_synthetic_B"] },
  { ...base, context: "current", projects: ["PVT_synthetic_A", "PVT_synthetic_B"] },
];

test("named templates and resolved bounds distinguish every membership basis", () => {
  const templates = bases.map((scope) => ({ ...scope, period: "30d" }));
  assert.doesNotThrow(() => validatePublicationPeriods(templates));
  const resolved = resolvePublicationWindows(templates, cutoff, resolveMetricWindow);
  assert.equal(resolved.length, templates.length);
  assert.equal(new Set(resolved.map(({ scope }) => publicScopeKey(scope))).size, templates.length);
  for (const { scope, window } of resolved) {
    assert.equal(scope.start, "2026-10-03T12:00:00.000Z");
    assert.equal(scope.end, cutoff);
    assert.equal(window.period, "30d");
    assert.equal(Object.hasOwn(scope, "period"), false);
  }
});

test("an approved named or exact template cannot authorize another membership lens", () => {
  const templates = bases.map((scope) => ({ ...scope, period: "30d" }));
  const scopes = templates.map((template) => resolve(template).scope);
  for (const [i, template] of templates.entries()) {
    for (const [j, scope] of scopes.entries()) {
      assert.equal(approvedPublicationScope([template], scope, resolveMetricWindow), i === j, `named ${i}/${j}`);
      assert.equal(approvedPublicationScope([scopes[i]], scope, resolveMetricWindow), i === j, `exact ${i}/${j}`);
    }
  }
});

test("period resolution preserves exact legacy bytes and detaches canonical Project sets", () => {
  const alias = { ...base, context: "event", projects: [], period: "all" };
  const legacy = resolve(alias).scope;
  assert.equal(JSON.stringify(legacy), JSON.stringify(base));
  assert.equal(publicScopeKey(legacy), '["synthetic-org",null,null,null,null]');
  assert.deepEqual(alias, { ...base, context: "event", projects: [], period: "all" });
  const template = {
    ...base,
    context: "current",
    projects: ["PVT_synthetic_B", "PVT_synthetic_A", "PVT_synthetic_B"],
    period: "30d",
  };
  const original = structuredClone(template);
  const selected = resolve(template).scope;
  assert.equal(selected.schemaVersion, "public-scope/v2");
  assert.deepEqual(selected.projects, ["PVT_synthetic_A", "PVT_synthetic_B"]);
  selected.projects.push("PVT_synthetic_detached");
  assert.deepEqual(template, original, "the approved configuration is never rewritten or shared with the result");
});

test("canonical aliases collide only within the same complete template identity", () => {
  const project = { ...base, context: "current", projects: ["PVT_synthetic_A", "PVT_synthetic_B"] };
  const alias = { ...project, projects: ["PVT_synthetic_B", "PVT_synthetic_A", "PVT_synthetic_B"] };
  for (const period of [undefined, "all", "30d"]) {
    assert.throws(
      () =>
        validatePublicationPeriods([
          { ...project, period },
          { ...alias, period },
        ]),
      /duplicate_public_scope/,
    );
  }
  assert.throws(
    () => validatePublicationPeriods([base, { ...base, context: "event", projects: [], period: "all" }]),
    /duplicate_public_scope/,
  );
  const templates = [
    { ...base, period: "month" },
    { ...project, period: "quarter" },
  ];
  assert.doesNotThrow(() => resolvePublicationWindows(templates, "2026-10-18T12:00:00.000Z", resolveMetricWindow));
  assert.throws(
    () =>
      resolvePublicationWindows(
        [
          { ...project, period: "month" },
          { ...alias, period: "quarter" },
        ],
        "2026-10-18T12:00:00.000Z",
        resolveMetricWindow,
      ),
    /ambiguous_public_period_bounds/,
  );
});

test("template metadata never admits malformed or unknown public-scope fields", () => {
  for (const patch of [
    { context: "future" },
    { context: "current", projects: [], schemaVersion: "public-scope/v999" },
    { context: "current", projects: ["PVT_synthetic_A"], extraScope: true },
    { context: "current", projects: Array.from({ length: 101 }, (_, i) => `PVT_synthetic_${i}`) },
  ]) {
    const template = { ...base, ...patch, period: "30d" };
    assert.throws(() => validatePublicationPeriods([template]), /invalid_public_scope/);
    assert.throws(() => resolve(template), /invalid_public_scope/);
  }
});

test("named role unions preserve every canonical lens without widening approval", () => {
  const membership = { ...base, context: "current", projects: ["PVT_synthetic_B", "PVT_synthetic_A"] };
  const templates = [[], ["reporter"], ["author"], ["reporter", "author", "reporter"]].map((roles) => ({
    ...membership,
    roles,
    period: "30d",
  }));
  const original = structuredClone(templates);
  assert.doesNotThrow(() => validatePublicationPeriods(templates));
  const scopes = resolvePublicationWindows(templates, cutoff, resolveMetricWindow).map(({ scope }) => scope);
  assert.equal(new Set(scopes.map(publicScopeKey)).size, templates.length);
  assert.equal(scopes[0].schemaVersion, "public-scope/v2");
  assert.equal(Object.hasOwn(scopes[0], "roles"), false);
  assert.deepEqual(scopes[3].roles, ["author", "reporter"]);
  assert.equal(scopes[3].schemaVersion, "public-scope/v3");
  assert.equal(scopes[3].end, cutoff);
  for (const [i, template] of templates.entries()) {
    for (const [j, scope] of scopes.entries()) {
      assert.equal(approvedPublicationScope([template], scope, resolveMetricWindow), i === j, `named role ${i}/${j}`);
      assert.equal(approvedPublicationScope([scopes[i]], scope, resolveMetricWindow), i === j, `exact role ${i}/${j}`);
    }
  }
  assert.throws(
    () => validatePublicationPeriods([templates[3], { ...templates[3], roles: ["author", "reporter"] }]),
    /duplicate_public_scope/,
  );
  scopes[3].roles.push("reviewer");
  scopes[3].projects.push("PVT_synthetic_detached");
  assert.deepEqual(templates, original, "resolving a role window never mutates approved configuration arrays");
});
