import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubReadClient,
  githubCommentEditRevision,
  githubContentEditRevision,
} from "../../../packages/github/dist/index.js";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import {
  commentInventoryModel,
  commentInventoryResponse,
  repository,
} from "../../../tests/fixtures/comment-edit-inventory.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { createGithubContentEditAdmission } from "../src/content-edit-inventory.mjs";

const until = "2026-10-01T12:00:00.000Z";
const approvedRepository = { ...repository, installationId: 1, families: ["content_edits"] };
const request = (overrides = {}) => ({
  repositoryId: repository.id,
  runId: "gce2:" + "a".repeat(64),
  family: "content_edits",
  mode: "audit",
  since: null,
  until,
  cursor: null,
  limit: 100,
  ...overrides,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function source({
  state = commentInventoryModel(),
  admission,
  parentPolicy,
  commentPolicy,
  assertAuthorized = () => {},
  beforeResponse,
  checkpoints = syntheticCheckpointStore(),
} = {}) {
  const calls = [];
  const tokens = [];
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async (scope) => {
      tokens.push(scope);
      return undefined;
    },
    checkpoints,
    maxRetries: 0,
    fetch: async (url, options) => {
      const call = {
        path: new URL(url).pathname,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      const override = await beforeResponse?.(call);
      if (override !== undefined) return override;
      if (call.path === `/repos/${repository.slug}`)
        return json({ id: repository.id, private: false, full_name: repository.slug });
      assert.equal(call.path, "/graphql", "metadata collection never reads a body or diff REST route");
      assert.equal(options.method, "POST");
      assert.doesNotMatch(call.body.query, /\b(?:body|bodyHTML|bodyText|diff|title|login|email)\b/);
      return json(commentInventoryResponse(state, call.body));
    },
  });
  const options = {
    client,
    sourceId: "synthetic-comment-edit-installation",
    repositories: [approvedRepository],
    isSynthetic: true,
    assertAuthorized,
    ...(parentPolicy === undefined && admission === undefined
      ? {}
      : { includeContentEditMetadata: parentPolicy ?? ((selected) => admission.allows(selected)) }),
    ...(commentPolicy === undefined && admission === undefined
      ? {}
      : { includeCommentEditMetadata: commentPolicy ?? ((selected) => admission.allowsComments(selected)) }),
  };
  return { read: createGithubCollectionSource(options), options, calls, tokens, checkpoints };
}

function admitted(selected = request()) {
  const admission = createGithubContentEditAdmission();
  assert.equal(admission.recordSelected(selected), true);
  return admission;
}

function assertNeutral(page, runId) {
  assert.equal(page.repositoryId, repository.id);
  assert.equal(page.visibility, "public");
  assert.equal(page.isSynthetic, true);
  assert.equal(page.expectedCount, null, "current target enumeration does not prove lifetime edit coverage");
  for (const fact of page.facts) {
    const metadata = fact.contentEditMetadata;
    const comment = metadata.version === "github-comment-edit-metadata/v1";
    const target = comment ? metadata.target : metadata.parent;
    assert.deepEqual(Object.keys(fact).sort(), [
      "actorId",
      "contentEditMetadata",
      "evidence",
      "occurredAt",
      "sourceRevision",
      "sourceUrl",
      "state",
      "subjectId",
    ]);
    assert.equal(fact.subjectId, target.id);
    assert.equal(fact.sourceUrl, target.url);
    assert.equal(
      fact.sourceRevision,
      (comment ? githubCommentEditRevision : githubContentEditRevision)(metadata, runId),
    );
    assert.equal(fact.evidence, "current_state");
    assert.equal(fact.actorId, null);
    assert.equal(fact.occurredAt, null);
    assert.equal(fact.state, "present");
  }
  assert.doesNotMatch(JSON.stringify(page), /synthetic-never-retain|"(?:body|diff|title|login|email)":/);
}

for (const mode of ["audit", "backfill"])
  test(`v2 source ${mode} fully reads all published target families before returning offset pages`, async () => {
    const selected = request({ mode, limit: 3 });
    const s = source({ admission: admitted(selected) });
    const first = await s.read.readPage(selected);
    assertNeutral(first, selected.runId);
    assert.equal(first.facts.length, 3);
    assert.equal(first.nextCursor, "3");
    const histories = () => s.calls.filter((call) => call.body?.query.includes("query GithubCommentEditMetadata"));
    assert.equal(histories().length, 9, "even the first offset page waits for every published target history");
    const facts = [...first.facts];
    let cursor = first.nextCursor;
    const cursors = [cursor];
    while (cursor !== null) {
      const page = await s.read.readPage({ ...selected, cursor });
      assertNeutral(page, selected.runId);
      facts.push(...page.facts);
      cursor = page.nextCursor;
      cursors.push(cursor);
    }
    assert.deepEqual(cursors, ["3", "6", "9", null]);
    assert.equal(facts.length, 11);
    assert.equal(new Set(facts.map((fact) => fact.subjectId)).size, 11);
    const comments = facts.filter((fact) => fact.contentEditMetadata.version === "github-comment-edit-metadata/v1");
    assert.deepEqual(
      Object.fromEntries(
        [
          "issue_comment",
          "pull_request_conversation_comment",
          "pull_request_review",
          "pull_request_review_comment",
        ].map((kind) => [kind, comments.filter((fact) => fact.contentEditMetadata.target.kind === kind).length]),
      ),
      {
        issue_comment: 2,
        pull_request_conversation_comment: 2,
        pull_request_review: 2,
        pull_request_review_comment: 3,
      },
    );
    assert.equal(
      histories().length,
      9,
      "offset continuation revalidates retained pages without refetching completed histories",
    );
    assert.ok(histories().every((call) => !call.body.variables.id.endsWith("404")));
    assert.ok(facts.every((fact) => !fact.subjectId.endsWith("404")));
  });

test("a saved gce1 admission and an absent expanded policy keep the parent-only route literal", async () => {
  for (const selected of [request({ runId: "gce1:" + "b".repeat(64) }), request()]) {
    const s = selected.runId.startsWith("gce1:")
      ? source({ admission: admitted(selected) })
      : source({ parentPolicy: () => true });
    const page = await s.read.readPage(selected);
    assertNeutral(page, selected.runId);
    assert.equal(page.facts.length, 2);
    assert.ok(page.facts.every((fact) => fact.contentEditMetadata.version === "github-content-edit-metadata/v1"));
    assert.equal(
      s.calls.some((call) => call.body?.query.includes("GithubCommentEdit")),
      false,
    );
  }
});

test("expanded admission never bypasses the required parent admission or its exact saved tuple", async (t) => {
  for (const [name, options, selected] of [
    ["no parent policy", {}, request()],
    ["explicit parent denial", { parentPolicy: () => false }, request()],
    ["foreign cutoff", { admission: admitted() }, request({ until: "2026-10-02T12:00:00.000Z" })],
  ])
    await t.test(name, async () => {
      let expandedCalls = 0;
      const s = source({
        ...options,
        commentPolicy: () => {
          expandedCalls++;
          return true;
        },
      });
      await assert.rejects(s.read.readPage(selected), /source_content_edit_inventory_unavailable/);
      assert.equal(expandedCalls, 0);
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.tokens, []);
    });
});

test("expanded callbacks must be synchronous booleans and cannot trigger thenable access", async (t) => {
  let thenCalls = 0;
  const thenable = Object.defineProperty({}, "then", {
    get() {
      thenCalls++;
      throw new Error("must not inspect then");
    },
  });
  const vectors = [
    ["null", () => null],
    ["number", () => 1],
    ["text", () => "true"],
    ["resolved native promise", () => Promise.resolve(true)],
    ["rejected native promise", () => Promise.reject(new Error("synthetic callback rejection"))],
    ["untrusted thenable", () => thenable],
  ];
  for (const [name, commentPolicy] of vectors)
    await t.test(name, async () => {
      const s = source({ parentPolicy: () => true, commentPolicy });
      await assert.rejects(s.read.readPage(request()), /invalid_comment_edit_inventory_policy/);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.tokens, []);
    });
  assert.equal(thenCalls, 0);
});

test("nonfunction expanded selectors are rejected at construction", () => {
  const s = source();
  for (const value of [null, true, 1, "true", {}, []])
    assert.throws(
      () => createGithubCollectionSource({ ...s.options, includeCommentEditMetadata: value }),
      /invalid_github_collection_source/,
    );
  assert.deepEqual(s.calls, []);
});

test("rejected asynchronous policy results are observed even when authorization changes during the callback", async (t) => {
  for (const [name, parent, revoke] of [
    ["parent promise rejected with unchanged authority", true, false],
    ["parent promise rejected while authority is revoked", true, true],
    ["expanded promise rejected while authority is revoked", false, true],
  ])
    await t.test(name, async () => {
      let authorized = true;
      const invalidPolicy = () => {
        if (revoke) authorized = false;
        return Promise.reject(new Error("synthetic invalid policy rejection"));
      };
      const s = source({
        parentPolicy: parent ? invalidPolicy : () => true,
        commentPolicy: parent ? () => true : invalidPolicy,
        assertAuthorized() {
          if (!authorized) throw new Error("synthetic callback authority revoked");
        },
      });
      await assert.rejects(
        s.read.readPage(request()),
        revoke ? /synthetic callback authority revoked/ : /invalid_content_edit_inventory_policy/,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.tokens, []);
    });
});

test(
  "both policy decisions receive the frozen original tuple while an awaited caller mutates its request",
  { timeout: 10000 },
  async () => {
    const selected = request();
    const original = structuredClone(selected);
    const admission = admitted(selected);
    const seen = [];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const s = source({
      parentPolicy(value) {
        assert.equal(Object.isFrozen(value), true);
        seen.push(["parent", structuredClone(value)]);
        return admission.allows(value);
      },
      commentPolicy(value) {
        assert.equal(Object.isFrozen(value), true);
        assert.throws(() => {
          value.runId = "replacement";
        }, TypeError);
        seen.push(["comment", structuredClone(value)]);
        return admission.allowsComments(value);
      },
      async beforeResponse(call) {
        if (call.path === `/repos/${repository.slug}`) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const observed = s.read.readPage(selected).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const watchdog = setTimeout(() => {
      release.resolve();
      entered.reject(new Error("synthetic probe not reached"));
    }, 3000);
    try {
      await Promise.race([
        entered.promise,
        observed.then((outcome) => {
          throw outcome.error ?? new Error("completed before probe");
        }),
      ]);
      Object.assign(selected, {
        repositoryId: 99,
        family: "comments",
        runId: "replaced",
        mode: "reconcile",
        since: "changed",
        until: "changed",
        cursor: "999",
        limit: 0,
      });
    } finally {
      clearTimeout(watchdog);
      release.resolve();
    }
    const outcome = await observed;
    assert.equal(outcome.error, undefined);
    assertNeutral(outcome.value, original.runId);
    assert.equal(outcome.value.facts.length, 11);
    assert.deepEqual(seen, [
      ["parent", original],
      ["comment", original],
    ]);
  },
);

test("an interrupted nested inventory returns no fact page and resumes retained parents and threads", async () => {
  const selected = request({ limit: 1 });
  let fail = true;
  const s = source({
    admission: admitted(selected),
    beforeResponse(call) {
      if (
        fail &&
        call.body?.query.includes("query GithubCommentEditInventory") &&
        call.body.variables.id === "THREAD_SYNTHETIC_2"
      )
        return json({ message: "synthetic temporary source outage" }, 503);
    },
  });
  await assert.rejects(s.read.readPage(selected), (error) => error.name === "GithubClientError");
  assert.equal(
    s.calls.some((call) => call.body?.query.includes("query GithubCommentEditMetadata")),
    false,
  );
  const parentHistoryReads = s.calls.filter((call) =>
    call.body?.query.includes("query GithubContentEditMetadata"),
  ).length;
  assert.equal(parentHistoryReads, 2);
  fail = false;
  const page = await s.read.readPage(selected);
  assertNeutral(page, selected.runId);
  assert.equal(page.facts.length, 1);
  assert.equal(page.nextCursor, "1");
  assert.equal(
    s.calls.filter((call) => call.body?.query.includes("query GithubContentEditMetadata")).length,
    parentHistoryReads,
  );
  assert.equal(s.calls.filter((call) => call.body?.query.includes("query GithubCommentEditMetadata")).length, 9);
});

test("invalid history beyond the requested first offset cannot produce a partial success", async () => {
  const state = commentInventoryModel();
  const last = state.entries.get(state.threadComments.get("THREAD_SYNTHETIC_2")[0]);
  last.records[1].editor = { __typename: "User", id: "synthetic-unbound-actor" };
  const selected = request({ limit: 1 });
  const s = source({ state, admission: admitted(selected) });
  await assert.rejects(s.read.readPage(selected));
  assert.equal(s.calls.filter((call) => call.body?.query.includes("query GithubCommentEditMetadata")).length, 9);
});

test("live authority loss during nested inventory and before completed-cache reuse withholds all facts", async (t) => {
  await t.test("revoked during thread response", async () => {
    let authorized = true;
    let reached = false;
    const selected = request();
    const s = source({
      admission: admitted(selected),
      assertAuthorized() {
        if (!authorized) throw new Error("synthetic authority revoked");
      },
      beforeResponse(call) {
        if (
          call.body?.query.includes("query GithubCommentEditInventory") &&
          call.body.variables.id === "THREAD_SYNTHETIC_1"
        ) {
          reached = true;
          authorized = false;
        }
      },
    });
    await assert.rejects(s.read.readPage(selected));
    assert.equal(reached, true);
    assert.equal(
      s.calls.some((call) => call.body?.query.includes("query GithubCommentEditMetadata")),
      false,
    );
  });
  await t.test("revoked after a completed first read", async () => {
    let authorized = true;
    const selected = request();
    const s = source({
      admission: admitted(selected),
      assertAuthorized() {
        if (!authorized) throw new Error("synthetic authority revoked");
      },
    });
    assert.equal((await s.read.readPage(selected)).facts.length, 11);
    const before = [s.calls.length, s.tokens.length];
    authorized = false;
    await assert.rejects(s.read.readPage(selected), /synthetic authority revoked/);
    assert.deepEqual([s.calls.length, s.tokens.length], before);
  });
});
