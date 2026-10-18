import assert from "node:assert/strict";
import test from "node:test";
import { createGithubCollectionSource } from "../src/github-source.mjs";

const repository = { id: 2, installationId: 1, slug: "synthetic-owner/repository", families: ["reviews"] };
const request = { repositoryId: 2, runId: "synthetic", family: "reviews", cursor: null, limit: 1 };
const review = (id, pull) => ({
  id,
  node_id: `R_${id}`,
  submitted_at: "2026-10-01T12:00:00Z",
  html_url: `https://github.com/${repository.slug}/pull/${pull}#pullrequestreview-${id}`,
  state: "APPROVED",
});
const harness = (scan) =>
  createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    client: { rest: async () => ({ id: 2, private: false }), scanRest: scan },
  });

test("reviews traverse every pull and nested review list before exposing complete count", async () => {
  const calls = [];
  const source = harness(async (options) => {
    calls.push(options);
    return options.select(
      options.url.includes("/pulls?")
        ? [{ number: 1 }, { number: 2 }]
        : [review(options.url.includes("/pulls/1/") ? 11 : 22, options.url.includes("/pulls/1/") ? 1 : 2)],
    );
  });
  const page = await source.readPage(request);
  assert.equal(page.expectedCount, 2);
  assert.equal(page.nextCursor, "1");
  assert.equal(page.facts[0].subjectId, "R_11");
  assert.equal(page.facts[0].occurredAt, null);
  assert.equal(page.facts[0].actorId, null);
  assert.equal(page.facts[0].evidence, "current_state");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.key.includes(":2:synthetic:")));
});

test("incomplete nested review scan does not publish a partial cohort", async () => {
  const source = harness(async (options) => {
    if (options.url.includes("/pulls?")) return [{ number: 1 }, { number: 2 }];
    if (options.url.includes("/pulls/1/")) return [review(11, 1)];
    throw Error("pagination exhausted");
  });
  await assert.rejects(source.readPage(request), /pagination exhausted/);
});

test("duplicate or malformed pull identities cannot establish complete review inventory", async () => {
  for (const pulls of [[{ number: 1 }, { number: 1 }], [{ number: "1" }]]) {
    const source = harness(async (options) => (options.url.includes("/pulls?") ? pulls : []));
    await assert.rejects(source.readPage(request), /source_pull_identity_unverified/);
  }
});

test("Discussion source distinguishes disabled capability from an empty complete connection", async () => {
  let enabled = false;
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [{ ...repository, families: ["discussions"] }],
    isSynthetic: true,
    client: {
      rest: async () => ({ id: 2, private: false }),
      scanRest: async () => [],
      scanGraphql: async (options) =>
        options.select({
          repository: {
            databaseId: 2,
            isPrivate: false,
            hasDiscussionsEnabled: enabled,
            discussions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }).nodes,
    },
  });
  await assert.rejects(source.readPage({ ...request, family: "discussions" }), /discussions_source_unavailable/);
  enabled = true;
  const page = await source.readPage({ ...request, family: "discussions" });
  assert.equal(page.expectedCount, 0);
  assert.equal(page.nextCursor, null);
});

test("review dismissal and body edits change the frozen source revision", async () => {
  let value = review(11, 1);
  const source = harness(async (options) => (options.url.includes("/pulls?") ? [{ number: 1 }] : [value]));
  const approved = (await source.readPage(request)).facts[0];
  value = { ...value, state: "DISMISSED" };
  const dismissed = (await source.readPage(request)).facts[0];
  assert.notEqual(approved.sourceRevision, dismissed.sourceRevision);
  value = { ...value, body: "synthetic edited feedback" };
  const edited = (await source.readPage(request)).facts[0];
  assert.notEqual(dismissed.sourceRevision, edited.sourceRevision);
  assert.equal(JSON.stringify(edited).includes("synthetic edited feedback"), false);
});

test("review A to B to A observations retain distinct scan revisions", async () => {
  let value = review(11, 1);
  const source = harness(async (options) => (options.url.includes("/pulls?") ? [{ number: 1 }] : [value]));
  const a = (await source.readPage({ ...request, runId: "synthetic-a" })).facts[0];
  value = { ...value, state: "DISMISSED" };
  const b = (await source.readPage({ ...request, runId: "synthetic-b" })).facts[0];
  value = { ...value, state: "APPROVED" };
  const a2 = (await source.readPage({ ...request, runId: "synthetic-a2" })).facts[0];
  assert.notEqual(a.sourceRevision, b.sourceRevision);
  assert.notEqual(a.sourceRevision, a2.sourceRevision);
  assert.equal(a.sourceRevision.split(".")[0], a2.sourceRevision.split(".")[0]);
  assert.deepEqual((await source.readPage({ ...request, runId: "synthetic-a2" })).facts[0], a2);
});
