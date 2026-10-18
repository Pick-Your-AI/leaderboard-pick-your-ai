import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { webhookDispatchVersion } from "../src/webhook-dispatch.mjs";
import { components, clock, fixtureId, publicScope } from "./harness.mjs";
import {
  operatorAllow as allow,
  operatorSettings as settings,
  operatorScopes as scopes,
  operatorHarness as ready,
  insertOperatorDelivery as insert,
  queueOperatorReplay as queue,
  publishedOperatorReplay as published,
} from "./operator-harness.mjs";
const health = (h, authorize = allow) => h.runtime.operations.readHealth(2, authorize);
const result = (h, receipt, authorize = allow) => h.runtime.operations.readReplayResult(2, receipt.id, authorize);

test("an empty inbox and no attempted collection remain unknown, never a quiet source", async (t) => {
  const h = await ready(t);
  const value = await health(h);
  assert.equal(value.collector.state, "unknown");
  assert.equal(value.collector.families[0].reason, "no_current_attempt");
  assert.equal(value.intake.retained, 0);
  assert.equal(value.intake.queueAgeSeconds, null);
  assert.equal(value.intake.lagSeconds, null);
  assert.equal(value.publication.state, "unknown");
  assert.equal(value.publication.delaySeconds, null);
  assert.deepEqual(h.githubReads, { fetches: 0, tokens: 0 });
});

test("a fresh completed empty window is quiet while a failed collection read is disconnected", async (t) => {
  const quiet = await ready(t, { payloads: [] });
  assert.equal((await quiet.runtime.runOnce({ cutoff: clock() })).state, "published");
  const value = await health(quiet);
  assert.equal(value.collector.state, "quiet");
  assert.equal(value.collector.families[0].reason, "completed_empty_window");
  assert.equal(value.collector.families[0].expectedItems, 0);
  const failed = await ready(t, {
    source: {
      async readPage() {
        throw new Error("synthetic private exception and URL");
      },
    },
  });
  assert.equal((await failed.runtime.runOnce({ cutoff: clock() })).state, "collecting");
  const disconnected = await health(failed);
  assert.equal(disconnected.collector.state, "disconnected");
  assert.equal(disconnected.collector.families[0].reason, "source_read_failed");
  assert.equal(JSON.stringify(disconnected).includes("private exception"), false);
  assert.equal(disconnected.intake.retained, 0);
});

test("old empty windows, unknown source counts and future collection clocks cannot establish quiet", async (t) => {
  let advance = 0;
  const h = await ready(t, { payloads: [], now: () => new Date(Date.now() + advance).toISOString() });
  await h.runtime.runOnce({ cutoff: clock() });
  advance = 61_000;
  assert.equal((await health(h)).collector.state, "overdue");
  advance = 0;
  await h.db.query("UPDATE leaderboard_ingestion.collection_runs SET expected_count=NULL");
  assert.equal((await health(h)).collector.state, "unknown");
  await h.db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET expected_count=0,attempted_at=clock_timestamp()+interval '1 day'",
  );
  const unknown = await health(h);
  assert.equal(unknown.collector.state, "unknown");
  assert.equal(unknown.collector.families[0].lastAttemptAt, null);
});

test("retained intake timestamps measure lag and queue age while absent or future action time stays unknown", async (t) => {
  const h = await ready(t);
  await insert(h, 1, new Date(Date.now() - 5000).toISOString());
  const observed = await health(h);
  assert.equal(observed.intake.pending, 1);
  assert.ok(observed.intake.lagSeconds >= 5 && observed.intake.lagSeconds < 20);
  assert.ok(observed.intake.queueAgeSeconds >= 0);
  await insert(h, 2, null);
  assert.equal((await health(h)).intake.lagSeconds, null);
  await insert(h, 3, new Date(Date.now() + 60_000).toISOString());
  const future = await health(h);
  assert.equal(future.intake.lagSeconds, null);
  assert.equal(future.intake.latestSourceAt, null);
});

test("private quota reads expose only the current pool's fixed observations without HTTP or credentials", async (t) => {
  const h = await ready(t, {
    quotaHeaders: {
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-used": "5000",
      "x-private-source-header": "synthetic-private-header",
    },
  });
  // Observe one real exhausted response. Diagnostics must not need another
  // request (which correctly waits for the separately retained pool pause).
  await h.options.githubClient.forRepository(2).rest("installation:1", "/repos/synthetic-org/synthetic-repo");
  const before = { ...h.githubReads };
  const value = await health(h);
  assert.deepEqual(h.githubReads, before);
  assert.equal(value.quota.state, "available");
  assert.equal(value.quota.resources.length, 5);
  assert.equal(value.quota.resources.find((row) => row.resource === "core").observation.remaining, 0);
  assert.equal(value.quota.resources.find((row) => row.resource === "graphql").observation, null);
  for (const hidden of ["synthetic-test-token", "synthetic-private-header", "installation:1", "api.synthetic.invalid"])
    assert.equal(JSON.stringify(value).includes(hidden), false);
});

test("configuration approval, host currentness, repository epoch and final operator authorization remain independent", async (t) => {
  let current = true;
  const h = await ready(t, { operatorDiagnostics: settings(() => current) });
  await health(h);
  let calls = 0;
  await assert.rejects(
    () =>
      health(h, async () => {
        if (++calls === 2) current = false;
        return allow();
      }),
    /operation_health_changed/,
  );
  current = true;
  await assert.rejects(
    () =>
      health(h, async () => {
        throw new Error("synthetic revoked grant");
      }),
    /revoked grant/,
  );
  await h.runtime.collection.suppress(fixtureId(90), "f".repeat(64), 1, [2], "private");
  await assert.rejects(() => health(h), /operation_source_unavailable/);
});

test("a promise-returning currentness callback cannot authorize an operator diagnostic", async (t) => {
  const h = await ready(t, { operatorDiagnostics: settings(async () => true) });
  await assert.rejects(() => health(h), /operation_health_unavailable/);
});

test("actual dispatcher receipts bind a replay to each confirmed scope and measure publication delay", async (t) => {
  const { h, receipt } = await published(t);
  const value = await result(h, receipt);
  assert.equal(value.status, "published");
  assert.equal(value.publications.length, 2);
  assert.equal(new Set(value.publications.map((row) => row.scopeKey)).size, 2);
  const saved = (
    await h.db.query("SELECT scope_key,snapshot_id,revision FROM leaderboard_pipeline.snapshots ORDER BY scope_key")
  ).rows;
  assert.deepEqual(
    value.publications.slice().sort((a, b) => a.scopeKey.localeCompare(b.scopeKey)),
    saved
      .map((row) => ({
        scopeKey: row.scope_key,
        snapshotId: row.snapshot_id,
        revision: Number(row.revision),
      }))
      .sort((a, b) => a.scopeKey.localeCompare(b.scopeKey)),
  );
  assert.ok(value.processingDelaySeconds >= 0);
  assert.ok(value.publicationDelaySeconds >= value.processingDelaySeconds);
  const observed = await health(h);
  assert.equal(observed.publication.state, "verified");
  assert.deepEqual(observed.publication.publications, value.publications);
  assert.ok(observed.publication.delaySeconds >= value.publicationDelaySeconds);
  assert.equal(observed.collector.state, "progress");
});

test("outbox done JSON cannot substitute for the pipeline's actual publication ledger", async (t) => {
  const h = await ready(t);
  const receipt = await queue(h);
  await h.runtime.inbox.complete(await h.runtime.inbox.claim());
  const lease = await h.runtime.outbox.claim({
    configurationHash: createHash("sha256").update(JSON.stringify(h.config)).digest("hex"),
    configurationVersion: h.config.version,
    configurationRevision: 0,
    normalizationVersion: webhookDispatchVersion,
    policyVersion: components.metrics.metricRegistryV1.policy_version,
    dataMode: "synthetic",
    cutoff: clock(),
  });
  await h.runtime.outbox.freeze(lease, clock(), [{ repositoryId: 2, generation: "1" }]);
  await h.runtime.outbox.complete(
    lease,
    [{ scopeKey: components.contracts.publicScopeKey(publicScope), snapshotId: "b".repeat(64), revision: 1 }],
    async () => {},
  );
  const value = await result(h, receipt);
  assert.equal(value.status, "unavailable");
  assert.deepEqual(value.publications, []);
  const observed = await health(h);
  assert.equal(observed.publication.state, "unavailable");
  assert.equal(observed.publication.delaySeconds, null);
});

test("a later dispatch cannot graft a confirmed snapshot from a different publication window", async (t) => {
  const { h, receipt: priorReceipt } = await published(t);
  const prior = await result(h, priorReceipt);
  assert.equal(prior.status, "published");
  const receipt = await queue(h, 2);
  await h.runtime.inbox.complete(await h.runtime.inbox.claim());
  const lease = await h.runtime.outbox.claim({
    configurationHash: createHash("sha256").update(JSON.stringify(h.config)).digest("hex"),
    configurationVersion: h.config.version,
    configurationRevision: 0,
    normalizationVersion: webhookDispatchVersion,
    policyVersion: components.metrics.metricRegistryV1.policy_version,
    dataMode: "synthetic",
    cutoff: clock(),
  });
  const frozen = await h.runtime.outbox.freeze(lease, clock(), [{ repositoryId: 2, generation: "1" }]);
  const priorOperation = (
    await h.db.query("SELECT operation FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
      `github:delivery:${priorReceipt.deliveryId}`,
    ])
  ).rows[0].operation;
  assert.notEqual(lease.operation.cutoff, priorOperation.cutoff);
  assert.ok(frozen.cutoff >= lease.operation.cutoff);
  // Simulate an invalid host confirmation that copies otherwise authentic
  // snapshot/private-proof identities into the new operation's SQL mapping.
  assert.equal(
    await h.runtime.outbox.complete(lease, prior.publications, async (tx) => {
      for (const publication of prior.publications)
        await tx.query(
          "INSERT INTO leaderboard_pipeline.dispatch_publications(operation_key,scope_key,snapshot_id) VALUES($1,$2,$3)",
          [lease.operation.operationKey, publication.scopeKey, publication.snapshotId],
        );
    }),
    true,
  );
  const withheld = await result(h, receipt);
  assert.equal(withheld.status, "unavailable");
  assert.deepEqual(withheld.publications, []);
  assert.equal(withheld.publicationDelaySeconds, null);
  assert.equal((await health(h)).publication.state, "unavailable");
});

test("a real content-identical dispatch may retain its existing revision after a later observation freeze", async (t) => {
  const { h, receipt: priorReceipt } = await published(t);
  const prior = await result(h, priorReceipt);
  const earlier = (
    await h.db.query("SELECT operation,observation_cutoff FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
      `github:delivery:${priorReceipt.deliveryId}`,
    ])
  ).rows[0];
  const receipt = await queue(h, 2);
  await h.runtime.inbox.complete(await h.runtime.inbox.claim());
  const { operationKey: ignored, ...binding } = earlier.operation;
  const lease = await h.runtime.outbox.claim(binding);
  assert.equal(await h.runtime.outbox.fail(lease, "publication_unavailable"), "retry_scheduled");
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()-interval '1 second' WHERE event_key=$1",
    [lease.eventKey],
  );
  // Exercise the actual dispatcher and publisher. Its persisted operation keeps
  // the original event window while a new complete read freezes later evidence.
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const later = (
    await h.db.query("SELECT observation_cutoff FROM leaderboard_ingestion.outbox WHERE event_key=$1", [lease.eventKey])
  ).rows[0];
  assert.ok(new Date(later.observation_cutoff) > new Date(earlier.observation_cutoff));
  const value = await result(h, receipt);
  assert.equal(value.status, "published");
  assert.deepEqual(value.publications, prior.publications);
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS count FROM leaderboard_pipeline.snapshots")).rows[0].count,
    2,
  );
  assert.equal((await health(h)).publication.state, "verified");
});

test("current private suppression withholds old publication references and latency", async (t) => {
  const { h, receipt } = await published(t);
  assert.equal((await result(h, receipt)).status, "published");
  h.controlsStore.transaction((state) => {
    state.profiles["101"] = { ...state.profiles["101"], suppressed: true };
  });
  const withheld = await result(h, receipt);
  assert.equal(withheld.status, "unavailable");
  assert.deepEqual(withheld.publications, []);
  assert.equal(withheld.publicationDelaySeconds, null);
  assert.equal((await health(h)).publication.state, "unavailable");
});

test("a restarted publisher recovers the expired intake lease and produces one verified multi-scope result", async (t) => {
  const h = await ready(t, {
    webhookDispatch: true,
    configure: (config) => {
      config.scopes = scopes;
    },
  });
  const receipt = await queue(h);
  const staleLease = await h.runtime.inbox.claim();
  await h.db.query(
    "UPDATE leaderboard_ingestion.inbox SET lease_until=clock_timestamp()-interval '1 second' WHERE delivery_id=$1",
    [receipt.deliveryId],
  );
  await h.runtime.stop();
  await h.reopenDatabase();
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  assert.equal(await recovered.inbox.complete(staleLease), false);
  const lease = await recovered.inbox.claim();
  assert.ok(lease && lease.token !== staleLease.token);
  assert.equal(await recovered.inbox.complete(lease), true);
  assert.equal(await recovered.inbox.complete(lease), false);
  assert.equal(await recovered.dispatchOnce(), "processed");
  assert.equal(await recovered.dispatchOnce(), "idle");
  const value = await recovered.operations.readReplayResult(2, receipt.id, allow);
  assert.equal(value.status, "published");
  assert.equal(value.publications.length, 2);
  const counts = (
    await h.db.query(`SELECT
    (SELECT count(*)::integer FROM leaderboard_ingestion.observations) AS observations,
    (SELECT count(*)::integer FROM leaderboard_ingestion.outbox) AS notices,
    (SELECT count(*)::integer FROM leaderboard_ingestion.replay_processing_results) AS results,
    (SELECT count(*)::integer FROM leaderboard_pipeline.dispatch_publications) AS publications`)
  ).rows[0];
  assert.deepEqual(counts, { observations: 1, notices: 1, results: 1, publications: 2 });
  assert.equal((await recovered.operations.readHealth(2, allow)).collector.state, "progress");
});
