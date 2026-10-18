import assert from "node:assert/strict";
import test from "node:test";
import { startLiveUpdates } from "../dist/live-client.js";

const initial = { snapshotId: "one", revision: 1, policyVersion: "p1" };
const response = (notice = initial) =>
  new Response(JSON.stringify({ ...notice, status: "recently_reconciled" }), {
    headers: { ETag: '"health-one"' },
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const variant of ["new-snapshot", "same-revision-policy"]) {
  for (const kind of ["304", "200", "json"]) {
    test(`late ${kind} health cannot undo ${variant} stream notice`, async (t) => {
      const states = [],
        notices = [],
        listeners = new Map();
      const second = Promise.withResolvers();
      const pending = Promise.withResolvers();
      const jsonStarted = Promise.withResolvers();
      const third = Promise.withResolvers();
      let count = 0;
      const current =
        variant === "new-snapshot"
          ? { snapshotId: "two", revision: 2, policyVersion: "p2" }
          : { ...initial, policyVersion: "p2" };
      const stop = startLiveUpdates({
        intervalMs: 50,
        onState: (value) => states.push(value),
        onSnapshot: (value) => notices.push(value),
        eventSource: () => ({ addEventListener: (name, listener) => listeners.set(name, listener), close() {} }),
        fetch: async (_url, options) => {
          count++;
          if (count === 1) return response();
          if (count === 2) {
            assert.equal(options.headers["If-None-Match"], '"health-one"');
            second.resolve();
            if (kind === "json")
              return {
                ok: true,
                status: 200,
                headers: new Headers({ ETag: '"old"' }),
                json: () => {
                  jsonStarted.resolve();
                  return pending.promise;
                },
              };
            return pending.promise;
          }
          third.resolve(options);
          return response(current);
        },
      });
      t.after(stop);
      await second.promise;
      if (kind === "json") await jsonStarted.promise;
      listeners.get("reset")({ data: JSON.stringify(current) });
      assert.equal(states.at(-1).freshness, "unknown");
      pending.resolve(
        kind === "304"
          ? new Response(null, { status: 304 })
          : kind === "200"
            ? response()
            : { ...initial, status: "recently_reconciled" },
      );
      await tick();
      assert.equal(states.at(-1).freshness, "unknown");
      assert.equal(states.at(-1).checkedAt, null);
      assert.deepEqual(notices, [initial, current]);
      assert.equal(
        (await third.promise).headers["If-None-Match"],
        undefined,
        "next poll must obtain health for the new identity without an obsolete validator",
      );
    });
  }
}
