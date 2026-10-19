import assert from "node:assert/strict";
import test from "node:test";
import { GithubReadClient } from "../dist/index.js";

const ORIGIN = "https://api.synthetic.invalid";
const SOURCE = "installation:a";
const START = Date.parse("2026-01-01T00:00:00.000Z");
const query = "query { viewer { id } }";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

class MemoryStore {
  values = new Map();
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

const delayedRead = (client, kind) =>
  kind === "REST" ? client.rest(SOURCE, "/delayed") : client.graphql(SOURCE, query);
const successfulBody = (kind) => (kind === "REST" ? { ok: true } : { data: { ok: true } });

for (const kind of ["REST", "GraphQL"]) {
  for (const limit of ["primary", "secondary"]) {
    test(kind + " observes a sibling " + limit + " pause established during token resolution", async () => {
      let now = START;
      let firstToken = true;
      let releaseSleep;
      const tokenEntered = Promise.withResolvers();
      const tokenRelease = Promise.withResolvers();
      const sleepEntered = Promise.withResolvers();
      const requests = [];
      const checkpoints = new MemoryStore();
      const waitMs = limit === "primary" ? 60_000 : 12_000;
      const client = new GithubReadClient({
        apiOrigin: ORIGIN,
        checkpoints,
        concurrency: 2,
        maxRetries: 0,
        now: () => now,
        random: () => 0,
        token: async () => {
          if (firstToken) {
            firstToken = false;
            tokenEntered.resolve();
            await tokenRelease.promise;
          }
          return "synthetic-token";
        },
        sleep: (ms) =>
          new Promise((resolve) => {
            releaseSleep = () => {
              releaseSleep = undefined;
              now += ms;
              resolve();
            };
            sleepEntered.resolve(ms);
          }),
        fetch: async (url) => {
          const path = new URL(url).pathname;
          requests.push({ path, at: now });
          if (path === "/exhaust") {
            return limit === "primary"
              ? json({ ok: true }, 200, {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": String((START + waitMs) / 1000),
                })
              : json({ message: "secondary rate limit" }, 403, { "retry-after": "12" });
          }
          return json(path === "/unrelated" ? { unrelated: true } : successfulBody(kind));
        },
      });

      const delayed = delayedRead(client, kind);
      try {
        await tokenEntered.promise;
        if (limit === "primary") {
          assert.deepEqual(await client.rest(SOURCE, "/exhaust"), { ok: true });
        } else {
          await assert.rejects(client.rest(SOURCE, "/exhaust"), (error) => error.outcome.kind === "rate_limited");
        }
        const pause = [...checkpoints.values.entries()].find(([key]) => key.startsWith("pause:"))[1];
        assert.equal(pause.until, START + waitMs);
        tokenRelease.resolve();
        const boundary = await Promise.race([
          sleepEntered.promise.then((ms) => ({ kind: "sleep", ms })),
          delayed.then(() => ({ kind: "dispatched" })),
        ]);
        assert.deepEqual(boundary, { kind: "sleep", ms: waitMs });
        assert.deepEqual(requests, [{ path: "/exhaust", at: START }]);
        assert.deepEqual(await client.rest("installation:b", "/unrelated"), { unrelated: true });
        assert.deepEqual(requests.at(-1), { path: "/unrelated", at: START });
        releaseSleep();
        assert.deepEqual(await delayed, { ok: true });
        assert.deepEqual(requests.at(-1), {
          path: kind === "REST" ? "/delayed" : "/graphql",
          at: START + waitMs,
        });
        assert.equal(requests.length, 3);
      } finally {
        tokenRelease.resolve();
        releaseSleep?.();
        await delayed.catch(() => undefined);
      }
    });
  }

  test(kind + " preserves its retry allowance when a known pause prevents dispatch", async () => {
    let now = START;
    let firstToken = true;
    let attempts = 0;
    const tokenEntered = Promise.withResolvers();
    const tokenRelease = Promise.withResolvers();
    const waits = [];
    const requestedAt = [];
    const client = new GithubReadClient({
      apiOrigin: ORIGIN,
      checkpoints: new MemoryStore(),
      concurrency: 2,
      maxRetries: 1,
      now: () => now,
      random: () => 0,
      token: async () => {
        if (firstToken) {
          firstToken = false;
          tokenEntered.resolve();
          await tokenRelease.promise;
        }
        return "synthetic-token";
      },
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      fetch: async (url) => {
        if (url.endsWith("/exhaust")) {
          return json({ ok: true }, 200, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((START + 60_000) / 1000),
          });
        }
        requestedAt.push(now);
        attempts += 1;
        return attempts === 1 ? json({ message: "synthetic outage" }, 503) : json(successfulBody(kind));
      },
    });
    const delayed = delayedRead(client, kind);
    try {
      await tokenEntered.promise;
      await client.rest(SOURCE, "/exhaust");
      tokenRelease.resolve();
      assert.deepEqual(await delayed, { ok: true });
      assert.equal(attempts, 2);
      assert.deepEqual(waits, [60_000, 1_000]);
      assert.deepEqual(requestedAt, [START + 60_000, START + 61_000]);
    } finally {
      tokenRelease.resolve();
      await delayed.catch(() => undefined);
    }
  });
}
