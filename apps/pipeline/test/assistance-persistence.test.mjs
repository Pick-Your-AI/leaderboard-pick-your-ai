import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { harness, components, ago, clock } from "./harness.mjs";

const artifactId = "SYNTHETIC_PR_ASSISTED";
const boardUrl = "/api/v1/boards?metric=pr_merged";
// Match the whole private version without treating ISO timestamp seconds as attribution.
const privateFields = /assistance|participation|Claude|(?<![\d.])5\.5(?![\d.])|synthetic-model|example\.invalid|manual/;

test("private model version detector rejects JSON/CSV values without matching source timestamp fractions", () => {
  assert.doesNotMatch(JSON.stringify({ occurredAt: "2026-10-17T05:26:35.586Z" }), privateFields);
  for (const value of [
    JSON.stringify({ version: "5.5" }),
    '"5.5"',
    "5.5",
    JSON.stringify({ assistance: [] }),
    JSON.stringify({ participation: [] }),
    "Claude Opus",
    "synthetic-model@example.invalid",
    "manual",
  ]) {
    assert.match(value, privateFields);
  }
});

async function assistedHarness(t) {
  let enrichCalls = 0;
  const payload = {
    id: 1001,
    node_id: artifactId,
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/pull/1",
    created_at: ago(2),
    updated_at: ago(1),
    merged_at: ago(1),
    closed_at: ago(1),
    state: "closed",
    merged: true,
    draft: false,
    base: { ref: "main" },
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
    merged_by: { id: 202, node_id: "U_SYNTHETIC_M", login: "synthetic-merger", type: "User" },
  };
  const h = await harness(t, {
    payloads: [payload],
    authorizePolicyPreview: async () => true,
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      const policy = {
        ...config.policies[0].policy,
        metricId: "pr_merged",
        unit: components.metrics.getMetricDefinition("pr_merged").definition.unit,
        roles: ["author"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy-review" },
      ];
    },
    enrichmentFactory(client, slug) {
      return async (input) => {
        enrichCalls++;
        const fetched = await client.rest("installation:1", `/repos/${slug}/pulls/1`);
        const declared = components.github.parseDeclaredCoauthorTrailers(
          "Co-authored-by: Claude Opus 5.5 <synthetic-model@example.invalid>\nCo-authored-by: Verified Person\nCo-authored-by: Unverified Person",
          {
            declaredModels: [{ trailerName: "Claude Opus 5.5", model: "Claude Opus", version: "5.5" }],
            verifiedPeople: [
              {
                trailerName: "Verified Person",
                actor: { id: 303, node_id: "U_SYNTHETIC_C", login: "synthetic-coauthor", type: "User" },
                verificationReceipt: "synthetic-verified-person",
              },
            ],
          },
        );
        assert.equal(declared.unresolvedCount, 1);
        return {
          repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
          proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
          family: "pull_request",
          observedAt: input.observedAt,
          payload: { pull_request: fetched },
          assistance: declared.assistance,
          verifiedCoauthors: declared.coauthors,
        };
      };
    },
  });
  return { ...h, enrichCalls: () => enrichCalls };
}

async function assertPrivateAndUncredited(h, runtime) {
  const saved = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows[0].document;
  assert.deepEqual(saved.assistance, [{ artifactId, model: "Claude Opus", version: "5.5" }]);
  assert.deepEqual(saved.participation, [
    { artifactId, actorId: "101", role: "author", conservedUnit: `${artifactId}:merged` },
    { artifactId, actorId: "303", role: "coauthor", conservedUnit: `${artifactId}:merged` },
  ]);
  assert.deepEqual(saved.actors.map((actor) => actor.id).sort(), ["101", "202", "303"]);
  assert.ok(saved.actors.every((actor) => actor.kind === "user" && actor.executionMode === "unknown"));
  assert.equal(saved.facts.find((fact) => fact.metricId === "pr_merged").actorId, "101");
  assert.equal(saved.facts.find((fact) => fact.metricId === "maintainer_merges").actorId, "202");
  assert.equal(saved.facts.find((fact) => fact.metricId === "pr_coauthored").actorId, "303");
  assert.doesNotMatch(JSON.stringify(saved), /email|example\.invalid|synthetic-model|manual/);
  const boardResponse = await runtime.app.inject(boardUrl);
  assert.equal(boardResponse.statusCode, 200, boardResponse.body);
  const board = boardResponse.json();
  assert.deepEqual(
    board.rows.map((row) => [row.actorId, row.result.value]),
    [["101", 1]],
  );
  const paths = [
    boardUrl,
    "/api/v1/contributors",
    "/api/v1/contributors/101",
    "/api/v1/exports?metric=pr_merged",
    "/api/v1/exports?metric=pr_merged&format=csv",
    `/api/v1/evidence/${board.rows[0].evidenceIds[0]}?snapshot=${board.snapshotId}`,
  ];
  for (const path of paths) {
    const response = await runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, privateFields);
  }
  for (const table of ["snapshots", "frozen_inputs", "receipts"])
    assert.doesNotMatch(
      JSON.stringify((await h.db.query(`SELECT document FROM leaderboard_pipeline.${table}`)).rows),
      /"assistance"|"participation"|Claude|example\.invalid|synthetic-model/,
    );
  return saved;
}

test("declared model/version and conserved participation survive collection, cache and database restart privately", async (t) => {
  const h = await assistedHarness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  assert.equal(first.state, "published");
  assert.equal(h.enrichCalls(), 1);
  const original = await assertPrivateAndUncredited(h, h.runtime);
  const cached = await h.runtime.runOnce({ cutoff });
  assert.equal(cached.publications[0].changed, false);
  assert.equal(h.enrichCalls(), 1);
  assert.deepEqual(await assertPrivateAndUncredited(h, h.runtime), original);
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const replay = await restarted.runOnce({ cutoff });
  assert.equal(replay.publications[0].changed, false);
  assert.equal(h.enrichCalls(), 1);
  assert.deepEqual(await assertPrivateAndUncredited(h, restarted), original);
});

test("legacy cache recomputes missing attribution while exact frozen identity replay remains authorized", async (t) => {
  const h = await assistedHarness(t);
  const cutoff = clock();
  const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  const legacy = structuredClone(saved.document);
  delete legacy.assistance;
  delete legacy.participation;
  const legacySignature = createHash("sha256")
    .update(
      JSON.stringify(["current-state-selection-v1", "synthetic", h.config.policies.map((entry) => entry.signature)]),
    )
    .digest("hex");
  const legacyHash = comparisonHash(legacy);
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1,document=$2::jsonb,document_hash=$3 WHERE fact_key=$4",
    [legacySignature, JSON.stringify(legacy), legacyHash, saved.fact_key],
  );
  const frozen = (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs")).rows[0].document;
  frozen.identityAuthorization.identityEvidence.normalizationHashes = [legacyHash];
  await h.db.query("UPDATE leaderboard_pipeline.frozen_inputs SET document=$1::jsonb,document_hash=$2", [
    JSON.stringify(frozen),
    comparisonHash(frozen),
  ]);
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const preview = () =>
    restarted.previewPolicy({
      snapshotId: publication.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-legacy-preview", rank: false },
      operatorId: "201",
    });
  assert.ok((await preview()).comparison.before.rows.some((row) => row.actorId === "101"));
  assert.equal(h.enrichCalls(), 1);
  await restarted.runOnce({ cutoff });
  assert.equal(h.enrichCalls(), 2);
  const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.policy_signature === legacySignature).document, legacy);
  assert.deepEqual(rows.find((row) => row.policy_signature !== legacySignature).document.assistance, [
    { artifactId, model: "Claude Opus", version: "5.5" },
  ]);
  assert.ok((await preview()).comparison.before.rows.some((row) => row.actorId === "101"));
  // A matching hash is insufficient without the same policy, source and mode.
  await h.db.query("UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE policy_signature=$2", [
    "f".repeat(64),
    legacySignature,
  ]);
  await assert.rejects(preview(), /identity evidence unavailable/);
});

test("malformed private attribution fails before normalization persistence or publication", async (t) => {
  const h = await harness(t, {
    normalizerFactory(options) {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
      return async (input) => {
        const output = await normalize(input);
        output.assistance = [{ artifactId: "SYNTHETIC_UNRELATED", model: "Claude Opus", version: "5.5" }];
        return output;
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /invalid_private_attribution/);
  for (const table of ["normalizations", "snapshots", "frozen_inputs"])
    assert.equal((await h.db.query(`SELECT count(*)::int AS n FROM leaderboard_pipeline.${table}`)).rows[0].n, 0);
});
