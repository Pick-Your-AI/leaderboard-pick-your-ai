import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { buildAggregateExplanation, AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { ago, clock, components, harness } from "./harness.mjs";

const version = "default-delivery-scope/v1";
const slug = "synthetic-org/synthetic-repo";
const before = "b".repeat(40);
const after = "c".repeat(40);
const fixture = JSON.parse(
  await readFile(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const deliveryMetrics = [
  "commits_integrated",
  "direct_changes",
  "pr_lines_added",
  "pr_lines_removed",
  "pr_lines_changed",
  "files_changed",
];
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
  comparisonHash(["github-issue-transfer-admission/v1", projectSignature(config, "project-membership-context/v2")]);

async function deliveryHarness(t, family, extra = {}) {
  const sourceFamily = { commit: "commits", pull_request: "pull_requests", issue: "issues" }[family];
  const metric = extra.deliveryMetric ?? (family === "commit" ? "commits_integrated" : "pr_lines_changed");
  const at = ago(1);
  const sourceUrl =
    "https://github.com/" +
    slug +
    (family === "commit" ? "/commit/" + after : family === "pull_request" ? "/pull/10" : "/issues/10");
  const subjectId =
    family === "commit" ? after : family === "pull_request" ? fixture.pull_request.node_id : "I_SYNTHETIC_DELIVERY_10";
  const state = { defaultBranch: "main", revision: after, hydrations: 0 };
  const enrich = async (input) => {
    state.hydrations++;
    let payload;
    if (family === "commit")
      payload = {
        sha: after,
        html_url: sourceUrl,
        author: fixture.author,
        committer: fixture.merger,
        parents: [{ sha: before }],
        commit: { message: "Synthetic default-delivery fixture" },
      };
    else if (family === "pull_request")
      payload = {
        repository: { ...fixture.repository, full_name: slug },
        pull_request: {
          ...structuredClone(fixture.pull_request),
          number: 10,
          html_url: sourceUrl,
          user: fixture.author,
          merged_by: fixture.merger,
          merge_commit_sha: after,
          base: { ref: "main" },
        },
        sender: fixture.merger,
      };
    else
      payload = {
        repository: { ...fixture.repository, full_name: slug },
        issue: {
          id: 10,
          node_id: subjectId,
          number: 10,
          html_url: sourceUrl,
          user: fixture.author,
          created_at: at,
          updated_at: at,
          state: "open",
        },
        sender: fixture.merger,
      };
    return {
      repository: {
        id: 2,
        slug,
        visibility: "public",
        ...(state.defaultBranch === undefined ? {} : { defaultBranch: state.defaultBranch }),
      },
      proof: {
        verified: true,
        source: "github_rest",
        revision: input.fact.sourceRevision,
        eventId: "synthetic-delivery-" + family,
        isSynthetic: true,
      },
      family,
      action:
        family === "commit" ? "direct_default_branch_integration" : family === "pull_request" ? "closed" : "opened",
      occurredAt: at,
      observedAt: input.observedAt,
      payload,
      integration: {
        before,
        after,
        canonicalChangeId: "synthetic-delivery-" + family,
        defaultBranch: "main",
        targetBranch: "main",
        commitShas: [after],
        ...(family === "commit"
          ? {}
          : {
              diff: { before, after, complete: true, files: [{ path: "src/change.ts", additions: 7, deletions: 2 }] },
            }),
      },
    };
  };
  const h = await harness(t, {
    authorizePolicyPreview: async () => true,
    githubEnrich: enrich,
    source: {
      async readPage(request) {
        assert.equal(request.family, sourceFamily);
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId,
              sourceRevision: state.revision,
              sourceUrl,
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
      config.repositories[0].families = [sourceFamily];
      const policy = {
        ...config.policies[0].policy,
        metricId: metric,
        unit: components.metrics.getMetricDefinition(metric).definition.unit,
        aggregation:
          components.metrics.getMetricDefinition(metric).definition.aggregation === "sum_eligible_line_units"
            ? "sum"
            : "count",
        roles: ["author"],
        groupBy: metric === "files_changed" ? "canonical" : "actor_artifact",
        sources: ["github_rest"],
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" },
      ];
      if (extra.includeIssuePolicy) config.policies.push(issuePolicy);
    },
    ...extra,
  });
  return {
    ...h,
    state,
    family,
    sourceFamily,
    metric,
    enrich,
    at,
    subjectId,
    sourceUrl,
    expected: family === "commit" ? 1 : ({ pr_lines_added: 7, pr_lines_removed: 2, files_changed: 1 }[metric] ?? 9),
  };
}

const paths = (metric) => [
  "/api/v1/boards?metric=" + metric,
  "/api/v1/exports?metric=" + metric + "&format=json",
  "/api/v1/exports?metric=" + metric + "&format=csv",
];
const previewRequest = (h, snapshotId) => ({
  snapshotId,
  policy: { ...h.config.policies[0].policy, version: "synthetic-delivery-preview", rank: false },
  operatorId: "201",
});
async function assertDenied(runtime, metric, snapshot, current = true) {
  for (const path of paths(metric)) {
    if (current) assert.equal((await runtime.app.inject(path)).statusCode, 503, path);
    const response = await runtime.app.inject(path + "&snapshot=" + snapshot);
    assert.equal(response.statusCode, 410, response.body);
    assert.doesNotMatch(response.body, /synthetic-.*|normalizationHashes|normalizationSources/);
  }
}
async function assertMetric(runtime, metric, expected, snapshot = null) {
  const response = await runtime.app.inject(paths(metric)[0] + (snapshot ? "&snapshot=" + snapshot : ""));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .rows.filter((row) => row.result.value > 0)
      .map((row) => [row.actorId, row.result.value]),
    expected ? [["101", expected]] : [],
  );
  for (const path of paths(metric)) {
    const response = await runtime.app.inject(path + (snapshot ? "&snapshot=" + snapshot : ""));
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /defaultDeliveryNormalizationVersion|normalizationHashes|normalizationSources/);
  }
}

// Reconstruct an integrity-valid pre-upgrade fixture, including its SQL and
// SQLite authorities. These explicit fixture writes never run in production.
async function retainLegacyDelivery(h, publication, bindingMode) {
  const row = (
    await h.db.query(
      `SELECT n.* FROM leaderboard_pipeline.normalizations n
       JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family=$1`,
      [h.sourceFamily],
    )
  ).rows[0];
  const document = structuredClone(row.document);
  delete document.defaultDeliveryNormalizationVersion;
  const oldHash = comparisonHash(document);
  const signature =
    h.sourceFamily === "reviews"
      ? comparisonHash([components.github.reviewSourceNormalizationVersion, legacySignature(h.config)])
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
  let explanationHash, input, inputId;
  if (publication.comparisonInput) {
    const before = new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).document;
    const explanation = buildAggregateExplanation(capture, {
      scopeKey: before.scopeKey,
      computationVersion: before.snapshot.computationVersion,
    });
    explanationHash = comparisonHash(explanation);
    h.controlsStore.db
      .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
      .run(JSON.stringify(explanation), explanationHash, publication.snapshotId);
    const oldInput = h.controlsStore.db
      .prepare("SELECT * FROM policy_preview_inputs WHERE id=?")
      .get(publication.comparisonInput.inputId);
    input = JSON.parse(oldInput.document);
    replaceBinding(input.authorization);
    inputId = comparisonHash(input);
    h.controlsStore.db
      .prepare("UPDATE policy_preview_inputs SET id=?,document=?,digest=? WHERE id=?")
      .run(inputId, JSON.stringify(input), inputId, oldInput.id);
  }
  const receipt = (
    await h.db.query("SELECT receipt_id,document FROM leaderboard_pipeline.receipts WHERE kind='snapshot_published'")
  ).rows.find((entry) => entry.document.snapshotId === publication.snapshotId);
  receipt.document.comparisonInputHash = comparisonHash(capture);
  await h.db.query("UPDATE leaderboard_pipeline.receipts SET document=$2::jsonb,document_hash=$3 WHERE receipt_id=$1", [
    receipt.receipt_id,
    JSON.stringify(receipt.document),
    comparisonHash(receipt.document),
  ]);
  if (publication.comparisonInput) {
    h.controlsStore.transaction((state) => {
      for (const confirmation of [
        state.pipelinePublications[publication.snapshotId],
        ...Object.values(state.pipelineHeads),
      ]) {
        if (confirmation.snapshotId !== publication.snapshotId) continue;
        delete confirmation.defaultDeliveryNormalizationVersion;
        confirmation.aggregateExplanationHash = explanationHash;
      }
    });
    assert.equal(new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).digest, explanationHash);
    assert.equal(h.runtime.policyComparisons.comparisons.input(inputId).id, inputId);
  }
  return {
    factKey: row.fact_key,
    signature,
    document,
    documentHash: oldHash,
    inputId,
    authorization: input?.authorization ?? frozen.identityAuthorization,
  };
}

async function restart(h, work, extra = {}) {
  await h.runtime.stop();
  h.controlsStore.close();
  h.controlsStore.close = () => {};
  await h.reopenDatabase();
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const runtime = await createPipeline({ ...h.options, controlsStore, ...extra });
  try {
    await work(runtime, controlsStore);
  } finally {
    await runtime.stop();
    controlsStore.close();
  }
}

export {
  deliveryHarness,
  assertDenied,
  assertMetric,
  retainLegacyDelivery,
  restart,
  previewRequest,
  paths,
  version,
  legacySignature,
  currentSignature,
  deliveryMetrics,
  before,
  after,
};
