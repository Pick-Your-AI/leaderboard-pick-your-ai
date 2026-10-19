import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { harness, components, ago, clock } from "./harness.mjs";
import {
  issueFieldFixture,
  nativeEvent,
  nativeActor,
  repository as nativeRepository,
  issue as nativeIssue,
} from "../../../packages/github/test/issue-field-fixture.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";

function historyFixture(family, createdAt) {
  if (family === "issue_field_history") {
    const field = issueFieldFixture([nativeEvent(undefined, { createdAt })]);
    return {
      ...field,
      repository: nativeRepository,
      subject: nativeIssue,
      actor: nativeActor,
      sourceId: field.options.source,
    };
  }
  const repository = {
    id: 2,
    installationId: 1,
    slug: "synthetic-owner/repository",
    allowedProjectIds: ["PVT_allowed"],
    families: [family],
  };
  const subject = { id: "I_SYNTHETIC_TYPED", url: `https://github.com/${repository.slug}/issues/1` };
  const actor = { id: "U_SYNTHETIC_TYPED", __typename: "User", databaseId: 7, login: "synthetic-editor" };
  const event = {
    id: "E_SYNTHETIC_TYPED",
    actor,
    createdAt,
    ...(family === "relationships"
      ? {
          __typename: "ParentIssueAddedEvent",
          parent: {
            id: "I_SYNTHETIC_PARENT",
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
  const calls = [];
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-typed-history-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (url, request) => {
      const respond = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (request.method !== "POST") {
        const path = new URL(url).pathname;
        if (path === `/repos/${repository.slug}`)
          return respond({ id: repository.id, private: false, full_name: repository.slug });
        assert.equal(path, `/repos/${repository.slug}/issues`);
        return respond([{ node_id: subject.id, number: 1, html_url: subject.url }]);
      }
      const { query, variables } = JSON.parse(request.body);
      calls.push(query);
      if (query.includes("timelineItems"))
        return respond({
          data: {
            repository: {
              databaseId: repository.id,
              isPrivate: false,
              issue: {
                ...subject,
                timelineItems: { nodes: [event], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        });
      if (query.includes("... on ProjectV2 {")) {
        assert.equal(variables.id, "PVT_allowed");
        return respond({ data: { node: { id: "PVT_allowed", public: true } } });
      }
      assert.ok(query.includes("... on ProjectV2ItemStatusChangedEvent {"));
      assert.equal(variables.id, event.id);
      return respond({ data: { node: { ...event, previousStatus: "Todo", status: "Done" } } });
    },
  });
  return { repository, subject, actor, client, calls, sourceId: "installation:synthetic" };
}

// Literal accepted predecessor namespace, independent of the new family generation.
function predecessorSignature(config) {
  const classification = {
    documentation: config.documentationPolicies ?? [],
    research: config.researchPolicies ?? [],
  };
  const signatures = config.policies.map((entry) => entry.signature);
  const policy = comparisonHash(
    classification.documentation.length || classification.research.length
      ? ["current-state-selection-v2", "synthetic", signatures, classification]
      : ["current-state-selection-v1", "synthetic", signatures],
  );
  const attribution = comparisonHash([normalizationDocumentVersion, policy]);
  const documentation = classification.documentation.length
    ? comparisonHash(["documentation-locales/v2", attribution])
    : attribution;
  const verifiedMerge = comparisonHash(["verified-default-branch-merge-pins/v1", documentation]);
  return comparisonHash(["project-membership-context/v2", verifiedMerge, []]);
}

const metrics = {
  relationships: "parent_child_links",
  project_history: "project_status_updates",
  issue_field_history: "issue_field_updates",
};

for (const family of Object.keys(metrics))
  for (const [droppedFamily, legacyDelivery, completePolicy = false, typedPredecessor = false] of [
    [false, false],
    [true, false],
    [false, true],
    [false, false, true, false],
    [false, true, true, false],
    [false, false, true, true],
    [true, true, true, true],
  ])
    test(`${family} classification preserves frozen predecessor caches across reopen; dropped=${droppedFamily}${legacyDelivery ? "; legacy-delivery" : ""}${completePolicy ? "; complete-policy" : ""}${typedPredecessor ? "; typed-predecessor" : ""}`, async (t) => {
      const fixture = historyFixture(family, ago(1));
      const { repository, subject, actor, client, sourceId } = fixture;
      const source = createGithubCollectionSource({ client, sourceId, repositories: [repository], isSynthetic: true });
      const classification = {
        schemaVersion: "leaderboard-service-account/v1",
        classificationId: "synthetic-typed-cache-review",
        githubDatabaseId: actor.databaseId,
        githubNodeId: actor.id,
        source: "reviewed_configuration",
        evidenceIds: ["synthetic-typed-cache-evidence"],
        reviewerActorId: "202",
        reviewedAt: "2026-01-01T00:00:00Z",
      };
      let ordinaryEnabled = false;
      const ordinaryFact = {
        subjectId: subject.id,
        sourceRevision: ago(1),
        sourceUrl: subject.url,
        evidence: "current_state",
        actorId: null,
        occurredAt: null,
        state: "open",
      };
      const normalizeCalls = [];
      const normalizer = (options, classify) => {
        const actual = components.github.createGithubEvidenceNormalizer({
          client: options.githubClient,
          source: options.sourceId,
          allowedRepositoryIds: [repository.id],
          isSynthetic: true,
          ...(classify
            ? { reviewedServiceAccounts: [classification], authorizedClassifierIds: [classification.reviewerActorId] }
            : {}),
          enrich: async (input) => {
            assert.equal(input.family, "issues");
            return {
              repository: { ...repository, visibility: "public" },
              proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
              family: "issue",
              observedAt: input.observedAt,
              payload: {
                id: 1,
                node_id: subject.id,
                html_url: subject.url,
                created_at: ordinaryFact.sourceRevision,
                updated_at: ordinaryFact.sourceRevision,
                state: "open",
                user: { id: actor.databaseId, node_id: actor.id, type: "User", login: actor.login },
              },
            };
          },
        });
        return async (input) => {
          normalizeCalls.push({ family: input.family, classify });
          return actual(input);
        };
      };
      const h = await harness(t, {
        githubClient: client,
        sourceId,
        authorizePolicyPreview: async () => true,
        policyComparisonAuthorityCurrent: () => true,
        defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
        configure(config) {
          Object.assign(config.repositories[0], repository);
          config.repositories[0].families = droppedFamily ? ["issues"] : ["issues", family];
          // These optional selections were already bound by the older policy,
          // before their release and authored-purpose generation wrappers.
          if (completePolicy) {
            config.documentationPolicies = [
              {
                repositoryId: repository.id,
                version: "synthetic-typed-notes-v1",
                documentationPaths: ["docs/"],
                releaseNotesPaths: ["docs/releases/"],
                researchPaths: [],
                generatedPaths: [],
                importedPaths: [],
              },
            ];
            config.releaseInclusionTargets = [{ repositoryId: repository.id, releaseId: 700, pullRequestNumber: 11 }];
          }
          const metricId = metrics[family];
          const policy = {
            ...config.policies[0].policy,
            metricId,
            unit: components.metrics.getMetricDefinition(metricId).definition.unit,
            roles: ["triager"],
            sources: ["github_graphql"],
          };
          config.policies = [
            { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-typed-policy" },
          ];
        },
        probeRepository: async () => {
          const current = await client.rest(sourceId, `/repos/${repository.slug}`);
          return {
            repositoryId: current.id,
            installationId: repository.installationId,
            visibility: current.private ? "private" : "public",
            checkedAt: clock(),
          };
        },
        source: {
          async readPage(request) {
            if (request.family !== "issues") return source.readPage(request);
            return {
              repositoryId: repository.id,
              visibility: "public",
              isSynthetic: true,
              facts: ordinaryEnabled ? [structuredClone(ordinaryFact)] : [],
              expectedCount: ordinaryEnabled ? 1 : 0,
              nextCursor: null,
            };
          },
        },
        normalizerFactory: (options) => normalizer(options, false),
      });
      if (droppedFamily) {
        assert.equal((await h.runtime.runOnce()).state, "published");
        const collection = new components.ingestion.CollectionStore(h.db);
        const runId = `synthetic-retained-${family}`;
        await collection.start({
          runId,
          repositoryId: repository.id,
          family,
          mode: "reconcile",
          since: null,
          until: clock(),
        });
        assert.equal(await collection.step(runId, source), "complete");
        await h.db.query(
          "INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode) SELECT fact_key,'synthetic' FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1",
          [runId],
        );
      }
      const publication = (await h.runtime.runOnce()).publications[0];
      const sourceRow = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE family=$1", [family]))
        .rows[0];
      assert.ok(sourceRow);
      const produced = (
        await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1", [sourceRow.fact_key])
      ).rows;
      assert.equal(produced.length, 1);
      assert.equal(produced[0].document.actors[0].kind, "user");
      assert.equal(produced[0].document_hash, comparisonHash(produced[0].document));
      const projectSignature = predecessorSignature(h.config);
      const baseSignature = typedPredecessor
        ? comparisonHash(["typed-history-actor-classification/v1", projectSignature])
        : projectSignature;
      const oldSignature = legacyDelivery
        ? comparisonHash([components.github.defaultDeliveryNormalizationVersion, baseSignature])
        : baseSignature;
      const oldDocument = {
        ...produced[0].document,
        ...(legacyDelivery
          ? { defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion }
          : {}),
      };
      const oldHash = comparisonHash(oldDocument);
      // Hydrate real source data, then retain that exact User document under the
      // accepted predecessor namespace. On the old runtime this is already its
      // actual key; newer runtimes reconstruct the same historical cache fixture.
      await h.db.query(
        "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING",
        [sourceRow.fact_key, oldSignature, JSON.stringify(oldDocument), oldHash],
      );
      await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature<>$2", [
        sourceRow.fact_key,
        oldSignature,
      ]);
      if (legacyDelivery) {
        // Model the existing delivery wrapper without inventing a delivery fact.
        // The disposable frozen fixture binds that exact historical document;
        // the transition itself must never rewrite this receipt or its cache.
        const frozen = (
          await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
            publication.snapshotId,
          ])
        ).rows[0].document;
        const binding = frozen.identityAuthorization.identityEvidence;
        binding.normalizationHashes = binding.normalizationHashes.map((hash) =>
          hash === produced[0].document_hash ? oldHash : hash,
        );
        if (binding.normalizationSources !== undefined)
          binding.normalizationSources = binding.normalizationSources.map((entry) =>
            entry.factKey === sourceRow.fact_key ? { ...entry, documentHash: oldHash } : entry,
          );
        await h.db.query(
          "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
          [publication.snapshotId, JSON.stringify(frozen), comparisonHash(frozen)],
        );
      }
      const oldCache = (
        await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1", [sourceRow.fact_key])
      ).rows[0];
      const oldFrozen = (
        await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
          publication.snapshotId,
        ])
      ).rows[0];
      const request = {
        snapshotId: publication.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-typed-cache-preview", rank: false },
        operatorId: "201",
      };
      const oldPreview = await h.runtime.previewPolicy(request);
      assert.ok(oldPreview.comparison.before.rows.some((row) => row.actorId === String(actor.databaseId)));
      assert.ok(normalizeCalls.some((entry) => entry.family === family && !entry.classify));
      await h.runtime.stop();
      await h.reopenDatabase();
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1", [sourceRow.fact_key]))
          .rows,
        [oldCache],
      );
      ordinaryEnabled = true;
      const options = { ...h.options, normalizer: normalizer(h.options, true) };
      const upgraded = await createPipeline(options);
      t.after(() => upgraded.stop());
      let runResult;
      let runError = null;
      try {
        runResult = await upgraded.runOnce();
      } catch (error) {
        runError = error.message;
      }
      let previewResult;
      let previewError = null;
      try {
        previewResult = await upgraded.previewPolicy(request);
      } catch (error) {
        previewError = error.message;
      }
      const caches = (
        await h.db.query(
          "SELECT * FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 ORDER BY policy_signature",
          [sourceRow.fact_key],
        )
      ).rows;
      const retained = caches.find((row) => row.policy_signature === oldSignature);
      const current = caches.filter((row) => row.policy_signature !== oldSignature);
      t.diagnostic(
        JSON.stringify({
          family,
          droppedFamily,
          legacyDelivery,
          completePolicy,
          typedPredecessor,
          runError,
          previewError,
          classifiedHydrations: normalizeCalls.filter((entry) => entry.family === family && entry.classify).length,
          predecessorRetained: JSON.stringify(retained) === JSON.stringify(oldCache),
          currentKeys: current.length,
          currentKinds: caches.map((row) => row.document.actors[0].kind),
        }),
      );
      assert.equal(runError, null, "mixed-source publication must use a consistently reviewed account identity");
      assert.equal(runResult.state, "published");
      assert.deepEqual(retained, oldCache, "new classification must not overwrite an older frozen dependency");
      assert.equal(current.length, 1, "a new affected-family cache key must preserve the predecessor");
      assert.equal(current[0].document.actors[0].kind, "service_account");
      assert.equal(current[0].document.actors[0].executionMode, "unknown");
      assert.deepEqual(current[0].document.actors[0].serviceAccountClassification, classification);
      assert.equal(current[0].document_hash, comparisonHash(current[0].document));
      const { actors: oldActors, ...oldFacts } = oldCache.document;
      const { actors: newActors, ...newFacts } = current[0].document;
      assert.deepEqual(newFacts, oldFacts);
      assert.equal(newActors[0].githubDatabaseId, oldActors[0].githubDatabaseId);
      assert.equal(newActors[0].githubNodeId, oldActors[0].githubNodeId);
      assert.deepEqual(
        (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [sourceRow.fact_key]))
          .rows[0],
        sourceRow,
      );
      assert.deepEqual(
        (
          await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
            publication.snapshotId,
          ])
        ).rows[0],
        oldFrozen,
      );
      assert.equal(previewError, null);
      assert.deepEqual(previewResult, oldPreview);
      for (const filter of ["all", "user", "automation"]) {
        const response = await upgraded.app.inject(`/api/v1/exports?metric=${metrics[family]}&actors=${filter}`);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(
          response.json().rows.map((row) => [row.actorId, row.actorKind, row.executionMode]),
          filter === "user" ? [] : [[String(actor.databaseId), "service_account", "unknown"]],
        );
        assert.doesNotMatch(response.body, /serviceAccountClassification|reviewerActorId|synthetic-typed-cache/);
      }
      const callsBeforeCurrentRun = normalizeCalls.filter((entry) => entry.family === family && entry.classify).length;
      assert.equal((await upgraded.runOnce()).state, "published");
      assert.equal(
        normalizeCalls.filter((entry) => entry.family === family && entry.classify).length,
        callsBeforeCurrentRun + (family === "issue_field_history" ? 1 : 0),
      );
      assert.deepEqual(await upgraded.previewPolicy(request), oldPreview);
      // A valid new record must not hide corruption in its retained predecessor.
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=jsonb_set(document,'{actors,0,githubNodeId}','\"U_SYNTHETIC_TAMPERED\"'::jsonb) WHERE fact_key=$1 AND policy_signature=$2",
        [sourceRow.fact_key, oldSignature],
      );
      await assert.rejects(upgraded.previewPolicy(request), /Frozen identity evidence integrity failure/);
      await assert.rejects(upgraded.runOnce(), /normalization_integrity_error/);
    });
