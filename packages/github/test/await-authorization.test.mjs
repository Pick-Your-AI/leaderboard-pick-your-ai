import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const ORIGIN = "https://api.synthetic.invalid";
const QUERY = "query Items { items { nodes { id } pageInfo { hasNextPage endCursor } } }";
const denied = (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.equal(error.outcome.kind, "unsafe_request");
  assert.equal(error.message, "GitHub source request failed: unsafe_request");
  return true;
};

function setup(fetch, { writePrefix, maxRetries = 0, revokeAtWrite = 1 }) {
  let authorized = true;
  let now = 100_000;
  const sleeps = [];
  const writes = [];
  const checkpoints = {
    async load() {
      return undefined;
    },
    async save(key, value) {
      writes.push({ key, value: structuredClone(value) });
      await Promise.resolve();
      if (
        key.startsWith(writePrefix) &&
        writes.filter((write) => write.key.startsWith(writePrefix)).length === revokeAtWrite
      )
        authorized = false;
    },
  };
  const client = new GithubReadClient({
    apiOrigin: ORIGIN,
    token: async () => undefined,
    checkpoints,
    fetch,
    maxRetries,
    random: () => 0,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return {
    client,
    checkpoints,
    writes,
    sleeps,
    assertAuthorized() {
      if (!authorized) throw new Error("private host revocation must remain private");
    },
  };
}

for (const protocol of ["REST", "GraphQL"]) {
  for (const status of [429, 503]) {
    for (const maxRetries of [0, 1]) {
      test(`${protocol} ${status} denies retry-pause revocation with maxRetries=${maxRetries}`, async () => {
        let requests = 0;
        const context = setup(
          async () => {
            requests++;
            return new Response(JSON.stringify({ message: status === 429 ? "rate limit" : "outage" }), {
              status,
              headers: { "retry-after": "2" },
            });
          },
          { writePrefix: "pause:", maxRetries },
        );
        const result =
          protocol === "REST"
            ? context.client.rest("synthetic:source", "/items", context.assertAuthorized)
            : context.client.graphql("synthetic:source", QUERY, {}, context.assertAuthorized);
        await assert.rejects(result, denied);
        assert.equal(requests, 1, "denial does not retry the source");
        assert.deepEqual(context.sleeps, [], "revoked access does not wait through the saved retry pause");
        assert.equal(context.writes.length, 1, "already-started quota persistence remains durable");
      });
    }
  }

  for (const guard of ["maxPages", "repeatedPage"]) {
    test(`${protocol} checkpoint-save revocation precedes ${guard}`, async () => {
      let requests = 0;
      const acceptedPages = protocol === "GraphQL" && guard === "repeatedPage" ? 2 : 1;
      const context = setup(
        async () => {
          requests++;
          if (protocol === "REST") {
            const next = guard === "repeatedPage" ? `${ORIGIN}/items` : `${ORIGIN}/items?page=2`;
            return new Response(JSON.stringify([{ id: "accepted-before-revocation" }]), {
              headers: { link: `<${next}>; rel="next"` },
            });
          }
          return new Response(
            JSON.stringify({
              data: { items: { nodes: [{ id: requests }], pageInfo: { hasNextPage: true, endCursor: "next" } } },
            }),
          );
        },
        { writePrefix: "scan:", revokeAtWrite: acceptedPages },
      );
      const common = {
        source: "synthetic:source",
        key: `${protocol}/${guard}`,
        maxPages: guard === "maxPages" ? 1 : 3,
        assertAuthorized: context.assertAuthorized,
      };
      const result =
        protocol === "REST"
          ? context.client.scanRest({ ...common, url: "/items", select: (body) => body })
          : context.client.scanGraphql({ ...common, query: QUERY, select: (data) => data.items });
      await assert.rejects(result, denied);
      assert.equal(requests, acceptedPages, "denial prevents the next source request");
      assert.equal(context.writes.length, acceptedPages, "already-started accepted checkpoints remain durable");
      assert.equal(context.writes.at(-1).value.visited.length, acceptedPages);
    });
  }
}
