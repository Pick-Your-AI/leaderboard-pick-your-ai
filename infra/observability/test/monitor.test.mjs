import test from "node:test";
import assert from "node:assert/strict";
import { OperationalMonitor } from "../monitor.mjs";
const monitor = (options) =>
  new OperationalMonitor({
    freshnessBudgetMs: 1000,
    alertCooldownMs: 500,
    retentionMs: 5000,
    maximumEntries: 10,
    ...options,
  });

test("injected collection failure produces a fixed actionable acknowledged alert and matching public health", async () => {
  let now = 0;
  const delivered = [];
  const item = monitor({
    now: () => now,
    sink: async (value) => {
      delivered.push(value);
      return { accepted: true, id: "synthetic-alert:1" };
    },
  });
  assert.deepEqual(item.status("synthetic-source"), { state: "unknown", lagMs: null, revision: null });
  item.success({ source: "synthetic-source", stage: "collection", latencyMs: 12, revision: "synthetic-r1" });
  const receipt = await item.failure({
    source: "synthetic-source",
    stage: "collection",
    code: "source_unavailable",
    traceId: "synthetic-trace:1",
  });
  assert.equal(receipt.state, "delivered");
  assert.equal(item.status("synthetic-source").state, "error");
  assert.match(delivered[0].message, /retry state/);
  assert.equal(JSON.stringify(delivered).includes("synthetic-source"), false);
  assert.equal(
    (
      await item.failure({
        source: "synthetic-source",
        stage: "collection",
        code: "source_unavailable",
        traceId: "synthetic-trace:2",
      })
    ).state,
    "throttled",
  );
  now = 2000;
  item.success({ source: "synthetic-source", stage: "collection", latencyMs: 10 });
  assert.equal(item.status("synthetic-source").state, "fresh");
  now = 3001;
  assert.equal(item.status("synthetic-source").state, "stale");
});
test("missing or failed destinations never fabricate delivery and raw exception fields are rejected", async () => {
  const event = { source: "synthetic", stage: "publication", code: "publication_failed", traceId: "trace:1" };
  assert.equal((await monitor().failure(event)).state, "undelivered");
  assert.equal(
    (
      await monitor({
        sink: async () => {
          throw Error("private-secret");
        },
      }).failure(event)
    ).reason,
    "destination_unavailable",
  );
  assert.equal((await monitor({ sink: async () => ({ accepted: false }) }).failure(event)).state, "undelivered");
  await assert.rejects(monitor().failure({ ...event, code: "private-secret" }), /Invalid/);
  let attempts = 0;
  const retry = monitor({
    sink: () => {
      attempts++;
      throw Error("private-secret");
    },
  });
  await retry.failure({ ...event, rawError: "private-secret" });
  await retry.failure(event);
  assert.equal(attempts, 2);
  assert.equal(JSON.stringify(retry.internal()).includes("private-secret"), false);
});
test("quiet sources produce no activity alert and telemetry retention is bounded", async () => {
  let now = 0;
  let alerts = 0;
  const item = monitor({
    now: () => now,
    sink: async () => {
      alerts++;
      return { accepted: true, id: "a" };
    },
  });
  for (let index = 0; index < 20; index++) item.success({ source: "synthetic", stage: "read", latencyMs: index });
  assert.equal(item.internal().length, 10);
  now = 6000;
  assert.equal(item.internal().length, 0);
  assert.equal(item.status("synthetic").state, "unknown");
  assert.equal(alerts, 0);
});
test("simultaneous source failures coalesce without pausing another source alert", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  const item = monitor({
    sink: async () => {
      count++;
      await waiting;
      return { accepted: true, id: `receipt:${count}` };
    },
  });
  const event = { source: "synthetic", stage: "collection", code: "source_unavailable", traceId: "t" };
  const first = item.failure(event);
  const second = item.failure(event);
  const other = item.failure({ ...event, source: "other" });
  release();
  assert.equal((await first).state, "delivered");
  assert.equal((await second).state, "delivered");
  await other;
  assert.equal(count, 2);
});
test("object coercion cannot smuggle private fields and unrelated success cannot clear collection failure", async () => {
  const item = monitor();
  const privateObject = { toString: () => "valid-id", rawPayload: "private-secret" };
  assert.throws(() => item.success({ source: "s", stage: "read", latencyMs: 1, revision: privateObject }), /Invalid/);
  for (const traceId of [undefined, privateObject])
    await assert.rejects(
      item.failure({ source: "s", stage: "collection", code: "permission_revoked", traceId }),
      /Invalid/,
    );
  await item.failure({ source: "s", stage: "collection", code: "permission_revoked", traceId: "t" });
  item.success({ source: "s", stage: "read", latencyMs: 1 });
  assert.deepEqual(item.status("s"), { state: "error", lagMs: null, revision: null });
  assert.equal(item.status("s", "read").state, "fresh");
  assert.equal(JSON.stringify(item.internal()).includes("private-secret"), false);
});
test("retention cannot erase cooldown acknowledgements and asynchronous acknowledgement maps stay bounded", async () => {
  assert.throws(() => monitor({ retentionMs: 100, alertCooldownMs: 500 }), /cooldown/);
  const item = monitor({ maximumEntries: 2, sink: async () => ({ accepted: true, id: "receipt" }) });
  for (let index = 0; index < 20; index++)
    await item.failure({ source: `synthetic:${index}`, stage: "collection", code: "source_unavailable", traceId: "t" });
  assert.ok(item.alerts.size <= 2);
  assert.ok(item.sources.size <= 2);
  assert.ok(item.internal().length <= 2);
});
