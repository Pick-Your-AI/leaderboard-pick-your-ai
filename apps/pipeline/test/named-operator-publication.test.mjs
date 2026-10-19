import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { webhookDispatchVersion } from "../src/webhook-dispatch.mjs";
import { components, ago, publicScope } from "./harness.mjs";
import { operatorAllow, operatorHarness, queueOperatorReplay, insertOperatorDelivery } from "./operator-harness.mjs";

const second = (value) => value.replace(/\.\d{3}Z$/, ".000Z");

test("operator verification binds mixed named and exact scopes to the persisted replay cutoff", async (t) => {
  let current = null;
  const templates = [
    { ...publicScope, period: "30d" },
    { ...publicScope, repository: "2", roles: ["reporter"], period: "7d" },
    { ...publicScope },
    { ...publicScope, repository: "2", start: second(ago(20)), end: second(ago(1)), period: "custom" },
  ];
  const h = await operatorHarness(t, {
    now: () => current ?? new Date().toISOString(),
    webhookDispatch: true,
    configure(config) {
      config.scopes = structuredClone(templates);
    },
  });
  const receipt = await queueOperatorReplay(h);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  const cutoff = second(new Date().toISOString());
  const lease = await h.runtime.outbox.claim({
    configurationHash: createHash("sha256").update(JSON.stringify(h.config)).digest("hex"),
    configurationVersion: h.config.version,
    configurationRevision: 0,
    normalizationVersion: webhookDispatchVersion,
    policyVersion: components.metrics.metricRegistryV1.policy_version,
    dataMode: "synthetic",
    cutoff,
  });
  assert.ok(lease);
  assert.equal(await h.runtime.outbox.fail(lease, "publication_unavailable"), "retry_scheduled");
  const pending = (await h.db.query("SELECT operation FROM leaderboard_ingestion.outbox")).rows[0].operation;
  assert.equal(pending.cutoff, cutoff);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const expectedScopes = templates.map(({ period, ...scope }) => {
    if (period !== "30d" && period !== "7d") return scope;
    const window = components.metrics.resolveMetricWindow(period, cutoff);
    return { ...scope, start: window.from, end: window.to };
  });
  const operation = (await h.db.query("SELECT operation FROM leaderboard_ingestion.outbox")).rows[0].operation;
  assert.deepEqual(operation, pending);
  const read = () => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  const initial = await read();
  assert.equal(initial.status, "published", initial.reason);
  assert.equal(initial.publications.length, templates.length);
  assert.deepEqual(
    initial.publications.map((entry) => entry.scopeKey).sort(),
    expectedScopes.map(components.contracts.publicScopeKey).sort(),
  );
  const documents = (await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots")).rows;
  for (const { document } of documents) {
    assert.equal(Object.hasOwn(document.scope, "period"), false);
    const key = components.contracts.publicScopeKey(document.scope);
    const expected = expectedScopes.find((scope) => components.contracts.publicScopeKey(scope) === key);
    assert.ok(expected);
    assert.deepEqual(document.scope, components.contracts.canonicalPublicScope(expected));
  }
  const reads = { ...h.githubReads };
  current = new Date(Date.parse(cutoff) + 86_400_000).toISOString();
  assert.deepEqual(await read(), initial, "a later read cannot resolve a fresh named window");
  const health = await h.runtime.operations.readHealth(2, operatorAllow);
  assert.equal(health.publication.state, "verified");
  assert.deepEqual(health.publication.publications, initial.publications);
  assert.deepEqual(h.githubReads, reads, "verification reads do not collect a replacement source window");
  assert.deepEqual(h.config.scopes, templates, "the approved configuration retains its exact template bytes");
  h.controlsStore.transaction((state) => {
    state.profiles["101"] = { ...state.profiles["101"], suppressed: true };
  });
  const withheld = await read();
  assert.equal(withheld.status, "unavailable");
  assert.deepEqual(withheld.publications, []);
  assert.equal(withheld.publicationDelaySeconds, null);
});

const namedCutoff = "2025-01-15T12:00:00.000Z";
const beforeNamedCutoff = (days) => new Date(Date.parse(namedCutoff) - days * 86400000).toISOString();
const { publicScopeKey, publicWindowPeriods } = components.contracts;
const namedReplayResult = (h, receipt) => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
const ordered = (publications) => publications.slice().sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));

async function publishedNamedReplay(t) {
  const h = await operatorHarness(t, {
    webhookDispatch: true,
    configure(config) {
      config.scopes = publicWindowPeriods.map((period) => ({ ...publicScope, period }));
    },
    transformPayloads(payloads) {
      return payloads.map((payload, index) => ({
        ...payload,
        created_at: beforeNamedCutoff(index === 0 ? 2 : 45),
        updated_at: beforeNamedCutoff(1),
      }));
    },
  });
  await insertOperatorDelivery(h, 1, beforeNamedCutoff(2));
  const failing = new components.ingestion.InboxStore(h.db, 1);
  assert.equal(await failing.fail(await failing.claim(), "source_unavailable", true), true);
  const row = (await h.runtime.operations.read(2, operatorAllow)).quarantined[0];
  const receipt = await h.runtime.operations.replay(
    {
      repositoryId: 2,
      deliveryId: row.deliveryId,
      expectedRevision: row.revision,
      reason: "source_recovered",
      operatorId: "201",
    },
    operatorAllow,
  );
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  // A real retained operation owns its January window. Later dispatch and
  // diagnostic clocks must not replace that cutoff or its coalesced scopes.
  const lease = await h.runtime.outbox.claim({
    configurationHash: createHash("sha256").update(JSON.stringify(h.config)).digest("hex"),
    configurationVersion: h.config.version,
    configurationRevision: 0,
    normalizationVersion: webhookDispatchVersion,
    policyVersion: components.metrics.metricRegistryV1.policy_version,
    dataMode: "synthetic",
    cutoff: namedCutoff,
  });
  assert.ok(lease);
  assert.equal(await h.runtime.outbox.fail(lease, "publication_unavailable"), "retry_scheduled");
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE event_key=$1", [
    lease.eventKey,
  ]);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const saved = (
    await h.db.query("SELECT operation,completion FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
      lease.eventKey,
    ])
  ).rows[0];
  assert.equal(saved.operation.cutoff, namedCutoff);
  assert.equal(saved.operation.operationKey, lease.operation.operationKey);
  assert.equal(saved.completion.publications.length, 5, "seven labels have five concrete January scopes");
  return { h, receipt, eventKey: lease.eventKey, completion: saved.completion };
}

test("operator replay verifies one publication per resolved scope when named presets share a window", async (t) => {
  const { h, receipt, completion } = await publishedNamedReplay(t);
  const saved = (
    await h.db.query("SELECT scope_key,snapshot_id,revision FROM leaderboard_pipeline.snapshots ORDER BY scope_key")
  ).rows;
  assert.equal(saved.length, 5);
  const expectedKeys = [
    ...[7, 30, 90].map((days) => publicScopeKey({ ...publicScope, start: beforeNamedCutoff(days), end: namedCutoff })),
    publicScopeKey({ ...publicScope, start: "2025-01-01T00:00:00.000Z", end: namedCutoff }),
    publicScopeKey(publicScope),
  ].sort();
  assert.deepEqual(saved.map((row) => row.scope_key).sort(), expectedKeys);
  const value = await namedReplayResult(h, receipt);
  assert.equal(value.status, "published");
  assert.equal(value.publications.length, 5);
  assert.deepEqual(ordered(value.publications), ordered(completion.publications));
  assert.deepEqual(
    ordered(value.publications),
    ordered(
      saved.map((row) => ({
        scopeKey: row.scope_key,
        snapshotId: row.snapshot_id,
        revision: Number(row.revision),
      })),
    ),
  );
  const health = await h.runtime.operations.readHealth(2, operatorAllow);
  assert.equal(health.publication.state, "verified");
  assert.deepEqual(ordered(health.publication.publications), ordered(value.publications));
});

test("named replay still withholds missing, duplicate and substituted publication references", async (t) => {
  const { h, receipt, eventKey, completion } = await publishedNamedReplay(t);
  assert.equal((await namedReplayResult(h, receipt)).status, "published");
  const publications = completion.publications;
  const corruptions = [
    ["missing scope", publications.slice(1)],
    ["duplicate scope", [publications[0], ...publications.slice(0, -1)]],
    [
      "unselected scope",
      [{ ...publications[0], scopeKey: publicScopeKey({ ...publicScope, repository: "2" }) }, ...publications.slice(1)],
    ],
    ["substituted snapshot", [{ ...publications[0], snapshotId: "f".repeat(64) }, ...publications.slice(1)]],
  ];
  try {
    for (const [label, altered] of corruptions) {
      await h.db.query("UPDATE leaderboard_ingestion.outbox SET completion=$2::jsonb WHERE event_key=$1", [
        eventKey,
        JSON.stringify({ ...completion, publications: altered }),
      ]);
      const value = await namedReplayResult(h, receipt);
      assert.equal(value.status, "unavailable", label);
      assert.deepEqual(value.publications, [], label);
      assert.equal(value.publicationDelaySeconds, null, label);
    }
  } finally {
    await h.db.query("UPDATE leaderboard_ingestion.outbox SET completion=$2::jsonb WHERE event_key=$1", [
      eventKey,
      JSON.stringify(completion),
    ]);
  }
  const restored = await namedReplayResult(h, receipt);
  assert.equal(restored.status, "published");
  assert.deepEqual(ordered(restored.publications), ordered(publications));
});
