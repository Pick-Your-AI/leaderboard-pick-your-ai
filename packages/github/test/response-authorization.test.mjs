import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const ORIGIN = "https://api.synthetic.invalid";
const QUERY = "query Items { items { nodes { id } pageInfo { hasNextPage endCursor } } }";
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const envelope = (kind, items) => (kind === "REST" ? items : { data: { items } });
const deferred = () => Promise.withResolvers();
const denied = (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.equal(error.outcome.kind, "unsafe_request");
  assert.equal(error.message, "GitHub source request failed: unsafe_request");
  return true;
};

class MemoryStore {
  values = new Map();
  writes = [];
  onSave = async () => {};
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
    this.writes.push({ key, value: structuredClone(value) });
    await this.onSave(key);
  }
}

function setup(fetch, extra = {}) {
  const checkpoints = new MemoryStore();
  let authorized = true;
  const assertAuthorized = () => {
    if (!authorized) throw new Error("private host-policy details must stay private");
  };
  const client = new GithubReadClient({
    apiOrigin: ORIGIN,
    token: async () => undefined,
    checkpoints,
    fetch,
    concurrency: 1,
    maxRetries: 2,
    sleep: async () => {
      throw new Error("authorization denial must not retry");
    },
    ...extra,
  });
  return {
    client,
    checkpoints,
    assertAuthorized,
    revoke: () => {
      authorized = false;
    },
  };
}

function read(kind, context, source = "scope:a") {
  return kind === "REST"
    ? context.client.rest(source, "/items", context.assertAuthorized)
    : context.client.graphql(source, QUERY, {}, context.assertAuthorized);
}

for (const kind of ["REST", "GraphQL"]) {
  test(`${kind} denies a response after revocation during fetch and releases the request slot`, async () => {
    let calls = 0;
    let cancelled = 0;
    const context = setup(async () => {
      calls++;
      if (calls > 1) return json({ accessible: true });
      const stream = new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope(kind, [{ id: "private" }]))));
            controller.close();
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
      context.revoke();
      return new Response(stream, { headers: { etag: '"private-v1"' } });
    });
    await assert.rejects(read(kind, context), denied);
    assert.equal(cancelled, 1, "unread rejected response body is cancelled");
    assert.equal(context.checkpoints.writes.length, 0);
    assert.deepEqual(await context.client.rest("scope:b", "/other"), { accessible: true });
    assert.equal(calls, 2, "denial does not retry or retain the only request slot");
  });

  test(`${kind} rechecks authorization after awaiting streamed response bytes`, { timeout: 5000 }, async () => {
    const reading = deferred();
    const release = deferred();
    let calls = 0;
    const context = setup(async () => {
      calls++;
      return new Response(
        new ReadableStream(
          {
            async pull(controller) {
              reading.resolve();
              await release.promise;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope(kind, [{ id: "private" }]))));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { etag: '"private-v1"' } },
      );
    });
    const rejection = assert.rejects(read(kind, context), denied);
    await reading.promise;
    context.revoke();
    release.resolve();
    await rejection;
    assert.equal(calls, 1);
    assert.equal(context.checkpoints.writes.length, 0, "revoked bytes do not enter a new HTTP cache");
  });

  test(`${kind} does not advance a scan checkpoint after revocation during selection`, async () => {
    let calls = 0;
    const context = setup(async () => {
      calls++;
      const items = [{ id: calls }];
      const more = calls === 1;
      return kind === "REST"
        ? json(items, more ? { link: `<${ORIGIN}/items?page=2>; rel="next"` } : {})
        : json({ data: { items: { nodes: items, pageInfo: { hasNextPage: more, endCursor: more ? "next" : null } } } });
    });
    const common = { source: "scope:a", key: "items/v1", maxPages: 2, assertAuthorized: context.assertAuthorized };
    const result =
      kind === "REST"
        ? context.client.scanRest({
            ...common,
            url: "/items",
            select: (body) => {
              if (calls === 2) context.revoke();
              return body;
            },
          })
        : context.client.scanGraphql({
            ...common,
            query: QUERY,
            select: (data) => {
              if (calls === 2) context.revoke();
              return data.items;
            },
          });
    await assert.rejects(result, denied);
    const saves = context.checkpoints.writes.filter(({ key }) => key.startsWith("scan:"));
    assert.equal(saves.length, 1, "only the previously authorized page was committed");
    assert.deepEqual(saves[0].value.items, [{ id: 1 }]);
    assert.equal(saves[0].value.complete, false);
    assert.equal(saves[0].value.visited.length, 1);
    assert.ok(saves[0].value.next);
    assert.equal(calls, 2);
  });
}

test("REST rechecks authorization after an awaited HTTP cache write", { timeout: 5000 }, async () => {
  const saving = deferred();
  const release = deferred();
  let calls = 0;
  const context = setup(async () => {
    calls++;
    return json([{ id: "private" }], { etag: '"private-v1"' });
  });
  context.checkpoints.onSave = async (key) => {
    assert.ok(key.startsWith("http:"));
    saving.resolve();
    await release.promise;
  };
  const rejection = assert.rejects(read("REST", context), denied);
  await saving.promise;
  context.revoke();
  release.resolve();
  await rejection;
  assert.equal(calls, 1);
  // A durable write started while authorized can already have completed; the
  // read guard does not claim transactional rollback or source-cache deletion.
  assert.equal(context.checkpoints.writes.length, 1);
});

test("REST does not expose a cached 304 body after revocation while persisting quota state", async () => {
  let calls = 0;
  const now = 1_000_000;
  const context = setup(
    async () => {
      calls++;
      return calls === 1
        ? json([{ id: "private" }], { etag: '"private-v1"' })
        : new Response(null, {
            status: 304,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(now / 1000 + 60),
            },
          });
    },
    { now: () => now },
  );
  assert.deepEqual(await read("REST", context), [{ id: "private" }]);
  context.checkpoints.onSave = async (key) => {
    if (key.startsWith("pause:")) context.revoke();
  };
  await assert.rejects(read("REST", context), denied);
  assert.equal(calls, 2);
  assert.equal(context.checkpoints.writes.filter(({ key }) => key.startsWith("http:")).length, 1);
  assert.equal(context.checkpoints.writes.filter(({ key }) => key.startsWith("pause:")).length, 1);
});
