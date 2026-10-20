import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GithubReadClient } from "../dist/client.js";
import { FileCheckpointStore } from "../dist/checkpoints.js";
import {
  githubCommentEditRevision,
  parseGithubCommentEditMetadata,
  readGithubCommentEditMetadata,
  verifyGithubCommentEditRevision,
} from "../dist/comment-edit-history.js";
import { parseGithubContentEditMetadata, verifyGithubContentEditRevision } from "../dist/content-edit-history.js";
import {
  commentEntry,
  commentKinds,
  commentModel,
  commentResponse,
  commentTarget,
  edit,
  repository,
} from "../../../tests/fixtures/comment-edit-metadata.mjs";

const metadataFailure =
  /github_(?:comment|content)_edit_|unsafe_request|invalid_checkpoint|pagination .*maxPages|pagination repeated/;

async function harness(t, state = commentModel()) {
  const directory = await mkdtemp(join(tmpdir(), "github-comment-edit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = {
    directory,
    state,
    calls: [],
    authorized: true,
    transform: undefined,
    beforeToken: undefined,
    afterLoad: undefined,
    tokenCalls: 0,
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
              const value = await scoped.load(key);
              await h.afterLoad?.(value);
              return value;
            },
          };
        },
      },
      token: async () => {
        h.tokenCalls++;
        await h.beforeToken?.();
        return "synthetic-token";
      },
      maxRetries: 0,
      fetch: async (url, options) => {
        assert.equal(String(url), "https://api.github.com/graphql");
        assert.equal(options.method, "POST");
        const request = JSON.parse(options.body);
        h.calls.push(structuredClone(request));
        const response = commentResponse(state, request);
        const selected = (await h.transform?.(response, request)) ?? response;
        return selected instanceof Response
          ? selected
          : new Response(JSON.stringify(selected), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  };
  h.reopen();
  h.options = (extra = {}) => ({
    client: h.client,
    source: "synthetic-comment-edits",
    repository: structuredClone(repository),
    scanId: "synthetic-comment-scan-a",
    target: structuredClone(state.selected),
    first: 1,
    maxPages: 10,
    assertAuthorized: () => {
      if (!h.authorized) throw new Error("synthetic comment access revoked");
    },
    ...extra,
  });
  h.entry = () => state.entries.get(state.selected.id);
  return h;
}

async function checkpointFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await checkpointFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function metadataPage(value, id) {
  if (!value || typeof value !== "object") return undefined;
  if (value.target?.id === id && value.publication) return value;
  for (const child of Object.values(value)) {
    const page = metadataPage(child, id);
    if (page) return page;
  }
  return undefined;
}

async function alterCheckpoint(h, mutate) {
  for (const file of await checkpointFiles(h.directory)) {
    const checkpoint = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(checkpoint.items)) continue;
    const pages = checkpoint.items.map((item) => metadataPage(item, h.state.selected.id));
    if (pages.length && pages.every(Boolean)) {
      mutate(checkpoint, pages);
      await writeFile(file, JSON.stringify(checkpoint));
      return;
    }
  }
  assert.fail("expected real durable comment metadata pages");
}

function historyOf(page) {
  return page.history ?? page;
}

test("each published comment family binds its exact native type, parent and publication fields", async (t) => {
  for (const kind of commentKinds)
    await t.test(kind, async (t) => {
      const h = await harness(t, commentModel(kind));
      const value = await readGithubCommentEditMetadata(h.options());
      assert.deepEqual(
        Object.keys(value).sort(),
        ["version", "repository", "target", "publication", "includesCreatedEdit", "history"].sort(),
      );
      assert.equal(value.version, "github-comment-edit-metadata/v1");
      assert.deepEqual(value.repository, repository);
      assert.deepEqual(value.target, h.state.selected);
      assert.deepEqual(value.publication, {
        publishedAt: "2026-01-02T03:04:05.000Z",
        reviewState:
          kind === "pull_request_review" ? "COMMENTED" : kind === "pull_request_review_comment" ? "SUBMITTED" : null,
        submittedAt: kind === "pull_request_review" ? "2026-01-02T03:04:05.100Z" : null,
      });
      assert.equal(value.history.retainedTotalCount, 1);
      assert.equal(value.history.records[0].editedAt, "2026-01-02T03:04:06.100Z");
      const query = h.calls[0].query;
      const expectedType =
        kind === "pull_request_review"
          ? "PullRequestReview"
          : kind === "pull_request_review_comment"
            ? "PullRequestReviewComment"
            : "IssueComment";
      assert.match(query, new RegExp(`\\.\\.\\.\\s+on\\s+${expectedType}\\b`));
      assert.match(query, /repository\s*\{\s*databaseId\s+nameWithOwner\s+isPrivate\s*\}/);
      if (kind === "issue_comment") {
        assert.match(query, /\bissue\s*\{/);
        assert.match(query, /pullRequest\s*\{\s*id\s*\}/);
      } else assert.doesNotMatch(query, /\bissue\s*\{/);
      assert.deepEqual(h.calls[0].variables, { id: value.target.id, first: 1, after: null });
    });
});

test("published reviews require one of the four submitted states and an explicit submission time", async (t) => {
  for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"])
    await t.test(state, async (t) => {
      const h = await harness(t, commentModel("pull_request_review"));
      h.entry().native.state = state;
      assert.equal((await readGithubCommentEditMetadata(h.options())).publication.reviewState, state);
    });
  for (const [name, mutate] of [
    [
      "draft review",
      (n) => {
        n.state = "PENDING";
      },
    ],
    [
      "inline-only state",
      (n) => {
        n.state = "SUBMITTED";
      },
    ],
    [
      "missing state",
      (n) => {
        delete n.state;
      },
    ],
    [
      "unsubmitted review",
      (n) => {
        n.submittedAt = null;
      },
    ],
    [
      "missing submission",
      (n) => {
        delete n.submittedAt;
      },
    ],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t, commentModel("pull_request_review"));
      mutate(h.entry().native);
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
});

test("unpublished comments and pending inline comments do not become published edit evidence", async (t) => {
  for (const kind of commentKinds)
    for (const publication of [null, undefined])
      await t.test(`${kind} publishedAt ${publication}`, async (t) => {
        const h = await harness(t, commentModel(kind));
        if (publication === undefined) delete h.entry().native.publishedAt;
        else h.entry().native.publishedAt = publication;
        await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
      });
  for (const state of ["PENDING", "APPROVED", null, undefined])
    await t.test(`inline state ${state}`, async (t) => {
      const h = await harness(t, commentModel("pull_request_review_comment"));
      if (state === undefined) delete h.entry().native.state;
      else h.entry().native.state = state;
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
});

test("unknown history, available empty history and the creation flag remain distinct", async (t) => {
  const values = [];
  for (const records of [null, []]) {
    const h = await harness(t);
    h.entry().records = records;
    h.entry().native.includesCreatedEdit = false;
    const value = await readGithubCommentEditMetadata(h.options({ maxEdits: 0 }));
    values.push(value);
    assert.deepEqual(
      value.history,
      records === null
        ? { availability: "unavailable", retainedTotalCount: null, records: null }
        : { availability: "available", retainedTotalCount: 0, records: [] },
    );
    assert.equal(value.includesCreatedEdit, false);
  }
  assert.notEqual(githubCommentEditRevision(values[0], "same-scan"), githubCommentEditRevision(values[1], "same-scan"));
});

test("metadata counts reconcile across pages and a real interrupted checkpoint resumes after reopen", async (t) => {
  const h = await harness(t);
  h.entry().records = [edit("UCE_SYNTHETIC_Z"), edit("UCE_SYNTHETIC_A", { editor: null })];
  let fail = true;
  h.transform = (_response, request) =>
    fail && request.variables.after !== null ? new Response("synthetic unavailable", { status: 503 }) : undefined;
  await assert.rejects(readGithubCommentEditMetadata(h.options()), /transient_failure/);
  const before = h.calls.length;
  fail = false;
  h.reopen();
  const value = await readGithubCommentEditMetadata(h.options());
  assert.equal(value.history.retainedTotalCount, 2);
  assert.deepEqual(
    value.history.records.map((r) => r.id),
    ["UCE_SYNTHETIC_A", "UCE_SYNTHETIC_Z"],
  );
  assert.equal(value.history.records[0].editor, null);
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls[before].variables.after, `comment-edits:${h.state.selected.id}:1`);
  const completed = h.calls.length;
  h.reopen();
  assert.deepEqual(await readGithubCommentEditMetadata(h.options()), value);
  assert.equal(h.calls.length, completed);
});

test("queries, results and durable pages minimize unselected content and actor identifiers", async (t) => {
  const h = await harness(t);
  const marker = "SYNTHETIC-UNSELECTED-COMMENT-CONTENT";
  Object.assign(h.entry().native, { body: marker, bodyHTML: marker, diff: marker, author: { login: marker } });
  h.entry().native.issue.title = marker;
  h.entry().records = [
    edit("UCE_SYNTHETIC_MINIMIZED", {
      body: marker,
      diff: marker,
      editor: { __typename: "Mannequin", id: marker, login: marker, email: marker },
      deletedBy: { __typename: "Bot", id: "BOT_SYNTHETIC_8", databaseId: null, login: marker },
      deletedAt: "2026-01-03T00:00:00Z",
    }),
  ];
  const value = await readGithubCommentEditMetadata(h.options());
  assert.deepEqual(value.history.records[0].editor, { kind: "unknown", typename: "Mannequin" });
  assert.deepEqual(value.history.records[0].deletedBy, { kind: "Bot", id: "BOT_SYNTHETIC_8", databaseId: null });
  assert.equal(value.history.records[0].deletedAt, "2026-01-03T00:00:00.000Z");
  assert.ok(!JSON.stringify(value).includes(marker));
  for (const { query } of h.calls) {
    assert.doesNotMatch(query, /\b(?:body|bodyHTML|bodyText|diff|title|author|authorAssociation|login|email)\b/);
    assert.doesNotMatch(query, /\b(?:mutation|subscription)\b/);
  }
  for (const file of await checkpointFiles(h.directory)) assert.ok(!(await readFile(file, "utf8")).includes(marker));
});

test("native target, repository and parent bindings reject foreign, private and cross-family substitutions", async (t) => {
  const mutations = [
    [
      "null node",
      (r) => {
        r.data.node = null;
      },
    ],
    [
      "different target ID",
      (r) => {
        r.data.node.id = "COMMENT_SYNTHETIC_OTHER";
      },
    ],
    [
      "different target URL",
      (r) => {
        r.data.node.url += "0";
      },
    ],
    [
      "wrong native type",
      (r) => {
        r.data.node.__typename = "PullRequestReview";
      },
    ],
    [
      "private repository",
      (r) => {
        r.data.node.repository.isPrivate = true;
      },
    ],
    [
      "different repository ID",
      (r) => {
        r.data.node.repository.databaseId++;
      },
    ],
    [
      "different repository slug",
      (r) => {
        r.data.node.repository.nameWithOwner = "Synthetic/Other";
      },
    ],
    [
      "missing repository slug",
      (r) => {
        delete r.data.node.repository.nameWithOwner;
      },
    ],
    [
      "different parent ID",
      (r) => {
        r.data.node.issue.id = "I_SYNTHETIC_OTHER";
      },
    ],
    [
      "different parent number",
      (r) => {
        r.data.node.issue.number++;
      },
    ],
    [
      "different parent URL",
      (r) => {
        r.data.node.issue.url += "0";
      },
    ],
    [
      "wrong parent native type",
      (r) => {
        r.data.node.issue.__typename = "PullRequest";
      },
    ],
    [
      "private parent repository",
      (r) => {
        r.data.node.issue.repository.isPrivate = true;
      },
    ],
    [
      "foreign parent repository",
      (r) => {
        r.data.node.issue.repository.databaseId++;
      },
    ],
    [
      "foreign parent repository slug",
      (r) => {
        r.data.node.issue.repository.nameWithOwner = "Synthetic/Other";
      },
    ],
    [
      "PR-backed issue comment",
      (r) => {
        r.data.node.pullRequest = { id: "PR_SYNTHETIC_12" };
      },
    ],
    [
      "unknown issue comment PR relation",
      (r) => {
        delete r.data.node.pullRequest;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response) => {
        mutate(response);
        return response;
      };
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
  for (const kind of commentKinds.slice(1))
    await t.test(`${kind} requires pullRequest parent`, async (t) => {
      const h = await harness(t, commentModel(kind));
      delete h.entry().native.pullRequest;
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
});

test("publication, creation flag, availability and counts cannot drift between retained pages", async (t) => {
  const mutations = [
    [
      "publication time",
      (n) => {
        n.publishedAt = "2026-01-03T00:00:00Z";
      },
    ],
    [
      "submission time",
      (n) => {
        n.submittedAt = "2026-01-03T00:00:00Z";
      },
    ],
    [
      "review state",
      (n) => {
        n.state = "DISMISSED";
      },
    ],
    [
      "creation flag",
      (n) => {
        n.includesCreatedEdit = false;
      },
    ],
    [
      "availability",
      (n) => {
        n.userContentEdits = null;
      },
    ],
    [
      "count",
      (n) => {
        n.userContentEdits.totalCount++;
      },
    ],
    [
      "parent",
      (n) => {
        n.pullRequest.id = "PR_SYNTHETIC_OTHER";
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const h = await harness(t, commentModel("pull_request_review"));
      h.entry().records.push(edit("UCE_SYNTHETIC_SECOND"));
      h.transform = (response, request) => {
        if (request.variables.after !== null) mutate(response.data.node);
        return response;
      };
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
});

test("duplicate IDs, incomplete counts and invalid cursor chains never return partial success", async (t) => {
  for (const scenario of [
    "duplicate",
    "wrong total",
    "early terminal",
    "repeated cursor",
    "next without cursor",
    "empty cursor",
    "oversized page",
  ])
    await t.test(scenario, async (t) => {
      const h = await harness(t);
      h.entry().records = [edit("UCE_SYNTHETIC_A"), edit("UCE_SYNTHETIC_B")];
      if (scenario === "duplicate") h.entry().records[1].id = h.entry().records[0].id;
      h.transform = (response, request) => {
        const connection = response.data.node.userContentEdits;
        if (scenario === "wrong total") connection.totalCount++;
        if (scenario === "early terminal" && request.variables.after === null) connection.pageInfo.hasNextPage = false;
        if (scenario === "repeated cursor" && request.variables.after !== null)
          connection.pageInfo = { hasNextPage: true, endCursor: request.variables.after };
        if (scenario === "next without cursor") connection.pageInfo = { hasNextPage: true, endCursor: null };
        if (scenario === "empty cursor") connection.pageInfo = { hasNextPage: true, endCursor: "" };
        if (scenario === "oversized page") connection.nodes.push(edit("UCE_SYNTHETIC_EXTRA"));
        return response;
      };
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
});

test("retained-edit and page budgets reject overflow while accepting the exact 100-edit boundary", async (t) => {
  for (const scenario of ["zero", "smaller cap", "101 retained", "page cap"])
    await t.test(scenario, async (t) => {
      const h = await harness(t);
      h.entry().records = Array.from({ length: scenario === "101 retained" ? 101 : 2 }, (_, i) =>
        edit(`UCE_SYNTHETIC_${i}`),
      );
      const bounds =
        scenario === "zero"
          ? { maxEdits: 0 }
          : scenario === "smaller cap"
            ? { maxEdits: 1 }
            : scenario === "page cap"
              ? { maxPages: 1 }
              : {};
      await assert.rejects(readGithubCommentEditMetadata(h.options(bounds)), metadataFailure);
    });
  const h = await harness(t);
  h.entry().records = Array.from({ length: 100 }, (_, i) => edit(`UCE_SYNTHETIC_${i}`));
  const value = await readGithubCommentEditMetadata(h.options({ first: 100, maxEdits: 100, maxPages: 1 }));
  assert.equal(value.history.retainedTotalCount, 100);
  assert.equal(value.history.records.length, 100);
  assert.equal(h.calls.length, 1);
});

test("input bounds and the required synchronous authorization callback fail before transport", async (t) => {
  for (const [name, extra] of [
    ["first zero", { first: 0 }],
    ["first 101", { first: 101 }],
    ["fractional page size", { first: 1.5 }],
    ["pages zero", { maxPages: 0 }],
    ["pages 10001", { maxPages: 10001 }],
    ["negative edits", { maxEdits: -1 }],
    ["edits 101", { maxEdits: 101 }],
    ["missing guard", { assertAuthorized: undefined }],
    ["null guard", { assertAuthorized: null }],
    ["async guard", { assertAuthorized: async () => {} }],
    ["empty scan", { scanId: "" }],
    ["invalid source", { source: "source with spaces" }],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      await assert.rejects(readGithubCommentEditMetadata(h.options(extra)), metadataFailure);
      assert.equal(h.calls.length, 0);
    });
});

test("authorization loss after transport and after completed-cache load prevents result delivery", async (t) => {
  for (const stage of ["transport", "completed cache"])
    await t.test(stage, async (t) => {
      const h = await harness(t);
      if (stage === "transport")
        h.transform = () => {
          h.authorized = false;
        };
      else {
        await readGithubCommentEditMetadata(h.options());
        h.reopen();
        h.afterLoad = (value) => {
          if (value?.complete) h.authorized = false;
        };
      }
      const count = h.calls.length;
      await assert.rejects(readGithubCommentEditMetadata(h.options()), /unsafe_request|revoked/);
      assert.equal(h.calls.length, count + (stage === "transport" ? 1 : 0));
    });
});

test("repository retirement also blocks an otherwise valid completed comment cache", async (t) => {
  const h = await harness(t);
  await readGithubCommentEditMetadata(h.options());
  const scoped = h.store.forRepository(repository.id);
  await scoped.retire({
    operationId: "synthetic-retirement",
    policyId: "synthetic-policy",
    authorizationId: "synthetic-authorization",
  });
  const count = h.calls.length;
  h.reopen();
  await assert.rejects(readGithubCommentEditMetadata(h.options()));
  assert.equal(h.calls.length, count);
});

test("caller mutation after the first await cannot redirect target, repository, scan or authority", async (t) => {
  const h = await harness(t);
  h.entry().records.push(edit("UCE_SYNTHETIC_SECOND"));
  const options = h.options();
  const expectedTarget = structuredClone(options.target);
  let mutated = false;
  h.beforeToken = () => {
    if (mutated) return;
    mutated = true;
    options.repository.id = 999;
    options.repository.slug = "Synthetic/Other";
    options.target.id = "COMMENT_SYNTHETIC_OTHER";
    options.target.kind = "pull_request_review";
    options.target.url += "0";
    options.target.parent.id = "I_SYNTHETIC_OTHER";
    options.target.parent.number++;
    options.target.parent.url += "0";
    options.source = "other-source";
    options.scanId = "other-scan";
    options.first = 0;
    options.maxPages = 0;
    options.maxEdits = 0;
    options.assertAuthorized = () => {
      throw new Error("replacement callback must not become authority");
    };
  };
  const value = await readGithubCommentEditMetadata(options);
  assert.deepEqual(value.repository, repository);
  assert.deepEqual(value.target, expectedTarget);
  assert.equal(value.history.retainedTotalCount, 2);
  assert.ok(h.calls.every((request) => request.variables.id === expectedTarget.id && request.variables.first === 1));
  const count = h.calls.length;
  h.beforeToken = undefined;
  h.reopen();
  assert.deepEqual(await readGithubCommentEditMetadata(h.options()), value);
  assert.equal(h.calls.length, count);
});

test("target, source and scan identities have separate durable namespaces", async (t) => {
  const h = await harness(t);
  const first = await readGithubCommentEditMetadata(h.options());
  const next = commentEntry(commentTarget("issue_comment", "102"));
  h.state.entries.set(next.target.id, next);
  const second = await readGithubCommentEditMetadata(h.options({ target: next.target }));
  assert.equal(second.target.id, next.target.id);
  assert.notEqual(second.target.id, first.target.id);
  assert.equal(h.calls.length, 2);
  await readGithubCommentEditMetadata(h.options({ source: "synthetic-other-source" }));
  await readGithubCommentEditMetadata(h.options({ scanId: "synthetic-other-scan" }));
  assert.equal(h.calls.length, 4);
  h.reopen();
  await readGithubCommentEditMetadata(h.options());
  await readGithubCommentEditMetadata(h.options({ target: next.target }));
  assert.equal(h.calls.length, 4);
});

test("completed cached pages revalidate closed metadata, stable headers and the entire cursor chain", async (t) => {
  for (const scenario of [
    "raw root",
    "raw edit",
    "repository",
    "target",
    "publication",
    "flag",
    "count",
    "duplicate",
    "missing page",
    "cursor",
  ])
    await t.test(scenario, async (t) => {
      const h = await harness(t);
      h.entry().records.push(edit("UCE_SYNTHETIC_SECOND"));
      await readGithubCommentEditMetadata(h.options());
      await alterCheckpoint(h, (checkpoint, pages) => {
        const first = pages[0],
          last = pages.at(-1);
        if (scenario === "raw root") first.body = "SYNTHETIC-UNSELECTED-CONTENT";
        if (scenario === "raw edit") historyOf(first).records[0].diff = "SYNTHETIC-UNSELECTED-CONTENT";
        if (scenario === "repository") first.repository.id++;
        if (scenario === "target") first.target.id = "COMMENT_SYNTHETIC_OTHER";
        if (scenario === "publication") last.publication.publishedAt = "2026-02-01T00:00:00.000Z";
        if (scenario === "flag") last.includesCreatedEdit = !first.includesCreatedEdit;
        if (scenario === "count") historyOf(first).retainedTotalCount++;
        if (scenario === "duplicate") historyOf(last).records[0].id = historyOf(first).records[0].id;
        if (scenario === "missing page") checkpoint.items.shift();
        if (scenario === "cursor") first.pageInfo.hasNextPage = false;
      });
      const count = h.calls.length;
      h.reopen();
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
      assert.equal(h.calls.length, count, "corrupt completed evidence cannot disguise itself as a fresh scan");
    });
});

test("all publication and edit timestamps reject malformed calendars, offsets and excess precision", async (t) => {
  for (const [field, value] of [
    ["publishedAt", "2026-02-30T00:00:00Z"],
    ["publishedAt", "2026-01-02T03:04:05+00:00"],
    ["submittedAt", "2026-01-02T03:04:05.0001Z"],
    ["createdAt", "2026-02-30T00:00:00Z"],
    ["editedAt", "2026-01-02T03:04:05.0001Z"],
    ["updatedAt", "2026-01-02T03:04:05+00:00"],
    ["deletedAt", "not-a-date"],
  ])
    await t.test(`${field}: ${value}`, async (t) => {
      const h = await harness(t, commentModel("pull_request_review"));
      if (field === "publishedAt" || field === "submittedAt") h.entry().native[field] = value;
      else h.entry().records[0][field] = value;
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
});

test("native edit records preserve explicit nulls and reject malformed required actor or type evidence", async (t) => {
  for (const [name, mutate] of [
    [
      "wrong type",
      (e) => {
        e.__typename = "IssueComment";
      },
    ],
    [
      "missing editor",
      (e) => {
        delete e.editor;
      },
    ],
    [
      "missing deletion actor",
      (e) => {
        delete e.deletedBy;
      },
    ],
    [
      "missing known actor ID",
      (e) => {
        delete e.editor.id;
      },
    ],
    [
      "zero actor database ID",
      (e) => {
        e.editor.databaseId = 0;
      },
    ],
    [
      "missing creation flag",
      (_e, n) => {
        delete n.includesCreatedEdit;
      },
    ],
    [
      "unknown creation flag",
      (_e, n) => {
        n.includesCreatedEdit = null;
      },
    ],
  ])
    await t.test(name, async (t) => {
      const h = await harness(t);
      mutate(h.entry().records[0], h.entry().native);
      await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
    });
  const h = await harness(t);
  h.entry().records[0] = null;
  await assert.rejects(readGithubCommentEditMetadata(h.options()), metadataFailure);
});

test("comment anchors are exact positive decimal text, including values beyond JavaScript safe integers", async (t) => {
  const h = await harness(t);
  const target = commentTarget("issue_comment", "9007199254740993");
  h.state.entries.set(target.id, commentEntry(target));
  const value = await readGithubCommentEditMetadata(h.options({ target }));
  assert.equal(value.target.url, target.url);
  const nearby = structuredClone(target);
  nearby.url = nearby.url.replace("9007199254740993", "9007199254740992");
  await assert.rejects(readGithubCommentEditMetadata(h.options({ target: nearby })), metadataFailure);
  for (const anchor of [
    "#issuecomment-0",
    "#issuecomment-01",
    "#issuecomment--1",
    "#issuecomment-1e3",
    "#issuecomment-1?raw=1",
    "#issuecomment-1\n",
    "#discussion_r1",
  ]) {
    const invalid = structuredClone(value);
    invalid.target.url = invalid.target.parent.url + anchor;
    assert.throws(() => parseGithubCommentEditMetadata(invalid), metadataFailure);
  }
  const inline = await harness(t, commentModel("pull_request_review_comment"));
  inline.state.selected.url = inline.state.selected.url.replace("#discussion_r", "#r");
  inline.entry().native.url = inline.state.selected.url;
  assert.equal((await readGithubCommentEditMetadata(inline.options())).target.url, inline.state.selected.url);
});

test("the metadata parser closes every persisted layer and preserves family publication semantics", async (t) => {
  const h = await harness(t);
  const value = await readGithubCommentEditMetadata(h.options());
  const mutations = [
    [
      "root",
      (v) => {
        v.body = "SYNTHETIC-RAW";
      },
    ],
    [
      "repository",
      (v) => {
        v.repository.isPrivate = false;
      },
    ],
    [
      "target",
      (v) => {
        v.target.author = "SYNTHETIC-RAW";
      },
    ],
    [
      "parent",
      (v) => {
        v.target.parent.title = "SYNTHETIC-RAW";
      },
    ],
    [
      "publication",
      (v) => {
        v.publication.createdAt = v.publication.publishedAt;
      },
    ],
    [
      "history",
      (v) => {
        v.history.cursor = "SYNTHETIC-RAW";
      },
    ],
    [
      "record",
      (v) => {
        v.history.records[0].body = "SYNTHETIC-RAW";
      },
    ],
    [
      "actor",
      (v) => {
        v.history.records[0].editor.login = "synthetic";
      },
    ],
    [
      "ordinary review state",
      (v) => {
        v.publication.reviewState = "SUBMITTED";
      },
    ],
    [
      "ordinary submitted time",
      (v) => {
        v.publication.submittedAt = v.publication.publishedAt;
      },
    ],
    [
      "unavailable with retained count",
      (v) => {
        v.history = { availability: "unavailable", retainedTotalCount: 0, records: null };
      },
    ],
    [
      "available with null rows",
      (v) => {
        v.history.records = null;
      },
    ],
    [
      "count mismatch",
      (v) => {
        v.history.retainedTotalCount++;
      },
    ],
    [
      "foreign parent slug",
      (v) => {
        v.repository.slug = "Synthetic/Other";
      },
    ],
    [
      "parent family",
      (v) => {
        v.target.parent.kind = "pull_request";
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, () => {
      const invalid = structuredClone(value);
      mutate(invalid);
      assert.throws(() => parseGithubCommentEditMetadata(invalid), metadataFailure);
    });
  const roundTrip = parseGithubCommentEditMetadata(value);
  value.target.parent.number = 999;
  assert.equal(roundTrip.target.parent.number, 11, "parser result does not retain the caller's nested object");
});

test("comment revisions isolate semantic changes and A to B to A observations from old revision families", async (t) => {
  const h = await harness(t);
  const a = await readGithubCommentEditMetadata(h.options());
  const b = structuredClone(a);
  b.history.records[0].editor = null;
  const first = githubCommentEditRevision(a, "scan-a"),
    changed = githubCommentEditRevision(b, "scan-b"),
    restored = githubCommentEditRevision(a, "scan-c");
  assert.match(first, /^gh-content-edit-comment-v1:[a-f0-9]{64}\.[a-f0-9]{32}$/);
  assert.notEqual(first, changed);
  assert.notEqual(first, restored);
  assert.equal(first.split(".")[0], restored.split(".")[0]);
  assert.equal(verifyGithubCommentEditRevision(a, first), true);
  assert.equal(verifyGithubCommentEditRevision(a, changed), false);
  assert.equal(verifyGithubCommentEditRevision(a, restored), true);
  assert.equal(verifyGithubContentEditRevision(a, first), false);
  assert.throws(() => parseGithubContentEditMetadata(a));
  for (const invalid of [
    first.replace("gh-content-edit-comment-v1:", "gh-content-edit-v1:"),
    first + "\n",
    first + "x",
    first.toUpperCase(),
  ])
    assert.equal(verifyGithubCommentEditRevision(a, invalid), false);
  for (const mutate of [
    (v) => {
      v.repository.id++;
    },
    (v) => {
      v.publication.publishedAt = "2026-01-03T00:00:00.000Z";
    },
    (v) => {
      v.includesCreatedEdit = !v.includesCreatedEdit;
    },
    (v) => {
      v.history.records[0].deletedBy = { kind: "unknown", typename: "Mannequin" };
    },
  ]) {
    const next = structuredClone(a);
    mutate(next);
    assert.equal(verifyGithubCommentEditRevision(next, first), false);
  }
  const invalid = structuredClone(a);
  invalid.history.records[0].body = "SYNTHETIC-RAW";
  assert.equal(verifyGithubCommentEditRevision(invalid, first), false);
});
