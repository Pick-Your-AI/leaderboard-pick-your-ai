import assert from "node:assert/strict";
import test from "node:test";
import { GithubReadClient } from "../../../packages/github/dist/index.js";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { repository, parent, edit, model, responseFor } from "../../../tests/fixtures/content-edit-metadata.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { createGithubContentEditAdmission } from "../src/content-edit-inventory.mjs";

const origin = "https://api.synthetic.invalid";
const until = "2026-10-01T12:00:00.000Z";
const approvedRepository = { ...repository, installationId: 1, families: ["content_edits"] };
const request = (overrides = {}) => ({
  repositoryId: repository.id,
  runId: "gce1:" + "a".repeat(64),
  family: "content_edits",
  mode: "audit",
  since: null,
  until,
  cursor: null,
  limit: 100,
  ...overrides,
});
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function source({ state = model(), admission, policy, assertAuthorized = () => {}, beforeResponse, checkpoints } = {}) {
  const calls = [];
  const tokens = [];
  const client = new GithubReadClient({
    apiOrigin: origin,
    token: async (scope) => {
      tokens.push(scope);
      return undefined;
    },
    checkpoints: checkpoints ?? syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const call = { path, method: options.method, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      await beforeResponse?.(call);
      if (path === `/repos/${repository.slug}`)
        return json({ id: repository.id, private: false, full_name: repository.slug });
      assert.equal(path, "/graphql", "metadata collection has no REST body or diff route");
      assert.equal(options.method, "POST");
      assert.doesNotMatch(call.body.query, /\b(?:body|bodyHTML|bodyText|diff|title|login|email)\b/);
      return json(responseFor(state, call.body));
    },
  });
  const read = createGithubCollectionSource({
    client,
    sourceId: "synthetic-content-edit-installation",
    repositories: [approvedRepository],
    isSynthetic: true,
    assertAuthorized,
    ...(policy === undefined && admission === undefined
      ? {}
      : { includeContentEditMetadata: policy ?? ((selected) => admission.allows(selected)) }),
  });
  return { read, calls, tokens };
}

function assertNeutral(page) {
  assert.equal(page.repositoryId, repository.id);
  assert.equal(page.visibility, "public");
  assert.equal(page.expectedCount, null, "parent snapshots cannot prove lifetime edit-history coverage");
  for (const fact of page.facts) {
    assert.equal(fact.evidence, "current_state");
    assert.equal(fact.actorId, null);
    assert.equal(fact.occurredAt, null);
    assert.equal(fact.state, "present");
    assert.equal(fact.subjectId, fact.contentEditMetadata.parent.id);
    assert.equal(fact.sourceUrl, fact.contentEditMetadata.parent.url);
    assert.match(fact.sourceRevision, /^gh-content-edit-v1:[a-f0-9]{64}\.[a-f0-9]{32}$/);
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
  }
}

for (const mode of ["audit", "backfill"])
  test(`admitted default content-edit ${mode} traverses both native parent inventories with unknown coverage`, async () => {
    const selected = request({ mode, limit: 1 });
    const admission = createGithubContentEditAdmission();
    assert.equal(admission.recordSelected(selected), true);
    const s = source({ admission });
    const first = await s.read.readPage(selected);
    assertNeutral(first);
    assert.equal(first.facts.length, 1);
    assert.equal(first.nextCursor, "1");
    const second = await s.read.readPage({ ...selected, cursor: first.nextCursor });
    assertNeutral(second);
    assert.equal(second.nextCursor, null);
    const facts = [...first.facts, ...second.facts];
    assert.deepEqual(new Set(facts.map((fact) => fact.subjectId)), new Set(["I_SYNTHETIC_11", "PR_SYNTHETIC_12"]));
    assert.deepEqual(facts.find((fact) => fact.subjectId === "PR_SYNTHETIC_12").contentEditMetadata.history, {
      availability: "available",
      retainedTotalCount: 0,
      records: [],
    });
    const graph = s.calls.filter((call) => call.path === "/graphql");
    assert.equal(graph.filter((call) => call.body.query.includes("GithubContentEditParents")).length, 2);
    assert.equal(graph.filter((call) => call.body.query.includes("GithubContentEditMetadata")).length, 2);
    assert.ok(graph.every((call) => call.body.variables.after === null));
  });

test("null and redacted edit metadata retain present parents and never retain unselected content", async () => {
  const state = model();
  const unavailable = parent("issue", 13, { title: "forbidden-parent-title" });
  state.issues.push(unavailable);
  state.histories.set(unavailable.id, { includesCreatedEdit: false, records: null });
  state.histories.get(state.issues[0].id).records = [
    edit("UCE_SYNTHETIC_REDACTED", {
      editor: null,
      deletedAt: "2026-01-03T00:00:00Z",
      deletedBy: null,
      body: "forbidden-edit-body",
      diff: "forbidden-edit-diff",
    }),
  ];
  const selected = request();
  const admission = createGithubContentEditAdmission();
  admission.recordSelected(selected);
  const s = source({ state, admission });
  const page = await s.read.readPage(selected);
  assertNeutral(page);
  assert.equal(page.facts.length, 3);
  assert.equal(page.nextCursor, null);
  const missing = page.facts.find((fact) => fact.subjectId === unavailable.id);
  assert.deepEqual(missing.contentEditMetadata.history, {
    availability: "unavailable",
    retainedTotalCount: null,
    records: null,
  });
  const redacted = page.facts.find((fact) => fact.subjectId === "I_SYNTHETIC_11").contentEditMetadata.history
    .records[0];
  assert.equal(redacted.editor, null);
  assert.equal(redacted.deletedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(redacted.deletedBy, null);
  assert.doesNotMatch(JSON.stringify(page), /forbidden-|"(?:body|diff|title)":/);
});

test("an empty native parent inventory remains complete traversal with unknown edit-history coverage", async () => {
  const admission = createGithubContentEditAdmission();
  const selected = request();
  admission.recordSelected(selected);
  const s = source({ state: { issues: [], pullRequests: [], histories: new Map() }, admission });
  const page = await s.read.readPage(selected);
  assertNeutral(page);
  assert.deepEqual(page.facts, []);
  assert.equal(page.nextCursor, null);
  assert.equal(s.calls.filter((call) => call.path === "/graphql").length, 2);
  assert.equal(
    s.calls.some((call) => call.body?.query.includes("GithubContentEditMetadata")),
    false,
  );
});

test("unadmitted and malformed content-edit requests fail before repository or metadata I/O", async (t) => {
  const vectors = [
    ["default absence", undefined, request(), "source_content_edit_inventory_unavailable"],
    ["explicit denial", () => false, request(), "source_content_edit_inventory_unavailable"],
    ["nonboolean policy", () => "true", request(), "invalid_content_edit_inventory_policy"],
    [
      "recent mode",
      () => true,
      request({ mode: "reconcile", since: "2026-09-30T00:00:00.000Z" }),
      "source_content_edit_window_unsupported",
    ],
    [
      "bounded audit",
      () => true,
      request({ since: "2026-09-30T00:00:00.000Z" }),
      "source_content_edit_window_unsupported",
    ],
    [
      "noncanonical cutoff",
      () => true,
      request({ until: "2026-10-01T12:00:00Z" }),
      "source_content_edit_window_unsupported",
    ],
  ];
  for (const [name, policy, selected, reason] of vectors)
    await t.test(name, async () => {
      const s = source({ policy });
      await assert.rejects(s.read.readPage(selected), new RegExp(reason));
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.tokens, []);
    });
});

test(
  "a captured content-edit request survives caller mutation while its repository probe waits",
  { timeout: 10000 },
  async () => {
    const selected = request();
    const original = structuredClone(selected);
    const admission = createGithubContentEditAdmission();
    admission.recordSelected(selected);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const seen = [];
    const s = source({
      policy(value) {
        seen.push(structuredClone(value));
        return admission.allows(value);
      },
      async beforeResponse(call) {
        if (call.path === `/repos/${repository.slug}`) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const pending = s.read.readPage(selected);
    const observed = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const watchdog = setTimeout(() => {
      release.resolve();
      entered.reject(new Error("synthetic repository probe was not reached"));
    }, 3000);
    try {
      await Promise.race([
        entered.promise,
        observed.then((outcome) => {
          throw outcome.error ?? new Error("source completed without its required repository probe");
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
    assertNeutral(outcome.value);
    assert.equal(outcome.value.facts.length, 2);
    assert.deepEqual(seen, [original]);
  },
);

test("live denial during a content-edit parent response prevents metadata delivery", { timeout: 10000 }, async () => {
  const selected = request();
  const admission = createGithubContentEditAdmission();
  admission.recordSelected(selected);
  let authorized = true;
  let deniedDuringResponse = false;
  const s = source({
    admission,
    assertAuthorized() {
      if (!authorized) throw new Error("synthetic content-edit authority revoked");
    },
    beforeResponse(call) {
      if (call.body?.query.includes("GithubContentEditParents")) {
        authorized = false;
        deniedDuringResponse = true;
      }
    },
  });
  await assert.rejects(s.read.readPage(selected));
  assert.equal(deniedDuringResponse, true, "the denial must occur at the actual awaited source response");
  assert.equal(s.calls.filter((call) => call.path === "/graphql").length, 1);
});
