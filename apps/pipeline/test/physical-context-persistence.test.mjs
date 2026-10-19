import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, clock } from "./harness.mjs";
import { physicalSource } from "./fixtures/physical-context.mjs";

const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const boardUrl = "/api/v1/boards?metric=pr_lines_added";

async function setup(t, legacy = false) {
  let calls = 0,
    stripReceipt = legacy;
  const { pull } = physicalSource();
  const h = await harness(t, {
    payloads: [pull],
    // The instrumentation wrapper delegates source decisions to the current stock adapter.
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      const policy = {
        ...config.policies[0].policy,
        metricId: "pr_lines_added",
        unit: components.metrics.getMetricDefinition("pr_lines_added").definition.unit,
        aggregation: "sum",
        roles: ["author"],
        groupBy: "canonical",
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-physical-policy" },
      ];
    },
    enrichmentFactory(client, slug) {
      return async (input) => {
        const value = physicalSource({ observedAt: input.observedAt });
        value.envelope.payload.pull_request = await client.rest("installation:1", `/repos/${slug}/pulls/1`);
        value.envelope.proof.revision = input.fact.sourceRevision;
        return value.envelope;
      };
    },
    normalizerFactory(options) {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: options.githubEnrich,
      });
      return async (input) => {
        calls++;
        const output = await normalize(input);
        assert.ok(output.physicalContext, "the actual enriched stock source must provide the receipt");
        if (stripReceipt) delete output.physicalContext;
        return output;
      };
    },
  });
  return {
    ...h,
    calls: () => calls,
    useCurrentNormalizer: () => {
      stripReceipt = false;
    },
  };
}

async function assertPrivate(runtime, snapshotId) {
  for (const path of [
    boardUrl,
    `${boardUrl}&snapshot=${snapshotId}`,
    "/api/v1/exports?metric=pr_lines_added",
    "/api/v1/exports?metric=pr_lines_added&format=csv",
  ]) {
    const response = await runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(
      response.body,
      /github-physical-context|canonicalIntegrationId|mergedEvidenceId|"physicalContexts"|"physicalEvidence"/,
    );
    if (path.startsWith(boardUrl)) assert.equal(response.json().rows[0].result.value, 17);
  }
}

test("private physical receipt survives persisted reopen and rejects rehashed foreign cache bindings", async (t) => {
  const h = await setup(t),
    cutoff = clock();
  const publication = await h.runtime.runOnce({ cutoff });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
  assert.equal(saved.length, 1);
  assert.ok(saved[0].document.physicalContext);
  assert.equal(saved[0].document.isSynthetic, true);
  assert.equal(hash(saved[0].document), saved[0].document_hash);
  await assertPrivate(h.runtime, snapshotId);
  assert.equal(h.calls(), 1);

  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  assert.equal((await reopened.runOnce({ cutoff })).state, "published");
  assert.equal(h.calls(), 1, "cached source is checked without source rehydration");
  const after = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  assert.deepEqual(after.document, saved[0].document);
  assert.equal(after.document_hash, saved[0].document_hash);
  assert.equal(after.policy_signature, saved[0].policy_signature);
  await assertPrivate(reopened, snapshotId);

  for (const field of ["factId", "canonicalKey"]) {
    const changed = structuredClone(saved[0].document);
    changed.physicalContext.facts[0][field] = `gh:${"a".repeat(64)}`;
    assert.equal(
      components.contracts.githubPhysicalContextReceiptSchema.safeParse(changed.physicalContext).success,
      true,
    );
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=$1::jsonb,document_hash=$2 WHERE fact_key=$3 AND policy_signature=$4",
      [JSON.stringify(changed), hash(changed), saved[0].fact_key, saved[0].policy_signature],
    );
    await assert.rejects(reopened.runOnce({ cutoff }), /invalid_retained_physical_context/);
    assert.equal(h.calls(), 1);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
  }
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$1::jsonb,document_hash=$2 WHERE fact_key=$3 AND policy_signature=$4",
    [JSON.stringify(saved[0].document), saved[0].document_hash, saved[0].fact_key, saved[0].policy_signature],
  );
  assert.equal((await reopened.runOnce({ cutoff })).state, "published");
  await assertPrivate(reopened, snapshotId);
});

test("receipt-less legacy cache stays absent after reopen under the current normalizer", async (t) => {
  const h = await setup(t, true),
    cutoff = clock();
  const publication = await h.runtime.runOnce({ cutoff });
  assert.equal(publication.state, "published");
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  assert.equal(saved.document.physicalContext, undefined);
  assert.equal(h.calls(), 1);
  h.useCurrentNormalizer();
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  const next = await reopened.runOnce({ cutoff });
  assert.equal(next.state, "published");
  assert.equal(h.calls(), 1, "reader version does not manufacture a new normalization");
  const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  assert.deepEqual(retained.document, saved.document);
  assert.equal(retained.document_hash, saved.document_hash);
  assert.equal(retained.policy_signature, saved.policy_signature);
  await assertPrivate(reopened, next.publications[0].snapshotId);
});

test("fresh retained reads require original cache hashes while preserving quantities and current privacy", async (t) => {
  const h = await setup(t);
  const publication = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const retainedSnapshot = async () =>
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
        snapshotId,
      ])
    ).rows[0];
  const originalSnapshot = await retainedSnapshot();
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  const originalReads = structuredClone(h.githubReads);
  let runtime = h.runtime;
  t.after(() => runtime.stop());
  const reopen = async () => {
    await runtime.stop();
    await h.reopenDatabase();
    runtime = await createPipeline(h.options);
  };
  const restore = () =>
    h.db.query(
      `INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash)
     VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(fact_key,policy_signature)
     DO UPDATE SET document=excluded.document,document_hash=excluded.document_hash`,
      [saved.fact_key, saved.policy_signature, JSON.stringify(saved.document), saved.document_hash],
    );
  const read = async () => {
    const rows = [];
    for (const path of [
      boardUrl,
      `${boardUrl}&snapshot=${snapshotId}`,
      `/api/v1/exports?metric=pr_lines_added&snapshot=${snapshotId}&format=json`,
    ]) {
      const response = await runtime.app.inject(path);
      assert.equal(response.statusCode, 200, response.body);
      assert.doesNotMatch(response.body, /github-physical-context|canonicalIntegrationId|mergedEvidenceId/);
      rows.push(response.json().rows);
    }
    const csv = await runtime.app.inject(`/api/v1/exports?metric=pr_lines_added&snapshot=${snapshotId}&format=csv`);
    assert.equal(csv.statusCode, 200, csv.body);
    assert.doesNotMatch(csv.body, /github-physical-context|canonicalIntegrationId|mergedEvidenceId/);
    return { rows, csv: csv.body };
  };
  const readUnavailable = async () => {
    const statuses = [];
    for (const path of [
      boardUrl,
      `${boardUrl}&snapshot=${snapshotId}`,
      `/api/v1/exports?metric=pr_lines_added&snapshot=${snapshotId}&format=json`,
      `/api/v1/exports?metric=pr_lines_added&snapshot=${snapshotId}&format=csv`,
    ]) {
      const response = await runtime.app.inject(path);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
      statuses.push(response.statusCode);
    }
    return statuses;
  };
  const original = await read();
  for (const rows of original.rows) {
    assert.equal(rows[0].result.value, 17);
    assert.equal(rows[0].physicalContext.state, "available");
  }
  await reopen();
  assert.deepEqual(await read(), original, "a fresh read binds the same retained source without collection");

  const changed = structuredClone(saved.document);
  changed.physicalContext.before = "d".repeat(40);
  assert.equal(
    components.contracts.githubPhysicalContextReceiptSchema.safeParse(changed.physicalContext).success,
    true,
  );
  assert.notEqual(hash(changed), saved.document_hash);
  const observed = [];
  for (const variant of ["deleted", "corrupt_original_hash", "coherently_rehashed_substitution"]) {
    await restore();
    if (variant === "deleted")
      await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
        saved.fact_key,
        saved.policy_signature,
      ]);
    else
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$1::jsonb,document_hash=$2 WHERE fact_key=$3 AND policy_signature=$4",
        [
          JSON.stringify(changed),
          variant === "corrupt_original_hash" ? saved.document_hash : hash(changed),
          saved.fact_key,
          saved.policy_signature,
        ],
      );
    await reopen();
    // These original normalization copies also establish mandatory default-delivery
    // authority. Optional physical context cannot keep an invalid publication visible.
    observed.push({
      variant,
      statuses: await readUnavailable(),
    });
    assert.deepEqual(
      await retainedSnapshot(),
      originalSnapshot,
      "missing normalization authority never rewrites the selected snapshot or its stored quantities",
    );
  }
  await restore();
  await reopen();
  assert.deepEqual(await read(), original, "restoring the exact original hash restores only the optional context");
  h.controlsStore.transaction(
    (state) => {
      state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
    },
    { publish: true },
  );
  await reopen();
  const hidden = await read();
  assert.deepEqual(hidden.rows, [[], [], []]);
  assert.doesNotMatch(hidden.csv, /beforeUrl|afterUrl|sampleCount|unitCount|summary/);
  assert.deepEqual(await retainedSnapshot(), originalSnapshot);
  assert.equal(h.calls(), 1, "public checks never rehydrate or invoke the normalizer");
  assert.deepEqual(h.githubReads, originalReads, "public checks grant no source reads or token lookup");
  assert.deepEqual(
    observed,
    ["deleted", "corrupt_original_hash", "coherently_rehashed_substitution"].map((variant) => ({
      variant,
      statuses: [503, 503, 503, 503],
    })),
  );
});
