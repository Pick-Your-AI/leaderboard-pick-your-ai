import assert from "node:assert/strict";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { buildAggregateExplanation, AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { components, harness, ago } from "./harness.mjs";
import { legacySignature, currentSignature, restart } from "./default-delivery-fixtures.mjs";
import { operatorHarness } from "./operator-harness.mjs";

export const version = "relationship-pair-units/v1";
const slug = "synthetic-org/synthetic-repo";
const actor = { id: 202, node_id: "U_SYNTHETIC_PAIR_202", login: "synthetic-linker", type: "User" };
const author = { id: 101, node_id: "U_SYNTHETIC_PAIR_101", login: "synthetic-author", type: "User" };
export const pairPolicy = (metricId = "closing_links") => ({
  metricId,
  version: "synthetic-relationship-pair-policy-v1",
  definitionVersion: components.metrics.metricRegistryV1.policy_version,
  unit: components.metrics.getMetricDefinition(metricId).definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["triager"],
  groupBy: "canonical",
  groupingPolicyVersion: version,
  sources: ["github_graphql"],
  minimumSamples: 1,
  rank: false,
});

export async function pairHarness(t, extra = {}) {
  const metric = extra.metric ?? "closing_links";
  const kind = metric === "reference_links" ? "reference" : "closing";
  const at = ago(2);
  const state = { valid: true, hydrations: 0, revision: "synthetic-pair-source-v1" };
  const issue = (number) => ({
    id: number,
    node_id: number === 1 ? "SYNTHETIC_ISSUE_1" : `I_SYNTHETIC_PAIR_${number}`,
    number,
    html_url: `https://github.com/${slug}/issues/${number}`,
    created_at: at,
    updated_at: at,
    state: "open",
    user: author,
  });
  const target = issue(20);
  const items = extra.operator ? [issue(1), target] : [target];
  const enrich = async (input) => {
    state.hydrations++;
    const selected = items.find((item) => item.node_id === input.fact.subjectId);
    assert.ok(selected, "only the explicitly collected synthetic subject may be enriched");
    const isTarget = selected.number === 20;
    const eventId = `synthetic-pair-event-${selected.number}`;
    return {
      repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
      proof: {
        verified: true,
        source: isTarget ? "github_graphql" : "github_rest",
        revision: input.fact.sourceRevision,
        eventId,
        isSynthetic: true,
      },
      family: isTarget ? "relationship" : "issue",
      action: isTarget ? (kind === "reference" ? "referenced" : "connected") : "opened",
      occurredAt: at,
      observedAt: input.observedAt,
      payload: {
        repository: { id: 2, private: false, full_name: slug },
        issue: structuredClone(selected),
        sender: actor,
        ...(isTarget
          ? {
              relationship: {
                kind,
                from: "PR_SYNTHETIC_PAIR_10",
                to: target.node_id,
                intentional: true,
                publicEndpointsVerified: state.valid,
                pair: {
                  version,
                  kind,
                  action: kind === "reference" ? "reference" : "connect",
                  eventId,
                  from: { repositoryId: "2", artifactId: "PR_SYNTHETIC_PAIR_10", kind: "pull_request" },
                  to: { repositoryId: "2", artifactId: target.node_id, kind: "issue" },
                },
              },
            }
          : {}),
      },
      ...(extra.includeDelivery && isTarget
        ? {
            integration: {
              before: "b".repeat(40),
              after: "c".repeat(40),
              canonicalChangeId: "synthetic-pair-delivery",
              defaultBranch: "main",
              targetBranch: "main",
              commitShas: ["c".repeat(40)],
              diff: {
                before: "b".repeat(40),
                after: "c".repeat(40),
                complete: true,
                files: [{ path: "src/pair.ts", additions: 3, deletions: 1 }],
              },
            },
          }
        : {}),
    };
  };
  const create = extra.operator ? operatorHarness : harness;
  const h = await create(t, {
    authorizePolicyPreview: async () => true,
    githubEnrich: enrich,
    payloads: items,
    source: {
      async readPage(request) {
        assert.equal(request.family, "issues");
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: items.length,
          facts: items.map((item) => ({
            subjectId: item.node_id,
            sourceRevision: state.revision,
            sourceUrl: item.html_url,
            evidence: "current_state",
            actorId: null,
            occurredAt: null,
            state: "present",
          })),
        };
      },
    },
    configure(config) {
      const issuePolicy = config.policies[0];
      const policy = pairPolicy(metric);
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-pair-policy" },
      ];
      if (extra.operator || extra.includeIssuePolicy) config.policies.push(issuePolicy);
      if (extra.includeDelivery) {
        const delivery = {
          ...issuePolicy.policy,
          metricId: "pr_lines_changed",
          unit: components.metrics.getMetricDefinition("pr_lines_changed").definition.unit,
          aggregation: "sum",
          roles: ["author"],
          sources: ["github_graphql"],
          rank: false,
        };
        config.policies.push({
          policy: delivery,
          signature: components.metrics.stableJSON(delivery),
          approvalReceipt: "synthetic-delivery-policy",
        });
      }
      if (extra.named) config.scopes = [{ ...config.scopes[0], period: "all" }];
    },
    ...(extra.operator ? { webhookDispatch: true } : {}),
    ...extra,
  });
  return { ...h, state, metric, enrich, sourceFamily: "issues", at, subjectId: target.node_id };
}

export const paths = (metric) => [
  `/api/v1/boards?metric=${metric}`,
  `/api/v1/exports?metric=${metric}&format=json`,
  `/api/v1/exports?metric=${metric}&format=csv`,
];
export const previewRequest = (h, snapshotId) => ({
  snapshotId,
  policy: { ...h.config.policies[0].policy, version: "synthetic-pair-preview-v1" },
  operatorId: "201",
});
export async function assertPair(runtime, metric, quantity, snapshotId = null) {
  for (const path of paths(metric)) {
    const response = await runtime.app.inject(path + (snapshotId ? `&snapshot=${snapshotId}` : ""));
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
    if (path.includes("/boards"))
      assert.deepEqual(
        response
          .json()
          .rows.filter((row) => row.result.value > 0)
          .map((row) => [row.actorId, row.result.value]),
        quantity ? [["202", quantity]] : [],
      );
  }
}
export async function assertDenied(runtime, metric, snapshotId, current = true) {
  for (const path of paths(metric)) {
    if (current) assert.equal((await runtime.app.inject(path)).statusCode, 503, path);
    const response = await runtime.app.inject(`${path}&snapshot=${snapshotId}`);
    assert.equal(response.statusCode, 410, response.body);
    assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
  }
}

// Fixture-only reconstruction of a hash-valid historical generation. Preserve
// all independent SQL, explanation and SQLite bindings so a denial cannot be
// explained by a broken test receipt or an orphaned preview input.
export async function retainLegacyPair(
  h,
  publication,
  bindingMode = "exact",
  { evidenceOnly = false, wrapper = "plain", marker = false } = {},
) {
  const row = (
    await h.db.query(
      `SELECT n.* FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.subject_id=$1`,
      [h.subjectId],
    )
  ).rows[0];
  const document = structuredClone(row.document);
  delete document.relationshipPairNormalizationVersion;
  for (const fact of document.facts) delete fact.relationshipPair;
  if (evidenceOnly) document.facts = [];
  if (marker) document.relationshipPairNormalizationVersion = version;
  let signature = wrapper === "previous" ? legacySignature(h.config) : currentSignature(h.config);
  if (document.defaultDeliveryNormalizationVersion)
    signature = comparisonHash([document.defaultDeliveryNormalizationVersion, signature]);
  const oldHash = comparisonHash(document);
  await h.db.query(
    `UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$5`,
    [row.fact_key, signature, JSON.stringify(document), oldHash, row.policy_signature],
  );
  const replaceBinding = (authorization) => {
    // Historical inputs predate the independently bound current-generation
    // pair capture; remove it consistently from every reconstructed input.
    delete authorization.relationshipPairEvidence;
    if (bindingMode === "unbound") {
      delete authorization.identityEvidence;
      return;
    }
    authorization.identityEvidence.normalizationHashes = authorization.identityEvidence.normalizationHashes
      .map((hash) => (hash === row.document_hash ? oldHash : hash))
      .sort();
    if (bindingMode === "exact")
      authorization.identityEvidence.normalizationSources = authorization.identityEvidence.normalizationSources.map(
        (source) => (source.factKey === row.fact_key ? { ...source, documentHash: oldHash } : source),
      );
    else delete authorization.identityEvidence.normalizationSources;
  };
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  replaceBinding(frozen.identityAuthorization);
  for (const fact of frozen.frozen.facts) delete fact.relationshipPair;
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
  for (const fact of input.input.facts) delete fact.relationshipPair;
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
    for (const saved of [state.pipelinePublications[publication.snapshotId], ...Object.values(state.pipelineHeads)]) {
      if (saved.snapshotId !== publication.snapshotId) continue;
      delete saved.relationshipPairNormalizationVersion;
      saved.aggregateExplanationHash = explanationHash;
    }
  });
  return {
    factKey: row.fact_key,
    signature,
    document,
    documentHash: oldHash,
    inputId,
    authorization: input.authorization,
  };
}

export { currentSignature, legacySignature, restart };
