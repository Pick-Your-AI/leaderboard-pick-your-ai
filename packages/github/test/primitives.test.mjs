import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGithubFailure,
  nextRestLink,
  paginateGraphql,
  paginateRest,
  readableOutcome,
} from "../dist/index.js";

const API = "https://api.github.test";

test("REST pagination follows next links and collects every page", async () => {
  const calls = [];
  const items = await paginateRest(`${API}/items?per_page=2`, async (url, request) => {
    calls.push(url);
    assert.equal(request.method, "GET");
    if (calls.length === 1) return { items: [1, 2], link: `<${API}/items?per_page=2&page=2>; rel="next"` };
    return { items: [3], link: null };
  }, { apiOrigin: API, maxPages: 3 });
  assert.deepEqual(items, [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test("REST pagination rejects cross-origin and unbounded links", async () => {
  await assert.rejects(() => paginateRest(`${API}/items`, async () => ({
    items: [], link: "<https://attacker.test/collect>; rel=next",
  }), { apiOrigin: API, maxPages: 3 }), /outside the configured/);
  await assert.rejects(() => paginateRest(`${API}/items`, async () => ({
    items: [], link: `<${API}/items?page=2>; rel=next`,
  }), { apiOrigin: API, maxPages: 1 }), /maxPages/);
});

test("REST Link parser finds next relation among other relations", () => {
  assert.equal(nextRestLink(`<${API}/items?page=1>; rel="prev", <${API}/items?page=3>; rel="next last"`), `${API}/items?page=3`);
  assert.equal(nextRestLink(null), undefined);
});

test("GraphQL pagination uses cursors and rejects partial/error results", async () => {
  const calls = [];
  const nodes = await paginateGraphql(async (variables) => {
    calls.push(variables);
    return calls.length === 1
      ? { nodes: ["a"], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } }
      : { nodes: ["b"], pageInfo: { hasNextPage: false, endCursor: "cursor-2" } };
  }, { first: 100, maxPages: 3 });
  assert.deepEqual(nodes, ["a", "b"]);
  assert.deepEqual(calls, [{ first: 100, after: null }, { first: 100, after: "cursor-1" }]);
  await assert.rejects(() => paginateGraphql(async () => ({
    nodes: ["partial"], pageInfo: { hasNextPage: false, endCursor: null }, errors: [{ message: "resource limit" }],
  }), { first: 1, maxPages: 2 }), /included errors/);
});

test("quota classification honors headers and keeps visibility unknown", () => {
  const headers = new Map([["retry-after", "12"]]);
  const result = classifyGithubFailure({
    status: 429,
    headers: { get: (name) => headers.get(name) ?? null },
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.deepEqual(result, {
    kind: "rate_limited", visibility: "unknown", retryAt: "2026-01-01T00:00:12.000Z", scope: "source",
  });
  assert.equal(classifyGithubFailure({ status: 404 }).kind, "not_found_or_hidden");
  assert.equal(classifyGithubFailure({ status: 401 }).kind, "authentication_required");
  assert.equal(classifyGithubFailure({ status: 403 }).kind, "permission_denied");
  assert.equal(readableOutcome(undefined).visibility, "unknown");
});

test("HTTP 429 without quota headers uses the source retry fallback", () => {
  assert.deepEqual(classifyGithubFailure({
    status: 429,
    now: new Date("2026-01-01T00:00:00Z"),
  }), {
    kind: "rate_limited",
    visibility: "unknown",
    retryAt: "2026-01-01T00:01:00.000Z",
    scope: "source",
  });
});

test("authorization errors retain their meaning when quota headers are also present", () => {
  const headers = new Headers({ "x-ratelimit-remaining": "0", "retry-after": "12" });
  assert.equal(classifyGithubFailure({ status: 401, headers }).kind, "authentication_required");
  assert.equal(classifyGithubFailure({ status: 404, headers }).kind, "not_found_or_hidden");
});

test("invalid retry-after and unrelated primary reset cannot shorten secondary fallback", () => {
  const headers = new Headers({ "retry-after": "1e300", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1767225601" });
  assert.equal(classifyGithubFailure({ status: 429, headers, now: new Date("2026-01-01T00:00:00Z") }).retryAt,
    "2026-01-01T00:01:00.000Z");
});
