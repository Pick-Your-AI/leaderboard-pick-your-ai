import assert from "node:assert/strict";
import test from "node:test";
import { startLiveUpdates } from "../dist/live-client.js";
import { canonicalPublicScope } from "../../../packages/contracts/dist/index.js";
import { legacyScope } from "../../../tests/fixtures/public-scope.mjs";

const scope = canonicalPublicScope({
  ...legacyScope,
  context: "current",
  projects: ["PVT_A"],
  roles: ["author"],
});
const initial = {
  schemaVersion: "public-read/v3",
  snapshotSchemaVersion: "leaderboard/v1",
  snapshotId: "notice-one",
  revision: 1,
  policyVersion: "notice-policy",
  scope,
};
const current = { ...initial, snapshotId: "notice-two", revision: 2 };
const identity = ({ snapshotId, revision, policyVersion }) => ({ snapshotId, revision, policyVersion });
const health = (notice, etag) =>
  new Response(JSON.stringify({ ...notice, status: "recently_reconciled" }), { headers: { ETag: etag } });
const until = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("live notice validation did not settle");
};
const validate = (value) => {
  assert.equal(value.schemaVersion, "public-read/v3");
  assert.equal(value.snapshotSchemaVersion, "leaderboard/v1");
  assert.deepEqual(value.scope, scope);
};
const invalid = (kind) => ({
  ...initial,
  snapshotId: "rejected-high-revision",
  revision: 1000000,
  ...(kind === "scope" ? { scope: { ...scope, projects: ["PVT_OTHER"] } } : { schemaVersion: "public-read/v2" }),
});

for (const kind of ["scope", "version"]) {
  for (const eventName of ["snapshot", "reset"]) {
    test(`rejected ${kind} ${eventName} cannot poison an in-flight validator or later lower revision`, async (t) => {
      const states = [],
        notices = [],
        requests = [],
        validated = [],
        events = new Map();
      const second = Promise.withResolvers();
      const pending = Promise.withResolvers();
      let closes = 0,
        connection;
      const stop = startLiveUpdates({
        intervalMs: 50,
        onState: (value) => states.push(value),
        onSnapshot: (value) => notices.push(value),
        validateNotice(value) {
          validated.push(value);
          validate(value);
        },
        eventSource: () => {
          connection = {
            close() {
              closes++;
            },
            addEventListener: (name, listener) => events.set(name, listener),
          };
          return connection;
        },
        fetch: async (_url, options) => {
          requests.push(options);
          if (requests.length === 1) return health(initial, '"notice-one"');
          if (requests.length === 2) {
            second.resolve();
            return pending.promise;
          }
          return health(current, '"notice-two"');
        },
      });
      t.after(() => {
        stop();
        pending.resolve(new Response(null, { status: 304 }));
      });
      await second.promise;
      connection.onopen();
      const priorState = { ...states.at(-1) };
      events.get(eventName)({ data: JSON.stringify(invalid(kind)) });
      assert.deepEqual(notices, [identity(initial)], "unvalidated input cannot request a snapshot refetch");
      assert.equal(validated.at(-1).snapshotId, "rejected-high-revision");
      assert.equal(closes, 1, "rejected notices retain the existing stream-to-polling fallback");
      assert.deepEqual(states.at(-1), { ...priorState, transport: "polling" });
      const emitted = states.length;
      pending.resolve(new Response(null, { status: 304 }));
      await until(() => states.length > emitted);
      assert.equal(states.at(-1).freshness, "recently_reconciled", "the prior verified health identity survives");
      assert.equal(requests[1].headers["If-None-Match"], '"notice-one"');
      await until(() => notices.length === 2);
      assert.deepEqual(
        notices,
        [identity(initial), identity(current)],
        "a valid lower revision must still be accepted",
      );
      assert.equal(requests[2].headers["If-None-Match"], '"notice-one"', "rejection must not clear the valid ETag");
      assert.equal(states.at(-1).freshness, "recently_reconciled");
      assert.equal(states.at(-1).transport, "polling");
    });
  }

  test(`rejected ${kind} health cannot install a revision or ETag before a valid lower response`, async (t) => {
    const states = [],
      notices = [],
      requests = [],
      order = [];
    const stop = startLiveUpdates({
      intervalMs: 50,
      onState: (value) => states.push(value),
      onSnapshot: (value) => {
        order.push(`snapshot:${value.snapshotId}`);
        notices.push(value);
      },
      validateHealth(body) {
        order.push(`health:${body.snapshotId}`);
        assert.equal(body.status, "recently_reconciled");
      },
      validateNotice(value) {
        order.push(`notice:${value.snapshotId}`);
        validate(value);
      },
      eventSource: () => ({ close() {}, addEventListener() {} }),
      fetch: async (_url, options) => {
        requests.push(options);
        return requests.length === 1
          ? health(invalid(kind), '"rejected-high-revision"')
          : health(current, '"notice-two"');
      },
    });
    t.after(stop);
    await until(() => states.at(-1).transport === "unavailable" || notices.length);
    assert.deepEqual(notices, []);
    assert.equal(states.at(-1).freshness, "unknown");
    await until(() => notices.length === 1);
    assert.deepEqual(notices, [identity(current)]);
    assert.equal(requests[1].headers["If-None-Match"], undefined, "rejected health cannot install a validator");
    assert.deepEqual(order.slice(0, 5), [
      "health:rejected-high-revision",
      "notice:rejected-high-revision",
      "health:notice-two",
      "notice:notice-two",
      "snapshot:notice-two",
    ]);
    assert.equal(states.at(-1).freshness, "recently_reconciled");
  });
}
