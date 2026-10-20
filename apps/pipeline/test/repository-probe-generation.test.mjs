import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { boardUrl, clock, components, fixtureId, getBoard, harness } from "./harness.mjs";

const accessQuery = "SELECT state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1";
const secret = "synthetic-probe-lifecycle-secret-at-least-32-characters";
const testOptions = { timeout: 60_000 };
const retainedTables = [
  "leaderboard_ingestion.collection_runs",
  "leaderboard_ingestion.source_facts",
  "leaderboard_pipeline.normalizations",
  "leaderboard_pipeline.frozen_inputs",
  "leaderboard_pipeline.snapshots",
  "leaderboard_pipeline.heads",
];

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`synthetic test boundary timed out: ${label}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function capturedProbeBarrier(t) {
  let enter,
    release,
    armed = false,
    pending = Promise.resolve();
  const entered = new Promise((resolve) => (enter = resolve));
  const released = new Promise((resolve) => (release = resolve));
  // Register before harness cleanup; the case's finally also releases and settles.
  t.after(async () => {
    release();
    await bounded(pending, "released pipeline cleanup");
  });
  return {
    arm() {
      assert.equal(armed, false);
      armed = true;
    },
    async capture(value) {
      if (!armed) return value;
      armed = false;
      enter(structuredClone(value));
      await released;
      return value;
    },
    start(work) {
      pending = work.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      return pending;
    },
    entered() {
      return bounded(
        Promise.race([entered, pending.then(() => assert.fail("pipeline settled before the captured public probe"))]),
        "captured public probe",
      );
    },
    release,
    settle() {
      return bounded(pending, "released pipeline");
    },
  };
}

async function fixture(t) {
  const barrier = capturedProbeBarrier(t);
  const calls = { probes: 0, pages: 0 };
  let h;
  h = await harness(t, {
    probeRepository: async (repo) => {
      calls.probes++;
      const value = await h.options.githubClient.rest("installation:1", `/repos/${repo.slug}`);
      const captured = {
        repositoryId: value.id,
        installationId: repo.installationId,
        visibility: value.private ? "private" : "public",
        checkedAt: clock(),
      };
      return barrier.capture(captured);
    },
  });
  const readPage = h.options.source.readPage;
  h.options.source.readPage = (request) => {
    calls.pages++;
    return readPage(request);
  };
  // Distinct explicit cutoffs target one probe, without waiting on wall-clock ticks.
  let cutoff = Date.now() - 120_000;
  return {
    h,
    barrier,
    calls,
    cutoff: () => new Date((cutoff += 1000)).toISOString(),
  };
}

async function access(h) {
  const row = (
    await h.db.query(
      "SELECT repository_id,installation_id,state,generation::text AS generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1",
      [2],
    )
  ).rows[0];
  return row
    ? {
        repositoryId: Number(row.repository_id),
        installationId: Number(row.installation_id),
        state: row.state,
        generation: row.generation,
      }
    : null;
}

async function retained(h) {
  const result = {};
  for (const table of retainedTables)
    result[table] = (
      await h.db.query(`SELECT to_jsonb(saved) AS document FROM ${table} AS saved ORDER BY to_jsonb(saved)::text`)
    ).rows.map((row) => row.document);
  result.publications = structuredClone(h.controlsStore.read().pipelinePublications ?? {});
  return result;
}

async function signedLifecycle(h, reason, deliveryNumber) {
  const event =
    reason === "private" ? "repository" : reason === "removed" ? "installation_repositories" : "installation";
  const payload =
    reason === "private"
      ? { installation: { id: 1 }, repository: { id: 2, private: true }, action: "privatized" }
      : reason === "removed"
        ? { installation: { id: 1 }, repositories_removed: [{ id: 2 }], action: "removed" }
        : {
            installation: {
              id: 1,
              app_id: 2,
              target_id: 3,
              repository_selection: "selected",
              target_type: "Organization",
            },
            action: "deleted",
          };
  const body = JSON.stringify(payload);
  const deliveryId = fixtureId(deliveryNumber);
  const handler = components.ingestion.createWebhookHandler({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: h.runtime.inbox,
    lifecycle: h.runtime.collection,
  });
  const response = await bounded(
    handler(
      new Request("https://synthetic.invalid/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": event,
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      }),
    ),
    "signed lifecycle acknowledgment",
  );
  const acknowledgment = await response.json();
  assert.equal(response.status, 202, JSON.stringify(acknowledgment));
  assert.deepEqual(acknowledgment, { status: "accepted" });
  const receipt = (
    await h.db.query(
      "SELECT body_hash,installation_id,repository_ids,reason FROM leaderboard_ingestion.lifecycle_receipts WHERE delivery_id=$1",
      [deliveryId],
    )
  ).rows[0];
  assert.ok(receipt, "the signed acknowledgment follows a committed lifecycle receipt");
  assert.equal(receipt.body_hash, createHash("sha256").update(body).digest("hex"));
  assert.equal(Number(receipt.installation_id), 1);
  assert.deepEqual(receipt.repository_ids, [2]);
  assert.equal(receipt.reason, reason);
}

async function withheld(h, pin, pinnedStatus = 410, validators = []) {
  for (const url of [boardUrl, "/api/v1/exports?metric=issues_opened", "/api/v1/updates"])
    assert.equal((await h.runtime.app.inject(url)).statusCode, 503, url);
  if (pin !== null) assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode, pinnedStatus);
  for (const cached of validators) {
    const response = await h.runtime.app.inject({
      method: "GET",
      url: cached.url,
      headers: { "if-none-match": cached.etag },
    });
    assert.equal(response.statusCode, cached.url === boardUrl ? 503 : pinnedStatus, cached.url);
    assert.equal(response.headers["cache-control"], "no-store", cached.url);
    assert.deepEqual(Object.keys(response.json()), ["error"], cached.url);
    for (const value of cached.publicContent) assert.equal(response.body.includes(value), false, cached.url);
  }
}

async function prepare(f, initial, captureValidators = false) {
  let pin = null;
  const validators = [];
  if (initial !== "absent") {
    const result = await bounded(f.h.runtime.runOnce({ cutoff: f.cutoff() }), "initial publication");
    assert.equal(result.state, "published");
    const board = await getBoard(f.h.runtime);
    assert.equal(board.rows.length, 2);
    pin = board.snapshotId;
    if (captureValidators) {
      for (const url of [boardUrl, `${boardUrl}&snapshot=${pin}`]) {
        const response = await f.h.runtime.app.inject(url);
        assert.equal(response.statusCode, 200, response.body);
        const value = response.json();
        assert.equal(value.snapshotId, pin);
        assert.equal(value.rows.length, 2);
        assert.ok(value.rows.every((row) => row.evidenceIds.length > 0));
        const etag = response.headers.etag;
        assert.match(etag, /^"[a-f0-9]{64}"$/);
        const unchanged = await f.h.runtime.app.inject({
          method: "GET",
          url,
          headers: { "if-none-match": etag },
        });
        assert.equal(unchanged.statusCode, 304, unchanged.body);
        assert.equal(unchanged.body, "");
        assert.equal(unchanged.headers.etag, etag);
        const publicContent = [value.snapshotId, ...value.rows.flatMap((row) => [row.actorId, ...row.evidenceIds])];
        assert.ok(publicContent.every((entry) => typeof entry === "string" && entry.length > 0));
        validators.push({ url, etag, publicContent });
      }
    }
    if (initial === "unavailable") await signedLifecycle(f.h, "private", 901);
  }
  const current = await access(f.h);
  if (initial === "absent") {
    assert.equal(current, null);
    const empty = await retained(f.h);
    for (const table of retainedTables) assert.deepEqual(empty[table], [], table);
    assert.deepEqual(empty.publications, {});
  } else {
    assert.equal(current.state, initial);
    assert.equal(current.repositoryId, 2);
    assert.equal(current.installationId, 1);
  }
  return { pin, current, validators };
}

function rejected(outcome, message) {
  assert.equal(outcome.status, "rejected", "the pending run must reject, not return a blocked/collecting result");
  assert.equal(outcome.error?.name, "Error");
  assert.equal(outcome.error?.message, message);
}

for (const initial of ["public", "unavailable", "absent"])
  for (const reason of ["private", "removed"])
    test(
      `a pending public probe cannot adopt ${reason} access from an initially ${initial} repository`,
      testOptions,
      async (t) => {
        const f = await fixture(t);
        const { h, barrier, calls } = f;
        const { pin, current, validators } = await prepare(f, initial, true);
        const before = await retained(h);
        const callsBefore = { ...calls };
        const transportBefore = { ...h.githubReads };
        let denied;
        barrier.arm();
        barrier.start(h.runtime.runOnce({ cutoff: f.cutoff() }));
        try {
          const captured = await barrier.entered();
          assert.equal(captured.repositoryId, 2);
          assert.equal(captured.installationId, 1);
          assert.equal(captured.visibility, "public");
          assert.equal(new Date(captured.checkedAt).toISOString(), captured.checkedAt);
          assert.equal(calls.probes, callsBefore.probes + 1);
          assert.equal(calls.pages, callsBefore.pages);
          assert.ok(h.githubReads.fetches > transportBefore.fetches);
          assert.ok(h.githubReads.tokens > transportBefore.tokens);
          const transportAtCapture = { ...h.githubReads };

          if (reason === "private") h.setPrivate(true);
          await signedLifecycle(h, reason, 902);
          denied = await access(h);
          assert.equal(denied.state, "unavailable");
          assert.equal(denied.generation, current ? String(BigInt(current.generation) + 1n) : "1");
          assert.deepEqual(await retained(h), before);
          await withheld(h, pin, 410, validators);

          barrier.release();
          rejected(
            await barrier.settle(),
            initial === "public" ? "repository_access_changed" : "repository_revoked_or_changed",
          );
          assert.deepEqual(
            await access(h),
            denied,
            "the late result must not restore or advance the denial generation",
          );
          assert.deepEqual(calls, { probes: callsBefore.probes + 1, pages: callsBefore.pages });
          assert.deepEqual(
            h.githubReads,
            transportAtCapture,
            "no page or hydration request follows the rejected probe",
          );
          assert.deepEqual(await retained(h), before);
          await withheld(h, pin, 410, validators);
        } finally {
          barrier.release();
          await barrier.settle();
        }

        // A separate fresh request may reauthorize a nonpermanent restriction.
        h.setPrivate(false);
        const fresh = await bounded(h.runtime.runOnce({ cutoff: f.cutoff() }), "fresh post-denial publication");
        assert.equal(fresh.state, "published");
        const restored = await access(h);
        assert.equal(restored.state, "public");
        assert.equal(restored.generation, String(BigInt(denied.generation) + 1n));
        assert.equal(calls.probes, callsBefore.probes + 2);
        assert.ok(calls.pages > callsBefore.pages);
        assert.equal((await getBoard(h.runtime)).rows.length, 2);
        if (pin !== null) assert.equal((await getBoard(h.runtime, `&snapshot=${pin}`)).snapshotId, pin);
      },
    );

for (const initial of ["public", "unavailable", "absent"])
  test(`a fresh unchanged public probe admits an initially ${initial} repository`, testOptions, async (t) => {
    const f = await fixture(t);
    const { h, calls } = f;
    const { current } = await prepare(f, initial);
    const before = { ...calls };
    const result = await bounded(h.runtime.runOnce({ cutoff: f.cutoff() }), "healthy publication");
    assert.equal(result.state, "published");
    assert.deepEqual(await access(h), {
      repositoryId: 2,
      installationId: 1,
      state: "public",
      generation: current ? String(BigInt(current.generation) + BigInt(initial === "public" ? 0 : 1)) : "1",
    });
    assert.equal(calls.probes, before.probes + 1);
    assert.ok(calls.pages > before.pages);
    assert.equal((await getBoard(h.runtime)).rows.length, 2);
  });

test("an installation-wide revoked receipt remains an absolute reactivation fence", testOptions, async (t) => {
  const f = await fixture(t);
  const { h, barrier, calls } = f;
  const { pin } = await prepare(f, "unavailable");
  const before = await retained(h);
  const callsBefore = { ...calls };
  let denied;
  barrier.arm();
  barrier.start(h.runtime.runOnce({ cutoff: f.cutoff() }));
  try {
    assert.equal((await barrier.entered()).visibility, "public");
    await signedLifecycle(h, "revoked", 903);
    denied = await access(h);
    assert.equal(denied.state, "unavailable");
    barrier.release();
    rejected(await barrier.settle(), "repository_revoked_or_changed");
    assert.deepEqual(await access(h), denied);
    assert.equal(calls.pages, callsBefore.pages);
    assert.deepEqual(await retained(h), before);
    await withheld(h, pin);
  } finally {
    barrier.release();
    await barrier.settle();
  }
  await assert.rejects(
    bounded(h.runtime.runOnce({ cutoff: f.cutoff() }), "fresh probe after installation revocation"),
    { name: "Error", message: "repository_revoked_or_changed" },
  );
  assert.equal(calls.probes, callsBefore.probes + 2);
  assert.equal(calls.pages, callsBefore.pages);
  assert.deepEqual(await access(h), denied);
  assert.deepEqual(await retained(h), before);
  await withheld(h, pin);
});

test("configuration revocation during the access-row read prevents the outbound probe", testOptions, async (t) => {
  const f = await fixture(t);
  const { h, calls } = f;
  const { pin, current } = await prepare(f, "public");
  const before = await retained(h);
  const callsBefore = { ...calls };
  const transportBefore = { ...h.githubReads };
  const query = h.db.query;
  let armed = true,
    interceptions = 0;
  h.db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (armed && sql === accessQuery) {
      armed = false;
      interceptions++;
      assert.deepEqual(params, [2]);
      assert.equal(String(result.rows[0].generation), current.generation);
      h.controlsStore.transaction(
        (state) => {
          state.configuration = {
            revision: 1,
            proposals: {},
            history: [],
            active: {
              version: "synthetic-revoked-v1",
              digest: "a".repeat(64),
              approval: { id: "synthetic-revocation-approval" },
              document: { repositories: [], projects: [], metrics: [] },
            },
          };
        },
        { publish: true },
      );
    }
    return result;
  };
  try {
    await assert.rejects(bounded(h.runtime.runOnce({ cutoff: f.cutoff() }), "configuration read boundary"), {
      name: "Error",
      message: "active_configuration_revoked_source",
    });
  } finally {
    h.db.query = query;
  }
  assert.equal(interceptions, 1);
  assert.deepEqual(calls, callsBefore);
  assert.deepEqual(
    h.githubReads,
    transportBefore,
    "configuration changes stop the outbound token and metadata request",
  );
  assert.deepEqual(await access(h), current);
  assert.deepEqual(await retained(h), before);
  await withheld(h, pin, 503);
});
