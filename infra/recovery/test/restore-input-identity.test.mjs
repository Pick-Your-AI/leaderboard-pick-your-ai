import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { encryptBackup, restoreBackup } from "../backup.mjs";

const now = "2026-10-17T12:00:00.000Z";
const state = { snapshot: "synthetic-revision-12", corrections: ["synthetic-correction-2"] };
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const key = randomBytes(32);
  const originalDump = Buffer.from(
    "-- selected recovery point\nCREATE TABLE synthetic(id int); INSERT INTO synthetic VALUES(1);",
  );
  const replacementDump = Buffer.from(
    "-- other recovery point\nCREATE TABLE synthetic(id int); INSERT INTO synthetic VALUES(1);",
  );
  const input = {
    key,
    databaseDump: originalDump,
    configuration: { repositories: ["synthetic"] },
    policyVersions: ["synthetic-policy/v1"],
    watermarks: { synthetic: "cursor:12" },
    createdAt: now,
    sourceCutoff: "2026-10-17T11:59:00Z",
    expiresAt: "2026-10-18T12:00:00Z",
  };
  const envelope = encryptBackup(input);
  const replacement = encryptBackup({ ...input, databaseDump: replacementDump });
  const operations = [];
  let restoredDump;
  const args = {
    envelope,
    key,
    now,
    observedSourceCutoff: now,
    expectedState: state,
    assertEmptyTarget: async () => {
      operations.push("empty");
    },
    restoreDatabase: async (dump) => {
      operations.push("restore");
      restoredDump = Buffer.from(dump);
    },
    reapplySuppressions: async () => {
      operations.push("suppress");
    },
    inspectRestoredState: async () => {
      operations.push("inspect");
      return state;
    },
  };
  return { args, envelope, replacement, key, originalDump, replacementDump, operations, restored: () => restoredDump };
}

async function verifySelected(t, f) {
  const receipt = await restoreBackup(f.args);
  t.diagnostic(
    JSON.stringify({
      selectedDumpSha256: digest(f.originalDump),
      restoredDumpSha256: digest(f.restored()),
      receiptDumpSha256: receipt.restoredDumpSha256,
      operations: f.operations,
    }),
  );
  assert.deepEqual(f.operations, ["empty", "restore", "suppress", "inspect"]);
  assert.equal(digest(f.restored()), digest(f.originalDump), "the database callback must receive the selected dump");
  assert.equal(receipt.restoredDumpSha256, digest(f.originalDump), "the receipt must identify the selected dump");
}

test("ordinary expected state restores the selected backup", async (t) => {
  await verifySelected(t, fixture());
});

test("serializable expected state is supported and serialized once", async (t) => {
  const f = fixture();
  let serializations = 0;
  f.args.expectedState = {
    toJSON() {
      serializations += 1;
      return state;
    },
  };
  await verifySelected(t, f);
  assert.equal(serializations, 1);
});

test("expected-state serialization cannot replace the selected authenticated envelope", async (t) => {
  const f = fixture();
  let serializations = 0;
  f.args.expectedState = {
    toJSON() {
      serializations += 1;
      Object.assign(f.envelope, f.replacement);
      return state;
    },
  };
  await verifySelected(t, f);
  assert.equal(serializations, 1);
  assert.notEqual(digest(f.originalDump), digest(f.replacementDump));
});

test("expected-state serialization cannot change the selected key bytes", async (t) => {
  const f = fixture();
  let serializations = 0;
  f.args.expectedState = {
    toJSON() {
      serializations += 1;
      f.key.fill(0);
      return state;
    },
  };
  await verifySelected(t, f);
  assert.equal(serializations, 1);
  assert.deepEqual(f.key, Buffer.alloc(32));
});

test("an invalid selected backup cannot be repaired by an expected-state serializer", async () => {
  const f = fixture();
  const validEnvelope = { ...f.envelope };
  const corrupted = Buffer.from(f.envelope.ciphertext, "base64");
  corrupted[0] ^= 1;
  f.envelope.ciphertext = corrupted.toString("base64");
  let serializations = 0;
  f.args.expectedState = {
    toJSON() {
      serializations += 1;
      Object.assign(f.envelope, validEnvelope);
      return state;
    },
  };
  await assert.rejects(restoreBackup(f.args));
  assert.equal(serializations, 0);
  assert.deepEqual(f.operations, []);
});

test("expected-state serialization cannot change authenticated dump bytes through a caller buffer pool", () => {
  // Isolate deliberate pool mutation from the test runner's own pooled IPC buffers.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { createHash } from "node:crypto";
        const { encryptBackup, restoreBackup } = await import(process.argv[1]);
        const expectedState = JSON.parse(process.argv[2]);
        const now = "2026-10-17T12:00:00.000Z";
        const text = "synthetic PostgreSQL selected recovery dump\\n";
        // Expected bytes and key must not share the slab that the serializer changes.
        const expectedDump = Buffer.alloc(Buffer.byteLength(text));
        expectedDump.write(text);
        const key = Buffer.alloc(32, 7);
        const hash = (value) => createHash("sha256").update(value).digest("hex");
        const expectedDigest = hash(expectedDump);
        const envelope = encryptBackup({
          databaseDump: expectedDump,
          key,
          configuration: { repositories: ["synthetic"] },
          policyVersions: ["synthetic-policy/v1"],
          watermarks: { synthetic: "cursor:12" },
          createdAt: now,
          sourceCutoff: "2026-10-17T11:59:00Z",
          expiresAt: "2026-10-18T12:00:00Z",
        });
        assert.equal(envelope.dumpSha256, expectedDigest);
        const fixtureBytes = Buffer.byteLength(JSON.stringify(envelope));
        const poolSize = Buffer.poolSize;
        assert.ok(Number.isSafeInteger(poolSize) && poolSize > 0);
        assert.ok(fixtureBytes * 8 < poolSize, "the synthetic fixture must fit comfortably in a fresh slab");
        const previousBacking = Buffer.allocUnsafe(1).buffer;
        let guard;
        for (let attempt = 0; attempt <= poolSize; attempt++) {
          const candidate = Buffer.allocUnsafe(1);
          if (candidate.buffer !== previousBacking) {
            guard = candidate;
            break;
          }
        }
        assert.ok(guard, "a fresh caller slab must be reached within the allocation bound");
        assert.ok(guard.buffer.byteLength - guard.byteOffset > fixtureBytes * 8);
        const operations = [];
        let serializations = 0;
        let restoredDump, restoredSharesCallerSlab;
        const receipt = await restoreBackup({
          envelope,
          key,
          now,
          expectedDumpSha256: expectedDigest,
          observedSourceCutoff: now,
          expectedState: {
            toJSON() {
              serializations++;
              const currentPoolProbe = Buffer.allocUnsafe(1);
              assert.equal(currentPoolProbe.buffer, guard.buffer, "the attack must still target the selected fresh slab");
              new Uint8Array(guard.buffer).fill(0x58);
              return expectedState;
            },
          },
          assertEmptyTarget: async () => {
            operations.push("empty");
          },
          restoreDatabase: async (dump) => {
            operations.push("restore");
            restoredSharesCallerSlab = dump.buffer === guard.buffer;
            restoredDump = Buffer.alloc(dump.length);
            restoredDump.set(dump);
          },
          reapplySuppressions: async () => {
            operations.push("suppress");
          },
          inspectRestoredState: async () => {
            operations.push("inspect");
            return expectedState;
          },
        });
        assert.equal(serializations, 1);
        assert.equal(guard[0], 0x58, "the serializer must actually mutate the caller slab");
        assert.deepEqual(operations, ["empty", "restore", "suppress", "inspect"]);
        assert.deepEqual(
          restoredDump,
          expectedDump,
          "selected restore bytes changed; callback shared caller slab=" + restoredSharesCallerSlab,
        );
        assert.equal(hash(restoredDump), expectedDigest);
        assert.equal(receipt.restoredDumpSha256, expectedDigest);
        assert.equal(receipt.restoredDumpSha256, hash(restoredDump));
        process.stdout.write("isolated restore dump snapshot verified\\n");
      `,
      new URL("../backup.mjs", import.meta.url).href,
      JSON.stringify(state),
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "isolated restore dump snapshot verified\n");
});
