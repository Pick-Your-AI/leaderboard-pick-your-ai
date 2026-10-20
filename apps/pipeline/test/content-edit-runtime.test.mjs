import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { operatorHarness, operatorAllow } from "./operator-harness.mjs";
import { components } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { parseReconciliationRunId, reconciliationContextDigest } from "../src/reconciliation-plan.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { repository, parent, edit, model } from "../../../tests/fixtures/content-edit-metadata.mjs";
import { commentInventoryModel, commentInventoryResponse } from "../../../tests/fixtures/comment-edit-inventory.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";

const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const iso = (value) => new Date(value).toISOString();
const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const policy = { lookbackMs: 86400000, overlapMs: 1000, fullAuditsPerCycle: 2 };

function transport({ state = model(), commentState, beforeResponse } = {}) {
  const inventory = commentState ?? {
    parents: state,
    entries: new Map(),
    comments: new Map(),
    reviews: new Map(),
    threads: new Map(),
    threadComments: new Map(),
  };
  const cutoff = new Date(Date.now() - 1000).toISOString();
  const created = new Date(Date.parse(cutoff) - 86400000).toISOString();
  const actor = { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" };
  const conversation = {
    id: 10,
    node_id: "IC_SYNTHETIC_10",
    html_url: `https://github.com/${repository.slug}/pull/12#issuecomment-10`,
    url: `https://api.github.com/repos/${repository.slug}/issues/comments/10`,
    issue_url: `https://api.github.com/repos/${repository.slug}/issues/12`,
    created_at: created,
    updated_at: created,
    body: "synthetic conversation",
    user: actor,
  };
  const inline = {
    id: 10,
    node_id: "PRRC_SYNTHETIC_10",
    html_url: `https://github.com/${repository.slug}/pull/12#discussion_r10`,
    url: `https://api.github.com/repos/${repository.slug}/pulls/comments/10`,
    pull_request_url: `https://api.github.com/repos/${repository.slug}/pulls/12`,
    pull_request_review_id: 90,
    created_at: created,
    updated_at: created,
    body: "synthetic inline",
    user: actor,
  };
  const calls = [];
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => undefined,
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const call = { path, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      const replacement = await beforeResponse?.(call);
      if (replacement !== undefined) return replacement;
      if (path === `/repos/${repository.slug}`)
        return json({ id: repository.id, private: false, full_name: repository.slug });
      if (path === "/graphql") {
        assert.doesNotMatch(call.body.query, /\b(?:body|bodyHTML|bodyText|diff|title|login|email)\b/);
        return json(commentInventoryResponse(inventory, call.body));
      }
      const values = new Map([
        [`/repos/${repository.slug}/issues/comments`, [conversation]],
        [`/repos/${repository.slug}/issues/comments/10`, conversation],
        [`/repos/${repository.slug}/pulls/comments`, [inline]],
        [`/repos/${repository.slug}/pulls/comments/10`, inline],
      ]);
      assert.ok(values.has(path), `unexpected synthetic source route: ${path}`);
      return json(values.get(path));
    },
  });
  return { state, client, calls, cutoff };
}
const graphCalls = (s) => s.calls.filter((call) => call.path === "/graphql");
const inventoryCalls = (s) =>
  s.calls.filter((call) => call.path === "/graphql" || /\/(?:issues|pulls)\/comments$/.test(call.path));
const configure =
  (families = ["content_edits"], scheduled = false) =>
  (config) => {
    config.repositories[0].slug = repository.slug;
    config.repositories[0].families = [...families];
    if (scheduled) config.reconciliation = { ...policy };
  };
const runs = async (h) =>
  (await h.db.query("SELECT * FROM leaderboard_ingestion.collection_runs ORDER BY family,run_id")).rows;
const planTuple = (row) => ({
  runId: row.run_id,
  repositoryId: Number(row.repository_id),
  family: row.family,
  mode: row.mode,
  since: row.since_at === null ? null : iso(row.since_at),
  until: iso(row.until_at),
  generation: String(row.access_generation),
});
const count = async (h, table) => (await h.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const contentRows = async (h) =>
  (
    await h.db.query(
      "SELECT f.subject_id,f.source_revision,f.document AS source,n.document AS normalized FROM leaderboard_ingestion.source_facts f LEFT JOIN leaderboard_pipeline.normalizations n USING(fact_key) WHERE f.family='content_edits' ORDER BY f.subject_id",
    )
  ).rows;
async function assertNoPublicCreditOrSuppression(h, runtime = h.runtime) {
  assert.equal(await count(h, "leaderboard_ingestion.object_suppressions"), 0);
  const board = await runtime.app.inject("/api/v1/boards?metric=issues_opened");
  assert.equal(board.statusCode, 200, board.body);
  assert.deepEqual(board.json().rows, []);
  for (const { source, normalized } of await contentRows(h)) {
    assert.equal(source.actorId, null);
    assert.equal(source.occurredAt, null);
    assert.equal(source.evidence, "current_state");
    assert.equal(source.state, "present");
    const comment = source.contentEditMetadata.version === "github-comment-edit-metadata/v1";
    const target = comment ? source.contentEditMetadata.target : source.contentEditMetadata.parent;
    assert.equal(source.subjectId, target.id);
    assert.equal(source.sourceUrl, target.url);
    assert.match(
      source.sourceRevision,
      comment
        ? /^gh-content-edit-comment-v1:[a-f0-9]{64}\.[a-f0-9]{32}$/
        : /^gh-content-edit-v1:[a-f0-9]{64}\.[a-f0-9]{32}$/,
    );
    assert.ok(normalized, "each selected content observation has a retained normalization");
    for (const field of ["actors", "facts", "evidence", "assistance", "participation", "suppressArtifactIds"])
      assert.deepEqual(normalized[field], [], field);
    for (const field of ["artifacts", "observations", "contentEditMetadata"])
      assert.equal(Object.hasOwn(normalized, field), false, field);
    assert.deepEqual(normalized.reasons, ["content_edit_metadata_only"]);
  }
}

// These are real SQL/SQLite runtime journeys with synthetic HTTP transport. They
// certify no provider capability or lifetime edit-history coverage.
test(
  "default content audit stays neutral beside gc2 comments and replays exact observations after SQL reopen",
  { timeout: 30000 },
  async (t) => {
    const state = model();
    const unavailable = parent("issue", 13);
    state.issues.push(unavailable);
    state.histories.set(unavailable.id, { includesCreatedEdit: false, records: null });
    state.histories.get(state.issues[0].id).records = [
      edit("UCE_SYNTHETIC_REDACTED", {
        editor: null,
        deletedAt: "2026-01-03T00:00:00Z",
        deletedBy: null,
        body: "never-retain-edit-body",
        diff: "never-retain-edit-diff",
      }),
    ];
    const s = transport({ state });
    const h = await operatorHarness(t, { githubClient: s.client, configure: configure(["comments", "content_edits"]) });
    const first = await h.runtime.runOnce({ mode: "audit", cutoff: s.cutoff });
    assert.equal(first.state, "published");
    assert.match(first.progress.find((row) => row.family === "comments").runId, /^gc2:[a-f0-9]{64}$/);
    const content = first.progress.find((row) => row.family === "content_edits");
    assert.match(content.runId, /^gce2:[a-f0-9]{64}$/);
    const saved = (await runs(h)).find((row) => row.run_id === content.runId);
    assert.equal(saved.item_count, 3);
    assert.equal(saved.expected_count, null);
    assert.equal(saved.page_count, 1);
    const observations = await contentRows(h);
    assert.deepEqual(
      observations.map((row) => row.subject_id),
      ["I_SYNTHETIC_11", "I_SYNTHETIC_13", "PR_SYNTHETIC_12"],
    );
    assert.deepEqual(observations.find((row) => row.subject_id === unavailable.id).source.contentEditMetadata.history, {
      availability: "unavailable",
      retainedTotalCount: null,
      records: null,
    });
    assert.deepEqual(
      observations.find((row) => row.subject_id === "PR_SYNTHETIC_12").source.contentEditMetadata.history,
      { availability: "available", retainedTotalCount: 0, records: [] },
    );
    assert.doesNotMatch(JSON.stringify(observations), /never-retain-edit-(?:body|diff)/);
    await assertNoPublicCreditOrSuppression(h);
    const comments = (
      await h.db.query(
        "SELECT f.subject_id,f.source_revision,n.document FROM leaderboard_ingestion.source_facts f JOIN leaderboard_pipeline.normalizations n USING(fact_key) WHERE f.family='comments' ORDER BY f.subject_id",
      )
    ).rows;
    assert.deepEqual(
      comments.map((row) => [row.subject_id, row.source_revision.split(":")[0]]),
      [
        ["IC_SYNTHETIC_10", "gh-rest-v1"],
        ["PRRC_SYNTHETIC_10", "gh-rest-comment-v2"],
      ],
    );
    for (const row of comments) {
      assert.deepEqual(row.document.facts, []);
      assert.deepEqual(row.document.evidence, []);
      assert.deepEqual(row.document.participation, []);
    }
    const beforeFacts = (
      await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
    ).rows;
    const beforeReads = inventoryCalls(s).length;
    await h.runtime.stop();
    await h.reopenDatabase();
    const reopened = await createPipeline(h.options);
    t.after(() => reopened.stop());
    const again = await reopened.runOnce({ mode: "audit", cutoff: s.cutoff });
    assert.equal(again.state, "published");
    assert.deepEqual(again.progress, first.progress);
    assert.equal(inventoryCalls(s).length, beforeReads, "a completed saved run does not collect or hydrate again");
    assert.deepEqual(
      (await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
      beforeFacts,
    );
    assert.deepEqual(
      again.publications.map((row) => [row.snapshotId, row.revision]),
      first.publications.map((row) => [row.snapshotId, row.revision]),
    );
    await assertNoPublicCreditOrSuppression(h, reopened);
  },
);

test(
  "a failed actual content audit plan resumes its saved rc1 tuple after reopen without claiming historic coverage",
  { timeout: 30000 },
  async (t) => {
    let interrupted = false;
    const s = transport({
      beforeResponse(call) {
        if (!interrupted && call.path === "/graphql" && call.body.query.includes("GithubContentEditParents")) {
          interrupted = true;
          // Reject before a page can enter the retained checkpoint. This is not a
          // rate-limit response, so retry does not bypass a persisted quota pause.
          return json({ errors: [{ message: "synthetic interrupted metadata inventory" }] });
        }
      },
    });
    const h = await operatorHarness(t, {
      githubClient: s.client,
      configure: configure(["comments", "content_edits"], true),
    });
    const first = await h.runtime.runOnce();
    assert.equal(interrupted, true, "the source-failure injection must be reached");
    assert.equal(first.state, "collecting");
    assert.equal(first.progress.find((row) => row.family === "content_edits").status, "failed");
    const before = await runs(h);
    assert.equal(before.length, 2);
    const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows;
    assert.equal(saved.length, 1);
    const sources = [{ repositoryId: repository.id, generation: "1" }];
    const oldContext = [0, null, sources, "github-comments-inventory/v2"];
    const key = hash(["bounded-scan/v1", h.config, "synthetic", "reconcile"]);
    const contextHash = hash([...oldContext, "github-content-edits/metadata-v2"]);
    assert.equal(saved[0].configuration_key, key);
    assert.equal(saved[0].context_hash, contextHash);
    const expected = reconciliationContextDigest({ key, contextHash });
    assert.notEqual(expected, reconciliationContextDigest({ key, contextHash: hash(oldContext) }));
    for (const row of before) {
      const identity = parseReconciliationRunId(row.run_id);
      assert.equal(identity.contextDigest, expected);
      assert.equal(identity.token, saved[0].cycle_token);
      assert.equal(identity.total, 2);
      assert.equal(row.mode, "audit");
      assert.equal(row.since_at, null);
      assert.equal(iso(row.until_at), iso(saved[0].event_cutoff));
    }
    const contentBefore = before.find((row) => row.family === "content_edits");
    assert.equal(contentBefore.page_count, 0);
    assert.equal(contentBefore.item_count, 0);
    const parentReads = graphCalls(s).length;
    await h.runtime.stop();
    await h.reopenDatabase();
    const reopened = await createPipeline(h.options);
    t.after(() => reopened.stop());
    const second = await reopened.runOnce();
    assert.equal(second.state, "published");
    assert.deepEqual((await runs(h)).map(planTuple), before.map(planTuple));
    assert.ok(graphCalls(s).length > parentReads, "the retained failed plan is actually resumed");
    const contentAfter = (await runs(h)).find((row) => row.family === "content_edits");
    assert.equal(contentAfter.state, "complete");
    assert.equal(contentAfter.item_count, 2);
    assert.equal(contentAfter.expected_count, null);
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows, []);
    const frozen = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        second.publications[0].snapshotId,
      ])
    ).rows[0].document.frozen;
    assert.ok(frozen.coverage.length > 0);
    for (const coverage of frozen.coverage) {
      assert.equal(coverage.knownStart, null);
      assert.equal(coverage.sourceWatermark, null);
      assert.ok(coverage.sourceErrors.includes("reconciliation_count_unknown"));
      assert.ok(coverage.sourceErrors.includes("reconciliation_baseline_unavailable"));
    }
    const diagnostic = await reopened.operations.readHealth(repository.id, operatorAllow);
    const contentHealth = diagnostic.collector.families.find((row) => row.family === "content_edits");
    assert.equal(contentHealth.expectedItems, null);
    assert.equal(contentHealth.reconciledThrough, null);
    assert.ok(contentHealth.lastSuccessAt !== null);
    await assertNoPublicCreditOrSuppression(h, reopened);
  },
);

for (const retainedState of ["complete", "pending", "failed"])
  test(
    `a retained ${retainedState} legacy content run is never renamed or silently repaired by metadata inventory`,
    { timeout: 20000 },
    async (t) => {
      const s = transport();
      const h = await operatorHarness(t, { githubClient: s.client, configure: configure() });
      const runId = hash([h.config.version, repository.id, "content_edits", s.cutoff, "audit", "synthetic"]);
      const request = {
        runId,
        repositoryId: repository.id,
        family: "content_edits",
        mode: "audit",
        since: null,
        until: s.cutoff,
      };
      await h.runtime.collection.start(request);
      const oldFact = {
        subjectId: "I_SYNTHETIC_11",
        sourceRevision: "synthetic-legacy-content-v1",
        sourceUrl: `https://github.com/${repository.slug}/issues/11`,
        evidence: "current_state",
        actorId: null,
        occurredAt: null,
        state: "present",
      };
      assert.equal(
        await h.runtime.collection.step(runId, {
          async readPage() {
            return {
              repositoryId: repository.id,
              visibility: "public",
              isSynthetic: true,
              facts: [oldFact],
              nextCursor: retainedState === "complete" ? null : "legacy-next",
              expectedCount: retainedState === "complete" ? 1 : 2,
            };
          },
        }),
        retainedState === "complete" ? "complete" : "progress",
      );
      if (retainedState === "failed")
        assert.equal(
          await h.runtime.collection.step(runId, {
            readPage() {
              throw new Error("synthetic old source failure");
            },
          }),
          "failed",
        );
      const before = (await runs(h))[0];
      assert.equal(before.state, retainedState);
      const oldFacts = (
        await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
      ).rows;
      const result = await h.runtime.runOnce({ mode: "audit", cutoff: s.cutoff });
      assert.equal(result.state, retainedState === "complete" ? "published" : "collecting");
      assert.equal(result.progress[0].runId, runId);
      const after = await runs(h);
      assert.equal(after.length, 1, "no fresh versioned run bypasses a retained old operation");
      assert.deepEqual(planTuple(after[0]), planTuple(before));
      for (const field of ["cursor", "page_count", "item_count", "expected_count"])
        assert.equal(after[0][field], before[field], field);
      assert.equal(after[0].state, retainedState === "complete" ? "complete" : "failed");
      assert.equal(graphCalls(s).length, 0);
      assert.deepEqual(
        (await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
        oldFacts,
      );
      assert.equal(await count(h, "leaderboard_ingestion.object_suppressions"), 0);
      if (retainedState !== "complete") assert.equal(await count(h, "leaderboard_pipeline.snapshots"), 0);
    },
  );

test(
  "unplanned default content reconciliation rejects before metadata I/O or run materialization",
  { timeout: 20000 },
  async (t) => {
    const s = transport();
    const h = await operatorHarness(t, { githubClient: s.client, configure: configure() });
    await assert.rejects(h.runtime.runOnce({ cutoff: s.cutoff }), /invalid_content_edit_inventory_request/);
    assert.equal(graphCalls(s).length, 0);
    assert.deepEqual(await runs(h), []);
    assert.equal(await count(h, "leaderboard_ingestion.source_facts"), 0);
    assert.equal(await count(h, "leaderboard_pipeline.snapshots"), 0);
  },
);

test(
  "an actual source-generation change during content inventory denies the page commit and publication",
  { timeout: 20000 },
  async (t) => {
    let h,
      changed = false;
    const s = transport({
      async beforeResponse(call) {
        if (!changed && call.path === "/graphql") {
          changed = true;
          await h.db.query(
            "UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=$1",
            [repository.id],
          );
        }
      },
    });
    h = await operatorHarness(t, { githubClient: s.client, configure: configure() });
    const result = await h.runtime.runOnce({ mode: "audit", cutoff: s.cutoff });
    assert.equal(changed, true, "the actual source response must change the persisted generation");
    assert.equal(result.state, "collecting");
    assert.equal(result.progress[0].status, "failed");
    const saved = (await runs(h))[0];
    assert.equal(String(saved.access_generation), "1");
    assert.equal(saved.page_count, 0);
    assert.equal(saved.item_count, 0);
    assert.equal(await count(h, "leaderboard_ingestion.source_facts"), 0);
    assert.equal(await count(h, "leaderboard_pipeline.snapshots"), 0);
    assert.equal(await count(h, "leaderboard_ingestion.object_suppressions"), 0);
  },
);

test(
  "current configuration revision withdrawal during a content response denies collection and publication",
  { timeout: 20000 },
  async (t) => {
    let revision = 0,
      changed = false;
    const s = transport({
      beforeResponse(call) {
        if (!changed && call.path === "/graphql") {
          changed = true;
          revision++;
        }
      },
    });
    const h = await operatorHarness(t, {
      githubClient: s.client,
      configure: configure(),
      configurationOverlay: () => ({
        revision,
        allowedRepositoryIds: null,
        allowedRepositories: null,
        allowedProjectIds: null,
        disabledMetricIds: [],
        disabledMetrics: [],
      }),
    });
    await assert.rejects(h.runtime.runOnce({ mode: "audit", cutoff: s.cutoff }), /active_configuration_changed/);
    assert.equal(changed, true, "the current host revision must change during the actual response");
    assert.equal(graphCalls(s).length, 1);
    assert.equal((await runs(h))[0].page_count, 0);
    assert.equal(await count(h, "leaderboard_ingestion.source_facts"), 0);
    assert.equal(await count(h, "leaderboard_pipeline.snapshots"), 0);
    assert.equal(await count(h, "leaderboard_ingestion.object_suppressions"), 0);
  },
);

test(
  "a custom content source retains its old scheduled context and never inherits default metadata admission",
  { timeout: 20000 },
  async (t) => {
    const s = transport();
    const requests = [];
    const h = await operatorHarness(t, {
      githubClient: s.client,
      configure: configure(["comments", "content_edits"], true),
      source: {
        async readPage(request) {
          requests.push(structuredClone(request));
          return {
            repositoryId: repository.id,
            visibility: "public",
            isSynthetic: true,
            facts: [],
            nextCursor: null,
            expectedCount: 0,
          };
        },
      },
    });
    const result = await h.runtime.runOnce();
    assert.equal(result.state, "published");
    assert.equal(requests.length, 2);
    const expected = reconciliationContextDigest({
      key: hash(["bounded-scan/v1", h.config, "synthetic", "reconcile"]),
      contextHash: hash([0, null, [{ repositoryId: repository.id, generation: "1" }]]),
    });
    for (const request of requests) {
      assert.equal(parseReconciliationRunId(request.runId).contextDigest, expected);
      assert.equal(request.mode, "audit");
    }
    assert.equal(inventoryCalls(s).length, 0);
    assert.equal(await count(h, "leaderboard_ingestion.source_facts"), 0);
    assert.equal(await count(h, "leaderboard_ingestion.object_suppressions"), 0);
  },
);

test(
  "the default v2 audit collects and hydrates all four published comment families without contribution credit",
  { timeout: 30000 },
  async (t) => {
    const commentState = commentInventoryModel();
    const s = transport({ state: commentState.parents, commentState });
    const h = await operatorHarness(t, { githubClient: s.client, configure: configure() });
    const result = await h.runtime.runOnce({ mode: "audit", cutoff: s.cutoff });
    assert.equal(result.state, "published");
    assert.match(result.progress[0].runId, /^gce2:[a-f0-9]{64}$/);
    const rows = await contentRows(h);
    assert.equal(rows.length, 11);
    const comments = rows.filter((row) => row.source.contentEditMetadata.version === "github-comment-edit-metadata/v1");
    assert.equal(comments.length, 9);
    assert.deepEqual([...new Set(comments.map((row) => row.source.contentEditMetadata.target.kind))].sort(), [
      "issue_comment",
      "pull_request_conversation_comment",
      "pull_request_review",
      "pull_request_review_comment",
    ]);
    assert.ok(comments.every((row) => row.source.contentEditMetadata.repository.id === repository.id));
    assert.doesNotMatch(
      JSON.stringify(rows),
      /synthetic-never-retain|COMMENT_SYNTHETIC_pull_request_review_comment_404/,
    );
    const saved = (await runs(h))[0];
    assert.equal(saved.item_count, 11);
    assert.equal(saved.expected_count, null);
    const historyReads = graphCalls(s).filter((call) => call.body.query.includes("query GithubCommentEditMetadata"));
    assert.equal(historyReads.length, 18, "each of nine collected targets has a separately bound hydration read");
    await assertNoPublicCreditOrSuppression(h);
    const retained = await h.db.query(
      "SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
    );
    const reads = inventoryCalls(s).length;
    await h.runtime.stop();
    await h.reopenDatabase();
    const reopened = await createPipeline(h.options);
    t.after(() => reopened.stop());
    const again = await reopened.runOnce({ mode: "audit", cutoff: s.cutoff });
    assert.equal(again.state, "published");
    assert.deepEqual(again.progress, result.progress);
    assert.equal(inventoryCalls(s).length, reads);
    assert.deepEqual(
      (await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
      retained.rows,
    );
    await assertNoPublicCreditOrSuppression(h, reopened);
  },
);

for (const retainedState of ["complete", "pending", "failed"])
  test(
    `a retained ${retainedState} gce1 parent run keeps its exact namespace and never enumerates comment targets`,
    { timeout: 30000 },
    async (t) => {
      const commentState = commentInventoryModel();
      const s = transport({ state: commentState.parents, commentState });
      const h = await operatorHarness(t, { githubClient: s.client, configure: configure() });
      const runId = "gce1:" + hash([h.config.version, repository.id, "content_edits", s.cutoff, "audit", "synthetic"]);
      const request = {
        runId,
        repositoryId: repository.id,
        family: "content_edits",
        mode: "audit",
        since: null,
        until: s.cutoff,
      };
      await h.runtime.collection.start(request);
      const source = createGithubCollectionSource({
        client: s.client,
        sourceId: h.options.sourceId,
        repositories: h.config.repositories,
        isSynthetic: true,
        includeContentEditMetadata: () => true,
      });
      const oldPage = await source.readPage({ ...request, cursor: null, limit: 100 });
      const first =
        retainedState === "complete" ? oldPage : { ...oldPage, facts: oldPage.facts.slice(0, 1), nextCursor: "1" };
      assert.equal(
        await h.runtime.collection.step(runId, { readPage: async () => first }),
        retainedState === "complete" ? "complete" : "progress",
      );
      if (retainedState === "failed")
        assert.equal(
          await h.runtime.collection.step(runId, {
            readPage() {
              throw new Error("synthetic retained v1 failure");
            },
          }),
          "failed",
        );
      const before = (await runs(h))[0];
      const retainedFacts = (
        await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
      ).rows;
      await h.runtime.stop();
      await h.reopenDatabase();
      const reopened = await createPipeline(h.options);
      t.after(() => reopened.stop());
      const result = await reopened.runOnce({ mode: "audit", cutoff: s.cutoff });
      assert.equal(result.state, "published");
      assert.equal(result.progress[0].runId, runId);
      const after = await runs(h);
      assert.equal(after.length, 1);
      assert.deepEqual(planTuple(after[0]), planTuple(before));
      assert.equal(after[0].item_count, 2);
      assert.equal(after[0].expected_count, null);
      for (const retained of retainedFacts) {
        const actual = (
          await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [
            retained.fact_key,
          ])
        ).rows[0];
        assert.deepEqual(actual, retained);
      }
      assert.equal(graphCalls(s).filter((call) => call.body.query.includes("query GithubCommentEdit")).length, 0);
      assert.equal((await contentRows(h)).length, 2);
      await assertNoPublicCreditOrSuppression(h, reopened);
    },
  );

test(
  "an interrupted v2 nested inventory commits no partial fact page and resumes the same actual scheduled plan",
  { timeout: 30000 },
  async (t) => {
    const commentState = commentInventoryModel();
    let failed = false;
    const s = transport({
      state: commentState.parents,
      commentState,
      beforeResponse(call) {
        if (
          !failed &&
          call.path === "/graphql" &&
          call.body.query.includes("query GithubCommentEditInventory") &&
          call.body.variables.id === "THREAD_SYNTHETIC_2"
        ) {
          failed = true;
          return json({ errors: [{ message: "synthetic interrupted child inventory" }] });
        }
      },
    });
    const h = await operatorHarness(t, { githubClient: s.client, configure: configure(["content_edits"], true) });
    const first = await h.runtime.runOnce();
    assert.equal(failed, true);
    assert.equal(first.state, "collecting");
    const before = (await runs(h))[0];
    assert.equal(before.item_count, 0);
    assert.equal(before.page_count, 0);
    assert.equal(await count(h, "leaderboard_ingestion.source_facts"), 0);
    assert.equal(await count(h, "leaderboard_pipeline.snapshots"), 0);
    const scan = (await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows[0];
    const parsed = parseReconciliationRunId(before.run_id);
    assert.equal(parsed.token, scan.cycle_token);
    await h.runtime.stop();
    await h.reopenDatabase();
    const reopened = await createPipeline(h.options);
    t.after(() => reopened.stop());
    const result = await reopened.runOnce();
    assert.equal(result.state, "published");
    const after = (await runs(h))[0];
    assert.deepEqual(planTuple(after), planTuple(before));
    assert.equal(after.item_count, 11);
    assert.equal(after.expected_count, null);
    const health = await reopened.operations.readHealth(repository.id, operatorAllow);
    const coverage = health.collector.families.find((value) => value.family === "content_edits");
    assert.equal(coverage.expectedItems, null);
    assert.equal(coverage.reconciledThrough, null);
    await assertNoPublicCreditOrSuppression(h, reopened);
  },
);
