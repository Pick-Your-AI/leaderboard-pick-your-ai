import assert from "node:assert/strict";
import test from "node:test";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { githubDiscussionRevision } from "../../../packages/github/dist/index.js";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";

const repository = {
  id: 2,
  installationId: 1,
  slug: "synthetic-owner/repository",
  families: ["discussions"],
};
const selected = () => ({
  id: "D_SYNTHETIC_TIME",
  url: `https://github.com/${repository.slug}/discussions/4`,
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T12:00:00Z",
  answerChosenAt: "2026-10-07T12:00:00Z",
  author: { databaseId: 101, id: "U_SYNTHETIC_101", __typename: "User" },
  answerChosenBy: { databaseId: 202, id: "U_SYNTHETIC_202", __typename: "User" },
  answer: {
    id: "DC_SYNTHETIC_TIME",
    createdAt: "2026-10-07T11:00:00Z",
    isAnswer: true,
    author: { databaseId: 303, id: "U_SYNTHETIC_303", __typename: "User" },
  },
});
async function collect(value) {
  const queries = [];
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    client: syntheticRepositoryClient(2, {
      rest: async () => ({ id: 2, private: false, full_name: repository.slug }),
      scanRest: async () => [],
      scanGraphql: async (options) => {
        queries.push(options.query);
        return options.select({
          repository: {
            databaseId: 2,
            isPrivate: false,
            hasDiscussionsEnabled: true,
            discussions: { nodes: [value], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }).nodes;
      },
    }),
  });
  const page = await source.readPage({
    repositoryId: 2,
    runId: "synthetic-time",
    family: "discussions",
    cursor: null,
    limit: 100,
  });
  return { page, queries };
}

test("Discussion collection requests answer creation and binds it without retaining the raw source object", async () => {
  const value = selected();
  const { page, queries } = await collect(value);
  assert.match(queries[0], /answer\s*\{[^}]*\bcreatedAt\b/);
  assert.equal(page.expectedCount, 1);
  assert.equal(page.nextCursor, null);
  assert.equal(page.facts[0].sourceRevision.split(".")[0], githubDiscussionRevision(value));
  assert.equal(page.facts[0].evidence, "current_state");
  assert.equal(page.facts[0].actorId, null);
  assert.equal(page.facts[0].occurredAt, null);
  assert.equal(JSON.stringify(page.facts).includes("DC_SYNTHETIC_TIME"), false);
  assert.equal(JSON.stringify(page.facts).includes("U_SYNTHETIC_303"), false);
});

test("Discussion collection distinguishes answer-creation corrections when all parent and selection clocks stay fixed", async () => {
  const first = selected();
  const changed = structuredClone(first);
  changed.answer.createdAt = "2026-10-07T11:00:00.001Z";
  const a = (await collect(first)).page.facts[0];
  const b = (await collect(changed)).page.facts[0];
  assert.notEqual(a.sourceRevision, b.sourceRevision);
  assert.equal(a.subjectId, b.subjectId);
  assert.equal(a.sourceUrl, b.sourceUrl);
  assert.deepEqual((await collect(first)).page.facts[0], a);
});
