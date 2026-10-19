import test from "node:test";
import assert from "node:assert/strict";
import { OperationalMonitor } from "../monitor.mjs";

function fixture() {
  let now = 0;
  const monitor = new OperationalMonitor({
    now: () => now,
    freshnessBudgetMs: 100,
    alertCooldownMs: 50,
    retentionMs: 1000,
    maximumEntries: 2,
  });
  return {
    monitor,
    at: (value) => {
      now = value;
    },
    success: (source, stage = "collection", revision = null) =>
      monitor.success({ source, stage, revision, latencyMs: 1 }),
    failure: (source, stage = "collection") =>
      monitor.failure({ source, stage, code: "source_unavailable", traceId: "synthetic-trace" }),
  };
}

test("capacity retains refreshed source health while its latest success event is retained", () => {
  const { monitor, at, success } = fixture();
  success("synthetic-a", "collection", "revision-a1");
  at(1);
  success("synthetic-b");
  at(2);
  success("synthetic-a", "collection", "revision-a2");
  at(3);
  success("synthetic-c");
  assert.deepEqual(
    monitor.internal().map((event) => event.sourceKey),
    [monitor.sourceKey("synthetic-a"), monitor.sourceKey("synthetic-c")],
  );
  assert.deepEqual(monitor.status("synthetic-a"), { state: "fresh", lagMs: 1, revision: "revision-a2" });
  assert.deepEqual(monitor.status("synthetic-b"), { state: "unknown", lagMs: null, revision: null });
  assert.equal(monitor.sources.size, 2);
});

test("a new failure refreshes source retention and preserves its prior success context", async () => {
  const { monitor, at, success, failure } = fixture();
  success("synthetic-a", "collection", "revision-a1");
  at(1);
  success("synthetic-b");
  at(2);
  assert.equal((await failure("synthetic-a")).state, "undelivered");
  at(3);
  success("synthetic-c");
  assert.equal(monitor.internal()[0].state, "failure");
  assert.deepEqual(monitor.status("synthetic-a"), { state: "error", lagMs: 3, revision: "revision-a1" });
  assert.equal(monitor.status("synthetic-b").state, "unknown");
  assert.equal(monitor.sources.size, 2);
});

test("source recency remains independent for each observed stage", () => {
  const { monitor, at, success } = fixture();
  success("synthetic-a", "collection");
  at(1);
  success("synthetic-a", "read");
  at(2);
  success("synthetic-a", "collection");
  at(3);
  success("synthetic-b", "collection");
  assert.deepEqual(monitor.status("synthetic-a", "collection"), { state: "fresh", lagMs: 1, revision: null });
  assert.equal(monitor.status("synthetic-a", "read").state, "unknown");
  assert.equal(monitor.status("synthetic-b", "collection").state, "fresh");
});

test("health reads and rejected observations do not promote an old source", async () => {
  const { monitor, at, success, failure } = fixture();
  success("synthetic-a");
  at(1);
  success("synthetic-b");
  at(2);
  assert.equal(monitor.status("synthetic-a").state, "fresh");
  assert.throws(() => success("synthetic-a", "invalid"), /Invalid telemetry/);
  await assert.rejects(failure("synthetic-a", "invalid"), /Invalid failure telemetry/);
  success("synthetic-c");
  assert.equal(monitor.status("synthetic-a").state, "unknown");
  assert.equal(monitor.status("synthetic-b").state, "fresh");
  assert.equal(monitor.status("synthetic-c").state, "fresh");
});

test("recency refresh preserves freshness and exact retention expiry", () => {
  const { monitor, at, success } = fixture();
  success("synthetic-a");
  at(1);
  success("synthetic-b");
  at(2);
  success("synthetic-a");
  at(3);
  success("synthetic-c");
  at(102);
  assert.equal(monitor.status("synthetic-a").state, "fresh");
  at(103);
  assert.equal(monitor.status("synthetic-a").state, "stale");
  at(1002);
  assert.equal(monitor.status("synthetic-a").state, "stale");
  at(1003);
  assert.equal(monitor.status("synthetic-a").state, "unknown");
  assert.equal(monitor.status("synthetic-c").state, "stale");
  at(1004);
  assert.equal(monitor.status("synthetic-c").state, "unknown");
  assert.equal(monitor.sources.size, 0);
  assert.deepEqual(monitor.internal(), []);
});
