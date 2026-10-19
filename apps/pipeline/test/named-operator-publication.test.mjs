import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { webhookDispatchVersion } from "../src/webhook-dispatch.mjs";
import { components, ago, publicScope } from "./harness.mjs";
import { operatorAllow, operatorHarness, queueOperatorReplay } from "./operator-harness.mjs";

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
