import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptBackup, encryptBackup, writeBackup } from "../backup.mjs";

const key = randomBytes(32);
const now = "2026-10-17T12:02:00.000Z";
function fixture(replacement = false) {
  return encryptBackup({
    key,
    databaseDump: Buffer.from(replacement ? "synthetic replacement dump" : "synthetic original dump"),
    configuration: {},
    policyVersions: ["synthetic/v1"],
    watermarks: {},
    createdAt: replacement ? "2026-10-17T12:01:00Z" : "2026-10-17T12:00:00Z",
    sourceCutoff: "2026-10-17T11:59:00Z",
    expiresAt: replacement ? "2026-10-19T12:00:00Z" : "2026-10-18T12:00:00Z",
  });
}

async function withBackupPath(run) {
  const directory = await fs.mkdtemp(join(tmpdir(), "leaderboard-backup-identity-test-"));
  try {
    await run(join(directory, "synthetic.lbbackup"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function assertSavedIdentity(path, receipt, expected) {
  const saved = JSON.parse(await fs.readFile(path, "utf8"));
  assert.deepEqual(saved, expected, "the saved envelope must match the captured serialization");
  assert.deepEqual(decryptBackup(saved, { key, now }).databaseDump, decryptBackup(expected, { key, now }).databaseDump);
  assert.deepEqual(receipt, {
    format: "backup-write-receipt/v1",
    file: "synthetic.lbbackup",
    dumpSha256: saved.dumpSha256,
    createdAt: saved.createdAt,
    expiresAt: saved.expiresAt,
  });
}

test("backup creation captures the caller envelope before the first filesystem await", async () => {
  await withBackupPath(async (path) => {
    const original = fixture();
    const envelope = { ...original };
    const writing = writeBackup(path, envelope);
    Object.assign(envelope, fixture(true));
    await assertSavedIdentity(path, await writing, original);
  });
});

test("a backup receipt identifies the durable file when the caller changes after its write", async (t) => {
  await withBackupPath(async (path) => {
    const original = fixture();
    const envelope = { ...original };
    const replacement = fixture(true);
    const originalOpen = fs.open;
    t.mock.method(fs, "open", async (...args) => {
      const file = await originalOpen(...args);
      if (args[1] === "wx") {
        const originalWrite = file.writeFile.bind(file);
        t.mock.method(file, "writeFile", async (...writeArgs) => {
          await originalWrite(...writeArgs);
          Object.assign(envelope, replacement);
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    try {
      const receipt = await writeBackup(path, envelope);
      assert.deepEqual(envelope, replacement, "the caller changes at the real file-write boundary");
      await assertSavedIdentity(path, receipt, original);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("a backup receipt uses the serialized envelope when toJSON supplies it", async () => {
  await withBackupPath(async (path) => {
    const serialized = fixture(true);
    const envelope = { ...fixture(), toJSON: () => serialized };
    await assertSavedIdentity(path, await writeBackup(path, envelope), serialized);
  });
});
