import assert from "node:assert/strict";
import { createHash, createSecretKey } from "node:crypto";
import test from "node:test";
import { decryptBackup, encryptBackup } from "../backup.mjs";

const values = {
  configuration: { version: "synthetic-config-v1" },
  policyVersions: ["synthetic-policy-v1"],
  watermarks: { source: "synthetic-cursor" },
};
const now = "2026-10-19T01:00:00Z";

function fixture() {
  return {
    databaseDump: Buffer.from("synthetic PostgreSQL recovery dump\n"),
    ...structuredClone(values),
    key: Buffer.alloc(32, 0x17),
    createdAt: "2026-10-19T00:00:00Z",
    expiresAt: "2026-10-20T00:00:00Z",
    sourceCutoff: "2026-10-19T00:00:00Z",
  };
}

function copyBytes(bytes) {
  const copy = Buffer.alloc(bytes.length);
  copy.set(bytes);
  return copy;
}

function verify(envelope, key, dump) {
  const decoded = decryptBackup(envelope, {
    key,
    now,
    expectedDumpSha256: createHash("sha256").update(dump).digest("hex"),
  });
  assert.deepEqual(decoded.databaseDump, dump);
  for (const field of Object.keys(values)) assert.deepEqual(decoded[field], values[field]);
}

test("backup encryption preserves the supplied key and valid serializers run once", () => {
  const input = fixture();
  const expectedKey = copyBytes(input.key);
  const expectedDump = copyBytes(input.databaseDump);
  const calls = {};
  for (const [field, value] of Object.entries(values)) {
    calls[field] = 0;
    input[field] = Object.assign(Array.isArray(value) ? [...value] : { ...value }, {
      toJSON() {
        calls[field] += 1;
        return value;
      },
    });
  }
  const envelope = encryptBackup(input);
  assert.deepEqual(input.key, expectedKey);
  assert.deepEqual(calls, { configuration: 1, policyVersions: 1, watermarks: 1 });
  verify(envelope, expectedKey, expectedDump);
});

test("backup encryption still rejects invalid public key inputs before serialization", () => {
  for (const key of [Buffer.alloc(31), Buffer.alloc(33), createSecretKey(Buffer.alloc(32))]) {
    const input = fixture();
    input.key = key;
    let calls = 0;
    input.configuration = {
      toJSON() {
        calls += 1;
        return values.configuration;
      },
    };
    assert.throws(() => encryptBackup(input), /Backup key must be exactly 32 bytes/);
    assert.equal(calls, 0);
  }
});

for (const [field, value] of Object.entries(values)) {
  test(`backup encryption binds the supplied key across ${field} serialization`, () => {
    const input = fixture();
    const expectedKey = copyBytes(input.key);
    const expectedDump = copyBytes(input.databaseDump);
    let calls = 0;
    input[field] = Object.assign(Array.isArray(value) ? [...value] : { ...value }, {
      toJSON() {
        calls += 1;
        input.key.fill(0x29);
        return value;
      },
    });
    const envelope = encryptBackup(input);
    assert.equal(calls, 1);
    assert.notDeepEqual(input.key, expectedKey);
    verify(envelope, expectedKey, expectedDump);
    assert.throws(() => decryptBackup(envelope, { key: input.key, now }));
  });
}

test("backup encryption isolates the supplied key from caller-owned backing memory", () => {
  const input = fixture();
  // Separate key and dump ranges deliberately share only this fixture's allocation.
  const backing = new ArrayBuffer(128);
  const expectedDump = copyBytes(input.databaseDump);
  input.key = Buffer.from(backing, 0, 32);
  input.key.fill(0x17);
  input.databaseDump = Buffer.from(backing, 64, expectedDump.length);
  input.databaseDump.set(expectedDump);
  const expectedKey = copyBytes(input.key);
  assert.equal(input.key.buffer, input.databaseDump.buffer);
  let calls = 0;
  input.configuration = {
    toJSON() {
      calls += 1;
      new Uint8Array(input.databaseDump.buffer).fill(0x58);
      return values.configuration;
    },
  };
  const envelope = encryptBackup(input);
  assert.equal(calls, 1);
  assert.notDeepEqual(input.key, expectedKey);
  assert.notDeepEqual(input.databaseDump, expectedDump);
  verify(envelope, expectedKey, expectedDump);
  assert.throws(() => decryptBackup(envelope, { key: input.key, now }));
});
