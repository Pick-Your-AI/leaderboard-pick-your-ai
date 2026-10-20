import assert from "node:assert/strict";
import { syntheticRepositoryClient } from "../../packages/github/test/synthetic-client.mjs";

export const curationActor = {
  __typename: "User",
  id: "U_SYNTHETIC_EDITOR",
  databaseId: 202,
  login: "synthetic-editor",
};
export const curationProjectId = "PVT_SYNTHETIC_CURATION";
export const curationTime = "2026-10-01T12:00:00.000Z";

export function curationEvent(id, patch = {}) {
  return {
    id,
    __typename: "AddedToProjectV2Event",
    createdAt: curationTime,
    wasAutomated: false,
    actor: structuredClone(curationActor),
    project: { id: curationProjectId, public: true },
    ...patch,
  };
}

/** Synthetic transport only. The reader, source adapter and normalizer used by
 * callers are real; no installed grant, native capture or complete history is claimed.
 */
export function projectCurationFixture({ slug = "synthetic-org/synthetic-repo", createdAt = curationTime } = {}) {
  const repository = {
    id: 2,
    installationId: 1,
    slug,
    families: ["project_curation_history"],
    allowedProjectIds: [curationProjectId],
  };
  const subjects = [
    { node_id: "I_SYNTHETIC_CURATION", number: 1, html_url: "https://github.com/" + slug + "/issues/1" },
    {
      node_id: "PR_SYNTHETIC_CURATION",
      number: 2,
      html_url: "https://github.com/" + slug + "/pull/2",
      pull_request: { url: "https://api.github.com/repos/" + slug + "/pulls/2" },
    },
  ];
  const state = {
    repositoryPublic: true,
    repositoryId: 2,
    projectPublic: true,
    hiddenSubject: false,
    changedSubject: false,
    subjects,
    events: new Map([
      [1, [curationEvent("PVE_SYNTHETIC_ISSUE_ADD", { createdAt })]],
      [2, [curationEvent("PVE_SYNTHETIC_PR_REMOVE", { createdAt, __typename: "RemovedFromProjectV2Event" })]],
    ]),
    reads: [],
    afterScan: null,
    afterProject: null,
  };
  function data(number, query, nodes = state.events.get(number) ?? []) {
    const subject = state.subjects.find((value) => value.number === number);
    return {
      repository: {
        databaseId: state.repositoryId,
        isPrivate: !state.repositoryPublic,
        [query.includes("pullRequest(number:") ? "pullRequest" : "issue"]:
          !subject || state.hiddenSubject
            ? null
            : {
                id: state.changedSubject ? "I_SYNTHETIC_OTHER" : subject.node_id,
                url: subject.html_url,
                timelineItems: {
                  nodes: structuredClone(nodes),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
      },
    };
  }
  function inventory(query) {
    const field = query.includes("pullRequests(") ? "pullRequests" : "issues";
    return {
      repository: {
        databaseId: state.repositoryId,
        isPrivate: !state.repositoryPublic,
        [field]: {
          nodes: state.subjects
            .filter((subject) => (subject.pull_request !== undefined) === (field === "pullRequests"))
            .map((subject) => ({ id: subject.node_id, number: subject.number, url: subject.html_url })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }
  const client = syntheticRepositoryClient(repository.id, {
    async rest(source, path, authorize) {
      authorize?.();
      state.reads.push({ kind: "rest", path });
      assert.equal(path, "/repos/" + slug);
      return { id: state.repositoryId, full_name: slug, private: !state.repositoryPublic };
    },
    async scanRest(options) {
      options.assertAuthorized?.();
      state.reads.push({ kind: "inventory", key: options.key, url: options.url, refresh: options.refresh });
      assert.match(options.url, /\/issues\?/);
      assert.equal(options.refresh, true);
      return options.select(structuredClone(state.subjects));
    },
    async scanGraphql(options) {
      options.assertAuthorized?.();
      if (options.query.includes("ProjectCurationInventory")) {
        state.reads.push({ kind: "inventory", key: options.key, query: options.query, refresh: options.refresh });
        assert.equal(options.refresh, true);
        return options.select(inventory(options.query)).nodes;
      }
      state.reads.push({ kind: "timeline", key: options.key, query: options.query, refresh: options.refresh });
      assert.match(options.query, /ADDED_TO_PROJECT_V2_EVENT,REMOVED_FROM_PROJECT_V2_EVENT/);
      assert.equal(options.refresh, true);
      const selected = options.select(data(options.variables.number, options.query)).nodes;
      await state.afterScan?.();
      options.assertAuthorized?.();
      return selected;
    },
    async graphql(source, query, variables, authorize) {
      authorize?.();
      state.reads.push({ kind: variables.id ? "project" : "subject", query, variables: structuredClone(variables) });
      let result;
      if (variables.id) {
        result = { node: { id: variables.id, public: state.projectPublic } };
        await state.afterProject?.();
      } else if (query.includes("ProjectCurationRepository")) {
        result = {
          repository: {
            databaseId: state.repositoryId,
            nameWithOwner: slug,
            isPrivate: !state.repositoryPublic,
          },
        };
      } else result = data(variables.number, query);
      authorize?.();
      return result;
    },
  });
  return { repository, state, client, data, inventory };
}

export function curationReaderOptions(fixture, number = 1) {
  const subject = fixture.state.subjects.find((value) => value.number === number);
  return {
    client: fixture.client,
    source: "installation:synthetic-curation",
    repository: fixture.repository,
    number,
    subjectType: subject.pull_request ? "pull_request" : "issue",
    subjectId: subject.node_id,
    scanId: "synthetic-curation-audit",
  };
}
