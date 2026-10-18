import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  canonicalPublicScope,
  publicContributionRoles,
  publicScopeKey,
  publicScopeParameters,
} from "@pick-your-ai/contracts";
import { createPipeline } from "../src/index.mjs";
import { publicationMonitorIdentity } from "../src/scope-storage.mjs";
import { OperationalMonitor } from "../../../infra/observability/monitor.mjs";
import { ago, clock, components, fixtureId, harness, publicScope } from "./harness.mjs";
import { hash, projects } from "./scope-storage-harness.mjs";

const scopeV2 = canonicalPublicScope({ ...publicScope, context: "current", projects });
const scopeV3 = canonicalPublicScope({ ...scopeV2, schemaVersion: undefined, roles: publicContributionRoles });
const monitor = () =>
  new OperationalMonitor({
    freshnessBudgetMs: 60_000,
    alertCooldownMs: 1000,
    retentionMs: 120_000,
    maximumEntries: 100,
  });
const url = (scope, pin) =>
  `/api/v1/boards?${new URLSearchParams({ ...publicScopeParameters(scope), metric: "issues_opened", ...(pin ? { snapshot: pin } : {}) })}`;
const publicationRows = async (db) =>
  (
    await db.query(`SELECT snapshot_id,scope_key,revision,document,document_hash
  FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id`)
  ).rows;

async function scopeHarness(t, scopes = [publicScope, scopeV2, scopeV3], extra = {}) {
  return harness(t, {
    ...extra,
    configure(config) {
      config.scopes = structuredClone(scopes);
      config.repositories[0].allowedProjectIds = projects;
    },
  });
}

test("approval denial reads use the bounded receipt index and retain exact repository, version and kind fences", async (t) => {
  const h = await harness(t);
  const key = (id, version = h.config.version) => `project-scope-denial:${id}:${hash(JSON.stringify(version))}`;
  const expectedKey = key(2);
  const unrelatedKey = key(99);
  const document = JSON.stringify({ synthetic: true });
  const saved = (operation, kind = "project_scope_denial") => ({
    operation,
    kind,
    receiptId: hash(JSON.stringify([operation, kind])),
  });
  const rows = [
    ...Array.from({ length: 1024 }, (_, index) => saved(`SYNTHETIC_RETAINED_DENIAL:${index}`)),
    saved(key(2, h.config.version + "-previous")),
    saved(unrelatedKey),
    saved(expectedKey, "source_unavailable"),
  ];
  await h.db.query(
    `INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash,operation_hash)
    SELECT value->>'receiptId',value->>'operation',value->>'kind',$2::jsonb,$3,
      sha256(convert_to(value->>'operation','UTF8')) FROM jsonb_array_elements($1::jsonb)`,
    [JSON.stringify(rows), document, hash(document)],
  );

  const query = h.db.query;
  let captured;
  h.db.query = async (sql, parameters) => {
    if (sql.includes("project_scope_denial") && sql.startsWith("SELECT"))
      captured = { sql, parameters: structuredClone(parameters) };
    return query(sql, parameters);
  };
  let first;
  try {
    first = await h.runtime.runOnce({ cutoff: clock() });
    assert.equal(first.state, "published", "other repositories, old versions and another receipt kind must not deny");
    const read = await h.runtime.source.read(
      publicScope,
      first.publications[0].snapshotId,
      new AbortController().signal,
    );
    assert.equal(read.selected.snapshot.snapshotId, first.publications[0].snapshotId);
  } finally {
    h.db.query = query;
  }
  assert.ok(captured, "capture the actual approval query used by the publisher and public reader");
  assert.deepEqual(captured.parameters, [[expectedKey]]);
  assert.deepEqual((await h.db.query(captured.sql, captured.parameters)).rows, []);
  assert.deepEqual(
    (await h.db.query(captured.sql, [Array.from({ length: 100 }, (_, index) => key(index + 1))])).rows,
    [{ operation_key: unrelatedKey }],
    "the complete admitted repository set must retain exact matching and receipt kind",
  );

  const plan = await h.db.transaction(async (tx) => {
    // Suppress tiny-fixture sequential-scan preference, without forcing an index
    // or disabling join strategies. The actual digest predicate must be usable.
    await tx.query("SET LOCAL enable_seqscan=off");
    return (await tx.query("EXPLAIN (FORMAT JSON) " + captured.sql, captured.parameters)).rows[0]["QUERY PLAN"][0].Plan;
  });
  const nodes = (value) => [value, ...(value.Plans ?? []).flatMap(nodes)];
  assert.ok(
    nodes(plan).some(
      (node) =>
        node["Index Name"] === "receipts_operation_hash_key" && /operation_hash\s*=/.test(node["Index Cond"] ?? ""),
    ),
    "the captured approval query must probe the bounded operation hash index: " + JSON.stringify(plan),
  );

  await h.db.query("DELETE FROM leaderboard_pipeline.receipts WHERE operation_key=$1", [expectedKey]);
  await h.db.query("ALTER TABLE leaderboard_pipeline.receipts DROP CONSTRAINT receipts_operation_hash_valid");
  await h.db.query(
    "UPDATE leaderboard_pipeline.receipts SET operation_hash=sha256(convert_to($1,'UTF8')) WHERE operation_key=$2",
    [expectedKey, unrelatedKey],
  );
  // Deliberate post-startup corruption tests the raw equality fence; no actual
  // SHA-256 collision is claimed and the validated constraint is restored below.
  const stillApproved = await h.runtime.source.read(
    publicScope,
    first.publications[0].snapshotId,
    new AbortController().signal,
  );
  assert.equal(stillApproved.selected.snapshot.snapshotId, first.publications[0].snapshotId);
  await h.db.query("UPDATE leaderboard_pipeline.receipts SET operation_key=$1,receipt_id=$2 WHERE operation_key=$3", [
    expectedKey,
    saved(expectedKey).receiptId,
    unrelatedKey,
  ]);
  await h.db.query(
    "ALTER TABLE leaderboard_pipeline.receipts ADD CONSTRAINT receipts_operation_hash_valid CHECK(operation_hash=sha256(convert_to(operation_key,'UTF8')))",
  );
  assert.equal(h.controlsStore.read().pipelineSourceDenials, undefined, "the SQL receipt supplies this denial");
  await assert.rejects(
    () => h.runtime.source.read(publicScope, first.publications[0].snapshotId, new AbortController().signal),
    /project_source_scope_requires_reapproval/,
  );
  await assert.rejects(() => h.runtime.runOnce({ cutoff: clock() }), /project_source_scope_requires_reapproval/);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  await assert.rejects(() => restarted.runOnce({ cutoff: clock() }), /project_source_scope_requires_reapproval/);
  assert.notEqual((await restarted.app.inject(url(publicScope, first.publications[0].snapshotId))).statusCode, 200);
});

test("actual publisher retains distinct full v2/v3 scopes, exact frozen inputs, old pins and private authority after restart", async (t) => {
  const telemetry = monitor();
  const h = await scopeHarness(t, undefined, { monitor: telemetry });
  const configBefore = JSON.stringify(h.config);
  const first = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(first.state, "published");
  assert.equal(first.publications.length, 3);
  assert.equal(new Set(first.publications.map((value) => value.snapshotId)).size, 3);
  const snapshots = await publicationRows(h.db);
  const receipts = (
    await h.db.query(
      "SELECT receipt_id,operation_key,kind,document,document_hash FROM leaderboard_pipeline.receipts ORDER BY receipt_id",
    )
  ).rows;
  for (const [index, scope] of h.config.scopes.entries()) {
    const published = first.publications[index];
    const key = publicScopeKey(scope);
    const saved = snapshots.find((row) => row.snapshot_id === published.snapshotId);
    assert.equal(saved.scope_key, key);
    assert.deepEqual(saved.document.scope, scope);
    const frozen = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        published.snapshotId,
      ])
    ).rows[0].document;
    assert.deepEqual(frozen.scope, scope);
    assert.deepEqual(frozen.engineScope.roles, scope.roles ?? []);
    assert.deepEqual(frozen.engineScope.projects, scope.projects ?? []);
    const rawOperation = `publish:${key}:${published.snapshotId}`;
    const receipt = receipts.find((row) => row.operation_key === rawOperation);
    assert.equal(receipt.receipt_id, hash(JSON.stringify([rawOperation, "snapshot_published"])));
    assert.equal(h.controlsStore.read().pipelineHeads[key].snapshotId, published.snapshotId);
    assert.equal(telemetry.status(publicationMonitorIdentity(key), "publication").state, "fresh");
    const read = await h.runtime.source.read(scope, published.snapshotId, new AbortController().signal);
    assert.equal(read.selected.snapshot.snapshotId, published.snapshotId);
    assert.deepEqual(read.selected.scope, scope);
    if (index === 0) {
      const response = await h.runtime.app.inject(url(scope, published.snapshotId));
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().snapshotId, published.snapshotId);
    }
  }
  const privateBefore = h.controlsStore.read();
  await h.runtime.stop();
  await h.reopenDatabase();
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  for (const [index, scope] of h.config.scopes.entries()) {
    const read = await recovered.source.read(scope, first.publications[index].snapshotId, new AbortController().signal);
    assert.equal(read.selected.snapshot.snapshotId, first.publications[index].snapshotId);
    assert.deepEqual(read.selected.scope, scope);
    const wrong = await recovered.source.read(
      scope,
      first.publications[(index + 1) % 3].snapshotId,
      new AbortController().signal,
    );
    assert.equal(wrong, null);
  }
  assert.deepEqual(await publicationRows(h.db), snapshots);
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT receipt_id,operation_key,kind,document,document_hash FROM leaderboard_pipeline.receipts ORDER BY receipt_id",
      )
    ).rows,
    receipts,
  );
  assert.deepEqual(h.controlsStore.read(), privateBefore);
  assert.equal(JSON.stringify(h.config), configBefore);
  h.setPrivate(true);
  await recovered.runOnce({ cutoff: clock() }).catch(() => {});
  for (const [index, scope] of h.config.scopes.entries())
    assert.equal(
      await recovered.source.read(scope, first.publications[index].snapshotId, new AbortController().signal),
      null,
    );
});

test("a corrupted occupied head digest slot cannot replace a different raw scope or confirm a new revision", async (t) => {
  const telemetry = monitor();
  const h = await scopeHarness(t, [scopeV3], { monitor: telemetry });
  await h.runtime.runOnce({ cutoff: clock() });
  const before = await publicationRows(h.db);
  const privateBefore = h.controlsStore.read();
  await h.db.query("ALTER TABLE leaderboard_pipeline.heads DROP CONSTRAINT heads_scope_hash_valid");
  const different = publicScopeKey(canonicalPublicScope({ ...scopeV3, roles: ["author"] }));
  await h.db.query("UPDATE leaderboard_pipeline.heads SET scope_key=$1", [different]);
  const heads = (await h.db.query("SELECT * FROM leaderboard_pipeline.heads")).rows;
  await assert.rejects(() => h.runtime.runOnce({ cutoff: clock() }), /pipeline_scope_identity_conflict/);
  assert.deepEqual(await publicationRows(h.db), before);
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.heads")).rows, heads);
  assert.deepEqual(h.controlsStore.read(), privateBefore);
  assert.equal(telemetry.status(publicationMonitorIdentity(publicScopeKey(scopeV3)), "publication").state, "error");
});

test("a corrupted receipt digest slot cannot acknowledge another literal operation and the whole publication rolls back", async (t) => {
  const h = await scopeHarness(t, [scopeV2]);
  await h.runtime.runOnce({ cutoff: clock() });
  await h.db.query("ALTER TABLE leaderboard_pipeline.receipts DROP CONSTRAINT receipts_operation_hash_valid");
  const snapshots = await publicationRows(h.db);
  const receipts = (await h.db.query("SELECT * FROM leaderboard_pipeline.receipts ORDER BY receipt_id")).rows;
  const prior = receipts.find((row) => row.kind === "snapshot_published");
  const transaction = h.db.transaction;
  let injected = false;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, parameters) => {
          if (sql.includes("INSERT INTO leaderboard_pipeline.receipts") && parameters?.[2] === "snapshot_published") {
            assert.notEqual(parameters[1], prior.operation_key);
            await tx.query(
              "UPDATE leaderboard_pipeline.receipts SET operation_hash=sha256(convert_to($1,'UTF8')) WHERE receipt_id=$2",
              [parameters[1], prior.receipt_id],
            );
            injected = true;
          }
          return tx.query(sql, parameters);
        },
      }),
    );
  try {
    await assert.rejects(() => h.runtime.runOnce({ cutoff: clock() }), /pipeline_receipt_identity_conflict/);
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(injected, true, "the real receipt insertion must encounter the occupied digest slot");
  assert.deepEqual(await publicationRows(h.db), snapshots);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.receipts ORDER BY receipt_id")).rows,
    receipts,
  );
});

async function enqueue(h) {
  const secret = "SYNTHETIC_SCOPE_STORAGE_WEBHOOK_SECRET_32_CHARACTERS";
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: { node_id: "SYNTHETIC_SENDER" },
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2) },
  });
  const handler = components.ingestion.createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
  });
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": fixtureId(819),
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(response.status, 202, await response.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
}

test("an interrupted dispatch reuses its exact receipt after restart and a mismatched scope slot never completes", async (t) => {
  const h = await scopeHarness(t, [publicScope], { webhookDispatch: true });
  await enqueue(h);
  const change = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (work, options) =>
    change((state) => {
      const result = work(state);
      if (state.pipelinePublications) throw new Error("SYNTHETIC_CONFIRMATION_INTERRUPTION");
      return result;
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  h.controlsStore.transaction = change;
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.dispatch_publications")).rows;
  assert.equal(saved.length, 1);
  const snapshots = await publicationRows(h.db);
  await h.runtime.stop();
  await h.reopenDatabase();
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  await h.db.query(
    "ALTER TABLE leaderboard_pipeline.dispatch_publications DROP CONSTRAINT dispatch_publications_scope_hash_valid",
  );
  await h.db.query("UPDATE leaderboard_pipeline.dispatch_publications SET scope_key=$1", [
    publicScopeKey({ ...publicScope, workstream: "SYNTHETIC_UNRELATED" }),
  ]);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
  const transaction = h.db.transaction;
  const failures = [];
  h.db.transaction = (work) =>
    transaction(work).catch((error) => {
      failures.push(error.message);
      throw error;
    });
  try {
    assert.equal(await recovered.dispatchOnce(), "retry_scheduled");
  } finally {
    h.db.transaction = transaction;
  }
  assert.ok(
    failures.includes("dispatch_publication_conflict"),
    "the actual exact-key dispatch guard must reject the occupied slot",
  );
  assert.equal((await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox")).rows[0].completion, null);
  assert.deepEqual(await publicationRows(h.db), snapshots);
  assert.equal((await recovered.app.inject(url(publicScope))).statusCode, 503);
  await h.db.query("UPDATE leaderboard_pipeline.dispatch_publications SET scope_key=$1", [saved[0].scope_key]);
  await h.db.query(
    "ALTER TABLE leaderboard_pipeline.dispatch_publications ADD CONSTRAINT dispatch_publications_scope_hash_valid CHECK(scope_hash=sha256(convert_to(scope_key,'UTF8')))",
  );
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
  assert.equal(await recovered.dispatchOnce(), "processed");
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.dispatch_publications")).rows, saved);
  assert.deepEqual(await publicationRows(h.db), snapshots);
  const response = await recovered.app.inject(url(publicScope));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().snapshotId, saved[0].snapshot_id);
  assert.equal(await recovered.dispatchOnce(), "idle");
});

test("startup schema rejection occurs before configuration, source or collection work", async (t) => {
  const h = await scopeHarness(t, [scopeV2]);
  await h.db.query("UPDATE leaderboard_pipeline.storage_migrations SET version='pipeline-storage/v999'");
  let touched = 0;
  await assert.rejects(
    () =>
      createPipeline({
        ...h.options,
        verifyConfiguration: async () => {
          touched++;
          return true;
        },
        probeRepository: async () => {
          touched++;
          throw Error("SYNTHETIC_PROBE");
        },
      }),
    /unsupported_pipeline_storage_schema/,
  );
  assert.equal(touched, 0);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS count FROM leaderboard_ingestion.collection_runs")).rows[0].count,
    0,
  );
});

test("short telemetry identities remain exact and long scopes have separate bounded success/failure identities", async () => {
  const telemetry = monitor();
  const short = publicScopeKey(publicScope);
  assert.equal(publicationMonitorIdentity(short), short);
  assert.equal(publicationMonitorIdentity("S".repeat(200)), "S".repeat(200));
  for (const scope of [scopeV2, scopeV3]) {
    const key = publicScopeKey(scope);
    const source = publicationMonitorIdentity(key);
    assert.equal(source, `pipeline-scope/v1:${hash(key)}`);
    assert.ok(source.length < 200);
    telemetry.success({ source, stage: "publication", latencyMs: 0, revision: "1" });
    assert.equal(telemetry.status(source, "publication").state, "fresh");
  }
  assert.notEqual(
    publicationMonitorIdentity(publicScopeKey(scopeV2)),
    publicationMonitorIdentity(publicScopeKey(scopeV3)),
  );
  telemetry.success({ source: short, stage: "publication", latencyMs: 0, revision: "1" });
  assert.equal(telemetry.internal().at(-1).sourceKey, hash(short));
  const source = publicationMonitorIdentity(publicScopeKey(scopeV3));
  const result = await telemetry.failure({
    source,
    stage: "publication",
    code: "publication_failed",
    traceId: "SYNTHETIC_TRACE",
  });
  assert.equal(result.state, "undelivered");
  assert.equal(telemetry.status(source, "publication").state, "error");
  assert.equal(telemetry.status(publicationMonitorIdentity(publicScopeKey(scopeV2)), "publication").state, "fresh");
  assert.equal(JSON.stringify(telemetry.internal()).includes(projects[0]), false);
});
