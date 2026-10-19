import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { decryptBackup, encryptBackup, restoreBackup } from "../backup.mjs";

const now = "2026-10-19T09:00:00.000Z";
const state = { snapshot: "synthetic-state-12", corrections: ["synthetic-correction-2"] };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function input() {
  return {
    key: randomBytes(32),
    databaseDump: Buffer.from("synthetic PostgreSQL recovery dump\n"),
    configuration: { repositories: ["synthetic"] },
    policyVersions: ["synthetic-policy/v1"],
    watermarks: { synthetic: "cursor:12" },
    createdAt: now,
    sourceCutoff: "2026-10-19T08:59:00.000Z",
    expiresAt: "2026-10-20T09:00:00.000Z",
  };
}

// Reproduce a v1 payload accepted before serialized required-state validation.
// Its ciphertext, AAD and both digests are valid; only the required state differs.
function legacyEnvelope(source, changes) {
  const { iv: unusedIv, tag: unusedTag, ciphertext: unusedCiphertext, ...metadata } = encryptBackup(source);
  const payload = Buffer.from(
    JSON.stringify({
      databaseDump: source.databaseDump.toString("base64"),
      configuration: source.configuration,
      policyVersions: source.policyVersions,
      watermarks: source.watermarks,
      ...changes,
    }),
  );
  metadata.payloadSha256 = digest(payload);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", source.key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    ...metadata,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function restoreArgs(source, envelope, operations) {
  return {
    envelope,
    key: source.key,
    now,
    expectedState: state,
    observedSourceCutoff: now,
    assertEmptyTarget: async () => operations.push("empty"),
    restoreDatabase: async () => operations.push("restore"),
    reapplySuppressions: async () => operations.push("suppress"),
    inspectRestoredState: async () => {
      operations.push("inspect");
      return state;
    },
  };
}

test("valid custom required-state serializers run once and retain their serialized values", async () => {
  const source = input();
  const calls = { configuration: 0, policyVersions: 0, watermarks: 0 };
  source.configuration = {
    toJSON() {
      calls.configuration += 1;
      return { repositories: ["serialized-synthetic"] };
    },
  };
  source.policyVersions.toJSON = () => {
    calls.policyVersions += 1;
    return ["synthetic-policy/v2"];
  };
  source.watermarks = {
    toJSON() {
      calls.watermarks += 1;
      return { synthetic: "cursor:13" };
    },
  };
  const envelope = encryptBackup(source);
  const decoded = decryptBackup(envelope, { key: source.key, now });
  assert.deepEqual(decoded.databaseDump, source.databaseDump);
  assert.deepEqual(decoded.configuration, { repositories: ["serialized-synthetic"] });
  assert.deepEqual(decoded.policyVersions, ["synthetic-policy/v2"]);
  assert.deepEqual(decoded.watermarks, { synthetic: "cursor:13" });
  const operations = [];
  const receipt = await restoreBackup(restoreArgs(source, envelope, operations));
  assert.deepEqual(operations, ["empty", "restore", "suppress", "inspect"]);
  assert.equal(receipt.watermarksSha256, digest(JSON.stringify({ synthetic: "cursor:13" })));
  assert.equal(receipt.postBackupDataLoss, null);
  assert.deepEqual(calls, { configuration: 1, policyVersions: 1, watermarks: 1 });
});

test("required input guards still reject before invoking caller serializers", () => {
  for (const change of [{ policyVersions: [] }, { watermarks: null }]) {
    const source = { ...input(), ...change };
    let calls = 0;
    source.configuration = {
      toJSON() {
        calls += 1;
        throw new Error("the invalid input must be rejected first");
      },
    };
    assert.throws(() => encryptBackup(source), /Configuration|Source watermarks/);
    assert.equal(calls, 0);
  }
});

test("encryption rejects configuration serialized to null", () => {
  const source = input();
  source.configuration = { toJSON: () => null };
  assert.throws(() => encryptBackup(source), /Configuration and required policy versions/);
});

test("encryption rejects policy versions emptied by the preceding configuration serializer", () => {
  const source = input();
  source.configuration = {
    toJSON() {
      source.policyVersions.length = 0;
      return { repositories: ["synthetic"] };
    },
  };
  assert.throws(() => encryptBackup(source), /Configuration and required policy versions/);
});

test("encryption rejects a policy serializer producing an empty array or a non-array", () => {
  for (const serialized of [[], {}]) {
    const source = input();
    source.policyVersions.toJSON = () => serialized;
    assert.throws(() => encryptBackup(source), /Configuration and required policy versions/);
  }
});

test("encryption rejects source watermarks omitted by serialization", () => {
  const source = input();
  source.watermarks = { toJSON: () => undefined };
  assert.throws(() => encryptBackup(source), /Source watermarks/);
});

test("encryption rejects source watermarks serialized to an array", () => {
  const source = input();
  source.watermarks = { toJSON: () => [] };
  assert.throws(() => encryptBackup(source), /Source watermarks/);
});

for (const [description, changes, error] of [
  ["null configuration", { configuration: null }, /Configuration and required policy versions/],
  ["empty policy versions", { policyVersions: [] }, /Configuration and required policy versions/],
  ["missing source watermarks", { watermarks: undefined }, /Source watermarks/],
  ["array source watermarks", { watermarks: [] }, /Source watermarks/],
]) {
  test(`authenticated legacy ${description} is rejected before any restore callback`, async () => {
    const source = input();
    const envelope = legacyEnvelope(source, changes);
    assert.throws(() => decryptBackup(envelope, { key: source.key, now }), error);
    const operations = [];
    await assert.rejects(restoreBackup(restoreArgs(source, envelope, operations)), error);
    assert.deepEqual(operations, []);
  });
}
