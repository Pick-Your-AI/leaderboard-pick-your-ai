import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GithubReadClient } from "../dist/index.js";

const origin = "https://api.synthetic.invalid";
const source = "synthetic-installation";
const url = `${origin}/repos/synthetic/example/commits`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const httpKey = `http:${hash([source, "2022-11-28", url])}`;
const scanKey = `scan:${hash([source, "commits-v1"])}`;
const rawCommit = () => ({
  sha: "synthetic-sha",
  node_id: "synthetic-node",
  html_url: "https://github.com/synthetic/example/commit/synthetic-sha",
  author: { id: 10, login: "synthetic-author" },
  committer: { id: 20, login: "synthetic-committer" },
  commit: {
    author: { name: "Synthetic author", email: "synthetic-author@example.invalid", date: "2026-01-01T00:00:00Z" },
    committer: {
      name: "Synthetic committer",
      email: "synthetic-committer@example.invalid",
      date: "2026-01-02T00:00:00Z",
    },
    message: "Synthetic message\n\nCo-authored-by: Synthetic <trailer@example.invalid>",
  },
});
const minimizedCommit = () => {
  const result = rawCommit();
  delete result.commit.author.email;
  delete result.commit.committer.email;
  return result;
};
class Store {
  values = new Map();
  writes = [];
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.writes.push(structuredClone(value));
    this.values.set(key, structuredClone(value));
  }
}
const client = (checkpoints, fetch) =>
  new GithubReadClient({
    apiOrigin: origin,
    token: async () => undefined,
    checkpoints,
    fetch,
    maxRetries: 0,
  });
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const scan = { source, key: "commits-v1", url, maxPages: 2, select: (body) => body };
const legacyScan = (complete) => ({
  version: 1,
  fingerprint: hash(["rest/v1", url, "2022-11-28", scan.key]),
  next: complete ? null : `${url}?page=2`,
  visited: [url],
  items: [rawCommit()],
  complete,
});

test("fresh REST minimizes structured emails before selectors and both checkpoint writes", async () => {
  const store = new Store();
  const raw = rawCommit();
  const before = structuredClone(raw);
  const reader = client(store, async () => json([raw], { etag: '"synthetic"' }));
  const result = await reader.scanRest({
    ...scan,
    select(body) {
      assert.deepEqual(body, [minimizedCommit()]);
      return body;
    },
  });
  assert.deepEqual(result, [minimizedCommit()]);
  assert.deepEqual(store.values.get(httpKey).body, result);
  assert.deepEqual(store.values.get(scanKey).items, result);
  assert.deepEqual(raw, before);
  for (const write of store.writes) {
    assert.equal(JSON.stringify(write).includes("synthetic-author@example.invalid"), false);
    assert.equal(JSON.stringify(write).includes("synthetic-committer@example.invalid"), false);
  }
  // Free-text trailers deliberately remain unchanged; this is not a full payload scrubber.
  assert.match(result[0].commit.message, /trailer@example.invalid/);
});

test("legacy HTTP cache is durably minimized before conditional 304 reuse", async () => {
  const store = new Store();
  const legacy = { version: 1, etag: '"legacy"', link: `<${url}?page=2>; rel="next"`, body: [rawCommit()] };
  store.values.set(httpKey, structuredClone(legacy));
  const reader = client(store, async (_, request) => {
    assert.equal(request.headers.get("if-none-match"), legacy.etag);
    assert.deepEqual(store.values.get(httpKey), { ...legacy, body: [minimizedCommit()] });
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await reader.rest(source, url), [minimizedCommit()]);
  assert.equal(store.values.get(httpKey).link, legacy.link);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(legacy.body, [rawCommit()]);
});

for (const complete of [false, true]) {
  test(`legacy ${complete ? "completed" : "interrupted"} scan migrates before returning or resuming`, async () => {
    const store = new Store();
    const legacy = legacyScan(complete);
    store.values.set(scanKey, structuredClone(legacy));
    let calls = 0;
    const reader = client(store, async (next) => {
      calls++;
      assert.equal(next, legacy.next);
      assert.deepEqual(store.values.get(scanKey), { ...legacy, items: [minimizedCommit()] });
      return json([rawCommit()]);
    });
    assert.deepEqual(await reader.scanRest(scan), Array.from({ length: complete ? 1 : 2 }, minimizedCommit));
    assert.equal(calls, complete ? 0 : 1);
    assert.deepEqual(store.writes[0], { ...legacy, items: [minimizedCommit()] });
    assert.deepEqual(legacy.items, [rawCommit()]);
  });
}

test("legacy migration failures prevent HTTP requests and scan reuse", async () => {
  for (const kind of ["http", "completed", "interrupted"]) {
    const store = new Store();
    store.values.set(
      kind === "http" ? httpKey : scanKey,
      kind === "http"
        ? { version: 1, etag: '"legacy"', link: null, body: [rawCommit()] }
        : legacyScan(kind === "completed"),
    );
    store.save = async () => {
      throw new Error("synthetic write failure");
    };
    let calls = 0;
    const reader = client(store, async () => {
      calls++;
      throw new Error("unexpected request");
    });
    await assert.rejects(kind === "http" ? reader.rest(source, url) : reader.scanRest(scan), /synthetic write failure/);
    assert.equal(calls, 0);
  }
});

test("GraphQL response and selected items minimize identity emails without mutating selectors", async () => {
  const store = new Store();
  const selected = { ...rawCommit(), metadata: { email: "unrelated@example.invalid" } };
  const before = structuredClone(selected);
  const reader = client(store, async () =>
    json({ data: { nodes: [rawCommit()], pageInfo: { hasNextPage: false, endCursor: null } } }),
  );
  const result = await reader.scanGraphql({
    source,
    key: "graphql-commits",
    query: "query { repository { id } }",
    maxPages: 1,
    select(data) {
      assert.deepEqual(data.nodes, [minimizedCommit()]);
      return { ...data, nodes: [selected] };
    },
  });
  assert.deepEqual(selected, before);
  assert.deepEqual(result, [{ ...minimizedCommit(), metadata: selected.metadata }]);
  assert.deepEqual(store.writes[0].items, result);
});
