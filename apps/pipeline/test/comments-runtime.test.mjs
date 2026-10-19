import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { operatorHarness, insertOperatorDelivery } from "./operator-harness.mjs";
import { components } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { webhookDispatchVersion } from "../src/webhook-dispatch.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { reconciliationContextDigest, parseReconciliationRunId } from "../src/reconciliation-plan.mjs";
const slug = "synthetic-org/synthetic-repo";
const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const jsonHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function transport() {
  const clock = new Date(Date.now() - 1000).toISOString();
  const created = new Date(Date.parse(clock) - 86400000).toISOString();
  const actor = { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" };
  const issue = {
    id: 1,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    title: "Synthetic issue",
    state: "open",
    html_url: `https://github.com/${slug}/issues/1`,
    created_at: created,
    updated_at: created,
    user: actor,
  };
  const conversation = {
    id: 10,
    node_id: "IC_SYNTHETIC_10",
    html_url: `https://github.com/${slug}/pull/7#issuecomment-10`,
    url: `https://api.github.com/repos/${slug}/issues/comments/10`,
    issue_url: `https://api.github.com/repos/${slug}/issues/7`,
    created_at: created,
    updated_at: created,
    body: "synthetic conversation",
    user: actor,
  };
  const inline = {
    id: 10,
    node_id: "PRRC_SYNTHETIC_10",
    html_url: `https://github.com/${slug}/pull/7#discussion_r10`,
    url: `https://api.github.com/repos/${slug}/pulls/comments/10`,
    pull_request_url: `https://api.github.com/repos/${slug}/pulls/7`,
    pull_request_review_id: 90,
    created_at: created,
    updated_at: created,
    body: "synthetic inline",
    user: actor,
  };
  const calls = [];
  const checkpoints = syntheticCheckpointStore();
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => undefined,
    checkpoints,
    maxRetries: 0,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const value =
        path === `/repos/${slug}`
          ? { id: 2, private: false, full_name: slug }
          : path === `/repos/${slug}/issues`
            ? [issue]
            : path === `/repos/${slug}/issues/1`
              ? issue
              : path === `/repos/${slug}/issues/comments`
                ? [conversation]
                : path === `/repos/${slug}/issues/comments/10`
                  ? conversation
                  : path === `/repos/${slug}/pulls/comments`
                    ? [inline]
                    : path === `/repos/${slug}/pulls/comments/10`
                      ? inline
                      : null;
      return new Response(JSON.stringify(value ?? {}), {
        status: value === null ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, calls, clock, created };
}
const commentLists = (calls) => calls.filter((path) => /\/(issues|pulls)\/comments$/.test(path));

test(
  "fresh default comments retain exact native identity and neutral normalization across SQL reopen",
  { timeout: 20000 },
  async (t) => {
    const s = transport();
    const h = await operatorHarness(t, {
      githubClient: s.client,
      configure(config) {
        config.repositories[0].families = ["issues", "comments"];
      },
    });
    const first = await h.runtime.runOnce({ cutoff: s.clock });
    assert.equal(first.state, "published");
    const run = first.progress.find((item) => item.family === "comments");
    assert.match(run.runId, /^gc2:[a-f0-9]{64}$/);
    const counts = (
      await h.db.query("SELECT item_count,expected_count FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [
        run.runId,
      ])
    ).rows[0];
    assert.deepEqual(counts, { item_count: 2, expected_count: 2 });
    const comments = (
      await h.db.query(
        "SELECT n.document,f.subject_id,f.document AS source FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='comments' ORDER BY f.subject_id",
      )
    ).rows;
    assert.deepEqual(
      comments.map((row) => row.subject_id),
      ["IC_SYNTHETIC_10", "PRRC_SYNTHETIC_10"],
    );
    assert.deepEqual(
      comments.map((row) => row.source.sourceUrl),
      [`https://github.com/${slug}/pull/7#issuecomment-10`, `https://github.com/${slug}/pull/7#discussion_r10`],
    );
    for (const row of comments) {
      assert.equal(row.source.actorId, null);
      assert.equal(row.source.occurredAt, null);
      assert.deepEqual(row.document.facts, []);
      assert.deepEqual(row.document.evidence, []);
      assert.deepEqual(row.document.participation, []);
      assert.ok(
        row.document.reasons.includes("pr_comment_snapshot_does_not_prove_submitted_review_or_accepted_answer"),
      );
    }
    const snapshots = (await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots")).rows;
    assert.ok(snapshots.every((row) => !JSON.stringify(row.document).includes("synthetic inline")));
    const beforeLists = commentLists(s.calls).length;
    await h.runtime.stop();
    await h.reopenDatabase();
    const reopened = await createPipeline(h.options);
    t.after(() => reopened.stop());
    const second = await reopened.runOnce({ cutoff: s.clock });
    assert.equal(second.state, "published");
    assert.deepEqual(second.progress, first.progress);
    assert.equal(commentLists(s.calls).length, beforeLists);
    assert.deepEqual(
      second.publications.map((item) => [item.snapshotId, item.revision]),
      first.publications.map((item) => [item.snapshotId, item.revision]),
    );
  },
);

test(
  "a frozen legacy dispatch reopens with original collection IDs and never recollects comments",
  { timeout: 20000 },
  async (t) => {
    const s = transport();
    const h = await operatorHarness(t, {
      githubClient: s.client,
      webhookDispatch: true,
      configure(config) {
        config.repositories[0].families = ["issues", "comments"];
      },
    });
    await insertOperatorDelivery(h, 919, s.created);
    assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
    const lease = await h.runtime.outbox.claim({
      configurationHash: jsonHash(h.config),
      configurationVersion: h.config.version,
      configurationRevision: 0,
      normalizationVersion: webhookDispatchVersion,
      policyVersion: components.metrics.metricRegistryV1.policy_version,
      dataMode: "synthetic",
      cutoff: s.clock,
    });
    assert.ok(lease);
    const legacy = createGithubCollectionSource({
      client: s.client,
      sourceId: "installation:1",
      repositories: h.config.repositories,
      isSynthetic: true,
    });
    const ids = [];
    for (const family of ["issues", "comments"]) {
      const runId = hash([
        h.config.version,
        2,
        family,
        s.clock,
        "reconcile",
        "synthetic",
        lease.operation.operationKey,
        lease.collectionRevision,
      ]);
      ids.push(runId);
      await h.runtime.collection.start({
        runId,
        repositoryId: 2,
        family,
        mode: "reconcile",
        since: null,
        until: s.clock,
      });
      assert.equal(await h.runtime.collection.step(runId, legacy), "complete");
    }
    const frozen = await h.runtime.outbox.freeze(lease, new Date().toISOString(), [
      { repositoryId: 2, generation: "1" },
    ]);
    const oldFacts = (await h.db.query("SELECT fact_key FROM leaderboard_ingestion.source_facts ORDER BY fact_key"))
      .rows;
    assert.equal(await h.runtime.outbox.fail(lease, "publication_unavailable"), "retry_scheduled");
    await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=$1", [s.created]);
    const priorLists = commentLists(s.calls).length;
    await h.runtime.stop();
    await h.reopenDatabase();
    const reopened = await createPipeline(h.options);
    t.after(() => reopened.stop());
    assert.equal(await reopened.dispatchOnce(), "processed");
    assert.equal(commentLists(s.calls).length, priorLists);
    assert.deepEqual(
      (await h.db.query("SELECT run_id FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows.map(
        (row) => row.run_id,
      ),
      ids.sort(),
    );
    assert.deepEqual(
      (await h.db.query("SELECT fact_key FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
      oldFacts,
    );
    const row = (
      await h.db.query("SELECT operation,observation_cutoff,source_generations,state FROM leaderboard_ingestion.outbox")
    ).rows[0];
    assert.deepEqual(row.operation, lease.operation);
    assert.equal(new Date(row.observation_cutoff).toISOString(), frozen.cutoff);
    assert.deepEqual(row.source_generations, frozen.generations);
    assert.equal(row.state, "done");
  },
);

for (const custom of [false, true])
  test(
    `scheduled ${custom ? "custom comments" : "default no-comments"} retains the exact previous context`,
    { timeout: 20000 },
    async (t) => {
      const s = transport();
      const options = {
        githubClient: s.client,
        configure(config) {
          config.reconciliation = { lookbackMs: 86400000, overlapMs: 1000, fullAuditsPerCycle: 2 };
          if (custom) config.repositories[0].families = ["issues", "comments"];
        },
      };
      if (custom)
        options.source = {
          async readPage() {
            return {
              repositoryId: 2,
              visibility: "public",
              isSynthetic: true,
              facts: [],
              expectedCount: 0,
              nextCursor: null,
            };
          },
        };
      const h = await operatorHarness(t, options);
      const result = await h.runtime.runOnce();
      assert.equal(result.state, "published");
      const sources = [{ repositoryId: 2, generation: "1" }];
      const expected = reconciliationContextDigest({
        key: hash(["bounded-scan/v1", h.config, "synthetic", "reconcile"]),
        contextHash: hash([0, null, sources]),
      });
      assert.ok(result.progress.every((item) => parseReconciliationRunId(item.runId)?.contextDigest === expected));
      assert.equal(commentLists(s.calls).length, 0);
    },
  );
