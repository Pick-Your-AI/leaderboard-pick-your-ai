import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadPipelineComponents, createPipeline, migratePipeline } from "../src/index.mjs";

const checkout = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const roots = process.env.PIPELINE_COMPONENT_ROOTS ? JSON.parse(process.env.PIPELINE_COMPONENT_ROOTS) : {};
const ingestionRoot = roots.ingestion ?? checkout;
const require = createRequire(join(ingestionRoot, "packages/ingestion/package.json"));
const { PGlite } = require("@electric-sql/pglite");
export const components = await loadPipelineComponents(roots);
export const clock = () => new Date().toISOString();
export const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
export const fixtureId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const publicScope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
export const boardUrl = "/api/v1/boards?metric=issues_opened";

export async function harness(t, extra = {}) {
  const slug = extra.markerFreeConfig ? "example-org/example-repo" : "synthetic-org/synthetic-repo";
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-pipeline-"));
  let engine = new PGlite(join(directory, "postgres"));
  const db = {
    query: async (sql, params) => {
      const result = await engine.query(sql, params);
      if (extra.reverseNormalizationRows && sql.includes("SELECT fact.*")) result.rows.reverse();
      return result;
    },
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
      title: "Synthetic collected issue title",
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
  if (extra.transformPayloads) payloads = extra.transformPayloads(payloads);
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
  const { createPolicyPreviewAuthority, previewAuthorityLimitsV1 } =
    await import("../../controls/src/policy-preview-authority.mjs");
  const { comparisonHash } = await import("../../controls/src/policy-comparison.mjs");
  const authority = createPolicyPreviewAuthority();
  authority.replace({
    schemaVersion: previewAuthorityLimitsV1.schemaVersion,
    revision: 1,
    validUntil: Date.now() + 60_000,
    configurationHashes: [comparisonHash(options.config)],
    reviewers: [{ actorId: "201", roleVersion: "1" }],
  });
  options.policyComparisonAuthorityCurrent ??= authority.isCurrent;
  if (extra.normalizerFactory) options.normalizer = extra.normalizerFactory(options);
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
    async reopenDatabase() {
      await engine.close();
      engine = new PGlite(join(directory, "postgres"));
    },
    authority,
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

export async function getBoard(runtime, suffix = "") {
  const response = await runtime.app.inject(boardUrl + suffix);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
