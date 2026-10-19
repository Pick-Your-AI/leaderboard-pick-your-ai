// Fictional REST responses and a disposable database exercise a private cache
// upgrade. This records no real release, participant review, or source permission.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ScanContinuationStore } from "../src/scan-continuation.mjs";
import { configurationOverlay } from "../../controls/src/overlay.mjs";
import { components, harness, publicScope } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";

const slug = "example-org/example-repo";
const prefix = `/repos/${slug}`;
const api = "https://api.fixture.invalid";
const mergeSha = "b".repeat(40),
  tagSha = "c".repeat(40);
const iso = (value) => new Date(value).toISOString();
const elapsed = (value, milliseconds) => iso(Date.parse(value) + milliseconds);

function transport() {
  const mergedAt = iso(Date.now() - 86_400_000);
  const repository = {
    id: 2,
    node_id: "R_clock_fixture",
    full_name: slug,
    private: false,
    visibility: "public",
    default_branch: "main",
    url: `${api}${prefix}`,
  };
  const pull = {
    id: 10,
    node_id: "PR_clock_fixture",
    number: 10,
    url: `${api}${prefix}/pulls/10`,
    html_url: `https://github.com/${slug}/pull/10`,
    created_at: elapsed(mergedAt, -60_000),
    updated_at: mergedAt,
    state: "closed",
    merged: true,
    draft: false,
    merged_at: mergedAt,
    merge_commit_sha: mergeSha,
    base: { ref: "main", repo: repository },
    user: { id: 101, node_id: "U_clock_fixture", login: "fixture-author", type: "User" },
  };
  const state = { logicalTime: null, publishedAt: null, calls: [], events: [] };
  const now = () => {
    const at = state.logicalTime ?? new Date().toISOString();
    state.events.push({ kind: "clock", at });
    return at;
  };
  const client = new components.github.GithubReadClient({
    apiOrigin: api,
    token: async () => "fixture-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value, options) => {
      assert.equal(options?.method ?? "GET", "GET");
      const url = new URL(value),
        path = url.pathname + url.search;
      if (state.logicalTime) state.logicalTime = elapsed(state.logicalTime, 10);
      state.calls.push(path);
      state.events.push({ kind: "http", path, at: state.logicalTime ?? new Date().toISOString() });
      let body;
      if (path === prefix) body = repository;
      else if (path === `${prefix}/pulls/10`) body = pull;
      else if (path === `${prefix}/releases/700`) {
        assert.ok(state.publishedAt, "a release lookup cannot precede this fixture's publication");
        body = {
          id: 700,
          node_id: "RE_clock_fixture",
          url: `${api}${prefix}/releases/700`,
          immutable: true,
          draft: false,
          prerelease: false,
          published_at: state.publishedAt,
          tag_name: "v-clock",
        };
      } else if (path === `${prefix}/git/ref/tags/v-clock`)
        body = {
          ref: "refs/tags/v-clock",
          node_id: "REF_clock_fixture",
          url: `${api}${prefix}/git/refs/tags/v-clock`,
          object: { type: "commit", sha: tagSha, url: `${api}${prefix}/git/commits/${tagSha}` },
        };
      else if (path === `${prefix}/compare/${mergeSha}...${tagSha}?per_page=1&page=1`)
        body = {
          url: `${api}${prefix}/compare/${mergeSha}...${tagSha}`,
          base_commit: { sha: mergeSha },
          merge_base_commit: { sha: mergeSha },
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
        };
      else assert.fail(`unexpected normalization transport path: ${path}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { client, now, state, pull };
}

const digest = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const sourceRows = async (db) =>
  (
    await db.query(
      "SELECT fact_key,source_revision,observed_at,document,first_run_id FROM leaderboard_ingestion.source_facts WHERE repository_id=2 AND family='pull_requests' ORDER BY fact_key",
    )
  ).rows.map((row) => ({ ...row, observed_at: iso(row.observed_at) }));
const scans = async (db) =>
  (
    await db.query(
      "SELECT configuration_key,context_hash,cycle_token,event_cutoff,observation_cutoff,scope_heads FROM leaderboard_pipeline.scan_continuations ORDER BY configuration_key",
    )
  ).rows.map((row) => ({
    ...row,
    event_cutoff: iso(row.event_cutoff),
    observation_cutoff: row.observation_cutoff === null ? null : iso(row.observation_cutoff),
  }));
const cache = async (db, factKey, signature) =>
  (
    await db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2",
      [factKey, signature],
    )
  ).rows[0];

// Literal preceding 4d release-v2 cache identity. It deliberately does not call
// today's cache-key implementation or acquire today's default-delivery wrapper.
const precedingReleaseSignature = (config) =>
  digest([
    "github-release-inclusion/v2",
    digest([
      "project-membership-context/v1",
      digest([
        "verified-default-branch-merge-pins/v1",
        digest([
          "pipeline-private-attribution/v1",
          digest(["current-state-selection-v1", "public", config.policies.map((entry) => entry.signature)]),
        ]),
      ]),
      [],
    ]),
    config.releaseInclusionTargets,
  ]);

// The accepted Project scope upgrade has its own current generation. Keep the
// literal preceding 4d oracle above unchanged for the persisted-token regression.
const currentProjectReleaseSignature = (config) =>
  digest([
    "github-release-inclusion/v2",
    digest([
      "project-membership-context/v2",
      digest([
        "verified-default-branch-merge-pins/v1",
        digest([
          "pipeline-private-attribution/v1",
          digest(["current-state-selection-v1", "public", config.policies.map((entry) => entry.signature)]),
        ]),
      ]),
      [],
    ]),
    config.releaseInclusionTargets,
  ]);

async function assertAutomaticPublication(runtime, publication) {
  assert.equal(publication.state, "published");
  assert.equal(publication.publications.length, 1);
  const read = await runtime.source.read(
    publicScope,
    publication.publications[0].snapshotId,
    new AbortController().signal,
  );
  assert.ok(read);
  assert.equal(read.selected.rows.find((row) => row.result.metricId === "pr_merged")?.result.value, 1);
  assert.equal(
    read.selected.rows.some((row) => row.result.metricId === "release_changes"),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(read.selected),
    /releaseInclusions|proofHash|annotatedTags|defaultDeliveryNormalizationVersion/,
  );
}

test("release cache upgrade: a frozen legacy v2 scan without manual bindings retires for the delivery generation and current frozen replay never recollects", async (t) => {
  const provider = transport();
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [provider.pull],
    githubClient: provider.client,
    now: provider.now,
    probeRepository: async () => ({
      repositoryId: 2,
      installationId: 1,
      visibility: "public",
      checkedAt: provider.now(),
    }),
    configure(config) {
      const policy = {
        metricId: "pr_merged",
        version: "pr-merged-generation-v1",
        definitionVersion: components.metrics.metricRegistryV1.policy_version,
        unit: components.metrics.getMetricDefinition("pr_merged").definition.unit,
        aggregation: "count",
        dateBasis: "occurredAt",
        rankedStates: ["observed"],
        roles: ["author"],
        groupBy: "actor_artifact",
        sources: ["github_rest"],
        minimumSamples: 1,
        rank: true,
      };
      config.repositories[0].families = ["pull_requests"];
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-policy-approval" },
      ];
      config.recognitionBindings = [];
    },
  });
  assert.equal(h.options.normalizer, undefined);
  assert.equal(h.options.githubEnrich, undefined);
  await assertAutomaticPublication(h.runtime, await h.runtime.runOnce({ cutoff: iso(Date.now() - 1_000) }));
  const originals = await sourceRows(h.db);
  assert.equal(originals.length, 1);
  const original = originals[0];
  assert.equal(original.source_revision, provider.pull.updated_at);
  assert.equal(
    provider.state.calls.some((path) => path.includes("/releases/")),
    false,
  );
  await h.runtime.stop();

  provider.state.publishedAt = elapsed(original.observed_at, 60_000);
  provider.state.logicalTime = elapsed(original.observed_at, 120_000);
  const config = structuredClone(h.config);
  config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }];
  assert.deepEqual(config.recognitionBindings, []);
  assert.deepEqual(Object.values(h.controlsStore.read().requests ?? {}), []);
  const recordQuery = (query, sql, parameters) => {
    if (sql.includes("SET context_hash=$2,cycle_token=$3"))
      provider.state.events.push({
        kind: "scan-context",
        token: parameters[2],
        contextHash: parameters[1],
        at: parameters[3],
      });
    if (sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff"))
      provider.state.events.push({ kind: "freeze", at: parameters[1] });
    return query(sql, parameters);
  };
  const database = {
    query: (sql, parameters) => recordQuery(h.db.query.bind(h.db), sql, parameters),
    transaction: (work) =>
      h.db.transaction((tx) => work({ query: (sql, parameters) => recordQuery(tx.query.bind(tx), sql, parameters) })),
  };
  const runtime = await createPipeline({ ...h.options, config, db: database });
  t.after(() => runtime.stop());

  // First collect a real stock-normalizer product for the fictional source. Only
  // the explicit fixture writes below reconstruct its preceding serialized cache
  // generation; no caller supplies inclusion flags or a custom normalizer result.
  await assertAutomaticPublication(runtime, await runtime.runOnce());
  assert.deepEqual(await sourceRows(h.db), originals);
  assert.deepEqual(await scans(h.db), []);
  const oldSignature = precedingReleaseSignature(config);
  assert.equal(components.github.defaultDeliveryNormalizationVersion, "default-delivery-scope/v1");
  const currentSignature = digest(["default-delivery-scope/v1", currentProjectReleaseSignature(config)]);
  const collected = await cache(h.db, original.fact_key, currentSignature);
  assert.ok(collected);
  assert.equal(digest(collected.document), collected.document_hash);
  assert.equal(collected.document.defaultDeliveryNormalizationVersion, "default-delivery-scope/v1");
  assert.equal(collected.document.releaseInclusions.length, 1);
  assert.equal(collected.document.facts.find((fact) => fact.metricId === "pr_merged").observedAt, original.observed_at);
  components.github.validateGithubReleaseInclusion(collected.document.releaseInclusions[0]);
  assert.ok(Date.parse(collected.document.releaseInclusions[0].observedAt) > Date.parse(original.observed_at));

  const legacyDocument = structuredClone(collected.document);
  delete legacyDocument.defaultDeliveryNormalizationVersion;
  const legacy = {
    ...collected,
    policy_signature: oldSignature,
    document: legacyDocument,
    document_hash: digest(legacyDocument),
  };
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$5",
    [original.fact_key, oldSignature, JSON.stringify(legacyDocument), legacy.document_hash, currentSignature],
  );
  assert.deepEqual(await cache(h.db, original.fact_key, oldSignature), legacy);
  assert.equal(await cache(h.db, original.fact_key, currentSignature), undefined);
  const sources = (
    await h.db.query(
      "SELECT repository_id,generation FROM leaderboard_ingestion.repository_access WHERE state='public' ORDER BY repository_id",
    )
  ).rows.map((row) => ({ repositoryId: Number(row.repository_id), generation: String(row.generation) }));
  const revision = configurationOverlay(h.controlsStore.read()).revision;
  const key = digest(["bounded-scan/v1", config, "public", "reconcile"]);
  // Literal 4d context: no manual bindings means recognition authority is null.
  // The unchanged source revisions alone cannot reveal a cache-generation move.
  const oldContext = digest([revision, null, sources, oldSignature]);
  const currentContext = digest([revision, null, sources, currentSignature]);
  assert.notEqual(oldContext, currentContext);
  const store = new ScanContinuationStore(h.db);
  const oldCutoff = elapsed(collected.document.releaseInclusions[0].observedAt, 1);
  let historical = await store.claim(
    { key, contextHash: oldContext, cutoff: oldCutoff, sources },
    () => {},
    () => oldCutoff,
    () => [components.contracts.publicScopeKey(publicScope)],
  );
  historical = await store.freeze(historical, elapsed(oldCutoff, 1), () => {});
  assert.equal((await scans(h.db))[0].cycle_token, historical.token);
  assert.ok(Date.parse(legacy.document.releaseInclusions[0].observedAt) <= Date.parse(historical.observationCutoff));
  provider.state.logicalTime = elapsed(historical.observationCutoff, 60_000);
  provider.state.calls.length = 0;
  provider.state.events.length = 0;

  // Regression boundary: a naive source union reuses the old frozen token and
  // throws release_inclusion_frozen_normalization_unavailable here indefinitely.
  const publication = await runtime.runOnce();
  await assertAutomaticPublication(runtime, publication);
  const replaced = provider.state.events.find((event) => event.kind === "scan-context");
  assert.ok(replaced, "the incompatible persisted context must be atomically replaced");
  assert.equal(replaced.contextHash, currentContext);
  assert.notEqual(replaced.token, historical.token);
  const current = await cache(h.db, original.fact_key, currentSignature);
  assert.ok(current);
  assert.equal(digest(current.document), current.document_hash);
  assert.equal(current.document.defaultDeliveryNormalizationVersion, "default-delivery-scope/v1");
  const proof = current.document.releaseInclusions[0];
  assert.ok(Date.parse(proof.observedAt) > Date.parse(historical.observationCutoff));
  const lastHttp = provider.state.events.findLastIndex((event) => event.kind === "http");
  const freeze = provider.state.events.findLastIndex((event) => event.kind === "freeze");
  assert.ok(lastHttp >= 0, "the replacement must collect under the current generation");
  assert.ok(freeze > lastHttp, "all proof HTTP must complete before the replacement cutoff is frozen");
  assert.ok(Date.parse(proof.observedAt) >= Date.parse(provider.state.events[lastHttp].at));
  assert.ok(Date.parse(proof.observedAt) <= Date.parse(provider.state.events[freeze].at));
  assert.deepEqual(
    await cache(h.db, original.fact_key, oldSignature),
    legacy,
    "the preceding cache is immutable history",
  );
  assert.deepEqual(await sourceRows(h.db), originals);
  assert.equal(configurationOverlay(h.controlsStore.read()).revision, revision);
  assert.deepEqual(await scans(h.db), []);

  // An already-current frozen context must still fail closed when its compatible
  // cache disappears. The older valid cache cannot justify post-cutoff HTTP.
  provider.state.logicalTime = elapsed(provider.state.logicalTime, 60_000);
  const replayCutoff = provider.now();
  let pending = await store.claim(
    { key, contextHash: currentContext, cutoff: replayCutoff, sources },
    () => {},
    () => replayCutoff,
    () => [components.contracts.publicScopeKey(publicScope)],
  );
  pending = await store.freeze(pending, elapsed(replayCutoff, 1), () => {});
  const retainedScan = await scans(h.db);
  await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
    original.fact_key,
    currentSignature,
  ]);
  const calls = [...provider.state.calls];
  provider.state.logicalTime = elapsed(pending.observationCutoff, 60_000);
  await assert.rejects(runtime.runOnce(), /release_inclusion_frozen_normalization_unavailable/);
  assert.deepEqual(provider.state.calls, calls);
  assert.deepEqual(await scans(h.db), retainedScan);
  assert.deepEqual(await cache(h.db, original.fact_key, oldSignature), legacy);
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
    [original.fact_key, currentSignature, JSON.stringify(current.document), current.document_hash],
  );
  const replay = await runtime.runOnce();
  await assertAutomaticPublication(runtime, replay);
  assert.deepEqual(provider.state.calls, calls, "compatible frozen replay must not recollect");
  assert.deepEqual(await cache(h.db, original.fact_key, currentSignature), current);
  assert.deepEqual(await cache(h.db, original.fact_key, oldSignature), legacy);
  assert.deepEqual(await sourceRows(h.db), originals);
  assert.deepEqual(await scans(h.db), []);
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      replay.publications[0].snapshotId,
    ])
  ).rows[0].document;
  assert.equal(frozen.frozen.cutoff, pending.observationCutoff);
});

// These fictional collected PR records are copied under each retained wrapper
// solely to test frozen identity lookup. The copies do not claim review or
// Discussion collection, a real release, or fresh publication authority.
for (const [generation, wrappers] of [
  ["base", []],
  ["review", [components.github.reviewSourceNormalizationVersion]],
  ["Discussion", [components.github.discussionSourceNormalizationVersion]],
  ["delivery", [components.github.defaultDeliveryNormalizationVersion]],
  [
    "review delivery",
    [components.github.reviewSourceNormalizationVersion, components.github.defaultDeliveryNormalizationVersion],
  ],
  [
    "Discussion delivery",
    [components.github.discussionSourceNormalizationVersion, components.github.defaultDeliveryNormalizationVersion],
  ],
])
  test(`retained public release Project v1 ${generation} identity survives the v2 scope upgrade without new HTTP`, async (t) => {
    const provider = transport();
    provider.state.publishedAt = elapsed(provider.pull.merged_at, 1_000);
    const h = await harness(t, {
      markerFreeConfig: true,
      dataMode: "public",
      payloads: [provider.pull],
      githubClient: provider.client,
      now: provider.now,
      authorizePolicyPreview: async () => true,
      policyComparisonAuthorityCurrent: () => true,
      probeRepository: async () => ({
        repositoryId: 2,
        installationId: 1,
        visibility: "public",
        checkedAt: provider.now(),
      }),
      configure(config) {
        const policy = {
          metricId: "pr_merged",
          version: "pr-merged-retained-release-v1",
          definitionVersion: components.metrics.metricRegistryV1.policy_version,
          unit: components.metrics.getMetricDefinition("pr_merged").definition.unit,
          aggregation: "count",
          dateBasis: "occurredAt",
          rankedStates: ["observed"],
          roles: ["author"],
          groupBy: "actor_artifact",
          sources: ["github_rest"],
          minimumSamples: 1,
          rank: true,
        };
        config.repositories[0].families = ["pull_requests"];
        config.policies = [
          { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-policy-approval" },
        ];
        config.recognitionBindings = [];
        config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }];
      },
    });
    const publication = await h.runtime.runOnce();
    await assertAutomaticPublication(h.runtime, publication);
    const request = {
      snapshotId: publication.publications[0].snapshotId,
      policy: { ...h.config.policies[0].policy, version: "retained-release-project-preview", rank: false },
      operatorId: "201",
    };
    const before = await h.runtime.previewPolicy(request);
    const originals = await sourceRows(h.db);
    const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(
      row.policy_signature,
      digest([components.github.defaultDeliveryNormalizationVersion, currentProjectReleaseSignature(h.config)]),
    );
    components.github.validateGithubReleaseInclusion(row.document.releaseInclusions[0]);
    const signature = wrappers.reduce(
      (value, version) => digest([version, value]),
      precedingReleaseSignature(h.config),
    );
    assert.notEqual(signature, row.policy_signature);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
      [row.fact_key, signature, row.policy_signature],
    );
    const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
    const frozen = (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id")).rows;
    const calls = [...provider.state.calls];
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    assert.deepEqual(await restarted.previewPolicy(request), before);
    assert.deepEqual(provider.state.calls, calls);
    assert.deepEqual(await sourceRows(h.db), originals);
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
      retained,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id")).rows,
      frozen,
    );
    assert.doesNotMatch(
      JSON.stringify(before),
      /releaseInclusions|proofHash|normalizationSources|factKey|documentHash/,
    );
    await h.db.query(
      `UPDATE leaderboard_pipeline.normalizations SET document=jsonb_set(document,'{actors,0,githubNodeId}','"U_TAMPERED"'::jsonb) WHERE fact_key=$1 AND policy_signature=$2`,
      [row.fact_key, signature],
    );
    await assert.rejects(restarted.previewPolicy(request), /Frozen identity evidence integrity failure/);
  });

// The preceding host allowed these Project v2 family keys while an optional
// release selection was present but not yet wrapped. As above, this fixture
// rekeys a current fictional document only to isolate frozen identity lookup;
// it does not claim an old stock producer emitted this release-proof document.
for (const [generation, wrappers] of [
  ["review", [components.github.reviewSourceNormalizationVersion]],
  ["Discussion", [components.github.discussionSourceNormalizationVersion]],
  [
    "review delivery",
    [components.github.reviewSourceNormalizationVersion, components.github.defaultDeliveryNormalizationVersion],
  ],
  [
    "Discussion delivery",
    [components.github.discussionSourceNormalizationVersion, components.github.defaultDeliveryNormalizationVersion],
  ],
])
  test(`retained public Project v2 ${generation} identity survives selected release generation without new HTTP`, async (t) => {
    const provider = transport();
    provider.state.publishedAt = elapsed(provider.pull.merged_at, 1_000);
    const h = await harness(t, {
      markerFreeConfig: true,
      dataMode: "public",
      payloads: [provider.pull],
      githubClient: provider.client,
      now: provider.now,
      authorizePolicyPreview: async () => true,
      policyComparisonAuthorityCurrent: () => true,
      probeRepository: async () => ({
        repositoryId: 2,
        installationId: 1,
        visibility: "public",
        checkedAt: provider.now(),
      }),
      configure(config) {
        const policy = {
          metricId: "pr_merged",
          version: "pr-merged-retained-project-v2",
          definitionVersion: components.metrics.metricRegistryV1.policy_version,
          unit: components.metrics.getMetricDefinition("pr_merged").definition.unit,
          aggregation: "count",
          dateBasis: "occurredAt",
          rankedStates: ["observed"],
          roles: ["author"],
          groupBy: "actor_artifact",
          sources: ["github_rest"],
          minimumSamples: 1,
          rank: true,
        };
        config.repositories[0].families = ["pull_requests"];
        config.policies = [
          { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-policy-approval" },
        ];
        config.recognitionBindings = [];
        config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }];
      },
    });
    assert.equal(h.options.normalizer, undefined);
    assert.equal(h.options.githubEnrich, undefined);
    const publication = await h.runtime.runOnce();
    await assertAutomaticPublication(h.runtime, publication);
    const request = {
      snapshotId: publication.publications[0].snapshotId,
      policy: { ...h.config.policies[0].policy, version: "retained-project-v2-release-preview", rank: false },
      operatorId: "201",
    };
    const before = await h.runtime.previewPolicy(request);
    const originals = await sourceRows(h.db);
    const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(
      row.policy_signature,
      digest([components.github.defaultDeliveryNormalizationVersion, currentProjectReleaseSignature(h.config)]),
    );
    assert.equal(row.document_hash, digest(row.document));
    components.github.validateGithubReleaseInclusion(row.document.releaseInclusions[0]);
    // Literal pre-release Project v2 key, independent of the receiving runtime.
    const projectSignature = digest([
      "project-membership-context/v2",
      digest([
        "verified-default-branch-merge-pins/v1",
        digest([
          "pipeline-private-attribution/v1",
          digest(["current-state-selection-v1", "public", h.config.policies.map((entry) => entry.signature)]),
        ]),
      ]),
      [],
    ]);
    const signature = wrappers.reduce((value, version) => digest([version, value]), projectSignature);
    assert.notEqual(signature, row.policy_signature);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
      [row.fact_key, signature, row.policy_signature],
    );
    const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
    assert.deepEqual(retained, [{ ...row, policy_signature: signature }]);
    const frozen = (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id")).rows;
    const snapshots = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows;
    const calls = [...provider.state.calls];
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    assert.deepEqual(await restarted.previewPolicy(request), before);
    assert.deepEqual(provider.state.calls, calls);
    assert.deepEqual(await sourceRows(h.db), originals);
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
      retained,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id")).rows,
      frozen,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows,
      snapshots,
    );
    assert.doesNotMatch(
      JSON.stringify(before),
      /releaseInclusions|proofHash|normalizationSources|factKey|documentHash/,
    );
    await h.db.query(
      `UPDATE leaderboard_pipeline.normalizations SET document=jsonb_set(document,'{actors,0,githubNodeId}','"U_TAMPERED"'::jsonb) WHERE fact_key=$1 AND policy_signature=$2`,
      [row.fact_key, signature],
    );
    await assert.rejects(restarted.previewPolicy(request), /Frozen identity evidence integrity failure/);
    assert.deepEqual(provider.state.calls, calls);
  });
