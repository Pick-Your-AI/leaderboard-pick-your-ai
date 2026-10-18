// Synthetic retained publication and real loopback transport; no live Project enrollment.
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPublicScope,
  publicContributionRoles,
  publicScopeKey,
  publicScopeParameters,
} from "@pick-your-ai/contracts";
import { createPipeline } from "../src/index.mjs";
import { fixtureId, publicScope } from "./harness.mjs";
import { operatorAllow, operatorHarness, queueOperatorReplay } from "./operator-harness.mjs";
import { projects } from "./scope-storage-harness.mjs";

const scopeV2 = canonicalPublicScope({ ...publicScope, context: "current", projects });
const scopeV3 = canonicalPublicScope({ ...scopeV2, schemaVersion: undefined, roles: publicContributionRoles });
const path = (scope, pin) =>
  `/api/v1/boards?${new URLSearchParams({ ...publicScopeParameters(scope), metric: "issues_opened", snapshot: pin })}`;

async function listen(app) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return async (target, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${target}`, {
      headers: { Connection: "close", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
}

test("100-Project v2/v3 scopes survive actual replay publication, socket reads, restart and privacy fences", async (t) => {
  const scopes = [scopeV2, scopeV3];
  assert.equal(projects.length, 100);
  assert.equal(new Set(projects).size, 100);
  assert.ok(projects.every((value) => /^[a-f0-9]{128}$/.test(value)));
  assert.ok(scopes.every((scope) => publicScopeKey(scope).length > 13_000));
  const h = await operatorHarness(t, {
    webhookDispatch: true,
    configure(config) {
      config.scopes = structuredClone(scopes);
      config.repositories[0].allowedProjectIds = projects;
    },
  });
  const receipt = await queueOperatorReplay(h, 820);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const verified = await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  assert.equal(verified.status, "published");
  assert.equal(verified.publications.length, 2);
  assert.equal(new Set(verified.publications.map((value) => value.snapshotId)).size, 2);
  const saved = (
    await h.db.query(
      `SELECT state,operation,completion,
      leaderboard_ingestion.delivery_expiry_completion_valid(operation,completion) AS valid
      FROM leaderboard_ingestion.outbox WHERE event_key=$1`,
      [`github:delivery:${receipt.deliveryId}`],
    )
  ).rows[0];
  assert.equal(saved.state, "done");
  assert.equal(saved.valid, true, "the upgraded SQL recognizer accepts the actual long-scope completion");
  assert.deepEqual(saved.completion.publications, verified.publications);
  assert.equal(saved.completion.operationKey, saved.operation.operationKey);
  const ledger = await h.db.query(
    "SELECT scope_key,snapshot_id FROM leaderboard_pipeline.dispatch_publications ORDER BY scope_key",
  );
  const native = await listen(h.runtime.app);
  const original = [];
  const readsBefore = { ...h.githubReads };
  for (const scope of scopes) {
    const publication = verified.publications.find((value) => value.scopeKey === publicScopeKey(scope));
    assert.ok(publication);
    const target = path(scope, publication.snapshotId);
    assert.ok(target.length > 4_096, "this real request crosses the original failed transport boundary");
    const response = await native(target);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(response.data.scope, scope);
    assert.equal(response.data.snapshotId, publication.snapshotId);
    assert.equal(response.data.schemaVersion, scope === scopeV2 ? "public-read/v2" : "public-read/v3");
    assert.ok(response.headers.get("etag"));
    original.push({ target, data: response.data, etag: response.headers.get("etag") });
  }
  assert.deepEqual(h.githubReads, readsBefore, "public reads do not recollect or infer provider authority");
  const health = await h.runtime.operations.readHealth(2, operatorAllow);
  assert.equal(health.publication.state, "verified");
  assert.deepEqual(health.publication.publications, verified.publications);
  await h.runtime.stop();
  await h.reopenDatabase();
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  const retained = await recovered.operations.readReplayResult(2, receipt.id, operatorAllow);
  assert.equal(retained.status, "published");
  assert.deepEqual(retained.publications, verified.publications);
  assert.equal(await recovered.dispatchOnce(), "idle");
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT scope_key,snapshot_id FROM leaderboard_pipeline.dispatch_publications ORDER BY scope_key",
      )
    ).rows,
    ledger.rows,
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 2);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.observations")).rows[0].n, 1);
  const restarted = await listen(recovered.app);
  for (const before of original) {
    const response = await restarted(before.target);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(response.data, before.data);
  }
  await recovered.collection.suppress(fixtureId(821), "f".repeat(64), 1, [2], "private");
  for (const before of original) {
    const withheld = await restarted(before.target, { "If-None-Match": before.etag });
    assert.equal(withheld.status, 410, JSON.stringify(withheld.data));
    assert.equal(withheld.data.error, "snapshot_expired_refetch");
    assert.equal("rows" in withheld.data || "evidence" in withheld.data, false);
  }
  await assert.rejects(
    () => recovered.operations.readReplayResult(2, receipt.id, operatorAllow),
    /operation_source_unavailable/,
  );
});
