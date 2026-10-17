import assert from "node:assert/strict";
import test from "node:test";
import { defaultScope, parseScope, resolveWindow, serializeScope } from "../src/lib/scope.ts";

const context = { repoIds: ["r1", "r2"], projectIds: ["p1"], snapshotIds: ["s1", "s2"] };

test("defaults serialize to an empty query", () => {
  assert.equal(serializeScope(defaultScope), "");
  assert.deepEqual(parseScope("", context), { scope: defaultScope, issues: [] });
});

test("a copied URL round-trips to the same scope", () => {
  const search = "?period=90d&repo=r2,r1&project=p1&actor=all&snapshot=s1&density=compact";
  const { scope, issues } = parseScope(search, context);
  assert.deepEqual(issues, []);
  const serialized = serializeScope(scope);
  assert.equal(serialized, "?period=90d&repo=r1%2Cr2&project=p1&actor=all&snapshot=s1&density=compact");
  assert.deepEqual(parseScope(serialized, context).scope, scope);
});

test("route parameters follow scope parameters in stable order", () => {
  const { scope } = parseScope("?period=7d", context);
  assert.equal(serializeScope(scope, { q: "review", family: "triage", empty: "" }), "?period=7d&family=triage&q=review");
});

test("custom windows are half-open and require both bounds", () => {
  const ok = parseScope("?from=2026-10-01&to=2026-10-08", context);
  assert.equal(ok.scope.period, "custom");
  assert.equal(ok.issues.length, 0);
  const window = resolveWindow(ok.scope, new Date("2026-10-17T12:00:00Z"));
  assert.equal(window.start?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-10-08T00:00:00.000Z");

  for (const bad of ["?from=2026-10-08&to=2026-10-01", "?from=2026-10-01", "?from=2026-02-30&to=2026-03-02", "?period=custom"]) {
    const parsed = parseScope(bad, context);
    assert.equal(parsed.scope.period, "30d", bad);
    assert.equal(parsed.issues.length, 1, bad);
  }
});

test("invalid values produce visible issues instead of silent substitution", () => {
  const { scope, issues } = parseScope("?period=fortnight&repo=r1,nope&actor=humans&snapshot=s9&density=tiny", context);
  assert.equal(scope.period, "30d");
  assert.deepEqual(scope.repos, ["r1"]);
  assert.equal(scope.actor, "user");
  assert.equal(scope.snapshot, null);
  assert.equal(scope.density, "comfortable");
  assert.deepEqual(issues.map((issue) => issue.param), ["period", "repo", "actor", "snapshot", "density"]);
});

test("rolling and calendar windows resolve against the snapshot cutoff in UTC", () => {
  const cutoff = new Date("2026-10-17T12:00:00Z");
  const at = (period: string) => resolveWindow({ ...defaultScope, period: period as typeof defaultScope.period }, cutoff);
  assert.equal(at("30d").start?.toISOString(), "2026-09-17T12:00:00.000Z");
  assert.equal(at("quarter").start?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(at("quarter").label, "Q4 2026");
  assert.equal(at("year").start?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(at("all").start, null);
  assert.equal(at("7d").end.toISOString(), cutoff.toISOString());
});
