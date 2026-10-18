import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encryptBackup, decryptBackup, writeBackup, expireBackups, restoreBackup } from "../backup.mjs";

const key = randomBytes(32);
const now = "2026-10-17T12:00:00.000Z";
const input = () => ({
  key,
  databaseDump: Buffer.from("CREATE TABLE synthetic(id int); INSERT INTO synthetic VALUES(1);"),
  configuration: { repos: ["synthetic"] },
  policyVersions: ["synthetic-policy/v1"],
  watermarks: { synthetic: "cursor:12" },
  createdAt: now,
  sourceCutoff: "2026-10-17T11:59:00Z",
  expiresAt: "2026-10-18T12:00:00Z",
});

test("authenticated backup round-trips database, configuration, policies and watermarks", () => {
  const source = input();
  const envelope = encryptBackup(source);
  assert.equal(JSON.stringify(envelope).includes("CREATE TABLE"), false);
  assert.equal(JSON.stringify(envelope).includes("cursor:12"), false);
  const decoded = decryptBackup(envelope, { key, now });
  assert.deepEqual(decoded.databaseDump, source.databaseDump);
  assert.deepEqual(decoded.configuration, source.configuration);
  assert.deepEqual(decoded.policyVersions, source.policyVersions);
  assert.deepEqual(decoded.watermarks, source.watermarks);
  assert.notEqual(encryptBackup(source).iv, envelope.iv);
});

test("wrong key, corrupted ciphertext, metadata edits, expiry and revision mismatch fail closed", () => {
  const envelope = encryptBackup(input());
  assert.throws(() => decryptBackup(envelope, { key: randomBytes(32), now }));
  assert.throws(() => decryptBackup({ ...envelope, expiresAt: "2026-10-20T12:00:00Z" }, { key, now }));
  const corrupted = Buffer.from(envelope.ciphertext, "base64");
  corrupted[0] ^= 1;
  assert.throws(() => decryptBackup({ ...envelope, ciphertext: corrupted.toString("base64") }, { key, now }));
  assert.throws(() => decryptBackup(envelope, { key, now: "2026-10-19T12:00:00Z" }), /expired/);
  assert.throws(() => decryptBackup(envelope, { key, now, expectedDumpSha256: "wrong" }), /revision/);
  assert.throws(() => encryptBackup({ ...input(), key: Buffer.alloc(16) }), /32 bytes/);
});

test("atomic backup creation never overwrites recovery points and expiry preserves unrelated files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leaderboard-backup-test-"));
  try {
    const path = join(dir, "synthetic.lbbackup");
    const envelope = encryptBackup(input());
    await writeBackup(path, envelope);
    await assert.rejects(writeBackup(path, envelope), /EEXIST/);
    await writeFile(join(dir, "unrelated.json"), "{}");
    assert.equal((await readFile(path, "utf8")).includes("CREATE TABLE"), false);
    assert.equal((await expireBackups(dir, { now, key })).expired.length, 0);
    const receipt = await expireBackups(dir, { now: "2026-10-19T12:00:00Z", key });
    assert.equal(receipt.expired.length, 1);
    assert.deepEqual(await readdir(dir), ["unrelated.json"]);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.match(dir.split(/[\\/]/).at(-1), /^leaderboard-backup-test-/);
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore authenticates before mutation, reapplies suppression before verification, and measures recovery", async () => {
  const operations = [];
  const state = { snapshot: "synthetic-revision-12", corrections: ["synthetic-correction-2"] };
  const args = {
    envelope: encryptBackup(input()),
    key,
    now,
    expectedState: state,
    observedSourceCutoff: now,
    assertEmptyTarget: async () => operations.push("empty"),
    restoreDatabase: async (dump) => {
      assert.deepEqual(dump, input().databaseDump);
      operations.push("restore");
    },
    reapplySuppressions: async () => operations.push("suppress"),
    inspectRestoredState: async () => {
      operations.push("inspect");
      return { corrections: state.corrections, snapshot: state.snapshot };
    },
  };
  const receipt = await restoreBackup(args);
  assert.deepEqual(operations, ["empty", "restore", "suppress", "inspect"]);
  assert.equal(receipt.sourceGapMilliseconds, 60000);
  assert.equal(receipt.postBackupDataLoss, null);
  assert.ok(receipt.recoveryMilliseconds >= 0);
  operations.length = 0;
  await assert.rejects(restoreBackup({ ...args, key: randomBytes(32) }));
  assert.deepEqual(operations, []);
  await assert.rejects(
    restoreBackup({
      ...args,
      assertEmptyTarget: async () => {
        throw Error("not empty");
      },
    }),
    /not empty/,
  );
  assert.deepEqual(operations, []);
  await assert.rejects(restoreBackup({ ...args, expectedState: {} }), /does not match/);
});

test("expiry bypass still validates the observation clock", () => {
  const envelope = encryptBackup(input());
  for (const invalid of [undefined, null, "invalid", ""]) {
    assert.throws(() => decryptBackup(envelope, { key, now: invalid, allowExpired: true }), /timestamp/);
  }
});

test("restore rejects incomplete safeguards and impossible evidence before mutation", async () => {
  const operations = [];
  const args = {
    envelope: encryptBackup(input()),
    key,
    now,
    expectedState: {},
    observedSourceCutoff: now,
    assertEmptyTarget: async () => operations.push("empty"),
    restoreDatabase: async () => operations.push("restore"),
    reapplySuppressions: async () => operations.push("suppress"),
    inspectRestoredState: async () => ({}),
  };
  for (const callback of ["assertEmptyTarget", "restoreDatabase", "reapplySuppressions", "inspectRestoredState"]) {
    await assert.rejects(restoreBackup({ ...args, [callback]: undefined }), /callbacks/);
  }
  await assert.rejects(restoreBackup({ ...args, expectedState: undefined }), /Expected restored state/);
  const circular = {};
  circular.self = circular;
  await assert.rejects(restoreBackup({ ...args, expectedState: circular }));
  await assert.rejects(restoreBackup({ ...args, observedSourceCutoff: "2026-10-17T12:00:01Z" }), /future/);
  await assert.rejects(restoreBackup({ ...args, observedSourceCutoff: "2026-10-17T11:58:00Z" }), /precedes/);
  assert.deepEqual(operations, []);
});
