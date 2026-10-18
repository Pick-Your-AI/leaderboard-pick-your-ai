import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  let engine = new PGlite(join(directory, "postgres"));
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
  let hydrationFailure = false;
  let fetchHook = null;
  const calls = [];
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
      calls.push(url.pathname);
      await fetchHook?.(url);
      if (hydrationFailure && /\/issues\/\d+$/.test(url.pathname)) throw new Error("synthetic hydration failure");
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
    calls,
    async reopenDatabase() {
      await engine.close();
      engine = new PGlite(join(directory, "postgres"));
    },
    setHydrationFailure(value) {
      hydrationFailure = value;
    },
    setFetchHook(value) {
      fetchHook = value;
    },
    updateIssue(number, patch) {
      Object.assign(
        payloads.find((payload) => payload.number === number),
        patch,
      );
    },
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

const webhookSecret = "synthetic-webhook-secret-more-than-32-characters";
function issueRequest(n = 700, patch = {}) {
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: { node_id: "SYNTHETIC_SENDER_NOT_AUTHOR" },
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2).replace(/\.\d{3}Z$/, "Z") },
    ...patch,
  });
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": fixtureId(n),
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
    },
  };
}
async function enqueueNotice(h, n = 700, patch = {}) {
  const handler = components.ingestion.createWebhookHandler({
    secrets: [webhookSecret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
  });
  const response = await handler(new Request("http://localhost/webhooks/github", issueRequest(n, patch)));
  assert.equal(response.status, 202, await response.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
}
async function dispatchRow(h, n = 700) {
  return (
    await h.db.query("SELECT * FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
      `github:delivery:${fixtureId(n)}`,
    ])
  ).rows[0];
}
async function readyDispatch(h) {
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
}
async function until(work) {
  for (let i = 0; i < 100; i++) {
    if (await work()) return;
    await delay(50);
  }
  assert.fail("synthetic progress deadline exceeded");
}

test("signed socket webhook survives runtime/database restart and dispatcher produces confirmed HTTP API evidence", async (t) => {
  const h = await harness(t, { webhookSecrets: [webhookSecret], source: undefined, probeRepository: undefined });
  const address = await h.runtime.start({ webhook: { host: "127.0.0.1", port: 0 } });
  const webhook = `http://127.0.0.1:${address.webhook.port}/webhooks/github`;
  const signedRequest = issueRequest();
  const responses = await Promise.all([fetch(webhook, signedRequest), fetch(webhook, signedRequest)]);
  assert.deepEqual(responses.map((item) => item.status).sort(), [200, 202]);
  await until(async () => (await h.runtime.inbox.health()).completed === 1);
  assert.equal((await h.runtime.outbox.health()).pending, 1);
  await h.runtime.stop();
  await h.reopenDatabase();
  const recovered = await createPipeline({ ...h.options, webhookDispatch: true });
  t.after(() => recovered.stop());
  const recoveredAddress = await recovered.start();
  await until(async () => (await recovered.outbox.health()).completed === 1);
  const response = await fetch(`http://127.0.0.1:${recoveredAddress.public.port}${boardUrl}`);
  assert.equal(response.status, 200);
  const board = await response.json();
  assert.deepEqual(
    board.rows.map((row) => [row.actorId, row.result.value]),
    [
      ["101", 1],
      ["102", 1],
    ],
  );
  const row = await dispatchRow(h);
  assert.equal(row.state, "done");
  assert.equal(row.completion.publications[0].snapshotId, board.snapshotId);
  const evidenceId = board.rows[0].evidenceIds[0];
  const evidence = await fetch(
    `http://127.0.0.1:${recoveredAddress.public.port}/api/v1/evidence/${evidenceId}?snapshot=${board.snapshotId}`,
  );
  assert.equal(evidence.status, 200);
  assert.equal(
    h.calls.some((path) => path.endsWith("/issues")),
    true,
  );
  assert.equal(
    h.calls.some((path) => path.endsWith("/issues/1")),
    true,
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.outbox")).rows[0].n, 1);
  await recovered.stop();
});

test("distinct duplicate notices and concurrent dispatch calls never duplicate creation credit", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h, 700);
  await enqueueNotice(h, 701);
  assert.deepEqual(await Promise.all([h.runtime.dispatchOnce(), h.runtime.dispatchOnce()]), ["processed", "processed"]);
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => row.result.value),
    [1, 1],
  );
  assert.equal((await h.runtime.outbox.health()).completed, 2);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 2);
});

test("dispatch retries hydration failure with frozen operation and no premature contribution publication", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  h.setHydrationFailure(true);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  const first = await dispatchRow(h);
  assert.equal(first.completion, null);
  assert.equal(first.reason_code, "enrichment_unavailable");
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal(await h.runtime.dispatchOnce(), "idle");
  h.setHydrationFailure(false);
  await readyDispatch(h);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const second = await dispatchRow(h);
  assert.deepEqual(second.operation, first.operation);
  assert.equal(new Date(second.observation_cutoff).toISOString(), new Date(first.observation_cutoff).toISOString());
  assert.equal(second.attempts, 2);
  assert.deepEqual(
    (await getBoard(h.runtime)).rows.map((row) => row.result.value),
    [1, 1],
  );
});

test("dispatch recovers SQL commit before failed confirmation without a second snapshot", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const result = change(state);
      if (state.pipelinePublications) throw Error("synthetic_confirmation_failure");
      return result;
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h)).completion, null);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.dispatch_publications")).rows[0].n,
    1,
  );
  h.controlsStore.transaction = transaction;
  await readyDispatch(h);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 200);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 1);
});

test("crash after publication before acknowledgment resumes its pinned operation without reverting a newer head", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic process loss");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic process loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic process loss/);
  const pending = await dispatchRow(h);
  const first = await getBoard(h.runtime);
  await delay(5);
  const advanced = await h.runtime.runOnce();
  assert.notEqual(advanced.publications[0].snapshotId, first.snapshotId);
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  assert.equal(await recovered.dispatchOnce(), "processed");
  const done = await dispatchRow(h);
  assert.deepEqual(done.operation, pending.operation);
  assert.equal(done.completion.publications[0].snapshotId, first.snapshotId);
  assert.equal((await getBoard(recovered)).snapshotId, advanced.publications[0].snapshotId);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 2);
  await recovered.stop();
});

test("expired dispatcher cannot publish or acknowledge an in-flight hydration result", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  let expired = false;
  h.setFetchHook(async (url) => {
    if (!expired && /\/issues\/1$/.test(url.pathname)) {
      expired = true;
      await h.db.query(
        "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
      );
    }
  });
  assert.equal(await h.runtime.dispatchOnce(), "lease_lost");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  h.setFetchHook(null);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
});

test("unsupported actions quarantine and source installation revocation blocks dispatch", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h, 700, { action: "edited" });
  assert.equal(await h.runtime.dispatchOnce(), "quarantined");
  assert.equal((await dispatchRow(h)).reason_code, "unsupported_observation");
  assert.equal(h.calls.length, 0);
  await enqueueNotice(h, 701);
  await h.runtime.collection.suppress(fixtureId(799), "a".repeat(64), 1, [2], "revoked");
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h, 701)).reason_code, "source_unavailable");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 0);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
});

test("unknown webhook/source occurrence timestamps never become delivery-time credit", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  h.updateIssue(1, { created_at: null });
  await enqueueNotice(h, 700, { issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1 } });
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const unknown = (await h.db.query("SELECT observation FROM leaderboard_ingestion.observations")).rows[0].observation;
  assert.equal(unknown.occurredAt, null);
  const output = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows
    .map((row) => row.document)
    .flatMap((item) => item.facts)
    .find((fact) => fact.actorId === "101");
  assert.equal(output.occurredAt, null);
  assert.equal(output.state, "unknown");
  assert.equal(
    (await getBoard(h.runtime)).rows.some((row) => row.actorId === "101" && row.result.value > 0),
    false,
  );
});

test("dispatch stays opt-in, rejects public mode, and does not claim unapproved configuration", async (t) => {
  const disabled = await harness(t);
  await enqueueNotice(disabled);
  assert.equal(await disabled.runtime.dispatchOnce(), "blocked");
  assert.equal((await dispatchRow(disabled)).attempts, 0);
  await assert.rejects(
    createPipeline({ ...disabled.options, webhookDispatch: true, dataMode: "public" }),
    /public_webhook_dispatch_not_approved/,
  );
  const denied = await createPipeline({
    ...disabled.options,
    webhookDispatch: true,
    verifyConfiguration: async () => false,
  });
  t.after(() => denied.stop());
  assert.equal(await denied.dispatchOnce(), "blocked");
  assert.equal((await dispatchRow(disabled)).attempts, 0);
  await denied.stop();
});

function revokeAndRestoreConfiguration(store, repository) {
  store.transaction(
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
  store.transaction(
    (state) => {
      state.configuration.revision++;
      state.configuration.active.document.repositories = [
        {
          id: String(repository.id),
          installationId: String(repository.installationId),
          slug: repository.slug,
          capabilities: repository.families,
        },
      ];
    },
    { publish: true },
  );
}

test("configuration removal and restoration during dispatch hydration cannot authorize the earlier operation", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  let changed = false;
  h.setFetchHook((url) => {
    if (!changed && /\/issues\/1$/.test(url.pathname)) {
      changed = true;
      revokeAndRestoreConfiguration(h.controlsStore, h.config.repositories[0]);
    }
  });
  assert.equal(await h.runtime.dispatchOnce(), "quarantined");
  assert.equal((await dispatchRow(h)).reason_code, "configuration_changed");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  assert.equal(await h.runtime.dispatchOnce(), "idle");
});

for (const change of ["capability", "installation"])
  test(`configuration ${change} narrowing during dispatch is quarantined without publication`, async (t) => {
    const h = await harness(t, { webhookDispatch: true });
    await enqueueNotice(h);
    let changed = false;
    h.setFetchHook((url) => {
      if (!changed && /\/issues\/1$/.test(url.pathname)) {
        changed = true;
        revokeAndRestoreConfiguration(h.controlsStore, h.config.repositories[0]);
        h.controlsStore.transaction(
          (state) => {
            const repository = state.configuration.active.document.repositories[0];
            if (change === "capability") repository.capabilities = [];
            else repository.installationId = "999";
          },
          { publish: true },
        );
      }
    });
    assert.equal(await h.runtime.dispatchOnce(), "quarantined");
    assert.equal((await dispatchRow(h)).reason_code, "configuration_changed");
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
    assert.equal((await dispatchRow(h)).completion, null);
  });

test("a restarted dispatcher cannot rebind failed work to a different approved policy/configuration", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  h.setHydrationFailure(true);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  const prior = await dispatchRow(h);
  h.setHydrationFailure(false);
  await readyDispatch(h);
  const replacement = await createPipeline({
    ...h.options,
    config: { ...h.config, version: "synthetic-configuration-v2" },
  });
  t.after(() => replacement.stop());
  assert.equal(await replacement.dispatchOnce(), "quarantined");
  const current = await dispatchRow(h);
  assert.deepEqual(current.operation, prior.operation);
  assert.equal(current.reason_code, "configuration_changed");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  await replacement.stop();
});

test("source revocation during dispatch hydration cannot publish or acknowledge the result", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  let revoked = false;
  h.setFetchHook(async (url) => {
    if (!revoked && /\/issues\/1$/.test(url.pathname)) {
      revoked = true;
      await h.runtime.collection.suppress(fixtureId(799), "a".repeat(64), 1, [2], "revoked");
    }
  });
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h)).reason_code, "source_unavailable");
  assert.equal((await dispatchRow(h)).completion, null);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
});

test("unknown retained observation schema quarantines before any source request", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  await h.db.query("UPDATE leaderboard_ingestion.observations SET normalization_version='unsupported-observation/v2'");
  assert.equal(await h.runtime.dispatchOnce(), "quarantined");
  assert.equal((await dispatchRow(h)).reason_code, "unsupported_observation");
  assert.deepEqual(h.calls, []);
});

test("dispatch refreshes an eventually consistent completed scan without changing its frozen operation", async (t) => {
  const h = await harness(t, { webhookDispatch: true, source: undefined, probeRepository: undefined });
  await enqueueNotice(h, 700, {
    issue: { node_id: "SYNTHETIC_ISSUE_3", number: 3, created_at: ago(2).replace(/\.\d{3}Z$/, "Z") },
  });
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  const pending = await dispatchRow(h);
  assert.equal(pending.collection_revision, 1);
  assert.equal(pending.observation_cutoff, null);
  h.add({
    id: 1003,
    node_id: "SYNTHETIC_ISSUE_3",
    number: 3,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/3",
    created_at: ago(2),
    updated_at: ago(1),
    user: { id: 103, node_id: "U_SYNTHETIC_C", login: "synthetic-carol", type: "User" },
  });
  await readyDispatch(h);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const done = await dispatchRow(h);
  assert.deepEqual(done.operation, pending.operation);
  assert.equal(done.collection_revision, 1);
  assert.equal(h.calls.filter((path) => path.endsWith("/issues")).length, 2);
  assert.equal((await getBoard(h.runtime)).rows.find((row) => row.actorId === "103").result.value, 1);
});

test("a suppressed dispatch target cannot complete merely because its collection item exists", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  await h.db.query(
    "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(2,'SYNTHETIC_ISSUE_1','unavailable')",
  );
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h)).completion, null);
  assert.equal((await dispatchRow(h)).reason_code, "enrichment_unavailable");
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
});

test("failed dispatch persists authoritative target suppression before rejecting incomplete enrichment", async (t) => {
  let suppress = false,
    h;
  h = await harness(t, {
    webhookDispatch: true,
    normalizer: async (input) => {
      if (suppress && input.fact.subjectId === "SYNTHETIC_ISSUE_1")
        return {
          isSynthetic: true,
          facts: [],
          actors: [],
          evidence: [],
          suppressArtifactIds: ["SYNTHETIC_ISSUE_1"],
          reasons: ["source_object_unavailable"],
        };
      return components.github.createGithubEvidenceNormalizer({
        client: h.options.githubClient,
        source: "installation:1",
        allowedRepositoryIds: [2],
        isSynthetic: true,
      })(input);
    },
  });
  await h.runtime.runOnce();
  const original = await getBoard(h.runtime);
  const evidenceId = original.rows.find((row) => row.actorId === "101").evidenceIds[0];
  h.duplicate();
  suppress = true;
  await enqueueNotice(h);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h)).completion, null);
  assert.equal(
    (await h.db.query("SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=2")).rows[0]
      .subject_id,
    "SYNTHETIC_ISSUE_1",
  );
  assert.equal(
    (await getBoard(h.runtime, `&snapshot=${original.snapshotId}`)).rows.some((row) => row.actorId === "101"),
    false,
  );
  assert.equal(
    (await h.runtime.app.inject(`/api/v1/evidence/${evidenceId}?snapshot=${original.snapshotId}`)).statusCode,
    404,
  );
});

test("delayed failed dispatch preserves the last confirmed snapshot and cannot rewind a newer recovered head", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  const first = (await h.runtime.runOnce()).publications[0];
  await enqueueNotice(h);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      change(state);
      throw Error("synthetic_confirmation_failure");
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  h.controlsStore.transaction = transaction;
  const failed = (await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.heads")).rows[0];
  assert.equal(Number(failed.revision), 2);
  assert.equal((await getBoard(h.runtime)).snapshotId, first.snapshotId);
  assert.equal((await getBoard(h.runtime, `&snapshot=${first.snapshotId}`)).head.snapshotId, first.snapshotId);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${failed.snapshot_id}`)).statusCode, 410);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 1);
  const third = (await h.runtime.runOnce()).publications[0];
  assert.equal(third.revision, 3);
  await h.reopenDatabase();
  await readyDispatch(h);
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  assert.equal(await recovered.dispatchOnce(), "processed");
  const done = await dispatchRow(h);
  assert.equal(done.completion.publications[0].snapshotId, failed.snapshot_id);
  assert.equal((await getBoard(recovered)).snapshotId, third.snapshotId);
  const pinned = await getBoard(recovered, `&snapshot=${failed.snapshot_id}`);
  assert.equal(pinned.snapshotId, failed.snapshot_id);
  assert.equal(pinned.head.snapshotId, third.snapshotId);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 3);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 3);
  assert.doesNotMatch(JSON.stringify(h.controlsStore.publicSnapshot()), /pipelineHeads|pipelinePublications|audit/);
});

test("unconfirmed dispatch cannot attach changed private inputs to identical public snapshot content", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await h.runtime.runOnce();
  const before = await getBoard(h.runtime);
  await enqueueNotice(h);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      change(state);
      throw Error("synthetic_confirmation_failure");
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  h.controlsStore.transaction = transaction;
  const unconfirmed = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id;
  const requestId = fixtureId(901);
  const factId = before.rows.find((row) => row.actorId === "101").evidenceIds[0];
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
  await h.runtime.applyCorrection({
    requestId,
    expectedVersion: 1,
    factId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  });
  // This correction is later than the dispatch's frozen observation cutoff.
  // It changes private input/audit provenance without changing the old public
  // aggregate. The stored full-input receipt, not public content equality, fences it.
  const dbTransaction = h.db.transaction;
  let rejectedInput = null;
  h.db.transaction = (work) =>
    dbTransaction(work).catch((error) => {
      rejectedInput = error.message;
      throw error;
    });
  await readyDispatch(h);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h)).reason_code, "publication_unavailable");
  assert.equal(rejectedInput, "dispatch_snapshot_input_changed_or_unbound");
  assert.equal(h.controlsStore.read().pipelinePublications[unconfirmed], undefined);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 1);
  const retained = await getBoard(h.runtime);
  assert.equal(retained.snapshotId, before.snapshotId);
  assert.deepEqual(
    retained.rows.map((row) => row.actorId),
    ["102"],
  );
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${unconfirmed}`)).statusCode, 410);
});

test("a delayed historical dispatch cannot initialize missing private head authority", async (t) => {
  const h = await harness(t, { webhookDispatch: true });
  await enqueueNotice(h);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic process loss");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic process loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic process loss/);
  const old = await getBoard(h.runtime);
  const newer = (await h.runtime.runOnce()).publications[0];
  h.controlsStore.transaction((state) => {
    delete state.pipelineHeads;
  });
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  assert.equal(await recovered.dispatchOnce(), "retry_scheduled");
  assert.equal((await recovered.app.inject(boardUrl)).statusCode, 503);
  assert.equal(h.controlsStore.read().pipelineHeads, undefined);
  assert.equal(
    (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id,
    newer.snapshotId,
  );
  const fresh = (await recovered.runOnce()).publications[0];
  assert.equal(fresh.revision, 3);
  await readyDispatch(h);
  assert.equal(await recovered.dispatchOnce(), "processed");
  assert.equal((await getBoard(recovered)).snapshotId, fresh.snapshotId);
  assert.equal((await getBoard(recovered, `&snapshot=${old.snapshotId}`)).head.snapshotId, fresh.snapshotId);
});
