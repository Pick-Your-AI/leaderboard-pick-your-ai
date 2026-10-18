import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { FileCheckpointStore, GithubReadClient } from "../dist/index.js";

const origin = "https://api.synthetic.invalid";
const source = "installation:synthetic-quota";
const instant = "2026-10-18T13:00:00.000Z";
const headers = {
  "x-ratelimit-resource": "core",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4000",
  "x-ratelimit-used": "1000",
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
const scan = { source, key: "synthetic-issues", url: "/issues", maxPages: 2, select: (body) => body };
const core = (diagnostics) => diagnostics.resources.find((row) => row.resource === "core");

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
    apiOrigin: origin,
    checkpoints: new MemoryStore(),
    token: async () => "synthetic-secret-token",
    now: () => Date.parse(instant),
    maxRetries: 0,
    random: () => 0,
    fetch,
    ...options,
  });

test("actual REST refresh observes current 304 quota headers while keeping the cached source representation", async () => {
  let requests = 0;
  let now = Date.parse(instant);
  const client = create(
    async (_url, request) => {
      requests += 1;
      if (request.headers.has("if-none-match"))
        return new Response(null, { status: 304, headers: { ...headers, "x-ratelimit-remaining": "4100" } });
      return json([1, 2], 200, { ...headers, etag: '"synthetic-v1"' });
    },
    { now: () => now },
  );
  assert.deepEqual(await client.scanRest(scan), [1, 2]);
  assert.equal(core(await client.readQuota(source)).observation.remaining, 4000);
  now += 1000;
  assert.deepEqual(await client.scanRest({ ...scan, refresh: true }), [1, 2]);
  assert.equal(requests, 2);
  assert.deepEqual(core(await client.readQuota(source)).observation, {
    observedAt: "2026-10-18T13:00:01.000Z",
    responseStatus: 304,
    limit: 5000,
    remaining: 4100,
    used: 1000,
    resetAt: null,
    retryAfterSeconds: null,
  });
});

test("diagnostic reads resolve neither tokens nor source requests and enforce the supplied host grant", async () => {
  const checkpoints = new MemoryStore();
  const writer = create(async () => json([1], 200, headers), { checkpoints });
  await writer.scanRest(scan);
  let tokens = 0;
  let requests = 0;
  const reader = create(
    async () => {
      requests += 1;
      throw new Error("unexpected transport");
    },
    {
      checkpoints,
      token: async () => {
        tokens += 1;
        throw new Error("unexpected token lookup");
      },
    },
  );
  let checks = 0;
  const diagnostics = await reader.readQuota(source, () => {
    checks += 1;
  });
  assert.equal(core(diagnostics).observation.remaining, 4000);
  assert.ok(checks >= 2);
  assert.equal(tokens, 0);
  assert.equal(requests, 0);
  await assert.rejects(
    reader.readQuota(source, () => {
      throw new Error("synthetic-secret");
    }),
    (error) => error.outcome.kind === "unsafe_request" && !error.message.includes("synthetic-secret"),
  );
  assert.equal(tokens, 0);
  assert.equal(requests, 0);
});

test("access revocation during quota checkpoint reads prevents final private diagnostic delivery", async () => {
  const checkpoints = new MemoryStore();
  const client = create(async () => json([1], 200, headers), { checkpoints });
  await client.scanRest(scan);
  let authorized = true;
  const load = checkpoints.load.bind(checkpoints);
  checkpoints.load = async (key) => {
    const result = await load(key);
    if (key.startsWith("quota:")) authorized = false;
    return result;
  };
  await assert.rejects(
    client.readQuota(source, () => {
      if (!authorized) throw new Error("synthetic-secret");
    }),
    (error) => error.outcome.kind === "unsafe_request" && !error.message.includes("synthetic-secret"),
  );
});

test("revocation while fetch awaits does not retain the returned quota or consume its source page", async () => {
  const checkpoints = new MemoryStore();
  let authorized = true;
  let selected = 0;
  const client = create(
    async () => {
      authorized = false;
      return json([1], 200, headers);
    },
    { checkpoints },
  );
  await assert.rejects(
    client.scanRest({
      ...scan,
      select: (body) => {
        selected += 1;
        return body;
      },
      assertAuthorized: () => {
        if (!authorized) throw new Error("synthetic-secret");
      },
    }),
    (error) => error.outcome.kind === "unsafe_request",
  );
  assert.equal(selected, 0);
  assert.equal(
    [...checkpoints.values.keys()].some((key) => key.startsWith("quota:")),
    false,
  );
});

test("a rejected redirect cannot inject quota metadata into the configured API pool", async () => {
  const checkpoints = new MemoryStore();
  const client = create(
    async () =>
      new Response(null, { status: 302, headers: { ...headers, location: "https://untrusted.synthetic.invalid/" } }),
    { checkpoints },
  );
  await assert.rejects(client.scanRest(scan), (error) => error.outcome.kind === "unsafe_request");
  assert.ok((await client.readQuota(source)).resources.every((row) => row.state === "unknown"));
  assert.equal(
    [...checkpoints.values.keys()].some((key) => key.startsWith("quota:")),
    false,
  );
});

test("actual HTTP permission failures retain only bounded observed headers without becoming a successful collection", async () => {
  const client = create(async () => json({ message: "synthetic-private-body" }, 403, headers));
  await assert.rejects(client.scanRest(scan), (error) => error.outcome.kind === "permission_denied");
  const diagnostics = await client.readQuota(source);
  assert.equal(core(diagnostics).observation.responseStatus, 403);
  assert.equal(core(diagnostics).observation.remaining, 4000);
  assert.equal(JSON.stringify(diagnostics).includes("synthetic-private-body"), false);
});

test("actual GraphQL rate-limit errors retain their transport status and separate GraphQL resource observation", async () => {
  const client = create(async () =>
    json({ errors: [{ type: "RATE_LIMITED", message: "synthetic-private-error" }] }, 200, {
      ...headers,
      "x-ratelimit-resource": "graphql",
      "x-ratelimit-remaining": "0",
      "retry-after": "60",
    }),
  );
  await assert.rejects(
    client.scanGraphql({
      source,
      key: "synthetic-query",
      query: "query { viewer { id } }",
      maxPages: 1,
      select: () => {
        throw new Error("unexpected source acceptance");
      },
    }),
    (error) => error.outcome.kind === "rate_limited",
  );
  const diagnostics = await client.readQuota(source);
  assert.equal(core(diagnostics).state, "unknown");
  const graphql = diagnostics.resources.find((row) => row.resource === "graphql");
  assert.equal(graphql.observation.responseStatus, 200);
  assert.equal(graphql.observation.remaining, 0);
  assert.equal(graphql.observation.retryAfterSeconds, 60);
  assert.equal(JSON.stringify(diagnostics).includes("synthetic-private-error"), false);
});

test("a quota save failure neither retries a successful request nor manufactures a source pause", async () => {
  const checkpoints = new MemoryStore();
  const save = checkpoints.save.bind(checkpoints);
  checkpoints.save = async (key, value) => {
    if (key.startsWith("quota:")) throw new Error("synthetic-secret-store-failure");
    return save(key, value);
  };
  let requests = 0;
  const client = create(
    async () => {
      requests += 1;
      return json([1], 200, headers);
    },
    {
      checkpoints,
      maxRetries: 3,
      sleep: async () => {
        throw new Error("unexpected retry");
      },
    },
  );
  assert.deepEqual(await client.scanRest(scan), [1]);
  assert.equal(requests, 1);
  assert.equal(
    [...checkpoints.values.keys()].some((key) => key.startsWith("pause:")),
    false,
  );
  assert.equal(core(await client.readQuota(source)).state, "unknown");
});

test("filesystem-backed quota observations survive a client restart without source content or tokens in their records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-quota-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^leaderboard-quota-/);
    await rm(directory, { recursive: true, force: true });
  });
  const first = create(async () => json([1], 200, headers), { checkpoints: new FileCheckpointStore(directory) });
  await first.scanRest(scan);
  const files = await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")));
  const records = files.map((text) => JSON.parse(text)).filter((value) => value?.scopeKey);
  assert.equal(records.length, 1);
  const encoded = JSON.stringify(records);
  for (const forbidden of [source, origin, "synthetic-secret-token", "envelope", "body", "items"])
    assert.equal(encoded.includes(forbidden), false, forbidden);
  const restarted = create(
    async () => {
      throw new Error("unexpected network");
    },
    {
      checkpoints: new FileCheckpointStore(directory),
      token: async () => {
        throw new Error("unexpected token");
      },
    },
  );
  assert.equal(core(await restarted.readQuota(source)).observation.remaining, 4000);
});
