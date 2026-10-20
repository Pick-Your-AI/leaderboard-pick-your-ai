import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GithubReadClient } from "../dist/client.js";
import { FileCheckpointStore } from "../dist/checkpoints.js";
import { readGithubCommentEditInventory } from "../dist/comment-edit-inventory.js";
import { readGithubContentEditParents } from "../dist/content-edit-history.js";
import {
  commentInventoryModel,
  commentInventoryResponse,
  repository,
  edit,
} from "../../../tests/fixtures/comment-edit-inventory.mjs";

const failure =
  /github_(?:comment|content)_(?:edit|inventory)_|invalid_checkpoint|pagination .*maxPages|pagination repeated|repository.*retired|unsafe_request/;
const isInventory = (request) => request.query.includes("query GithubCommentEditInventory");
const isHistory = (request) => request.query.includes("query GithubCommentEditMetadata");
const clone = (value) => structuredClone(value);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function harness(t, state = commentInventoryModel()) {
  const directory = await mkdtemp(join(tmpdir(), "comment-inventory-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = {
    state,
    directory,
    calls: [],
    authorized: true,
    transform: undefined,
    beforeToken: undefined,
    afterLoad: undefined,
  };
  h.reopen = () => {
    const store = new FileCheckpointStore(join(directory, "checkpoints"));
    h.store = store;
    h.client = new GithubReadClient({
      checkpoints: {
        load: (key) => store.load(key),
        save: (key, value) => store.save(key, value),
        forRepository(id) {
          const scoped = store.forRepository(id);
          return {
            ...scoped,
            async load(key) {
              const result = await scoped.load(key);
              await h.afterLoad?.(result);
              return result;
            },
          };
        },
      },
      token: async () => {
        await h.beforeToken?.();
        return "synthetic-token";
      },
      maxRetries: 0,
      fetch: async (url, options) => {
        assert.equal(String(url), "https://api.github.com/graphql");
        const request = JSON.parse(options.body);
        h.calls.push(clone(request));
        const response = commentInventoryResponse(state, request);
        const selected = (await h.transform?.(response, request)) ?? response;
        return selected instanceof Response
          ? selected
          : new Response(JSON.stringify(selected), { headers: { "content-type": "application/json" } });
      },
    });
  };
  h.reopen();
  h.options = (extra = {}) => ({
    client: h.client,
    source: "synthetic-comment-inventory",
    repository: clone(repository),
    scanId: "synthetic-comment-inventory-a",
    first: 1,
    maxPages: 10,
    assertAuthorized() {
      if (!h.authorized) throw new Error("synthetic inventory access revoked");
    },
    ...extra,
  });
  h.read = (extra) => readGithubCommentEditInventory(h.options(extra));
  return h;
}
const children = (value) => value.snapshots.filter((value) => value.version === "github-comment-edit-metadata/v1");
const matching = (request, id, field = "comments") =>
  isInventory(request) && request.variables.id === id && request.query.includes(`${field}(first:`);

test("nested parent, comment, review, thread and edit pages reconcile before returning published metadata", async (t) => {
  const h = await harness(t);
  // The review association is nullable in the native schema. Thread enumeration
  // must retain this submitted comment without deriving or requiring a review ID.
  h.state.entries.get("COMMENT_SYNTHETIC_pull_request_review_comment_403").native.pullRequestReview = null;
  const result = await h.read({ maxObjects: 12, maxThreads: 2, maxEdits: 19 });
  assert.deepEqual(result.parentTotals, { issues: 1, pullRequests: 1 });
  assert.deepEqual(result.targetTotals, {
    publishedIssueComments: 2,
    publishedPullRequestComments: 2,
    submittedReviews: 2,
    submittedReviewComments: 3,
    excludedPendingReviewComments: 1,
    reviewThreads: 2,
  });
  assert.equal(result.snapshots.length, 11);
  assert.equal(children(result).length, 9);
  assert.equal(
    result.snapshots.reduce((n, value) => n + (value.history.records?.length ?? 0), 0),
    19,
  );
  for (const value of children(result)) {
    assert.deepEqual(value.repository, repository);
    assert.equal(value.publication.publishedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(value.history.retainedTotalCount, 2);
    assert.equal(value.history.records.length, 2);
  }
  for (const request of h.calls)
    assert.doesNotMatch(request.query, /\b(?:body|bodyHTML|bodyText|diff|diffHunk|title|login|email|author)\b/);
  const reviews = h.calls.filter((request) => matching(request, "PR_SYNTHETIC_12", "reviews"));
  assert.equal(reviews.length, 2);
  assert.ok(
    reviews.every((request) => request.query.includes("states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]")),
  );
  assert.ok(!h.calls.some((request) => isHistory(request) && request.variables.id.endsWith("_404")));
  const retained = (await Promise.all((await files(h.directory)).map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(
    retained,
    /synthetic-never-retain|COMMENT_SYNTHETIC_pull_request_review_comment_404|discussion_r404/,
  );
  assert.match(retained, /pending_review_comment/);
  assert.doesNotMatch(JSON.stringify(result), /pending_review_comment|synthetic-never-retain|_404/);
});

test("a completed real filesystem inventory reopens without repeating network or changing its observations", async (t) => {
  const h = await harness(t);
  const first = await h.read(),
    calls = h.calls.length;
  h.reopen();
  assert.deepEqual(await h.read(), first);
  assert.equal(h.calls.length, calls);
});

test("an interrupted thread cursor resumes its exact page and never reads child histories before inventory completion", async (t) => {
  const h = await harness(t);
  let failed = false;
  h.transform = (response, request) => {
    if (!failed && matching(request, "THREAD_SYNTHETIC_1") && request.variables.after !== null) {
      failed = true;
      return new Response("temporary synthetic interruption", { status: 503 });
    }
    return response;
  };
  await assert.rejects(h.read());
  assert.equal(h.calls.filter(isHistory).length, 0);
  const before = h.calls.length;
  h.reopen();
  const result = await h.read();
  assert.equal(result.snapshots.length, 11);
  const next = h.calls[before];
  assert.equal(next.variables.id, "THREAD_SYNTHETIC_1");
  assert.equal(next.variables.after, "THREAD_SYNTHETIC_1:comments:1");
  assert.equal(
    h.calls.filter((request) => matching(request, "THREAD_SYNTHETIC_1") && request.variables.after === null).length,
    1,
  );
});

test("an interrupted nested edit page resumes without recollecting completed inventory", async (t) => {
  const h = await harness(t);
  let failed = false;
  h.transform = (response, request) => {
    if (!failed && isHistory(request) && request.variables.id.endsWith("_403") && request.variables.after !== null) {
      failed = true;
      return new Response("temporary synthetic edit interruption", { status: 503 });
    }
    return response;
  };
  await assert.rejects(h.read());
  const inventoryCount = h.calls.filter(isInventory).length,
    before = h.calls.length;
  h.reopen();
  assert.equal((await h.read()).snapshots.length, 11);
  assert.equal(h.calls.filter(isInventory).length, inventoryCount);
  assert.equal(h.calls[before].variables.id, "COMMENT_SYNTHETIC_pull_request_review_comment_403");
  assert.notEqual(h.calls[before].variables.after, null);
});

test("unavailable and available-empty histories retain different typed observations", async (t) => {
  const h = await harness(t);
  h.state.parents.histories.get("I_SYNTHETIC_11").records = null;
  h.state.entries.get("COMMENT_SYNTHETIC_issue_comment_101").records = null;
  h.state.entries.get("COMMENT_SYNTHETIC_issue_comment_102").records = [];
  const result = await h.read();
  const issue = children(result).filter((value) => value.target.kind === "issue_comment");
  assert.deepEqual(result.snapshots[0].history, {
    availability: "unavailable",
    retainedTotalCount: null,
    records: null,
  });
  assert.deepEqual(issue[0].history, { availability: "unavailable", retainedTotalCount: null, records: null });
  assert.deepEqual(issue[1].history, { availability: "available", retainedTotalCount: 0, records: [] });
});

test("whole-inventory budgets include excluded pending objects and all retained edit identities", async (t) => {
  for (const [name, options] of [
    ["all objects", { maxObjects: 11 }],
    ["threads", { maxThreads: 1 }],
    ["zero threads", { maxThreads: 0 }],
    ["edits", { maxEdits: 18 }],
    ["pages", { maxPages: 1 }],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      await assert.rejects(h.read(options), failure);
    });
  const h = await harness(t);
  await h.read();
  const before = h.calls.length;
  h.reopen();
  await assert.rejects(h.read({ maxObjects: 11 }), failure);
  assert.equal(h.calls.length, before, "retained pages must obey a newly smaller budget too");
});

test("native repository, container and target bindings reject mismatched source objects", async (t) => {
  const cases = [
    ["container type", (node) => (node.__typename = "PullRequest")],
    ["container ID", (node) => (node.id += "_OTHER")],
    ["container number", (node) => (node.number = 13)],
    ["container URL", (node) => (node.url += "/other")],
    ["container database ID", (node) => (node.repository.databaseId = 3)],
    ["container slug", (node) => (node.repository.nameWithOwner = "Synthetic/Other")],
    ["private container", (node) => (node.repository.isPrivate = true)],
    ["target type", (node) => (node.comments.nodes[0].__typename = "PullRequestReview")],
    ["target database ID", (node) => (node.comments.nodes[0].repository.databaseId = 3)],
    ["target slug", (node) => (node.comments.nodes[0].repository.nameWithOwner = "Synthetic/Other")],
    ["private target", (node) => (node.comments.nodes[0].repository.isPrivate = true)],
    ["target parent ID", (node) => (node.comments.nodes[0].issue.id += "_OTHER")],
    ["target parent number", (node) => (node.comments.nodes[0].issue.number = 13)],
    ["target parent URL", (node) => (node.comments.nodes[0].issue.url += "/other")],
    ["target parent type", (node) => (node.comments.nodes[0].issue.__typename = "PullRequest")],
    ["target parent repository", (node) => (node.comments.nodes[0].issue.repository.databaseId = 3)],
    ["issue target unexpectedly has a PR", (node) => (node.comments.nodes[0].pullRequest = { id: "PR_SYNTHETIC_12" })],
    ["wrong fragment", (node) => (node.comments.nodes[0].url = node.url + "#discussion_r101")],
    ["unpublished conversation", (node) => (node.comments.nodes[0].publishedAt = null)],
    ["null target", (node) => (node.comments.nodes[0] = null)],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response, request) => {
        if (matching(request, "I_SYNTHETIC_11")) mutate(response.data.node);
        return response;
      };
      await assert.rejects(h.read(), failure);
      assert.equal(h.calls.filter(isHistory).length, 0);
    });
});

test("thread identities and submitted publication states are checked before history access", async (t) => {
  for (const [name, id, field, mutate] of [
    [
      "foreign thread parent",
      "PR_SYNTHETIC_12",
      "reviewThreads",
      (node) => (node.reviewThreads.nodes[0].pullRequest.id += "_OTHER"),
    ],
    [
      "private thread",
      "PR_SYNTHETIC_12",
      "reviewThreads",
      (node) => (node.reviewThreads.nodes[0].repository.isPrivate = true),
    ],
    ["thread type", "PR_SYNTHETIC_12", "reviewThreads", (node) => (node.reviewThreads.nodes[0].__typename = "Issue")],
    ["wrong current thread", "THREAD_SYNTHETIC_1", "comments", (node) => (node.id += "_OTHER")],
    ["wrong current thread parent", "THREAD_SYNTHETIC_1", "comments", (node) => (node.pullRequest.id += "_OTHER")],
    [
      "pending review escaped native filter",
      "PR_SYNTHETIC_12",
      "reviews",
      (node) => (node.reviews.nodes[0].state = "PENDING"),
    ],
    [
      "review missing submission time",
      "PR_SYNTHETIC_12",
      "reviews",
      (node) => (node.reviews.nodes[0].submittedAt = null),
    ],
    [
      "submitted inline missing publication",
      "THREAD_SYNTHETIC_1",
      "comments",
      (node) => (node.comments.nodes[0].publishedAt = null),
    ],
    [
      "pending inline claims publication",
      "THREAD_SYNTHETIC_1",
      "comments",
      (node) => (node.comments.nodes[0].state = "PENDING"),
    ],
    ["unknown inline state", "THREAD_SYNTHETIC_1", "comments", (node) => (node.comments.nodes[0].state = "UNKNOWN")],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response, request) => {
        if (matching(request, id, field)) mutate(response.data.node);
        return response;
      };
      await assert.rejects(h.read(), failure);
      assert.equal(h.calls.filter(isHistory).length, 0);
    });
});

test("counts, page shape and the complete cursor chain remain stable across nested pages", async (t) => {
  for (const [name, mutate] of [
    [
      "changing total",
      (connection, request) => {
        if (request.variables.after !== null) connection.totalCount++;
      },
    ],
    ["missing target", (connection) => (connection.nodes = [])],
    ["more than requested", (connection) => connection.nodes.push(clone(connection.nodes[0]))],
    ["repeated cursor", (connection) => (connection.pageInfo.endCursor = "repeated-synthetic-cursor")],
    ["premature terminal", (connection) => (connection.pageInfo.hasNextPage = false)],
    [
      "missing next cursor",
      (connection) => {
        connection.pageInfo.hasNextPage = true;
        connection.pageInfo.endCursor = null;
      },
    ],
    ["invalid total", (connection) => (connection.totalCount = -1)],
    ["null nodes", (connection) => (connection.nodes = null)],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response, request) => {
        if (matching(request, "I_SYNTHETIC_11")) mutate(response.data.node.comments, request);
        return response;
      };
      await assert.rejects(h.read());
      assert.equal(h.calls.filter(isHistory).length, 0);
    });
  const h = await harness(t);
  h.transform = (response, request) => {
    if (matching(request, "PR_SYNTHETIC_12", "reviews")) response.data.node.reviews = null;
    return response;
  };
  await assert.rejects(h.read(), /inventory_unavailable/);
});

test("global native identity checks reject comments shared by threads and edits shared by targets", async (t) => {
  for (const [name, mutate] of [
    [
      "submitted comment in two threads",
      (h) => h.state.threadComments.get("THREAD_SYNTHETIC_2").push("COMMENT_SYNTHETIC_pull_request_review_comment_401"),
    ],
    [
      "pending comment in two threads",
      (h) => h.state.threadComments.get("THREAD_SYNTHETIC_2").push("COMMENT_SYNTHETIC_pull_request_review_comment_404"),
    ],
    [
      "same edit across comments",
      (h) =>
        (h.state.entries.get("COMMENT_SYNTHETIC_issue_comment_102").records[0] = edit(
          "UCE_COMMENT_SYNTHETIC_issue_comment_101_1",
        )),
    ],
    [
      "same edit as a parent",
      (h) => (h.state.entries.get("COMMENT_SYNTHETIC_issue_comment_101").records[0] = edit("UCE_SYNTHETIC_1")),
    ],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      mutate(h);
      await assert.rejects(h.read(), /duplicate_/);
    });
});

test("a publication transition between inventory and hydration cannot return a mixed snapshot", async (t) => {
  for (const [name, mutate] of [
    ["publication timestamp", (node) => (node.publishedAt = "2026-01-04T00:00:00Z")],
    ["review state", (node) => (node.state = "DISMISSED")],
    ["submission timestamp", (node) => (node.submittedAt = "2026-01-04T00:00:00Z")],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response, request) => {
        if (isHistory(request) && request.variables.id.endsWith("review_301")) mutate(response.data.node);
        return response;
      };
      await assert.rejects(h.read(), /publication_changed/);
    });
});

test("authorization is synchronous and current at input, token wait, checkpoint reopen and retirement", async (t) => {
  for (const guard of [undefined, async () => {}, () => true])
    await t.test(String(guard), async (t) => {
      const h = await harness(t);
      await assert.rejects(h.read({ assertAuthorized: guard }), /authorization_/);
      assert.equal(h.calls.length, 0);
    });
  await t.test("withdrawn while acquiring token", async (t) => {
    const h = await harness(t);
    h.beforeToken = () => (h.authorized = false);
    await assert.rejects(
      h.read(),
      (error) =>
        error instanceof Error && error.name === "GithubClientError" && error.outcome?.kind === "unsafe_request",
    );
    assert.equal(h.calls.length, 0);
  });
  await t.test("withdrawn during cached checkpoint load", async (t) => {
    const h = await harness(t);
    await h.read();
    const count = h.calls.length;
    h.reopen();
    h.afterLoad = () => (h.authorized = false);
    await assert.rejects(
      h.read(),
      (error) =>
        error instanceof Error && error.name === "GithubClientError" && error.outcome?.kind === "unsafe_request",
    );
    assert.equal(h.calls.length, count);
  });
  await t.test("retired repository cannot replay completed inventory", async (t) => {
    const h = await harness(t);
    await h.read();
    const count = h.calls.length;
    await h.store.forRepository(repository.id).retire({
      operationId: "synthetic-inventory-retirement",
      policyId: "synthetic-policy",
      authorizationId: "synthetic-authorization",
    });
    h.reopen();
    await assert.rejects(h.read());
    assert.equal(h.calls.length, count);
  });
});

test("caller options are captured before the first await and new scan identities use distinct checkpoints", async (t) => {
  const h = await harness(t),
    options = h.options();
  h.beforeToken = () => {
    options.repository.id = 99;
    options.repository.slug = "Synthetic/Other";
    options.source = "other-source";
    options.scanId = "other-scan";
    options.maxObjects = 1;
    options.assertAuthorized = () => {
      throw new Error("mutated caller");
    };
  };
  assert.equal((await readGithubCommentEditInventory(options)).snapshots.length, 11);
  h.beforeToken = undefined;
  const calls = h.calls.length;
  await h.read({ scanId: "synthetic-comment-inventory-b" });
  assert.equal(h.calls.length, calls * 2);
  await h.read({ source: "other-synthetic-source" });
  assert.equal(h.calls.length, calls * 3);
});

async function corruptInventory(h, predicate, mutate) {
  for (const path of await files(h.directory)) {
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    const pages = [];
    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (value.version === "github-comment-edit-inventory-page/v1") {
        pages.push(value);
        return;
      }
      for (const child of Object.values(value)) visit(child);
    }
    visit(checkpoint);
    const page = pages.find(predicate);
    if (page) {
      mutate(page);
      await writeFile(path, JSON.stringify(checkpoint));
      return;
    }
  }
  assert.fail("a completed real inventory checkpoint was not found");
}

test("closed completed checkpoints cannot inject fields, rebind targets or rewrite count and publication proof", async (t) => {
  for (const [name, predicate, mutate] of [
    ["extra body", (page) => page.connection === "issue_comments", (page) => (page.body = "must reject")],
    ["repository", (page) => page.connection === "issue_comments", (page) => (page.repository.id = 3)],
    ["parent", (page) => page.connection === "issue_comments", (page) => (page.parent.id += "_OTHER")],
    ["connection", (page) => page.connection === "issue_comments", (page) => (page.connection = "reviews")],
    ["thread", (page) => page.connection === "thread_comments", (page) => (page.threadId += "_OTHER")],
    [
      "target kind",
      (page) => page.connection === "issue_comments",
      (page) => (page.entries[0].target.kind = "pull_request_review"),
    ],
    [
      "target parent",
      (page) => page.connection === "issue_comments",
      (page) => (page.entries[0].target.parent.id += "_OTHER"),
    ],
    [
      "publication",
      (page) => page.connection === "issue_comments",
      (page) => (page.entries[0].publication.publishedAt = null),
    ],
    ["count", (page) => page.connection === "issue_comments", (page) => page.totalCount++],
    [
      "extra draft data",
      (page) => page.entries.some((value) => value.kind === "pending_review_comment"),
      (page) => (page.entries.find((value) => value.kind === "pending_review_comment").id = "forbidden-draft-id"),
    ],
    [
      "bad draft digest",
      (page) => page.entries.some((value) => value.kind === "pending_review_comment"),
      (page) => (page.entries.find((value) => value.kind === "pending_review_comment").identityDigest = "bad"),
    ],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      await h.read();
      const calls = h.calls.length;
      await corruptInventory(h, predicate, mutate);
      h.reopen();
      await assert.rejects(h.read(), failure);
      assert.equal(h.calls.length, calls);
    });
});

test("a saved v1 parent checkpoint remains literal while the distinct inventory completes its child cohorts", async (t) => {
  const h = await harness(t);
  const parents = await readGithubContentEditParents(h.options());
  const prior = h.calls.length;
  const result = await h.read();
  assert.deepEqual(result.snapshots.slice(0, 2), parents.snapshots);
  assert.ok(h.calls.slice(prior).every((request) => !request.query.includes("query GithubContentEdit")));
  const calls = h.calls.length;
  assert.deepEqual(await readGithubContentEditParents(h.options()), parents);
  assert.equal(h.calls.length, calls);
});
