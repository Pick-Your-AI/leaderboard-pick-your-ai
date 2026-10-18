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

test("timeline source retains actual event identity, actor and occurrence time", async () => {
  const event = {
    id: 901,
    event: "assigned",
    created_at: "2026-10-01T12:00:00Z",
    actor: { id: 3 },
    issue: { html_url: `https://github.com/${repository.slug}/issues/20` },
  };
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [{ ...repository, families: ["timelines"] }],
    client: { rest: async () => ({ id: 2, private: false }), scanRest: async (scan) => scan.select([event]) },
  });
  const page = await source.readPage({ ...request, family: "timelines" });
  assert.equal(page.facts[0].subjectId, "901");
  assert.equal(page.facts[0].evidence, "observed_transition");
  assert.equal(page.facts[0].actorId, "3");
  assert.equal(page.facts[0].occurredAt, "2026-10-01T12:00:00.000Z");
});

test("Project collector traverses subject memberships and current field snapshots", async () => {
  const calls = [];
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [{ ...repository, families: ["project_current"], allowedProjectIds: ["PVT_synthetic"] }],
    client: {
      graphql: async () => ({ node: { project: { id: "PVT_synthetic", public: true } } }),
      rest: async () => ({ id: 2, private: false }),
      scanRest: async () => [{ node_id: "I_synthetic" }],
      scanGraphql: async (scan) => {
        calls.push(scan.key);
        const node = scan.query.includes("ProjectV2Item {")
          ? {
              id: "PVTI_synthetic",
              updatedAt: "2026-10-01T12:00:00Z",
              isArchived: false,
              project: { id: "PVT_synthetic", public: true },
              content: {
                url: `https://github.com/${repository.slug}/issues/20`,
                repository: { databaseId: 2, isPrivate: false },
              },
              fieldValues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            }
          : {
              id: "I_synthetic",
              repository: { databaseId: 2, isPrivate: false },
              projectItems: {
                nodes: [{ id: "PVTI_synthetic", project: { id: "PVT_synthetic", public: true } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            };
        return scan.select({ node }).nodes;
      },
    },
  });
  const page = await source.readPage({ ...request, family: "project_current" });
  assert.equal(calls.length, 2);
  assert.equal(page.expectedCount, 1);
  assert.equal(page.facts[0].subjectId, "PVTI_synthetic");
  assert.equal(page.facts[0].actorId, null);
  assert.equal(page.facts[0].occurredAt, null);
  assert.equal(page.facts[0].evidence, "current_state");
});

test("selected relationship history enters collection as timestamped native transitions", async () => {
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [{ ...repository, families: ["relationships"] }],
    client: {
      rest: async () => ({ id: 2, private: false }),
      scanRest: async () => [{ number: 1 }],
      scanGraphql: async (scan) =>
        scan.select({
          repository: {
            databaseId: 2,
            isPrivate: false,
            issue: {
              id: "I_synthetic",
              url: `https://github.com/${repository.slug}/issues/1`,
              timelineItems: {
                nodes: [
                  {
                    id: "E_synthetic",
                    __typename: "ParentIssueAddedEvent",
                    createdAt: "2026-10-01T00:00:00Z",
                    actor: { __typename: "User", databaseId: 3, id: "U_synthetic" },
                    parent: {
                      id: "I_parent",
                      url: `https://github.com/${repository.slug}/issues/2`,
                      repository: { databaseId: 2, isPrivate: false },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }).nodes,
    },
  });
  const page = await source.readPage({ ...request, family: "relationships" });
  assert.equal(page.facts[0].subjectId, "E_synthetic");
  assert.equal(page.facts[0].actorId, "3");
  assert.equal(page.facts[0].occurredAt, "2026-10-01T00:00:00.000Z");
  assert.equal(page.facts[0].evidence, "observed_transition");
});

test("Project history requires approved IDs even when repository inventory is empty", async () => {
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [{ ...repository, families: ["project_history"] }],
    client: { rest: async () => ({ id: 2, private: false }), scanRest: async () => [] },
  });
  await assert.rejects(source.readPage({ ...request, family: "project_history" }), /approved_project_scope_required/);
});
