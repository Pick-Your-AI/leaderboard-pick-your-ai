import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
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
    "006_delivery_payload_expiry.up.sql",
    "007_operator_replay_results.up.sql",
    "008_dispatch_publication_scope_capacity.up.sql",
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

for (const [loss, subjectType] of [
  ["private", "issue"],
  ["hidden", "issue"],
  ["controls_failure", "issue"],
  ["private", "pull_request"],
  ["subject_private", "pull_request"],
  ["subject_identity", "pull_request"],
  ["inventory_missing_id", "pull_request"],
  ["inventory_reused_id", "pull_request"],
  ["inventory_malformed_id", "pull_request"],
  ["inventory_oversized_id", "pull_request"],
  ["normalization_identity", "pull_request"],
  ["legacy_normalization_identity", "pull_request"],
])
  test(`confirmed ${loss} Project revokes current and pinned ${subjectType} publications until a new approved configuration`, async (t) => {
    const h = await harness(t);
    const config = structuredClone(h.options.config);
    config.repositories[0].families = ["project_history"];
    config.repositories[0].allowedProjectIds = ["PVT_syntheticAllowed"];
    const policy = {
      ...config.policies[0].policy,
      metricId: "project_status_updates",
      unit: components.metrics.getMetricDefinition("project_status_updates").definition.unit,
      roles: ["triager"],
      sources: ["github_graphql"],
    };
    config.policies = [
      { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" },
    ];
    let publicProject = true;
    let privateSubject = false;
    let changedSubject = false;
    let inventoryLoss = null;
    let invalidInventoryHistoryReads = 0;
    let normalizationIdentityLoss = false;
    let normalizing = false;
    let normalizationIdentityReads = 0;
    const event = () => ({
      id: "E_synthetic",
      __typename: "ProjectV2ItemStatusChangedEvent",
      createdAt: ago(1),
      wasAutomated: false,
      actor: { id: "U_synthetic", databaseId: 101, __typename: "User", login: "synthetic" },
      project: { id: "PVT_syntheticAllowed", public: publicProject },
    });
    const stableEvent = event();
    const current = () => ({
      ...stableEvent,
      // A newly collected event forces hydration without disturbing an older
      // cached publication. The legacy-cache case deliberately keeps this ID.
      id: normalizationIdentityLoss && loss === "normalization_identity" ? "E_synthetic_new" : stableEvent.id,
      project: { ...stableEvent.project, public: publicProject },
    });
    const subjectId = () => {
      if (inventoryLoss === "inventory_malformed_id") return "PR invalid";
      if (inventoryLoss === "inventory_oversized_id") return "P".repeat(129);
      return subjectType === "pull_request" ? "PR_synthetic" : "I_synthetic";
    };
    const client = syntheticRepositoryClient(2, {
      rest: async () => ({ id: 2, private: false, full_name: config.repositories[0].slug }),
      scanRest: async (o) => {
        const subject = {
          id: 1,
          node_id: subjectId(),
          number: 1,
          ...(subjectType === "pull_request" ? { pull_request: {} } : {}),
        };
        if (inventoryLoss === "inventory_missing_id") delete subject.node_id;
        return o.select(
          inventoryLoss === "inventory_reused_id" ? [subject, { ...subject, id: 2, number: 2 }] : [subject],
        );
      },
      scanGraphql: async (o) => {
        if (["inventory_malformed_id", "inventory_oversized_id"].includes(inventoryLoss))
          invalidInventoryHistoryReads += 1;
        const changedDuringHydration = normalizationIdentityLoss && normalizing;
        if (changedDuringHydration) normalizationIdentityReads += 1;
        return o.select({
          repository: {
            databaseId: 2,
            isPrivate: privateSubject,
            [subjectType === "pull_request" ? "pullRequest" : "issue"]: {
              id: changedSubject || changedDuringHydration ? "PR_synthetic_changed" : subjectId(),
              url: `https://github.com/synthetic-org/synthetic-repo/${subjectType === "pull_request" ? "pull" : "issues"}/1`,
              timelineItems: { nodes: [current()], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        }).nodes;
      },
      graphql: async (_source, query) =>
        query.includes("... on ProjectV2 {")
          ? { node: publicProject === null ? null : { id: "PVT_syntheticAllowed", public: publicProject } }
          : { node: { ...current(), previousStatus: "Todo", status: "Done" } },
    });
    const runtimeOptions = {
      ...h.options,
      config,
      githubClient: client,
      source: undefined,
      components: {
        ...components,
        github: {
          ...components.github,
          createGithubEvidenceNormalizer(options) {
            const normalize = components.github.createGithubEvidenceNormalizer(options);
            return async (input) => {
              normalizing = true;
              try {
                return await normalize(input);
              } finally {
                normalizing = false;
              }
            };
          },
        },
      },
    };
    const runtime = await createPipeline(runtimeOptions);
    t.after(() => runtime.stop());
    const first = await runtime.runOnce();
    assert.equal(first.state, "published");
    const url = "/api/v1/boards?metric=project_status_updates";
    assert.deepEqual(
      (await runtime.app.inject(url)).json().rows.map((r) => r.result.value),
      [1],
    );
    if (loss === "legacy_normalization_identity") {
      const cached = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
      assert.equal(cached.length, 1);
      const document = structuredClone(cached[0].document);
      assert.equal(document.projectHistoryNormalizationVersion, "collected-subject/v2");
      // Emulate an intact private cache written before collected-subject
      // binding. It must be recomputed, even with an unchanged event revision.
      delete document.projectHistoryNormalizationVersion;
      const hash = createHash("sha256").update(components.metrics.stableJSON(document)).digest("hex");
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$1::jsonb,document_hash=$2 WHERE fact_key=$3 AND policy_signature=$4",
        [JSON.stringify(document), hash, cached[0].fact_key, cached[0].policy_signature],
      );
    }
    const originalTransaction = h.controlsStore.transaction.bind(h.controlsStore);
    if (loss === "controls_failure")
      h.controlsStore.transaction = (change, options) =>
        originalTransaction((state) => {
          change(state);
          if (state.pipelineSourceDenials) throw Error("synthetic_controls_write_failure");
        }, options);
    if (loss === "subject_private") privateSubject = true;
    else if (loss === "subject_identity") changedSubject = true;
    else if (loss.startsWith("inventory_")) inventoryLoss = loss;
    else if (loss.endsWith("normalization_identity")) normalizationIdentityLoss = true;
    else publicProject = loss === "hidden" ? null : false;
    let runError;
    await runtime.runOnce().catch((error) => {
      runError = error;
    });
    if (normalizationIdentityLoss) assert.ok(normalizationIdentityReads > 0);
    h.controlsStore.transaction = originalTransaction;
    const read = await runtime.app.inject(url + "&snapshot=" + first.publications[0].snapshotId);
    assert.notEqual(read.statusCode, 200);
    assert.notEqual((await runtime.app.inject(url)).statusCode, 200);
    if (runError)
      assert.match(
        runError.message,
        /project_source_scope_requires_reapproval|synthetic_controls_write_failure|project_subject_identity_unverified/,
      );
    if (["inventory_malformed_id", "inventory_oversized_id"].includes(loss))
      assert.equal(invalidInventoryHistoryReads, 0);
    if (loss === "controls_failure") assert.equal(h.controlsStore.read().pipelineSourceDenials, undefined);
    else assert.equal(h.controlsStore.read().pipelineSourceDenials[2].configurationVersion, config.version);
    assert.equal(
      (
        await h.db.query(
          "SELECT count(*)::int AS total FROM leaderboard_pipeline.receipts WHERE kind='project_scope_denial'",
        )
      ).rows[0].total,
      1,
    );
    assert.equal(
      (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .state,
      "unavailable",
    );
    // A repository that remains public cannot reopen a known-private Project publication.
    publicProject = true;
    privateSubject = false;
    changedSubject = false;
    inventoryLoss = null;
    normalizationIdentityLoss = false;
    await assert.rejects(runtime.runOnce(), /project_source_scope_requires_reapproval/);
    assert.notEqual((await runtime.app.inject(url)).statusCode, 200);
    const restarted = await createPipeline(runtimeOptions);
    t.after(() => restarted.stop());
    await assert.rejects(restarted.runOnce(), /project_source_scope_requires_reapproval/);
    assert.notEqual(
      (await restarted.app.inject(url + "&snapshot=" + first.publications[0].snapshotId)).statusCode,
      200,
    );
    // Recovery requires a separately approved config version and rebuilt publication.
    const approvedConfig = { ...config, version: config.version + "-reapproved" };
    const recovered = await createPipeline({
      ...runtimeOptions,
      config: approvedConfig,
    });
    t.after(() => recovered.stop());
    assert.notEqual(
      (await recovered.app.inject(url + "&snapshot=" + first.publications[0].snapshotId)).statusCode,
      200,
    );
    assert.equal((await recovered.runOnce()).state, "published");
    assert.equal((await recovered.app.inject(url)).statusCode, 200);
  });

test("Project scope loss during normalization persists the publication gate", async (t) => {
  const h = await harness(t);
  const first = await h.runtime.runOnce();
  assert.equal(first.state, "published");
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 200);
  h.add({
    id: 9,
    node_id: "I_synthetic_new",
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/9",
    created_at: clock(),
    updated_at: clock(),
    state: "open",
    user: { id: 101, login: "synthetic", type: "User" },
  });
  const runtime = await createPipeline({
    ...h.options,
    normalizer: async () => {
      throw Error("project_not_authorized");
    },
  });
  t.after(() => runtime.stop());
  await assert.rejects(runtime.runOnce(), /project_not_authorized/);
  assert.notEqual((await runtime.app.inject(boardUrl)).statusCode, 200);
  assert.notEqual(
    (await runtime.app.inject(boardUrl + "&snapshot=" + first.publications[0].snapshotId)).statusCode,
    200,
  );
  assert.equal(h.controlsStore.read().pipelineSourceDenials[2].configurationVersion, h.config.version);
  assert.equal(JSON.stringify(h.controlsStore.publicSnapshot()).includes("pipelineSourceDenials"), false);
});
