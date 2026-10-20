import assert from "node:assert/strict";
import { GithubReadClient } from "../dist/index.js";
import { syntheticCheckpointStore } from "./synthetic-client.mjs";

export const slug = "synthetic-owner/repository";
export const mergedAt = "2026-10-07T10:00:00.000Z";
export const observedAt = "2026-10-10T10:00:00.000Z";
export const mergeOid = "b".repeat(40);

/** Actual read-client and normalizer exports, entirely synthetic in-memory HTTP. */
export function mergeTargetFixture() {
  const api = "https://api.synthetic.invalid";
  const repository = {
    id: 2,
    node_id: "R_fixture",
    full_name: slug,
    private: false,
    visibility: "public",
    default_branch: "main",
  };
  const payload = {
    id: 10,
    node_id: "PR_fixture_10",
    number: 10,
    html_url: `https://github.com/${slug}/pull/10`,
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: observedAt,
    state: "closed",
    merged: true,
    merged_at: mergedAt,
    merge_commit_sha: mergeOid,
    base: { ref: "main", repo: repository },
    user: { id: 101, node_id: "U_fixture_author", type: "User", login: "fixture-author" },
    merged_by: { id: 102, node_id: "U_fixture_merger", type: "User", login: "fixture-merger" },
  };
  const graphqlRepository = { databaseId: 2, isPrivate: false, nameWithOwner: slug };
  const event = {
    __typename: "MergedEvent",
    id: "ME_fixture_10",
    createdAt: "2026-10-07T10:00:00Z",
    mergeRefName: "stack/topic",
    commit: { oid: mergeOid },
    pullRequest: {
      id: payload.node_id,
      number: 10,
      url: payload.html_url,
      repository: graphqlRepository,
    },
  };
  const graphqlPullRequest = {
    id: payload.node_id,
    number: 10,
    url: payload.html_url,
    merged: true,
    mergedAt: "2026-10-07T10:00:00Z",
    mergeCommit: { oid: mergeOid },
  };
  const state = {
    calls: [],
    requests: [],
    authorized: true,
    status: 200,
    onRead: async () => {},
    onLoad: (value) => value,
    pages: new Map([[null, { nodes: [event], pageInfo: { hasNextPage: false, endCursor: null } }]]),
  };
  const store = syntheticCheckpointStore();
  const client = new GithubReadClient({
    apiOrigin: api,
    token: async () => "synthetic-token",
    checkpoints: {
      ...store,
      forRepository(repositoryId) {
        const scoped = store.forRepository(repositoryId);
        return { ...scoped, load: async (key) => state.onLoad(await scoped.load(key), key) };
      },
    },
    maxRetries: 0,
    fetch: async (value, init) => {
      const path = new URL(value).pathname;
      const request = init?.body ? JSON.parse(init.body) : null;
      state.calls.push(path);
      if (request) state.requests.push(request);
      await state.onRead(path, request);
      let body;
      if (path === "/graphql") {
        assert.ok(state.pages.has(request.variables.after), "fixture must cover the actual requested cursor");
        body = {
          data: {
            repository: {
              ...graphqlRepository,
              pullRequest: { ...graphqlPullRequest, timelineItems: state.pages.get(request.variables.after) },
            },
          },
        };
      } else if (path === `/repos/${slug}`) body = repository;
      else if (path === `/repos/${slug}/pulls/10`) body = payload;
      else assert.fail(`Unexpected synthetic request: ${path}`);
      return new Response(JSON.stringify(body), {
        status: state.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const assertAuthorized = () => {
    if (!state.authorized) throw new Error("synthetic-authorization-revoked");
  };
  const reader = {
    client,
    source: "synthetic-installation",
    repository: { id: 2, slug },
    pullRequest: { id: payload.node_id, number: 10, url: payload.html_url },
    sourceRevision: observedAt,
    mergedAt,
    observedAt,
    expectedCommitOid: mergeOid,
    scanId: "synthetic-run-1",
    assertAuthorized,
  };
  const options = {
    client,
    source: reader.source,
    now: () => observedAt,
    allowedRepositoryIds: [2],
    pullRequestMergeTargetRepositoryIds: [2],
    assertAuthorized,
    isSynthetic: true,
  };
  const input = {
    repository: { id: 2, slug },
    family: "pull_requests",
    observedAt,
    policyVersion: "synthetic-policy-v1",
    factKey: "synthetic-fact-key",
    fact: {
      subjectId: payload.node_id,
      sourceUrl: payload.html_url,
      sourceRevision: observedAt,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "closed",
    },
  };
  return { state, repository, payload, graphqlRepository, graphqlPullRequest, event, reader, options, input };
}
