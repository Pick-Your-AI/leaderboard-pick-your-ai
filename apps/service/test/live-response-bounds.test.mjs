import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { startLiveUpdates } from "../dist/live-client.js";

const health = {
  snapshotId: "bounded-public-1",
  revision: 1,
  policyVersion: "bounded-policy-1",
  status: "recently_reconciled",
};
const until = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("live transport did not settle");
};
const observe = (t, fetcher, extra = {}) => {
  const states = [],
    notices = [];
  const stop = startLiveUpdates({
    intervalMs: 30000,
    onState: (value) => states.push(value),
    onSnapshot: (value) => notices.push(value),
    fetch: fetcher,
    ...extra,
  });
  t.after(stop);
  return { states, notices, stop };
};

test("health polling rejects redirects and omits credentials before requesting a snapshot", async (t) => {
  let followed = 0,
    credentials;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/health") {
      response.writeHead(302, { Location: "/redirected-health" });
      response.end();
    } else {
      followed++;
      response.end(JSON.stringify(health));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = observe(t, async (url, init) => {
    credentials = init.credentials;
    return fetch(new URL(url, origin), init);
  });
  await until(() => result.states.at(-1)?.transport === "unavailable" || result.notices.length);
  assert.equal(credentials, "omit");
  assert.equal(followed, 0, "the transport must never request the redirect target");
  assert.equal(result.notices.length, 0);
  assert.equal(result.states.at(-1).freshness, "unknown");
});

test("an advertised oversized health response is cancelled before any body is read", async (t) => {
  let reads = 0,
    cancelled = false;
  const body = new ReadableStream(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(health)));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = observe(
    t,
    async () => new Response(body, { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } }),
  );
  await until(() => result.states.at(-1)?.transport === "unavailable" || result.notices.length);
  assert.equal(result.notices.length, 0);
  assert.equal(reads, 0);
  assert.equal(cancelled, true);
  assert.equal(result.states.at(-1).freshness, "unknown");
});

for (const advertised of [null, "64"]) {
  test(`decoded health bytes are bounded when Content-Length is ${advertised ?? "absent"}`, async (t) => {
    let reads = 0,
      cancelled = false;
    const prefix = JSON.stringify(health).slice(0, -1) + ',"padding":"';
    const body = new ReadableStream(
      {
        pull(controller) {
          reads++;
          if (reads === 1) controller.enqueue(new TextEncoder().encode(prefix));
          else if (reads <= 35) controller.enqueue(new Uint8Array(64 * 1024).fill(97));
          else {
            controller.enqueue(new TextEncoder().encode('"}'));
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = observe(
      t,
      async () => new Response(body, { headers: advertised === null ? {} : { "Content-Length": advertised } }),
    );
    await until(() => result.states.at(-1)?.transport === "unavailable" || result.notices.length);
    assert.equal(result.notices.length, 0);
    assert.equal(cancelled, true);
    assert.ok(reads < 36, "stop consuming before the oversized JSON body ends");
    assert.equal(result.states.at(-1).freshness, "unknown");
  });
}

test("a health response at the decoded limit still verifies a complete snapshot", async (t) => {
  const prefix = JSON.stringify(health).slice(0, -1) + ',"padding":"';
  const json = prefix + "a".repeat(2 * 1024 * 1024 - prefix.length - 2) + '"}';
  const result = observe(t, async () => new Response(json));
  await until(() => result.notices.length === 1);
  assert.equal(result.states.at(-1).freshness, "recently_reconciled");
  assert.equal(result.notices[0].snapshotId, health.snapshotId);
});

test("stopping during a body read cancels the reader without accepting late health", async (t) => {
  const reading = Promise.withResolvers();
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull() {
        reading.resolve();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = observe(t, async () => new Response(body));
  await reading.promise;
  result.stop();
  await until(() => cancelled);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.locked, false);
  assert.equal(result.notices.length, 0);
  assert.equal(
    result.states.some((state) => state.freshness === "recently_reconciled"),
    false,
  );
});

for (const padding of ["a".repeat(2 * 1024 * 1024), "€".repeat(800000)]) {
  test(`oversized ${padding[0] === "a" ? "ASCII" : "UTF-8"} stream notices close without accepting a new snapshot`, async (t) => {
    const listeners = new Map();
    let closed = false;
    const result = observe(t, async () => new Response(JSON.stringify(health)), {
      eventSource: () => ({
        close() {
          closed = true;
        },
        addEventListener: (name, listener) => listeners.set(name, listener),
      }),
    });
    await until(() => listeners.has("reset"));
    const oversized = JSON.stringify({ ...health, snapshotId: "oversized-public-2", revision: 2, padding });
    listeners.get("reset")({ data: oversized });
    assert.equal(closed, true);
    assert.equal(result.notices.length, 1);
    assert.equal(result.states.at(-1).transport, "polling");
  });
}
