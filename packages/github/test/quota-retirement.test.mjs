import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { FileCheckpointStore, GithubReadClient } from "../dist/index.js";

const source = "synthetic-installation-quota";
const origin = "https://api.synthetic.invalid";
const retirement = {
  operationId: "synthetic-retirement",
  policyId: "synthetic-policy",
  authorizationId: "synthetic-authority",
};
const core = (value) => value.resources.find((row) => row.resource === "core").observation;
const denied = (error) =>
  error.outcome?.kind === "unsafe_request" && error.message === "GitHub source request failed: unsafe_request";
const response = (remaining) =>
  new Response(JSON.stringify({ id: "synthetic-private-source" }), {
    headers: {
      "content-type": "application/json",
      etag: '"synthetic-source"',
      "x-ratelimit-resource": "core",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(remaining),
    },
  });
async function fixture(t, fetch, wrap = (store) => store) {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-quota-retirement-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^leaderboard-quota-retirement-/);
    await rm(directory, { recursive: true, force: true });
  });
  const cache = join(directory, "cache");
  const fileStore = new FileCheckpointStore(cache);
  let tokens = 0;
  const options = {
    apiOrigin: origin,
    token: async () => {
      tokens++;
      return undefined;
    },
    checkpoints: wrap(fileStore),
    maxRetries: 0,
    concurrency: 2,
    fetch,
  };
  const client = new GithubReadClient(options);
  return {
    cache,
    fileStore,
    options,
    client,
    a: client.forRepository(2),
    b: client.forRepository(3),
    tokens: () => tokens,
  };
}

test("repository quota views share observations while retired views remain denied across filesystem restart", async (t) => {
  let calls = 0;
  const h = await fixture(t, async () => response(++calls === 1 ? 4000 : 4100));
  await h.a.rest(source, "/items");
  assert.equal(core(await h.b.readQuota(source)).remaining, 4000);
  assert.equal(calls, 1);
  assert.equal(h.tokens(), 1);
  await h.b.rest(source, "/items");
  assert.equal(core(await h.a.readQuota(source)).remaining, 4100);
  assert.equal(core(await h.client.readQuota(source)).remaining, 4100);
  await h.client.retireRepositoryCheckpoints(2, retirement);
  await assert.rejects(h.a.readQuota(source), denied);
  assert.equal(core(await h.b.readQuota(source)).remaining, 4100);
  const restarted = new GithubReadClient({ ...h.options, checkpoints: new FileCheckpointStore(h.cache) });
  await assert.rejects(restarted.forRepository(2).readQuota(source), denied);
  assert.equal(core(await restarted.forRepository(3).readQuota(source)).remaining, 4100);
  assert.equal(core(await restarted.readQuota(source)).remaining, 4100);
  assert.equal(calls, 2);
  assert.equal(h.tokens(), 2);
  await assert.rejects(readdir(join(h.cache, "repositories-v1", "2")), { code: "ENOENT" });
  const shared = (await readdir(h.cache)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(shared.length, 1);
  const record = JSON.parse(await readFile(join(h.cache, shared[0]), "utf8"));
  assert.equal(record.remaining, 4100);
  assert.doesNotMatch(JSON.stringify(record), /synthetic-private-source|synthetic-installation-quota|api\.synthetic/);
});

for (const retireQueuedView of [false, true]) {
  test(
    `repository views share one pending quota writer; queued retirement=${retireQueuedView}`,
    { timeout: 5000 },
    async (t) => {
      const firstWrite = Promise.withResolvers(),
        release = Promise.withResolvers(),
        secondObserved = Promise.withResolvers();
      let writes = 0,
        calls = 0;
      const h = await fixture(
        t,
        async () => {
          const result = response(++calls === 1 ? 4000 : 4100);
          if (calls === 2) {
            const get = result.headers.get.bind(result.headers);
            result.headers.get = (name) => {
              if (name === "x-ratelimit-resource") secondObserved.resolve();
              return get(name);
            };
          }
          return result;
        },
        (store) => ({
          load: (key) => store.load(key),
          forRepository: (id) => store.forRepository(id),
          async save(key, value) {
            if (key.startsWith("quota:") && ++writes === 1) {
              firstWrite.resolve();
              await release.promise;
            }
            return store.save(key, value);
          },
        }),
      );
      const first = h.b.rest(source, "/first");
      await firstWrite.promise;
      const second = h.a.rest(source, "/second");
      const rejected = retireQueuedView ? assert.rejects(second, denied) : null;
      await secondObserved.promise;
      assert.equal(writes, 1, "the second view shares the original observer's pending write queue");
      if (retireQueuedView) await h.client.retireRepositoryCheckpoints(2, retirement);
      release.resolve();
      await first;
      if (rejected) await rejected;
      else await second;
      assert.equal(writes, retireQueuedView ? 1 : 2);
      assert.equal(core(await h.b.readQuota(source)).remaining, retireQueuedView ? 4000 : 4100);
      assert.equal(calls, 2, "retirement neither retries a response nor cancels the authorized sibling");
      if (retireQueuedView) await assert.rejects(h.a.readQuota(source), denied);
    },
  );
}

test("retirement during a retained pool read withholds the result without a token or network request", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let hold = false,
    held = false,
    calls = 0;
  const h = await fixture(
    t,
    async () => {
      calls++;
      return response(4000);
    },
    (store) => ({
      save: (key, value) => store.save(key, value),
      forRepository: (id) => store.forRepository(id),
      async load(key) {
        const result = await store.load(key);
        if (hold && !held && key.startsWith("quota:")) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    }),
  );
  await h.a.rest(source, "/items");
  hold = true;
  const rejected = assert.rejects(h.a.readQuota(source), denied);
  await entered.promise;
  await h.client.retireRepositoryCheckpoints(2, retirement);
  release.resolve();
  await rejected;
  assert.equal(core(await h.b.readQuota(source)).remaining, 4000);
  assert.equal(calls, 1);
  assert.equal(h.tokens(), 1);
});
