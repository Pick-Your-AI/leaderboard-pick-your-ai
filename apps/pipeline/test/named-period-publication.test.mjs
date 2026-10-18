import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { harness, components, ago, clock, boardUrl, fixtureId, publicScope } from "./harness.mjs";
const second = (value) => value.replace(/\.\d{3}Z$/, ".000Z");
const scopeAt = (end, period = "30d") => {
  const window = components.metrics.resolveMetricWindow(period, end);
  return { ...publicScope, start: window.from, end: window.to };
};
const urlFor = (scope, extra = {}) =>
  `${boardUrl}&${new URLSearchParams({ start: scope.start, end: scope.end, ...extra })}`;
const saved = (h, id) =>
  h.controlsStore.db.prepare("SELECT * FROM pipeline_aggregate_explanations WHERE snapshot_id=?").get(id);

test("named periods persist exact public scopes, partial history and precise observation cutoffs across retry/restart", async (t) => {
  const h = await harness(t, {
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
    transformPayloads(payloads) {
      return payloads.map((payload) => ({ ...payload, created_at: ago(4), updated_at: ago(0.1) }));
    },
  });
  const firstEnd = second(ago(3)),
    nextEnd = second(ago(1));
  const first = (await h.runtime.runOnce({ cutoff: firstEnd })).publications[0];
  // Fresh event time is after the prior event boundary, with ordinary source ingestion.
  h.add({
    id: 1003,
    node_id: "SYNTHETIC_ISSUE_3",
    number: 3,
    html_url: "https://github.com/synthetic-org/synthetic-repo/issues/3",
    created_at: new Date(Date.parse(firstEnd) + 86400000).toISOString(),
    updated_at: ago(0.1),
    user: { id: 102, node_id: "U_SYNTHETIC_B", login: "synthetic-bob", type: "User" },
  });
  const next = (await h.runtime.runOnce({ cutoff: nextEnd })).publications[0];
  const before = [saved(h, first.snapshotId), saved(h, next.snapshotId)];
  assert.notEqual(
    JSON.parse(before[0].document).backfillRevision,
    JSON.parse(before[1].document).backfillRevision,
    "current digest(outputs) is conservative even for ordinary fresh activity; no stable live epoch is claimed",
  );
  for (const [i, publication] of [first, next].entries()) {
    const end = [firstEnd, nextEnd][i],
      scope = scopeAt(end);
    const document = JSON.parse(before[i].document);
    assert.equal(document.scope.period, "30d");
    assert.equal(document.scope.to, end);
    assert.ok(document.cutoff > end, "observation cutoff remains separate from event cutoff");
    assert.equal(document.metrics[0].coverage, "incomplete");
    const frozen = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        publication.snapshotId,
      ])
    ).rows[0].document;
    assert.equal(frozen.frozen.cutoff, document.cutoff);
    assert.equal(frozen.engineScope.to, end);
    assert.ok(
      frozen.frozen.coverage.every((item) => item.sourceErrors.includes("historical_capability_not_certified")),
    );
    const response = await h.runtime.app.inject(urlFor(scope, { snapshot: publication.snapshotId }));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().scope, scope);
    assert.ok(
      response
        .json()
        .coverage.every((item) => item.state === "partial" && item.knownStart === null && item.sourceErrors.length > 0),
    );
    assert.doesNotMatch(response.body, /rankEvidence|comparisonSignature|backfillRevision|private-rank-evidence/);
  }
  const comparisonUrl = urlFor(scopeAt(nextEnd), {
    snapshot: next.snapshotId,
    compare: first.snapshotId,
    compareStart: scopeAt(firstEnd).start,
    compareEnd: firstEnd,
  });
  const response = await h.runtime.app.inject(comparisonUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().comparison.snapshotId, first.snapshotId);
  assert.ok(response.json().rows.length > 0);
  assert.ok(
    response.json().rows.every((row) => row.movement.reason === "insufficient_history" && row.movement.delta === null),
  );
  await h.runtime.runOnce({ cutoff: nextEnd });
  assert.deepEqual([saved(h, first.snapshotId), saved(h, next.snapshotId)], before);
  // Same-length arbitrary custom scope is neither materialized nor made public.
  const unknown = scopeAt(second(ago(2)));
  assert.equal((await h.runtime.app.inject(urlFor(unknown))).statusCode, 503);
  const malformed = { ...scopeAt(nextEnd), start: second(ago(32)) };
  assert.equal((await h.runtime.app.inject(urlFor(malformed))).statusCode, 503);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const again = await restarted.app.inject(comparisonUrl);
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(again.json(), response.json());
  assert.deepEqual([saved(h, first.snapshotId), saved(h, next.snapshotId)], before);
});

test("named-period validation rejects lossy cutoffs and ambiguous bounds before collection", async (t) => {
  const h = await harness(t, {
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  await assert.rejects(h.runtime.runOnce({ cutoff: "2026-10-16T12:00:00.123Z" }), /whole_second_cutoff/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.collection_runs")).rows[0].n, 0);
  await h.runtime.stop();
  const runtime = await createPipeline({
    ...h.options,
    config: { ...h.config, scopes: ["month", "quarter"].map((period) => ({ ...publicScope, period })) },
  });
  t.after(() => runtime.stop());
  await assert.rejects(runtime.runOnce({ cutoff: "2026-10-16T12:00:00.000Z" }), /ambiguous_public_period_bounds/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.collection_runs")).rows[0].n, 0);
});

test("current configuration approval remains required for named publications and historical reads", async (t) => {
  let approved = true;
  const h = await harness(t, {
    verifyConfiguration: async () => approved,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  const end = second(ago(0.5));
  const publication = (await h.runtime.runOnce({ cutoff: end })).publications[0];
  approved = false;
  assert.deepEqual(await h.runtime.runOnce({ cutoff: second(clock()) }), {
    state: "blocked",
    reason: "approved_configuration_required",
  });
  assert.equal(
    (await h.runtime.app.inject(urlFor(scopeAt(end), { snapshot: publication.snapshotId }))).statusCode,
    410,
  );
});

test("webhook operation binds materialized named scope and retry never resolves a fresh window", async (t) => {
  const cutoff = second(new Date(Date.now() + 10000).toISOString());
  let current = cutoff;
  const h = await harness(t, {
    now: () => current,
    webhookDispatch: true,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  const secret = "synthetic-named-period-webhook-secret";
  const handler = components.ingestion.createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
  });
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: { node_id: "SYNTHETIC_SENDER_NOT_AUTHOR" },
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2).replace(/\.\d{3}Z$/, "Z") },
  });
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": fixtureId(901),
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(response.status, 202, await response.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  h.setSourceFailure(true);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  const pending = (await h.db.query("SELECT operation FROM leaderboard_ingestion.outbox")).rows[0].operation;
  assert.equal(pending.cutoff, cutoff);
  current = new Date(Date.parse(cutoff) + 10000).toISOString();
  h.setSourceFailure(false);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const done = (await h.db.query("SELECT operation,completion FROM leaderboard_ingestion.outbox")).rows[0];
  assert.deepEqual(done.operation, pending);
  const scope = scopeAt(cutoff);
  assert.equal(
    done.completion.publications[0].scopeKey,
    JSON.stringify([scope.organization, scope.repository, scope.workstream, scope.start, scope.end]),
  );
  assert.equal((await h.runtime.app.inject(urlFor(scope))).statusCode, 200);
  assert.equal((await h.runtime.app.inject(urlFor(scopeAt(current)))).statusCode, 503);
});
