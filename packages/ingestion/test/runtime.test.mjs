import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createIngestionServer, runWorker } from "../dist/index.js";

const secret = "synthetic-runtime-test-secret-with-32-characters";
const payload = JSON.stringify({
  action: "reopened",
  installation: { id: 1 },
  repository: { id: 2, private: false, visibility: "public", full_name: "synthetic-org/synthetic-repo" },
  sender: null,
  issue: { node_id: "SYNTHETIC_ISSUE", number: 3, body: "unretained" },
});
function headers(body = payload) {
  return {
    "content-type": "application/json",
    "x-github-event": "issues",
    "x-github-delivery": "00000000-0000-4000-8000-000000000001",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}
async function listening(t, options = {}) {
  const receipts = [];
  const server = createIngestionServer({
    secrets: [secret],
    scope: new Map([[1, new Set([2])]]),
    store: {
      insert: async (delivery) => {
        receipts.push(delivery);
        return "accepted";
      },
    },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, server, receipts };
}
function send(url, options = {}, write = (req) => req.end(payload)) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: headers(), ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    write(req);
  });
}

test("real HTTP socket preserves signed bytes and returns a minimized durable receipt", async (t) => {
  const { url, receipts } = await listening(t);
  assert.deepEqual(await send(`${url}/webhooks/github`), { status: 202, body: { status: "accepted" } });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].envelope.occurredAt, null);
  assert.doesNotMatch(JSON.stringify(receipts), /unretained/);
  assert.equal(
    (await send(`${url}/webhooks/github`, { headers: { ...headers(), "x-hub-signature-256": "sha256=bad" } })).status,
    401,
  );
  assert.equal(receipts.length, 1);
});

test("strict routing, methods, duplicate security headers and readiness semantics", async (t) => {
  const { url, receipts } = await listening(t);
  assert.equal((await send(`${url}/webhooks/github?unexpected=1`)).status, 404);
  assert.equal((await send(`${url}/webhooks/github`, { method: "GET" }, (req) => req.end())).status, 405);
  assert.deepEqual(await send(`${url}/healthz`, { method: "GET" }, (req) => req.end()), {
    status: 200,
    body: { status: "alive" },
  });
  assert.equal(
    (await send(`${url}/webhooks/github`, { headers: { ...headers(), "x-github-event": ["issues", "push"] } })).status,
    400,
  );
  assert.equal(receipts.length, 0);
});

test("declared and chunked oversized bodies are bounded before storage", async (t) => {
  const { url, receipts } = await listening(t, { maxBodyBytes: 10 });
  assert.equal(
    (await send(`${url}/webhooks/github`, { headers: { ...headers(), "content-length": Buffer.byteLength(payload) } }))
      .status,
    413,
  );
  assert.equal(
    (
      await send(`${url}/webhooks/github`, {}, (req) => {
        req.write("123456");
        req.end("78901");
      })
    ).status,
    413,
  );
  assert.equal(receipts.length, 0);
});

test("slow body expires and releases capacity for fresh useful intake", async (t) => {
  const { url, receipts } = await listening(t, { bodyTimeoutMs: 100, maxConcurrentRequests: 1 });
  const slow = send(`${url}/webhooks/github`, {}, (req) => {
    req.flushHeaders();
    req.write("{");
  });
  assert.equal((await slow).status, 408);
  assert.equal((await send(`${url}/webhooks/github`)).status, 202);
  assert.equal(receipts.length, 1);
});

test("in-flight storage consumes a slot; overload never acknowledges or stores a second delivery", async (t) => {
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { url } = await listening(t, {
    maxConcurrentRequests: 1,
    store: {
      insert: async () => {
        calls++;
        enter();
        await gate;
        return "accepted";
      },
    },
  });
  const first = send(`${url}/webhooks/github`);
  await entered;
  assert.equal((await send(`${url}/webhooks/github`)).status, 503);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 202);
});

const lease = {
  deliveryId: "synthetic-delivery",
  token: "synthetic-token",
  envelope: {},
  receivedAt: new Date(0),
  attempt: 1,
};
test("worker completes in-flight lease on shutdown and emits fixed status codes", async () => {
  const control = new AbortController();
  const states = [];
  let completed = 0;
  await runWorker(
    {
      claim: async () => {
        control.abort();
        return lease;
      },
      complete: async (current) => {
        assert.equal(current, lease);
        completed++;
        return true;
      },
      fail: async () => assert.fail("must not fail"),
    },
    { signal: control.signal, onStatus: (state) => states.push(state) },
  );
  assert.equal(completed, 1);
  assert.deepEqual(states, ["processed"]);
});

test("worker outage and normalization failures back off and recover without stale lease reuse", async () => {
  const control = new AbortController();
  const states = [];
  let claims = 0,
    completions = 0,
    failures = 0;
  await runWorker(
    {
      claim: async () => {
        if (++claims === 1) throw new Error("synthetic-sensitive-database-message");
        return lease;
      },
      complete: async () => {
        if (++completions === 1) throw new Error("synthetic-sensitive-source");
        return true;
      },
      fail: async (current, reason) => {
        assert.equal(current, lease);
        assert.equal(reason, "normalization_failed");
        failures++;
        return true;
      },
    },
    {
      signal: control.signal,
      idleMs: 1,
      failureBackoffMs: 1,
      onStatus: (state) => {
        states.push(state);
        if (state === "processed") control.abort();
      },
    },
  );
  assert.equal(claims, 3);
  assert.equal(failures, 1);
  assert.deepEqual(states, ["store_unavailable", "retry_scheduled", "processed"]);
});

test("worker idle abort is prompt and observer exceptions cannot turn completion into failure", async () => {
  const idle = new AbortController();
  await runWorker(
    { claim: async () => null, complete: async () => assert.fail(), fail: async () => assert.fail() },
    { signal: idle.signal, onStatus: () => idle.abort() },
  );
  const complete = new AbortController();
  await runWorker(
    { claim: async () => lease, complete: async () => true, fail: async () => assert.fail() },
    {
      signal: complete.signal,
      onStatus: () => {
        complete.abort();
        throw new Error("synthetic-observer-failure");
      },
    },
  );
});
