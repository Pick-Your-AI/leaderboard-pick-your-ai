import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { harness, components, publicScope } from "./harness.mjs";
import { insertOperatorDelivery } from "./operator-harness.mjs";

const opening = "2027-01-01T00:00:00.000Z";
const oneSecondLater = "2027-01-01T00:00:01.000Z";
const notice = async (h) =>
  (
    await h.db.query(
      "SELECT state,attempts,operation,completion,observation_cutoff,source_generations FROM leaderboard_ingestion.outbox ORDER BY id",
    )
  ).rows;
const counts = async (h) =>
  (
    await h.db.query(`SELECT
    (SELECT count(*)::int FROM leaderboard_ingestion.outbox_attempts) AS attempts,
    (SELECT count(*)::int FROM leaderboard_ingestion.collection_runs) AS collections,
    (SELECT count(*)::int FROM leaderboard_pipeline.snapshots) AS snapshots,
    (SELECT count(*)::int FROM leaderboard_pipeline.dispatch_publications) AS publications`)
  ).rows[0];

async function calendarHarness(t, periods = ["month", "quarter", "year"], initial = opening) {
  let current = initial;
  const h = await harness(t, {
    now: () => current,
    webhookDispatch: true,
    probeRepository: async (repo) => ({
      repositoryId: repo.id,
      installationId: repo.installationId,
      visibility: "public",
      checkedAt: current,
    }),
    configure(config) {
      config.scopes = periods.map((period) => ({ ...publicScope, period }));
    },
  });
  await insertOperatorDelivery(h, 941);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  return {
    h,
    at: (value) => {
      current = value;
    },
  };
}

test("an empty calendar opening leaves a notice unclaimed across restart and later publishes one shared scope", async (t) => {
  const { h, at } = await calendarHarness(t);
  const before = await notice(h);
  const beforeCounts = await counts(h);
  for (let i = 0; i < 3; i++) assert.equal(await h.runtime.dispatchOnce(), "idle");
  assert.deepEqual(await notice(h), before);
  assert.deepEqual(await counts(h), beforeCounts);
  assert.equal(before[0].state, "pending");
  assert.equal(before[0].attempts, 0);
  assert.equal(before[0].operation, null);
  assert.equal(before[0].completion, null);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  assert.equal(await restarted.dispatchOnce(), "idle");
  assert.deepEqual(await notice(h), before);
  at(oneSecondLater);
  assert.equal(await restarted.dispatchOnce(), "processed");
  const [done] = await notice(h);
  assert.equal(done.state, "done");
  assert.equal(done.attempts, 1);
  assert.equal(done.operation.cutoff, oneSecondLater);
  assert.equal(done.completion.operationKey, done.operation.operationKey);
  assert.equal(done.completion.publications.length, 1);
  const response = await restarted.app.inject("/api/v1/windows");
  assert.equal(response.statusCode, 200, response.body);
  const windows = response.json().windows;
  assert.deepEqual(
    windows.map((entry) => entry.period),
    ["month", "quarter", "year"],
  );
  for (const entry of windows) {
    assert.equal(entry.scope.start, opening);
    assert.equal(entry.scope.end, oneSecondLater);
    assert.equal(entry.snapshotId, done.completion.publications[0].snapshotId);
    assert.equal(entry.revision, done.completion.publications[0].revision);
  }
  assert.equal(await restarted.dispatchOnce(), "idle");
  assert.equal((await counts(h)).attempts, 1);
});

test("a bound nonempty calendar retry still uses its retained window at the next empty calendar opening", async (t) => {
  const priorCutoff = "2026-12-31T23:59:59.000Z";
  const { h, at } = await calendarHarness(t, ["month"], priorCutoff);
  h.setSourceFailure(true);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  const [pending] = await notice(h);
  assert.equal(pending.operation.cutoff, priorCutoff);
  h.setSourceFailure(false);
  at(opening);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const [done] = await notice(h);
  assert.deepEqual(done.operation, pending.operation);
  assert.equal(done.attempts, 2);
  assert.equal(done.completion.publications.length, 1);
  const windows = (await h.runtime.app.inject("/api/v1/windows")).json().windows;
  assert.equal(windows.length, 1);
  assert.equal(windows[0].scope.start, "2026-12-01T00:00:00.000Z");
  assert.equal(windows[0].scope.end, priorCutoff);
});

test("an empty calendar label does not defer a nonempty rolling publication", async (t) => {
  const { h } = await calendarHarness(t, ["month", "30d"]);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const [done] = await notice(h);
  assert.equal(done.operation.cutoff, opening);
  assert.equal(done.completion.publications.length, 1);
  const response = await h.runtime.app.inject("/api/v1/windows");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().windows.map((entry) => entry.period),
    ["30d"],
  );
  assert.equal(response.json().windows[0].scope.end, opening);
});

test("a missing publication still cannot create an ordinary outbox completion", async () => {
  const outbox = new components.ingestion.OutboxStore({
    transaction: async () => assert.fail("an empty publication cannot reach SQL"),
  });
  await assert.rejects(
    outbox.complete({}, [], async () => {}),
    /invalid_dispatch_publication/,
  );
});

test("ambiguous calendar configuration fails before binding a dispatch instead of being treated as empty", async (t) => {
  const { h } = await calendarHarness(t, ["month"], oneSecondLater);
  await h.runtime.stop();
  const before = await notice(h);
  const beforeCounts = await counts(h);
  const runtime = await createPipeline({
    ...h.options,
    config: {
      ...h.config,
      scopes: [
        { ...publicScope, period: "month" },
        { ...publicScope, start: opening, end: oneSecondLater, period: "custom" },
      ],
    },
  });
  t.after(() => runtime.stop());
  await assert.rejects(runtime.dispatchOnce(), /ambiguous_public_period_bounds/);
  assert.deepEqual(await notice(h), before);
  assert.deepEqual(await counts(h), beforeCounts);
});
