import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { createPublicationWindowIndex } from "../src/publication-window-index.mjs";
import { ago, clock, components, harness, publicScope } from "./harness.mjs";
import {
  assertPair,
  currentSignature,
  legacySignature,
  pairHarness,
  pairPolicy,
  previewRequest,
  restart,
  version as pairVersion,
} from "./relationship-pair-fixtures.mjs";
import { operatorAllow, queueOperatorReplay } from "./operator-harness.mjs";

const fieldVersion = "field-change-json-values/v1";
const deliveryVersion = "default-delivery-scope/v1";
const fieldMetric = "issue_field_updates";
const P = (base) => comparisonHash([pairVersion, base]);
const F = (base) => comparisonHash([fieldVersion, base]);
const D = (base) => comparisonHash([deliveryVersion, base]);
const allGenerations = (base) => [base, D(base), F(base), F(D(base)), P(base), P(D(base)), P(F(base)), P(F(D(base)))];
const cacheRows = async (h) =>
  (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
const snapshotRows = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
const frozenInput = async (h, snapshotId) =>
  (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [snapshotId]))
    .rows[0].document;
function publication(result) {
  assert.equal(result.state, "published", JSON.stringify(result));
  assert.equal(result.publications.length, 1);
  return result.publications[0];
}
function fieldPolicy(template) {
  return {
    ...template,
    metricId: fieldMetric,
    unit: components.metrics.getMetricDefinition(fieldMetric).definition.unit,
    roles: ["triager"],
    sources: ["github_graphql"],
    rank: false,
  };
}
function addFieldObservation(output, envelope, equalValues = false) {
  const resource = envelope.payload.issue ?? {
    ...envelope.payload.pull_request,
    id: 40,
    node_id: "I_SYNTHETIC_PEER_FIELD_40",
    number: 40,
    html_url: `https://github.com/${envelope.repository.slug}/issues/40`,
  };
  const field = components.github.normalizeGithubObservation({
    repository: envelope.repository,
    proof: { ...envelope.proof, eventId: `${envelope.proof.eventId}-field` },
    family: "field_change",
    action: "issue_field_changed",
    occurredAt: envelope.occurredAt,
    observedAt: envelope.observedAt,
    payload: {
      issue: resource,
      id: resource.node_id,
      url: resource.html_url,
      sender: envelope.payload.sender,
      change: {
        before: { alpha: 1, beta: 2 },
        after: equalValues ? { beta: 2, alpha: 1 } : { alpha: 1, beta: 3 },
      },
    },
  });
  return {
    ...output,
    facts: [...output.facts, ...field.facts],
    actors: [...new Map([...output.actors, ...field.actors].map((actor) => [actor.id, actor])).values()],
    evidence: [...output.evidence, ...field.evidence],
  };
}

// All positive claims come from the actual GitHub normalizers. The explicit
// replacement composes two verified observations for one collected source; it
// therefore declares all applicable generations rather than forging markers.
async function mixedHarness(t, extra = {}) {
  const { includeDelivery = false, afterNormalize = async () => {}, ...rest } = extra;
  const mixed = { empty: false, calls: 0 };
  const h = await pairHarness(t, {
    memoryDatabase: true,
    ...rest,
    includeDelivery,
    relationshipPairNormalizationVersion: pairVersion,
    fieldChangeNormalizationVersion: fieldVersion,
    defaultDeliveryNormalizationVersion: deliveryVersion,
    configure(config) {
      const ordinary = config.policies[0];
      const pair = pairPolicy(rest.metric);
      const field = fieldPolicy(ordinary.policy);
      config.policies = [pair, field].map((policy) => ({
        policy,
        signature: components.metrics.stableJSON(policy),
        approvalReceipt: "synthetic-pair-field-policy",
      }));
      if (rest.operator) config.policies.push(ordinary);
      if (includeDelivery) {
        const delivery = {
          ...ordinary.policy,
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
          approvalReceipt: "synthetic-pair-field-delivery-policy",
        });
      }
      if (rest.named) config.scopes = [{ ...config.scopes[0], period: "all" }];
    },
    normalizerFactory(options) {
      let envelope;
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: async (input) => {
          envelope = await options.githubEnrich(input);
          if (mixed.empty) delete envelope.integration;
          return envelope;
        },
      });
      return async (input) => {
        mixed.calls++;
        const original = await builtin(input);
        const output =
          input.fact.subjectId === "I_SYNTHETIC_PAIR_20"
            ? addFieldObservation(original, envelope, mixed.empty)
            : original;
        await afterNormalize(options, input, output);
        return output;
      };
    },
  });
  return { ...h, mixed };
}
async function assertField(runtime, quantity, snapshotId = null, repository = null) {
  const query = new URLSearchParams({
    metric: fieldMetric,
    ...(snapshotId ? { snapshot: snapshotId } : {}),
    ...(repository ? { repository: String(repository) } : {}),
  });
  const response = await runtime.app.inject(`/api/v1/boards?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .rows.filter((row) => row.result.value > 0)
      .map((row) => [row.actorId, row.result.value]),
    quantity ? [["202", quantity]] : [],
  );
  assert.doesNotMatch(response.body, /relationshipPair|fieldChangeNormalizationVersion|normalizationHashes/);
}
async function assertCaptured(h, current, row) {
  const frozen = await frozenInput(h, current.snapshotId);
  const explanation = new AggregateExplanationStore(h.controlsStore).read(current.snapshotId).document;
  const comparison = JSON.parse(
    h.controlsStore.db
      .prepare("SELECT document FROM policy_preview_inputs WHERE id=?")
      .get(current.comparisonInput.inputId).document,
  );
  const captured = frozen.identityAuthorization.relationshipPairEvidence;
  assert.deepEqual(explanation.authorization.relationshipPairEvidence, captured);
  assert.deepEqual(comparison.authorization.relationshipPairEvidence, captured);
  assert.ok(
    captured.bindings.some(
      (binding) =>
        binding.factKey === row.fact_key &&
        binding.documentHash === row.document_hash &&
        binding.policySignature === row.policy_signature,
    ),
  );
  await h.runtime.previewPolicy(previewRequest(h, current.snapshotId));
  await h.runtime.aggregateExplanations.read(current.snapshotId);
}
async function insertCache(h, row, signature, document, hash = comparisonHash(document)) {
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
    [row.fact_key, signature, JSON.stringify(document), hash],
  );
}
const emptyDocument = (delivery = false, pair = false) => ({
  isSynthetic: true,
  facts: [],
  actors: [],
  evidence: [],
  reasons: [],
  suppressArtifactIds: [],
  fieldChangeNormalizationVersion: fieldVersion,
  ...(delivery ? { defaultDeliveryNormalizationVersion: deliveryVersion } : {}),
  ...(pair ? { relationshipPairNormalizationVersion: pairVersion } : {}),
});

for (const includeDelivery of [false, true]) {
  test(`combined pair/field generation retains empty predecessor hints; delivery=${includeDelivery}`, async (t) => {
    const h = await mixedHarness(t, { includeDelivery, memoryDatabase: includeDelivery, named: true });
    const cutoff = clock();
    const first = publication(await h.runtime.runOnce({ cutoff }));
    const original = (await cacheRows(h))[0];
    const expected = P(F(includeDelivery ? D(currentSignature(h.config)) : currentSignature(h.config)));
    assert.equal(original.policy_signature, expected);
    assert.equal(original.document.relationshipPairNormalizationVersion, pairVersion);
    assert.equal(original.document.fieldChangeNormalizationVersion, fieldVersion);
    assert.ok(original.document.facts.some((fact) => fact.metricId === h.metric));
    assert.ok(original.document.facts.some((fact) => fact.metricId === fieldMetric));
    await assertPair(h.runtime, h.metric, 1);
    await assertField(h.runtime, 1);
    await assertCaptured(h, first, original);
    const snapshots = await snapshotRows(h);
    // Reconstruct preceding classification caches for this SAME immutable source.
    // Their empty output is a hint only; it must not downgrade the current key.
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
      original.fact_key,
      original.policy_signature,
    ]);
    const prior = includeDelivery ? D(legacySignature(h.config)) : legacySignature(h.config);
    await insertCache(h, original, F(prior), emptyDocument(includeDelivery));
    await insertCache(h, original, P(F(prior)), emptyDocument(includeDelivery, true));
    const predecessors = await cacheRows(h);
    h.state.valid = false;
    h.mixed.empty = true;
    let candidateKeys;
    const query = h.db.query;
    h.db.query = async (sql, params) => {
      if (sql.includes("FROM leaderboard_pipeline.normalizations") && sql.includes("policy_signature=ANY"))
        candidateKeys = new Set(params[1]);
      return query(sql, params);
    };
    const corrected = publication(await h.runtime.runOnce({ cutoff }));
    assert.ok(allGenerations(currentSignature(h.config)).every((key) => candidateKeys.has(key)));
    assert.ok(allGenerations(legacySignature(h.config)).every((key) => candidateKeys.has(key)));
    const current = (await cacheRows(h)).find((row) => row.policy_signature === expected);
    assert.ok(current);
    assert.deepEqual(current.document.facts, []);
    assert.equal(current.document.relationshipPairNormalizationVersion, pairVersion);
    assert.equal(current.document.fieldChangeNormalizationVersion, fieldVersion);
    const confirmation = h.controlsStore.read().pipelinePublications[corrected.snapshotId];
    assert.equal(confirmation.relationshipPairNormalizationVersion, pairVersion);
    assert.equal(confirmation.fieldChangeNormalizationVersion, fieldVersion);
    await assertPair(h.runtime, h.metric, 0);
    await assertField(h.runtime, 0);
    for (const row of predecessors)
      assert.deepEqual(
        (await cacheRows(h)).find((entry) => entry.policy_signature === row.policy_signature),
        row,
      );
    for (const row of snapshots)
      assert.deepEqual(
        (await snapshotRows(h)).find((entry) => entry.snapshot_id === row.snapshot_id),
        row,
      );
    const retained = await cacheRows(h);
    const calls = h.mixed.calls;
    h.state.valid = true;
    h.mixed.empty = false;
    const check = async (runtime) => {
      assert.equal(publication(await runtime.runOnce({ cutoff })).snapshotId, corrected.snapshotId);
      assert.equal(h.mixed.calls, calls, "a corrected current cache cannot rehydrate unchanged source into credit");
      assert.deepEqual(await cacheRows(h), retained);
      await assertPair(runtime, h.metric, 0, corrected.snapshotId);
      await assertField(runtime, 0, corrected.snapshotId);
    };
    if (includeDelivery) await check(h.runtime);
    else await restart(h, check);
  });
}

async function peerHarness(t, metric) {
  const sourceSlug = "synthetic-org/synthetic-pair-issues";
  const peerSlug = "synthetic-org/synthetic-pair-pulls";
  const issueId = "I_SYNTHETIC_FIELD_PAIR_20";
  const pullId = "PR_SYNTHETIC_FIELD_PAIR_10";
  const actor = (id) => ({ id, node_id: `U_SYNTHETIC_FIELD_PAIR_${id}`, login: `synthetic-${id}`, type: "User" });
  const state = { revision: "v1", unbound: false, context: null };
  const sourceAt = ago(2),
    peerAt = ago(3);
  const kind = metric === "reference_links" ? "reference" : "closing";
  const h = await harness(t, {
    memoryDatabase: true,
    authorizePolicyPreview: async () => true,
    relationshipPairNormalizationVersion: pairVersion,
    fieldChangeNormalizationVersion: fieldVersion,
    configure(config) {
      const ordinary = config.policies[0].policy;
      config.repositories = [sourceSlug, peerSlug].map((slug, index) => ({
        id: index + 2,
        installationId: 1,
        slug,
        families: ["issues"],
        approvalReceipt: "synthetic-pair-field-source-approved",
      }));
      config.policies = [pairPolicy(metric), fieldPolicy(ordinary)].map((policy) => ({
        policy,
        signature: components.metrics.stableJSON(policy),
        approvalReceipt: "synthetic-pair-field-policy",
      }));
      config.scopes = [null, "2"].map((repository) => ({ ...publicScope, repository }));
    },
    async probeRepository(repository) {
      return {
        repositoryId: repository.id,
        installationId: 1,
        visibility: "public",
        checkedAt: clock(),
      };
    },
    source: {
      async readPage(request) {
        const peer = request.repositoryId === 3;
        return {
          repositoryId: request.repositoryId,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: peer ? pullId : issueId,
              sourceRevision: peer ? `synthetic-peer-${state.revision}` : "synthetic-source-v1",
              sourceUrl: `https://github.com/${peer ? peerSlug + "/pull/10" : sourceSlug + "/issues/20"}`,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "present",
            },
          ],
        };
      },
    },
    async githubEnrich(input) {
      const peer = input.repository.id === 3;
      const slug = peer ? peerSlug : sourceSlug;
      const occurredAt = peer ? peerAt : sourceAt;
      const eventId = peer ? "synthetic-earlier-field-pair" : "synthetic-selected-field-pair";
      return {
        repository: { id: input.repository.id, slug, visibility: "public", defaultBranch: "main" },
        proof: {
          verified: true,
          source: "github_graphql",
          revision: input.fact.sourceRevision,
          eventId,
          isSynthetic: true,
        },
        family: "relationship",
        action: kind === "reference" ? "referenced" : "connected",
        occurredAt,
        observedAt: input.observedAt,
        ...(peer ? { currentContext: structuredClone(state.context) } : {}),
        payload: {
          [peer ? "pull_request" : "issue"]: {
            id: peer ? 10 : 20,
            node_id: peer ? pullId : issueId,
            number: peer ? 10 : 20,
            html_url: input.fact.sourceUrl,
            created_at: occurredAt,
            updated_at: occurredAt,
            state: "open",
            user: actor(101),
          },
          sender: actor(peer ? 303 : 202),
          relationship: {
            kind,
            from: pullId,
            to: issueId,
            intentional: true,
            publicEndpointsVerified: true,
            pair:
              peer && state.unbound
                ? undefined
                : {
                    version: pairVersion,
                    kind,
                    action: kind === "reference" ? "reference" : "connect",
                    eventId,
                    from: { repositoryId: "3", artifactId: pullId, kind: "pull_request" },
                    to: { repositoryId: "2", artifactId: issueId, kind: "issue" },
                  },
          },
        },
      };
    },
    normalizerFactory(options) {
      let envelope;
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2, 3],
        isSynthetic: true,
        enrich: async (input) => (envelope = await options.githubEnrich(input)),
      });
      return async (input) => addFieldObservation(await builtin(input), envelope);
    },
  });
  return { ...h, metric, state };
}
async function pairBoard(h, repository = null) {
  const query = new URLSearchParams({ metric: h.metric, ...(repository ? { repository: String(repository) } : {}) });
  const response = await h.runtime.app.inject(`/api/v1/boards?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.doesNotMatch(response.body, /relationshipPair|normalizationHashes|normalizationSources/);
  return response.json();
}
const positiveRows = (board) =>
  board.rows.filter((row) => row.result.value > 0).map((row) => [row.actorId, row.result.value]);
for (const metric of ["reference_links", "closing_links"]) {
  test(`${metric}: combined peer history remains authoritative outside the selected repository`, async (t) => {
    const h = await peerHarness(t, metric);
    assert.equal((await h.runtime.runOnce({ cutoff: clock() })).state, "published");
    assert.deepEqual(positiveRows(await pairBoard(h)), [["303", 1]]);
    const selected = await pairBoard(h, 2);
    assert.deepEqual(positiveRows(selected), []);
    const frozen = await frozenInput(h, selected.snapshotId);
    assert.deepEqual([...frozen.frozen.repositoryIds].sort(), ["2", "3"]);
    assert.deepEqual(frozen.engineScope.repos, ["2"]);
    assert.ok(frozen.frozen.facts.some((fact) => fact.repoId === "3" && fact.metricId === metric));
    assert.ok(!frozen.frozen.facts.some((fact) => fact.repoId === "3" && fact.metricId === fieldMetric));
    const peer = frozen.identityAuthorization.identityEvidence.normalizationSources.find(
      (source) => source.relationshipPairFactHashes !== undefined,
    );
    assert.ok(peer && peer.relationshipPairFactHashes.length > 0);
    await assertField(h.runtime, 1, selected.snapshotId, 2);
    await h.runtime.previewPolicy({
      snapshotId: selected.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-combined-peer-preview" },
      operatorId: "201",
    });
    const original = await cacheRows(h);
    assert.ok(original.every((row) => row.policy_signature === P(F(currentSignature(h.config)))));
    h.state.revision = "v2";
    if (metric === "reference_links") h.state.unbound = true;
    else
      h.state.context = {
        projects: ["synthetic-project"],
        workstreams: [],
        workstreamsKnown: true,
        projectScope: ["synthetic-project"],
        workstreamScope: [],
      };
    assert.equal((await h.runtime.runOnce({ cutoff: clock() })).state, "published");
    assert.deepEqual(positiveRows(await pairBoard(h)), []);
    assert.deepEqual(positiveRows(await pairBoard(h, 2)), []);
    for (const row of original)
      assert.deepEqual(
        (await cacheRows(h)).find((value) => value.fact_key === row.fact_key),
        row,
      );
  });
}

function revoke(h, field) {
  delete h.options.normalizer;
  delete h.options[field];
}
function afterTransaction(h, predicate, after) {
  const transaction = h.db.transaction;
  h.db.transaction = async (work) => {
    let matched = false;
    const value = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          matched ||= predicate(sql);
          return result;
        },
      }),
    );
    if (matched) after();
    return value;
  };
}
function noConfirmation(h) {
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
}
for (const [kind, field, version, failure] of [
  ["pair", "relationshipPairNormalizationVersion", pairVersion, /relationship_pair_normalizer_version_unverified/],
  [
    "delivery",
    "defaultDeliveryNormalizationVersion",
    deliveryVersion,
    /default_delivery_normalizer_version_unverified/,
  ],
]) {
  test(`${kind}: removing provider options during normalization cannot borrow builtin compatibility`, async (t) => {
    let armed = true;
    const h = await mixedHarness(t, {
      includeDelivery: kind === "delivery",
      afterNormalize: async (options) => {
        await Promise.resolve();
        if (!armed) return;
        armed = false;
        delete options.normalizer;
        delete options[field];
      },
    });
    const cutoff = clock();
    await assert.rejects(h.runtime.runOnce({ cutoff }), failure);
    assert.equal(h.mixed.calls, 1);
    assert.deepEqual(await cacheRows(h), []);
    assert.deepEqual(await snapshotRows(h), []);
    noConfirmation(h);
    h.options[field] = version;
    publication(await h.runtime.runOnce({ cutoff }));
    assert.equal(h.mixed.calls, 2);
    await assertPair(h.runtime, h.metric, 1);
    await assertField(h.runtime, 1);
  });

  test(`${kind}: cached dependency capture rechecks the retained provider under its source lock`, async (t) => {
    const h = await mixedHarness(t, { includeDelivery: kind === "delivery" });
    const cutoff = clock();
    publication(await h.runtime.runOnce({ cutoff }));
    const caches = await cacheRows(h),
      snapshots = await snapshotRows(h);
    const confirmations = structuredClone(h.controlsStore.read().pipelinePublications);
    const transaction = h.db.transaction;
    let changed = false,
      writes = 0;
    h.db.transaction = (work) =>
      transaction((tx) =>
        work({
          query: async (sql, params) => {
            if (changed && /INSERT\s+INTO\s+leaderboard_pipeline\.source_artifacts/i.test(sql)) writes++;
            const value = await tx.query(sql, params);
            if (
              !changed &&
              sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") &&
              sql.includes("FOR UPDATE")
            ) {
              revoke(h, field);
              changed = true;
            }
            return value;
          },
        }),
      );
    await assert.rejects(h.runtime.runOnce({ cutoff }), failure);
    assert.equal(changed, true);
    assert.equal(writes, 0);
    assert.equal(h.mixed.calls, 1);
    assert.deepEqual(await cacheRows(h), caches);
    assert.deepEqual(await snapshotRows(h), snapshots);
    assert.deepEqual(h.controlsStore.read().pipelinePublications, confirmations);
    h.options[field] = version;
    publication(await h.runtime.runOnce({ cutoff }));
    assert.equal(h.mixed.calls, 1);
    assert.deepEqual(await snapshotRows(h), snapshots);
  });

  test(`${kind}: final SQLite confirmation rejects compatibility lost after the SQL commit`, async (t) => {
    const h = await mixedHarness(t, { includeDelivery: kind === "delivery" });
    let armed = false,
      changed = false;
    afterTransaction(
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
          revoke(h, field);
          changed = true;
        }
        return work(state);
      });
    const cutoff = clock();
    await assert.rejects(h.runtime.runOnce({ cutoff }), failure);
    assert.equal(changed, true);
    const snapshots = await snapshotRows(h);
    assert.equal(snapshots.length, 1);
    noConfirmation(h);
    h.options[field] = version;
    const current = publication(await h.runtime.runOnce({ cutoff }));
    assert.equal(current.snapshotId, snapshots[0].snapshot_id);
    assert.deepEqual(await snapshotRows(h), snapshots);
    assert.equal(h.mixed.calls, 1);
    const before = await h.runtime.previewPolicy(previewRequest(h, current.snapshotId));
    revoke(h, field);
    await assertPair(h.runtime, h.metric, 1, current.snapshotId);
    assert.deepEqual(await h.runtime.previewPolicy(previewRequest(h, current.snapshotId)), before);
  });

  test(`${kind}: an unused later callback cannot certify an older captured builtin`, async (t) => {
    const github = { ...components.github, [field]: undefined };
    const h = await pairHarness(t, {
      memoryDatabase: true,
      includeDelivery: kind === "delivery",
      components: { ...components, github },
      [field]: version,
    });
    let unused = 0;
    h.options.normalizer = async () => {
      unused++;
      throw Error("unused callback");
    };
    const cutoff = clock();
    await assert.rejects(h.runtime.runOnce({ cutoff }), failure);
    assert.equal(unused, 0);
    assert.deepEqual(await cacheRows(h), []);
    noConfirmation(h);
    github[field] = version;
    publication(await h.runtime.runOnce({ cutoff }));
    assert.equal(unused, 0);
    await assertPair(h.runtime, h.metric, 1);
  });
}

for (const predecessor of ["pair", "field"]) {
  test(`${predecessor}: every queried predecessor is validated despite a valid combined cache`, async (t) => {
    const h = await mixedHarness(t);
    const cutoff = clock();
    publication(await h.runtime.runOnce({ cutoff }));
    const original = (await cacheRows(h))[0],
      snapshots = await snapshotRows(h);
    const currentBase = currentSignature(h.config);
    for (const base of [currentBase, legacySignature(h.config)]) {
      const signature = predecessor === "pair" ? P(base === currentBase ? base : F(base)) : F(base);
      const document = emptyDocument(false, predecessor === "pair");
      await insertCache(h, original, signature, document, "0".repeat(64));
      await assert.rejects(h.runtime.runOnce({ cutoff }), /normalization_integrity_error/);
      assert.equal(h.mixed.calls, 1);
      assert.deepEqual(await snapshotRows(h), snapshots);
      document.isSynthetic = false;
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
        [original.fact_key, signature, JSON.stringify(document), comparisonHash(document)],
      );
      await assert.rejects(h.runtime.runOnce({ cutoff }), /normalization_data_mode_mismatch/);
      await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
        original.fact_key,
        signature,
      ]);
    }
    assert.deepEqual(await cacheRows(h), [original]);
    publication(await h.runtime.runOnce({ cutoff }));
    assert.equal(h.mixed.calls, 1);
    assert.deepEqual(await snapshotRows(h), snapshots);
    await assertPair(h.runtime, h.metric, 1);
  });
}

test("operator replay reconstructs both pair and field versions and rejects missing content markers", async (t) => {
  const h = await mixedHarness(t, { operator: true, named: true });
  const receipt = await queueOperatorReplay(h);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const read = () => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  const first = await read();
  assert.equal(first.status, "published", first.reason);
  const id = first.publications[0].snapshotId;
  const confirmation = structuredClone(h.controlsStore.read().pipelinePublications[id]);
  assert.equal(confirmation.relationshipPairNormalizationVersion, pairVersion);
  assert.equal(confirmation.fieldChangeNormalizationVersion, fieldVersion);
  const windows = await h.runtime.app.inject(
    `/api/v1/windows?${new URLSearchParams(components.contracts.publicScopeParameters(components.contracts.canonicalPublicScope(publicScope)))}`,
  );
  assert.equal(windows.statusCode, 200, windows.body);
  assert.deepEqual(
    windows.json().windows.map((window) => [window.period, window.snapshotId]),
    [["all", id]],
  );
  for (const field of ["relationshipPairNormalizationVersion", "fieldChangeNormalizationVersion"]) {
    h.controlsStore.transaction((state) => {
      delete state.pipelinePublications[id][field];
    });
    const denied = await read();
    assert.equal(denied.status, "unavailable");
    assert.equal(denied.reason, "publication_verification_unavailable");
    h.controlsStore.transaction((state) => {
      state.pipelinePublications[id] = structuredClone(confirmation);
    });
    assert.equal((await read()).status, "published");
  }
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[id].discussionFeedbackNormalizationVersion =
      components.contracts.discussionFeedbackContentVersion;
  });
  assert.equal((await read()).status, "unavailable");
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[id] = structuredClone(confirmation);
  });
  assert.equal((await read()).status, "published");
});

test("window confirmation preserves pair plus field plus paired feedback metadata and ordinary absence", () => {
  const scope = components.contracts.canonicalPublicScope(publicScope);
  const index = createPublicationWindowIndex({
    configurationVersion: "synthetic-combined-windows",
    configurationHash: "a".repeat(64),
    dataMode: "synthetic",
    templates: [{ ...scope, period: "all" }],
    resolveMetricWindow: components.metrics.resolveMetricWindow,
  });
  const confirmation = {
    recognitionFingerprint: null,
    configurationVersion: "synthetic-combined-windows",
    configurationHash: "a".repeat(64),
    controlsConfigurationRevision: 0,
    aggregateExplanationHash: "b".repeat(64),
    dataMode: "synthetic",
    scopeKey: components.contracts.publicScopeKey(scope),
    snapshotId: "c".repeat(64),
    revision: 1,
    relationshipPairNormalizationVersion: pairVersion,
    fieldChangeNormalizationVersion: fieldVersion,
    discussionFeedbackNormalizationVersion: components.contracts.discussionFeedbackContentVersion,
    discussionFeedbackAuthorityHash: "d".repeat(64),
  };
  const record = (value) => {
    const state = {
      pipelinePublications: { [value.snapshotId]: value },
      pipelineHeads: { [value.scopeKey]: value },
    };
    assert.equal(index.record(state, scope, ["all"], value), true);
    return index.read(state, scope).windows[0].confirmation;
  };
  assert.deepEqual(record(confirmation), confirmation);
  for (const field of ["relationshipPairNormalizationVersion", "fieldChangeNormalizationVersion"])
    assert.throws(() => record({ ...confirmation, [field]: "obsolete" }), /publication_window_index_integrity_error/);
  for (const field of ["discussionFeedbackNormalizationVersion", "discussionFeedbackAuthorityHash"]) {
    const missing = { ...confirmation };
    delete missing[field];
    assert.throws(() => record(missing), /publication_window_index_integrity_error/);
  }
  const ordinary = { ...confirmation };
  for (const field of [
    "relationshipPairNormalizationVersion",
    "fieldChangeNormalizationVersion",
    "discussionFeedbackNormalizationVersion",
    "discussionFeedbackAuthorityHash",
  ])
    delete ordinary[field];
  assert.deepEqual(record(ordinary), ordinary);
});

for (const generation of ["current", "preceding"]) {
  test(`${generation}: empty plain-key field markers require validated migration`, async (t) => {
    const h = await mixedHarness(t, {
      memoryDatabase: true,
      afterNormalize: async (_options, _input, output) => {
        // Isolate the retained cache marker: the freshly corrected empty
        // provider output contributes neither facts nor a classification marker.
        if (output.facts.length === 0) {
          delete output.fieldChangeNormalizationVersion;
          delete output.relationshipPairNormalizationVersion;
        }
      },
    });
    const cutoff = clock();
    const first = publication(await h.runtime.runOnce({ cutoff }));
    const original = (await cacheRows(h))[0];
    const currentBase = currentSignature(h.config);
    assert.equal(original.policy_signature, P(F(currentBase)));
    const signature = generation === "current" ? currentBase : legacySignature(h.config);
    const document = emptyDocument();
    assert.deepEqual(document.facts, []);
    assert.equal(document.relationshipPairNormalizationVersion, undefined);
    const snapshots = await snapshotRows(h);
    const confirmations = structuredClone(h.controlsStore.read().pipelinePublications);
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
      original.fact_key,
      original.policy_signature,
    ]);
    // Only this plain-key marker identifies field semantics. No F/P(F) cache
    // or field fact is left to make the classification succeed independently.
    await insertCache(h, original, signature, document, "0".repeat(64));
    h.state.valid = false;
    h.mixed.empty = true;
    const calls = h.mixed.calls;
    const update = async (value, hash = comparisonHash(value)) =>
      h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
        [original.fact_key, signature, JSON.stringify(value), hash],
      );
    const unchanged = async (rows) => {
      assert.equal(h.mixed.calls, calls, "untrusted hints cannot reach the provider");
      assert.deepEqual(await cacheRows(h), rows);
      assert.deepEqual(await snapshotRows(h), snapshots);
      assert.deepEqual(h.controlsStore.read().pipelinePublications, confirmations);
    };

    let retained = await cacheRows(h);
    await assert.rejects(h.runtime.runOnce({ cutoff }), /normalization_integrity_error/);
    await unchanged(retained);
    await update({ ...document, isSynthetic: false });
    retained = await cacheRows(h);
    await assert.rejects(h.runtime.runOnce({ cutoff }), /normalization_data_mode_mismatch/);
    await unchanged(retained);
    await update(document);
    const predecessor = (await cacheRows(h))[0];
    delete h.options.fieldChangeNormalizationVersion;
    await assert.rejects(h.runtime.runOnce({ cutoff }), /field_change_normalizer_version_unverified/);
    await unchanged([predecessor]);

    h.options.fieldChangeNormalizationVersion = fieldVersion;
    const corrected = publication(await h.runtime.runOnce({ cutoff }));
    assert.ok(h.mixed.calls > calls, "a marker alone cannot authorize reuse of its plain-key document");
    retained = await cacheRows(h);
    assert.equal(retained.length, 2);
    assert.deepEqual(retained.find((row) => row.policy_signature === signature), predecessor);
    const current = retained.find((row) => row.policy_signature === F(currentBase));
    assert.ok(current, "the empty corrected cache must retain the field wrapper");
    assert.deepEqual(current.document.facts, []);
    assert.equal(current.document.fieldChangeNormalizationVersion, fieldVersion);
    assert.equal(current.document.relationshipPairNormalizationVersion, undefined);
    assert.equal(current.document_hash, comparisonHash(current.document));
    assert.equal(
      h.controlsStore.read().pipelinePublications[corrected.snapshotId].fieldChangeNormalizationVersion,
      fieldVersion,
    );
    assert.deepEqual(h.controlsStore.read().pipelinePublications[first.snapshotId], confirmations[first.snapshotId]);
    for (const row of snapshots)
      assert.deepEqual(
        (await snapshotRows(h)).find((entry) => entry.snapshot_id === row.snapshot_id),
        row,
      );
    await assertField(h.runtime, 0, corrected.snapshotId);
    await assertPair(h.runtime, h.metric, 0, corrected.snapshotId);

    const correctedCalls = h.mixed.calls;
    h.state.valid = true;
    h.mixed.empty = false;
    assert.equal(publication(await h.runtime.runOnce({ cutoff })).snapshotId, corrected.snapshotId);
    assert.equal(h.mixed.calls, correctedCalls, "the corrected empty cache must not rehydrate unchanged source");
    assert.deepEqual(await cacheRows(h), retained);
    await assertField(h.runtime, 0);
    await assertPair(h.runtime, h.metric, 0);
  });
}
