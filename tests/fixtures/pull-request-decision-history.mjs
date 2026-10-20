import assert from "node:assert/strict";
import { GithubReadClient } from "../../packages/github/dist/index.js";

export const decisionRepository = { id: 2, slug: "synthetic-owner/repository" };
const author = { id: "U_SYNTHETIC_AUTHOR", databaseId: 101, kind: "User" };
export const decisionSubject = {
  id: "PR_SYNTHETIC_DECISION",
  databaseId: 10,
  url: "https://github.com/synthetic-owner/repository/pull/7",
  createdAt: "2026-01-01T00:00:00Z",
  author,
};
const nativeRepository = () => ({
  databaseId: decisionRepository.id,
  nameWithOwner: decisionRepository.slug,
  isPrivate: false,
});
const parent = () => ({
  __typename: "PullRequest",
  id: decisionSubject.id,
  databaseId: decisionSubject.databaseId,
  number: 7,
  url: decisionSubject.url,
  repository: nativeRepository(),
});
export const decisionEvent = (kind, createdAt, id = "E_SYNTHETIC_" + kind) => ({
  __typename: { closed: "ClosedEvent", reopened: "ReopenedEvent", merged: "MergedEvent" }[kind],
  id,
  createdAt,
  ...(kind === "merged" ? { pullRequest: parent(), commit: { oid: "a".repeat(40) } } : { closable: parent() }),
});
export const closedAnchor = (at) => ({ state: "CLOSED", closedAt: at, mergedAt: null });
export const mergedAnchor = (at) => ({ state: "MERGED", closedAt: at, mergedAt: at });

/** Real repository-scoped production client; only its HTTP and private in-memory stores are synthetic. */
export function decisionFixture(events = [], current = {}) {
  const state = {
    authorized: true,
    calls: [],
    pageSize: 100,
    transform: undefined,
    wire: undefined,
    totalCount: events.length,
    timelineUpdatedAt: "2026-01-07T00:00:00Z",
    events: structuredClone(events),
    native: {
      id: decisionSubject.id,
      databaseId: decisionSubject.databaseId,
      number: 7,
      url: decisionSubject.url,
      createdAt: decisionSubject.createdAt,
      updatedAt: "2026-01-07T00:00:00Z",
      state: "OPEN",
      closedAt: null,
      mergedAt: null,
      author: { __typename: "User", id: author.id, databaseId: author.databaseId },
      ...current,
    },
  };
  const global = new Map();
  const scoped = new Map();
  const writes = [];
  const checkpoints = {
    async load(key) {
      return structuredClone(global.get(key));
    },
    async save(key, value) {
      global.set(key, structuredClone(value));
      writes.push({ key, value });
    },
    forRepository(id) {
      assert.equal(id, 2);
      return {
        repositoryId: id,
        async load(key) {
          return structuredClone(scoped.get(key));
        },
        async save(key, value) {
          scoped.set(key, structuredClone(value));
          writes.push({ key, value });
        },
        async assertActive() {
          if (!state.authorized) throw new Error("Synthetic repository retired");
        },
        async retire() {
          throw new Error("No retirement certification in this memory fixture");
        },
      };
    },
  };
  const fetch = async (_url, request) => {
    assert.equal(request.method, "POST");
    const { query, variables } = JSON.parse(request.body);
    const operation = query.match(/query\s+([A-Za-z0-9_]+)/)?.[1];
    assert.ok(["PullRequestDecisionAnchor", "PullRequestDecisionHistory"].includes(operation));
    const call = { operation, query, variables };
    state.calls.push(call);
    const start = variables.after === null || variables.after === undefined ? 0 : Number(variables.after.slice(2));
    const slice = state.events.slice(start, start + state.pageSize);
    const end = start + slice.length;
    const connection = { totalCount: state.totalCount, updatedAt: state.timelineUpdatedAt };
    if (operation === "PullRequestDecisionHistory")
      Object.assign(connection, {
        filteredCount: state.totalCount - start,
        pageCount: slice.length,
        pageInfo: { hasNextPage: end < state.totalCount, endCursor: slice.length ? "C_" + end : null },
        edges: slice.map((node, index) => ({ cursor: "C_" + (start + index + 1), node: structuredClone(node) })),
      });
    const response = {
      data: {
        repository: {
          ...nativeRepository(),
          pullRequest: { ...structuredClone(state.native), timelineItems: connection },
        },
      },
    };
    state.transform?.(call, response);
    const wire = state.wire?.(call, response) ?? response;
    return new Response(JSON.stringify(wire), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GithubReadClient({
    token: async () => "synthetic-not-a-credential",
    checkpoints,
    fetch,
    maxRetries: 0,
    now: () => Date.parse("2026-01-08T00:00:00Z"),
    sleep: async () => {},
    random: () => 0,
  });
  const options = {
    client,
    source: "synthetic-installation:1",
    repository: structuredClone(decisionRepository),
    pullNumber: 7,
    expectedSubject: {
      ...structuredClone(decisionSubject),
      createdAt: state.native.createdAt,
      author: state.native.author === null ? null : structuredClone(author),
    },
    semanticRevision: "synthetic-rest-revision:1",
    scanId: "synthetic-scan:1",
    asOf: "2026-01-05T00:00:00Z",
    now: () => "2026-01-08T00:00:00Z",
    assertAuthorized() {
      if (!state.authorized) throw new Error("Synthetic authorization revoked");
    },
  };
  return { state, options, writes, checkpoints };
}
