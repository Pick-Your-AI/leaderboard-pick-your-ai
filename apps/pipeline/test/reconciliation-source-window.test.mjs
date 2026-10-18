import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";

const repository = {
  id: 2,
  installationId: 1,
  slug: "synthetic-owner/repository",
  families: [
    "issues",
    "comments",
    "pull_requests",
    "reviews",
    "commits",
    "releases",
    "timelines",
    "discussions",
    "project_current",
    "relationships",
  ],
};
const since = "2026-10-01T12:00:00.250Z";
const until = "2026-10-02T12:00:00.000Z";
const request = {
  repositoryId: 2,
  runId: "synthetic-recent-window",
  mode: "reconcile",
  since,
  until,
  cursor: null,
  limit: 100,
};
const item = (id, updated) => ({
  id,
  node_id: "I_" + id,
  number: id,
  html_url: "https://github.com/" + repository.slug + "/issues/" + id,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: updated,
  state: "open",
  body: "synthetic source observation",
});
const makeSource = (overrides = {}) =>
  createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    client: syntheticRepositoryClient(2, {
      rest: async () => ({ id: 2, private: false, full_name: repository.slug }),
      ...overrides,
    }),
  });

for (const family of ["issues", "comments"]) {
  test(family + " uses the supported updated filter and retains exact boundary/current observations", async () => {
    const calls = [];
    const source = makeSource({
      scanRest: async (options) => {
        calls.push(options);
        return options.select([
          item(1, "2026-10-01T12:00:00.249Z"),
          item(2, since),
          item(3, "2026-10-02T00:00:00Z"),
          item(4, "2026-10-03T00:00:00Z"),
        ]);
      },
    });
    const page = await source.readPage({ ...request, family });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url, "https://api.github.com");
    assert.equal(url.searchParams.get("since"), "2026-10-01T11:59:59Z");
    assert.equal(url.searchParams.get("sort"), "updated");
    assert.equal(url.searchParams.get("direction"), "asc");
    assert.equal(url.searchParams.has("until"), false);
    assert.deepEqual(
      page.facts.map((fact) => fact.subjectId),
      ["I_2", "I_3", "I_4"],
    );
    assert.equal(page.expectedCount, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      page.facts.every(
        (fact) => fact.evidence === "current_state" && fact.actorId === null && fact.occurredAt === null,
      ),
    );
  });
}

test("recent issue collection filters pulls while preserving the complete selected output count", async () => {
  const source = makeSource({
    scanRest: async (options) =>
      options.select([item(1, since), { ...item(2, since), pull_request: { url: "synthetic" } }, item(3, since)]),
  });
  const first = await source.readPage({ ...request, family: "issues", limit: 1 });
  const second = await source.readPage({ ...request, family: "issues", limit: 1, cursor: first.nextCursor });
  assert.deepEqual([first.facts[0].subjectId, second.facts[0].subjectId], ["I_1", "I_3"]);
  assert.equal(first.expectedCount, 2);
  assert.equal(second.expectedCount, 2);
  assert.equal(second.nextCursor, null);
});

for (const family of [
  "pull_requests",
  "reviews",
  "commits",
  "releases",
  "timelines",
  "discussions",
  "project_current",
]) {
  test(family + " cannot silently claim a supported recent change window", async () => {
    let reads = 0;
    const source = makeSource({
      scanRest: async () => {
        reads++;
        return [];
      },
    });
    await assert.rejects(source.readPage({ ...request, family }), /source_recent_window_unsupported/);
    assert.equal(reads, 0);
  });
}

test("bounded windows reject invalid/reversed timestamps before any source page", async () => {
  const source = makeSource({
    scanRest: async () => {
      throw Error("unexpected_source_page");
    },
  });
  for (const changes of [
    { since: "2026-02-30T00:00:00.000Z" },
    { since: until },
    { until: "2026-10-01T00:00:00.000Z" },
    { since: "2026-10-01T12:00:00.250Z\n" },
  ])
    await assert.rejects(source.readPage({ ...request, family: "issues", ...changes }), /invalid_source_window/);
});

test("malformed updated timestamps cannot disappear from a bounded inventory", async () => {
  for (const updated of [null, "2026-02-30T00:00:00Z", "not-a-clock"]) {
    const source = makeSource({ scanRest: async (options) => options.select([item(1, updated)]) });
    await assert.rejects(source.readPage({ ...request, family: "issues" }), /source_window_timestamp_unverified/);
  }
});

test("full audits preserve the unfiltered repository route", async () => {
  const calls = [];
  const source = makeSource({
    scanRest: async (options) => {
      calls.push(options);
      return options.select([item(1, "2026-09-01T00:00:00Z")]);
    },
  });
  const page = await source.readPage({ ...request, mode: "audit", since: null, family: "issues" });
  const url = new URL(calls[0].url, "https://api.github.com");
  assert.equal(url.searchParams.has("since"), false);
  assert.equal(url.searchParams.get("sort"), "created");
  assert.equal(page.facts.length, 1);
});

test("typed recent history visits all authorized parents and clips only source-owned event times", async () => {
  const restCalls = [],
    graphCalls = [];
  const event = (id, createdAt) => ({
    id,
    createdAt,
    __typename: "ParentIssueAddedEvent",
    actor: null,
    parent: {
      id: "I_parent",
      url: "https://github.com/" + repository.slug + "/issues/50",
      repository: { databaseId: 2, isPrivate: false },
    },
  });
  const source = makeSource({
    scanRest: async (options) => {
      restCalls.push(options);
      return options.select([item(1, "2026-09-01T00:00:00Z"), item(2, "2026-09-02T00:00:00Z")]);
    },
    scanGraphql: async (options) => {
      graphCalls.push(options);
      const number = options.variables.number;
      return options.select({
        repository: {
          databaseId: 2,
          isPrivate: false,
          issue: {
            id: "I_" + number,
            url: "https://github.com/" + repository.slug + "/issues/" + number,
            timelineItems: {
              nodes:
                number === 1
                  ? [
                      event("E_old", "2026-10-01T12:00:00.249Z"),
                      event("E_edge", since),
                      event("E_end", until),
                      event("E_future", "2026-10-03T00:00:00Z"),
                    ]
                  : [event("E_second_parent", "2026-10-02T00:00:00Z")],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }).nodes;
    },
  });
  const page = await source.readPage({ ...request, family: "relationships" });
  assert.equal(new URL(restCalls[0].url, "https://api.github.com").searchParams.has("since"), false);
  assert.deepEqual(
    graphCalls.map((call) => call.variables.number),
    [1, 2],
  );
  assert.ok(
    graphCalls.every((call) => call.variables.since === "2026-10-01T11:59:59Z" && /since:\s*\$since/.test(call.query)),
  );
  assert.deepEqual(
    page.facts.map((fact) => fact.subjectId),
    ["E_edge", "E_end", "E_second_parent"],
  );
  assert.ok(page.facts.every((fact) => fact.actorId === null && fact.evidence === "observed_transition"));
  assert.equal(page.expectedCount, 3);
});

test("an interrupted recent source read retains its failure instead of reporting an empty completed window", async () => {
  const source = makeSource({
    scanRest: async () => {
      throw Error("synthetic_pagination_incomplete");
    },
  });
  await assert.rejects(source.readPage({ ...request, family: "issues" }), /synthetic_pagination_incomplete/);
});
