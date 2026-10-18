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
