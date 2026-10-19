import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { buildAggregateExplanation, AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
import { ago, clock, components, harness, publicScope } from "./harness.mjs";
import { insertOperatorDelivery } from "./operator-harness.mjs";

const version = "review-source-identity/v3";
const slug = "synthetic-org/synthetic-repo";
const parentUrl = `https://github.com/${slug}/pull/10`;
const parentApi = `https://api.github.com/repos/${slug}/pulls/10`;
const actor = (id) => ({ id, node_id: `U_SYNTHETIC_${id}`, login: `synthetic-${id}`, type: "User" });
const projectSignature = (config, version) =>
  comparisonHash([
    version,
    comparisonHash([
      "verified-default-branch-merge-pins/v1",
      comparisonHash([
        normalizationDocumentVersion,
        comparisonHash(["current-state-selection-v1", "synthetic", config.policies.map((entry) => entry.signature)]),
      ]),
    ]),
    [],
  ]);
const legacySignature = (config) => projectSignature(config, "project-membership-context/v1");
const currentSignature = (config) => projectSignature(config, "project-membership-context/v2");

async function reviewHarness(t, extra = {}) {
  const at = ago(2);
  const issue = {
    id: 1001,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    html_url: `https://github.com/${slug}/issues/1`,
    created_at: at,
    updated_at: at,
    user: actor(101),
  };
  const parent = {
    id: 10,
    node_id: "PR_SYNTHETIC_10",
    number: 10,
    html_url: parentUrl,
    user: actor(101),
    created_at: ago(3),
    updated_at: at,
    state: "open",
    head: { sha: "a".repeat(40) },
  };
  const state = {
    parent: structuredClone(parent),
    review: {
      id: 51,
      node_id: "PRR_SYNTHETIC_51",
      html_url: `${parentUrl}#pullrequestreview-51`,
      pull_request_url: parentApi,
      _links: {
        html: { href: `${parentUrl}#pullrequestreview-51` },
        pull_request: { href: parentApi },
      },
      user: actor(303),
      state: "COMMENTED",
      submitted_at: at,
      created_at: at,
      commit_id: "a".repeat(40),
      body: "Synthetic feedback body, never public evidence",
    },
    cohort: null,
    hydrations: 0,
  };
  const githubClient = syntheticRepositoryClient(2, {
    rest: async (_source, path) => {
      if (path === `/repos/${slug}/issues/1`) return structuredClone(issue);
      if (path === `/repos/${slug}/pulls/10`) return structuredClone(state.parent);
      if (path === `/repos/${slug}/pulls/10/reviews/51`) {
        state.hydrations += 1;
        return structuredClone(state.review);
      }
      assert.equal(path, `/repos/${slug}`);
      return { id: 2, private: false, full_name: slug, default_branch: "main" };
    },
    scanRest: async ({ url }) => {
      assert.equal(url, `/repos/${slug}/pulls/10/reviews?per_page=100`);
      return structuredClone(state.cohort ?? [state.review]);
    },
  });
  const h = await harness(t, {
    authorizePolicyPreview: async () => true,
    githubClient,
    source: {
      async readPage(request) {
        assert.ok(request.family === "reviews" || (extra.includeIssue && request.family === "issues"));
        const item = request.family === "issues" ? issue : state.review;
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: item.node_id,
              sourceRevision:
                request.family === "issues"
                  ? item.updated_at
                  : extra.sequenceObservation
                    ? components.github.githubSnapshotRevision(
                        components.github.githubReviewRevision(item),
                        request.runId,
                      )
                    : components.github.githubReviewRevision(item),
              sourceUrl: item.html_url,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "present",
            },
          ],
        };
      },
    },
    configure(config) {
      const issuePolicy = config.policies[0];
      config.repositories[0].families = extra.includeIssue ? ["issues", "reviews"] : ["reviews"];
      config.policies = [
        "prs_reviewed",
        "review_rounds",
        "review_feedback",
        ...(extra.sequenceObservation ? ["first_reviews"] : []),
      ].map((metricId) => {
        const policy = {
          ...config.policies[0].policy,
          metricId,
          unit: components.metrics.getMetricDefinition(metricId).definition.unit,
          roles: ["reviewer"],
          groupBy: ["first_reviews", "review_rounds"].includes(metricId) ? "canonical" : "actor_artifact",
          rank: metricId !== "review_feedback",
        };
        return { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" };
      });
      if (extra.includeIssue) config.policies.push(issuePolicy);
    },
    ...extra,
  });
  return { ...h, state, parent, issue };
}

const previewRequest = (h, snapshotId) => ({
  snapshotId,
  policy: { ...h.config.policies[0].policy, version: "synthetic-review-preview", rank: false },
  operatorId: "201",
});
const paths = (metric) => [
  `/api/v1/boards?metric=${metric}`,
  `/api/v1/exports?metric=${metric}&format=json`,
  `/api/v1/exports?metric=${metric}&format=csv`,
];
async function assertDenied(runtime, snapshotId, { current = true } = {}) {
  for (const path of paths("prs_reviewed")) {
    if (current) assert.equal((await runtime.app.inject(path)).statusCode, 503, path);
    const response = await runtime.app.inject(`${path}&snapshot=${snapshotId}`);
    assert.equal(response.statusCode, 410, response.body);
    assert.doesNotMatch(response.body, /synthetic-303|PR_SYNTHETIC|normalizationHashes|normalizationSources/);
  }
}
async function assertMetrics(runtime, expected, snapshotId = null) {
  for (const [metric, count] of Object.entries(expected)) {
    const suffix = snapshotId ? `&snapshot=${snapshotId}` : "";
    const response = await runtime.app.inject(`/api/v1/boards?metric=${metric}${suffix}`);
    assert.equal(response.statusCode, 200, response.body);
    const positives = response.json().rows.filter((row) => row.result.value > 0);
    assert.deepEqual(
      positives.map((row) => [row.actorId, row.result.value]),
      count ? [["303", count]] : [],
    );
  }
  for (const path of paths("prs_reviewed")) {
    const response = await runtime.app.inject(`${path}${snapshotId ? `&snapshot=${snapshotId}` : ""}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(
      response.body,
      /reviewSourceNormalizationVersion|normalizationHashes|normalizationSources|feedback body/,
    );
  }
}

// A deliberately pre-upgrade fixture: actual source/cache, SQL frozen input and
// SQLite authorities retain valid hashes, but review semantics have no version
// assertion. Rebuild the private arithmetic receipt from the same frozen input.
async function retainLegacyReview(h, publication, bindingMode, legacyVersion = null) {
  const row = (
    await h.db.query(
      `SELECT n.* FROM leaderboard_pipeline.normalizations n
       JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='reviews'`,
    )
  ).rows[0];
  const document = structuredClone(row.document);
  if (legacyVersion) document.reviewSourceNormalizationVersion = legacyVersion;
  else delete document.reviewSourceNormalizationVersion;
  const oldHash = comparisonHash(document);
  const signature = legacyVersion
    ? comparisonHash([legacyVersion, currentSignature(h.config)])
    : legacySignature(h.config);
  await h.db.query(
    `UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document=$3::jsonb,document_hash=$4
     WHERE fact_key=$1 AND policy_signature=$5`,
    [row.fact_key, signature, JSON.stringify(document), oldHash, row.policy_signature],
  );
  const retainedSources = (
    await h.db.query("SELECT fact_key,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key")
  ).rows.map((source) => ({ factKey: source.fact_key, documentHash: source.document_hash }));
  const replaceBinding = (authorization) => {
    if (bindingMode === "unbound") delete authorization.identityEvidence;
    else {
      authorization.identityEvidence.normalizationHashes = authorization.identityEvidence.normalizationHashes
        .map((hash) => (hash === row.document_hash ? oldHash : hash))
        .sort();
      if (bindingMode === "exact")
        authorization.identityEvidence.normalizationSources = (
          authorization.identityEvidence.normalizationSources ??
          retainedSources.filter((source) =>
            authorization.identityEvidence.normalizationHashes.includes(source.documentHash),
          )
        ).map((source) => (source.factKey === row.fact_key ? { ...source, documentHash: oldHash } : source));
      else delete authorization.identityEvidence.normalizationSources;
    }
  };
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  replaceBinding(frozen.identityAuthorization);
  await h.db.query(
    "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
    [publication.snapshotId, JSON.stringify(frozen), comparisonHash(frozen)],
  );
  const capture = {
    input: frozen.frozen,
    scope: frozen.engineScope,
    policies: frozen.policies.map((entry) => entry.policy),
    aggregates: frozen.policies.map((entry) =>
      components.metrics.aggregateMetric(frozen.frozen, entry.policy, frozen.engineScope),
    ),
    snapshot: { snapshotId: publication.snapshotId, revision: publication.revision },
    authorization: frozen.identityAuthorization,
  };
  const before = new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).document;
  const explanation = buildAggregateExplanation(capture, {
    scopeKey: before.scopeKey,
    computationVersion: before.snapshot.computationVersion,
  });
  const explanationHash = comparisonHash(explanation);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
    .run(JSON.stringify(explanation), explanationHash, publication.snapshotId);
  const oldInput = h.controlsStore.db
    .prepare("SELECT * FROM policy_preview_inputs WHERE id=?")
    .get(publication.comparisonInput.inputId);
  const input = JSON.parse(oldInput.document);
  replaceBinding(input.authorization);
  const inputId = comparisonHash(input);
  h.controlsStore.db
    .prepare("UPDATE policy_preview_inputs SET id=?,document=?,digest=? WHERE id=?")
    .run(inputId, JSON.stringify(input), inputId, oldInput.id);
  const receipt = (
    await h.db.query("SELECT receipt_id,document FROM leaderboard_pipeline.receipts WHERE kind='snapshot_published'")
  ).rows.find((entry) => entry.document.snapshotId === publication.snapshotId);
  receipt.document.comparisonInputHash = comparisonHash(capture);
  await h.db.query("UPDATE leaderboard_pipeline.receipts SET document=$2::jsonb,document_hash=$3 WHERE receipt_id=$1", [
    receipt.receipt_id,
    JSON.stringify(receipt.document),
    comparisonHash(receipt.document),
  ]);
  h.controlsStore.transaction((state) => {
    for (const confirmation of [
      state.pipelinePublications[publication.snapshotId],
      ...Object.values(state.pipelineHeads),
    ]) {
      if (confirmation.snapshotId !== publication.snapshotId) continue;
      if (legacyVersion) confirmation.reviewSourceNormalizationVersion = legacyVersion;
      else delete confirmation.reviewSourceNormalizationVersion;
      confirmation.aggregateExplanationHash = explanationHash;
    }
  });
  assert.equal(new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).digest, explanationHash);
  assert.equal(h.runtime.policyComparisons.comparisons.input(inputId).id, inputId);
  return {
    factKey: row.fact_key,
    signature,
    document,
    documentHash: oldHash,
    inputId,
    authorization: input.authorization,
  };
}

async function restart(h, work) {
  await h.runtime.stop();
  h.controlsStore.close();
  // The common harness cleanup also closes its original handle.
  h.controlsStore.close = () => {};
  await h.reopenDatabase();
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const runtime = await createPipeline({ ...h.options, controlsStore });
  try {
    await work(runtime, controlsStore);
  } finally {
    await runtime.stop();
    controlsStore.close();
  }
}

test("legacy review authority and cache generations are denied across actual PostgreSQL/SQLite reopen, then recover from verified sources", async (t) => {
  for (const bindingMode of ["exact", "hash-only", "unbound"])
    await t.test(bindingMode, async (t) => {
      const h = await reviewHarness(t);
      const cutoff = clock();
      const first = (await h.runtime.runOnce({ cutoff })).publications[0];
      await assertMetrics(h.runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
      await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
      const legacy = await retainLegacyReview(h, first, bindingMode);
      const before = (
        await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [first.snapshotId])
      ).rows[0];
      // An unrelated PR in an otherwise complete cohort formerly supplied an
      // earlier first-participation/round time. The target observation is unchanged.
      h.state.cohort = [
        {
          ...structuredClone(h.state.review),
          id: 50,
          node_id: "PRR_SYNTHETIC_50",
          submitted_at: ago(3),
          html_url: `https://github.com/${slug}/pull/999#pullrequestreview-50`,
        },
        structuredClone(h.state.review),
      ];
      const hydrations = h.state.hydrations;
      await restart(h, async (runtime, controlsStore) => {
        await assertDenied(runtime, first.snapshotId);
        await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), /policy_input_revoked/);
        await assert.rejects(
          runtime.aggregateExplanations.read(first.snapshotId),
          /Frozen review (normalization obsolete|evidence unavailable)/,
        );
        const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
        await assert.rejects(
          runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
            assert.fail("legacy private input gained authority"),
          ),
          /Frozen review (normalization obsolete|evidence unavailable)/,
        );
        // A current-version public confirmation alone cannot upgrade old inputs.
        controlsStore.transaction((state) => {
          state.pipelinePublications[first.snapshotId].reviewSourceNormalizationVersion = version;
          Object.values(state.pipelineHeads).forEach((head) => {
            head.reviewSourceNormalizationVersion = version;
          });
        });
        await assertDenied(runtime, first.snapshotId);
        const rebuilt = (await runtime.runOnce({ cutoff })).publications[0];
        assert.notEqual(rebuilt.snapshotId, first.snapshotId);
        assert.ok(
          h.state.hydrations > hydrations,
          "the unchanged review observation must be hydrated under the new semantics",
        );
        assert.equal(
          (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n,
          1,
        );
        await assertMetrics(runtime, { prs_reviewed: 0, review_rounds: 0, review_feedback: 1 });
        await assertMetrics(runtime, { prs_reviewed: 0, review_rounds: 0, review_feedback: 1 }, rebuilt.snapshotId);
        await assertDenied(runtime, first.snapshotId, { current: false });
        await runtime.previewPolicy(previewRequest(h, rebuilt.snapshotId));
        await runtime.aggregateExplanations.read(rebuilt.snapshotId);
        const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
          .rows;
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.find((row) => row.policy_signature === legacy.signature).document, legacy.document);
        assert.equal(rows.find((row) => row.policy_signature === legacy.signature).document_hash, legacy.documentHash);
        const current = rows.find((row) => row.policy_signature !== legacy.signature);
        assert.equal(current.policy_signature, comparisonHash([version, currentSignature(h.config)]));
        assert.equal(current.document.reviewSourceNormalizationVersion, version);
        assert.equal(
          current.document.facts.some((fact) => ["prs_reviewed", "review_rounds"].includes(fact.metricId)),
          false,
        );
        assert.deepEqual(
          (
            await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
              first.snapshotId,
            ])
          ).rows[0],
          before,
        );

        // A corrected, newly observed source can recover credit; the old pin
        // remains withheld after the current view advances.
        h.state.cohort = null;
        h.state.review.body = "Synthetic corrected source observation";
        const recovered = (await runtime.runOnce()).publications[0];
        await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
        await runtime.previewPolicy(previewRequest(h, recovered.snapshotId));
        await assertDenied(runtime, first.snapshotId, { current: false });
      });
    });
});

for (const oldVersion of ["review-source-identity/v1", "review-source-identity/v2"])
  test(`${oldVersion} authority is retained unchanged and withheld until a scan-bound sequence is recomputed`, async (t) => {
    const h = await reviewHarness(t, { sequenceObservation: true });
    const first = (await h.runtime.runOnce()).publications[0];
    await assertMetrics(h.runtime, { first_reviews: 1 });
    const legacy = await retainLegacyReview(h, first, "exact", oldVersion);
    const hydrations = h.state.hydrations;
    await restart(h, async (runtime) => {
      await assertDenied(runtime, first.snapshotId);
      assert.equal(
        (await runtime.app.inject(`/api/v1/boards?metric=first_reviews&snapshot=${first.snapshotId}`)).statusCode,
        410,
      );
      assert.equal(
        (await runtime.app.inject(`/api/v1/contributors/303?metric=first_reviews&snapshot=${first.snapshotId}`))
          .statusCode,
        410,
      );
      const rebuilt = (await runtime.runOnce()).publications[0];
      assert.notEqual(rebuilt.snapshotId, first.snapshotId);
      assert.ok(h.state.hydrations > hydrations);
      await assertDenied(runtime, first.snapshotId, { current: false });
      await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1, first_reviews: 1 });
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
        .rows;
      assert.equal(rows.length, 2);
      const retained = rows.find((row) => row.policy_signature === legacy.signature);
      assert.deepEqual(retained.document, legacy.document);
      assert.equal(retained.document_hash, legacy.documentHash);
      const current = rows.find((row) => row.policy_signature !== legacy.signature);
      assert.equal(current.document.reviewSourceNormalizationVersion, version);
      const firstFacts = current.document.facts.filter((fact) => fact.metricId === "first_reviews");
      assert.equal(firstFacts.length, 1);
      assert.equal(firstFacts[0].actorId, "303");
      assert.equal(firstFacts[0].occurredAt, h.state.review.submitted_at);
    });
  });

test("retained nonreview publications keep their cache generation, public exports and private comparison across restart", async (t) => {
  const h = await harness(t, { authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
  const before = await Promise.all(paths("issues_opened").map(async (path) => (await h.runtime.app.inject(path)).body));
  const privateBefore = await h.runtime.previewPolicy(previewRequest(h, publication.snapshotId));
  const normalizations = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.ok(normalizations.every((row) => row.policy_signature === currentSignature(h.config)));
  assert.ok(normalizations.every((row) => row.document.reviewSourceNormalizationVersion === undefined));
  await restart(h, async (runtime) => {
    const after = await Promise.all(paths("issues_opened").map(async (path) => (await runtime.app.inject(path)).body));
    assert.deepEqual(after, before);
    assert.deepEqual(await runtime.previewPolicy(previewRequest(h, publication.snapshotId)), privateBefore);
    const repeated = (await runtime.runOnce({ cutoff })).publications[0];
    assert.equal(repeated.snapshotId, publication.snapshotId);
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
      normalizations,
    );
    // Previous public frozen reads did not depend on retained normalization
    // rows. Removing only that dependency must not disable a nonreview board.
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations");
    for (const path of paths("issues_opened"))
      for (const suffix of ["", `&snapshot=${publication.snapshotId}`])
        assert.equal((await runtime.app.inject(path + suffix)).statusCode, 200, path + suffix);
    const source = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key LIMIT 1"))
      .rows[0];
    await h.db.query(
      `INSERT INTO leaderboard_ingestion.source_facts
       (fact_key,repository_id,family,subject_id,source_revision,document,first_run_id,observed_at)
       VALUES($1,2,'reviews','PRR_SYNTHETIC_LATER','synthetic-later',$2::jsonb,$3,$4)`,
      [
        "f".repeat(64),
        JSON.stringify({ ...source.document, subjectId: "PRR_SYNTHETIC_LATER" }),
        source.first_run_id,
        clock(),
      ],
    );
    for (const path of paths("issues_opened"))
      assert.equal((await runtime.app.inject(`${path}&snapshot=${publication.snapshotId}`)).statusCode, 200);
  });
});

test("custom review providers must explicitly assert the corrected semantics before receiving a cache version", async (t) => {
  for (const mode of ["normalizer", "enrichment"])
    await t.test(mode, async (t) => {
      let h;
      let calls = 0;
      const extra =
        mode === "normalizer"
          ? {
              normalizer: async () => {
                calls++;
                return { facts: [], actors: [], evidence: [] };
              },
            }
          : {
              githubEnrich: async (input) => {
                calls++;
                return {
                  repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
                  proof: {
                    verified: true,
                    source: "github_rest",
                    revision: input.fact.sourceRevision,
                    isSynthetic: true,
                  },
                  family: "review",
                  observedAt: input.observedAt,
                  payload: { pull_request: structuredClone(h.state.parent), review: structuredClone(h.state.review) },
                  reviewParticipation: {
                    verified: true,
                    firstSubmittedAt: h.state.review.submitted_at,
                    roundFirstSubmittedAt: h.state.review.submitted_at,
                  },
                };
              },
            };
      h = await reviewHarness(t, extra);
      await assert.rejects(h.runtime.runOnce(), /review_normalizer_version_unverified/);
      assert.equal(calls, 0);
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n,
        0,
      );
      const checked = await createPipeline({ ...h.options, reviewSourceNormalizationVersion: version });
      try {
        assert.equal((await checked.runOnce()).state, "published");
        assert.equal(calls, 1);
        assert.equal(
          h.state.hydrations,
          0,
          "the enriched provider actually supplies the envelope instead of REST hydration",
        );
        assert.equal(
          (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows[0].document
            .reviewSourceNormalizationVersion,
          version,
        );
        if (mode === "enrichment")
          await assertMetrics(checked, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
      } finally {
        await checked.stop();
      }
    });
});

test("current and pinned review reads bind each actual frozen input to its selected snapshot and confirmed head", async (t) => {
  const h = await reviewHarness(t);
  const first = (await h.runtime.runOnce()).publications[0];
  h.state.review.body = "Synthetic newer review observation";
  const head = (await h.runtime.runOnce()).publications[0];
  assert.notEqual(first.snapshotId, head.snapshotId);
  const saved = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
  ).rows[0];
  const replace = (snapshotId, document, hash = comparisonHash(document)) =>
    h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [snapshotId, JSON.stringify(document), hash],
    );
  for (const change of [
    (document) => {
      document.scope = { ...publicScope, repository: "2" };
    },
    (document) => {
      document.frozen.datasetId = "synthetic-other-dataset";
    },
    (document) => {
      document.frozen.cutoff = ago(1);
    },
    (document) => {
      document.frozen.backfillRevision = "f".repeat(64);
    },
    (document) => {
      document.identityAuthorization.identityEvidence.normalizationSources[0].factKey = "e".repeat(64);
    },
    (document) => {
      document.identityAuthorization.sources[0].generation = "999";
    },
  ]) {
    const corrupt = structuredClone(saved.document);
    change(corrupt);
    await replace(first.snapshotId, corrupt);
    await assert.rejects(
      h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal),
      /public_review_frozen_input_integrity_error/,
    );
    await assertMetrics(h.runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
    for (const path of paths("prs_reviewed")) {
      const response = await h.runtime.app.inject(`${path}&snapshot=${first.snapshotId}`);
      assert.notEqual(response.statusCode, 200, path);
      assert.doesNotMatch(response.body, /synthetic-303|normalizationSources/);
    }
    await replace(first.snapshotId, saved.document, saved.document_hash);
  }
  // A valid selected historical view cannot bypass an invalid current head.
  const headSaved = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [head.snapshotId])
  ).rows[0];
  await replace(head.snapshotId, saved.document, headSaved.document_hash);
  await assert.rejects(
    h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal),
    /public_review_frozen_input_integrity_error/,
  );
  await replace(head.snapshotId, headSaved.document, headSaved.document_hash);
  await assertMetrics(h.runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 }, first.snapshotId);
});

test("a committed dispatch cannot acknowledge obsolete review authority after restart or rewind a verified recovery", async (t) => {
  const h = await reviewHarness(t, { includeIssue: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertOperatorDelivery(h, 701, h.issue.created_at);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic loss before acknowledgment");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic loss before acknowledgment");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic loss before acknowledgment/);
  const saved = (await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.snapshots")).rows[0];
  const input = h.controlsStore.db
    .prepare("SELECT id,document FROM policy_preview_inputs")
    .all()
    .find((row) => JSON.parse(row.document).snapshot.snapshotId === saved.snapshot_id);
  const first = {
    snapshotId: saved.snapshot_id,
    revision: Number(saved.revision),
    comparisonInput: { inputId: input.id },
  };
  await retainLegacyReview(h, first, "exact");
  const operation = (await h.db.query("SELECT event_key,operation FROM leaderboard_ingestion.outbox")).rows[0];
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  await restart(h, async (runtime) => {
    await assertDenied(runtime, first.snapshotId);
    assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
    const pending = (
      await h.db.query("SELECT state,completion,operation FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
        operation.event_key,
      ])
    ).rows[0];
    assert.equal(pending.state, "pending");
    assert.equal(pending.completion, null);
    assert.deepEqual(pending.operation, operation.operation);
    await assertDenied(runtime, first.snapshotId);
    const recovery = (await runtime.runOnce()).publications[0];
    assert.notEqual(recovery.snapshotId, first.snapshotId);
    await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
    await assertDenied(runtime, first.snapshotId, { current: false });
    await h.db.query(
      "UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()+interval '1 hour' WHERE event_key=$1",
      [operation.event_key],
    );
    await insertOperatorDelivery({ ...h, runtime }, 702, h.issue.created_at);
    assert.equal(await runtime.inbox.complete(await runtime.inbox.claim()), true);
    assert.equal(await runtime.dispatchOnce(), "processed");
    const done = (await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox WHERE state='done'")).rows[0];
    assert.ok(done.completion.publications.every((publication) => publication.snapshotId !== first.snapshotId));
    await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
    await assertDenied(runtime, first.snapshotId, { current: false });
  });
});
