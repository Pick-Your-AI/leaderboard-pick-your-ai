import assert from "node:assert/strict";
import test from "node:test";
import { startLiveUpdates } from "../dist/live-client.js";

const health = (revision, policyVersion = `policy-${revision}`) => ({
  snapshotId: `public-${revision}`,
  revision,
  policyVersion,
  status: "recently_reconciled",
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const race of ["304", "body", "policy"]) {
  test(`stream notice supersedes in-flight ${race} health and its validator`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = new Map();
    const states = [];
    const notices = [];
    const headers = [];
    let finishResponse, finishBody;
    let calls = 0;
    const oldHealth = health(1);
    const nextHealth = race === "policy" ? health(1, "policy-new") : health(2);
    const stop = startLiveUpdates({
      intervalMs: 50,
      onState: (value) => states.push(value),
      onSnapshot: (value) => notices.push(value),
      eventSource: () => ({
        close() {},
        addEventListener(name, listener) { events.set(name, listener); },
      }),
      fetch: async (_url, init) => {
        headers.push(init.headers);
        calls++;
        if (calls === 1) return new Response(JSON.stringify(oldHealth), { headers: { ETag: '"old"' } });
        if (calls === 2) {
          if (race === "body" || race === "policy") return {
            ok: true,
            status: 200,
            headers: new Headers({ ETag: '"old"' }),
            json: () => new Promise((resolve) => { finishBody = resolve; }),
          };
          return new Promise((resolve) => { finishResponse = resolve; });
        }
        return new Response(JSON.stringify(nextHealth), { headers: { ETag: '"new"' } });
      },
    });
    t.after(stop);
    await flush();
    assert.equal(states.at(-1).freshness, "recently_reconciled");
    t.mock.timers.tick(50);
    await flush();
    assert.equal(headers[1]["If-None-Match"], '"old"');
    events.get("snapshot")({ data: JSON.stringify(nextHealth) });
    assert.equal(states.at(-1).freshness, "unknown");
    assert.equal(states.at(-1).checkedAt, null);
    if (race === "304") finishResponse(new Response(null, { status: 304 }));
    else finishBody(oldHealth);
    await flush();
    assert.equal(states.at(-1).freshness, "unknown", "superseded health cannot mark the new notice fresh");
    assert.equal(notices.length, 2, "an old policy cannot replace the streamed policy");
    assert.equal(notices.at(-1).policyVersion, nextHealth.policyVersion);
    t.mock.timers.tick(50);
    await flush();
    assert.equal(headers[2]["If-None-Match"], undefined, "new snapshot requires unconditional health validation");
    assert.equal(states.at(-1).freshness, "recently_reconciled");
    assert.equal(notices.length, 2);
  });
}
