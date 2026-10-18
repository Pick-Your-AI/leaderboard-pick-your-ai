import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../src/store.mjs";
import { createControlsServer } from "../src/server.mjs";

const origin = "https://controls.example.test";
const window = {
  receivedSince: "2026-10-01T00:00:00.000Z",
  receivedUntil: "2026-10-02T00:00:00.000Z",
  limit: 50,
  policyVersion: "test-1",
};
const commit = { ...window, expectedRevision: "a".repeat(64), reason: "operator_reviewed", confirmed: true };
const routes = [
  ["/replay-window/preview", window],
  ["/replay-window", commit],
];

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-window-controls-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  let now = 100_000;
  const token = "a".repeat(43),
    csrf = "b".repeat(43),
    viewerToken = "c".repeat(43);
  store.transaction((state) => {
    for (const [actorId, sessionToken, roles] of [
      ["7", token, ["operator"]],
      ["1", viewerToken, []],
    ])
      state.sessions[createHash("sha256").update(sessionToken).digest("base64url")] = {
        actorId,
        csrf,
        roles,
        roleVersion: "roster-1",
        expires: now + 900_000,
      };
  });
  const server = createControlsServer({
    store,
    origin,
    now: () => now,
    provider: {
      exchange() {
        throw Error("Synthetic session only");
      },
      authorizationURL() {
        throw Error("Synthetic session only");
      },
    },
    rolesForActor: (id) => ({ roles: id === "7" ? ["operator"] : [], version: "roster-1" }),
    operations: options.operations,
    authorizeRepository: options.authorizeRepository,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    expire: () => {
      now += 900_001;
    },
    async call(path, input, options = {}) {
      const method = options.method ?? (input === undefined ? "GET" : "POST");
      const response = await fetch(`http://127.0.0.1:${server.address().port}/controls/operations/${path}`, {
        method,
        redirect: "error",
        headers: {
          ...(options.anonymous ? {} : { cookie: `__Host-controls_session=${options.viewer ? viewerToken : token}` }),
          origin,
          "x-csrf-token": csrf,
          ...(input === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      return { status: response.status, data: await response.json(), headers: response.headers };
    },
  };
}

test("window HTTP routes require operator, exact repository authority, CSRF, preview fields and confirmation", async (t) => {
  const calls = [];
  const run = async (input, authorize) => {
    await authorize(input.repositoryId);
    calls.push(input);
    return { synthetic: true };
  };
  const h = await harness(t, {
    operations: { previewReplayWindow: run, replayWindow: run },
    authorizeRepository: async ({ actorId, repositoryId }) => ({
      allowed: actorId === "7" && repositoryId === 9,
      policyVersion: "test-1",
      revision: "grant-1",
    }),
  });
  for (const [route, input] of routes) {
    assert.equal((await h.call(`9${route}`, input, { anonymous: true })).status, 401);
    assert.equal((await h.call(`9${route}`, input, { viewer: true })).status, 403);
    assert.equal((await h.call(`8${route}`, input)).status, 403);
    assert.equal((await h.call(`9${route}`, input, { headers: { "x-csrf-token": "wrong" } })).status, 403);
    assert.equal(
      (await h.call(`9${route}`, input, { headers: { origin: "https://foreign.example.test" } })).status,
      403,
    );
    assert.equal((await h.call(`9${route}`, undefined)).status, 405);
    assert.equal((await h.call(`9${route}`, { ...input, repositoryId: 8 })).status, 400);
    assert.equal((await h.call(`9${route}`, { ...input, operatorId: "8" })).status, 400);
  }
  assert.equal((await h.call("9/replay-window", { ...commit, confirmed: false })).status, 400);
  assert.equal((await h.call("9/replay-window/preview", { ...window, confirmed: true })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await h.call("9/replay-window/preview", window)).status, 200);
  assert.deepEqual(calls[0], { repositoryId: 9, ...window });
  assert.equal((await h.call("9/replay-window", commit)).status, 201);
  assert.deepEqual(calls[1], {
    repositoryId: 9,
    ...window,
    expectedRevision: commit.expectedRevision,
    reason: commit.reason,
    operatorId: "7",
  });
  const unavailable = await harness(t, {
    operations: {},
    authorizeRepository: async () => ({ allowed: true, policyVersion: "test-1", revision: "grant-1" }),
  });
  for (const [route, input] of routes) assert.equal((await unavailable.call(`9${route}`, input)).status, 503);
});

test("real HTTP window preview is read-only; stale and changed authority cannot commit partial or duplicate replay", async (t) => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { OperatorInbox } = await import("../../../packages/ingestion/dist/operator.js");
  const engine = new PGlite();
  t.after(() => engine.close());
  for (const file of [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "007_operator_replay_results",
  ])
    await engine.exec(
      await readFile(new URL(`../../../packages/ingestion/sql/${file}.up.sql`, import.meta.url), "utf8"),
    );
  let allowed = true,
    revokeOnWrite = false;
  const db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) =>
      engine.transaction((tx) =>
        work({
          query: async (sql, params) => {
            const result = await tx.query(sql, params);
            if (revokeOnWrite && sql.includes("UPDATE leaderboard_ingestion.inbox")) allowed = false;
            return result;
          },
        }),
      ),
  };
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(9,1,'public')",
  );
  const id = (n) => `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
  const insert = (n, repositoryId = 9, receivedAt = window.receivedSince, installationId = 1) =>
    db.query(
      "INSERT INTO leaderboard_ingestion.inbox(delivery_id,body_hash,envelope,state,attempts,reason_code,received_at) VALUES($1,$2,$3::jsonb,'quarantined',3,'source_unavailable',$4)",
      [
        id(n),
        "a".repeat(64),
        JSON.stringify({ repositoryId, installationId, subjectId: "private-synthetic-subject" }),
        receivedAt,
      ],
    );
  await insert(1);
  await insert(2, 9, "2026-10-01T23:59:59.999Z");
  await insert(3, 9, window.receivedUntil);
  await insert(4, 8);
  await insert(5, 9, window.receivedSince, 2);
  const h = await harness(t, {
    operations: new OperatorInbox(db),
    authorizeRepository: async ({ repositoryId }) => ({
      allowed: allowed && repositoryId === 9,
      policyVersion: "test-1",
      revision: "grant-1",
    }),
  });
  const receipts = async () => (await db.query("SELECT * FROM leaderboard_ingestion.replay_receipts")).rows;
  const preview = await h.call("9/replay-window/preview", window);
  assert.equal(preview.status, 200);
  assert.deepEqual(
    preview.data.deliveries.map((row) => row.deliveryId),
    [id(1), id(2)],
  );
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(preview.data).includes("private-synthetic-subject"), false);
  assert.deepEqual(await receipts(), []);
  assert.equal((await h.call("9/replay-window/preview", { ...window, limit: 1 })).status, 409);
  assert.equal((await h.call("9/replay-window/preview", { ...window, policyVersion: "foreign-policy" })).status, 409);
  assert.equal(
    (await h.call("9/replay-window/preview", { ...window, receivedUntil: "2026-11-02T00:00:00.000Z" })).status,
    409,
  );
  const empty = await h.call("9/replay-window/preview", {
    ...window,
    receivedSince: "2026-09-01T00:00:00.000Z",
    receivedUntil: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.deliveries, []);
  const emptyWindow = { ...empty.data.window };
  delete emptyWindow.repositoryId;
  assert.equal(
    (await h.call("9/replay-window", { ...commit, ...emptyWindow, expectedRevision: empty.data.revision })).status,
    409,
  );
  await insert(6);
  assert.equal((await h.call("9/replay-window", { ...commit, expectedRevision: preview.data.revision })).status, 409);
  assert.deepEqual(await receipts(), []);
  const fresh = await h.call("9/replay-window/preview", window);
  const input = { ...commit, expectedRevision: fresh.data.revision };
  const queued = await h.call("9/replay-window", input);
  assert.equal(queued.status, 201);
  assert.equal(queued.data.status, "queued");
  assert.equal(queued.data.resultingPublicationRevision, null);
  assert.deepEqual(
    queued.data.receipts.map((row) => row.deliveryId),
    [id(1), id(6), id(2)],
  );
  assert.equal((await h.call("9/replay-window", input)).status, 409);
  assert.equal((await receipts()).length, 3);
  const states = (
    await db.query("SELECT delivery_id,state,attempts FROM leaderboard_ingestion.inbox ORDER BY delivery_id")
  ).rows;
  for (const row of states) {
    const changed = [id(1), id(2), id(6)].includes(row.delivery_id);
    assert.equal(row.state, changed ? "pending" : "quarantined");
    assert.equal(row.attempts, changed ? 0 : 3);
  }
  const read = await h.call("9");
  assert.equal(read.status, 200);
  assert.equal(read.data.receipts.length, 3);
  for (const receipt of read.data.receipts) {
    assert.equal(receipt.operatorId, "7");
    assert.equal(receipt.batch.id, queued.data.id);
    assert.equal(receipt.batch.size, 3);
    assert.equal(receipt.batch.selectionRevision, fresh.data.revision);
    assert.deepEqual(receipt.batch.window, { repositoryId: 9, ...window });
    assert.equal(receipt.resultingPublicationRevision, null);
  }
  assert.equal(JSON.stringify(read.data).includes("private-synthetic-subject"), false);
  await insert(7);
  await insert(8);
  const revokePreview = await h.call("9/replay-window/preview", window);
  revokeOnWrite = true;
  assert.equal(
    (await h.call("9/replay-window", { ...commit, expectedRevision: revokePreview.data.revision })).status,
    403,
  );
  assert.equal((await receipts()).length, 3);
  assert.deepEqual(
    (await db.query("SELECT state,attempts FROM leaderboard_ingestion.inbox WHERE delivery_id=$1", [id(7)])).rows[0],
    { state: "quarantined", attempts: 3 },
  );
});

test("both window responses are withheld after session, grant or authority revision changes", async (t) => {
  for (const [route, input] of routes) {
    for (const change of ["session", "grant", "revision"]) {
      await t.test(`${route} ${change}`, async (t) => {
        let h,
          allowed = true,
          revision = "grant-1";
        const run = async (_input, authorize) => {
          await authorize(9);
          if (change === "session") h.expire();
          if (change === "grant") allowed = false;
          if (change === "revision") revision = "grant-2";
          return { diagnostic: "restricted-synthetic-diagnostic" };
        };
        h = await harness(t, {
          operations: { previewReplayWindow: run, replayWindow: run },
          authorizeRepository: async () => ({ allowed, policyVersion: "test-1", revision }),
        });
        const response = await h.call(`9${route}`, input);
        assert.equal(response.status, { session: 401, grant: 403, revision: 409 }[change]);
        assert.equal(JSON.stringify(response.data).includes("restricted-synthetic-diagnostic"), false);
      });
    }
  }
});
