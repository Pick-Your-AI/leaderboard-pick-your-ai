import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { GithubClientError, GithubReadClient } from "../dist/index.js";

const cases = [
  { name: "oversized success", status: 200, kind: "invalid_response" },
  { name: "redirect rejection", status: 302, kind: "unsafe_request" },
  { name: "oversized rate-limit response", status: 429, kind: "rate_limited" },
];

for (const protocol of ["REST", "GraphQL"]) {
  for (const scenario of cases) {
    for (const cleanup of ["resolve", "reject"]) {
      test(
        `${protocol} ${scenario.name} releases its slot before slow cleanup ${cleanup}s`,
        { timeout: 5000 },
        async () => {
          const cancellation = Promise.withResolvers();
          const cancelStarted = Promise.withResolvers();
          const writes = [];
          let cancelCalls = 0;
          let fetchCalls = 0;
          let rejectedSettled = false;
          let siblingSettled = false;
          const client = new GithubReadClient({
            apiOrigin: "https://api.synthetic.invalid",
            token: async () => undefined,
            checkpoints: {
              load: async () => undefined,
              save: async (key, value) => writes.push({ key, value: structuredClone(value) }),
            },
            concurrency: 1,
            maxRetries: 0,
            maxResponseBytes: 8,
            now: () => 1_000_000,
            random: () => 0,
            sleep: async () => {
              throw new Error("The unrelated source must not wait on this source's quota");
            },
            fetch: async () => {
              fetchCalls += 1;
              if (fetchCalls > 1) return Response.json({ ok: 1 });
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(9));
                  },
                  cancel() {
                    cancelCalls += 1;
                    cancelStarted.resolve();
                    return cancellation.promise;
                  },
                }),
                { status: scenario.status },
              );
            },
          });
          const request =
            protocol === "REST"
              ? client.rest("source:a", "/items")
              : client.graphql("source:a", "query Items { items }");
          const rejected = request.then(
            (value) => ({ value }),
            (error) => {
              rejectedSettled = true;
              return { error };
            },
          );
          await cancelStarted.promise;
          const sibling = client.rest("source:b", "/other").then((value) => {
            siblingSettled = true;
            return value;
          });
          // Drain actual request microtasks while keeping the transport cleanup
          // unresolved. No elapsed-time performance threshold is asserted.
          await nextTurn();
          const beforeCleanup = { rejectedSettled, siblingSettled, fetchCalls };
          if (cleanup === "resolve") cancellation.resolve();
          else cancellation.reject(new Error("private cleanup details"));
          const outcome = await rejected;
          assert.deepEqual(await sibling, { ok: 1 });
          await nextTurn();
          assert.ok(outcome.error instanceof GithubClientError);
          assert.equal(outcome.error.outcome.kind, scenario.kind);
          assert.equal(outcome.error.message, `GitHub source request failed: ${scenario.kind}`);
          assert.equal(cancelCalls, 1);
          assert.equal(fetchCalls, 2, "the rejected response is not retried");
          assert.equal(
            writes.some(({ key }) => key.startsWith("http:") || key.startsWith("scan:")),
            false,
          );
          assert.equal(writes.filter(({ key }) => key.startsWith("pause:")).length, scenario.status === 429 ? 1 : 0);
          assert.deepEqual(beforeCleanup, { rejectedSettled: true, siblingSettled: true, fetchCalls: 2 });
        },
      );
    }
  }
}
