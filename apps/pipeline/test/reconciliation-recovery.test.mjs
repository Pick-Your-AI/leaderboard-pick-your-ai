import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createPipeline } from "../src/index.mjs";
import { harness, components, fixtureId, ago, boardUrl } from "./harness.mjs";

const digest = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");

async function unconfirmedLegacy(t) {
  const legacyMarker = digest(["synthetic-prior-publisher", "retained-opaque-marker"]);
  const h = await harness(t, {
    webhookDispatch: true,
    components: {
      ...components,
      metrics: {
        ...components.metrics,
        aggregateMetric(input, ...args) {
          // A fixture adapter represents the prior producer's opaque marker.
          // The actual engine, SQL publisher and input receipt remain in use;
          // no confirmation or stored hash is synthesized by this fixture.
          input.backfillRevision = legacyMarker;
          return components.metrics.aggregateMetric(input, ...args);
        },
      },
    },
  });
  const secret = "synthetic-recovery-webhook-secret-at-least-32-characters";
  const delivery = fixtureId(240);
  const eventKey = `github:delivery:${delivery}`;
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
    sender: { node_id: "SYNTHETIC_SENDER_NOT_AUTHOR" },
    issue: { node_id: "SYNTHETIC_ISSUE_1", number: 1, created_at: ago(2) },
  });
  const handler = components.ingestion.createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
  });
  const accepted = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": delivery,
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
  );
  assert.equal(accepted.status, 202, await accepted.text());
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const result = change(state);
      if (state.pipelinePublications) throw Error("synthetic_confirmation_failure");
      return result;
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  h.controlsStore.transaction = transaction;
  const stored = (await h.db.query("SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs"))
    .rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].document.frozen.backfillRevision, legacyMarker);
  assert.ok(stored[0].document.frozen.coverage.every((entry) => entry.state === "partial"));
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.dispatch_publications")).rows[0].n,
    1,
  );
  await h.runtime.stop();
  await h.reopenDatabase();
  const current = await createPipeline({ ...h.options, components });
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE event_key=$1", [
    eventKey,
  ]);
  return { h, current, stored, eventKey };
}

test("unconfirmed legacy publication recovers its exact retained marker after database restart", async (t) => {
  const { h, current, stored } = await unconfirmedLegacy(t);
  try {
    assert.equal(await current.dispatchOnce(), "processed");
    assert.deepEqual(
      (await h.db.query("SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs")).rows,
      stored,
    );
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
    assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 1);
    const publicResult = await current.app.inject(boardUrl);
    assert.equal(publicResult.statusCode, 200, publicResult.body);
    assert.deepEqual(
      publicResult.json().rows.map((row) => row.result.value),
      [1, 1],
    );
    assert.equal(await current.dispatchOnce(), "idle");
  } finally {
    await current.stop();
  }
});

test("unconfirmed recovery cannot use a missing, altered or unrelated frozen marker", async (t) => {
  for (const mutation of ["missing", "bad_hash", "changed_cutoff", "rebound_marker"]) {
    await t.test(mutation, async (t) => {
      const { h, current, stored, eventKey } = await unconfirmedLegacy(t);
      try {
        const saved = stored[0];
        if (mutation === "missing") {
          await h.db.query("DELETE FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [saved.snapshot_id]);
        } else {
          const document = structuredClone(saved.document);
          if (mutation === "changed_cutoff") document.frozen.cutoff = ago(1);
          else document.frozen.backfillRevision = digest(["synthetic-unrelated-marker"]);
          await h.db.query(
            "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
            [
              saved.snapshot_id,
              JSON.stringify(document),
              mutation === "bad_hash" ? saved.document_hash : digest(document),
            ],
          );
        }
        assert.equal(await current.dispatchOnce(), "retry_scheduled");
        const outbox = (
          await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox WHERE event_key=$1", [eventKey])
        ).rows[0];
        assert.equal(outbox.completion, null);
        assert.equal(h.controlsStore.read().pipelinePublications?.[saved.snapshot_id], undefined);
        assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
        assert.equal((await current.app.inject(boardUrl)).statusCode, 503);
        assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
      } finally {
        await current.stop();
      }
    });
  }
});
