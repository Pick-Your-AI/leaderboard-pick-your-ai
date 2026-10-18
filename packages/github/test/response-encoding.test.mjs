import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const origin = "https://api.synthetic.invalid";
const source = "synthetic-installation";
const query = "query { viewer { id } }";
class MemoryStore {
  values = new Map();
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
}
const clientFor = (fetch, checkpoints = new MemoryStore()) =>
  new GithubReadClient({
    apiOrigin: origin,
    token: async () => "synthetic-private-token",
    checkpoints,
    fetch,
    concurrency: 1,
    maxRetries: 0,
    random: () => 0,
  });
const json = (value, headers = {}) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const damaged = (octets, graphql = false) =>
  Buffer.concat([
    Buffer.from(graphql ? '{"data":{"viewer":{"id":"' : '[{"id":"'),
    Buffer.from(octets),
    Buffer.from(graphql ? '"}}}' : '"}]'),
  ]);
const invalidResponse = (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.deepEqual(error.outcome, { kind: "invalid_response" });
  assert.equal(error.message, "GitHub source request failed: invalid_response");
  return true;
};

for (const [name, octets] of [
  ["isolated continuation", [0x80]],
  ["truncated sequence", [0xe2, 0x82]],
  ["bad continuation", [0xc3, 0x28]],
  ["overlong character", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
  ["outside Unicode range", [0xf4, 0x90, 0x80, 0x80]],
]) {
  for (const graphql of [false, true]) {
    test(`${graphql ? "GraphQL" : "REST"} rejects ${name} bytes before accepting source identity`, async () => {
      const checkpoints = new MemoryStore();
      let calls = 0;
      const client = clientFor(async () => {
        calls += 1;
        return new Response(damaged(octets, graphql), { headers: { etag: '"damaged"' } });
      }, checkpoints);
      await assert.rejects(graphql ? client.graphql(source, query) : client.rest(source, "/issues"), invalidResponse);
      assert.equal(calls, 1, "invalid successful data is not retried");
      assert.equal(checkpoints.values.size, 0, "neither damaged source data nor its ETag is cached");
    });
  }
}

test("malformed UTF-8 cannot replace a valid REST representation or its ETag", async () => {
  const checkpoints = new MemoryStore();
  const valid = [{ id: "synthetic-é" }];
  let calls = 0;
  const client = clientFor(async (_url, request) => {
    calls += 1;
    if (calls === 1) return json(valid, { etag: '"valid"' });
    assert.equal(request.headers.get("if-none-match"), '"valid"');
    if (calls === 2) return new Response(damaged([0xc3, 0x28]), { headers: { etag: '"damaged"' } });
    return new Response(null, { status: 304 });
  }, checkpoints);
  assert.deepEqual(await client.rest(source, "/issues"), valid);
  const saved = structuredClone([...checkpoints.values]);
  await assert.rejects(client.rest(source, "/issues"), invalidResponse);
  assert.deepEqual([...checkpoints.values], saved);
  assert.deepEqual(await client.rest(source, "/issues"), valid);
  assert.equal(calls, 3);
});

test("a malformed later page preserves only accepted checkpoint progress and resumes that page", async () => {
  const checkpoints = new MemoryStore();
  const calls = [];
  let selected = 0;
  const scan = {
    source,
    key: "synthetic-issues-encoding-v1",
    url: "/issues?page=1",
    maxPages: 2,
    select: (body) => {
      selected += 1;
      return body;
    },
  };
  const client = clientFor(async (url) => {
    calls.push(url);
    return url.endsWith("page=1")
      ? json([{ id: "first" }], { link: `<${origin}/issues?page=2>; rel="next"` })
      : new Response(damaged([0x80]));
  }, checkpoints);
  await assert.rejects(client.scanRest(scan), invalidResponse);
  const retained = [...checkpoints.values].find(([key]) => key.startsWith("scan:"))[1];
  assert.equal(retained.complete, false);
  assert.equal(retained.next, `${origin}/issues?page=2`);
  assert.deepEqual(retained.items, [{ id: "first" }]);
  assert.equal(selected, 1, "malformed data never reaches the family selector");
  const resumed = clientFor(async (url) => {
    calls.push(url);
    assert.equal(url, `${origin}/issues?page=2`);
    return json([{ id: "second" }]);
  }, checkpoints);
  assert.deepEqual(await resumed.scanRest(scan), [{ id: "first" }, { id: "second" }]);
  assert.equal(selected, 2);
  assert.deepEqual(calls, [`${origin}/issues?page=1`, `${origin}/issues?page=2`, `${origin}/issues?page=2`]);
});

test("valid multilingual JSON survives byte-split streaming, including a literal replacement character", async () => {
  const value = { label: "日本語 café 🧪 \uFFFD" };
  for (const graphql of [false, true]) {
    const bytes = Buffer.from(JSON.stringify(graphql ? { data: value } : value));
    const client = clientFor(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        ),
    );
    assert.deepEqual(graphql ? await client.graphql(source, query) : await client.rest(source, "/issues"), value);
  }
});

for (const [status, kind] of [
  [401, "authentication_required"],
  [403, "permission_denied"],
  [404, "not_found_or_hidden"],
  [410, "unknown_failure"],
  [429, "rate_limited"],
  [503, "transient_failure"],
]) {
  test(`malformed UTF-8 in an HTTP ${status} body preserves its status classification`, async () => {
    const client = clientFor(async () => new Response(damaged([0x80]), { status }));
    await assert.rejects(client.rest(source, "/issues"), (error) => {
      assert.ok(error instanceof GithubClientError);
      assert.equal(error.outcome.kind, kind);
      assert.equal(error.outcome.visibility, "unknown");
      assert.equal(error.message, `GitHub source request failed: ${kind}`);
      return true;
    });
  });
}
