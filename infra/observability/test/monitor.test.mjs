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

const collectionFailure = (source) => ({
  source,
  stage: "collection",
  code: "source_unavailable",
  traceId: "synthetic-trace",
});

test("source churn cannot erase acknowledged cooldowns and expiry frees alert capacity", async () => {
  let now = 0;
  const calls = [];
  const item = monitor({
    now: () => now,
    maximumEntries: 2,
    sink: async (event) => {
      calls.push(event.sourceKey);
      return { accepted: true, id: `receipt:${calls.length}` };
    },
  });
  const results = [];
  for (const source of ["synthetic-a", "synthetic-b", "synthetic-c", "synthetic-a"])
    results.push(await item.failure(collectionFailure(source)));
  assert.deepEqual(
    results.map((result) => result.state),
    ["delivered", "delivered", "undelivered", "throttled"],
  );
  assert.equal(results[2].reason, "destination_capacity_exceeded");
  assert.equal(calls.length, 2);
  assert.equal(item.status("synthetic-c").state, "error");
  now = 499;
  assert.equal((await item.failure(collectionFailure("synthetic-c"))).reason, "destination_capacity_exceeded");
  assert.equal(calls.length, 2);
  now = 500;
  assert.equal((await item.failure(collectionFailure("synthetic-c"))).state, "delivered");
  assert.equal((await item.failure(collectionFailure("synthetic-a"))).state, "delivered");
  assert.equal(calls.length, 4);
  assert.equal((await item.failure(collectionFailure("synthetic-c"))).state, "throttled");
});

test("acknowledged and in-flight alerts share capacity while duplicate failures coalesce", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let block = false;
  const calls = [];
  const item = monitor({
    now: () => 0,
    maximumEntries: 2,
    sink: async (event) => {
      calls.push(event.sourceKey);
      const id = `receipt:${calls.length}`;
      if (block) await waiting;
      return { accepted: true, id };
    },
  });
  await item.failure(collectionFailure("synthetic-a"));
  block = true;
  const first = item.failure(collectionFailure("synthetic-b"));
  const duplicate = item.failure(collectionFailure("synthetic-b"));
  const overflow = item.failure(collectionFailure("synthetic-c"));
  release();
  const [receipt, duplicateReceipt, rejected] = await Promise.all([first, duplicate, overflow]);
  assert.equal(receipt.state, "delivered");
  assert.deepEqual(duplicateReceipt, receipt);
  assert.equal(rejected.state, "undelivered");
  assert.equal(rejected.reason, "destination_capacity_exceeded");
  assert.equal(calls.length, 2);
  assert.equal((await item.failure(collectionFailure("synthetic-a"))).state, "throttled");
  assert.equal((await item.failure(collectionFailure("synthetic-b"))).state, "throttled");
});

test("failed and unacknowledged destinations release capacity for a later successful attempt", async () => {
  for (const outcome of ["throw", "reject", "invalid"]) {
    const reason = outcome === "throw" ? "destination_unavailable" : "destination_did_not_acknowledge";
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const item = monitor({
      now: () => 0,
      maximumEntries: 1,
      sink: async () => {
        attempts++;
        if (attempts === 1) {
          await waiting;
          if (outcome === "throw") throw Error("synthetic-destination-failure");
          return outcome === "reject" ? { accepted: false } : { accepted: true, id: "invalid receipt" };
        }
        return { accepted: true, id: "synthetic-retry" };
      },
    });
    const first = item.failure(collectionFailure("synthetic-a"));
    const overflow = item.failure(collectionFailure("synthetic-b"));
    release();
    assert.equal((await first).reason, reason);
    assert.equal((await overflow).reason, "destination_capacity_exceeded");
    const retry = await item.failure(collectionFailure("synthetic-b"));
    assert.equal(retry.state, "delivered");
    assert.equal(retry.receiptId, "synthetic-retry");
    assert.equal(attempts, 2);
    assert.equal((await item.failure(collectionFailure("synthetic-b"))).state, "throttled");
    assert.equal((await item.failure(collectionFailure("synthetic-a"))).reason, "destination_capacity_exceeded");
    assert.equal(attempts, 2);
  }
});

test("pending capacity survives elapsed budgets and cooldown begins at acknowledgement", async () => {
  let now = 0;
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const item = monitor({
    now: () => now,
    maximumEntries: 1,
    sink: async () => {
      attempts++;
      await waiting;
      return { accepted: true, id: "synthetic-late-acknowledgement" };
    },
  });
  const first = item.failure(collectionFailure("synthetic-a"));
  now = 6000;
  const duplicate = item.failure(collectionFailure("synthetic-a"));
  assert.equal((await item.failure(collectionFailure("synthetic-b"))).reason, "destination_capacity_exceeded");
  release();
  const [receipt, duplicateReceipt] = await Promise.all([first, duplicate]);
  assert.equal(receipt.state, "delivered");
  assert.deepEqual(duplicateReceipt, receipt);
  assert.equal(attempts, 1);
  now = 6499;
  assert.equal((await item.failure(collectionFailure("synthetic-a"))).state, "throttled");
  assert.equal((await item.failure(collectionFailure("synthetic-b"))).reason, "destination_capacity_exceeded");
  now = 6500;
  assert.equal((await item.failure(collectionFailure("synthetic-b"))).state, "delivered");
  assert.equal(attempts, 2);
});

test("cooldown slots expire independently for each failure code on the same source", async () => {
  let now = 0;
  let attempts = 0;
  const item = monitor({
    now: () => now,
    maximumEntries: 2,
    sink: async () => ({ accepted: true, id: `receipt:${++attempts}` }),
  });
  const event = collectionFailure("synthetic-a");
  const revoked = { ...event, code: "permission_revoked" };
  const publication = { ...event, stage: "publication", code: "publication_failed" };
  assert.equal((await item.failure(event)).state, "delivered");
  now = 100;
  assert.equal((await item.failure(revoked)).state, "delivered");
  assert.equal((await item.failure(publication)).reason, "destination_capacity_exceeded");
  now = 499;
  assert.equal((await item.failure(event)).state, "throttled");
  now = 500;
  assert.equal((await item.failure(publication)).state, "delivered");
  assert.equal((await item.failure(revoked)).state, "throttled");
  assert.equal((await item.failure(event)).reason, "destination_capacity_exceeded");
  assert.equal(attempts, 3);
  now = 600;
  assert.equal((await item.failure(event)).state, "delivered");
  assert.equal((await item.failure(publication)).state, "throttled");
  assert.equal(attempts, 4);
});
