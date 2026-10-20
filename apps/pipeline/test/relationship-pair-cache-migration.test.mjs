import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { hasRelationshipPairClaims, hasRelationshipPairMarker } from "../src/relationship-pair-generation.mjs";
import { createPublicationWindowIndex } from "../src/publication-window-index.mjs";
import { components, clock, harness, publicScope } from "./harness.mjs";
import { operatorAllow, queueOperatorReplay } from "./operator-harness.mjs";
import {
  version,
  pairHarness,
  assertPair,
  assertDenied,
  previewRequest,
  retainLegacyPair,
  currentSignature,
  legacySignature,
  restart,
} from "./relationship-pair-fixtures.mjs";

const normalizationRows = async (h) =>
  (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature")).rows;
const snapshots = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;

// An evidence-only historical claim still used the old normalization semantics;
// a family or facts-only predicate would miss it.
test("pair classification includes actual fact/evidence claims and retains any assigned marker", () => {
  assert.equal(hasRelationshipPairClaims({ facts: [{ metricId: "reference_links" }] }), true);
  assert.equal(
    hasRelationshipPairClaims({ evidence: [{ contribution: { metricIds: ["issues_opened", "closing_links"] } }] }),
    true,
  );
  assert.equal(
    hasRelationshipPairClaims({ facts: [], evidence: [{ contribution: { metricIds: ["issues_opened"] } }] }),
    false,
  );
  assert.equal(hasRelationshipPairMarker({ relationshipPairNormalizationVersion: "obsolete" }), true);
  assert.equal(hasRelationshipPairMarker({ facts: [] }), false);
});

for (const metric of ["reference_links", "closing_links"])
  test(`${metric}: real enrichment outside native relationships gets an outer generation and private content marker`, async (t) => {
    const h = await pairHarness(t, { metric, named: true, discoveryAuthority: true });
    const first = (await h.runtime.runOnce({ cutoff: clock() })).publications[0];
    await assertPair(h.runtime, metric, 1);
    const rows = await normalizationRows(h);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].policy_signature, comparisonHash([version, currentSignature(h.config)]));
    assert.equal(rows[0].document.relationshipPairNormalizationVersion, version);
    assert.equal(rows[0].document.facts[0].relationshipPair.version, version);
    assert.equal(
      h.controlsStore.read().pipelinePublications[first.snapshotId].relationshipPairNormalizationVersion,
      version,
    );
    const document = (await snapshots(h))[0].document;
    assert.equal(Object.hasOwn(document, "relationshipPairNormalizationVersion"), false);
    assert.doesNotMatch(JSON.stringify(document), /"relationshipPair"/);
    const windows = await h.runtime.app.inject(
      `/api/v1/windows?${new URLSearchParams(components.contracts.publicScopeParameters(components.contracts.canonicalPublicScope(publicScope)))}`,
    );
    assert.equal(windows.statusCode, 200, windows.body);
    assert.deepEqual(
      windows.json().windows.map((window) => [window.period, window.snapshotId]),
      [["all", first.snapshotId]],
    );
    const hydrations = h.state.hydrations;
    await restart(h, async (runtime) => {
      await assertPair(runtime, metric, 1, first.snapshotId);
      assert.equal((await runtime.runOnce({ cutoff: first.cutoff ?? clock() })).state, "published");
      assert.equal(
        h.state.hydrations,
        hydrations,
        "current wrapped source is reused after actual SQLite/PGlite reopen",
      );
      assert.deepEqual(await normalizationRows(h), rows);
    });
  });

for (const mode of ["exact", "hash-only", "unbound"])
  test(`legacy ${mode} pair inputs cannot regain public/private authority through a marker`, async (t) => {
    const h = await pairHarness(t);
    const cutoff = clock();
    const first = (await h.runtime.runOnce({ cutoff })).publications[0];
    await assertPair(h.runtime, h.metric, 1);
    await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
    const legacy = await retainLegacyPair(h, first, mode);
    const oldSnapshots = await snapshots(h);
    h.state.valid = false;
    await restart(h, async (runtime, controls) => {
      await assertDenied(runtime, h.metric, first.snapshotId);
      await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), /policy_input_revoked/);
      await assert.rejects(
        runtime.aggregateExplanations.read(first.snapshotId),
        /Frozen (relationship pair|normalization).* (obsolete|unavailable)/,
      );
      await assert.rejects(
        runtime.policyComparisons.withAuthorizedInputs([legacy.authorization], () =>
          assert.fail("legacy capture authorized"),
        ),
        /Frozen (relationship pair|normalization).* (obsolete|unavailable)/,
      );
      controls.transaction((state) => {
        state.pipelinePublications[first.snapshotId].relationshipPairNormalizationVersion = version;
        Object.values(state.pipelineHeads).forEach((head) => {
          head.relationshipPairNormalizationVersion = version;
        });
      });
      await assertDenied(runtime, h.metric, first.snapshotId);
      const hydrations = h.state.hydrations;
      const rebuilt = (await runtime.runOnce({ cutoff })).publications[0];
      assert.notEqual(rebuilt.snapshotId, first.snapshotId);
      assert.ok(h.state.hydrations > hydrations);
      await assertPair(runtime, h.metric, 0, rebuilt.snapshotId);
      await assertDenied(runtime, h.metric, first.snapshotId, false);
      await runtime.previewPolicy(previewRequest(h, rebuilt.snapshotId));
      const rows = await normalizationRows(h);
      assert.equal(rows.length, 2);
      const old = rows.find((row) => row.policy_signature === legacy.signature);
      assert.deepEqual(old.document, legacy.document);
      assert.equal(old.document_hash, legacy.documentHash);
      const fresh = rows.find((row) => row.policy_signature !== legacy.signature);
      assert.equal(fresh.document.relationshipPairNormalizationVersion, version);
      assert.equal(fresh.document.facts.length, 0);
      assert.equal(fresh.document.evidence.length, 0);
      assert.deepEqual(
        (await snapshots(h)).find((row) => row.snapshot_id === first.snapshotId),
        oldSnapshots[0],
      );
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n,
        1,
      );
    });
    // Reopen again after the corrected empty generation is durable. A newly
    // positive enrichment callback must not revive the unchanged old source.
    h.state.valid = true;
    const hydrations = h.state.hydrations;
    await restart(h, async (runtime) => {
      await runtime.runOnce({ cutoff });
      assert.equal(h.state.hydrations, hydrations);
      await assertPair(runtime, h.metric, 0);
      assert.equal((await normalizationRows(h)).length, 2);
    });
  });

for (const variant of ["evidence-only", "marker-only", "previous-generation"])
  test(`${variant} migration hints survive before an unchanged source is rehydrated empty`, async (t) => {
    const h = await pairHarness(t);
    const cutoff = clock();
    const first = (await h.runtime.runOnce({ cutoff })).publications[0];
    const legacy = await retainLegacyPair(h, first, "exact", {
      evidenceOnly: variant === "evidence-only",
      wrapper: variant === "previous-generation" ? "previous" : "plain",
      marker: variant === "marker-only",
    });
    if (variant === "marker-only") {
      const document = { ...legacy.document, facts: [], evidence: [] };
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
        [legacy.factKey, legacy.signature, JSON.stringify(document), comparisonHash(document)],
      );
    }
    h.state.valid = false;
    const hydrations = h.state.hydrations;
    await h.runtime.runOnce({ cutoff });
    assert.ok(h.state.hydrations > hydrations);
    const rows = await normalizationRows(h);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.policy_signature === legacy.signature));
    const fresh = rows.find((row) => row.policy_signature === comparisonHash([version, currentSignature(h.config)]));
    assert.ok(fresh, "rehydration writes the new outer pair generation");
    assert.equal(fresh.document.relationshipPairNormalizationVersion, version);
    assert.equal(fresh.document.facts.length, 0);
  });

test("an unused predecessor must pass integrity and mode checks before supplying migration hints", async (t) => {
  const h = await pairHarness(t);
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const current = (await normalizationRows(h))[0];
  const signature = legacySignature(h.config);
  assert.notEqual(signature, current.policy_signature);
  const hydrations = h.state.hydrations;
  // A valid historical delivery wrapper would previously hide its plain
  // counterpart from predecessor validation. Both now supply classification
  // hints, even while the current pair generation itself remains valid.
  const otherSignature = comparisonHash([components.github.defaultDeliveryNormalizationVersion, signature]);
  const other = structuredClone(current.document);
  delete other.relationshipPairNormalizationVersion;
  other.defaultDeliveryNormalizationVersion = components.github.defaultDeliveryNormalizationVersion;
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
    [current.fact_key, otherSignature, JSON.stringify(other), comparisonHash(other)],
  );
  for (const [fault, expected] of [
    ["hash", /normalization_integrity_error/],
    ["mode", /normalization_data_mode_mismatch/],
  ]) {
    const document = structuredClone(current.document);
    delete document.relationshipPairNormalizationVersion;
    if (fault === "mode") document.isSynthetic = false;
    await h.db.query(
      "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
      [
        current.fact_key,
        signature,
        JSON.stringify(document),
        fault === "hash" ? "0".repeat(64) : comparisonHash(document),
      ],
    );
    await assert.rejects(h.runtime.runOnce({ cutoff }), expected);
    assert.equal(h.state.hydrations, hydrations, "invalid predecessor fails before any enrichment");
    assert.deepEqual(
      (await normalizationRows(h)).find((row) => row.policy_signature === current.policy_signature),
      current,
      "the valid current generation remains immutable",
    );
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
      current.fact_key,
      signature,
    ]);
  }
  await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
    current.fact_key,
    otherSignature,
  ]);
  assert.equal((await h.runtime.runOnce({ cutoff })).publications[0].snapshotId, first.snapshotId);
  assert.equal(h.state.hydrations, hydrations);
  assert.deepEqual(await normalizationRows(h), [current]);
});

test("pair and default-delivery generations compose without changing the older wrapper", async (t) => {
  const h = await pairHarness(t, { includeDelivery: true });
  const first = (await h.runtime.runOnce()).publications[0];
  const rows = await normalizationRows(h);
  assert.equal(
    rows[0].document.defaultDeliveryNormalizationVersion,
    components.github.defaultDeliveryNormalizationVersion,
  );
  assert.equal(
    rows[0].policy_signature,
    comparisonHash([
      version,
      comparisonHash([components.github.defaultDeliveryNormalizationVersion, currentSignature(h.config)]),
    ]),
  );
  assert.equal(
    h.controlsStore.read().pipelinePublications[first.snapshotId].defaultDeliveryNormalizationVersion,
    components.github.defaultDeliveryNormalizationVersion,
  );
  assert.equal(
    h.controlsStore.read().pipelinePublications[first.snapshotId].relationshipPairNormalizationVersion,
    version,
  );
  await assertPair(h.runtime, h.metric, 1);
});

test("custom output labels cannot bless an unqualified pair normalizer before or after cache creation", async (t) => {
  let calls = 0;
  const h = await pairHarness(t, {
    normalizerFactory(options) {
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: options.githubEnrich,
      });
      return async (input) => {
        calls++;
        return { ...(await builtin(input)), relationshipPairNormalizationVersion: version };
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /relationship_pair_normalizer_version_unverified/);
  assert.equal(calls, 1);
  assert.equal((await normalizationRows(h)).length, 0);
  const qualified = await createPipeline({ ...h.options, relationshipPairNormalizationVersion: version });
  try {
    await qualified.runOnce();
    await assertPair(qualified, h.metric, 1);
  } finally {
    await qualified.stop();
  }
  await assert.rejects(h.runtime.runOnce(), /relationship_pair_normalizer_version_unverified/);
});

test("an old loaded builtin cannot borrow the host option's pair version", async (t) => {
  const h = await pairHarness(t, {
    components: { ...components, github: { ...components.github, relationshipPairNormalizationVersion: undefined } },
    relationshipPairNormalizationVersion: version,
  });
  await assert.rejects(h.runtime.runOnce(), /relationship_pair_normalizer_version_unverified/);
  assert.equal((await normalizationRows(h)).length, 0);
});

test("unrelated issue generations and historical public reads keep their prior behavior", async (t) => {
  const h = await harness(t, { authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const rows = await normalizationRows(h);
  assert.ok(rows.every((row) => row.policy_signature === currentSignature(h.config)));
  assert.ok(rows.every((row) => !hasRelationshipPairMarker(row.document)));
  const before = await h.runtime.app.inject("/api/v1/boards?metric=issues_opened");
  await restart(h, async (runtime) => {
    assert.equal((await runtime.runOnce({ cutoff })).publications[0].snapshotId, first.snapshotId);
    assert.deepEqual(await normalizationRows(h), rows);
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations");
    const response = await runtime.app.inject(`/api/v1/boards?metric=issues_opened&snapshot=${first.snapshotId}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().rows, before.json().rows);
  });
});

test("operator replay binds the pair version in immutable content and rejects legacy source despite a new marker", async (t) => {
  const h = await pairHarness(t, { operator: true });
  const receipt = await queueOperatorReplay(h);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const value = await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  assert.equal(value.status, "published", value.reason);
  const publication = {
    ...value.publications[0],
    comparisonInput: { inputId: h.controlsStore.db.prepare("SELECT id FROM policy_preview_inputs").get().id },
  };
  const confirmation = h.controlsStore.read().pipelinePublications[publication.snapshotId];
  assert.equal(confirmation.relationshipPairNormalizationVersion, version);
  const legacy = await retainLegacyPair(h, publication);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[publication.snapshotId].relationshipPairNormalizationVersion = version;
    Object.values(state.pipelineHeads).forEach((head) => {
      head.relationshipPairNormalizationVersion = version;
    });
  });
  assert.equal(comparisonHash(legacy.document), legacy.documentHash);
  await restart(h, async (runtime) => {
    const result = await runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "publication_verification_unavailable");
    assert.deepEqual(result.publications, []);
  });
});

test("window-index strict confirmation supports the pair version and rejects an obsolete value", () => {
  const scope = components.contracts.canonicalPublicScope(publicScope);
  const index = createPublicationWindowIndex({
    configurationVersion: "synthetic-pair-windows",
    configurationHash: "a".repeat(64),
    dataMode: "synthetic",
    templates: [{ ...scope, period: "all" }],
    resolveMetricWindow: components.metrics.resolveMetricWindow,
  });
  const confirmation = {
    recognitionFingerprint: null,
    configurationVersion: "synthetic-pair-windows",
    configurationHash: "a".repeat(64),
    controlsConfigurationRevision: 0,
    aggregateExplanationHash: "b".repeat(64),
    dataMode: "synthetic",
    scopeKey: components.contracts.publicScopeKey(scope),
    snapshotId: "c".repeat(64),
    revision: 1,
    relationshipPairNormalizationVersion: version,
  };
  const state = {
    pipelinePublications: { [confirmation.snapshotId]: confirmation },
    pipelineHeads: { [confirmation.scopeKey]: confirmation },
  };
  assert.equal(index.record(state, scope, ["all"], confirmation), true);
  assert.equal(index.read(state, scope).windows[0].confirmation.relationshipPairNormalizationVersion, version);
  assert.throws(
    () =>
      index.record(state, scope, ["all"], {
        ...confirmation,
        relationshipPairNormalizationVersion: "relationship-pair-units/obsolete",
      }),
    /publication_window_index_integrity_error/,
  );
});

for (const component of ["contracts", "metrics"])
  test(`an old loaded ${component} component cannot produce a current pair generation`, async (t) => {
    const h = await pairHarness(t, {
      components: {
        ...components,
        [component]: { ...components[component], relationshipPairNormalizationVersion: undefined },
      },
      relationshipPairNormalizationVersion: version,
    });
    await assert.rejects(h.runtime.runOnce(), /relationship_pair_engine_version_unverified/);
    assert.equal((await normalizationRows(h)).length, 0);
  });
