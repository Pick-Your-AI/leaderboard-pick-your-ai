import assert from "node:assert/strict";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { ago, clock, components, harness } from "./harness.mjs";

export const discussionBoardUrl = "/api/v1/boards?metric=discussion_answers";
const slug = "synthetic-org/synthetic-repo";
const actor = (id) => ({ id: `U_SYNTHETIC_${id}`, databaseId: id, login: `synthetic-${id}`, __typename: "User" });

/** Synthetic HTTP only: the actual client, collector, normalizer, SQL publication,
 * SQLite controls and public service remain in the path. The memory checkpoint
 * and in-memory PGlite do not assert durable reopen or real source approval.
 * This policy is explicitly approved by the test host, not the public registry. */
export async function discussionCapabilityHarness(t, { enabled = true, empty = false } = {}) {
  const state = {
    enabled,
    privateRepository: false,
    rows: empty
      ? []
      : [
          {
            id: "D_SYNTHETIC_CAPABILITY",
            url: `https://github.com/${slug}/discussions/4`,
            createdAt: ago(3),
            updatedAt: ago(1),
            author: actor(101),
            answerChosenAt: ago(1),
            answerChosenBy: actor(202),
            answer: { id: "DC_SYNTHETIC_CAPABILITY", createdAt: ago(2), isAnswer: true, author: actor(303) },
          },
        ],
    collections: 0,
    hydrations: 0,
  };
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-discussion-capability-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value, options) => {
      const url = new URL(value);
      assert.equal(url.origin, "https://api.synthetic.invalid");
      let body;
      if (url.pathname === `/repos/${slug}`) {
        body = { id: 2, private: state.privateRepository, full_name: slug, default_branch: "main" };
      } else {
        assert.equal(url.pathname, "/graphql");
        const { query, variables } = JSON.parse(options.body);
        assert.equal(variables.owner, "synthetic-org");
        assert.equal(variables.name, "synthetic-repo");
        const repository = {
          databaseId: 2,
          isPrivate: state.privateRepository,
          hasDiscussionsEnabled: state.enabled,
        };
        if (/\bdiscussions\(/.test(query)) {
          state.collections++;
          assert.equal(variables.after, null);
          repository.discussions = {
            nodes: structuredClone(state.rows),
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        } else {
          state.hydrations++;
          assert.match(query, /\bdiscussion\(/);
          assert.match(query, /answer\s*\{[^}]*\bcreatedAt\b/);
          repository.discussion = structuredClone(state.rows[0] ?? null);
        }
        body = { data: { repository } };
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const source = createGithubCollectionSource({
    client: githubClient,
    sourceId: "installation:1",
    repositories: [{ id: 2, installationId: 1, slug, families: ["discussions"] }],
    isSynthetic: true,
  });
  const h = await harness(t, {
    memoryDatabase: true,
    githubClient,
    source,
    probeRepository: source.probeRepository,
    configure(config) {
      config.repositories[0].families = ["discussions"];
      const policy = {
        ...config.policies[0].policy,
        metricId: "discussion_answers",
        unit: components.metrics.getMetricDefinition("discussion_answers").definition.unit,
        roles: ["author"],
        sources: ["github_graphql"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" },
      ];
    },
  });
  return {
    ...h,
    state,
    collect: () => h.runtime.runOnce({ cutoff: clock() }),
  };
}
