import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../../apps/controls/src/store.mjs";
import { expireControlsAuthentication } from "../controls-expiry.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-expiry-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  store.transaction((s) => {
    s.sessions = {
      expired: { expires: 99, csrf: "private-session-token" },
      boundary: { expires: 100 },
      live: { expires: 101 },
      unknown: { expires: "99" },
    };
    s.oauth = { expired: { expires: 1, verifier: "private-verifier" }, live: { expires: 102 } };
  });
  return store;
}
const options = { receiptId: "synthetic-expiry", cutoff: 100, now: () => 100, authorize: async () => true };
test("expiry deletes only expired authentication records and persists minimized idempotent receipt", async (t) => {
  const store = fixture(t);
  const publication = store.publicSnapshot();
  const receipt = await expireControlsAuthentication(store, options);
  assert.equal(receipt.sessions, 2);
  assert.equal(receipt.oauth, 1);
  assert.deepEqual(Object.keys(store.read().sessions), ["live", "unknown"]);
  assert.deepEqual(Object.keys(store.read().oauth), ["live"]);
  assert.deepEqual(store.publicSnapshot(), publication);
  assert.doesNotMatch(JSON.stringify(receipt), /private|csrf|verifier|expired/);
  assert.deepEqual(await expireControlsAuthentication(store, options), receipt);
  await assert.rejects(expireControlsAuthentication(store, { ...options, cutoff: 99 }), /receipt_conflict/);
});
test("denied authority and future cutoffs never delete or issue a receipt", async (t) => {
  const store = fixture(t),
    before = store.read();
  await assert.rejects(
    expireControlsAuthentication(store, { ...options, authorize: async () => false }),
    /not_authorized/,
  );
  await assert.rejects(expireControlsAuthentication(store, { ...options, cutoff: 101 }), /invalid_/);
  assert.deepEqual(store.read(), before);
});
test("records refreshed while authorization awaits remain intact", async (t) => {
  const store = fixture(t);
  await expireControlsAuthentication(store, {
    ...options,
    authorize: async () => {
      store.transaction((s) => {
        s.sessions.expired.expires = 200;
      });
      return true;
    },
  });
  assert.equal(store.read().sessions.expired.expires, 200);
});
test("receipt storage failure rolls back deletions", async (t) => {
  const store = fixture(t),
    before = store.read();
  const broken = {
    transaction(change) {
      return store.transaction((state) => {
        change(state);
        throw new Error("synthetic-failure");
      });
    },
  };
  await assert.rejects(expireControlsAuthentication(broken, options), /synthetic-failure/);
  assert.deepEqual(store.read(), before);
});
