import assert from "node:assert/strict";
import { GithubReadClient } from "../dist/index.js";

export const repository = {
  id: 2,
  installationId: 1,
  slug: "synthetic-owner/repository",
  families: ["issue_field_history"],
};
export const issue = { id: "I_SYNTHETIC_FIELD_ISSUE", url: "https://github.com/" + repository.slug + "/issues/1" };
export const nativeActor = { __typename: "User", id: "U_SYNTHETIC_EDITOR", databaseId: 7, login: "synthetic-editor" };
export const nativeEvent = (id = "E_SYNTHETIC_FIELD_1", overrides = {}) => ({
  __typename: "IssueFieldChangedEvent",
  id,
  createdAt: "2026-10-01T00:00:00Z",
  fieldId: "IF_SYNTHETIC_PUBLIC",
  actor: structuredClone(nativeActor),
  previousValue: "SYNTHETIC_BEFORE_VALUE",
  newValue: "SYNTHETIC_AFTER_VALUE",
  previousOptions: null,
  newOptions: null,
  ...overrides,
});

class ScopedMemoryCheckpoints {
  values = new Map();
  repositoryValues = new Map();
  writes = [];
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
  forRepository(id) {
    assert.equal(id, repository.id);
    if (!this.repositoryValues.has(id)) this.repositoryValues.set(id, new Map());
    const values = this.repositoryValues.get(id);
    return {
      repositoryId: id,
      load: async (key) => structuredClone(values.get(key)),
      save: async (key, value) => {
        values.set(key, structuredClone(value));
        this.writes.push(structuredClone(value));
      },
      assertActive: async () => {},
      retire: async () => {
        throw Error("Memory fixtures do not certify filesystem retirement");
      },
    };
  }
}

/** Real production client and pagination, with a synthetic HTTP transport and private memory checkpoint seam. */
export function issueFieldFixture(events = [nativeEvent()]) {
  const state = {
    fields: new Map([["IF_SYNTHETIC_PUBLIC", { id: "IF_SYNTHETIC_PUBLIC", dataType: "TEXT", visibility: "ALL" }]]),
    events: new Map(events.map((event) => [event.id, structuredClone(event)])),
    timelineIds: events.map((event) => event.id),
    issue: structuredClone(issue),
    inventory: [
      { node_id: issue.id, number: 1, html_url: issue.url },
      {
        node_id: "PR_SYNTHETIC_IGNORED",
        number: 2,
        html_url: "https://github.com/" + repository.slug + "/pull/2",
        pull_request: {},
      },
    ],
    privateRepository: false,
    pageSize: 100,
    failCursor: undefined,
    inventoryPageSize: 100,
    inventoryFailCursor: undefined,
    unavailableEvents: new Set(),
    mutate: undefined,
  };
  const calls = [];
  const checkpoints = new ScopedMemoryCheckpoints();
  const metadata = (event) =>
    event && {
      __typename: event.__typename,
      id: event.id,
      createdAt: event.createdAt,
      issueField: structuredClone(state.fields.get(event.fieldId) ?? null),
    };
  const repo = (number) => ({
    databaseId: repository.id,
    isPrivate: state.privateRepository,
    issue: number === 1 ? structuredClone(state.issue) : null,
  });
  const respond = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = async (url, request) => {
    if (request.method !== "POST") {
      calls.push({ operation: "REST", url });
      const path = new URL(url).pathname;
      if (path === "/repos/" + repository.slug)
        return respond({ id: repository.id, private: state.privateRepository, full_name: repository.slug });
      if (path === "/repos/" + repository.slug + "/issues") return respond(state.inventory);
      return respond({ message: "Synthetic endpoint unavailable" }, 404);
    }
    const { query, variables } = JSON.parse(request.body);
    const operation = query.match(/query\s+([A-Za-z0-9_]+)/)?.[1];
    calls.push({ operation, query, variables: structuredClone(variables) });
    let data;
    if (operation === "IssueFieldInventory") {
      if (state.inventoryFailCursor !== undefined && variables.after === state.inventoryFailCursor)
        return respond({ message: "Synthetic inventory page failure" }, 503);
      const inventory = state.inventory.filter((item) => !item?.pull_request);
      const offset = variables.after === null ? 0 : Number(variables.after);
      const pageSize = Math.min(state.inventoryPageSize, variables.first);
      const items = inventory.slice(offset, offset + pageSize);
      const more = offset + items.length < inventory.length;
      data = {
        repository: {
          databaseId: repository.id,
          isPrivate: state.privateRepository,
          issues: {
            nodes: items.map((item) => ({ id: item.node_id, number: item.number, url: item.html_url })),
            pageInfo: { hasNextPage: more, endCursor: more ? String(offset + items.length) : null },
          },
        },
      };
    } else if (operation === "IssueFieldSubject") {
      data = { repository: repo(variables.number) };
    } else if (operation === "IssueFieldHistory") {
      if (variables.after === state.failCursor) return respond({ message: "Synthetic page failure" }, 503);
      const offset = variables.after === null ? 0 : Number(variables.after);
      const ids = state.timelineIds.slice(offset, offset + state.pageSize);
      const more = offset + ids.length < state.timelineIds.length;
      data = {
        repository: {
          ...repo(variables.number),
          issue:
            state.issue === null
              ? null
              : {
                  ...structuredClone(state.issue),
                  timelineItems: {
                    nodes: ids.map((id) => metadata(state.events.get(id))),
                    pageInfo: { hasNextPage: more, endCursor: more ? String(offset + ids.length) : null },
                  },
                },
        },
      };
    } else if (operation === "IssueFieldScope") {
      data = {
        repository: repo(variables.number),
        field: structuredClone(state.fields.get(variables.fieldId) ?? null),
        event: state.unavailableEvents.has(variables.eventId)
          ? null
          : (metadata(state.events.get(variables.eventId)) ?? null),
      };
    } else if (operation === "IssueFieldDetail") {
      const event = state.events.get(variables.id);
      data = {
        node:
          !event || state.unavailableEvents.has(variables.id)
            ? null
            : {
                ...metadata(event),
                actor: structuredClone(event.actor),
                previousValue: event.previousValue,
                newValue: event.newValue,
                previousOptions: structuredClone(event.previousOptions),
                newOptions: structuredClone(event.newOptions),
              },
      };
    } else {
      throw Error("Unexpected synthetic GraphQL operation: " + operation);
    }
    if (state.mutate) data = state.mutate({ operation, variables, data }) ?? data;
    return respond({ data });
  };
  const makeClient = () =>
    new GithubReadClient({
      apiOrigin: "https://api.synthetic.invalid",
      token: async () => "synthetic-native-field-token",
      checkpoints,
      fetch,
      maxRetries: 0,
    });
  const client = makeClient();
  const options = {
    client,
    source: "installation:synthetic",
    repository,
    number: 1,
    subjectId: issue.id,
    scanId: "synthetic-field-history",
  };
  return { state, calls, checkpoints, client, makeClient, options };
}
