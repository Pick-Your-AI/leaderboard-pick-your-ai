import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubReadClient,
  readTypedIssueHistory,
  typedHistoryRevision,
  createGithubEvidenceNormalizer,
} from "../dist/index.js";
import { syntheticCheckpointStore } from "./synthetic-client.mjs";

const repository = { id: 2, slug: "synthetic-owner/repository", allowedProjectIds: ["PVT_allowed"] };
const subject = { id: "I_synthetic", url: `https://github.com/${repository.slug}/issues/1` };
const actor = { id: "U_synthetic", __typename: "User", databaseId: 3, login: "synthetic-editor" };
const classification = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-typed-history-review",
  githubDatabaseId: actor.databaseId,
  githubNodeId: actor.id,
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-typed-history-evidence"],
  reviewerActorId: "202",
  reviewedAt: "2026-10-01T00:00:00Z",
};

async function fixture(family) {
  const calls = [];
  const event = {
    id: "E_synthetic_typed",
    actor,
    createdAt: "2026-10-01T00:00:00Z",
    ...(family === "relationships"
      ? {
          __typename: "ParentIssueAddedEvent",
          parent: {
            id: "I_parent",
            url: `https://github.com/${repository.slug}/issues/2`,
            repository: { databaseId: repository.id, isPrivate: false },
          },
        }
      : {
          __typename: "ProjectV2ItemStatusChangedEvent",
          wasAutomated: false,
          project: { id: "PVT_allowed", public: true },
        }),
  };
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-typed-history-token",
    checkpoints: syntheticCheckpointStore(),
    fetch: async (_url, request) => {
      const { query, variables } = JSON.parse(request.body);
      calls.push(query);
      let data;
      if (query.includes("timelineItems"))
        data = {
          repository: {
            databaseId: repository.id,
            isPrivate: false,
            issue: {
              ...subject,
              timelineItems: { nodes: [event], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        };
      else if (query.includes("... on ProjectV2 {")) {
        assert.equal(variables.id, "PVT_allowed");
        data = { node: { id: "PVT_allowed", public: true } };
      } else {
        assert.ok(query.includes("... on ProjectV2ItemStatusChangedEvent {"));
        assert.equal(variables.id, event.id);
        data = { node: { ...event, previousStatus: "Todo", status: "Done" } };
      }
      return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    },
  });
  const [record] = await readTypedIssueHistory({
    client: client.forRepository(repository.id),
    source: "synthetic",
    repository,
    number: 1,
    subjectId: subject.id,
    family,
    scanId: "synthetic-typed-history",
  });
  const input = {
    repository,
    family,
    factKey: "synthetic-typed-history",
    observedAt: "2026-10-02T00:00:00Z",
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: record.event.id,
      historySubjectId: subject.id,
      sourceRevision: typedHistoryRevision(record),
      sourceUrl: subject.url,
      evidence: "observed_transition",
      actorId: String(actor.databaseId),
      occurredAt: event.createdAt,
      state: "present",
    },
  };
  const normalize = (extra = {}) =>
    createGithubEvidenceNormalizer({
      client,
      source: "synthetic",
      allowedRepositoryIds: [repository.id],
      isSynthetic: true,
      ...extra,
    })(input);
  return { calls, normalize };
}

for (const family of ["relationships", "project_history"]) {
  test(`${family} preserves protected service-account identity through typed hydration`, async () => {
    const { calls, normalize } = await fixture(family);
    const original = await normalize();
    assert.equal(original.actors[0].kind, "user");
    const output = await normalize({ reviewedServiceAccounts: [classification], authorizedClassifierIds: ["202"] });
    assert.equal(output.actors[0].kind, "service_account");
    assert.equal(output.actors[0].executionMode, "unknown");
    assert.deepEqual(output.actors[0].serviceAccountClassification, classification);
    const { actors: originalActors, ...originalFacts } = original;
    const { actors: classifiedActors, ...classifiedFacts } = output;
    assert.deepEqual(classifiedFacts, originalFacts);
    assert.deepEqual(classifiedActors, [
      { ...originalActors[0], kind: "service_account", serviceAccountClassification: classification },
    ]);
    assert.ok(calls.some((query) => query.includes("timelineItems")));
  });

  test(`${family} rejects an unauthorized protected classifier instead of silently using User`, async () => {
    const { normalize } = await fixture(family);
    await assert.rejects(
      normalize({ reviewedServiceAccounts: [classification], authorizedClassifierIds: [] }),
      /service-account classification/i,
    );
  });
}
