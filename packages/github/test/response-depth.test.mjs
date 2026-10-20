import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const origin = "https://api.synthetic.invalid";
const source = "synthetic-depth-installation";
const query = "query { viewer { id } }";
const nestingLimit = 128;
const nested = (depth, kind = "object", leaf = "null") =>
  (kind === "object" ? '{"child":' : "[").repeat(depth) + leaf + (kind === "object" ? "}" : "]").repeat(depth);
const wire = (graphql, depth, kind = "object", leaf = "null") =>
  graphql ? '{"data":' + nested(depth - 1, kind, leaf) + "}" : nested(depth, kind, leaf);

class MemoryStore {
  values = new Map();
  writes = 0;
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.writes += 1;
    this.values.set(key, structuredClone(value));
  }
}

function fixture(fetch, { checkpoints = new MemoryStore(), maxRetries = 2 } = {}) {
  const observed = { calls: 0, tokens: 0, sleeps: [] };
  let now = 0;
  const client = new GithubReadClient({
    apiOrigin: origin,
    token: async () => {
      observed.tokens += 1;
      return undefined;
    },
    checkpoints,
    concurrency: 1,
    maxRetries,
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      observed.sleeps.push(ms);
      now += ms;
    },
    fetch: async (...args) => {
      observed.calls += 1;
      return fetch(...args);
    },
  });
  return { client, checkpoints, observed };
}

const read = (client, graphql) => (graphql ? client.graphql(source, query) : client.rest(source, "/issues"));
const rejectedAs = (kind) => (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.deepEqual(error.outcome, { kind });
  assert.equal(error.message, `GitHub source request failed: ${kind}`);
  return true;
};

for (const graphql of [false, true]) {
  for (const kind of ["object", "array"]) {
    test(`${graphql ? "GraphQL" : "REST"} rejects deeply nested ${kind} source once without a retry pause or cache`, async () => {
      const body = wire(graphql, 10_000, kind, '"synthetic-private-leaf"');
      assert.ok(Buffer.byteLength(body) < 128 * 1024, "the existing byte limit does not explain rejection");
      const { client, checkpoints, observed } = fixture(
        async (url) => new Response(url.endsWith("/healthy") ? "[]" : body, { headers: { etag: '"rejected"' } }),
      );
      await assert.rejects(read(client, graphql), rejectedAs("invalid_response"));
      assert.equal(observed.calls, 1);
      assert.deepEqual(observed.sleeps, []);
      assert.equal(checkpoints.values.size, 0);
      assert.equal(checkpoints.writes, 0);
      assert.deepEqual(await client.rest("synthetic-sibling", "/healthy"), []);
      assert.equal(observed.calls, 2, "rejected source released its concurrency slot");
    });

    test(`${graphql ? "GraphQL" : "REST"} accepts exactly 128 ${kind} containers and rejects 129`, async () => {
      const { client, checkpoints, observed } = fixture(
        async () => new Response(wire(graphql, observed.calls === 1 ? nestingLimit : nestingLimit + 1, kind)),
      );
      const value = await read(client, graphql);
      let leaf = value;
      for (let n = 0; n < nestingLimit - (graphql ? 1 : 0); n += 1) leaf = kind === "object" ? leaf.child : leaf[0];
      assert.equal(leaf, null);
      await assert.rejects(read(client, graphql), rejectedAs("invalid_response"));
      assert.equal(observed.calls, 2);
      assert.deepEqual(observed.sleeps, []);
      assert.equal(checkpoints.values.size, 0);
    });
  }
}

test("the nesting boundary includes values omitted by identity-email minimization", async () => {
  const body = '{"author":{"email":' + nested(nestingLimit) + '},"id":"synthetic-public-id"}';
  const { client, observed } = fixture(async () => new Response(body));
  await assert.rejects(client.rest(source, "/issues"), rejectedAs("invalid_response"));
  assert.equal(observed.calls, 1);
  assert.deepEqual(observed.sleeps, []);
});

test("identity minimization preserves accepted boundary values and unrelated free text", async () => {
  const leaf = '{"author":{"email":"synthetic@example.invalid","id":7},"text":"synthetic@example.invalid"}';
  const body = nested(nestingLimit - 2, "object", leaf);
  const { client, observed } = fixture(async () => new Response(body));
  let result = await client.rest(source, "/issues");
  for (let n = 0; n < nestingLimit - 2; n += 1) result = result.child;
  assert.deepEqual(result, { author: { id: 7 }, text: "synthetic@example.invalid" });
  assert.equal(observed.calls, 1);
});

test("an excessive response cannot replace a valid ETag representation", async () => {
  const original = [{ id: "synthetic-accepted" }];
  const { client, checkpoints, observed } = fixture(async (_url, request) => {
    if (observed.calls === 1) return new Response(JSON.stringify(original), { headers: { etag: '"accepted"' } });
    assert.equal(request.headers.get("if-none-match"), '"accepted"');
    if (observed.calls === 2) return new Response(nested(10_000), { headers: { etag: '"rejected"' } });
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await client.rest(source, "/issues"), original);
  const saved = structuredClone([...checkpoints.values]);
  await assert.rejects(client.rest(source, "/issues"), rejectedAs("invalid_response"));
  assert.deepEqual([...checkpoints.values], saved);
  assert.deepEqual(await client.rest(source, "/issues"), original);
  assert.equal(observed.calls, 3);
  assert.deepEqual(observed.sleeps, []);
});

for (const graphql of [false, true]) {
  test(`${graphql ? "GraphQL" : "REST"} preserves accepted scan progress and resumes an excessive later page`, async () => {
    let selections = 0;
    const requests = [];
    const { client, checkpoints, observed } = fixture(async (url, request) => {
      requests.push(graphql ? JSON.parse(request.body).variables.after : url);
      if (observed.calls === 2) return new Response(wire(graphql, 10_000));
      const first = observed.calls === 1;
      const nodes = [{ id: first ? "first" : "second" }];
      return graphql
        ? new Response(
            JSON.stringify({ data: { nodes, pageInfo: { hasNextPage: first, endCursor: first ? "next" : null } } }),
          )
        : new Response(JSON.stringify(nodes), {
            headers: first ? { link: `<${origin}/issues?page=2>; rel="next"` } : {},
          });
    });
    const options = {
      source,
      key: "synthetic-depth-scan",
      maxPages: 2,
      ...(graphql
        ? {
            query,
            select: (data) => {
              selections += 1;
              return data;
            },
          }
        : {
            url: "/issues?page=1",
            select: (body) => {
              selections += 1;
              return body;
            },
          }),
    };
    const scan = () => (graphql ? client.scanGraphql(options) : client.scanRest(options));
    await assert.rejects(scan(), rejectedAs("invalid_response"));
    const retained = [...checkpoints.values].find(([key]) => key.startsWith("scan:"))[1];
    assert.equal(retained.complete, false);
    assert.deepEqual(retained.items, [{ id: "first" }]);
    assert.equal(retained.next, graphql ? "next" : `${origin}/issues?page=2`);
    assert.equal(selections, 1);
    assert.deepEqual(await scan(), [{ id: "first" }, { id: "second" }]);
    assert.equal(selections, 2);
    assert.deepEqual(
      requests,
      graphql
        ? [null, "next", "next"]
        : [`${origin}/issues?page=1`, `${origin}/issues?page=2`, `${origin}/issues?page=2`],
    );
    assert.deepEqual(observed.sleeps, []);
  });
}

test("an excessive legacy HTTP cache fails as an invalid checkpoint before token or HTTP work", async () => {
  const retained = { version: 1, etag: '"legacy"', body: JSON.parse(nested(10_000)), link: null };
  let writes = 0;
  const checkpoints = {
    load: async (key) => (key.startsWith("http:") ? retained : undefined),
    save: async () => {
      writes += 1;
    },
  };
  const { client, observed } = fixture(async () => new Response(null, { status: 304 }), { checkpoints });
  await assert.rejects(client.rest(source, "/issues"), rejectedAs("invalid_checkpoint"));
  assert.equal(observed.tokens, 0);
  assert.equal(observed.calls, 0);
  assert.equal(writes, 0);
  assert.deepEqual(observed.sleeps, []);
  assert.equal(retained.etag, '"legacy"');
});

test("an excessive legacy scan fails as an invalid checkpoint without replacing its retained state", async () => {
  const options = { source, key: "synthetic-legacy-depth", url: "/issues", maxPages: 1, select: (body) => body };
  const { client, checkpoints, observed } = fixture(async () => new Response('[{"id":"accepted"}]'));
  await client.scanRest(options);
  const [key, retained] = [...checkpoints.values].find(([name]) => name.startsWith("scan:"));
  retained.items = [JSON.parse(nested(10_000))];
  // Model the decoded file-store value directly; structuredClone has its own unrelated depth limit.
  checkpoints.load = async (name) => checkpoints.values.get(name);
  const writes = checkpoints.writes;
  await assert.rejects(client.scanRest(options), rejectedAs("invalid_checkpoint"));
  assert.equal(checkpoints.values.get(key), retained);
  assert.equal(checkpoints.writes, writes);
  assert.equal(observed.calls, 1);
  assert.deepEqual(observed.sleeps, []);
});

test("an excessive selector result cannot advance a valid source page", async () => {
  const selected = [JSON.parse(nested(10_000))];
  const { client, checkpoints, observed } = fixture(async () => new Response("[]"));
  await assert.rejects(
    client.scanRest({ source, key: "synthetic-selected-depth", url: "/issues", maxPages: 1, select: () => selected }),
    rejectedAs("invalid_response"),
  );
  assert.equal(observed.calls, 1);
  assert.equal(checkpoints.writes, 0);
  assert.deepEqual(observed.sleeps, []);
  assert.equal(selected.length, 1);
});

for (const [status, kind, calls] of [
  [401, "authentication_required", 1],
  [403, "permission_denied", 1],
  [404, "not_found_or_hidden", 1],
  [429, "rate_limited", 2],
  [503, "transient_failure", 2],
]) {
  test(`HTTP ${status} retains status classification when its body exceeds the nesting bound`, async () => {
    const { client, observed } = fixture(async () => new Response(nested(10_000), { status }), { maxRetries: 1 });
    await assert.rejects(client.rest(source, "/issues"), (error) => {
      assert.ok(error instanceof GithubClientError);
      assert.equal(error.outcome.kind, kind);
      assert.equal(error.outcome.visibility, "unknown");
      return true;
    });
    assert.equal(observed.calls, calls);
    assert.equal(observed.sleeps.length, calls - 1);
  });
}
