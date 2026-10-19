import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { encryptBackup, restoreBackup } from "../backup.mjs";

const expectedState = { snapshot: "synthetic-snapshot-2", corrections: ["synthetic-correction-1"] };
const otherState = { snapshot: "synthetic-other-snapshot", corrections: [] };
const expectedDigest = createHash("sha256")
  .update('{"corrections":["synthetic-correction-1"],"snapshot":"synthetic-snapshot-2"}')
  .digest("hex");

function fixture(inspected) {
  const key = randomBytes(32);
  const dump = Buffer.from("synthetic isolated restore dump");
  const operations = [];
  const run = () =>
    restoreBackup({
      envelope: encryptBackup({
        key,
        databaseDump: dump,
        configuration: {},
        policyVersions: ["synthetic/v1"],
        watermarks: {},
        createdAt: "2026-10-17T12:00:00Z",
        sourceCutoff: "2026-10-17T11:59:00Z",
        expiresAt: "2026-10-18T12:00:00Z",
      }),
      key,
      now: "2026-10-17T12:02:00Z",
      observedSourceCutoff: "2026-10-17T11:59:00Z",
      expectedState,
      assertEmptyTarget: async () => operations.push("empty"),
      restoreDatabase: async (restored) => {
        assert.deepEqual(restored, dump);
        operations.push("restore");
      },
      reapplySuppressions: async () => operations.push("suppress"),
      inspectRestoredState: async () => {
        operations.push("inspect");
        return inspected;
      },
    });
  return { run, operations };
}

test("a restore receipt hashes the inspected state that passed equality verification", async () => {
  let serializations = 0;
  const h = fixture({
    toJSON() {
      return ++serializations === 1 ? expectedState : otherState;
    },
  });
  const receipt = await h.run();
  assert.equal(receipt.restoredStateSha256, expectedDigest);
  assert.equal(serializations, 1);
  assert.deepEqual(h.operations, ["empty", "restore", "suppress", "inspect"]);
});

test("restore does not reserialize an already verified inspection result", async () => {
  let serializations = 0;
  const h = fixture({
    toJSON() {
      if (++serializations !== 1) throw new Error("Synthetic inspection result was serialized again");
      return expectedState;
    },
  });
  const receipt = await h.run();
  assert.equal(receipt.restoredStateSha256, expectedDigest);
  assert.equal(serializations, 1);
  assert.deepEqual(h.operations, ["empty", "restore", "suppress", "inspect"]);
});

test("restore rejects an inspected mismatch even if a later serialization would match", async () => {
  let serializations = 0;
  const h = fixture({
    toJSON() {
      return ++serializations === 1 ? otherState : expectedState;
    },
  });
  await assert.rejects(h.run(), /Restored state does not match/);
  assert.equal(serializations, 1);
  assert.deepEqual(h.operations, ["empty", "restore", "suppress", "inspect"]);
});
