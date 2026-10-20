import assert from "node:assert/strict";
import test from "node:test";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { harness, components, ago, clock } from "./harness.mjs";
import {
  issueFieldFixture,
  nativeEvent,
  nativeActor,
  repository,
  issue,
} from "../../../packages/github/test/issue-field-fixture.mjs";

const classification = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-native-publication-review",
  githubDatabaseId: nativeActor.databaseId,
  githubNodeId: nativeActor.id,
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-native-publication-evidence"],
  reviewerActorId: "202",
  reviewedAt: "2026-01-01T00:00:00Z",
};
const metric = "issue_field_updates";

for (const ordinaryIssue of [false, true])
  test(`native service-account publication preserves protected identity; ordinary issue=${ordinaryIssue}`, async (t) => {
    const createdAt = ago(1);
    const field = issueFieldFixture([nativeEvent(undefined, { createdAt })]);
    const nativeSource = createGithubCollectionSource({
      client: field.client,
      sourceId: field.options.source,
      repositories: [repository],
      isSynthetic: true,
    });
    const ordinaryFact = {
      subjectId: issue.id,
      sourceRevision: createdAt,
      sourceUrl: issue.url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "open",
    };
    const h = await harness(t, {
      githubClient: field.client,
      sourceId: field.options.source,
      configure(config) {
        config.repositories[0].slug = repository.slug;
        config.repositories[0].families = ordinaryIssue ? ["issues", "issue_field_history"] : ["issue_field_history"];
        const policy = {
          ...config.policies[0].policy,
          metricId: metric,
          unit: components.metrics.getMetricDefinition(metric).definition.unit,
          roles: ["triager"],
          sources: ["github_graphql"],
        };
        config.policies = [
          { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-native-policy" },
        ];
      },
      probeRepository: async () => {
        const current = await field.client.rest(field.options.source, "/repos/" + repository.slug);
        return {
          repositoryId: current.id,
          installationId: repository.installationId,
          visibility: current.private ? "private" : "public",
          checkedAt: clock(),
        };
      },
      source: {
        async readPage(request) {
          if (request.family === "issue_field_history") return nativeSource.readPage(request);
          assert.equal(request.family, "issues");
          assert.equal(ordinaryIssue, true);
          return {
            repositoryId: repository.id,
            visibility: "public",
            isSynthetic: true,
            facts: [structuredClone(ordinaryFact)],
            expectedCount: 1,
            nextCursor: null,
          };
        },
      },
      fieldChangeNormalizationVersion: components.github.fieldChangeNormalizationVersion,
      normalizerFactory: (options) =>
        components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [repository.id],
          isSynthetic: true,
          reviewedServiceAccounts: [classification],
          authorizedClassifierIds: [classification.reviewerActorId],
          // The existing protected enrichment route supplies the ordinary
          // observation; the native transition still uses actual GraphQL reads.
          enrich: async (input) => {
            assert.equal(input.family, "issues");
            return {
              repository: { ...repository, visibility: "public" },
              proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
              family: "issue",
              observedAt: input.observedAt,
              payload: {
                id: 1,
                node_id: issue.id,
                html_url: issue.url,
                created_at: createdAt,
                updated_at: createdAt,
                state: "open",
                user: {
                  id: nativeActor.databaseId,
                  node_id: nativeActor.id,
                  type: "User",
                  login: nativeActor.login,
                },
              },
            };
          },
        }),
    });
    assert.equal((await h.runtime.runOnce()).state, "published");
    const normalizations = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(normalizations.length, ordinaryIssue ? 2 : 1);
    for (const { document } of normalizations) {
      assert.equal(document.actors.length, 1);
      assert.equal(document.actors[0].kind, "service_account");
      assert.equal(document.actors[0].executionMode, "unknown");
      assert.deepEqual(document.actors[0].serviceAccountClassification, classification);
    }
    assert.ok(field.calls.some((call) => call.operation === "IssueFieldDetail"));
    for (const filter of ["all", "user", "automation"]) {
      const response = await h.runtime.app.inject(`/api/v1/exports?metric=${metric}&actors=${filter}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        response.json().rows.map((row) => [row.actorId, row.actorKind, row.executionMode]),
        filter === "user" ? [] : [[String(nativeActor.databaseId), "service_account", "unknown"]],
      );
      assert.doesNotMatch(response.body, /serviceAccountClassification|reviewerActorId|synthetic-native-publication/);
    }
  });
