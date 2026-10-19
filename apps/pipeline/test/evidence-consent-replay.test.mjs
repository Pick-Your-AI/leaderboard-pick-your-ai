import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { ago, boardUrl, components, fixtureId, harness, publicScope } from "./harness.mjs";

// Synthetic source transport and review receipts exercise the real collector,
// normalizer, metric engine, SQL publication, SQLite confirmation and HTTP reads.
// They are not real contributor evidence or authorization to enable dispatch.
const webhookSecret = "synthetic-consent-replay-secret-more-than-32-characters";
const deliveryId = fixtureId(551);
const eventKey = `github:delivery:${deliveryId}`;

async function enqueue(h) {
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2).replace(/\.\d{3}Z$/, "Z") },
  });
  const handler = components.ingestion.createWebhookHandler({
    secrets: [webhookSecret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
  });
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(response.status, 202, await response.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
}

async function dispatchRow(h) {
  return (await h.db.query("SELECT * FROM leaderboard_ingestion.outbox WHERE event_key=$1", [eventKey])).rows[0];
}

async function publishedBeforeAcknowledgment(t) {
  const h = await harness(t, {
    webhookDispatch: true,
    configure(config) {
      const policy = config.policies[0].policy;
      policy.version = "synthetic-reviewed-consent-v1";
      policy.dateBasis = "acceptedAt";
      policy.rankedStates = ["qualified"];
      config.policies[0].signature = components.metrics.stableJSON(policy);
      config.recognitionBindings = [
        {
          category: "finding",
          scope: "repository:2",
          policyVersion: policy.version,
          metricId: "issues_opened",
          sourceMetricId: "issues_opened",
          repositoryId: "2",
          reviewerIds: ["202"],
        },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    const request = {
      id: "synthetic-consent-replay-claim",
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: "finding",
      scope: "repository:2",
      policyVersion: h.config.policies[0].policy.version,
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      collaborators: { 303: "accepted" },
      version: 1,
      history: [],
    };
    state.requests[request.id] = request;
    components.controls.record(state, request, "202", "accepted", Date.parse(ago(1)), {
      policyVersion: request.policyVersion,
    });
  });
  await enqueue(h);
  h.runtime.outbox.complete = async () => {
    throw new Error("synthetic process loss after confirmed publication");
  };
  h.runtime.outbox.fail = async () => {
    throw new Error("synthetic process loss after confirmed publication");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic process loss after confirmed publication/);
  const response = await h.runtime.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  const board = response.json();
  assert.deepEqual(
    board.rows.map((row) => [row.actorId, row.result.value]),
    [["101", 1]],
  );
  const saved = (await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots")).rows;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].document.evidence[0].evidenceMetadata.activityState, "accepted");
  const confirmation = structuredClone(h.controlsStore.read().pipelinePublications[board.snapshotId]);
  assert.equal(
    confirmation.recognitionFingerprint,
    recognitionFingerprint(h.controlsStore.read(), h.config.recognitionBindings),
  );
  const pending = await dispatchRow(h);
  assert.equal(pending.state, "leased");
  assert.equal(pending.completion, null);
  return { h, board, saved, confirmation, pending, etag: response.headers.etag };
}

async function restart(h, t) {
  await h.runtime.stop();
  await h.reopenDatabase();
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE event_key=$1 AND state='leased'",
    [eventKey],
  );
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  return recovered;
}

for (const disposition of ["pending", "declined", "withdrawn"])
  test(`dispatch replay cannot refresh original recognition authority after required consent becomes ${disposition}`, async (t) => {
    const { h, board, saved, confirmation, pending, etag } = await publishedBeforeAcknowledgment(t);
    h.controlsStore.transaction((state) => {
      const request = state.requests["synthetic-consent-replay-claim"];
      if (disposition === "withdrawn") request.status = "withdrawn";
      else request.collaborators["303"] = disposition;
      // Retain accepted status for pending/declined legacy requests. Their old
      // review must not authorize the whole claim just because the owner stayed.
      components.controls.record(state, request, disposition === "withdrawn" ? "101" : "303", disposition, Date.now());
    });
    assert.notEqual(
      recognitionFingerprint(h.controlsStore.read(), h.config.recognitionBindings),
      confirmation.recognitionFingerprint,
    );
    const recovered = await restart(h, t);
    const signal = new AbortController().signal;
    assert.equal(await recovered.source.read(publicScope, board.snapshotId, signal), null);
    assert.equal(await recovered.dispatchOnce(), "retry_scheduled");
    const retried = await dispatchRow(h);
    assert.deepEqual(retried.operation, pending.operation);
    assert.equal(retried.completion, null);
    assert.equal(retried.reason_code, "publication_unavailable");
    assert.equal(retried.attempts, 2);
    assert.deepEqual(h.controlsStore.read().pipelinePublications[board.snapshotId], confirmation);
    assert.deepEqual(
      (await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots")).rows,
      saved,
    );
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 2);
    assert.equal(await recovered.source.read(publicScope, board.snapshotId, signal), null);
    for (const url of [boardUrl, `${boardUrl}&snapshot=${board.snapshotId}`]) {
      const response = await recovered.app.inject({ url, headers: { "if-none-match": etag } });
      assert.equal(response.statusCode, url === boardUrl ? 503 : 410, response.body);
    }
    await recovered.stop();
  });

test("dispatch replay with unchanged reviewed participant consent recovers its original publication once", async (t) => {
  const { h, board, saved, confirmation, pending } = await publishedBeforeAcknowledgment(t);
  h.controlsStore.transaction((state) => {
    state.audit.push({ id: "synthetic-unrelated-session", actor: "404", action: "login", at: Date.now() });
  });
  assert.equal(
    recognitionFingerprint(h.controlsStore.read(), h.config.recognitionBindings),
    confirmation.recognitionFingerprint,
  );
  const recovered = await restart(h, t);
  assert.equal(await recovered.dispatchOnce(), "processed");
  const done = await dispatchRow(h);
  assert.deepEqual(done.operation, pending.operation);
  assert.equal(done.completion.publications[0].snapshotId, board.snapshotId);
  assert.equal(done.attempts, 2);
  assert.deepEqual(h.controlsStore.read().pipelinePublications[board.snapshotId], confirmation);
  assert.deepEqual((await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots")).rows, saved);
  const response = await recovered.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().snapshotId, board.snapshotId);
  assert.deepEqual(
    response.json().rows.map((row) => [row.actorId, row.result.value]),
    [["101", 1]],
  );
  assert.equal(await recovered.dispatchOnce(), "idle");
  await recovered.stop();
});

test("obsolete consent dispatch reaches quarantine while fresh reconciliation publishes current safe work", async (t) => {
  const { h, board, saved, confirmation, pending } = await publishedBeforeAcknowledgment(t);
  h.controlsStore.transaction((state) => {
    const request = state.requests["synthetic-consent-replay-claim"];
    request.status = "withdrawn";
    components.controls.record(state, request, "101", "withdrawn", Date.now());
  });
  const recovered = await restart(h, t);
  const outcomes = [];
  // Move only disposable retry clocks forward; every attempt still goes through
  // the actual lease, collection, frozen-publication guard and outbox failure.
  for (let attempt = 2; attempt <= 5; attempt++) {
    await h.db.query(
      "UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE event_key=$1 AND state='pending'",
      [eventKey],
    );
    outcomes.push(await recovered.dispatchOnce());
  }
  assert.deepEqual(outcomes, ["retry_scheduled", "retry_scheduled", "retry_scheduled", "quarantined"]);
  const quarantined = await dispatchRow(h);
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.attempts, 5);
  assert.equal(quarantined.reason_code, "publication_unavailable");
  assert.equal(quarantined.completion, null);
  assert.deepEqual(quarantined.operation, pending.operation);
  assert.equal(
    new Date(quarantined.observation_cutoff).toISOString(),
    new Date(pending.observation_cutoff).toISOString(),
  );
  assert.deepEqual(quarantined.source_generations, pending.source_generations);
  assert.equal(await recovered.dispatchOnce(), "idle");
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT outcome FROM leaderboard_ingestion.outbox_attempts WHERE event_key=$1 ORDER BY attempt",
        [eventKey],
      )
    ).rows.map((row) => row.outcome),
    ["expired", "retry", "retry", "retry", "quarantined"],
  );

  const fresh = await recovered.runOnce();
  assert.equal(fresh.state, "published");
  const publication = fresh.publications[0];
  assert.notEqual(publication.snapshotId, board.snapshotId);
  const read = await recovered.source.read(publicScope, publication.snapshotId, new AbortController().signal);
  assert.ok(read);
  assert.equal(
    read.selected.rows.some((row) => row.result.value > 0),
    false,
  );
  assert.equal(
    read.selected.evidence.some((entry) => entry.evidenceMetadata?.activityState === "accepted"),
    false,
  );
  assert.equal(await recovered.source.read(publicScope, board.snapshotId, new AbortController().signal), null);
  assert.deepEqual(h.controlsStore.read().pipelinePublications[board.snapshotId], confirmation);
  assert.deepEqual(
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
        board.snapshotId,
      ])
    ).rows,
    saved,
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 2);
  assert.equal((await recovered.app.inject(boardUrl)).statusCode, 200);
  assert.deepEqual(await recovered.outbox.health(), { pending: 0, leased: 0, quarantined: 1, completed: 0 });
  assert.equal(await recovered.dispatchOnce(), "idle");
  assert.deepEqual((await dispatchRow(h)).operation, pending.operation);
  await recovered.stop();
});

test("unchanged requests with a pre-consent-rule confirmation require fresh reconciliation", async (t) => {
  const { h, board, confirmation, pending } = await publishedBeforeAcknowledgment(t);
  const original = h.controlsStore.read();
  const request = original.requests["synthetic-consent-replay-claim"];
  // Exact prior authority format for this one generic binding: no domain or
  // source-admission generation applied to issues_opened before consent gating.
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "localization-review-target/v1",
        [request],
        [],
        [JSON.stringify(request.history[0])],
        h.config.recognitionBindings,
      ]),
    )
    .digest("hex");
  assert.notEqual(legacyFingerprint, confirmation.recognitionFingerprint);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[board.snapshotId].recognitionFingerprint = legacyFingerprint;
    for (const head of Object.values(state.pipelineHeads))
      if (head.snapshotId === board.snapshotId) head.recognitionFingerprint = legacyFingerprint;
  });
  assert.deepEqual(h.controlsStore.read().requests, original.requests);
  assert.deepEqual(h.controlsStore.read().audit, original.audit);
  assert.equal(
    recognitionFingerprint(h.controlsStore.read(), h.config.recognitionBindings),
    confirmation.recognitionFingerprint,
  );
  const recovered = await restart(h, t);
  assert.equal(await recovered.source.read(publicScope, board.snapshotId, new AbortController().signal), null);
  assert.equal(await recovered.dispatchOnce(), "retry_scheduled");
  assert.equal((await dispatchRow(h)).completion, null);
  assert.deepEqual((await dispatchRow(h)).operation, pending.operation);
  assert.equal(h.controlsStore.read().pipelinePublications[board.snapshotId].recognitionFingerprint, legacyFingerprint);

  const fresh = await recovered.runOnce();
  assert.equal(fresh.state, "published");
  assert.notEqual(fresh.publications[0].snapshotId, board.snapshotId);
  const response = await recovered.app.inject(boardUrl);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().snapshotId, fresh.publications[0].snapshotId);
  assert.deepEqual(
    response.json().rows.map((row) => [row.actorId, row.result.value]),
    [["101", 1]],
  );
  assert.equal(await recovered.source.read(publicScope, board.snapshotId, new AbortController().signal), null);
  assert.deepEqual(h.controlsStore.read().requests, original.requests);
  assert.deepEqual(h.controlsStore.read().audit, original.audit);
  await recovered.stop();
});
