import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { FileCheckpointStore, GithubReadClient, GithubClientError } from "../dist/index.js";

const ORIGIN = "https://api.synthetic.invalid";
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
const create = (fetch, options = {}) =>
  new GithubReadClient({
    apiOrigin: ORIGIN,
    token: async () => "synthetic-token",
    checkpoints: new MemoryStore(),
    fetch,
    random: () => 0,
    ...options,
  });
const scan = {
  source: "installation:a",
  key: "issues-v1",
  url: "/issues?per_page=100",
  maxPages: 5,
  select: (body) => body,
};
const query =
  "query Reviews($id: ID!, $first: Int!, $after: String) { node(id: $id) { ... on PullRequest { reviews(first: $first, after: $after) { nodes { id } pageInfo { endCursor hasNextPage } } } } }";

test("REST retrieves >100 items and conditional refresh retains cached pagination on 304", async () => {
  const calls = [];
  const client = create(async (url, request) => {
    calls.push({ url, request });
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-token");
    assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
    if (request.headers.get("if-none-match")) return new Response(null, { status: 304 });
    const second = url.endsWith("page=2");
    return json(
      Array.from({ length: second ? 23 : 100 }, (_, i) => (second ? 100 : 0) + i),
      200,
      { etag: second ? '"page2"' : '"page1"', ...(second ? {} : { link: `<${ORIGIN}/issues?page=2>; rel="next"` }) },
    );
  });
  const first = await client.scanRest(scan);
  assert.deepEqual(
    first,
    Array.from({ length: 123 }, (_, i) => i),
  );
  assert.deepEqual(await client.scanRest({ ...scan, refresh: true }), first);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].request.headers.get("if-none-match"), '"page1"');
  assert.equal(calls[3].request.headers.get("if-none-match"), '"page2"');
});

test("durable checkpoint resumes failed scan in another client without replaying prior pages", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-checkpoints-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^github-checkpoints-/);
    await rm(directory, { recursive: true, force: true });
  });
  const checkpoints = new FileCheckpointStore(directory);
  const calls = [];
  const first = create(
    async (url) => {
      calls.push(url);
      return url.endsWith("page=2")
        ? json({ message: "synthetic failure" }, 503)
        : json([1, 2], 200, { link: `<${ORIGIN}/issues?page=2>; rel=next` });
    },
    { checkpoints, maxRetries: 0 },
  );
  await assert.rejects(first.scanRest(scan), (error) => error.outcome.kind === "transient_failure");
  const resumed = create(
    async (url) => {
      calls.push(url);
      return json([3]);
    },
    {
      checkpoints: new FileCheckpointStore(directory),
      maxRetries: 0,
    },
  );
  assert.deepEqual(await resumed.scanRest(scan), [1, 2, 3]);
  assert.equal(calls.filter((url) => url.includes("per_page=100")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("page=2")).length, 2);
  assert.deepEqual(await resumed.scanRest(scan), [1, 2, 3]);
  assert.equal(calls.length, 3);
  const persisted = (
    await Promise.all((await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")))
  ).join("");
  assert.equal(persisted.includes("synthetic-token"), false);
});

test("nested GraphQL reviews have independent parent cursors and retrieve every child page", async () => {
  const calls = [];
  const client = create(async (url, request) => {
    assert.equal(url, `${ORIGIN}/graphql`);
    assert.equal(request.method, "POST");
    const { variables } = JSON.parse(request.body);
    calls.push(variables);
    const second = variables.after !== null;
    return json({
      data: {
        node: {
          reviews: {
            nodes: Array.from({ length: second ? 11 : 100 }, (_, i) => `${variables.id}:${second ? i + 100 : i}`),
            pageInfo: { hasNextPage: !second, endCursor: second ? null : `${variables.id}:next` },
          },
        },
      },
    });
  });
  const result = await client.scanNestedGraphql(["pr:a", "pr:b"], (id) => ({
    source: "installation:a",
    key: `reviews:${id}`,
    query,
    variables: { id },
    maxPages: 4,
    select: (data) => data.node.reviews,
  }));
  assert.deepEqual(
    result.map((item) => item.items.length),
    [111, 111],
  );
  assert.equal(calls.length, 4);
  for (const id of ["pr:a", "pr:b"]) {
    assert.deepEqual(
      calls.filter((call) => call.id === id).map((call) => call.after),
      [null, `${id}:next`],
    );
  }
});

test("source-scoped secondary limit yields its slot, honors retry-after+jitter, and resumes", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let wake;
  let sleeping;
  const sleepingStarted = new Promise((resolve) => {
    sleeping = resolve;
  });
  const calls = [];
  const client = create(
    async (url) => {
      calls.push({ url, at: now });
      if (url.endsWith("/a") && calls.filter((call) => call.url.endsWith("/a")).length === 1) {
        return json({ message: "secondary rate limit" }, 403, { "retry-after": "12" });
      }
      return json({ ok: true });
    },
    {
      concurrency: 1,
      now: () => now,
      random: () => 0.5,
      sleep: (ms) =>
        new Promise((resolve) => {
          wake = () => {
            now += ms;
            resolve();
          };
          sleeping(ms);
        }),
    },
  );
  const a = client.rest("installation:a", "/a");
  assert.equal(await sleepingStarted, 12_500);
  assert.deepEqual(await client.rest("installation:b", "/b"), { ok: true });
  assert.equal(calls.length, 2);
  wake();
  assert.deepEqual(await a, { ok: true });
  assert.equal(calls[2].at - calls[0].at, 12_500);
});

test("primary reset and GraphQL RATE_LIMITED errors obey bounded retries with fake time", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const waits = [];
  let count = 0;
  const client = create(
    async () => {
      count++;
      if (count === 1)
        return json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((now + 5_000) / 1000),
        });
      if (count === 2) return json({ data: null, errors: [{ type: "RATE_LIMITED" }] });
      return json({ data: { ok: true } });
    },
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  );
  assert.deepEqual(await client.graphql("installation:a", "query { viewer { login } }"), { ok: true });
  assert.deepEqual(waits, [5000, 60000]);
});

test("concurrency bound applies across REST and GraphQL requests", async () => {
  let active = 0;
  let maximum = 0;
  const pending = [];
  const client = create(
    async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => pending.push(resolve));
      active--;
      return json({ data: { ok: true } });
    },
    { concurrency: 2 },
  );
  const work = [client.rest("a", "/a"), client.graphql("b", "{ viewer { login } }"), client.rest("c", "/c")];
  for (let i = 0; i < 3; i++) {
    while (!pending.length) await new Promise((resolve) => setImmediate(resolve));
    pending.shift()();
  }
  await Promise.all(work);
  assert.equal(maximum, 2);
});

test("authorization, hidden resources and transient failure stay distinct without leaking payloads", async () => {
  for (const [status, kind] of [
    [401, "authentication_required"],
    [403, "permission_denied"],
    [404, "not_found_or_hidden"],
    [503, "transient_failure"],
  ]) {
    let calls = 0;
    const client = create(
      async () => {
        calls++;
        return json({ message: "private source payload" }, status);
      },
      { maxRetries: 0 },
    );
    await assert.rejects(client.rest("a", "/private"), (error) => {
      assert.ok(error instanceof GithubClientError);
      assert.equal(error.outcome.kind, kind);
      assert.equal(error.outcome.visibility, "unknown");
      assert.equal(error.message.includes("private source payload"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("read transport rejects mutation documents, credential URLs, cross-origin links and redirects", async () => {
  let calls = 0;
  const client = create(async () => {
    calls++;
    return json([]);
  });
  for (const query of [
    "mutation { createIssue(input: {}) { clientMutationId } }",
    "query { viewer { id } } mutation X { deleteIssue(input: {}) { clientMutationId } }",
    "subscription { x }",
  ]) {
    await assert.rejects(client.graphql("a", query), (error) => error.outcome.kind === "unsafe_request");
  }
  for (const url of [
    "https://attacker.invalid/items",
    "http://api.synthetic.invalid/items",
    "https://secret@api.synthetic.invalid/items",
    "/items#fragment",
  ]) {
    await assert.rejects(client.rest("a", url), (error) => error.outcome.kind === "unsafe_request");
  }
  assert.equal(calls, 0);
  const redirected = create(
    async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
  );
  await assert.rejects(redirected.rest("a", "/items"), (error) => error.outcome.kind === "unsafe_request");
  const linked = create(async () => json([1], 200, { link: '<https://attacker.invalid/steal>; rel="next"' }));
  await assert.rejects(linked.scanRest(scan), (error) => error.outcome.kind === "unsafe_request");
});

test("partial GraphQL data never completes a checkpoint and malformed pagination fails closed", async () => {
  const checkpoints = new MemoryStore();
  const client = create(
    async () =>
      json({
        data: { node: { reviews: { nodes: [1], pageInfo: { hasNextPage: false, endCursor: null } } } },
        errors: [{ message: "resource limit" }],
      }),
    { checkpoints },
  );
  await assert.rejects(
    client.scanGraphql({ source: "a", key: "reviews", query, maxPages: 2, select: (data) => data.node.reviews }),
    (error) => error.outcome.kind === "invalid_response",
  );
  assert.equal(checkpoints.values.size, 0);
  const malformed = create(async () =>
    json({ data: { nodes: [1], pageInfo: { hasNextPage: true, endCursor: null } } }),
  );
  await assert.rejects(
    malformed.scanGraphql({ source: "a", key: "reviews", query, maxPages: 2, select: (data) => data }),
    (error) => error.outcome.kind === "invalid_response",
  );
});

test("page bounds preserve progress and changed query identity rejects stale checkpoints", async () => {
  const checkpoints = new MemoryStore();
  const client = create(async (url) => json([url], 200, { link: `<${ORIGIN}/issues?page=2>; rel=next` }), {
    checkpoints,
  });
  await assert.rejects(client.scanRest({ ...scan, maxPages: 1 }), /maxPages/);
  await assert.rejects(
    client.scanRest({ ...scan, url: "/changed" }),
    (error) => error.outcome.kind === "invalid_checkpoint",
  );
  await assert.rejects(client.scanRest(scan), /repeated a page/);
});

test("rate-limit pause survives a new client and does not delay another source", async () => {
  const checkpoints = new MemoryStore();
  let now = Date.parse("2026-01-01T00:00:00Z");
  const exhausted = create(async () => json({ message: "rate limit" }, 429, { "retry-after": "30" }), {
    checkpoints,
    maxRetries: 0,
    now: () => now,
  });
  await assert.rejects(exhausted.rest("installation:a", "/a"), (error) => error.outcome.kind === "rate_limited");
  const waits = [];
  const resumed = create(async () => json({ ok: true }), {
    checkpoints,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  await resumed.rest("installation:b", "/b");
  assert.deepEqual(waits, []);
  await resumed.rest("installation:a", "/a");
  assert.deepEqual(waits, [30_000]);
});

test("HTTP status classification survives empty/non-JSON error responses", async () => {
  for (const [status, kind] of [
    [401, "authentication_required"],
    [404, "not_found_or_hidden"],
    [502, "transient_failure"],
  ]) {
    const client = create(async () => new Response("synthetic gateway", { status }), { maxRetries: 0 });
    await assert.rejects(client.rest("a", "/a"), (error) => error.outcome.kind === kind);
  }
});

test("GraphQL HTTP 200 permission and missing errors retain authorization distinctions", async () => {
  for (const [type, kind] of [
    ["FORBIDDEN", "permission_denied"],
    ["NOT_FOUND", "not_found_or_hidden"],
    ["UNAUTHENTICATED", "authentication_required"],
  ]) {
    const client = create(async () => json({ data: null, errors: [{ type }] }));
    await assert.rejects(client.graphql("a", "{ viewer { id } }"), (error) => error.outcome.kind === kind);
  }
});

test("transport retries transient network failures within its bound and redacts raw errors", async () => {
  let calls = 0;
  let now = Date.parse("2026-01-01T00:00:00Z");
  const waits = [];
  const client = create(
    async () => {
      calls++;
      throw new Error("private token=synthetic-token");
    },
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      maxRetries: 2,
    },
  );
  await assert.rejects(client.rest("a", "/a"), (error) => {
    assert.equal(error.message, "GitHub source request failed: transient_failure");
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("corrupt state, unsafe persisted URLs and duplicate active scans fail closed", async () => {
  const corrupt = create(
    async () => {
      throw new Error("must not request");
    },
    {
      checkpoints: { load: async () => ({ version: 999 }), save: async () => {} },
    },
  );
  await assert.rejects(corrupt.scanRest(scan), (error) => error.outcome.kind === "invalid_checkpoint");
  const checkpoints = new MemoryStore();
  const initial = create(async () => json([1], 200, { link: `<${ORIGIN}/issues?page=2>; rel=next` }), { checkpoints });
  await assert.rejects(initial.scanRest({ ...scan, maxPages: 1 }), /maxPages/);
  const scanKey = [...checkpoints.values.keys()].find((key) => key.startsWith("scan:"));
  checkpoints.values.get(scanKey).next = "https://attacker.invalid/steal";
  await assert.rejects(initial.scanRest(scan), (error) => error.outcome.kind === "unsafe_request");
  let release;
  const waiting = create(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return json([]);
  });
  const ongoing = waiting.scanRest(scan);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(waiting.scanRest(scan), /already running/);
  release();
  await ongoing;
});

test("oversized bodies and invalid successful JSON fail without completing a scan", async () => {
  for (const response of [() => json(["synthetic oversized body"]), () => new Response("invalid JSON")]) {
    const checkpoints = new MemoryStore();
    const client = create(async () => response(), { checkpoints, maxResponseBytes: 8 });
    await assert.rejects(client.scanRest(scan), (error) => error.outcome.kind === "invalid_response");
    assert.equal(checkpoints.values.size, 0);
  }
});

test("successful final quota unit pauses next request while retaining successful response", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const waits = [];
  let count = 0;
  const client = create(
    async () => {
      count++;
      return json(
        { count },
        200,
        count === 1 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 7000) / 1000) } : {},
      );
    },
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  );
  assert.deepEqual(await client.rest("a", "/a"), { count: 1 });
  assert.deepEqual(waits, []);
  await client.rest("a", "/a");
  assert.deepEqual(waits, [7000]);
});

test("conditional 304 quota exhaustion pauses the next request before reusing cached data", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const waits = [];
  let count = 0;
  const client = create(
    async () => {
      count++;
      if (count === 1) return json({ ok: true }, 200, { etag: '"synthetic-v1"' });
      return new Response(null, {
        status: 304,
        headers:
          count === 2
            ? {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String((now + 10_000) / 1000),
              }
            : {},
      });
    },
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  );
  assert.deepEqual(await client.rest("a", "/a"), { ok: true });
  assert.deepEqual(await client.rest("a", "/a"), { ok: true });
  assert.deepEqual(waits, []);
  assert.deepEqual(await client.rest("a", "/a"), { ok: true });
  assert.deepEqual(waits, [10_000]);
});
