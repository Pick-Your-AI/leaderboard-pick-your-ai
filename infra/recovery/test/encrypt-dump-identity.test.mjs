import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { decryptBackup, encryptBackup } from "../backup.mjs";

const payloadValues = {
  configuration: { version: "synthetic-config-v1" },
  policyVersions: ["synthetic-policy-v1"],
  watermarks: { source: "synthetic-cursor" },
};

function fixture() {
  return {
    databaseDump: Buffer.from("synthetic PostgreSQL recovery dump\n"),
    ...structuredClone(payloadValues),
    key: randomBytes(32),
    createdAt: "2026-10-19T00:00:00Z",
    expiresAt: "2026-10-20T00:00:00Z",
    sourceCutoff: "2026-10-19T00:00:00Z",
  };
}

function serializable(value, toJSON) {
  return Object.assign(Array.isArray(value) ? [...value] : { ...value }, { toJSON });
}

function verifyRoundTrip(envelope, input, expectedDump) {
  const expectedDigest = createHash("sha256").update(expectedDump).digest("hex");
  const decoded = decryptBackup(envelope, {
    key: input.key,
    now: "2026-10-19T01:00:00Z",
    expectedDumpSha256: expectedDigest,
  });
  assert.deepEqual(decoded.databaseDump, expectedDump);
  assert.equal(envelope.dumpSha256, expectedDigest);
  for (const field of Object.keys(payloadValues)) assert.deepEqual(decoded[field], payloadValues[field]);
}

test("backup encryption preserves valid payload serializers and invokes each once", () => {
  const input = fixture();
  const expectedDump = Buffer.from(input.databaseDump);
  const serializations = {};
  for (const [field, value] of Object.entries(payloadValues)) {
    serializations[field] = 0;
    input[field] = serializable(value, () => {
      serializations[field] += 1;
      return value;
    });
  }
  const envelope = encryptBackup(input);
  verifyRoundTrip(envelope, input, expectedDump);
  assert.deepEqual(serializations, { configuration: 1, policyVersions: 1, watermarks: 1 });
});

for (const [field, value] of Object.entries(payloadValues)) {
  test(`backup encryption binds one dump snapshot across ${field} serialization`, () => {
    const input = fixture();
    const expectedDump = Buffer.from(input.databaseDump);
    let serializations = 0;
    input[field] = serializable(value, () => {
      serializations += 1;
      input.databaseDump.fill(0x58);
      return value;
    });
    const envelope = encryptBackup(input);
    assert.equal(serializations, 1);
    assert.notDeepEqual(input.databaseDump, expectedDump);
    verifyRoundTrip(envelope, input, expectedDump);
  });
}

test("backup encryption isolates the dump snapshot from the caller's backing ArrayBuffer", () => {
  // Isolate deliberate pool mutation from the test runner's own pooled IPC buffers.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { createHash } from "node:crypto";
        const { decryptBackup, encryptBackup } = await import(process.argv[1]);
        const values = JSON.parse(process.argv[2]);
        const databaseDump = Buffer.from("synthetic PostgreSQL recovery dump\\n");
        // The expected bytes and key must not share the caller's pooled allocation.
        const expectedDump = Buffer.alloc(databaseDump.length);
        expectedDump.set(databaseDump);
        const key = Buffer.alloc(32, 7);
        assert.ok(databaseDump.buffer.byteLength > databaseDump.length);
        let serializations = 0;
        const envelope = encryptBackup({
          ...values,
          databaseDump,
          key,
          createdAt: "2026-10-19T00:00:00Z",
          expiresAt: "2026-10-20T00:00:00Z",
          sourceCutoff: "2026-10-19T00:00:00Z",
          configuration: {
            toJSON() {
              serializations += 1;
              new Uint8Array(databaseDump.buffer).fill(0x58);
              return values.configuration;
            },
          },
        });
        assert.equal(serializations, 1);
        assert.notDeepEqual(databaseDump, expectedDump);
        const expectedDigest = createHash("sha256").update(expectedDump).digest("hex");
        const decoded = decryptBackup(envelope, {
          key,
          now: "2026-10-19T01:00:00Z",
          expectedDumpSha256: expectedDigest,
        });
        assert.deepEqual(decoded.databaseDump, expectedDump);
        assert.equal(envelope.dumpSha256, expectedDigest);
        for (const field of Object.keys(values)) assert.deepEqual(decoded[field], values[field]);
        process.stdout.write("isolated dump snapshot verified\\n");
      `,
      new URL("../backup.mjs", import.meta.url).href,
      JSON.stringify(payloadValues),
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "isolated dump snapshot verified\n");
});
