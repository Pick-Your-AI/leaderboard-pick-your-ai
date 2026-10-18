import assert from "node:assert/strict";
import test from "node:test";
import { readTypedIssueHistory, typedHistoryRevision, createGithubEvidenceNormalizer } from "../dist/index.js";
const repository = { id: 2, slug: "synthetic-owner/repository", allowedProjectIds: ["PVT_allowed"] };
const subject = { id: "I_synthetic", url: `https://github.com/${repository.slug}/issues/1` };
const actor = { id: "U_synthetic", __typename: "User", databaseId: 3, login: "synthetic" };
const target = {
  id: "I_parent",
  url: `https://github.com/${repository.slug}/issues/2`,
  repository: { databaseId: 2, isPrivate: false },
};
const baseEvent = {
  id: "E_synthetic",
  __typename: "ParentIssueAddedEvent",
  actor,
  createdAt: "2026-10-01T00:00:00Z",
  parent: target,
};
const options = (client, family = "relationships") => ({
  client,
  source: "synthetic",
  repository,
  number: 1,
  family,
  scanId: "synthetic",
});
const clientFor = (event) => ({
  scanGraphql: async (scan) =>
    scan.select({
      repository: {
        databaseId: 2,
        isPrivate: false,
        issue: { ...subject, timelineItems: { nodes: [event], pageInfo: { hasNextPage: false, endCursor: null } } },
      },
    }).nodes,
});

test("native parent history normalizes explicit actors and preserves individual event identity", async () => {
  const client = clientFor(baseEvent);
  const [record] = await readTypedIssueHistory(options(client));
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const input = {
    repository,
    family: "relationships",
    factKey: "synthetic",
    observedAt: "2026-10-02T00:00:00Z",
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: record.event.id,
      sourceRevision: typedHistoryRevision(record),
      sourceUrl: subject.url,
      evidence: "observed_transition",
      actorId: "3",
      occurredAt: baseEvent.createdAt,
      state: "present",
    },
  };
  const out = await normalize(input);
  assert.equal(out.facts[0].metricId, "parent_child_links");
  assert.equal(out.facts[0].actorId, "3");
  assert.equal(out.observations[0].source, "github_graphql");
  assert.equal(out.facts[0].state, "observed");
});

test("foreign/private relationship endpoints remain unavailable", async () => {
  for (const repo of [
    { databaseId: 3, isPrivate: false },
    { databaseId: 2, isPrivate: true },
  ]) {
    await assert.rejects(
      readTypedIssueHistory(options(clientFor({ ...baseEvent, parent: { ...target, repository: repo } }))),
      /endpoint_not_authorized/,
    );
  }
});

test("Project status values are hydrated only after explicit public Project approval", async () => {
  let reads = 0;
  const event = {
    id: "E_project",
    __typename: "ProjectV2ItemStatusChangedEvent",
    actor,
    createdAt: baseEvent.createdAt,
    project: { id: "PVT_other", public: true },
  };
  const client = {
    ...clientFor(event),
    graphql: async () => {
      reads++;
      return { node: { ...event, previousStatus: "Todo", status: "Done" } };
    },
  };
  assert.deepEqual(await readTypedIssueHistory(options(client, "project_history")), []);
  assert.equal(reads, 0);
  event.project.id = "PVT_allowed";
  const [record] = await readTypedIssueHistory(options(client, "project_history"));
  assert.equal(reads, 1);
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const out = await normalize({
    repository,
    family: "project_history",
    factKey: "synthetic",
    observedAt: "2026-10-02T00:00:00Z",
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: record.event.id,
      sourceRevision: typedHistoryRevision(record),
      sourceUrl: subject.url,
      evidence: "observed_transition",
      actorId: "3",
      occurredAt: event.createdAt,
      state: "present",
    },
  });
  assert.equal(out.facts[0].metricId, "project_status_updates");
  assert.equal(out.facts[0].actorId, "3");
  assert.deepEqual(out.facts[0].eventContext.projects, ["PVT_allowed"]);
});
