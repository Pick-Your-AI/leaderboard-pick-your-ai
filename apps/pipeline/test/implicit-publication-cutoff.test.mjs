import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { runWorker } from "../../worker/dist/runner.js";
import { ago, components, fixtureId, harness, publicScope } from "./harness.mjs";

const iso = (value) => new Date(value).toISOString();
const wholeSecond = (value) => value.replace(/\.\d{3}Z$/, ".000Z");
function fractionalClock() {
  const initial = new Date(Date.now() + 120_000);
  initial.setUTCSeconds(37, 123);
  let current = initial.toISOString();
  return {
    now: () => current,
    advance() {
      current = iso(Date.parse(current) + 60_864);
    },
    probeRepository: async (repo) => ({
      repositoryId: repo.id,
      installationId: repo.installationId,
      visibility: "public",
      checkedAt: current,
    }),
  };
}
const frozenInputs = async (h) => (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs")).rows;
const collectionRuns = async (h) => (await h.db.query("SELECT * FROM leaderboard_ingestion.collection_runs")).rows;
const scanRows = async (h) => (await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows;

for (const period of ["7d", "30d", "90d", "month", "quarter", "year"])
  test(`implicit ${period} publication selects a whole-second event cutoff while preserving source and observation precision`, async (t) => {
    const time = fractionalClock();
    const rawClock = time.now();
    const eventCutoff = wholeSecond(rawClock);
    const createdAt = ago(1).replace(/\.\d{3}Z$/, ".321Z");
    const sourceRevision = ago(0.5).replace(/\.\d{3}Z$/, ".456Z");
    const h = await harness(t, {
      ...time,
      configure(config) {
        config.scopes = [{ ...publicScope, period }];
      },
      transformPayloads(payloads) {
        return payloads.map((payload) => ({ ...payload, created_at: createdAt, updated_at: sourceRevision }));
      },
    });
    const result = await h.runtime.runOnce();
    assert.equal(result.state, "published");
    assert.equal(result.publications.length, 1);
    const runs = await collectionRuns(h);
    assert.equal(runs.length, 1);
    assert.equal(iso(runs[0].until_at), eventCutoff);
    const [{ document }] = await frozenInputs(h);
    assert.equal(document.engineScope.period, period);
    assert.equal(document.engineScope.to, eventCutoff);
    assert.equal(document.frozen.cutoff, rawClock);
    assert.ok(document.frozen.coverage.every((item) => item.sourceWatermark === eventCutoff));
    const sourceRows = (await h.db.query("SELECT document,observed_at FROM leaderboard_ingestion.source_facts")).rows;
    assert.equal(sourceRows.length, 2);
    assert.ok(sourceRows.every((row) => row.document.sourceRevision === sourceRevision));
    const facts = document.frozen.facts.filter((fact) => fact.metricId === "issues_opened");
    assert.equal(facts.length, 2);
    assert.ok(facts.every((fact) => fact.occurredAt === createdAt));
    assert.ok(facts.every((fact) => sourceRows.some((row) => iso(row.observed_at) === fact.observedAt)));
    assert.deepEqual(await scanRows(h), []);
    const window = components.metrics.resolveMetricWindow(period, eventCutoff);
    const response = await h.runtime.app.inject(
      `/api/v1/boards?${new URLSearchParams({ metric: "issues_opened", start: window.from, end: window.to, snapshot: result.publications[0].snapshotId })}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().scope.end, eventCutoff);
  });

for (const kind of ["legacy", "fixed", "custom", "all"])
  test(`implicit ${kind}-only publication preserves the existing millisecond event cutoff`, async (t) => {
    const time = fractionalClock();
    const current = time.now();
    const scope = { ...publicScope };
    if (kind === "all" || kind === "custom") scope.period = kind;
    if (kind === "fixed" || kind === "custom") {
      scope.start = wholeSecond(ago(14));
      scope.end = wholeSecond(ago(1));
    }
    const h = await harness(t, {
      ...time,
      configure(config) {
        config.scopes = [scope];
      },
    });
    assert.equal((await h.runtime.runOnce()).state, "published");
    assert.equal(iso((await collectionRuns(h))[0].until_at), current);
    const [{ document }] = await frozenInputs(h);
    assert.equal(document.frozen.cutoff, current);
    assert.ok(document.frozen.coverage.every((item) => item.sourceWatermark === current));
    assert.deepEqual(await scanRows(h), []);
  });

test("an explicitly supplied fractional named cutoff still rejects before collection or durable scan creation", async (t) => {
  const time = fractionalClock();
  const h = await harness(t, {
    ...time,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  await assert.rejects(h.runtime.runOnce({ cutoff: time.now() }), /named_period_requires_whole_second_cutoff/);
  assert.deepEqual(await collectionRuns(h), []);
  assert.deepEqual(await frozenInputs(h), []);
  assert.deepEqual(await scanRows(h), []);
  assert.equal(h.githubReads.fetches, 0);
});

test("the actual worker's implicit named batch publishes from an ordinary fractional host clock and drains resources", async (t) => {
  const time = fractionalClock();
  const eventCutoff = wholeSecond(time.now());
  const h = await harness(t, {
    ...time,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  const lifecycle = [];
  const result = await runWorker(
    {
      authorize: async () => true,
      open: async () => ({
        runtime: {
          runOnce: (options) => h.runtime.runOnce(options),
          async stop() {
            await h.runtime.stop();
            lifecycle.push("drained");
          },
        },
        async close() {
          lifecycle.push("closed");
        },
      }),
    },
    { maxPages: 1 },
  );
  assert.equal(result, "completed");
  assert.deepEqual(lifecycle, ["drained", "closed"]);
  assert.equal(iso((await collectionRuns(h))[0].until_at), eventCutoff);
  assert.equal((await frozenInputs(h))[0].document.frozen.cutoff, time.now());
});

async function enqueueIssue(h) {
  const secret = randomBytes(32).toString("hex");
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
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2) },
  });
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": fixtureId(9101),
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(response.status, 202, await response.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
}

test("fractional implicit webhook binding freezes a whole-second named cutoff and preserves both cutoffs through restart", async (t) => {
  const time = fractionalClock();
  const observationCutoff = time.now();
  const eventCutoff = wholeSecond(observationCutoff);
  let failOnce = true;
  const h = await harness(t, {
    ...time,
    webhookDispatch: true,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
    normalizerFactory(options) {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
      return (input) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("SYNTHETIC_NORMALIZATION_INTERRUPTION");
        }
        return normalize(input);
      };
    },
  });
  await enqueueIssue(h);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  const pending = (
    await h.db.query("SELECT operation,observation_cutoff,reason_code FROM leaderboard_ingestion.outbox")
  ).rows[0];
  assert.equal(pending.operation.cutoff, eventCutoff);
  assert.equal(pending.reason_code, "enrichment_unavailable");
  assert.equal(iso(pending.observation_cutoff), observationCutoff);
  assert.deepEqual(await frozenInputs(h), []);
  await h.runtime.stop();
  await h.reopenDatabase();
  time.advance();
  const resumed = await createPipeline(h.options);
  try {
    await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE state='pending'");
    assert.equal(await resumed.dispatchOnce(), "processed");
    const done = (await h.db.query("SELECT operation,observation_cutoff,completion FROM leaderboard_ingestion.outbox"))
      .rows[0];
    assert.deepEqual(done.operation, pending.operation);
    assert.equal(iso(done.observation_cutoff), observationCutoff);
    assert.equal(done.completion.publications.length, 1);
    const [{ document }] = await frozenInputs(h);
    assert.equal(document.engineScope.to, eventCutoff);
    assert.equal(document.frozen.cutoff, observationCutoff);
    const runs = await collectionRuns(h);
    assert.equal(runs.length, 1, "retry reuses the original complete collection");
    assert.equal(iso(runs[0].until_at), eventCutoff);
    assert.deepEqual(await scanRows(h), [], "dispatch does not create an unrelated implicit scan");
  } finally {
    await resumed.stop();
  }
});
