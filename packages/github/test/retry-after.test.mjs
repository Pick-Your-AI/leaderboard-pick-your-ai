import assert from "node:assert/strict";
import test from "node:test";
import { classifyGithubFailure, GithubReadClient } from "../dist/index.js";

const start = Date.parse("2026-01-01T00:00:00Z");
const classify = (value, extra = {}) =>
  classifyGithubFailure({
    status: 429,
    headers: new Map([["retry-after", value]]),
    now: new Date(start),
    ...extra,
  });

for (const value of ["-1", "+1", "1.5", "1e1", "0x10", "", " ", "12, 24", "Infinity", "1e300"])
  test(`invalid delay ${JSON.stringify(value)} retains the secondary fallback`, () => {
    assert.equal(classify(value).retryAt, "2026-01-01T00:01:00.000Z");
    assert.equal(classify(value, { status: 403 }).kind, "permission_denied");
  });

for (const value of [
  "2026-01-01T00:00:01Z",
  "January 1, 2026",
  "Thu, 01 Jan 2026 00:00:01",
  "Thu, 01 Jan 2026 00:00:01 EST",
  "Thu, 31 Feb 2026 00:00:01 GMT",
  "Thu, 01 Jan 2026 24:00:00 GMT",
  "Thu, 01 Jan 2026 00:60:00 GMT",
])
  test(`non-HTTP or impossible date ${JSON.stringify(value)} retains the fallback`, () => {
    assert.equal(classify(value).retryAt, "2026-01-01T00:01:00.000Z");
  });

test("decimal seconds retain zero, leading zeros and their exact supplied delay", () => {
  for (const [value, delay] of [
    ["0", 0],
    ["12", 12000],
    ["0012", 12000],
    ["86400", 86400000],
  ])
    assert.equal(Date.parse(classify(value).retryAt) - start, delay);
});

test("all three HTTP date formats represent UTC independently of the local timezone", () => {
  for (const value of ["Thu, 01 Jan 2026 00:02:00 GMT", "Thursday, 01-Jan-26 00:02:00 GMT", "Thu Jan  1 00:02:00 2026"])
    assert.equal(classify(value).retryAt, "2026-01-01T00:02:00.000Z", value);
});

test("obsolete two-digit years use the HTTP rolling fifty-year interpretation", () => {
  assert.equal(classify("Tuesday, 01-Jan-75 00:00:00 GMT").retryAt, "2075-01-01T00:00:00.000Z");
  assert.equal(classify("Saturday, 01-Jan-77 00:00:00 GMT").retryAt, "1977-01-01T00:00:00.000Z");
});

test("HTTP leap seconds round forward instead of retrying before the supplied instant", () => {
  assert.equal(classify("Sat, 31 Dec 2016 23:59:60 GMT").retryAt, "2017-01-01T00:00:00.000Z");
});

test("a malformed Retry-After retains a separately verified exhausted primary reset", () => {
  const headers = new Headers({
    "retry-after": "-1",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String((start + 120000) / 1000),
  });
  assert.equal(classify("unused", { headers }).retryAt, "2026-01-01T00:02:00.000Z");
});

class MemoryStore {
  values = new Map();
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

test("invalid retry delay persists the source pause across clients while another source proceeds", async () => {
  let now = start;
  const checkpoints = new MemoryStore();
  const calls = [];
  const waits = [];
  const options = {
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "",
    checkpoints,
    concurrency: 1,
    maxRetries: 0,
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
  const first = new GithubReadClient({
    ...options,
    fetch: async (url) => {
      calls.push({ url, at: now });
      return new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 429,
        headers: { "retry-after": "-1" },
      });
    },
  });
  await assert.rejects(first.rest("installation:limited", "/limited"), (error) => {
    assert.equal(error.outcome.kind, "rate_limited");
    return true;
  });
  const restarted = new GithubReadClient({
    ...options,
    fetch: async (url) => {
      calls.push({ url, at: now });
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  assert.deepEqual(await restarted.rest("installation:other", "/other"), { ok: true });
  assert.equal(calls[1].at, start);
  assert.deepEqual(waits, []);
  assert.deepEqual(await restarted.rest("installation:limited", "/limited"), { ok: true });
  assert.deepEqual(waits, [60000]);
  assert.equal(calls[2].at, start + 60000);
});
