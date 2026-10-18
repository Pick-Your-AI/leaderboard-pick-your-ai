import assert from "node:assert/strict";
import test from "node:test";
import { prototypeNavigation } from "../src/lib/prototype-url.ts";

test("prototype links retain the complete scope, route controls and fragment in a fresh URL", () => {
  const original =
    "/leaderboards/pr_merged?repo=one%2Ctwo&project=web&period=custom&from=2026-09-01&to=2026-10-01&snapshot=s1&state=merged&date_basis=occurredAt&q=a%2Bb&tag=one&tag=two#receipt";
  const result = prototypeNavigation(original);
  const before = new URL(original, "https://example.test");
  const after = new URL(result.href, "https://example.test");
  assert.equal(result.clientSide, true);
  assert.equal(after.pathname, before.pathname);
  assert.equal(after.hash, before.hash);
  assert.deepEqual(after.searchParams.getAll("ui"), ["prototype"]);
  after.searchParams.delete("ui");
  assert.deepEqual([...after.searchParams], [...before.searchParams]);
});

test("prototype URL canonicalization is stable and emits one explicit mode", () => {
  for (const original of ["/", "/coverage?ui=prototype", "/live?ui=prototype&ui=prototype&mode=frozen#wall"]) {
    const once = prototypeNavigation(original);
    assert.deepEqual(prototypeNavigation(once.href), once);
    assert.deepEqual(new URL(once.href, "https://example.test").searchParams.getAll("ui"), ["prototype"]);
  }
});

test("explicit API and protected controls preserve their native navigation and exact URL", () => {
  for (const href of [
    "/?ui=api",
    "/live?ui=api&snapshot=s1",
    "/account",
    "/account/?next=%2Flive",
    "/admin///#access",
    "/admin?ui=prototype",
  ]) {
    assert.deepEqual(prototypeNavigation(href), { href, clientSide: false });
  }
});

test("external, relative and fragment destinations keep browser navigation", () => {
  for (const href of [
    "https://example.test/receipt",
    "//example.test/receipt",
    "/\\example.test/receipt",
    "mailto:reader@example.test",
    "../coverage",
    "#receipt",
  ]) {
    assert.deepEqual(prototypeNavigation(href), { href, clientSide: false });
  }
});
