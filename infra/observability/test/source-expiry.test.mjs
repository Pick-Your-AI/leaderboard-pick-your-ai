import test from "node:test";
import assert from "node:assert/strict";
import { OperationalMonitor } from "../monitor.mjs";

function fixture() {
  let now = 0;
  const alerts = [];
  const monitor = new OperationalMonitor({
    now: () => now,
    freshnessBudgetMs: 100,
    alertCooldownMs: 50,
    retentionMs: 1000,
    maximumEntries: 4,
    sink: async (event) => {
      alerts.push(structuredClone(event));
      return { accepted: true, id: "synthetic-receipt" };
    },
  });
  monitor.success({ source: "synthetic-a", stage: "collection", revision: "revision-a", latencyMs: 1 });
  return {
    monitor,
    alerts,
    at: (value) => {
      now = value;
    },
    failure: () =>
      monitor.failure({
        source: "synthetic-a",
        stage: "collection",
        code: "source_unavailable",
        traceId: "synthetic-trace",
      }),
    outcome: () => ({ status: monitor.status("synthetic-a"), events: monitor.internal(), alerts }),
  };
}

test("a failure after source retention expires cannot revive prior success evidence", async () => {
  const { monitor, alerts, at, failure } = fixture();
  at(1001);
  assert.equal((await failure()).state, "delivered");
  assert.deepEqual(monitor.status("synthetic-a"), { state: "error", lagMs: null, revision: null });
  assert.equal(monitor.internal().length, 1);
  assert.equal(monitor.internal()[0].revision, null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].revision, null);
});

test("expired failure evidence is independent of an intervening health read", async () => {
  const direct = fixture();
  const observed = fixture();
  direct.at(1001);
  observed.at(1001);
  assert.deepEqual(observed.monitor.status("synthetic-a"), { state: "unknown", lagMs: null, revision: null });
  await direct.failure();
  await observed.failure();
  assert.deepEqual(direct.outcome(), observed.outcome());
});

test("expired failure evidence is independent of an intervening event read", async () => {
  const direct = fixture();
  const observed = fixture();
  direct.at(1001);
  observed.at(1001);
  assert.deepEqual(observed.monitor.internal(), []);
  await direct.failure();
  await observed.failure();
  assert.deepEqual(direct.outcome(), observed.outcome());
});

test("the exact retention endpoint still preserves the prior success context", async () => {
  const direct = fixture();
  const observed = fixture();
  direct.at(1000);
  observed.at(1000);
  assert.deepEqual(observed.monitor.status("synthetic-a"), { state: "stale", lagMs: 1000, revision: "revision-a" });
  await direct.failure();
  await observed.failure();
  assert.deepEqual(direct.outcome(), observed.outcome());
  assert.deepEqual(direct.monitor.status("synthetic-a"), { state: "error", lagMs: 1000, revision: "revision-a" });
  assert.equal(direct.alerts[0].revision, "revision-a");
});

test("a retained recent failure continues to carry an older last successful revision", async () => {
  const { monitor, alerts, at, failure } = fixture();
  at(900);
  assert.equal((await failure()).state, "delivered");
  at(1001);
  assert.equal((await failure()).state, "delivered");
  assert.deepEqual(monitor.status("synthetic-a"), { state: "error", lagMs: 1001, revision: "revision-a" });
  assert.equal(monitor.internal().length, 2);
  assert.equal(
    monitor.internal().every((event) => event.state === "failure" && event.revision === "revision-a"),
    true,
  );
  assert.deepEqual(
    alerts.map((event) => event.revision),
    ["revision-a", "revision-a"],
  );
});
