import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { harness, fixtureId, components } from "./harness.mjs";
import { migratePipelineDerivedRetirement, PipelineDerivedRetirementStore } from "../src/derived-retirement.mjs";

const latch = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const details = (request) => ({
  sourceRevision: request.fact.sourceRevision,
  acceptedOutcome: true,
  reviewState: null,
  additions: null,
  deletions: null,
  changedFiles: null,
});
const option = (source, current = () => true) => ({
  source,
  policyVersion: "synthetic-runtime-metadata-v1",
  configurationCurrent: current,
});

test("pipeline exposes no metadata worker or additional job writes without explicit opt-in", async (t) => {
  const h = await harness(t, { memoryDatabase: true });
  assert.equal(h.runtime.enrichment, null);
  await h.runtime.runOnce();
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS n FROM leaderboard_ingestion.enrichment_jobs")).rows[0].n,
    0,
  );
});

test("runtime currentness binds source config and preserves exact publication bytes through metadata classification", async (t) => {
  let allowed = true;
  const bindings = [],
    calls = [];
  const h = await harness(t, {
    memoryDatabase: true,
    metadataEnrichment: option(
      {
        async readMetadata(request) {
          calls.push(request);
          return details(request);
        },
      },
      (binding) => {
        bindings.push(binding);
        return allowed;
      },
    ),
  });
  await h.runtime.runOnce();
  const snapshots = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows;
  assert.ok(snapshots.length > 0);
  assert.equal(await h.runtime.enrichment.processOne(), "classified");
  assert.equal(calls[0].family, "issues");
  assert.equal(calls[0].repositoryId, 2);
  assert.equal(bindings[0].installationId, 1);
  assert.equal(bindings[0].dataMode, "synthetic");
  assert.equal(bindings[0].policyVersion, "synthetic-runtime-metadata-v1");
  assert.equal(
    (await h.runtime.enrichment.readStates(2, "issues")).some((row) => row.state === "classified"),
    true,
  );
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows,
    snapshots,
  );
  allowed = false;
  await assert.rejects(h.runtime.enrichment.processOne(), /enrichment_authorization_changed/);
  await assert.rejects(h.runtime.enrichment.readStates(2, "issues"), /enrichment_authorization_changed/);
});

test("real webhook intake completes while background metadata is blocked and stop aborts its late result", async (t) => {
  const started = latch(),
    finish = latch();
  let request;
  const secret = "synthetic-metadata-http-secret-at-least-32-characters";
  const h = await harness(t, {
    memoryDatabase: true,
    webhookSecrets: [secret],
    metadataEnrichment: option({
      async readMetadata(value) {
        request = value;
        started.resolve();
        await finish.promise;
        return details(value);
      },
    }),
  });
  await h.runtime.runOnce();
  const addresses = await h.runtime.start({ webhook: { host: "127.0.0.1", port: 0 } });
  await started.promise;
  const deliveryId = fixtureId(958);
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    issue: { node_id: "SYNTHETIC_ASYNC_ISSUE", number: 958 },
    sender: null,
  });
  const response = await fetch(`http://127.0.0.1:${addresses.webhook.port}/webhooks/github`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 202, await response.text());
  assert.equal(
    (await h.db.query("SELECT delivery_id FROM leaderboard_ingestion.inbox WHERE delivery_id=$1", [deliveryId])).rows
      .length,
    1,
  );
  assert.equal(
    (await h.runtime.enrichment.readStates(2, "issues")).some((row) => row.state === "leased"),
    true,
  );
  await h.runtime.stop();
  assert.equal(request.signal.aborted, true);
  finish.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::integer AS n FROM leaderboard_ingestion.enrichment_jobs WHERE metadata IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(h.runtime.enrichment.readStates(2, "issues"), /enrichment_authorization_changed/);
});

test("an admitted derived retirement immediately invalidates the metadata request fence", async (t) => {
  const started = latch(),
    finish = latch();
  let request;
  const h = await harness(t, {
    memoryDatabase: true,
    metadataEnrichment: option({
      async readMetadata(value) {
        request = value;
        started.resolve();
        await finish.promise;
        return details(value);
      },
    }),
  });
  await h.runtime.runOnce();
  const pending = h.runtime.enrichment.processOne().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await started.promise;
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  await migratePipelineDerivedRetirement(h.db);
  const input = {
    operationId: "synthetic-metadata-retirement",
    repositoryId: 2,
    expectedGeneration: String(
      (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .generation,
    ),
    policyVersion: "synthetic-retirement-v1",
    authorizationReceipt: "synthetic-retirement-approval",
    operatorId: "synthetic-operator",
  };
  const revision = h.controlsStore.publicSnapshot().configuration.revision;
  await new components.ingestion.RepositoryRetirementStore(h.db).retire(input, async () => true);
  assert.equal(
    (await new PipelineDerivedRetirementStore(h.db, h.controlsStore).admit(input, async () => true)).status,
    "derived_writes_fenced",
  );
  assert.equal(h.controlsStore.publicSnapshot().configuration.revision, revision);
  let denial;
  try {
    request.assertAuthorized();
  } catch (error) {
    denial = error;
  }
  finish.resolve();
  const outcome = await pending;
  assert.match(denial?.message ?? "no synchronous denial", /enrichment_authorization_changed/);
  assert.match(outcome.error?.message ?? "no operation denial", /enrichment_authorization_changed/);
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::integer AS n FROM leaderboard_ingestion.enrichment_jobs WHERE metadata IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(h.runtime.enrichment.readStates(2, "issues"), /enrichment_authorization_changed/);
});
