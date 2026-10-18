import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadPipelineComponents,
  createPipeline,
  migratePipeline,
  createGithubCollectionSource,
} from "../src/index.mjs";

const checkout = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const roots = process.env.PIPELINE_COMPONENT_ROOTS ? JSON.parse(process.env.PIPELINE_COMPONENT_ROOTS) : {};
const ingestionRoot = roots.ingestion ?? checkout;
const require = createRequire(join(ingestionRoot, "packages/ingestion/package.json"));
const { PGlite } = require("@electric-sql/pglite");
const components = await loadPipelineComponents(roots);
const clock = () => new Date().toISOString();
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const fixtureId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const publicScope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
const boardUrl = "/api/v1/boards?metric=issues_opened";

async function harness(t, extra = {}) {
  const slug = extra.markerFreeConfig ? "example-org/example-repo" : "synthetic-org/synthetic-repo";
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-pipeline-"));
  const engine = new PGlite(join(directory, "postgres"));
  const db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  };
  for (const name of [
    "001_ingestion.up.sql",
    "002_snapshots.up.sql",
    "003_collection.up.sql",
    "004_outbox_dispatch.up.sql",
  ])
    await engine.exec(await readFile(join(ingestionRoot, "packages/ingestion/sql", name), "utf8"));
  await migratePipeline(db);
  const controlsStore = new components.controls.ControlStore(join(directory, "controls.sqlite"));
  const policy = {
    metricId: "issues_opened",
    version: "synthetic-policy-v1",
    definitionVersion: components.metrics.metricRegistryV1.policy_version,
    unit: components.metrics.getMetricDefinition("issues_opened").definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["reporter"],
    groupBy: "actor_artifact",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: true,
  };
  const config = {
    version: "synthetic-configuration-v1",
    organization: "Pick-Your-AI",
    approvalReceipt: "synthetic-config-approval",
    repositories: [
      { id: 2, installationId: 1, slug, families: ["issues"], approvalReceipt: "synthetic-source-approval" },
    ],
    policies: [
      { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-metric-approval" },
    ],
    scopes: [publicScope],
  };
  if (extra.markerFreeConfig) {
    config.version = "configuration-v1";
    config.approvalReceipt = "config-approval";
    config.repositories[0].approvalReceipt = "source-approval";
    policy.version = "policy-v1";
    config.policies[0].approvalReceipt = "policy-approval";
    config.policies[0].signature = components.metrics.stableJSON(policy);
  }
  let privateRepository = false;
  let fixturePage = false;
  let sourceFailure = false;
  let payloads = [
    {
      id: 1001,
      node_id: "SYNTHETIC_ISSUE_1",
      number: 1,
      html_url: `https://github.com/${slug}/issues/1`,
      created_at: ago(2),
      updated_at: ago(1),
      user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
    },
    {
      id: 1002,
      node_id: "SYNTHETIC_ISSUE_2",
      number: 2,
      html_url: `https://github.com/${slug}/issues/2`,
      created_at: ago(45),
      updated_at: ago(1),
      user: { id: 102, node_id: "U_SYNTHETIC_B", login: "synthetic-bob", type: "User" },
    },
  ];
  const githubClient = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    checkpoints: new components.github.FileCheckpointStore(join(directory, "http-checkpoints")),
    maxRetries: 0,
    fetch: async (value) => {
      const url = new URL(value);
      if (sourceFailure) throw new Error("synthetic unavailable source");
      const repository = { id: 2, private: privateRepository, full_name: slug, default_branch: "main" };
      let body;
      if (url.pathname === `/repos/${slug}`) body = repository;
      else if (url.pathname === `/repos/${slug}/issues`) body = payloads;
      else {
        const number = Number(url.pathname.match(/\/issues\/(\d+)$/)?.[1]);
        body = payloads.find((payload) => payload.number === number);
      }
      return new Response(JSON.stringify(body ?? { message: "not found" }), {
        status: body ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const source = {
    async readPage(request) {
      const items = await githubClient.rest("installation:1", `/repos/${slug}/issues`);
      return {
        repositoryId: 2,
        visibility: "public",
        isSynthetic: fixturePage,
        nextCursor: null,
        expectedCount: items.length,
        facts: items.map((item) => ({
          subjectId: item.node_id,
          sourceRevision: item.updated_at,
          sourceUrl: item.html_url,
          evidence: "current_state",
          actorId: null,
          occurredAt: null,
          state: "open",
        })),
      };
    },
  };
  const options = {
    components,
    db,
    controlsStore,
    githubClient,
    sourceId: "installation:1",
    source,
    config,
    dataMode: "synthetic",
    cursorSecret: "synthetic-cursor-secret-is-at-least-32-characters",
    verifyConfiguration: async (value) => value.approvalReceipt === config.approvalReceipt,
    authorizeCorrection: async (value) =>
      value.operatorId === "201" && value.approvalReceipt === "synthetic-correction-approval",
    probeRepository: async (repo) => {
      const value = await githubClient.rest("installation:1", `/repos/${repo.slug}`);
      return {
        repositoryId: value.id,
        installationId: repo.installationId,
        visibility: value.private ? "private" : "public",
        checkedAt: clock(),
      };
    },
    ...extra,
  };
  const runtime = await createPipeline(options);
  t.after(async () => {
    await runtime.stop();
    controlsStore.close();
    await engine.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^leaderboard-pipeline-/);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime,
    db,
    controlsStore,
    options,
    engine,
    directory,
    setPrivate(value) {
      privateRepository = value;
    },
    setSourceFailure(value) {
      sourceFailure = value;
    },
    setFixturePage(value) {
      fixturePage = value;
    },
    duplicate() {
      payloads = payloads.map((payload) => ({ ...payload, updated_at: clock() }));
    },
    add(payload) {
      payloads.push(payload);
    },
    config,
  };
}

async function getBoard(runtime, suffix = "") {
  const response = await runtime.app.inject(boardUrl + suffix);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("unapproved configuration fails closed before collection or public publication", async (t) => {
  const h = await harness(t, { verifyConfiguration: async () => false });
  assert.deepEqual(await h.runtime.runOnce(), { state: "blocked", reason: "approved_configuration_required" });
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 0);
});

test("actual source transport, collection, normalizer, metric engine and API preserve all-time evidence and replay duplicates", async (t) => {
  const h = await harness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  assert.equal(first.state, "published");
  assert.equal(first.publications[0].changed, true);
  const board = await getBoard(h.runtime);
  assert.deepEqual(
    board.rows.map((row) => [row.actorId, row.result.value, row.rank]),
    [
      ["101", 1, 1],
      ["102", 1, 1],
    ],
  );
  assert.equal(board.coverage[0].state, "partial");
  assert.match(board.computationVersion, /^synthetic-pipeline-/);
  assert.equal(board.methodology[0].policyVersion, "synthetic-policy-v1");
  const repeated = await h.runtime.runOnce({ cutoff });
  assert.equal(repeated.publications[0].changed, false);
  h.duplicate();
  const late = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(late.state, "published");
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => row.result.value),
    [1, 1],
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 4);
  const receipts = await h.runtime.receipts();
  assert.equal(receipts.filter((receipt) => receipt.kind === "snapshot_published").length >= 1, true);
});

test("current server-side privacy overlay applies to pinned API, evidence, exports and live reads immediately", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime),
    pin = before.snapshotId;
  const evidenceId = before.rows.find((row) => row.actorId === "101").evidenceIds[0];
  h.controlsStore.transaction(
    (state) => {
      state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
    },
    { publish: true },
  );
  const after = await getBoard(h.runtime, `&snapshot=${pin}`);
  assert.deepEqual(
    after.rows.map((row) => row.actorId),
    ["102"],
  );
  assert.notEqual(after.policyVersion, before.policyVersion);
  const profile = await h.runtime.app.inject(`/api/v1/contributors/101?snapshot=${pin}`);
  assert.equal(profile.statusCode, 404);
  assert.equal((await h.runtime.app.inject(`/api/v1/evidence/${evidenceId}?snapshot=${pin}`)).statusCode, 404);
  const exported = await h.runtime.app.inject(`/api/v1/exports?metric=issues_opened&format=csv&snapshot=${pin}`);
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.body.includes("synthetic-alice"), false);
  const live = await h.runtime.app.inject("/api/v1/updates");
  assert.equal(live.statusCode, 200);
  assert.equal(live.body.includes(after.policyVersion), true);
});

test("reviewed correction persists receipts, overlays old snapshots, recomputes, and binds exact retries", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime);
  const factId = before.rows.find((row) => row.actorId === "101").evidenceIds[0];
  const requestId = fixtureId(50);
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "102",
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      status: "pending",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  await assert.rejects(h.runtime.applyCorrection({ ...decision, operatorId: "102" }), /not_authorized/);
  const applied = await h.runtime.applyCorrection(decision);
  assert.equal(applied.status, "applied");
  const receiptCount = (await h.runtime.receipts()).length;
  assert.deepEqual(await h.runtime.applyCorrection(decision), applied);
  assert.equal((await h.runtime.receipts()).length, receiptCount);
  await assert.rejects(h.runtime.applyCorrection({ ...decision, expectedVersion: 9 }), /retry_mismatch/);
  assert.deepEqual(
    (await getBoard(h.runtime, `&snapshot=${before.snapshotId}`)).rows.map((row) => row.actorId),
    ["102"],
  );
  await h.runtime.runOnce();
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => row.actorId),
    ["102"],
  );
  assert.equal(h.controlsStore.read().requests[requestId].status, "applied");
  assert.equal(
    (await h.runtime.receipts()).some((receipt) => receipt.kind === "correction_applied"),
    true,
  );
});

test("signed lifecycle revocation blocks historical and current API, exports and live projections", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime);
  assert.equal(await h.runtime.collection.suppress(fixtureId(70), "a".repeat(64), 1, [2], "revoked"), "accepted");
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode, 410);
  assert.equal((await h.runtime.app.inject("/api/v1/exports?metric=issues_opened")).statusCode, 503);
  assert.equal((await h.runtime.app.inject("/api/v1/updates")).statusCode, 503);
  await assert.rejects(h.runtime.runOnce(), /revoked_or_changed/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
});

test("negative public visibility probe fences reads even when no lifecycle webhook arrives", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const pin = (await getBoard(h.runtime)).snapshotId;
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce(), /not_verified/);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode, 410);
  assert.equal(
    (await h.runtime.receipts()).some((receipt) => receipt.kind === "source_unavailable"),
    true,
  );
});

test("default public runtime rejects synthetic config and persists no fixture facts or public snapshot", async (t) => {
  const h = await harness(t, { dataMode: "public" });
  await assert.rejects(h.runtime.runOnce(), /synthetic_data_forbidden/);
  for (const table of [
    "leaderboard_ingestion.source_facts",
    "leaderboard_pipeline.normalizations",
    "leaderboard_pipeline.snapshots",
  ])
    assert.equal((await h.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
});

test("synthetic mode cannot bind public interfaces and missing approvals cannot be supplied by source payloads", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.runtime.start({ public: { host: "0.0.0.0", port: 0 } }), /requires_loopback/);
  const other = await harness(t, { verifyConfiguration: async () => false });
  other.setFixturePage(true);
  assert.equal((await other.runtime.runOnce()).state, "blocked");
});

test("synthetic snapshots and cache cannot be consumed by a public runtime reusing the same marker-free configuration", async (t) => {
  const h = await harness(t, { markerFreeConfig: true });
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime);
  const publicRuntime = await createPipeline({ ...h.options, dataMode: "public" });
  t.after(() => publicRuntime.stop());
  assert.equal(await publicRuntime.source.read(publicScope, before.snapshotId, new AbortController().signal), null);
  assert.equal((await publicRuntime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode, 410);
  const count = (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n;
  const result = await publicRuntime.runOnce();
  assert.equal(result.state, "collecting");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, count);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.source_modes WHERE data_mode='public'"))
      .rows[0].n,
    0,
  );
});

test("current activated controls configuration disables a metric with explanation and removes a revoked repository from every read", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime);
  h.controlsStore.transaction(
    (state) => {
      state.configuration = {
        revision: 1,
        proposals: {},
        history: [],
        active: {
          version: "controls-configuration-v1",
          digest: "a".repeat(64),
          approval: { id: "synthetic-configuration-approval" },
          document: {
            repositories: [
              { id: "2", installationId: "1", slug: "synthetic-org/synthetic-repo", capabilities: ["issues"] },
            ],
            projects: [],
            metrics: components.metrics.metricDefinitionsV1.map((metric) => ({
              id: metric.id,
              enabled: metric.id !== "issues_opened",
              reason: metric.id === "issues_opened" ? "Paused pending source review" : "",
              policyVersion: "synthetic-policy-v1",
              policyLink: "https://github.com/synthetic-org/synthetic-repo/issues/100",
            })),
          },
        },
      };
    },
    { publish: true },
  );
  const disabled = await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`);
  assert.equal(disabled.statusCode, 503, disabled.body);
  assert.equal(disabled.json().error, "metric_disabled");
  assert.equal(disabled.json().disabledMetrics[0].reason, "metric_disabled_by_approved_configuration");
  const health = await h.runtime.app.inject("/api/v1/health");
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().disabledMetrics.length, 1);
  h.controlsStore.transaction(
    (state) => {
      state.configuration.revision++;
      state.configuration.active.document.repositories = [];
    },
    { publish: true },
  );
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode, 503);
});

test("default production source adapter uses the real read-only GitHub client and normalizer boundary", async (t) => {
  const h = await harness(t, { source: undefined, probeRepository: undefined });
  assert.equal((await h.runtime.runOnce()).state, "published");
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => row.result.value),
    [1, 1],
  );
});

test("host-neutral runtime starts on loopback, reports absent operations telemetry honestly and stops cleanly", async (t) => {
  const h = await harness(t);
  assert.deepEqual(h.runtime.operationalStatus(2), { state: "unknown", lagMs: null, revision: null });
  const addresses = await h.runtime.start();
  const response = await fetch(`http://127.0.0.1:${addresses.public.port}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  await Promise.all([h.runtime.stop(), h.runtime.stop()]);
});

test("actual collection and publication boundaries emit only typed optional monitor fields", async (t) => {
  const events = [];
  const monitor = {
    success: (value) => events.push({ state: "success", ...value }),
    failure: async (value) => events.push({ state: "failure", ...value }),
    status: () => ({ state: "fresh", lagMs: 0, revision: null }),
  };
  const h = await harness(t, { monitor });
  await h.runtime.runOnce();
  assert.equal(
    events.some((value) => value.stage === "collection" && value.state === "success"),
    true,
  );
  assert.equal(
    events.some((value) => value.stage === "normalization" && value.state === "success"),
    true,
  );
  assert.equal(
    events.some((value) => value.stage === "publication" && value.state === "success"),
    true,
  );
  assert.equal(
    events
      .filter((value) => value.state === "success")
      .every((value) => Number.isFinite(value.latencyMs) && value.latencyMs >= 0),
    true,
  );
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce());
  assert.equal(
    events.some((value) => value.state === "failure" && value.code === "permission_revoked"),
    true,
  );
  assert.equal(
    events.every((value) => !("error" in value) && !("payload" in value) && !("url" in value)),
    true,
  );
});

test("durable normalization and public snapshot integrity checks reject altered values", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  await h.db.query(
    "UPDATE leaderboard_pipeline.snapshots SET document=jsonb_set(document,'{rows,0,result,value}','999'::jsonb)",
  );
  const response = await h.runtime.app.inject(boardUrl);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes("999"), false);
});

test("public recovery cannot label facts from an interrupted synthetic run as public", async (t) => {
  const h = await harness(t, { markerFreeConfig: true });
  const cutoff = clock();
  await h.runtime.runOnce({ cutoff });
  await h.db.query("DELETE FROM leaderboard_pipeline.source_modes");
  const publicRuntime = await createPipeline({
    ...h.options,
    dataMode: "public",
    source: {
      async readPage() {
        return { repositoryId: 2, visibility: "public", nextCursor: null, expectedCount: 0, facts: [] };
      },
    },
  });
  t.after(() => publicRuntime.stop());
  // An empty public recollection cannot establish provenance for facts left by a crashed run.
  // The original first_run_id remains authoritative even after its post-collection label was lost.
  await assert.rejects(publicRuntime.runOnce({ cutoff }), /cross_mode_or_unproven_source_data/);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.source_modes WHERE data_mode='public'"))
      .rows[0].n,
    0,
  );
  assert.equal((await publicRuntime.app.inject(boardUrl)).statusCode, 503);
});

test("stored public snapshot mutation fails closed before current overlays", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime);
  await h.db.query(
    "UPDATE leaderboard_pipeline.snapshots SET document=jsonb_set(document, '{rows,0,result,value}', '99'::jsonb) WHERE snapshot_id=$1",
    [before.snapshotId],
  );
  for (const path of [
    boardUrl,
    `${boardUrl}&snapshot=${before.snapshotId}`,
    `/api/v1/exports?metric=issues_opened&snapshot=${before.snapshotId}`,
  ]) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /"value":99/);
  }
});

test("historical content replay cannot install an inconsistent current snapshot head", async (t) => {
  const h = await harness(t);
  const cutoff = clock();
  await h.runtime.runOnce({ cutoff });
  const first = await getBoard(h.runtime);
  h.controlsStore.transaction(
    (state) => {
      state.profiles["101"] = { suppressed: true, public: false, bio: "", highlights: [] };
    },
    { publish: true },
  );
  await h.runtime.runOnce({ cutoff });
  const second = await getBoard(h.runtime);
  assert.notEqual(first.snapshotId, second.snapshotId);
  h.controlsStore.transaction(
    (state) => {
      state.profiles["101"].suppressed = false;
    },
    { publish: true },
  );
  const prior = (
    await h.db.query(
      "SELECT revision,document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1",
      [first.snapshotId],
    )
  ).rows[0];
  const receiptCount = (await h.runtime.receipts()).length;
  await assert.rejects(h.runtime.runOnce({ cutoff }), /pipeline_snapshot_identity_conflict/);
  const retained = await getBoard(h.runtime);
  assert.equal(retained.snapshotId, second.snapshotId);
  assert.equal(retained.revision, second.revision);
  assert.equal((await h.runtime.receipts()).length, receiptCount);
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT revision,document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1",
        [first.snapshotId],
      )
    ).rows[0],
    prior,
  );
  const historical = await getBoard(h.runtime, `&snapshot=${first.snapshotId}`);
  assert.equal(historical.revision, first.revision);
  assert.deepEqual(historical.rows, first.rows);
  const freshCutoff = clock();
  assert.notEqual(freshCutoff, cutoff);
  await h.runtime.runOnce({ cutoff: freshCutoff });
  const third = await getBoard(h.runtime);
  assert.notEqual(third.snapshotId, first.snapshotId);
  assert.equal(third.revision, second.revision + 1);
  assert.deepEqual(
    third.rows.map((row) => row.result.value),
    first.rows.map((row) => row.result.value),
  );
});
for (const boundary of [
  "probe",
  "page",
  "restored page",
  "source write",
  "normalization",
  "publication",
  "publication commit",
  "restored publication commit",
])
  test(`repository overlay revocation while ${boundary} is pending stops the running pipeline`, async (t) => {
    let enteredBoundary, releaseBoundary;
    const entered = new Promise((resolve) => (enteredBoundary = resolve));
    const release = new Promise((resolve) => (releaseBoundary = resolve));
    const pause = async () => {
      enteredBoundary();
      await release;
    };
    let h;
    const extra = {};
    if (boundary === "probe")
      extra.probeRepository = async (repo) => {
        await pause();
        return { repositoryId: repo.id, installationId: repo.installationId, visibility: "public", checkedAt: clock() };
      };
    if (boundary === "normalization")
      extra.normalizer = async (request) => {
        await pause();
        return components.github.createGithubEvidenceNormalizer({
          client: h.options.githubClient,
          source: "installation:1",
          allowedRepositoryIds: [2],
          isSynthetic: true,
        })(request);
      };
    h = await harness(t, extra);
    let sourceReads = 0;
    const readPage = h.options.source.readPage;
    h.options.source.readPage = async (request) => {
      sourceReads++;
      const result = await readPage(request);
      if (["page", "restored page"].includes(boundary)) await pause();
      return result;
    };
    if (["source write", "publication", "publication commit", "restored publication commit"].includes(boundary)) {
      const transaction = h.db.transaction;
      h.db.transaction = (work) =>
        transaction(async (tx) => {
          let publishing = false;
          const result = await work({
            query: async (sql, params) => {
              const result = await tx.query(sql, params);
              if (boundary === "publication" && sql.includes("pg_advisory_xact_lock")) await pause();
              if (boundary === "source write" && sql.includes("INSERT INTO leaderboard_ingestion.source_facts"))
                await pause();
              if (sql.includes("INSERT INTO leaderboard_pipeline.snapshots")) publishing = true;
              return result;
            },
          });
          if (["publication commit", "restored publication commit"].includes(boundary) && publishing) await pause();
          return result;
        });
    }
    const pending = h.runtime.runOnce();
    const rejected = assert.rejects(pending, /active_configuration_(revoked_source|changed)/);
    await entered;
    h.controlsStore.transaction(
      (state) => {
        state.configuration = {
          revision: 1,
          proposals: {},
          history: [],
          active: {
            version: "synthetic-revoked-v1",
            digest: "a".repeat(64),
            approval: { id: "synthetic-revocation-approval" },
            document: { repositories: [], projects: [], metrics: [] },
          },
        };
      },
      { publish: true },
    );
    if (["restored page", "restored publication commit"].includes(boundary))
      h.controlsStore.transaction(
        (state) => {
          state.configuration.revision++;
          state.configuration.active.document.repositories = [{ id: "2" }];
        },
        { publish: true },
      );
    releaseBoundary();
    await rejected;
    const count = async (table) => (await h.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    if (boundary === "probe") assert.equal(sourceReads, 0);
    if (["probe", "page", "restored page", "source write"].includes(boundary))
      assert.equal(await count("leaderboard_ingestion.source_facts"), 0);
    if (!["publication", "publication commit", "restored publication commit"].includes(boundary))
      assert.equal(await count("leaderboard_pipeline.normalizations"), 0);
    // Separate SQLite/Postgres stores cannot roll back a COMMIT already in flight.
    // The current read overlay must still hide it, and runOnce must reject.
    const committed = ["publication commit", "restored publication commit"].includes(boundary) ? 1 : 0;
    assert.equal(await count("leaderboard_pipeline.snapshots"), committed);
    assert.equal(await count("leaderboard_pipeline.heads"), committed);
    if (committed) {
      assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
      assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
    }
  });

test("default collection adapter rejects a revoked response before following its next cursor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-source-revocation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let authorized = true;
  const calls = [];
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    checkpoints: new components.github.FileCheckpointStore(join(directory, "checkpoints")),
    maxRetries: 0,
    fetch: async (value) => {
      const url = new URL(value);
      calls.push(url.href);
      if (url.pathname === "/repos/synthetic-org/synthetic-repo")
        return new Response(JSON.stringify({ id: 2, private: false }));
      authorized = false;
      return new Response(JSON.stringify([{}]), {
        headers: {
          link: '<https://api.synthetic.invalid/repos/synthetic-org/synthetic-repo/issues?page=2>; rel="next"',
        },
      });
    },
  });
  const source = createGithubCollectionSource({
    client,
    sourceId: "installation:1",
    repositories: [{ id: 2, installationId: 1, slug: "synthetic-org/synthetic-repo", families: ["issues"] }],
    isSynthetic: true,
    assertAuthorized() {
      if (!authorized) throw Error("synthetic_source_revoked");
    },
  });
  await assert.rejects(
    source.readPage({
      runId: "synthetic-scan",
      repositoryId: 2,
      family: "issues",
      mode: "reconcile",
      since: null,
      until: clock(),
      cursor: null,
      limit: 100,
    }),
    /synthetic_source_revoked/,
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((url) => url.includes("page=2")),
    false,
  );
});

test("publication confirmation is private and durable; legacy unconfirmed snapshots require an authorized rerun", async (t) => {
  const h = await harness(t);
  const cutoff = clock();
  const initial = await h.runtime.runOnce({ cutoff });
  const snapshotId = initial.publications[0].snapshotId;
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].configurationVersion, h.config.version);
  assert.equal(JSON.stringify(h.controlsStore.publicSnapshot()).includes("pipelinePublications"), false);
  const reopened = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const restarted = await createPipeline({ ...h.options, controlsStore: reopened });
  try {
    assert.equal((await getBoard(restarted, `&snapshot=${snapshotId}`)).snapshotId, snapshotId);
  } finally {
    await restarted.stop();
    reopened.close();
  }
  h.controlsStore.transaction((state) => {
    delete state.pipelinePublications;
  });
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${snapshotId}`)).statusCode, 410);
  const retry = await h.runtime.runOnce({ cutoff });
  assert.equal(retry.publications[0].snapshotId, snapshotId);
  assert.equal(retry.publications[0].changed, false);
  assert.equal((await getBoard(h.runtime, `&snapshot=${snapshotId}`)).snapshotId, snapshotId);
});

test("failed controls confirmation hides the SQL snapshot and an authorized exact rerun recovers", async (t) => {
  const h = await harness(t);
  const cutoff = clock();
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const result = change(state);
      if (state.pipelinePublications) throw Error("synthetic_confirmation_failure");
      return result;
    }, options);
  await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_confirmation_failure/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  h.controlsStore.transaction = transaction;
  const retry = await h.runtime.runOnce({ cutoff });
  assert.equal(retry.state, "published");
  assert.equal(retry.publications[0].changed, false);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 200);
});

test("a confirmed historical pin cannot advertise an unconfirmed newer publication head", async (t) => {
  const h = await harness(t);
  const first = await h.runtime.runOnce();
  const pin = first.publications[0].snapshotId;
  const cutoff = clock();
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      change(state);
      throw Error("synthetic_confirmation_failure");
    }, options);
  await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_confirmation_failure/);
  h.controlsStore.transaction = transaction;
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 2);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode, 410);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  const retry = await h.runtime.runOnce({ cutoff });
  assert.equal(retry.publications[0].changed, false);
  const pinned = await getBoard(h.runtime, `&snapshot=${pin}`);
  assert.equal(pinned.snapshotId, pin);
  assert.equal(pinned.head.snapshotId, retry.publications[0].snapshotId);
  assert.equal(pinned.head.revision, 2);
});

test("public observed work survives accepted-only rankings without granting assignee, mention or membership credit", async (t) => {
  const h = await harness(t);
  const config = structuredClone(h.config);
  config.policies[0].policy.rankedStates = ["qualified"];
  config.policies[0].policy.dateBasis = "acceptedAt";
  config.policies[0].signature = components.metrics.stableJSON(config.policies[0].policy);
  const runtime = await createPipeline({ ...h.options, config });
  t.after(() => runtime.stop());
  h.add({
    id: 1003,
    node_id: "SYNTHETIC_ISSUE_3",
    number: 3,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/3",
    created_at: ago(1),
    updated_at: ago(1),
    user: { id: 103, node_id: "U_SYNTHETIC_EXTERNAL", login: "synthetic-external", type: "User" },
    assignees: [{ id: 909, login: "synthetic-assigned-only", type: "User" }],
    body: "@synthetic-mentioned-only internal SECRET private@example.invalid",
    author_association: "NONE",
  });
  assert.equal((await runtime.runOnce()).state, "published");
  const board = await getBoard(runtime);
  assert.deepEqual(board.rows, []);
  const response = await runtime.app.inject("/api/v1/contributors");
  assert.equal(response.statusCode, 200, response.body);
  const directory = response.json();
  assert.deepEqual(
    directory.contributors.map((item) => item.actor.login),
    ["synthetic-alice", "synthetic-bob", "synthetic-external"],
  );
  assert.ok(
    directory.contributors.every((item) => item.categories[0].observed === 1 && item.categories[0].accepted === 0),
  );
  const profile = await runtime.app.inject(`/api/v1/contributors/103?snapshot=${directory.snapshotId}`);
  assert.deepEqual(profile.json().results, []);
  assert.equal(profile.json().timeline[0].activityState, "observed");
  assert.equal(profile.json().timeline[0].contribution.roles[0], "reporter");
  assert.doesNotMatch(
    response.body + profile.body,
    /assigned-only|mentioned-only|SECRET|private@example|author_association|acceptanceReceipt/,
  );
  h.controlsStore.transaction((state) => {
    state.profiles["103"] = { suppressed: true };
  });
  assert.deepEqual(
    (await runtime.app.inject(`/api/v1/contributors?search=external&snapshot=${directory.snapshotId}`)).json()
      .contributors,
    [],
  );
  assert.equal((await runtime.app.inject(`/api/v1/contributors/103?snapshot=${directory.snapshotId}`)).statusCode, 404);
});

test("policy previews persist exact frozen inputs and require independent host release authorization", async (t) => {
  const h = await harness(t, {
    authorizePolicyPreview: async ({ operatorId }) => operatorId === "201",
    authorizePolicyRelease: async ({ operatorId, approvalReceipt }) =>
      operatorId === "202" && approvalReceipt === "synthetic-policy-review",
    policyApproverIds: ["202"],
  });
  const publication = (await h.runtime.runOnce()).publications[0];
  const policy = {
    ...h.options.config.policies[0].policy,
    version: "synthetic-policy-v2",
    rankedStates: ["qualified"],
  };
  await assert.rejects(
    h.runtime.previewPolicy({ snapshotId: publication.snapshotId, policy, operatorId: "999" }),
    /not_authorized/,
  );
  const preview = await h.runtime.previewPolicy({ snapshotId: publication.snapshotId, policy, operatorId: "201" });
  assert.equal(preview.comparison.before.datasetId, preview.comparison.after.datasetId);
  assert.equal(preview.comparison.changes.length > 0, true);
  assert.deepEqual(
    await h.runtime.previewPolicy({ snapshotId: publication.snapshotId, policy, operatorId: "201" }),
    preview,
  );
  await assert.rejects(
    h.runtime.approvePolicyComparison({ comparisonId: preview.comparisonId, operatorId: "201" }),
    /not_authorized/,
  );
  const release = await h.runtime.approvePolicyComparison({
    comparisonId: preview.comparisonId,
    operatorId: "202",
    approvalReceipt: "synthetic-policy-review",
    releaseNotes: "Require accepted outcomes",
  });
  assert.equal(release.manifest.publicEnabled, false);
  assert.equal(release.manifest.targetVersion, policy.version);
  const head = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0];
  assert.equal(head.snapshot_id, publication.snapshotId);
});

test("accepted controls receipt materializes a separate lens and withdrawal fences pinned snapshots", async (t) => {
  const h = await harness(t);
  const config = structuredClone(h.options.config);
  const policy = {
    ...config.policies[0].policy,
    version: "synthetic-accepted-v1",
    dateBasis: "acceptedAt",
    rankedStates: ["qualified"],
  };
  config.policies = [
    { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-approval" },
  ];
  config.recognitionBindings = [
    {
      category: "finding",
      scope: "repository:2",
      policyVersion: policy.version,
      metricId: "issues_opened",
      sourceMetricId: "issues_opened",
      repositoryId: "2",
      reviewerIds: ["202"],
    },
  ];
  const event = {
    id: "synthetic-receipt",
    actor: "202",
    action: "accepted",
    at: Date.parse(ago(1)),
    policyVersion: policy.version,
  };
  h.controlsStore.transaction((s) => {
    s.requests.claim = {
      id: "claim",
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: "finding",
      scope: "repository:2",
      policyVersion: policy.version,
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      collaborators: {},
      history: [event],
    };
    s.audit.push(event);
  });
  const runtime = await createPipeline({
    ...h.options,
    config,
    authorizePolicyPreview: async () => {
      h.controlsStore.transaction((s) => {
        s.requests.claim.status = "withdrawn";
      });
      return true;
    },
  });
  t.after(() => runtime.stop());
  const publication = (await runtime.runOnce()).publications[0];
  const signal = new AbortController().signal;
  const visible = await runtime.source.read(publicScope, publication.snapshotId, signal);
  assert.equal(visible.selected.rows.find((r) => r.actorId === "101").result.value, 1);
  await assert.rejects(
    runtime.previewPolicy({
      snapshotId: publication.snapshotId,
      policy: { ...policy, version: "synthetic-accepted-v2" },
      operatorId: "202",
    }),
    /policy_input_revoked/,
  );
  assert.equal(await runtime.source.read(publicScope, publication.snapshotId, signal), null);
  const next = (await runtime.runOnce()).publications[0];
  const after = await runtime.source.read(publicScope, next.snapshotId, signal);
  assert.equal(
    after.selected.rows.some((r) => r.result.value > 0),
    false,
  );
});

for (const action of ["contributor suppression", "source revocation"])
  test(`policy preview fences ${action} during asynchronous authorization`, async (t) => {
    let revoke;
    const h = await harness(t, {
      authorizePolicyPreview: async () => {
        await revoke();
        return true;
      },
    });
    const publication = (await h.runtime.runOnce()).publications[0];
    revoke =
      action === "contributor suppression"
        ? async () =>
            h.controlsStore.transaction((s) => {
              s.profiles["101"] = { suppressed: true };
            })
        : async () => h.setPrivate(true);
    if (action === "source revocation")
      revoke = async () => {
        await h.db.query(
          "UPDATE leaderboard_ingestion.repository_access SET state='unavailable' WHERE repository_id=2",
        );
      };
    await assert.rejects(
      h.runtime.previewPolicy({
        snapshotId: publication.snapshotId,
        policy: { ...h.options.config.policies[0].policy, version: "v2" },
        operatorId: "201",
      }),
      /policy_input_revoked/,
    );
  });
test("policy approval rejects a frozen comparison after contributor suppression", async (t) => {
  const h = await harness(t, {
    authorizePolicyPreview: async () => true,
    authorizePolicyRelease: async () => true,
    policyApproverIds: ["202"],
  });
  const publication = (await h.runtime.runOnce()).publications[0];
  const preview = await h.runtime.previewPolicy({
    snapshotId: publication.snapshotId,
    policy: { ...h.options.config.policies[0].policy, version: "v2" },
    operatorId: "201",
  });
  h.controlsStore.transaction((s) => {
    s.profiles["101"] = { suppressed: true };
  });
  await assert.rejects(
    h.runtime.approvePolicyComparison({
      comparisonId: preview.comparisonId,
      operatorId: "202",
      approvalReceipt: "review",
      releaseNotes: "Reviewed",
    }),
    /policy_input_revoked|policy_input_changed/,
  );
});

test("real controls HTTP acceptance and withdrawal feed pipeline recognition without handcrafted receipts", async (t) => {
  const h = await harness(t);
  const config = structuredClone(h.options.config);
  const policy = {
    ...config.policies[0].policy,
    version: "synthetic-controls-v1",
    dateBasis: "acceptedAt",
    rankedStates: ["qualified"],
  };
  config.policies = [
    { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-reviewed-policy" },
  ];
  config.recognitionBindings = [
    {
      category: "governance",
      scope: "repository:2",
      policyVersion: policy.version,
      metricId: "issues_opened",
      sourceMetricId: "issues_opened",
      repositoryId: "2",
      reviewerIds: ["202"],
    },
  ];
  const origin = "https://controls.example.test";
  const server = components.controls.createControlsServer({
    store: h.controlsStore,
    origin,
    approvedPolicyVersions: [policy.version],
    rolesForActor: (actorId) => ({ roles: actorId === "202" ? ["reviewer"] : [], version: "v1" }),
    provider: {
      authorizationURL: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
      exchange: async ({ code }) => ({ actorId: code }),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, user, body) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        ...(user ? { cookie: user.cookie, origin, "x-csrf-token": user.csrf } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      response,
      data: response.headers.get("content-type")?.includes("application/json") ? await response.json() : null,
    };
  }
  async function login(actorId) {
    const start = await call("/controls/auth/login");
    const state = new URL(start.response.headers.get("location")).searchParams.get("state");
    const result = await call(`/controls/auth/callback?state=${state}&code=${actorId}`, {
      cookie: start.response.headers.getSetCookie()[0].split(";")[0],
    });
    assert.equal(result.response.status, 303);
    const cookie = result.response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-controls_session="))
      .split(";")[0];
    const session = await call("/controls/session", { cookie });
    assert.equal(session.response.status, 200);
    return { cookie, csrf: session.data.csrf };
  }
  const owner = await login("101"),
    reviewer = await login("202");
  const submitted = await call("/controls/requests", owner, {
    kind: "evidence",
    locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
    category: "governance",
    collaborators: [],
    consent: true,
    detail: "Private synthetic review detail",
    scope: "repository:2",
  });
  assert.equal(submitted.response.status, 201);
  const reviewed = await call(`/controls/requests/${submitted.data.id}/review`, reviewer, {
    version: submitted.data.version,
    decision: "accept",
    reason: "Private synthetic decision",
    conflict: false,
    policyVersion: policy.version,
    sourceReviewedPublic: true,
  });
  assert.equal(reviewed.response.status, 200);
  const runtime = await createPipeline({ ...h.options, config });
  t.after(() => runtime.stop());
  const publication = (await runtime.runOnce()).publications[0];
  const read = await runtime.source.read(publicScope, publication.snapshotId, new AbortController().signal);
  assert.equal(read.selected.rows.find((row) => row.actorId === "101").result.value, 1);
  assert.equal(JSON.stringify(read).includes("Private synthetic"), false);
  const withdrawn = await call(`/controls/requests/${submitted.data.id}/withdraw`, owner, {
    version: reviewed.data.version,
  });
  assert.equal(withdrawn.response.status, 200);
  assert.equal(await runtime.source.read(publicScope, publication.snapshotId, new AbortController().signal), null);
});

test("policy approval rolls back its durable receipt when privacy changes during persistence", async (t) => {
  const h = await harness(t, {
    authorizePolicyPreview: async () => true,
    authorizePolicyRelease: async () => true,
    policyApproverIds: ["202"],
  });
  const publication = (await h.runtime.runOnce()).publications[0];
  const preview = await h.runtime.previewPolicy({
    snapshotId: publication.snapshotId,
    policy: { ...h.options.config.policies[0].policy, version: "v2" },
    operatorId: "201",
  });
  const transact = h.db.transaction;
  h.db.transaction = (work) =>
    transact((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("INSERT INTO leaderboard_pipeline.receipts") && params?.includes("policy_release_reviewed"))
            h.controlsStore.transaction((s) => {
              s.profiles["101"] = { suppressed: true };
            });
          return result;
        },
      }),
    );
  await assert.rejects(
    h.runtime.approvePolicyComparison({
      comparisonId: preview.comparisonId,
      operatorId: "202",
      approvalReceipt: "review",
      releaseNotes: "Reviewed",
    }),
    /policy_input_revoked|policy_input_changed/,
  );
  assert.equal(
    (await h.runtime.receipts()).some((r) => r.kind === "policy_release_reviewed"),
    false,
  );
});

for (const narrowing of ["capability", "project", "installation", "slug"]) {
  test(`activated ${narrowing} narrowing fences historical reads and new collection`, async (t) => {
    const h = await harness(t);
    const config = structuredClone(h.options.config);
    config.repositories[0].allowedProjectIds = ["PVT_syntheticAllowed"];
    let sourceReads = 0;
    const runtime = await createPipeline({
      ...h.options,
      config,
      source: {
        readPage: async (request) => {
          sourceReads++;
          return h.options.source.readPage(request);
        },
      },
    });
    t.after(() => runtime.stop());
    const publication = (await runtime.runOnce()).publications[0];
    const active = {
      repositories: [{ id: "2", installationId: "1", slug: config.repositories[0].slug, capabilities: ["issues"] }],
      projects: [{ id: "PVT_syntheticAllowed", fields: [] }],
      metrics: [],
    };
    h.controlsStore.transaction(
      (state) => {
        state.configuration = {
          revision: 1,
          active: {
            version: "synthetic-control",
            digest: "a".repeat(64),
            approval: { id: "synthetic-approval" },
            document: active,
          },
        };
      },
      { publish: true },
    );
    assert.equal((await runtime.app.inject(`${boardUrl}&snapshot=${publication.snapshotId}`)).statusCode, 200);
    h.controlsStore.transaction(
      (state) => {
        state.configuration.revision++;
        const document = state.configuration.active.document;
        if (narrowing === "capability") document.repositories[0].capabilities = ["reviews"];
        if (narrowing === "project") document.projects = [];
        if (narrowing === "installation") document.repositories[0].installationId = "9";
        if (narrowing === "slug") document.repositories[0].slug = "synthetic-org/other";
      },
      { publish: true },
    );
    const priorReads = sourceReads;
    assert.equal((await runtime.app.inject(`${boardUrl}&snapshot=${publication.snapshotId}`)).statusCode, 503);
    assert.equal((await runtime.app.inject(boardUrl)).statusCode, 503);
    await assert.rejects(runtime.runOnce(), /active_configuration_/);
    assert.equal(sourceReads, priorReads);
  });
}
