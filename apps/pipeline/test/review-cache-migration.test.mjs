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
import { assertRetainedSourceGeneration } from "./transfer-cache-generation-fixtures.mjs";

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
const currentSignature = (config) =>
  comparisonHash([
    "pipeline-issue-transfer/v1",
    comparisonHash(["github-issue-transfer-admission/v1", projectSignature(config, "project-membership-context/v2")]),
  ]);

test("pre-transfer versioned review caches keep frozen public and private authority after restart", async (t) => {
  const h = await reviewHarness(t);
  await assertRetainedSourceGeneration({
    h,
    priorSignature: comparisonHash([version, legacySignature(h.config)]),
    request: previewRequest,
    assertPublic: (runtime, snapshot) =>
      assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 }, snapshot),
    restart,
  });
});

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
      if (extra.selectRelease)
        config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }];
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

for (const defaultWrapper of [false, true]) {
  test(`selected release review migration reads its ${defaultWrapper ? "empty default" : "plain"} Projectv2 predecessor before hydration`, async (t) => {
    const h = await reviewHarness(t, { selectRelease: true });
    const cutoff = clock();
    await h.runtime.runOnce({ cutoff });
    const currentBase = comparisonHash([
      version,
      comparisonHash(["github-release-inclusion/v1", currentSignature(h.config), h.config.releaseInclusionTargets]),
    ]);
    const predecessorBase = comparisonHash([version, projectSignature(h.config, "project-membership-context/v2")]);
    const deliveryVersion = "default-delivery-scope/v1";
    assert.equal(components.github.defaultDeliveryNormalizationVersion, deliveryVersion);
    const predecessorSignature = defaultWrapper ? comparisonHash([deliveryVersion, predecessorBase]) : predecessorBase;
    const expectedSignature = defaultWrapper ? comparisonHash([deliveryVersion, currentBase]) : currentBase;
    const row = (
      await h.db.query(
        `SELECT n.* FROM leaderboard_pipeline.normalizations n
         JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='reviews'`,
      )
    ).rows[0];
    assert.equal(row.policy_signature, currentBase);
    const document = structuredClone(row.document);
    if (defaultWrapper) {
      // The old key, not a positive fact, must retain the delivery-generation hint.
      document.facts = [];
      document.actors = [];
      document.evidence = [];
      document.defaultDeliveryNormalizationVersion = deliveryVersion;
    }
    const documentHash = comparisonHash(document);
    const sourceBefore = (
      await h.db.query(
        "SELECT fact_key,source_revision,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
      )
    ).rows;
    await h.db.query(
      `UPDATE leaderboard_pipeline.normalizations
       SET policy_signature=$2,document=$3::jsonb,document_hash=$4
       WHERE fact_key=$1 AND policy_signature=$5`,
      [row.fact_key, predecessorSignature, JSON.stringify(document), "0".repeat(64), row.policy_signature],
    );
    const hydrations = h.state.hydrations;
    await restart(h, async (runtime) => {
      const query = h.db.query;
      const lookups = [];
      h.db.query = async (sql, values) => {
        const result = await query.call(h.db, sql, values);
        if (
          sql.includes("FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=ANY") &&
          values[0] === row.fact_key
        )
          lookups.push({
            selected: [...values[1]],
            returned: result.rows.map((entry) => entry.policy_signature),
            hydrations: h.state.hydrations,
          });
        return result;
      };
      try {
        await assert.rejects(runtime.runOnce({ cutoff }), /normalization_integrity_error/);
        assert.equal(h.state.hydrations, hydrations, "corrupt predecessor must fail before native source hydration");
        assert.ok(
          lookups.some(
            (entry) => entry.selected.includes(predecessorSignature) && entry.returned.includes(predecessorSignature),
          ),
          "the actual SQL candidate query must read the persisted predecessor",
        );
        await h.db.query(
          "UPDATE leaderboard_pipeline.normalizations SET document_hash=$3 WHERE fact_key=$1 AND policy_signature=$2",
          [row.fact_key, predecessorSignature, documentHash],
        );
        lookups.length = 0;
        assert.equal((await runtime.runOnce({ cutoff })).state, "published");
        assert.equal(h.state.hydrations, hydrations + 1, "predecessor supplies identity and hints, never fresh facts");
        assert.ok(
          lookups.some(
            (entry) =>
              entry.selected.includes(predecessorSignature) &&
              entry.returned.includes(predecessorSignature) &&
              entry.hydrations === hydrations,
          ),
          "restored predecessor must be read before fresh native hydration",
        );
        const rows = (
          await h.db.query(
            "SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1",
            [row.fact_key],
          )
        ).rows;
        assert.equal(rows.length, 2);
        assert.deepEqual(
          rows.find((entry) => entry.policy_signature === predecessorSignature),
          {
            policy_signature: predecessorSignature,
            document,
            document_hash: documentHash,
          },
        );
        const current = rows.find((entry) => entry.policy_signature === expectedSignature);
        assert.ok(current, "current release-wrapped generation must preserve any retained default hint");
        assert.equal(current.document.reviewSourceNormalizationVersion, version);
        assert.equal(
          current.document.defaultDeliveryNormalizationVersion,
          defaultWrapper ? deliveryVersion : undefined,
        );
        assert.equal(current.document_hash, comparisonHash(current.document));
        await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
        assert.deepEqual(
          (
            await h.db.query(
              "SELECT fact_key,source_revision,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
            )
          ).rows,
          sourceBefore,
        );
      } finally {
        h.db.query = query;
      }
    });
  });
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
  for (const sourceGeneration of ["current", "Projectv2"])
    for (const defaultWrapper of [false, true])
      test(`obsolete ${oldVersion} ${sourceGeneration} ${defaultWrapper ? "empty default" : "plain"} cache supplies only a validated migration hint`, async (t) => {
        const h = await reviewHarness(t, { selectRelease: true });
        const cutoff = clock();
        await h.runtime.runOnce({ cutoff });
        const currentSource = comparisonHash([
          "github-release-inclusion/v1",
          currentSignature(h.config),
          h.config.releaseInclusionTargets,
        ]);
        const currentBase = comparisonHash([version, currentSource]);
        const precedingBase = comparisonHash([
          oldVersion,
          sourceGeneration === "current" ? currentSource : projectSignature(h.config, "project-membership-context/v2"),
        ]);
        const deliveryVersion = "default-delivery-scope/v1";
        const precedingSignature = defaultWrapper ? comparisonHash([deliveryVersion, precedingBase]) : precedingBase;
        const expectedSignature = defaultWrapper ? comparisonHash([deliveryVersion, currentBase]) : currentBase;
        const original = (
          await h.db.query(
            `SELECT n.* FROM leaderboard_pipeline.normalizations n
             JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='reviews'`,
          )
        ).rows[0];
        assert.equal(original.policy_signature, currentBase);
        // Explicitly reconstructed older review namespace. The empty delivery
        // case proves that the key itself must carry the migration hint.
        const document = structuredClone(original.document);
        document.reviewSourceNormalizationVersion = oldVersion;
        if (defaultWrapper) {
          document.facts = [];
          document.actors = [];
          document.evidence = [];
          document.defaultDeliveryNormalizationVersion = deliveryVersion;
        }
        const documentHash = comparisonHash(document);
        await h.db.query(
          `UPDATE leaderboard_pipeline.normalizations
           SET policy_signature=$2,document=$3::jsonb,document_hash=$4
           WHERE fact_key=$1 AND policy_signature=$5`,
          [original.fact_key, precedingSignature, JSON.stringify(document), "0".repeat(64), original.policy_signature],
        );
        const sourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key"))
          .rows;
        await restart(h, async (runtime) => {
          const hydrations = h.state.hydrations;
          const query = h.db.query;
          const reads = [];
          h.db.query = async (sql, values) => {
            const result = await query.call(h.db, sql, values);
            if (
              sql.includes("FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=ANY") &&
              values[0] === original.fact_key
            )
              reads.push({ keys: result.rows.map((row) => row.policy_signature), hydrations: h.state.hydrations });
            return result;
          };
          try {
            await assert.rejects(runtime.runOnce({ cutoff }), /normalization_integrity_error/);
            assert.equal(h.state.hydrations, hydrations, "old review integrity is checked before native hydration");
            assert.ok(reads.some((read) => read.keys.includes(precedingSignature) && read.hydrations === hydrations));
            await h.db.query(
              "UPDATE leaderboard_pipeline.normalizations SET document_hash=$3 WHERE fact_key=$1 AND policy_signature=$2",
              [original.fact_key, precedingSignature, documentHash],
            );
            await runtime.runOnce({ cutoff });
            assert.equal(h.state.hydrations, hydrations + 1, "old review facts are never a current cache hit");
            const rows = (
              await h.db.query(
                "SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1",
                [original.fact_key],
              )
            ).rows;
            assert.equal(rows.length, 2);
            assert.deepEqual(
              rows.find((row) => row.policy_signature === precedingSignature),
              {
                policy_signature: precedingSignature,
                document,
                document_hash: documentHash,
              },
            );
            const current = rows.find((row) => row.policy_signature === expectedSignature);
            assert.ok(current, "the current version preserves the validated historical delivery hint");
            assert.equal(current.document.reviewSourceNormalizationVersion, version);
            assert.equal(
              current.document.defaultDeliveryNormalizationVersion,
              defaultWrapper ? deliveryVersion : undefined,
            );
            await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
            assert.deepEqual(
              (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
              sourceRows,
            );
            // A valid v3 current cache must not hide corruption in an old key.
            await h.db.query(
              "UPDATE leaderboard_pipeline.normalizations SET document_hash=$3 WHERE fact_key=$1 AND policy_signature=$2",
              [original.fact_key, precedingSignature, "0".repeat(64)],
            );
            await assert.rejects(runtime.runOnce({ cutoff }), /normalization_integrity_error/);
            assert.equal(h.state.hydrations, hydrations + 1);
          } finally {
            h.db.query = query;
          }
        });
      });

for (const oldVersion of ["review-source-identity/v1", "review-source-identity/v2"])
  for (const keepCurrent of [false, true])
    test(`coexisting obsolete ${oldVersion} plain/default review caches both validate with current v3=${keepCurrent}`, async (t) => {
      const h = await reviewHarness(t, { selectRelease: true });
      const cutoff = clock();
      const first = (await h.runtime.runOnce({ cutoff })).publications[0];
      const currentSource = comparisonHash([
        "github-release-inclusion/v1",
        currentSignature(h.config),
        h.config.releaseInclusionTargets,
      ]);
      const currentBase = comparisonHash([version, currentSource]);
      const oldBase = comparisonHash([oldVersion, currentSource]);
      const deliveryVersion = "default-delivery-scope/v1";
      const oldDefault = comparisonHash([deliveryVersion, oldBase]);
      const currentDefault = comparisonHash([deliveryVersion, currentBase]);
      const original = (
        await h.db.query(
          `SELECT n.* FROM leaderboard_pipeline.normalizations n
           JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='reviews'`,
        )
      ).rows[0];
      assert.equal(original.policy_signature, currentBase);
      // Reconstructed obsolete namespaces deliberately coexist for one source.
      // The valid default row must not hide corruption in the retained plain row.
      const plain = { ...structuredClone(original.document), reviewSourceNormalizationVersion: oldVersion };
      const delivery = {
        ...structuredClone(plain),
        facts: [],
        actors: [],
        evidence: [],
        defaultDeliveryNormalizationVersion: deliveryVersion,
      };
      const predecessors = [
        { policy_signature: oldBase, document: plain, document_hash: comparisonHash(plain) },
        { policy_signature: oldDefault, document: delivery, document_hash: comparisonHash(delivery) },
      ];
      for (const row of predecessors)
        await h.db.query(
          "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
          [original.fact_key, row.policy_signature, JSON.stringify(row.document), row.document_hash],
        );
      if (!keepCurrent)
        await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
          original.fact_key,
          currentBase,
        ]);
      const setHash = (signature, hash) =>
        h.db.query(
          "UPDATE leaderboard_pipeline.normalizations SET document_hash=$3 WHERE fact_key=$1 AND policy_signature=$2",
          [original.fact_key, signature, hash],
        );
      const sourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
      const frozenRows = (
        await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
      ).rows;
      await setHash(oldBase, "0".repeat(64));
      await restart(h, async (runtime) => {
        const hydrations = h.state.hydrations;
        const query = h.db.query;
        const reads = [];
        h.db.query = async (sql, values) => {
          const result = await query.call(h.db, sql, values);
          if (
            sql.includes("FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=ANY") &&
            values[0] === original.fact_key
          )
            reads.push({ keys: result.rows.map((row) => row.policy_signature), hydrations: h.state.hydrations });
          return result;
        };
        try {
          await assert.rejects(runtime.runOnce({ cutoff }), /normalization_integrity_error/);
          assert.equal(h.state.hydrations, hydrations);
          assert.ok(
            reads.some(
              (read) =>
                read.keys.includes(oldBase) &&
                read.keys.includes(oldDefault) &&
                read.keys.includes(currentBase) === keepCurrent &&
                read.hydrations === hydrations,
            ),
            "both obsolete forms are read before hydration, even with a valid current cache",
          );
          await setHash(oldBase, predecessors[0].document_hash);
          await runtime.runOnce({ cutoff });
          assert.equal(h.state.hydrations, hydrations + 1);
          const rows = (
            await h.db.query(
              "SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1",
              [original.fact_key],
            )
          ).rows;
          for (const predecessor of predecessors)
            assert.deepEqual(
              rows.find((row) => row.policy_signature === predecessor.policy_signature),
              predecessor,
            );
          const current = rows.find((row) => row.policy_signature === currentDefault);
          assert.ok(current, "the valid historical default key still supplies the migration hint");
          assert.equal(current.document.reviewSourceNormalizationVersion, version);
          assert.equal(current.document.defaultDeliveryNormalizationVersion, deliveryVersion);
          assert.deepEqual(
            (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
            sourceRows,
          );
          assert.deepEqual(
            (
              await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
                first.snapshotId,
              ])
            ).rows,
            frozenRows,
          );
          // Each retained form remains checked when a valid current default cache exists.
          for (const predecessor of predecessors) {
            await setHash(predecessor.policy_signature, "0".repeat(64));
            await assert.rejects(runtime.runOnce({ cutoff }), /normalization_integrity_error/);
            assert.equal(h.state.hydrations, hydrations + 1);
            await setHash(predecessor.policy_signature, predecessor.document_hash);
          }
          await runtime.runOnce({ cutoff });
          assert.equal(h.state.hydrations, hydrations + 1, "valid current v3 output can still be reused");
          await assertMetrics(runtime, { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 });
        } finally {
          h.db.query = query;
        }
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

const reviewProviderUnavailable = /review_normalizer_version_unverified/;
const currentReviewMetrics = { prs_reviewed: 1, review_rounds: 1, review_feedback: 1 };
const reviewCaches = async (h) =>
  (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
const reviewSnapshots = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
async function assertNoReviewPublication(h) {
  assert.deepEqual(await reviewCaches(h), []);
  assert.deepEqual(await reviewSnapshots(h), []);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
}
const removeReviewCompatibility = (h, mode) => {
  delete h.options[mode === "normalizer" ? "normalizer" : "githubEnrich"];
  delete h.options.reviewSourceNormalizationVersion;
};
async function selectedReviewProvider(t, mode, after = async () => {}) {
  let h;
  const selected = { calls: 0 };
  const extra =
    mode === "normalizer"
      ? {
          normalizerFactory(options) {
            const native = components.github.createGithubEvidenceNormalizer({
              client: options.githubClient,
              source: options.sourceId,
              allowedRepositoryIds: [2],
              isSynthetic: true,
              // Fixture authority; the enclosing runtime checks its live authorization.
              assertAuthorized: () => assert.equal(options.dataMode, "synthetic"),
            });
            return async (input) => {
              selected.calls++;
              const output = await native(input);
              await after(h, input, output);
              return output;
            };
          },
        }
      : {
          githubEnrich: async (input) => {
            selected.calls++;
            const output = {
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
            await after(h, input, output);
            return output;
          },
        };
  h = await reviewHarness(t, { memoryDatabase: true, reviewSourceNormalizationVersion: version, ...extra });
  return { h, selected };
}
function afterReviewTransaction(h, predicate, after) {
  const transaction = h.db.transaction;
  h.db.transaction = async (work) => {
    let matched = false;
    const result = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          matched ||= predicate(sql);
          return value;
        },
      }),
    );
    if (matched) after();
    return result;
  };
}

test("retained review callbacks cannot borrow built-in compatibility after their options are removed", async (t) => {
  for (const mode of ["normalizer", "enrichment"])
    await t.test(mode, async (subtest) => {
      const { h, selected } = await selectedReviewProvider(subtest, mode);
      removeReviewCompatibility(h, mode);
      await assert.rejects(h.runtime.runOnce(), reviewProviderUnavailable);
      assert.equal(selected.calls, 0);
      await assertNoReviewPublication(h);
      // The selected callback is still retained even though its option is absent.
      h.options.reviewSourceNormalizationVersion = version;
      assert.equal((await h.runtime.runOnce()).state, "published");
      assert.equal(selected.calls, 1);
      await assertMetrics(h.runtime, currentReviewMetrics);
    });
});

test("review compatibility lost across the actual provider await cannot certify its returned facts", async (t) => {
  for (const mode of ["normalizer", "enrichment"])
    await t.test(mode, async (subtest) => {
      const { h, selected } = await selectedReviewProvider(subtest, mode, async (current) => {
        await Promise.resolve();
        removeReviewCompatibility(current, mode);
      });
      await assert.rejects(h.runtime.runOnce(), reviewProviderUnavailable);
      assert.equal(selected.calls, 1);
      assert.equal(h.state.hydrations, mode === "normalizer" ? 1 : 0);
      await assertNoReviewPublication(h);
    });
});

test("review source-lock and dependency awaits cannot commit a newly uncertified normalization", async (t) => {
  for (const [boundary, mode] of [
    ["source lock", "normalizer"],
    ["source artifact dependency", "enrichment"],
  ])
    await t.test(boundary, async (subtest) => {
      let armed = false,
        changed = false;
      const { h, selected } = await selectedReviewProvider(subtest, mode, async () => {
        armed = true;
      });
      const transaction = h.db.transaction;
      h.db.transaction = (work) =>
        transaction((tx) =>
          work({
            query: async (sql, params) => {
              const value = await tx.query(sql, params);
              if (
                armed &&
                (boundary === "source lock"
                  ? sql.includes("leaderboard_ingestion.repository_access") && /FOR UPDATE/.test(sql)
                  : /INSERT\s+INTO\s+leaderboard_pipeline\.source_artifacts/i.test(sql))
              ) {
                removeReviewCompatibility(h, mode);
                armed = false;
                changed = true;
              }
              return value;
            },
          }),
        );
      await assert.rejects(h.runtime.runOnce(), reviewProviderUnavailable);
      assert.equal(changed, true, "the intended awaited boundary was actually reached");
      assert.equal(selected.calls, 1);
      await assertNoReviewPublication(h);
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.source_artifacts")).rows[0].n,
        0,
        "dependency retention and the new cache roll back together",
      );
    });
});

test("a review candidate lookup cannot reuse a cache after its selected provider loses compatibility", async (t) => {
  const { h, selected } = await selectedReviewProvider(t, "normalizer");
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const beforeCaches = await reviewCaches(h),
    beforeSnapshots = await reviewSnapshots(h),
    beforeControls = h.controlsStore.read();
  assert.equal(selected.calls, 1);
  let changed = false;
  const query = h.db.query;
  h.db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (
      !changed &&
      sql.startsWith("SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations")
    ) {
      removeReviewCompatibility(h, "normalizer");
      changed = true;
    }
    return result;
  };
  await assert.rejects(h.runtime.runOnce({ cutoff }), reviewProviderUnavailable);
  assert.equal(changed, true);
  assert.equal(selected.calls, 1);
  assert.deepEqual(await reviewCaches(h), beforeCaches);
  assert.deepEqual(await reviewSnapshots(h), beforeSnapshots);
  assert.deepEqual(h.controlsStore.read().pipelinePublications, beforeControls.pipelinePublications);
  assert.deepEqual(h.controlsStore.read().pipelineHeads, beforeControls.pipelineHeads);
  // A live producer declaration is not retroactive authority over an immutable,
  // already-confirmed snapshot whose retained proofs remain intact.
  await assertMetrics(h.runtime, currentReviewMetrics, first.snapshotId);
  h.options.reviewSourceNormalizationVersion = version;
  assert.equal((await h.runtime.runOnce({ cutoff })).state, "published");
  assert.equal(selected.calls, 1);
  assert.deepEqual(await reviewCaches(h), beforeCaches);
});

test("a cached review result is withheld after its dependency transaction loses compatibility", async (t) => {
  const { h, selected } = await selectedReviewProvider(t, "enrichment");
  const cutoff = clock();
  await h.runtime.runOnce({ cutoff });
  const beforeCaches = await reviewCaches(h),
    beforeSnapshots = await reviewSnapshots(h),
    beforeControls = h.controlsStore.read();
  let changed = false;
  afterReviewTransaction(
    h,
    (sql) =>
      sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") && sql.includes("FOR UPDATE"),
    () => {
      if (changed) return;
      changed = true;
      removeReviewCompatibility(h, "enrichment");
    },
  );
  await assert.rejects(h.runtime.runOnce({ cutoff }), reviewProviderUnavailable);
  assert.equal(changed, true);
  assert.equal(selected.calls, 1);
  assert.equal(h.state.hydrations, 0);
  assert.deepEqual(await reviewCaches(h), beforeCaches);
  assert.deepEqual(await reviewSnapshots(h), beforeSnapshots);
  assert.deepEqual(h.controlsStore.read().pipelinePublications, beforeControls.pipelinePublications);
  assert.deepEqual(h.controlsStore.read().pipelineHeads, beforeControls.pipelineHeads);
});

test("an unconfirmed SQL review publication requires restored compatibility before same-cutoff recovery", async (t) => {
  const { h, selected } = await selectedReviewProvider(t, "normalizer");
  const cutoff = clock();
  let changed = false;
  afterReviewTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
    () => {
      if (changed) return;
      changed = true;
      removeReviewCompatibility(h, "normalizer");
    },
  );
  await assert.rejects(h.runtime.runOnce({ cutoff }), reviewProviderUnavailable);
  assert.equal(changed, true);
  const saved = await reviewSnapshots(h),
    savedCaches = await reviewCaches(h);
  assert.equal(saved.length, 1);
  assert.equal(savedCaches.length, 1);
  assert.equal(selected.calls, 1);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.notEqual(
    (await h.runtime.app.inject("/api/v1/boards?metric=prs_reviewed")).statusCode,
    200,
    "a committed SQL row alone cannot grant public visibility",
  );
  h.options.reviewSourceNormalizationVersion = version;
  const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(recovered.snapshotId, saved[0].snapshot_id);
  assert.equal(selected.calls, 1);
  assert.deepEqual(await reviewSnapshots(h), saved);
  assert.deepEqual(await reviewCaches(h), savedCaches);
  await assertMetrics(h.runtime, currentReviewMetrics);
});

test("the synchronous review confirmation checks compatibility inside the visibility transaction", async (t) => {
  const { h, selected } = await selectedReviewProvider(t, "enrichment");
  const cutoff = clock();
  let armed = false,
    changed = false;
  afterReviewTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
    () => {
      armed = true;
    },
  );
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (work) =>
    transaction((state) => {
      if (armed && !changed) {
        changed = true;
        removeReviewCompatibility(h, "enrichment");
      }
      return work(state);
    });
  await assert.rejects(h.runtime.runOnce({ cutoff }), reviewProviderUnavailable);
  assert.equal(changed, true);
  const saved = await reviewSnapshots(h);
  assert.equal(saved.length, 1);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  h.options.reviewSourceNormalizationVersion = version;
  const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(recovered.snapshotId, saved[0].snapshot_id);
  assert.equal(selected.calls, 1);
  assert.deepEqual(await reviewSnapshots(h), saved);
  await assertMetrics(h.runtime, currentReviewMetrics);
});

test("a frozen review retry rechecks the retained provider without recollecting its source", async (t) => {
  const { h, selected } = await selectedReviewProvider(t, "normalizer");
  let pages = 0;
  const readPage = h.options.source.readPage.bind(h.options.source);
  h.options.source.readPage = async (request) => {
    pages++;
    return readPage(request);
  };
  let frozen = false;
  afterReviewTransaction(
    h,
    (sql) => sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff"),
    () => {
      if (frozen) return;
      frozen = true;
      removeReviewCompatibility(h, "normalizer");
      throw new Error("synthetic_stop_after_review_freeze");
    },
  );
  await assert.rejects(h.runtime.runOnce(), /synthetic_stop_after_review_freeze/);
  assert.equal(frozen, true);
  assert.ok(pages > 0);
  const collected = pages;
  assert.equal(selected.calls, 0);
  await assert.rejects(h.runtime.runOnce(), reviewProviderUnavailable);
  assert.equal(pages, collected, "a frozen retry must use the completed collection");
  await assertNoReviewPublication(h);
  h.options.reviewSourceNormalizationVersion = version;
  assert.equal((await h.runtime.runOnce()).state, "published");
  assert.equal(pages, collected);
  assert.equal(selected.calls, 1);
  await assertMetrics(h.runtime, currentReviewMetrics);
});

test("declared review replacement and enrichment preserve native review metrics and source identities", async (t) => {
  for (const mode of ["normalizer", "enrichment"])
    await t.test(mode, async (subtest) => {
      const { h, selected } = await selectedReviewProvider(subtest, mode);
      assert.equal((await h.runtime.runOnce()).state, "published");
      assert.equal(selected.calls, 1);
      assert.equal(h.state.hydrations, mode === "normalizer" ? 1 : 0);
      const saved = await reviewCaches(h);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].document.reviewSourceNormalizationVersion, version);
      for (const metricId of Object.keys(currentReviewMetrics)) {
        const facts = saved[0].document.facts.filter((fact) => fact.metricId === metricId);
        assert.equal(facts.length, 1, metricId);
        assert.equal(facts[0].actorId, "303");
        assert.equal(facts[0].artifactId, "PR_SYNTHETIC_10");
        assert.equal(facts[0].occurredAt, h.state.review.submitted_at);
      }
      await assertMetrics(h.runtime, currentReviewMetrics);
    });
});

test("unused replacement and enrichment options do not reclassify the captured built-in review provider", async (t) => {
  const h = await reviewHarness(t, { memoryDatabase: true });
  let unused = 0;
  for (const name of ["normalizer", "githubEnrich"])
    h.options[name] = async () => {
      unused++;
      throw new Error("unused review provider option");
    };
  assert.equal(h.options.reviewSourceNormalizationVersion, undefined);
  assert.equal((await h.runtime.runOnce()).state, "published");
  assert.equal(unused, 0);
  assert.equal(h.state.hydrations, 1);
  await assertMetrics(h.runtime, currentReviewMetrics);
});

test("configured review collection without review rows does not require an unused provider declaration", async (t) => {
  let calls = 0;
  const h = await reviewHarness(t, {
    memoryDatabase: true,
    normalizer: async () => {
      calls++;
      throw new Error("an empty collection cannot call the review provider");
    },
    source: {
      async readPage(request) {
        assert.equal(request.family, "reviews");
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 0,
          facts: [],
        };
      },
    },
  });
  assert.equal(h.options.reviewSourceNormalizationVersion, undefined);
  assert.equal((await h.runtime.runOnce()).state, "published");
  assert.equal(calls, 0);
  assert.deepEqual(await reviewCaches(h), []);
});
