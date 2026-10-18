import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, boardUrl } from "./harness.mjs";

const reviewedServiceAccount = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-private-service-account-review",
  githubDatabaseId: 101,
  githubNodeId: "U_SYNTHETIC_A",
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-private-account-evidence"],
  reviewerActorId: "202",
  reviewedAt: "2026-01-01T00:00:00Z",
};
const reviewedNormalizer = (classification) => (options) =>
  components.github.createGithubEvidenceNormalizer({
    client: options.githubClient,
    source: options.sourceId,
    allowedRepositoryIds: [2],
    isSynthetic: true,
    reviewedServiceAccounts: [classification],
    authorizedClassifierIds: ["202"],
  });

for (const recognition of [false, true])
  test(`reviewed service account replays without retained identity; recognition=${recognition}`, async (t) => {
    const { createPolicyComparisonManager } = await import("../../controls/src/policy-comparison.mjs");
    const h = await harness(t, { normalizerFactory: reviewedNormalizer(reviewedServiceAccount) });
    const config = structuredClone(h.options.config);
    if (recognition)
      config.recognitionBindings = [
        {
          category: "finding",
          scope: "repository:2",
          policyVersion: config.policies[0].policy.version,
          metricId: "issues_opened",
          sourceMetricId: "issues_opened",
          repositoryId: "2",
          reviewerIds: ["202"],
        },
      ];
    h.options = { ...h.options, config, authorizePolicyPreview: async () => true };
    const { comparisonHash } = await import("../../controls/src/policy-comparison.mjs");
    const { previewAuthorityLimitsV1 } = await import("../../controls/src/policy-preview-authority.mjs");
    h.authority.replace({
      schemaVersion: previewAuthorityLimitsV1.schemaVersion,
      revision: 2,
      validUntil: Date.now() + 60_000,
      configurationHashes: [comparisonHash(config)],
      reviewers: [{ actorId: "201", roleVersion: "1" }],
    });

    h.runtime = await createPipeline(h.options);
    t.after(() => h.runtime.stop());
    const publication = (await h.runtime.runOnce()).publications[0];
    assert.equal(publication.comparisonInput.state, "retained");
    const record = h.runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
    assert.equal(record.input.actors.find((actor) => actor.id === "101").kind, "service_account");
    assert.equal(record.authorization.identityEvidence.schemaVersion, "pipeline-identity-evidence/v1");
    assert.equal(record.authorization.identityEvidence.normalizationHashes.length, 2);
    const privateFields =
      /githubNodeId|githubDatabaseId|serviceAccountClassification|reviewerActorId|authorizedClassifierIds|U_SYNTHETIC_[AB]|synthetic-private-(?:service-account-review|account-evidence)/;
    assert.doesNotMatch(JSON.stringify(record), privateFields);
    const sqlInput = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        publication.snapshotId,
      ])
    ).rows[0].document;
    assert.doesNotMatch(JSON.stringify(sqlInput), privateFields);
    assert.deepEqual(sqlInput.identityAuthorization.identityEvidence, record.authorization.identityEvidence);
    const sqlPreview = await h.runtime.previewPolicy({
      snapshotId: publication.snapshotId,
      policy: { ...record.policies[0], version: "synthetic-sql-preview-v2", rank: false },
      operatorId: "201",
    });
    assert.ok(sqlPreview.comparison.before.rows.some((row) => row.actorId === "101"));
    assert.doesNotMatch(JSON.stringify(sqlPreview), privateFields);

    const session = {
      sid: "synthetic-service-account-reviewer",
      actorId: "201",
      roles: ["reviewer"],
      roleVersion: "1",
      expires: Date.now() + 600_000,
    };
    h.controlsStore.transaction((state) => {
      state.sessions[session.sid] = session;
    });
    const request = {
      path: "/controls/policy-comparisons",
      method: "POST",
      session,
      refreshSession: async () => session,
      input: {
        inputId: record.id,
        candidatePolicy: { ...record.policies[0], version: "synthetic-service-preview-v2", rank: false },
      },
    };
    const manager = createPolicyComparisonManager(h.runtime.policyComparisons);
    const result = await manager(request);
    assert.equal(result.status, 200);
    assert.ok(result.data.before.rows.some((row) => row.actorId === "101"));
    assert.doesNotMatch(JSON.stringify(result), privateFields);
    for (const path of [
      boardUrl,
      "/api/v1/contributors",
      "/api/v1/contributors/101",
      "/api/v1/exports?metric=issues_opened",
      "/api/v1/exports?metric=issues_opened&format=csv",
    ])
      assert.doesNotMatch(
        (await h.runtime.app.inject(path)).body,
        /serviceAccountClassification|reviewerActorId|authorizedClassifierIds|synthetic-private-(?:service-account-review|account-evidence)/,
      );
    // Public Actor contracts already expose stable provider IDs; exports and
    // private previews intentionally have a smaller, explicit identity projection.
    const exportResponse = await h.runtime.app.inject("/api/v1/exports?metric=issues_opened");
    assert.doesNotMatch(exportResponse.body, privateFields);
    assert.equal(exportResponse.json().rows.find((row) => row.actorId === "101").actorKind, "service_account");
    assert.equal(exportResponse.json().rows.find((row) => row.actorId === "101").executionMode, "unknown");
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    assert.deepEqual(await createPolicyComparisonManager(restarted.policyComparisons)(request), result);
    h.controlsStore.transaction((state) => {
      state.profiles["101"] = { suppressed: true };
    });
    const suppressedPublication = (await h.runtime.runOnce()).publications[0];
    assert.equal(suppressedPublication.comparisonInput.state, "retained");
    const suppressedRecord = h.runtime.policyComparisons.comparisons.input(
      suppressedPublication.comparisonInput.inputId,
    );
    assert.equal(suppressedRecord.input.actors.find((actor) => actor.id === "101").publicState, "suppressed");
    assert.deepEqual(suppressedRecord.authorization.identityEvidence, record.authorization.identityEvidence);
    const suppressedReplay = await manager({
      ...request,
      input: {
        inputId: suppressedRecord.id,
        candidatePolicy: { ...record.policies[0], version: "synthetic-service-preview-v3", rank: false },
      },
    });
    assert.equal(suppressedReplay.status, 200);
    assert.ok(suppressedReplay.data.before.rows.every((row) => row.actorId !== "101"));
    assert.doesNotMatch(JSON.stringify(suppressedRecord), privateFields);
    const saved = (
      await h.db.query(
        "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key LIMIT 1",
      )
    ).rows[0];
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=jsonb_set(document,'{actors,0,githubNodeId}','\"U_TAMPERED\"'::jsonb) WHERE fact_key=$1 AND policy_signature=$2",
      [saved.fact_key, saved.policy_signature],
    );
    await assert.rejects(manager(request), /identity evidence integrity failure/);
    await assert.rejects(
      manager({ ...request, method: "GET", path: "/controls/policy-comparisons/" + result.data.comparisonId }),
      /identity evidence integrity failure/,
    );
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
      saved.fact_key,
      saved.policy_signature,
    ]);
    await assert.rejects(manager(request), /identity evidence unavailable/);
    assert.doesNotMatch(
      JSON.stringify(
        h.controlsStore.db
          .prepare("SELECT document FROM policy_preview_inputs UNION ALL SELECT document FROM policy_previews")
          .all(),
      ),
      privateFields,
    );
  });

for (const legacyUnknown of [false, true])
  for (const reverse of [false, true])
    test(`mixed execution observations publish and replay one User; legacy=${legacyUnknown}, reverse=${reverse}`, async (t) => {
      const { createPolicyComparisonManager } = await import("../../controls/src/policy-comparison.mjs");
      const h = await harness(t, {
        authorizePolicyPreview: async () => true,
        reverseNormalizationRows: reverse,
        transformPayloads: (payloads) => {
          payloads[1].user = structuredClone(payloads[0].user);
          payloads[1].sender = structuredClone(payloads[0].user);
          payloads[1].execution_mode = "automated";
          return payloads;
        },
        normalizerFactory: (options) => {
          const normalize = components.github.createGithubEvidenceNormalizer({
            client: options.githubClient,
            source: options.sourceId,
            allowedRepositoryIds: [2],
            isSynthetic: true,
          });
          return async (input) => {
            const output = await normalize(input);
            if (legacyUnknown)
              for (const actor of output.actors) if (actor.executionMode === "unknown") delete actor.executionMode;
            return output;
          };
        },
      });
      const publication = (await h.runtime.runOnce()).publications[0];
      const modes = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows.flatMap((row) =>
        row.document.actors.map((actor) => actor.executionMode ?? "legacy"),
      );
      assert.deepEqual(modes.sort(), ["automated", legacyUnknown ? "legacy" : "unknown"].sort());
      assert.equal(publication.comparisonInput.state, "retained");
      const record = h.runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
      assert.equal(record.input.actors.length, 1);
      assert.equal(record.input.actors[0].kind, "user");
      assert.equal(record.input.actors[0].executionMode, "automated");
      for (const filter of ["all", "user", "automation"]) {
        const response = await h.runtime.app.inject(`${boardUrl}&actors=${filter}`);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(
          response.json().rows.map((row) => [row.actorId, row.result.value]),
          [["101", 2]],
        );
        const exported = await h.runtime.app.inject(`/api/v1/exports?metric=issues_opened&actors=${filter}`);
        assert.equal(exported.statusCode, 200, exported.body);
        assert.deepEqual(
          exported.json().rows.map((row) => [row.actorId, row.actorKind, row.executionMode]),
          [["101", "user", "automated"]],
        );
      }
      const sqlPreview = await h.runtime.previewPolicy({
        snapshotId: publication.snapshotId,
        policy: { ...record.policies[0], version: "synthetic-mixed-execution-sql-v2", rank: false },
        operatorId: "201",
      });
      assert.deepEqual(
        sqlPreview.comparison.before.rows.map((row) => [row.actorId, row.value]),
        [["101", 2]],
      );
      const session = {
        sid: "synthetic-mixed-execution-reviewer",
        actorId: "201",
        roles: ["reviewer"],
        roleVersion: "1",
        expires: Date.now() + 600_000,
      };
      h.controlsStore.transaction((state) => {
        state.sessions[session.sid] = session;
      });
      const request = {
        path: "/controls/policy-comparisons",
        method: "POST",
        session,
        refreshSession: async () => session,
        input: {
          inputId: record.id,
          candidatePolicy: { ...record.policies[0], version: "synthetic-mixed-execution-private-v2", rank: false },
        },
      };
      const result = await createPolicyComparisonManager(h.runtime.policyComparisons)(request);
      assert.equal(result.status, 200);
      assert.deepEqual(
        result.data.before.rows.map((row) => [row.actorId, row.value]),
        [["101", 2]],
      );
      const restarted = await createPipeline(h.options);
      t.after(() => restarted.stop());
      assert.deepEqual(await createPolicyComparisonManager(restarted.policyComparisons)(request), result);
      assert.deepEqual(
        await restarted.previewPolicy({
          snapshotId: publication.snapshotId,
          policy: { ...record.policies[0], version: "synthetic-mixed-execution-sql-v2", rank: false },
          operatorId: "201",
        }),
        sqlPreview,
      );
    });

for (const conflict of ["login", "kind"])
  test(`positive automation does not hide conflicting ${conflict} metadata`, async (t) => {
    const h = await harness(t, {
      transformPayloads: (payloads) => {
        payloads[1].user = {
          ...payloads[0].user,
          ...(conflict === "login" ? { login: "synthetic-conflicting-login" } : { type: "Bot" }),
        };
        payloads[1].sender = structuredClone(payloads[1].user);
        payloads[1].execution_mode = "automated";
        return payloads;
      },
    });
    await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata/);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
    assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  });

for (const conflict of ["shared_node", "shared_database_id"])
  for (const reverse of [false, true])
    test(`pipeline rejects cross-observation ${conflict} before publication in ${reverse ? "reverse" : "forward"} order`, async (t) => {
      const { githubNodeId, ...numericClassification } = reviewedServiceAccount;
      const h = await harness(t, {
        normalizerFactory: reviewedNormalizer(numericClassification),
        reverseNormalizationRows: reverse,
        transformPayloads: (payloads) => {
          payloads[1].user = {
            ...payloads[1].user,
            ...(conflict === "shared_node" ? { node_id: payloads[0].user.node_id } : { id: payloads[0].user.id }),
          };
          return payloads;
        },
      });
      await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata|Conflicting actor node identity bindings/);
      assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
      assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    });
