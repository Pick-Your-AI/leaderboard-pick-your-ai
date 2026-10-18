import assert from "node:assert/strict";
import test from "node:test";
import { parameters, portfolioParameters, selection, uiHref } from "../src/remote/client.ts";
import { proofHref } from "../src/remote/proof.ts";
import { readWallQuery, wallHref } from "../src/remote/wall.ts";
import { parseScope, resolveWindow, routeParams, scopedHref, serializeScope } from "../src/lib/scope.ts";

test("the prototype preserves a selected display timezone without changing its UTC window", () => {
  const query = "?from=2026-11-01&to=2026-11-02&snapshot=s1&tz=America%2FNew_York";
  const chosen = parseScope(query);
  assert.deepEqual(chosen.issues, []);
  assert.equal(chosen.scope.timeZone, "America/New_York");
  assert.equal(new URLSearchParams(serializeScope(chosen.scope)).get("tz"), "America/New_York");
  assert.deepEqual(parseScope(serializeScope(chosen.scope)).scope, chosen.scope);
  assert.equal(routeParams(query).tz, undefined);
  for (const path of ["/", "/contributors", "/methodology", "/coverage", "/live"])
    assert.equal(
      new URL(scopedHref(path, chosen.scope), "https://example.invalid").searchParams.get("tz"),
      "America/New_York",
    );
  const cutoff = new Date("2026-11-03T00:00:00.000Z");
  assert.deepEqual(
    resolveWindow(chosen.scope, cutoff),
    resolveWindow(parseScope(query.replace(/&tz=.*/, "")).scope, cutoff),
  );
});

test("API navigation and proof retain display timezone while source and export parameters exclude it", () => {
  const query =
    "?organization=Pick-Your-AI&repository=repo-1&start=2026-11-01T00%3A00%3A00.000Z&end=2026-11-02T00%3A00%3A00.000Z&snapshot=s1&actors=user&tz=America%2FNew_York";
  const chosen = selection(query);
  const utc = selection(query.replace(/&tz=.*/, ""));
  assert.equal(chosen.timeZone, "America/New_York");
  for (const [first, second] of [
    [parameters(chosen), parameters(utc)],
    [parameters(chosen, { board: true }), parameters(utc, { board: true })],
    [portfolioParameters(chosen, true), portfolioParameters(utc, true)],
  ])
    assert.equal(first!.toString(), second!.toString());
  for (const path of ["/", "/contributors", "/methodology", "/coverage", "/live"])
    assert.equal(new URL(uiHref(path, chosen), "https://example.invalid").searchParams.get("tz"), "America/New_York");
  assert.equal(
    new URL(proofHref("/leaderboards/pr_merged", chosen, "e1"), "https://example.invalid").searchParams.get("tz"),
    "America/New_York",
  );
  const wall = wallHref(chosen, { mode: "frozen", boards: ["pr_merged"], interval: 30, format: "landscape" }, "s1");
  assert.equal(readWallQuery(new URL(wall, "https://example.invalid").search).selected.timeZone, "America/New_York");
});

test("invalid or duplicate timezones are explicit before API reads; prototype explains its UTC fallback", () => {
  for (const query of [
    "?tz=",
    "?tz=Mars%2FOlympus",
    "?tz=UTC&tz=America%2FNew_York",
    "?tz=%20UTC",
    `?tz=${"A".repeat(129)}`,
  ]) {
    assert.throws(() => selection(query));
    const parsed = parseScope(query);
    assert.equal(parsed.scope.timeZone, "UTC");
    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0]!.param, "tz");
  }
  assert.equal(parseScope("").scope.timeZone, "UTC");
  assert.equal(selection("").timeZone, "UTC");
  assert.equal(new URL(uiHref("/", selection("?tz=UTC")), "https://example.invalid").searchParams.has("tz"), false);
});
