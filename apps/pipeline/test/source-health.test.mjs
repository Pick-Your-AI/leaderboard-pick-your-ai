import assert from "node:assert/strict";
import test from "node:test";
import { harness, clock, fixtureId, publicScope } from "./harness.mjs";
import { readCurrentSourceHealth } from "../src/source-health.mjs";

const health = async (h, suffix = "") => h.runtime.app.inject(`/api/v1/health${suffix}`);
async function delivery(
  h,
  number,
  { repositoryId = 2, installationId = 1, event = "issues", age = 30, state = "pending" } = {},
) {
  await h.db.query(
    `INSERT INTO leaderboard_ingestion.inbox (delivery_id,body_hash,envelope,received_at,state,reason_code)
    VALUES($1,$2,$3::jsonb,clock_timestamp()-$4*interval '1 second',$5,'SECRET private-host')`,
    [
      fixtureId(number),
      "a".repeat(64),
      JSON.stringify({
        version: "github-delivery/v1",
        repositoryId,
        installationId,
        event,
        subjectId: "SECRET_SUBJECT",
        actorId: "SECRET_ACTOR",
        sourceUrl: "https://private.invalid",
      }),
      age,
      state,
    ],
  );
}

test("post-publication collection failure remains visible on pinned health without rewriting history", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce({ cutoff: new Date(Date.now() - 1000).toISOString() });
  const before = (await health(h)).json();
  assert.equal(
    (await h.runtime.source.read(publicScope, null, new AbortController().signal)).currentSourceHealth,
    undefined,
  );
  assert.equal(before.sources[0].currentCollection.state, "reconciled");
  assert.equal(before.sources[0].currentCollection.webhookState, "unknown");
  assert.equal(before.sources[0].webhookLagSeconds, null);
  h.options.source.readPage = async () => {
    throw new Error("SECRET source-host:443 stack trace");
  };
  const outcome = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(outcome.state, "collecting");
  const after = await health(h, `?snapshot=${before.snapshotId}`);
  assert.equal(after.statusCode, 200);
  assert.equal(after.json().status, "stale_or_degraded");
  assert.equal(after.json().sources[0].currentCollection.state, "degraded");
  assert.deepEqual(after.json().coverage, before.coverage);
  assert.deepEqual(after.json().lastSuccessfulPublish, before.lastSuccessfulPublish);
  assert.equal(
    after.json().sources[0].currentCollection.reconciledThrough,
    before.sources[0].currentCollection.reconciledThrough,
  );
  assert.doesNotMatch(after.body, /SECRET|source-host|stack trace|run_id|installation_id|reason/);
});

test("webhook age is scoped to current installation, authorized repository and supported configured family", async (t) => {
  const h = await harness(t, {
    configure(config) {
      config.scopes.push({ ...publicScope, repository: "2" });
    },
  });
  await h.runtime.runOnce();
  await delivery(h, 501, { repositoryId: 999, age: 5000, state: "quarantined" });
  await delivery(h, 502, { installationId: 999, age: 5000, state: "quarantined" });
  await delivery(h, 503, { event: "pull_request", age: 5000, state: "quarantined" });
  assert.equal((await health(h)).json().sources[0].webhookLagSeconds, null);
  await delivery(h, 504, { age: 30 });
  let response = await health(h, "?repository=2");
  let current = response.json().sources[0].currentCollection;
  assert.equal(current.webhookState, "pending");
  assert.ok(current.webhookLagSeconds >= 30 && current.webhookLagSeconds < 60);
  assert.doesNotMatch(response.body, /SECRET|private-host|private.invalid|body_hash|delivery_id/);
  assert.deepEqual(
    response.json().sources.map((source) => source.scopeId),
    ["2"],
  );
  const tag = response.headers.etag;
  await h.db.query("UPDATE leaderboard_ingestion.inbox SET state='quarantined' WHERE delivery_id=$1", [fixtureId(504)]);
  response = await h.runtime.app.inject({ url: "/api/v1/health?repository=2", headers: { "if-none-match": tag } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().sources[0].currentCollection.webhookState, "degraded");
  await h.db.query("UPDATE leaderboard_ingestion.inbox SET state='done' WHERE delivery_id=$1", [fixtureId(504)]);
  current = (await health(h)).json().sources[0].currentCollection;
  assert.equal(current.webhookState, "idle");
  assert.equal(current.webhookLagSeconds, 0);
  await delivery(h, 505, { age: -60 });
  current = (await health(h)).json().sources[0].currentCollection;
  assert.equal(current.webhookState, "unknown");
  assert.equal(current.webhookLagSeconds, null);
  await h.db.query("UPDATE leaderboard_ingestion.inbox SET state='quarantined' WHERE delivery_id=$1", [fixtureId(505)]);
  current = (await health(h)).json().sources[0].currentCollection;
  assert.equal(current.webhookState, "degraded", "an unknown receipt age cannot hide a known quarantine");
  assert.equal(current.webhookLagSeconds, null);
  await h.runtime.collection.suppress(fixtureId(506), "a".repeat(64), 1, [2], "revoked");
  response = await health(h);
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /currentCollection|scopeId|SECRET/);
});

test("collection generation and family coverage cannot be inferred from older or unrelated receipts", async (t) => {
  const h = await harness(t);
  await h.runtime.runOnce();
  const query = () =>
    h.db.transaction((tx) =>
      readCurrentSourceHealth(tx, [{ ...h.config.repositories[0], families: ["issues", "reviews"] }], clock()),
    );
  let current = (await query())[0];
  assert.equal(current.state, "unknown");
  assert.equal(current.lastSuccessfulSync, null);
  assert.equal(current.reconciledThrough, null);
  const oldCutoff = new Date(Date.now() - 86400000).toISOString();
  await h.db.query(
    `INSERT INTO leaderboard_ingestion.collection_runs(run_id,repository_id,family,mode,until_at,state,item_count,expected_count,last_success_at,attempted_at,access_generation)
    SELECT 'later-historical-scan',2,'issues','backfill',$1,'complete',0,0,clock_timestamp(),clock_timestamp(),generation
    FROM leaderboard_ingestion.repository_access WHERE repository_id=2`,
    [oldCutoff],
  );
  current = (await health(h)).json().sources[0].currentCollection;
  assert.equal(current.state, "no_activity_in_window");
  assert.equal(
    current.reconciledThrough,
    oldCutoff,
    "empty-scan state and watermark must describe the same completed scan",
  );
  await h.db.query("UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=2");
  current = (await health(h)).json().sources[0].currentCollection;
  assert.equal(current.state, "unknown");
  assert.equal(current.lastSuccessfulSync, null);
  assert.equal(current.reconciledThrough, null);
  await h.db.query("UPDATE leaderboard_ingestion.repository_access SET installation_id=999 WHERE repository_id=2");
  assert.equal((await health(h)).statusCode, 503);
});

test("completed empty bounded collection remains distinct from missing history and unknown webhook activity", async (t) => {
  const h = await harness(t, { payloads: [] });
  await h.runtime.runOnce();
  const response = (await health(h)).json();
  assert.equal(response.sources[0].currentCollection.state, "no_activity_in_window");
  assert.equal(response.sources[0].currentCollection.webhookState, "unknown");
  assert.equal(response.sources[0].webhookLagSeconds, null);
  assert.equal(response.sources[0].state, "partial");
  assert.equal(response.status, "stale_or_degraded");
});

test("a current-authorization change during health I/O fences the complete response", async (t) => {
  let authorized = true;
  const h = await harness(t, { verifyConfiguration: async () => authorized });
  await h.runtime.runOnce();
  const transaction = h.db.transaction;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("bool_or(delivery.state='quarantined')")) authorized = false;
          return result;
        },
      }),
    );
  const response = await health(h);
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /currentCollection|webhookLagSeconds|scopeId/);
});
