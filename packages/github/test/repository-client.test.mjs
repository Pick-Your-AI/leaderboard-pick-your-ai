import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckpointLimitError, FileCheckpointStore, GithubClientError, GithubReadClient } from "../dist/index.js";

const origin = "https://api.synthetic.invalid";
const source = "synthetic-installation:1";
const binding = {
  operationId: "synthetic-retirement-1",
  policyId: "synthetic-policy-v1",
  authorizationId: "synthetic-host-approval",
};
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const scan = {
  source,
  key: "synthetic-same-selection",
  url: "/items",
  maxPages: 2,
  select: (body) => body,
};
const denied = (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.equal(error.outcome.kind, "unsafe_request");
  assert.equal(error.message, "GitHub source request failed: unsafe_request");
  return true;
};

async function setup(t, fetch, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-repository-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "cache");
  const { checkpointOptions, ...clientOptions } = extra;
  const checkpoints = new FileCheckpointStore(cache, checkpointOptions);
  const options = {
    apiOrigin: origin,
    token: async () => undefined,
    checkpoints,
    fetch,
    maxRetries: 0,
    random: () => 0,
    ...clientOptions,
  };
  const client = new GithubReadClient(options);
  return { directory, cache, checkpoints, options, client, a: client.forRepository(2), b: client.forRepository(3) };
}

test("same-installation repository views isolate identical request and scan keys across retirement and restart", async (t) => {
  let calls = 0;
  const h = await setup(t, async (_url, request) => {
    calls++;
    assert.equal(request.headers.has("if-none-match"), false, "another repository's ETag is not reused");
    return json([{ id: `synthetic-source-${calls}` }], { etag: `"synthetic-${calls}"` });
  });
  const a = await h.a.scanRest(scan);
  const b = await h.b.scanRest(scan);
  assert.notDeepEqual(a, b);
  assert.equal(calls, 2);
  assert.deepEqual(await h.a.scanRest(scan), a);
  assert.deepEqual(await h.b.scanRest(scan), b);
  const oldPayload = join(h.directory, "old-a-payload");
  await cp(join(h.cache, "repositories-v1", "2"), oldPayload, { recursive: true });
  const receipt = await h.client.retireRepositoryCheckpoints(2, binding);
  assert.equal(receipt.checkpointPayloadsRemoved, true);
  assert.equal(receipt.repositoryId, 2);
  assert.equal(receipt.legacyUnscopedPayloads, "outside_scope");
  assert.deepEqual(await h.b.scanRest(scan), b);
  const restarted = new GithubReadClient({ ...h.options, checkpoints: new FileCheckpointStore(h.cache) });
  await assert.rejects(restarted.forRepository(2).scanRest(scan), denied);
  await assert.rejects(restarted.forRepository(2).rest(source, "/items"), denied);
  await assert.rejects(restarted.forRepository(2).graphql(source, "query { items }"), denied);
  assert.deepEqual(await restarted.forRepository(3).scanRest(scan), b);
  assert.equal(calls, 2, "retired reads and both completed scan replays make no HTTP requests");

  // Reintroducing an old cache payload is distinct from replacing the authority.
  await cp(oldPayload, join(h.cache, "repositories-v1", "2"), { recursive: true });
  await assert.rejects(restarted.forRepository(2).scanRest(scan), denied);
  assert.deepEqual(await restarted.retireRepositoryCheckpoints(2, binding), receipt);
  await assert.rejects(readdir(join(h.cache, "repositories-v1", "2")), { code: "ENOENT" });
  assert.deepEqual(await restarted.forRepository(3).scanRest(scan), b);
});

for (const protocol of ["REST", "GraphQL"]) {
  test(`${protocol} retirement during an HTTP response rejects its bytes and frees the shared request slot`, async (t) => {
    const entered = Promise.withResolvers();
    const response = Promise.withResolvers();
    let calls = 0;
    const h = await setup(
      t,
      async () => {
        calls++;
        if (calls > 1) return json({ id: "synthetic-other-repository" });
        entered.resolve();
        await response.promise;
        return json(protocol === "REST" ? { id: "synthetic-retired" } : { data: { id: "synthetic-retired" } }, {
          etag: '"synthetic-retired"',
        });
      },
      { concurrency: 1 },
    );
    const request = protocol === "REST" ? h.a.rest(source, "/items") : h.a.graphql(source, "query { id }");
    const rejected = assert.rejects(request, denied);
    await entered.promise;
    const other = h.b.rest(source, "/other");
    await h.client.retireRepositoryCheckpoints(2, binding);
    assert.equal(calls, 1, "the other repository still shares the configured one-request pool");
    response.resolve();
    await rejected;
    assert.deepEqual(await other, { id: "synthetic-other-repository" });
    assert.equal(calls, 2, "retirement does not retry the removed response");
    await assert.rejects(readdir(join(h.cache, "repositories-v1", "2")), { code: "ENOENT" });
  });
}

test("retirement during streamed body consumption rejects an uncached response", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const h = await setup(t, async () => {
    calls++;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          entered.resolve();
          await release.promise;
          controller.enqueue(new TextEncoder().encode('{"id":"synthetic-retired"}'));
          controller.close();
        },
      }),
    );
  });
  const rejected = assert.rejects(h.a.rest(source, "/items"), denied);
  await entered.promise;
  await h.client.retireRepositoryCheckpoints(2, binding);
  release.resolve();
  await rejected;
  assert.equal(calls, 1);
});

test("retirement while awaiting a token prevents HTTP and leaves another repository usable", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  let tokens = 0;
  const h = await setup(
    t,
    async () => {
      calls++;
      return json({ id: "synthetic-safe" });
    },
    {
      token: async () => {
        if (++tokens === 1) {
          entered.resolve();
          await release.promise;
        }
        return undefined;
      },
    },
  );
  const rejected = assert.rejects(h.a.rest(source, "/items"), denied);
  await entered.promise;
  await h.client.retireRepositoryCheckpoints(2, binding);
  release.resolve();
  await rejected;
  assert.equal(calls, 0);
  assert.deepEqual(await h.b.rest(source, "/items"), { id: "synthetic-safe" });
  assert.equal(calls, 1);
});

test("retiring one repository preserves its installation quota pause for another repository and restart", async (t) => {
  let now = 100_000;
  let calls = 0;
  const sleeps = [];
  const h = await setup(
    t,
    async () => {
      calls++;
      return json([{ id: "synthetic-observation" }], {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String((now + 2000) / 1000),
      });
    },
    {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  );
  await h.a.rest(source, "/items");
  await h.client.retireRepositoryCheckpoints(2, binding);
  const restarted = new GithubReadClient({ ...h.options, checkpoints: new FileCheckpointStore(h.cache) });
  await assert.rejects(restarted.forRepository(2).rest(source, "/items"), denied);
  await restarted.forRepository(3).rest(source, "/items");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls, 2);
  assert.ok((await readdir(h.cache)).some((name) => /^[a-f0-9]{64}\.json$/.test(name)));
});

test("retirement denies a retained interrupted scan without a retry or a stale page delivery", async (t) => {
  let calls = 0;
  const h = await setup(t, async () => {
    calls++;
    return json([{ id: "synthetic-first-page" }], { link: `<${origin}/items?page=2>; rel="next"` });
  });
  await assert.rejects(h.a.scanRest({ ...scan, maxPages: 1 }), /Source pagination exceeded maxPages/);
  assert.equal(calls, 1);
  await h.client.retireRepositoryCheckpoints(2, binding);
  const restarted = new GithubReadClient({ ...h.options, checkpoints: new FileCheckpointStore(h.cache) });
  await assert.rejects(restarted.forRepository(2).scanRest(scan), denied);
  await assert.rejects(restarted.forRepository(2).scanRest({ ...scan, refresh: true }), denied);
  assert.equal(calls, 1);
});

test("a nested GraphQL scan cannot return an earlier child after repository retirement", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const h = await setup(
    t,
    async () => {
      if (++calls === 2) {
        entered.resolve();
        await release.promise;
      }
      return json({
        data: { items: { nodes: [{ id: `synthetic-${calls}` }], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    },
    { concurrency: 1 },
  );
  const rejected = assert.rejects(
    h.a.scanNestedGraphql([1, 2], (id) => ({
      source,
      key: `synthetic-child-${id}`,
      query: "query { items { nodes { id } pageInfo { hasNextPage endCursor } } }",
      maxPages: 1,
      select: (data) => data.items,
    })),
    denied,
  );
  await entered.promise;
  await h.client.retireRepositoryCheckpoints(2, binding);
  release.resolve();
  await rejected;
  assert.equal(calls, 2);
});

test("repository scope cannot silently use a legacy store or change identity on an existing view", async (t) => {
  const h = await setup(t, async () => {
    throw new Error("No HTTP expected");
  });
  assert.equal(h.a.forRepository(2), h.a);
  assert.throws(() => h.a.forRepository(3), /Cannot change a repository-bound/);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])
    assert.throws(() => h.client.forRepository(id), /Invalid checkpoint repository identity/);
  const legacy = new GithubReadClient({
    ...h.options,
    checkpoints: { load: async () => undefined, save: async () => {} },
  });
  assert.throws(() => legacy.forRepository(2), /Repository-scoped checkpoint storage is required/);
});

test("an oversized ETag cache replacement preserves accepted bytes without retrying the network or pausing its quota pool", async (t) => {
  let calls = 0;
  let sleeps = 0;
  const accepted = { id: "synthetic-accepted" };
  const h = await setup(
    t,
    async (_url, request) => {
      calls++;
      if (calls === 1) return json(accepted, { etag: '"synthetic-accepted"' });
      assert.equal(request.headers.get("if-none-match"), '"synthetic-accepted"');
      if (calls === 2) return json({ id: "x".repeat(512) }, { etag: '"synthetic-too-large"' });
      return new Response(null, { status: 304 });
    },
    {
      checkpointOptions: { maxBytes: 256 },
      maxRetries: 3,
      sleep: async () => {
        sleeps++;
        throw new Error("A local capacity failure must not enter retry sleep");
      },
    },
  );
  assert.deepEqual(await h.a.rest(source, "/items"), accepted);
  const namespace = join(h.cache, "repositories-v1", "2");
  const files = await readdir(namespace);
  assert.equal(files.length, 1);
  const saved = await readFile(join(namespace, files[0]));
  await assert.rejects(h.a.rest(source, "/items"), CheckpointLimitError);
  assert.equal(calls, 2, "local capacity failure must not retry a successful HTTP response");
  assert.equal(sleeps, 0);
  assert.deepEqual(await readdir(namespace), files);
  assert.deepEqual(await readFile(join(namespace, files[0])), saved);
  assert.deepEqual(await readdir(h.cache), ["repositories-v1"], "no shared quota pause is synthesized");
  assert.deepEqual(await h.a.rest(source, "/items"), accepted);
  assert.equal(calls, 3);
});
