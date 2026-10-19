import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GithubReadClient } from "../dist/client.js";
import { FileCheckpointStore } from "../dist/checkpoints.js";
import {
  githubContentEditRevision,
  parseGithubContentEditMetadata,
  readGithubContentEditMetadata,
  readGithubContentEditParents,
  verifyGithubContentEditRevision,
} from "../dist/content-edit-history.js";
import { edit, model, parent, repository, responseFor } from "../../../tests/fixtures/content-edit-metadata.mjs";

async function harness(t, state = model()) {
  const directory = await mkdtemp(join(tmpdir(), "github-content-edit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const h = { directory, state, calls, authorized: true, transform: undefined, beforeToken: undefined };
  h.reopen = () => {
    const checkpoints = new FileCheckpointStore(join(directory, "checkpoints"));
    h.client = new GithubReadClient({
      checkpoints,
      token: async () => {
        await h.beforeToken?.();
        return "synthetic-token";
      },
      maxRetries: 0,
      fetch: async (url, options) => {
        assert.equal(String(url), "https://api.github.com/graphql");
        assert.equal(options.method, "POST");
        const request = JSON.parse(options.body);
        calls.push(structuredClone(request));
        const response = responseFor(state, request);
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
    source: "synthetic-content-edits",
    repository: structuredClone(repository),
    scanId: "synthetic-audit-1",
    first: 1,
    maxPages: 10,
    assertAuthorized: () => {
      if (!h.authorized) throw new Error("synthetic access revoked");
    },
    ...extra,
  });
  return h;
}

function selectedParent(value) {
  return {
    kind: value.__typename === "Issue" ? "issue" : "pull_request",
    id: value.id,
    number: value.number,
    url: value.url,
  };
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

async function alterCheckpoint(h, predicate, mutate) {
  for (const file of await checkpointFiles(h.directory)) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(parsed.items) && parsed.items.some(predicate)) {
      mutate(parsed);
      await writeFile(file, JSON.stringify(parsed));
      return;
    }
  }
  assert.fail("expected a real saved content-edit page checkpoint");
}

test("available issue and pull-request histories reconcile independent parent and edit counts", async (t) => {
  const state = model();
  const second = parent("issue", 13);
  state.issues.push(second);
  state.histories.set(second.id, { includesCreatedEdit: false, records: null });
  state.histories.get(state.issues[0].id).records.push(edit("UCE_SYNTHETIC_0", { editor: null }));
  const h = await harness(t, state);
  const result = await readGithubContentEditParents(h.options());
  assert.deepEqual(result.parentTotals, { issues: 2, pullRequests: 1 });
  assert.equal(result.snapshots.length, 3);
  const issue = result.snapshots.find((item) => item.parent.id === state.issues[0].id);
  assert.equal(issue.includesCreatedEdit, true);
  assert.equal(issue.history.retainedTotalCount, 2);
  assert.deepEqual(
    issue.history.records.map((item) => item.id),
    ["UCE_SYNTHETIC_0", "UCE_SYNTHETIC_1"],
  );
  assert.equal(issue.history.records[0].editor, null);
  assert.equal(issue.history.records[1].editedAt, "2026-01-02T03:04:06.100Z");
  assert.deepEqual(result.snapshots.find((item) => item.parent.kind === "pull_request").history, {
    availability: "available",
    retainedTotalCount: 0,
    records: [],
  });
  assert.deepEqual(result.snapshots.find((item) => item.parent.id === second.id).history, {
    availability: "unavailable",
    retainedTotalCount: null,
    records: null,
  });
  assert.ok(h.calls.some((call) => call.variables.after === "parents:issues:1"));
  assert.ok(h.calls.some((call) => call.variables.after === `edits:${state.issues[0].id}:1`));
  const count = h.calls.length;
  h.reopen();
  assert.deepEqual(await readGithubContentEditParents(h.options()), result);
  assert.equal(h.calls.length, count, "completed durable page checkpoints avoid another HTTP scan");
});

test("an interrupted child scan resumes its own saved cursor after reopening the real checkpoint store", async (t) => {
  const state = model();
  state.histories.get(state.issues[0].id).records.push(edit("UCE_SYNTHETIC_2"));
  const h = await harness(t, state);
  let fail = true;
  h.transform = (_response, request) => {
    if (fail && request.variables.after === `edits:${state.issues[0].id}:1`)
      return new Response("synthetic unavailable", { status: 503 });
  };
  await assert.rejects(readGithubContentEditParents(h.options()), /transient_failure/);
  const failedCalls = h.calls.length;
  fail = false;
  h.reopen();
  const resumed = await readGithubContentEditParents(h.options());
  assert.equal(resumed.snapshots[0].history.retainedTotalCount, 2);
  const next = h.calls.slice(failedCalls);
  assert.equal(next[0].variables.after, `edits:${state.issues[0].id}:1`);
  assert.equal(next.filter((call) => call.query.includes("query GithubContentEditParents")).length, 0);
  assert.equal(next.filter((call) => call.variables.after === null && call.variables.number === 11).length, 0);
});

test("queries and persisted checkpoints omit raw text, author relations and unsupported actor identity", async (t) => {
  const state = model();
  const marker = "SYNTHETIC-UNSELECTED-CONTENT";
  state.histories.get(state.issues[0].id).records = [
    edit("UCE_SYNTHETIC_1", {
      diff: marker,
      body: marker,
      author: { login: marker },
      editor: { __typename: "Mannequin", id: marker, login: marker, email: marker },
      deletedBy: { __typename: "Bot", id: "BOT_SYNTHETIC_8", databaseId: null, login: marker },
      deletedAt: "2026-01-03T00:00:00Z",
    }),
  ];
  const h = await harness(t, state);
  const result = await readGithubContentEditParents(h.options());
  const row = result.snapshots[0].history.records[0];
  assert.deepEqual(row.editor, { kind: "unknown", typename: "Mannequin" });
  assert.deepEqual(row.deletedBy, { kind: "Bot", id: "BOT_SYNTHETIC_8", databaseId: null });
  assert.equal(row.deletedAt, "2026-01-03T00:00:00.000Z");
  assert.ok(!JSON.stringify(result).includes(marker));
  for (const request of h.calls) {
    assert.ok(!/\b(?:diff|body|bodyHTML|bodyText|title|author|login|email|authorAssociation)\b/.test(request.query));
    assert.ok(!/\b(?:mutation|subscription)\b/.test(request.query));
  }
  for (const file of await checkpointFiles(h.directory)) assert.ok(!(await readFile(file, "utf8")).includes(marker));
});

test("foreign, private and changed native parent identities fail rather than shrinking the inventory", async (t) => {
  const mutations = [
    [
      "private repository",
      (repo) => {
        repo.isPrivate = true;
      },
    ],
    [
      "different repository",
      (repo) => {
        repo.databaseId = 3;
      },
    ],
    [
      "missing connection",
      (repo) => {
        delete repo.issues;
      },
    ],
    [
      "null native parent",
      (repo) => {
        repo.issues.nodes[0] = null;
      },
    ],
    [
      "wrong parent type",
      (repo) => {
        repo.issues.nodes[0].__typename = "PullRequest";
      },
    ],
    [
      "foreign parent URL",
      (repo) => {
        repo.issues.nodes[0].url = "https://github.com/Synthetic/Other/issues/11";
      },
    ],
    [
      "wrong parent number",
      (repo) => {
        repo.issues.nodes[0].number = 12;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response) => {
        mutate(response.data.repository);
        return response;
      };
      await assert.rejects(readGithubContentEditParents(h.options()), /github_content_edit_/);
    });
});

test("child parent binding, required metadata and calendar precision remain strict", async (t) => {
  const mutations = [
    [
      "missing parent",
      (repo) => {
        repo.issue = null;
      },
    ],
    [
      "changed parent node",
      (repo) => {
        repo.issue.id = "I_SYNTHETIC_OTHER";
      },
    ],
    [
      "wrong child type",
      (repo) => {
        repo.issue.userContentEdits.nodes[0].__typename = "IssueComment";
      },
    ],
    [
      "null child",
      (repo) => {
        repo.issue.userContentEdits.nodes[0] = null;
      },
    ],
    [
      "missing nullable editor",
      (repo) => {
        delete repo.issue.userContentEdits.nodes[0].editor;
      },
    ],
    [
      "unknown creation flag",
      (repo) => {
        repo.issue.includesCreatedEdit = null;
      },
    ],
    [
      "invalid day",
      (repo) => {
        repo.issue.userContentEdits.nodes[0].createdAt = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "unsupported submillisecond",
      (repo) => {
        repo.issue.userContentEdits.nodes[0].editedAt = "2026-01-01T00:00:00.0001Z";
      },
    ],
    [
      "unsupported timezone",
      (repo) => {
        repo.issue.userContentEdits.nodes[0].updatedAt = "2026-01-01T00:00:00+00:00";
      },
    ],
    [
      "missing known actor ID",
      (repo) => {
        delete repo.issue.userContentEdits.nodes[0].editor.id;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const h = await harness(t);
      h.transform = (response, request) => {
        if (request.query.includes("query GithubContentEditMetadata")) mutate(response.data.repository);
        return response;
      };
      await assert.rejects(
        readGithubContentEditMetadata(h.options({ parent: selectedParent(h.state.issues[0]) })),
        /github_content_edit_/,
      );
    });
});

test("parent and child totals, creation flags and repeated cursors cannot silently change between pages", async (t) => {
  for (const scenario of ["parent total", "child total", "creation flag", "repeated cursor", "terminal mismatch"]) {
    await t.test(scenario, async (t) => {
      const state = model();
      const second = parent("issue", 13);
      state.issues.push(second);
      state.histories.set(second.id, { includesCreatedEdit: false, records: [] });
      state.histories.get(state.issues[0].id).records.push(edit("UCE_SYNTHETIC_2"));
      const h = await harness(t, state);
      h.transform = (response, request) => {
        const repo = response.data.repository;
        if (scenario === "parent total" && request.variables.after === "parents:issues:1") repo.issues.totalCount++;
        if (request.variables.after === `edits:${state.issues[0].id}:1`) {
          if (scenario === "child total") repo.issue.userContentEdits.totalCount++;
          if (scenario === "creation flag") repo.issue.includesCreatedEdit = false;
          if (scenario === "repeated cursor")
            repo.issue.userContentEdits.pageInfo = { hasNextPage: true, endCursor: request.variables.after };
        }
        if (scenario === "terminal mismatch" && request.query.includes("query GithubContentEditMetadata"))
          repo.issue ? repo.issue.userContentEdits.totalCount++ : repo.pullRequest.userContentEdits.totalCount++;
        return response;
      };
      await assert.rejects(readGithubContentEditParents(h.options()), /github_content_edit_|pagination repeated/);
    });
  }
});

test("duplicate native edit IDs are rejected within a parent and across different parents", async (t) => {
  for (const crossParent of [false, true])
    await t.test(crossParent ? "cross-parent" : "same-parent", async (t) => {
      const state = model();
      const history = state.histories.get(crossParent ? state.pullRequests[0].id : state.issues[0].id);
      history.records.push(edit());
      const h = await harness(t, state);
      await assert.rejects(readGithubContentEditParents(h.options()), /github_content_edit_duplicate/);
    });
});

test("metadata, parent and page budgets fail explicitly without truncating a successful result", async (t) => {
  for (const scenario of ["parent", "repository edits", "child retention", "page"])
    await t.test(scenario, async (t) => {
      const state = model();
      if (scenario === "repository edits")
        state.histories.get(state.pullRequests[0].id).records.push(edit("UCE_SYNTHETIC_2"));
      if (scenario === "child retention")
        state.histories.get(state.issues[0].id).records = Array.from({ length: 101 }, (_, i) =>
          edit(`UCE_SYNTHETIC_${i}`),
        );
      if (scenario === "page") state.histories.get(state.issues[0].id).records.push(edit("UCE_SYNTHETIC_2"));
      const h = await harness(t, state);
      const bound =
        scenario === "parent"
          ? { maxParents: 1 }
          : scenario === "repository edits"
            ? { maxEdits: 1 }
            : scenario === "page"
              ? { maxPages: 1 }
              : {};
      await assert.rejects(
        readGithubContentEditParents(h.options(bound)),
        /github_content_edit_budget|exceeded maxPages/,
      );
    });
});

test("completed cached pages must still prove their closed fields, native parent, counts and IDs", async (t) => {
  for (const scenario of ["raw field", "parent", "count", "duplicate", "missing page"])
    await t.test(scenario, async (t) => {
      const state = model();
      state.histories.get(state.issues[0].id).records.push(edit("UCE_SYNTHETIC_2"));
      const h = await harness(t, state);
      await readGithubContentEditParents(h.options());
      await alterCheckpoint(
        h,
        (item) => item.version === "github-content-edit-metadata-page/v1" && item.parent.id === state.issues[0].id,
        (checkpoint) => {
          const first = checkpoint.items[0];
          if (scenario === "raw field") first.records[0].diff = "SYNTHETIC-UNSELECTED-CONTENT";
          if (scenario === "parent") first.parent.id = "I_SYNTHETIC_OTHER";
          if (scenario === "count") first.retainedTotalCount++;
          if (scenario === "duplicate") checkpoint.items[1].records[0].id = first.records[0].id;
          if (scenario === "missing page") checkpoint.items.shift();
        },
      );
      const calls = h.calls.length;
      h.reopen();
      await assert.rejects(readGithubContentEditParents(h.options()), /github_content_edit_/);
      assert.equal(h.calls.length, calls, "invalid completed metadata does not trigger a disguised refresh");
    });
});

test("authorization loss after transport and on completed-cache reuse prevents result delivery", async (t) => {
  const h = await harness(t);
  let revoke = true;
  h.transform = () => {
    if (revoke) h.authorized = false;
  };
  await assert.rejects(readGithubContentEditParents(h.options()), /unsafe_request/);
  h.authorized = true;
  revoke = false;
  await readGithubContentEditParents(h.options());
  const count = h.calls.length;
  h.authorized = false;
  await assert.rejects(readGithubContentEditParents(h.options()), /unsafe_request|github_content_edit_/);
  assert.equal(h.calls.length, count);
});

test("reader captures repository, scan and paging inputs before the first authorization await", async (t) => {
  const h = await harness(t);
  const options = h.options();
  let changed = false;
  h.beforeToken = () => {
    if (changed) return;
    changed = true;
    options.repository.id = 999;
    options.repository.slug = "Synthetic/Other";
    options.source = "other-source";
    options.scanId = "other-scan";
    options.first = 0;
    options.maxPages = 0;
    options.assertAuthorized = () => {
      throw new Error("replacement callback");
    };
  };
  const result = await readGithubContentEditParents(options);
  assert.deepEqual(result.parentTotals, { issues: 1, pullRequests: 1 });
  assert.ok(h.calls.every((call) => call.variables.owner === "Synthetic" && call.variables.first === 1));
});

test("versioned metadata revisions preserve nullable meaning and immutable A to B to A observations", async (t) => {
  const h = await harness(t);
  const a = await readGithubContentEditMetadata(h.options({ parent: selectedParent(h.state.issues[0]) }));
  const b = structuredClone(a);
  b.history.records[0].editor = null;
  const firstA = githubContentEditRevision(a, "synthetic-scan-a");
  const changed = githubContentEditRevision(b, "synthetic-scan-b");
  const restored = githubContentEditRevision(a, "synthetic-scan-c");
  assert.notEqual(firstA, changed);
  assert.notEqual(firstA, restored);
  assert.equal(firstA.split(".")[0], restored.split(".")[0]);
  assert.equal(verifyGithubContentEditRevision(a, firstA), true);
  assert.equal(verifyGithubContentEditRevision(a, changed), false);
  assert.equal(verifyGithubContentEditRevision(a, restored), true);
  assert.equal(verifyGithubContentEditRevision(a, firstA.replace("gh-content-edit-v1:", "gh-rest-v1:")), false);
  assert.equal(verifyGithubContentEditRevision(a, firstA + "unexpected"), false);
  const invalid = structuredClone(a);
  invalid.history.records[0].body = "SYNTHETIC-UNSELECTED-CONTENT";
  assert.equal(verifyGithubContentEditRevision(invalid, firstA), false);
  assert.throws(() => parseGithubContentEditMetadata(invalid), /github_content_edit_/);
  const unavailable = structuredClone(a);
  unavailable.history = { availability: "unavailable", retainedTotalCount: null, records: null };
  assert.notEqual(githubContentEditRevision(unavailable, "synthetic-scan-a"), firstA);
});
