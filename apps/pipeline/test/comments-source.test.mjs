import assert from "node:assert/strict";
import test from "node:test";
import { GithubReadClient } from "../../../packages/github/dist/index.js";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";

const origin = "https://api.synthetic.invalid";
const slug = "synthetic-owner/repository";
const repository = { id: 2, installationId: 1, slug, families: ["comments"] };
const at = "2026-10-01T12:00:00Z";
const request = { repositoryId: 2, runId: "synthetic-comments-v1", family: "comments", cursor: null, limit: 1 };
const comment = (id, kind = "conversation", updated = at) => ({
  id,
  node_id: (kind === "inline" ? "PRRC_" : "IC_") + id,
  url: "https://api.github.com/repos/" + slug + (kind === "inline" ? "/pulls/comments/" : "/issues/comments/") + id,
  html_url: "https://github.com/" + slug + "/pull/7#" + (kind === "inline" ? "discussion_r" : "issuecomment-") + id,
  ...(kind === "inline"
    ? { pull_request_url: "https://api.github.com/repos/" + slug + "/pulls/7", pull_request_review_id: 90 }
    : { issue_url: "https://api.github.com/repos/" + slug + "/issues/7" }),
  body: "synthetic comment body",
  created_at: at,
  updated_at: updated,
  user: { id: 42, node_id: "U_42", type: "User", login: "synthetic-author" },
});
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const source = (fetch, checkpoints = syntheticCheckpointStore()) =>
  createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    includePullRequestReviewComments: () => true,
    client: new GithubReadClient({
      apiOrigin: origin,
      token: async () => undefined,
      checkpoints,
      fetch,
      maxRetries: 0,
    }),
  });

test("comments inventory traverses issue conversation and inline pages before reporting a combined count", async () => {
  const calls = [];
  const read = source(async (url, options) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname + parsed.search);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.get("x-github-api-version"), "2022-11-28");
    if (parsed.pathname === "/repos/" + slug) return json({ id: 2, private: false, full_name: slug });
    if (parsed.pathname.endsWith("/issues/comments")) {
      if (parsed.searchParams.get("page") === "2") return json([comment(11)]);
      return json([comment(10)], 200, {
        link: "<" + origin + "/repos/" + slug + '/issues/comments?per_page=100&page=2>; rel="next"',
      });
    }
    if (parsed.pathname.endsWith("/pulls/comments")) return json([comment(10, "inline")]);
    throw new Error("unexpected synthetic endpoint");
  });
  const first = await read.readPage(request);
  assert.equal(first.expectedCount, 3);
  assert.equal(first.nextCursor, "1");
  const second = await read.readPage({ ...request, cursor: first.nextCursor });
  const third = await read.readPage({ ...request, cursor: second.nextCursor });
  assert.deepEqual(
    [first, second, third].flatMap((page) => page.facts.map((fact) => fact.subjectId)),
    ["IC_10", "IC_11", "PRRC_10"],
  );
  assert.equal(third.nextCursor, null);
  for (const page of [first, second, third]) {
    assert.equal(page.expectedCount, 3);
    assert.equal(page.facts[0].actorId, null);
    assert.equal(page.facts[0].occurredAt, null);
    assert.equal(page.facts[0].evidence, "current_state");
    assert.equal(JSON.stringify(page).includes("synthetic comment body"), false);
  }
  assert.equal(calls.filter((path) => path.includes("/issues/comments")).length, 2);
  assert.equal(calls.filter((path) => path.includes("/pulls/comments")).length, 1);
});

test("an unavailable inline comment page cannot establish a complete comments count", async () => {
  const read = source(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/" + slug) return json({ id: 2, private: false, full_name: slug });
    if (parsed.pathname.endsWith("/issues/comments")) return json([comment(10)]);
    if (parsed.pathname.endsWith("/pulls/comments")) return json({}, 500);
    throw new Error("unexpected synthetic endpoint");
  });
  await assert.rejects(read.readPage(request), /GitHub source request failed/);
});

test("recent comments apply the same outward API overlap to both native inventories", async () => {
  const calls = [];
  const since = "2026-10-01T12:00:00.250Z",
    until = "2026-10-02T12:00:00.000Z";
  const read = source(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/" + slug) return json({ id: 2, private: false, full_name: slug });
    calls.push(parsed);
    const kind = parsed.pathname.endsWith("/pulls/comments") ? "inline" : "conversation";
    return json([comment(10, kind, "2026-10-03T12:00:00Z")]);
  });
  const page = await read.readPage({ ...request, mode: "reconcile", since, until, limit: 100 });
  assert.equal(page.expectedCount, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    new Set(calls.map((url) => url.pathname)),
    new Set(["/repos/" + slug + "/issues/comments", "/repos/" + slug + "/pulls/comments"]),
  );
  for (const url of calls) {
    assert.equal(url.searchParams.get("since"), "2026-10-01T11:59:59Z");
    assert.equal(url.searchParams.get("sort"), "updated");
    assert.equal(url.searchParams.get("direction"), "asc");
  }
  assert.ok(
    page.facts.every((fact) => fact.evidence === "current_state" && fact.actorId === null && fact.occurredAt === null),
  );
});
