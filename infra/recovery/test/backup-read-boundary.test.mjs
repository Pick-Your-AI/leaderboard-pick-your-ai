import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { encryptBackup, expireBackups, readBackup } from "../backup.mjs";

const maximumFileBytes = 192 * 1024 * 1024;
const key = randomBytes(32);
const now = "2026-10-17T12:02:00Z";
const expiredAt = "2026-10-19T12:00:00Z";

function fixture(replacement = false) {
  return encryptBackup({
    key,
    databaseDump: Buffer.from(replacement ? "synthetic replacement dump" : "synthetic original dump"),
    configuration: {},
    policyVersions: ["synthetic/v1"],
    watermarks: {},
    createdAt: "2026-10-17T12:00:00Z",
    sourceCutoff: "2026-10-17T11:59:00Z",
    expiresAt: replacement ? "2026-10-20T12:00:00Z" : "2026-10-18T12:00:00Z",
  });
}

async function withBackupFile(run) {
  const directory = await fs.mkdtemp(join(tmpdir(), "leaderboard-backup-read-"));
  const path = join(directory, "synthetic.lbbackup");
  const envelope = fixture();
  try {
    await fs.writeFile(path, JSON.stringify(envelope));
    await run({ directory, path, envelope });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Both old pathname-stat and descriptor-stat implementations cross the same real
// filesystem boundary. Only the timing changes; the file and its bytes are real.
async function observeReads(t, path, { afterStat, shortReads = false, failOnce = false }, run) {
  const originalStat = fs.stat;
  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;
  const observation = { changed: false, handles: [], readCalls: 0, bytesRead: 0, failed: false };
  const selected = (value) => typeof value === "string" && resolve(value) === resolve(path);
  const measured = async () => {
    if (afterStat && !observation.changed) {
      observation.changed = true;
      await afterStat();
    }
  };
  const rejectRead = () => {
    if (failOnce && !observation.failed) {
      observation.failed = true;
      throw Object.assign(new Error("Synthetic backup read failed"), { code: "EIO" });
    }
  };
  t.mock.method(fs, "stat", async (target, ...options) => {
    const result = await originalStat(target, ...options);
    if (selected(target)) await measured();
    return result;
  });
  t.mock.method(fs, "readFile", async (target, ...options) => {
    if (selected(target)) rejectRead();
    return originalReadFile(target, ...options);
  });
  t.mock.method(fs, "open", async (target, ...options) => {
    const file = await originalOpen(target, ...options);
    if (!selected(target)) return file;
    observation.handles.push(file);
    const stat = file.stat.bind(file);
    const read = file.read.bind(file);
    t.mock.method(file, "stat", async (...args) => {
      const result = await stat(...args);
      await measured();
      return result;
    });
    t.mock.method(file, "read", async (buffer, offset, length, position) => {
      rejectRead();
      const result = await read(buffer, offset, shortReads ? Math.min(length, 7) : length, position);
      observation.readCalls++;
      observation.bytesRead += result.bytesRead;
      return result;
    });
    return file;
  });
  syncBuiltinESMExports();
  try {
    await run(observation);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    // Clean up only this test's handles even after an assertion failure. Passing
    // cases assert closure before this fallback, so it cannot hide a leak.
    for (const file of observation.handles) if (file.fd !== -1) await file.close();
  }
}

function assertClosed(observation) {
  for (const file of observation.handles) assert.equal(file.fd, -1, "the backup reader must close its descriptor");
}

test("backup reads retain the opened recovery point when its pathname is replaced after measurement", async (t) => {
  await withBackupFile(async ({ path, envelope }) => {
    const replacement = fixture(true);
    await observeReads(
      t,
      path,
      {
        afterStat: async () => {
          await fs.rename(path, `${path}.retained`);
          await fs.writeFile(path, JSON.stringify(replacement));
        },
      },
      async (observation) => {
        const decoded = await readBackup(path, { key, now });
        assert.equal(observation.changed, true);
        assert.equal(decoded.metadata.dumpSha256, envelope.dumpSha256);
        assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), replacement);
        assertClosed(observation);
      },
    );
  });
});

for (const operation of ["restore", "expiry"]) {
  test(`${operation} rejects a backup that grows past the byte bound after measurement and permits a repaired retry`, async (t) => {
    await withBackupFile(async ({ directory, path, envelope }) => {
      await observeReads(
        t,
        path,
        {
          // A sparse extension crosses the real fixed production limit without
          // writing or duplicating a 192 MiB fixture in the shared workspace.
          afterStat: () => fs.truncate(path, maximumFileBytes + 1),
        },
        async (observation) => {
          const run = () =>
            operation === "restore"
              ? readBackup(path, { key, now })
              : expireBackups(directory, { key, now: expiredAt });
          await assert.rejects(run(), new RegExp(`Backup file exceeds ${operation} bound`));
          assert.equal(observation.changed, true);
          assert.equal((await fs.stat(path)).size, maximumFileBytes + 1);
          assertClosed(observation);
          assert.ok(observation.bytesRead <= maximumFileBytes + 1, "overflow inspection reads at most limit plus one");
          await fs.writeFile(path, JSON.stringify(envelope));
          const result = await run();
          if (operation === "restore") assert.equal(result.metadata.dumpSha256, envelope.dumpSha256);
          else assert.deepEqual(result.expired, [{ file: "synthetic.lbbackup", dumpSha256: envelope.dumpSha256 }]);
          assertClosed(observation);
        },
      );
    });
  });
}

test("expiry preserves a different recovery point that replaces the opened file during its read", async (t) => {
  await withBackupFile(async ({ directory, path }) => {
    const replacement = fixture(true);
    await observeReads(
      t,
      path,
      {
        afterStat: async () => {
          await fs.rename(path, `${path}.retained`);
          await fs.writeFile(path, JSON.stringify(replacement));
        },
      },
      async (observation) => {
        await assert.rejects(expireBackups(directory, { key, now: expiredAt }), /Backup changed during expiry/);
        assert.equal(observation.changed, true);
        assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), replacement);
        assertClosed(observation);
        assert.deepEqual((await expireBackups(directory, { key, now: expiredAt })).expired, []);
        assertClosed(observation);
      },
    );
  });
});

test("already oversized backup files are rejected before content reads and retained for recovery", async (t) => {
  await withBackupFile(async ({ directory, path }) => {
    await fs.truncate(path, maximumFileBytes + 1);
    await observeReads(t, path, {}, async (observation) => {
      await assert.rejects(readBackup(path, { key, now }), /Backup file exceeds restore bound/);
      await assert.rejects(expireBackups(directory, { key, now: expiredAt }), /Backup file exceeds expiry bound/);
      assert.equal(observation.readCalls, 0);
      assert.equal((await fs.stat(path)).size, maximumFileBytes + 1);
      assertClosed(observation);
    });
  });
});

test("short reads and recoverable read failures preserve authentication and close every opened descriptor", async (t) => {
  await withBackupFile(async ({ path, envelope }) => {
    await observeReads(t, path, { shortReads: true, failOnce: true }, async (observation) => {
      await assert.rejects(readBackup(path, { key, now }), /Synthetic backup read failed/);
      assertClosed(observation);
      const restored = await readBackup(path, { key, now });
      assert.equal(restored.metadata.dumpSha256, envelope.dumpSha256);
      assertClosed(observation);
      await assert.rejects(readBackup(path, { key: randomBytes(32), now }));
      assertClosed(observation);
      await fs.writeFile(path, "{");
      await assert.rejects(readBackup(path, { key, now }), SyntaxError);
      assertClosed(observation);
      await fs.writeFile(path, JSON.stringify(envelope));
      assert.equal((await readBackup(path, { key, now })).metadata.dumpSha256, envelope.dumpSha256);
      assertClosed(observation);
    });
  });
});

test("expiry keeps its initial symlink exclusion while direct backup reads retain their existing link behavior", async () => {
  await withBackupFile(async ({ directory, path, envelope }) => {
    const backupDirectory = join(directory, "selected");
    await fs.mkdir(backupDirectory);
    const link = join(backupDirectory, "linked.lbbackup");
    await fs.symlink(path, link);
    assert.equal((await readBackup(link, { key, now })).metadata.dumpSha256, envelope.dumpSha256);
    assert.deepEqual((await expireBackups(backupDirectory, { key, now: expiredAt })).expired, []);
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), envelope);
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  });
});
