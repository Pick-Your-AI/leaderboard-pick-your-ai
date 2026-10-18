import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const origin = "https://api.synthetic.invalid";
const privateDetail = "synthetic-private-source-detail";
class Store {
  values = new Map();
  async load(key) {
    return structuredClone(this.values.get(key));
  }
  async save(key, value) {
    this.values.set(key, structuredClone(value));
  }
}
const create = (checkpoints, fetch) =>
  new GithubReadClient({
    apiOrigin: origin,
    token: async () => undefined,
    checkpoints,
    fetch,
    maxRetries: 3,
    sleep: async () => {
      assert.fail("HTTP 410 must not schedule a retry");
    },
  });
const assertGone = (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.deepEqual(error.outcome, { kind: "unknown_failure", visibility: "unknown", status: 410 });
  assert.equal(error.message, "GitHub source request failed: unknown_failure");
  assert.equal(String(error).includes(privateDetail), false);
  assert.equal(JSON.stringify(error).includes(privateDetail), false);
  return true;
};

for (const body of [JSON.stringify({ message: privateDetail }), privateDetail]) {
  test(`HTTP 410 ${body.startsWith("{") ? "JSON" : "non-JSON"} source failure is not retried, cached or leaked`, async () => {
    const store = new Store();
    let calls = 0;
    const client = create(store, async () => {
      calls++;
      return new Response(body, { status: 410, headers: { etag: '"synthetic-gone"' } });
    });
    await assert.rejects(client.rest("synthetic-installation", "/source"), assertGone);
    assert.equal(calls, 1);
    assert.equal(store.values.size, 0);
  });
}

test("HTTP 410 on a later page retains incomplete progress across restarts without accepting an empty page", async () => {
  const store = new Store();
  const calls = [];
  let selections = 0;
  const firstUrl = `${origin}/issues?page=1`;
  const nextUrl = `${origin}/issues?page=2`;
  const firstItems = [{ id: "synthetic-first-page" }];
  const fetch = async (url) => {
    calls.push(url);
    if (url === firstUrl)
      return new Response(JSON.stringify(firstItems), {
        headers: { etag: '"synthetic-first"', link: `<${nextUrl}>; rel="next"` },
      });
    assert.equal(url, nextUrl);
    return new Response(JSON.stringify({ message: privateDetail }), {
      status: 410,
      headers: { etag: '"synthetic-gone"' },
    });
  };
  const scan = {
    source: "synthetic-installation",
    key: "synthetic-issues",
    url: firstUrl,
    maxPages: 4,
    select(body) {
      selections++;
      return body;
    },
  };
  await assert.rejects(create(store, fetch).scanRest(scan), assertGone);
  const persisted = structuredClone([...store.values.entries()]);
  const checkpoints = persisted.filter(([key]) => key.startsWith("scan:"));
  assert.equal(checkpoints.length, 1);
  const state = checkpoints[0][1];
  assert.deepEqual(state.items, firstItems);
  assert.deepEqual(state.visited, [firstUrl]);
  assert.equal(state.next, nextUrl);
  assert.equal(state.complete, false);
  const cached = persisted.filter(([key]) => key.startsWith("http:"));
  assert.equal(cached.length, 1);
  assert.deepEqual(cached[0][1].body, firstItems);
  assert.equal(JSON.stringify(persisted).includes(privateDetail), false);
  assert.equal(JSON.stringify(persisted).includes("synthetic-gone"), false);
  await assert.rejects(create(store, fetch).scanRest(scan), assertGone);
  assert.deepEqual([...store.values.entries()], persisted);
  assert.deepEqual(calls, [firstUrl, nextUrl, nextUrl]);
  assert.equal(selections, 1);
});
