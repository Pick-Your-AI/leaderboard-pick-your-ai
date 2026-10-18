import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { record as recordControlsDecision } from "../../controls/src/store.mjs";
import { harness, components, ago, publicScope } from "./harness.mjs";

const before = "a".repeat(40),
  after = "b".repeat(40),
  blob = "c".repeat(40);
const recordPath = "research/inference/candidate.md";
const sourceUrl = `https://github.com/synthetic-org/synthetic-repo/blob/${after}/${recordPath}`;
const policyVersion = "synthetic-research-v1";
const boardUrl = "/api/v1/boards?metric=decision_records";
const mergedAt = ago(5);

async function researchHarness(t) {
  const payload = {
    id: 1001,
    node_id: "SYNTHETIC_PR_RESEARCH",
    number: 1,
    html_url: "https://github.com/synthetic-org/synthetic-repo/pull/1",
    title: "Approved synthetic research proposal",
    created_at: ago(7),
    updated_at: mergedAt,
    merged_at: mergedAt,
    closed_at: mergedAt,
    state: "closed",
    merged: true,
    draft: false,
    merge_commit_sha: after,
    base: { ref: "main" },
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  };
  return harness(t, {
    payloads: [payload],
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.researchPolicies = [
        {
          repositoryId: 2,
          version: policyVersion,
          recordPaths: ["research/"],
          generatedPaths: ["research/generated/"],
          importedPaths: ["research/imported/"],
          syntheticPaths: ["research/fixtures/"],
        },
      ];
      const policy = {
        ...config.policies[0].policy,
        metricId: "decision_records",
        version: policyVersion,
        unit: components.metrics.getMetricDefinition("decision_records").definition.unit,
        roles: ["author"],
        rankedStates: ["qualified"],
        groupBy: "actor_artifact",
        dateBasis: "occurredAt",
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy-review" },
      ];
      config.recognitionBindings = [
        {
          category: "other",
          scope: "repository:2:decision_records",
          policyVersion,
          metricId: "decision_records",
          sourceMetricId: "decision_records",
          repositoryId: "2",
          reviewerIds: ["202"],
        },
      ];
    },
    enrichmentFactory(client, slug) {
      return async (input) => ({
        repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
        proof: { verified: true, source: "github_rest", revision: input.fact.sourceRevision, isSynthetic: true },
        family: "pull_request",
        observedAt: input.observedAt,
        payload: { pull_request: await client.rest("installation:1", `/repos/${slug}/pulls/1`) },
        integration: {
          before,
          after,
          targetBranch: "main",
          defaultBranch: "main",
          canonicalChangeId: "synthetic-research-merge",
          commitShas: [after],
          diff: {
            before,
            after,
            complete: true,
            files: [
              { path: recordPath, additions: 20, deletions: 4 },
              { path: "research/unverified.md", additions: 100, deletions: 0 },
            ],
          },
        },
        researchRecords: [
          {
            verified: true,
            kind: "decision_record",
            repositoryId: 2,
            path: recordPath,
            sourceRevision: after,
            blobSha: blob,
            presentAtRevision: true,
            provenance: "original",
          },
        ],
      });
    },
  });
}

function accept(h, locator = sourceUrl) {
  let decision;
  h.controlsStore.transaction((state) => {
    const previous = state.requests["synthetic-record-request"];
    const request = {
      id: "synthetic-record-request",
      version: previous?.version ?? 0,
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: "other",
      scope: "repository:2:decision_records",
      policyVersion,
      locator,
      collaborators: {},
      history: [...(previous?.history ?? [])],
    };
    recordControlsDecision(state, request, "202", "accepted", Date.parse(ago(1)), {
      policyVersion,
      reason: "Private reviewer deliberation must remain private",
    });
    state.requests[request.id] = request;
    decision = request.history.at(-1);
  });
  return decision;
}

test("research records publish pending proof, require exact revision review, conserve accepted credit through replay and withdrawal", async (t) => {
  const h = await researchHarness(t);
  const first = await h.runtime.runOnce();
  let response = await h.runtime.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  let board = response.json();
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].result.state, "unknown");
  assert.equal(board.rows[0].pending.count, 1);
  assert.equal(board.rows[0].rank, null);
  const pending = await h.runtime.app.inject(
    `/api/v1/evidence/${board.rows[0].pending.evidenceIds[0]}?snapshot=${board.snapshotId}`,
  );
  assert.equal(pending.statusCode, 200, pending.body);
  assert.equal(pending.json().artifact.publicUrl, sourceUrl);
  assert.equal(pending.json().activityState, "pending");
  assert.equal(pending.body.includes("Approved synthetic research proposal"), false);

  // A generic PR approval and a different pinned note revision match neither candidate.
  accept(h, sourceUrl.replace(after, before));
  await h.runtime.runOnce();
  response = await h.runtime.app.inject(boardUrl);
  assert.equal(response.json().rows[0].result.state, "unknown");
  const review = accept(h);
  const accepted = await h.runtime.runOnce();
  response = await h.runtime.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  board = response.json();
  assert.equal(board.rows[0].result.value, 1);
  assert.equal(board.rows[0].pending.count, null); // Incomplete coverage cannot establish measured zero.
  assert.equal(board.rows[0].rank, 1);
  const evidenceId = board.rows[0].evidenceIds[0];
  const proof = await h.runtime.app.inject(`/api/v1/evidence/${evidenceId}?snapshot=${board.snapshotId}`);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.equal(proof.json().artifact.publicUrl, sourceUrl);
  assert.equal(proof.json().sourceRevision, after);
  assert.equal(proof.json().occurredAt, mergedAt); // The registry's merge clock is preserved.
  assert.equal(proof.json().activityState, "accepted");
  assert.equal(proof.body.includes("Private reviewer deliberation"), false);
  assert.equal(proof.body.includes(review.id), false);
  assert.equal(first.publications[0].snapshotId === accepted.publications[0].snapshotId, false);

  const cutoff = ago(0);
  await h.runtime.runOnce({ cutoff });
  await h.runtime.runOnce({ cutoff });
  await h.reopenDatabase();
  await h.runtime.runOnce();
  assert.equal((await h.runtime.app.inject(boardUrl)).json().rows[0].result.value, 1);
  const frozen = await h.runtime.source.read(publicScope, board.snapshotId, new AbortController().signal);
  assert.equal(JSON.stringify(frozen).includes("accepted_findings"), false);
  h.controlsStore.transaction((state) => {
    state.requests["synthetic-record-request"].status = "withdrawn";
  });
  assert.equal(await h.runtime.source.read(publicScope, board.snapshotId, new AbortController().signal), null);
  await h.runtime.runOnce();
  assert.equal((await h.runtime.app.inject(boardUrl)).json().rows[0].result.state, "unknown");
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce(), /public_source_not_verified/);
  assert.equal(
    await h.runtime.source.read(publicScope, first.publications[0].snapshotId, new AbortController().signal),
    null,
  );
});

test("research record activation rejects raw-ranked, wrong-clock and per-observation policies", async (t) => {
  const h = await researchHarness(t);
  for (const invalid of [
    { dateBasis: "acceptedAt" },
    { groupBy: "canonical" },
    { rankedStates: ["observed"] },
    { aggregation: "sum" },
  ]) {
    const config = structuredClone(h.config);
    Object.assign(config.policies[0].policy, invalid);
    await assert.rejects(createPipeline({ ...h.options, config }), /research_record_metric_policy_incompatible/);
  }
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 0);
});

test("a reviewed classification change invalidates cached research normalizations without changing metric arithmetic", async (t) => {
  const h = await researchHarness(t);
  await h.runtime.runOnce();
  assert.equal((await h.runtime.app.inject(boardUrl)).json().rows[0].pending.count, 1);
  const config = structuredClone(h.config);
  config.version = "synthetic-configuration-v2";
  config.researchPolicies[0].version = "synthetic-research-paths-v2";
  config.researchPolicies[0].recordPaths = ["research/approved-other-area/"];
  const runtime = await createPipeline({ ...h.options, config });
  t.after(() => runtime.stop());
  await runtime.runOnce();
  const response = await runtime.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    response.json().rows.some((row) => row.pending?.count > 0 || row.result.value > 0),
    false,
  );
  const cached = await h.db.query(
    "SELECT count(DISTINCT policy_signature)::int AS n FROM leaderboard_pipeline.normalizations",
  );
  assert.equal(cached.rows[0].n, 2);
});

for (const priorFormat of ["before attribution", "before merge pins"])
  test(`classified research evidence from ${priorFormat} survives cache migration and remains bound to its source policy`, async (t) => {
    const h = await researchHarness(t);
    accept(h);
    h.options.authorizePolicyPreview = async () => true;
    const cutoff = ago(0);
    const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
    const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
    const legacy = structuredClone(saved.document);
    if (priorFormat === "before attribution") {
      delete legacy.assistance;
      delete legacy.participation;
    }
    for (const entry of legacy.evidence.filter((value) => value.contribution.metricIds.includes("pr_merged"))) {
      entry.sourceRevision = null;
      entry.sourceRevisionUrl = null;
    }
    // Recreate each exact earlier persisted signature, including the approved
    // source classification, while keeping that format's original document.
    const policySignature = comparisonHash([
      "current-state-selection-v2",
      "synthetic",
      h.config.policies.map((entry) => entry.signature),
      { documentation: [], research: h.config.researchPolicies },
    ]);
    const legacySignature =
      priorFormat === "before attribution"
        ? policySignature
        : comparisonHash([normalizationDocumentVersion, policySignature]);
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
    const previewInput = {
      snapshotId: publication.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-legacy-research-preview", rank: false },
      operatorId: "201",
    };
    const preview = () => restarted.previewPolicy(previewInput);
    assert.equal((await preview()).comparison.before.rows.find((row) => row.actorId === "101").value, 1);
    await restarted.runOnce({ cutoff });
    const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((row) => row.policy_signature === legacySignature).document, legacy);
    assert.deepEqual(rows.find((row) => row.policy_signature !== legacySignature).document.assistance, []);
    const fresh = rows.find((row) => row.policy_signature !== legacySignature).document;
    assert.equal(
      fresh.evidence.find((entry) => entry.contribution.metricIds.includes("pr_merged")).sourceRevision,
      after,
    );
    assert.equal((await preview()).comparison.before.rows.find((row) => row.actorId === "101").value, 1);

    // A legacy document with identical content and metric arithmetic still cannot
    // authorize the frozen source identity if its classification binding is gone.
    const unclassifiedSignature = comparisonHash([
      "current-state-selection-v1",
      "synthetic",
      h.config.policies.map((entry) => entry.signature),
    ]);
    await h.db.query("UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE policy_signature=$2", [
      unclassifiedSignature,
      legacySignature,
    ]);
    await assert.rejects(preview(), /identity evidence unavailable/);
  });

for (const state of ["pending", "accepted"])
  test(`source PR suppression removes ${state} record versions from current and pinned public/private reads after restart`, async (t) => {
    const h = await researchHarness(t);
    if (state === "accepted") accept(h);
    h.options.authorizePolicyPreview = async () => true;
    await h.runtime.runOnce();
    const board = (await h.runtime.app.inject(boardUrl)).json();
    const evidenceId = state === "accepted" ? board.rows[0].evidenceIds[0] : board.rows[0].pending.evidenceIds[0];
    assert.equal(state === "accepted" ? board.rows[0].result.value : board.rows[0].pending.count, 1);
    const policy = { ...h.config.policies[0].policy, version: "synthetic-research-preview-v2", rank: false };
    await h.runtime.previewPolicy({ snapshotId: board.snapshotId, policy, operatorId: "201" });
    await h.runtime.aggregateExplanations.read(board.snapshotId);

    // The authoritative removal names the collected PR, not its derived record artifact.
    await h.db.query(
      "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(2,'SYNTHETIC_PR_RESEARCH','unavailable')",
    );
    async function assertSuppressed(runtime) {
      for (const pin of ["", `&snapshot=${board.snapshotId}`]) {
        const response = await runtime.app.inject(boardUrl + pin);
        assert.equal(response.statusCode, 200, response.body);
        if (state === "accepted") assert.equal(response.json().rows.length, 0, response.body);
        for (const row of response.json().rows) {
          assert.equal(row.result.state, "unknown");
          assert.equal(row.pending.count, null);
          assert.deepEqual(row.pending.evidenceIds, []);
          assert.equal(row.rank, null);
        }
      }
      const proof = await runtime.app.inject(`/api/v1/evidence/${evidenceId}?snapshot=${board.snapshotId}`);
      assert.equal(proof.statusCode, 404, proof.body);
      await assert.rejects(
        runtime.previewPolicy({ snapshotId: board.snapshotId, policy, operatorId: "201" }),
        /policy_input_revoked/,
      );
      await assert.rejects(
        runtime.aggregateExplanations.read(board.snapshotId),
        /aggregate_explanation_privacy_changed/,
      );
    }
    await assertSuppressed(h.runtime);
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    await assertSuppressed(restarted);
    // Cached collection/replay cannot resurrect a derived version of a suppressed source.
    await restarted.runOnce();
    await assertSuppressed(restarted);
    assert.equal(
      (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .state,
      "public",
    );
  });
