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

for (const concurrency of [1, 2]) {
  test(
    `nested GraphQL rechecks completed children before aggregate delivery (concurrency ${concurrency})`,
    { timeout: 5000 },
    async () => {
      const aSaved = deferred();
      const authorized = new Map([
        ["scope:a", true],
        ["scope:b", true],
      ]);
      const factoryCalls = new Map();
      const context = setup(
        async (_url, init) => {
          const parent = JSON.parse(init.body).variables.parent;
          if (parent === "scope:b") {
            await aSaved.promise;
            // Drain child A's checkpoint/scan continuations so its result is already
            // retained while the independent child B request remains pending.
            await new Promise((resolve) => setImmediate(resolve));
            authorized.set("scope:a", false);
          }
          return json({
            data: { items: { nodes: [{ id: parent }], pageInfo: { hasNextPage: false, endCursor: null } } },
          });
        },
        { concurrency },
      );
      context.checkpoints.onSave = async (key) => {
        if (key.startsWith("scan:") && context.checkpoints.values.get(key).items[0]?.id === "scope:a") {
          aSaved.resolve();
        }
      };
      await assert.rejects(
        context.client.scanNestedGraphql(["scope:a", "scope:b"], (parent) => {
          factoryCalls.set(parent, (factoryCalls.get(parent) ?? 0) + 1);
          return {
            source: parent,
            key: "nested-authorization/v1",
            query:
              "query Items($parent: ID!) { items(parent: $parent) { nodes { id } pageInfo { hasNextPage endCursor } } }",
            variables: { parent },
            maxPages: 1,
            select: (data) => data.items,
            assertAuthorized: () => {
              if (!authorized.get(parent)) throw new Error("private revoked child policy");
            },
          };
        }),
        denied,
      );
      assert.deepEqual(
        [...factoryCalls],
        [
          ["scope:a", 1],
          ["scope:b", 1],
        ],
        "child factories are not re-invoked to authorize delivery",
      );
      const saves = context.checkpoints.writes.filter(({ key }) => key.startsWith("scan:"));
      assert.equal(saves.length, 2, "already authorized child checkpoints are retained");
      assert.ok(saves.every(({ value }) => value.complete));
    },
  );
}

function scanOnce(kind, context) {
  const common = {
    source: "scope:a",
    key: "failure-boundary/v1",
    maxPages: 1,
    assertAuthorized: context.assertAuthorized,
  };
  return kind === "REST"
    ? context.client.scanRest({ ...common, url: "/items", select: (body) => body })
    : context.client.scanGraphql({ ...common, query: QUERY, select: (data) => data.items });
}

function scanEnvelope(kind) {
  const nodes = [{ id: "synthetic-item" }];
  return kind === "REST" ? nodes : { data: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } };
}

for (const kind of ["REST", "GraphQL"]) {
  for (const failure of ["malformed", "oversized"]) {
    test(`authorization fence: ${kind} revoked ${failure} successful body reports denial`, async () => {
      let calls = 0;
      const context = setup(
        async () => {
          calls++;
          if (calls > 1) return json({ accessible: true });
          return new Response(
            new ReadableStream(
              {
                pull(controller) {
                  context.revoke();
                  controller.enqueue(new TextEncoder().encode(failure === "malformed" ? "{" : "x".repeat(128)));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
        { maxResponseBytes: 64, maxRetries: 0 },
      );
      await assert.rejects(read(kind, context), denied);
      assert.equal(calls, 1);
      assert.equal(context.checkpoints.writes.length, 0);
      assert.deepEqual(
        await context.client.rest("scope:b", "/other"),
        { accessible: true },
        "failed body releases the request slot",
      );
    });
  }

  for (const checkpoint of ["corrupt", "future"]) {
    test(`authorization fence: ${kind} revoked ${checkpoint} pause load stops before validation or waiting`, async () => {
      let now = 1_000_000;
      let fetches = 0;
      let tokens = 0;
      const sleeps = [];
      const loads = [];
      const context = setup(
        async () => {
          fetches++;
          return json({});
        },
        {
          now: () => now,
          token: async () => {
            tokens++;
            return undefined;
          },
          sleep: async (ms) => {
            sleeps.push(ms);
            now += ms;
          },
        },
      );
      context.checkpoints.load = async (key) => {
        loads.push(key.split(":", 1)[0]);
        if (key.startsWith("pause:")) {
          context.revoke();
          return checkpoint === "corrupt" ? { version: 1, until: "invalid" } : { version: 1, until: now + 120_000 };
        }
        return undefined;
      };
      await assert.rejects(read(kind, context), denied);
      assert.deepEqual(loads, ["pause"], "revoked initial load does not proceed to HTTP cache loading");
      assert.deepEqual(sleeps, []);
      assert.equal(tokens, 0);
      assert.equal(fetches, 0);
      assert.equal(context.checkpoints.writes.length, 0);
    });
  }

  for (const operation of ["read", "scan"]) {
    test(`authorization fence: ${kind} revoked rejected ${operation} checkpoint load is sanitized`, async () => {
      let fetches = 0;
      const context = setup(async () => {
        fetches++;
        return json(scanEnvelope(kind));
      });
      const prefix = operation === "scan" ? "scan:" : "pause:";
      context.checkpoints.load = async (key) => {
        if (key.startsWith(prefix)) {
          context.revoke();
          throw new Error("private checkpoint backend failure");
        }
        return undefined;
      };
      await assert.rejects(operation === "scan" ? scanOnce(kind, context) : read(kind, context), denied);
      assert.equal(fetches, 0);
      assert.equal(context.checkpoints.writes.length, 0);
    });
  }

  test(`authorization fence: ${kind} revoked rejected scan save reports denial and releases scan ownership`, async () => {
    const context = setup(async () => json(scanEnvelope(kind)));
    context.checkpoints.onSave = async (key) => {
      if (key.startsWith("scan:")) {
        context.revoke();
        throw new Error("private scan checkpoint failure");
      }
    };
    await assert.rejects(scanOnce(kind, context), denied);
    const saves = context.checkpoints.writes.filter(({ key }) => key.startsWith("scan:"));
    assert.equal(saves.length, 1, "a save begun while authorized may already have persisted");
    assert.equal(saves[0].value.complete, true);
    // A second attempt must reach its authorization fence, not be rejected as
    // another scan still owning the same key after the first failed save.
    await assert.rejects(scanOnce(kind, context), denied);
  });

  test(`authorization fence: ${kind} revocation during the first quota sleep stops further chunks`, async () => {
    let now = 1_000_000;
    let fetches = 0;
    let tokens = 0;
    const sleeps = [];
    const context = setup(
      async () => {
        fetches++;
        return json({});
      },
      {
        now: () => now,
        token: async () => {
          tokens++;
          return undefined;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
          context.revoke();
        },
      },
    );
    context.checkpoints.load = async (key) =>
      key.startsWith("pause:") ? { version: 1, until: now + 180_000 } : undefined;
    await assert.rejects(read(kind, context), denied);
    assert.deepEqual(sleeps, [60_000], "the revoked source does not enter another quota wait chunk");
    assert.equal(tokens, 0);
    assert.equal(fetches, 0);
    assert.equal(context.checkpoints.writes.length, 0);
  });
}

for (const checkpoint of ["corrupt", "valid"]) {
  test(`authorization fence: REST revoked ${checkpoint} HTTP cache load stops before waiting or fetch`, async () => {
    let now = 1_000_000;
    let fetches = 0;
    let tokens = 0;
    const sleeps = [];
    const loads = [];
    const context = setup(
      async () => {
        fetches++;
        return json({});
      },
      {
        now: () => now,
        token: async () => {
          tokens++;
          return undefined;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );
    context.checkpoints.load = async (key) => {
      loads.push(key.split(":", 1)[0]);
      if (key.startsWith("pause:")) return { version: 1, until: now + 120_000 };
      context.revoke();
      return { version: 1, etag: checkpoint === "corrupt" ? 3 : '"saved"', link: null, body: [{ id: "private" }] };
    };
    await assert.rejects(read("REST", context), denied);
    assert.deepEqual(loads, ["pause", "http"]);
    assert.deepEqual(sleeps, []);
    assert.equal(tokens, 0);
    assert.equal(fetches, 0);
    assert.equal(context.checkpoints.writes.length, 0);
  });
}

test("authorization fence: REST revoked rejected HTTP cache save is not retried", async () => {
  let fetches = 0;
  const context = setup(
    async () => {
      fetches++;
      return json([{ id: "private" }], { etag: '"private-v1"' });
    },
    { maxRetries: 0 },
  );
  context.checkpoints.onSave = async (key) => {
    if (key.startsWith("http:")) {
      context.revoke();
      throw new Error("private HTTP checkpoint failure");
    }
  };
  await assert.rejects(read("REST", context), denied);
  assert.equal(fetches, 1);
  assert.equal(context.checkpoints.writes.length, 1, "denial does not persist a new retry pause");
  assert.ok(context.checkpoints.writes[0].key.startsWith("http:"));
});
