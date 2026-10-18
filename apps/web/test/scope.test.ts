import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultScope,
  parseScope,
  resolveWindow,
  serializeScope,
  scopedHref,
  mayFollowUpdates,
} from "../src/lib/scope.ts";

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
  assert.equal(
    serializeScope(scope, { q: "review", family: "triage", empty: "" }),
    "?period=7d&family=triage&q=review",
  );
});

test("custom windows are half-open and require both bounds", () => {
  const ok = parseScope("?from=2026-10-01&to=2026-10-08", context);
  assert.equal(ok.scope.period, "custom");
  assert.equal(ok.issues.length, 0);
  const window = resolveWindow(ok.scope, new Date("2026-10-17T12:00:00Z"));
  assert.equal(window.start?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-10-08T00:00:00.000Z");

  for (const bad of [
    "?from=2026-10-08&to=2026-10-01",
    "?from=2026-10-01",
    "?from=2026-02-30&to=2026-03-02",
    "?period=custom",
  ]) {
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
  assert.deepEqual(
    issues.map((issue) => issue.param),
    ["period", "repo", "actor", "snapshot", "density"],
  );
});

test("rolling and calendar windows resolve against the snapshot cutoff in UTC", () => {
  const cutoff = new Date("2026-10-17T12:00:00Z");
  const at = (period: string) =>
    resolveWindow({ ...defaultScope, period: period as typeof defaultScope.period }, cutoff);
  assert.equal(at("30d").start?.toISOString(), "2026-09-17T12:00:00.000Z");
  assert.equal(at("quarter").start?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(at("quarter").label, "Q4 2026");
  assert.equal(at("year").start?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(at("all").start, null);
  assert.equal(at("7d").end.toISOString(), cutoff.toISOString());
});

test("cross-route journeys preserve global scope without leaking route controls", () => {
  const selected = parseScope(
    "?period=90d&repo=r1&project=p1&actor=automation&snapshot=s1&density=compact&q=triage&proof=reader",
    context,
  ).scope;
  for (const path of [
    "/",
    "/leaderboards",
    "/contributors/reader",
    "/contributions/receipt",
    "/methodology/triage",
    "/coverage",
    "/live",
  ]) {
    const href = scopedHref(path, selected);
    const url = new URL(href, "https://prototype.example");
    assert.equal(url.pathname, path);
    assert.deepEqual(parseScope(url.search, context).scope, selected);
    assert.equal(url.searchParams.has("q"), false);
    assert.equal(url.searchParams.has("proof"), false);
  }
});

test("follow mode cannot resume while keyboard, pointer or proof remains engaged", () => {
  assert.equal(mayFollowUpdates(false, true, false), false, "pointer leave must not release keyboard engagement");
  assert.equal(mayFollowUpdates(true, false, false), false, "blur must not release pointer engagement");
  assert.equal(mayFollowUpdates(false, false, true), false);
  assert.equal(mayFollowUpdates(false, false, false), true);
});

test("invalid custom bounds use the stated default even alongside a valid preset", () => {
  for (const period of ["7d", "30d", "90d", "all", "month", "quarter", "year", "custom"]) {
    for (const bounds of [
      "from=invalid&to=2026-10-01",
      "from=2026-10-01",
      "to=2026-10-01",
      "from=2026-10-08&to=2026-10-01",
      "from=2026-10-01&to=2026-10-01",
    ]) {
      const search = `?period=${period}&${bounds}&repo=r1&project=p1&actor=automation&snapshot=s1&density=compact`;
      const parsed = parseScope(search, context);
      assert.deepEqual(
        parsed.scope,
        {
          ...defaultScope,
          repos: ["r1"],
          projects: ["p1"],
          actor: "automation",
          snapshot: "s1",
          density: "compact",
        },
        search,
      );
      assert.deepEqual(
        parsed.issues.map((issue) => issue.param),
        ["from/to"],
        search,
      );
      assert.match(parsed.issues[0]!.message, /Showing the last 30 days instead/, search);
      assert.deepEqual(parseScope(serializeScope(parsed.scope), context), {
        scope: parsed.scope,
        issues: [],
      });
    }
  }
});

test("valid custom bounds still take precedence over a named preset", () => {
  const parsed = parseScope("?period=90d&from=2026-09-01&to=2026-10-01", context);
  assert.equal(parsed.scope.period, "custom");
  assert.equal(parsed.scope.from, "2026-09-01");
  assert.equal(parsed.scope.to, "2026-10-01");
  assert.deepEqual(parsed.issues, []);
  assert.equal(serializeScope(parsed.scope), "?from=2026-09-01&to=2026-10-01");
});

test("multiple repository and Program selections survive canonical copied links", () => {
  const multiContext = { ...context, projectIds: ["p1", "p2"] };
  const parsed = parseScope("?repo=r2,r1&repo=r2&project=p2,p1&project=p2&snapshot=s1", multiContext);
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.scope.repos, ["r1", "r2"]);
  assert.deepEqual(parsed.scope.projects, ["p1", "p2"]);
  const canonical = serializeScope(parsed.scope);
  assert.equal(canonical, "?repo=r1%2Cr2&project=p1%2Cp2&snapshot=s1");
  assert.deepEqual(parseScope(canonical, multiContext), parsed);
});

test("an invalid preset explains the valid custom window that actually applies", () => {
  const parsed = parseScope("?period=fortnight&from=2026-09-01&to=2026-10-01", context);
  assert.equal(parsed.scope.period, "custom");
  assert.equal(parsed.scope.from, "2026-09-01");
  assert.equal(parsed.scope.to, "2026-10-01");
  assert.deepEqual(
    parsed.issues.map(({ param, value }) => ({ param, value })),
    [{ param: "period", value: "fortnight" }],
  );
  assert.match(parsed.issues[0]!.message, /Using the valid custom UTC dates instead/);
  assert.doesNotMatch(parsed.issues[0]!.message, /last 30 days/);
  const canonical = serializeScope(parsed.scope);
  assert.equal(canonical, "?from=2026-09-01&to=2026-10-01");
  assert.deepEqual(parseScope(canonical, context), { scope: parsed.scope, issues: [] });
});
