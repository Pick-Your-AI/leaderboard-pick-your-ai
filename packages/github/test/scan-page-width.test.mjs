import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { FileCheckpointStore, GithubClientError, GithubReadClient } from "../dist/index.js";
import { syntheticCheckpointStore } from "./synthetic-client.mjs";

const origin = "https://api.synthetic.invalid";
const source = "synthetic-page-width-installation";
const firstUrl = `${origin}/items?page=1`;
const nextUrl = `${origin}/items?page=2`;
const prefix = [{ id: -2 }, { id: -1 }];
const query =
  "query Items($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }";
const items = (count) => Array.from({ length: count }, (_, id) => ({ id }));
const scan = (kind, client, options) => (kind === "REST" ? client.scanRest(options) : client.scanGraphql(options));
const selectedItems = (kind, value) => (kind === "REST" ? value : value.nodes);
const withItems = (kind, value, nodes) => (kind === "REST" ? nodes : { ...value, nodes });
const cursor = (kind, url, request) => (kind === "REST" ? url : JSON.parse(request.body).variables.after);
const firstCursor = (kind) => (kind === "REST" ? firstUrl : null);
const nextCursor = (kind) => (kind === "REST" ? nextUrl : "next");
const visited = (kind) => (kind === "REST" ? [firstUrl, nextUrl] : ["", "next"]);
function response(kind, nodes, first) {
  const body =
    kind === "REST" ? nodes : { data: { nodes, pageInfo: { hasNextPage: first, endCursor: first ? "next" : null } } };
  return new Response(JSON.stringify(body), {
    headers: kind === "REST" && first ? { link: `<${nextUrl}>; rel="next"` } : {},
  });
}
function options(kind, key, select = (value) => value) {
  return {
    source,
    key,
    maxPages: 2,
    select,
    ...(kind === "REST" ? { url: firstUrl } : { query }),
  };
}
function client(checkpoints, fetch) {
  return new GithubReadClient({
    apiOrigin: origin,
    token: async () => undefined,
    checkpoints,
    concurrency: 1,
    maxRetries: 0,
    sleep: async () => assert.fail("these synthetic responses must not introduce a pause"),
    fetch,
  });
}
function track(checkpoints) {
  const saved = [];
  const references = [];
  return {
    saved,
    references,
    load: (key) => checkpoints.load(key),
    async save(key, value) {
      await checkpoints.save(key, value);
      if (key.startsWith("scan:")) {
        saved.push({ key, value: structuredClone(value) });
        references.push(value);
      }
    },
  };
}
const rejectedAs = (kind) => (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.deepEqual(error.outcome, { kind });
  return true;
};

for (const kind of ["REST", "GraphQL"]) {
  for (const count of [100, 200_000]) {
    test(`${kind} retains every ordered item from a ${count}-item flat page through filesystem checkpoint reuse`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "github-scan-page-width-"));
      t.after(async () => {
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        assert.match(basename(directory), /^github-scan-page-width-/);
        await rm(directory, { recursive: true, force: true });
      });
      const store = track(new FileCheckpointStore(directory));
      const page = items(count);
      const wire = response(kind, page, false);
      const body = await wire.text();
      assert.ok(Buffer.byteLength(body) < 16 * 1024 * 1024, "the complete shallow response fits the default byte cap");
      const calls = [];
      const selections = [];
      let interrupt = count > 100;
      const fetch = async (url, request) => {
        const current = cursor(kind, url, request);
        calls.push(current);
        if (current === firstCursor(kind)) return response(kind, prefix, true);
        assert.equal(current, nextCursor(kind));
        if (interrupt) {
          interrupt = false;
          return new Response("{");
        }
        return new Response(body);
      };
      const selection = (value) => {
        const nodes = selectedItems(kind, value);
        selections.push([nodes.length, nodes[0]?.id, nodes.at(-1)?.id]);
        return value;
      };
      const request = options(kind, `flat-${count}`, selection);
      let reader = client(store, fetch);
      if (count > 100) {
        await assert.rejects(scan(kind, reader, request), rejectedAs("invalid_response"));
        const retained = await store.load(store.saved[0].key);
        assert.deepEqual(retained.items, prefix);
        assert.deepEqual(retained.visited, visited(kind).slice(0, 1));
        assert.equal(retained.next, nextCursor(kind));
        assert.equal(retained.complete, false);
        reader = client(new FileCheckpointStore(directory), fetch);
      }
      const result = await scan(kind, reader, request);
      const expected = prefix.concat(page);
      assert.deepEqual(result, expected);
      assert.deepEqual(selections, [
        [prefix.length, -2, -1],
        [count, 0, count - 1],
      ]);
      assert.deepEqual(
        calls,
        count > 100 ? [firstCursor(kind), nextCursor(kind), nextCursor(kind)] : [firstCursor(kind), nextCursor(kind)],
      );
      const complete = await new FileCheckpointStore(directory).load(store.saved[0].key);
      assert.deepEqual(complete.items, expected);
      assert.deepEqual(complete.visited, visited(kind));
      assert.equal(complete.next, null);
      assert.equal(complete.complete, true);
      const restarted = new GithubReadClient({
        apiOrigin: origin,
        checkpoints: new FileCheckpointStore(directory),
        token: async () => assert.fail("completed checkpoint reuse must not resolve a token"),
        fetch: async () => assert.fail("completed checkpoint reuse must not repeat HTTP"),
      });
      assert.deepEqual(await scan(kind, restarted, request), expected);
      assert.equal(selections.length, 2, "completed checkpoint reuse does not select a page again");
    });
  }

  for (const failure of ["late invalid item", "late throwing iterator"]) {
    test(`${kind} leaves accepted progress unchanged when a selected page has a ${failure}`, async () => {
      const values = new Map();
      const store = track(syntheticCheckpointStore(values));
      const calls = [];
      const marker = new Error("synthetic selected iterator failure");
      const selected =
        failure === "late invalid item"
          ? [
              { id: "not-admitted", author: { id: 7, email: "synthetic@example.invalid" } },
              JSON.parse('{"child":'.repeat(128) + "null" + "}".repeat(128)),
            ]
          : [{ id: "unused-array-entry" }];
      if (failure === "late throwing iterator") {
        Object.defineProperty(selected, Symbol.iterator, {
          value: function* () {
            yield { id: "not-admitted" };
            throw marker;
          },
        });
      }
      let rejectSelection = true;
      const reader = client(store, async (url, request) => {
        const current = cursor(kind, url, request);
        calls.push(current);
        const first = current === firstCursor(kind);
        return response(kind, first ? prefix : [{ id: "accepted-after-retry" }], first);
      });
      const request = options(kind, failure, (value) => {
        if (selectedItems(kind, value)[0]?.id === -2 || !rejectSelection) return value;
        return withItems(kind, value, selected);
      });
      await assert.rejects(
        scan(kind, reader, request),
        failure === "late invalid item"
          ? rejectedAs("invalid_response")
          : (error) => {
              assert.equal(error, marker);
              return true;
            },
      );
      assert.equal(store.saved.length, 1, "a failed page does not publish another checkpoint");
      const accepted = store.saved[0];
      assert.deepEqual(accepted.value.items, prefix);
      assert.equal(accepted.value.next, nextCursor(kind));
      assert.equal(accepted.value.complete, false);
      assert.deepEqual(
        store.references[0],
        accepted.value,
        "the already accepted in-memory page must remain unchanged even when traversal fails after yielding an item",
      );
      assert.deepEqual(await store.load(accepted.key), accepted.value);
      if (failure === "late invalid item") assert.equal(selected[0].author.email, "synthetic@example.invalid");
      else assert.deepEqual(selected[0], { id: "unused-array-entry" });
      rejectSelection = false;
      const expected = prefix.concat({ id: "accepted-after-retry" });
      assert.deepEqual(await scan(kind, reader, request), expected);
      assert.deepEqual(calls, [firstCursor(kind), nextCursor(kind), nextCursor(kind)]);
      assert.deepEqual((await store.load(accepted.key)).items, expected);
      assert.equal((await store.load(accepted.key)).complete, true);
    });
  }

  test(`${kind} preserves selected sparse-array values and custom iterator order`, async () => {
    const store = syntheticCheckpointStore();
    const sparse = [{ id: "first" }, , { id: "last" }];
    let selected = sparse;
    const reader = client(store, async () => response(kind, [], false));
    const request = options(kind, "sparse-values", (value) => withItems(kind, value, selected));
    const expectedSparse = [{ id: "first" }, undefined, { id: "last" }];
    assert.deepEqual(await scan(kind, reader, request), expectedSparse);
    assert.equal(Object.hasOwn(sparse, 1), false, "the selected array retains its original hole");
    assert.deepEqual(await scan(kind, reader, request), expectedSparse);
    selected = [{ id: "unused-array-entry" }];
    let iterations = 0;
    Object.defineProperty(selected, Symbol.iterator, {
      value: function* () {
        iterations += 1;
        yield { id: "last-in-array-order" };
        yield undefined;
        yield { id: "first-in-array-order" };
      },
    });
    const expected = [{ id: "last-in-array-order" }, undefined, { id: "first-in-array-order" }];
    assert.deepEqual(await scan(kind, reader, { ...request, key: "iterator-order" }), expected);
    assert.equal(iterations, 1);
    assert.deepEqual(selected[0], { id: "unused-array-entry" });
    assert.deepEqual(await scan(kind, reader, { ...request, key: "iterator-order" }), expected);
    assert.equal(iterations, 1, "completed reuse does not traverse the selected iterator again");
  });
}

function nestedSelectedValue(depth, leaf = null) {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

for (const kind of ["REST", "GraphQL"]) {
  test(`${kind} validates materialized selected iterator identities at the nesting boundary`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "github-scan-iterator-"));
    t.after(async () => {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.match(basename(directory), /^github-scan-iterator-/);
      await rm(directory, { recursive: true, force: true });
    });
    const store = track(new FileCheckpointStore(directory));
    const leaf = {
      author: { id: 7, email: "synthetic-author@example.invalid" },
      committer: { id: 8, email: "synthetic-committer@example.invalid" },
      message: "synthetic-author@example.invalid is unchanged free text",
    };
    // The page array, 125 wrappers, row and identity object total 128 containers.
    const value = nestedSelectedValue(125, leaf);
    const before = structuredClone(value);
    const selected = [];
    let iterations = 0;
    Object.defineProperty(selected, Symbol.iterator, {
      value: function* () {
        iterations += 1;
        yield { id: "first-iterator-value" };
        yield value;
        yield undefined;
        yield { id: "last-iterator-value" };
      },
    });
    const reader = client(store, async () => response(kind, [], false));
    const request = options(kind, "iterator-identity-boundary", (page) => withItems(kind, page, selected));
    const expected = [
      { id: "first-iterator-value" },
      nestedSelectedValue(125, { author: { id: 7 }, committer: { id: 8 }, message: leaf.message }),
      undefined,
      { id: "last-iterator-value" },
    ];
    assert.deepEqual(await scan(kind, reader, request), expected);
    assert.equal(iterations, 1);
    assert.deepEqual(value, before, "minimization must not mutate the iterator's source value");
    assert.equal(selected.length, 0, "indexed entries cannot stand in for actual iterator output");
    assert.equal(store.saved.length, 1);
    assert.deepEqual(store.saved[0].value.items, expected);
    // JSON checkpoints preserve an explicit undefined array entry as null.
    const persisted = structuredClone(expected);
    persisted[2] = null;
    const restartedStore = new FileCheckpointStore(directory);
    assert.deepEqual((await restartedStore.load(store.saved[0].key)).items, persisted);
    const restarted = new GithubReadClient({
      apiOrigin: origin,
      checkpoints: restartedStore,
      token: async () => assert.fail("completed iterator checkpoint reuse must not resolve a token"),
      fetch: async () => assert.fail("completed iterator checkpoint reuse must not repeat HTTP"),
    });
    assert.deepEqual(await scan(kind, restarted, request), persisted);
    assert.equal(iterations, 1, "completed reuse must not traverse the selected iterator again");
  });

  for (const failure of ["excessive yielded nesting", "excessive omitted email", "late iterator error"]) {
    test(`${kind} rejects a materialized selected iterator with ${failure} without advancing accepted progress`, async () => {
      const store = track(syntheticCheckpointStore());
      const calls = [];
      const marker = new Error("synthetic materialized iterator failure");
      const invalid =
        failure === "excessive omitted email"
          ? { author: { id: 9, email: nestedSelectedValue(128) } }
          : nestedSelectedValue(128);
      const before = structuredClone(invalid);
      const selected = [];
      let iterations = 0;
      let rejectSelection = true;
      Object.defineProperty(selected, Symbol.iterator, {
        value: function* () {
          iterations += 1;
          yield { id: "not-admitted", committer: { id: 8, email: "synthetic@example.invalid" } };
          if (failure === "late iterator error") throw marker;
          yield invalid;
        },
      });
      const reader = client(store, async (url, request) => {
        const current = cursor(kind, url, request);
        calls.push(current);
        const first = current === firstCursor(kind);
        return response(kind, first ? prefix : [{ id: "accepted-after-iterator-retry" }], first);
      });
      const request = options(kind, `materialized-${failure}`, (value) => {
        if (selectedItems(kind, value)[0]?.id === -2 || !rejectSelection) return value;
        return withItems(kind, value, selected);
      });
      await assert.rejects(
        scan(kind, reader, request),
        failure === "late iterator error"
          ? (error) => {
              assert.equal(error, marker);
              return true;
            }
          : rejectedAs("invalid_response"),
      );
      assert.equal(iterations, 1);
      assert.deepEqual(invalid, before);
      assert.equal(selected.length, 0);
      assert.equal(store.saved.length, 1, "the rejected iterator cannot publish a second checkpoint");
      const accepted = store.saved[0];
      assert.deepEqual(accepted.value.items, prefix);
      assert.deepEqual(accepted.value.visited, visited(kind).slice(0, 1));
      assert.equal(accepted.value.next, nextCursor(kind));
      assert.equal(accepted.value.complete, false);
      assert.deepEqual(store.references[0], accepted.value, "the already accepted object must remain unchanged");
      assert.deepEqual(await store.load(accepted.key), accepted.value);
      rejectSelection = false;
      const expected = prefix.concat({ id: "accepted-after-iterator-retry" });
      assert.deepEqual(await scan(kind, reader, request), expected);
      assert.deepEqual(calls, [firstCursor(kind), nextCursor(kind), nextCursor(kind)]);
      assert.deepEqual((await store.load(accepted.key)).items, expected);
      assert.equal((await store.load(accepted.key)).complete, true);
      assert.equal(iterations, 1);
    });
  }
}
