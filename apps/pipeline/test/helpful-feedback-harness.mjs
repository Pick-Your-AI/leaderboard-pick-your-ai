import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harness, components, clock } from "./harness.mjs";
import { migrateDiscussionFeedback } from "../src/index.mjs";
import {
  feedbackNode,
  feedbackEnrollment,
  feedbackPolicy,
  feedbackBinding,
  feedbackRequest,
  feedbackRepository,
} from "../../../tests/fixtures/helpful-feedback.mjs";

/** Real file checkpoints, collection SQL, normalizer, metric engine, private
 * controls and publication with explicitly synthetic field-scope authority. */
export async function helpfulFeedbackHarness(
  t,
  { enrolled = true, migrateFeedback = true, memoryDatabase = false, sameAuthor = true, runtimeOptions = {} } = {},
) {
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "leaderboard-feedback-checkpoints-"));
  t.after(() => rm(checkpointDirectory, { recursive: true, force: true }));
  const state = {
    rows: [feedbackNode({ sameAuthor })],
    privateRepository: false,
    enabled: true,
    epoch: "synthetic-feedback-authority-1",
    queries: [],
    reads: 0,
    onRead: null,
    failPage: false,
  };
  const checkpoints = new components.github.FileCheckpointStore(checkpointDirectory);
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-feedback-token",
    checkpoints,
    maxRetries: 0,
    fetch: async (value, options) => {
      const url = new URL(value);
      assert.equal(url.origin, "https://api.synthetic.invalid");
      let body;
      if (url.pathname === `/repos/${feedbackRepository.slug}`)
        body = { id: 2, private: state.privateRepository, full_name: feedbackRepository.slug, default_branch: "main" };
      else {
        assert.equal(url.pathname, "/graphql");
        const { query, variables } = JSON.parse(options.body);
        state.queries.push(query);
        state.reads++;
        assert.equal(variables.owner, "synthetic-org");
        assert.equal(variables.name, "synthetic-repo");
        const repository = { databaseId: 2, isPrivate: state.privateRepository, hasDiscussionsEnabled: state.enabled };
        if (/\bdiscussions\(/.test(query)) {
          if (enrolled) assert.equal(variables.first, 10);
          const offset = variables.after === null ? 0 : Number(variables.after);
          if (state.failPage === true || (typeof state.failPage === "number" && offset >= state.failPage))
            throw new Error("synthetic-feedback-page-failure");
          const nodes = structuredClone(state.rows.slice(offset, offset + variables.first));
          if (!/\bbody\b/.test(query))
            for (const node of nodes) {
              delete node.title;
              delete node.body;
              delete node.lastEditedAt;
              if (node.answer)
                for (const field of ["body", "updatedAt", "lastEditedAt", "deletedAt", "isMinimized"])
                  delete node.answer[field];
            }
          repository.discussions = {
            nodes,
            pageInfo: {
              hasNextPage: offset + nodes.length < state.rows.length,
              endCursor: offset + nodes.length < state.rows.length ? String(offset + nodes.length) : null,
            },
          };
        } else {
          assert.match(query, /\bdiscussion\(/);
          repository.discussion = structuredClone(
            state.rows.find((row) => row.url.endsWith(`/${variables.number}`)) ?? null,
          );
        }
        body = { data: { repository } };
        if (state.onRead) await state.onRead({ query, variables });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const h = await harness(t, {
    memoryDatabase,
    githubClient,
    source: undefined,
    probeRepository: undefined,
    authorizePolicyPreview: async () => true,
    discussionFeedbackAuthorityEpoch(binding) {
      assert.equal(binding.repositoryId, 2);
      assert.equal(binding.installationId, 1);
      assert.equal(binding.dataMode, "synthetic");
      assert.deepEqual(binding.fieldScope, feedbackEnrollment().enrollments[0].fieldScope);
      return state.epoch;
    },
    ...runtimeOptions,
    configure(config) {
      config.repositories[0].families = ["discussions"];
      const policy = enrolled
        ? feedbackPolicy()
        : {
            ...config.policies[0].policy,
            metricId: "discussions_started",
            unit: components.metrics.getMetricDefinition("discussions_started").definition.unit,
            roles: ["author"],
            sources: ["github_graphql"],
          };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-feedback-policy" },
      ];
      if (enrolled) {
        config.discussionFeedback = feedbackEnrollment();
        config.recognitionBindings = [feedbackBinding(), feedbackBinding("discussion_answers")];
      }
      runtimeOptions.configure?.(config);
    },
  });
  if (enrolled && migrateFeedback) await migrateDiscussionFeedback(h.db);
  const collect = (options = {}) => h.runtime.runOnce({ cutoff: clock(), mode: "audit", ...options });
  const accept = async ({
    sourceMetricId = "discussions_started",
    id = "synthetic-feedback-accepted",
    acceptedAt = clock(),
    sourceRevision,
  } = {}) => {
    const rows = (
      await h.db.query(
        `SELECT f.*, n.document AS normalized FROM leaderboard_ingestion.source_facts f
      JOIN leaderboard_pipeline.normalizations n USING(fact_key) WHERE f.family='discussions'
      AND ($1::text IS NULL OR f.source_revision=$1) ORDER BY f.observed_at DESC`,
        [sourceRevision ?? null],
      )
    ).rows;
    const row = rows[0];
    assert.ok(row);
    const target = row.normalized.facts.find((fact) => fact.metricId === sourceMetricId);
    assert.ok(target);
    const source = {
      metadata: row.document.discussionFeedback,
      sourceRevision: row.source_revision,
      observedAt: new Date(row.observed_at).toISOString(),
      selectedCurrentState: false,
    };
    const receipt = feedbackRequest(source, target, { id, acceptedAt });
    h.controlsStore.transaction((controls) => {
      controls.requests[receipt.request.id] = receipt.request;
      controls.audit.push(receipt.decision);
    });
    return { ...receipt, source, target };
  };
  return { ...h, state, checkpoints, checkpointDirectory, collect, accept };
}
