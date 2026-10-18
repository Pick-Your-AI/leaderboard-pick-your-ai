import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, open, link, stat, unlink, readdir } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";

const format = "leaderboard-backup/v1";
const maxBytes = 64 * 1024 * 1024;
const digest = (data) => createHash("sha256").update(data).digest("hex");
function canonical(value) {
  const normalize = (item) =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, normalize(item[key])]),
          )
        : item;
  return JSON.stringify(normalize(JSON.parse(JSON.stringify(value))));
}
function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Backup key must be exactly 32 bytes");
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid backup timestamp");
  return new Date(value).toISOString();
}

/** Secrets and raw SQL exist only inside the authenticated encrypted payload. */
export function encryptBackup({
  databaseDump,
  configuration,
  policyVersions,
  watermarks,
  key,
  createdAt,
  expiresAt,
  sourceCutoff,
}) {
  validateKey(key);
  createdAt = timestamp(createdAt);
  expiresAt = timestamp(expiresAt);
  sourceCutoff = timestamp(sourceCutoff);
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(sourceCutoff) > Date.parse(createdAt)) {
    throw new Error("Invalid retention or source cutoff");
  }
  if (!Buffer.isBuffer(databaseDump) || databaseDump.length === 0 || databaseDump.length > maxBytes) {
    throw new Error("Database dump must be nonempty and within the 64 MiB backup bound");
  }
  if (!configuration || typeof configuration !== "object" || !Array.isArray(policyVersions) || !policyVersions.length) {
    throw new Error("Configuration and required policy versions must accompany a backup");
  }
  if (!watermarks || typeof watermarks !== "object" || Array.isArray(watermarks))
    throw new Error("Source watermarks are required");
  const payload = Buffer.from(
    JSON.stringify({ databaseDump: databaseDump.toString("base64"), configuration, policyVersions, watermarks }),
  );
  if (payload.length > maxBytes * 2) throw new Error("Backup payload exceeds serialization bound");
  const metadata = {
    format,
    createdAt,
    expiresAt,
    sourceCutoff,
    dumpSha256: digest(databaseDump),
    payloadSha256: digest(payload),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    ...metadata,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Authenticate before any restore mutation; expiry and expected revisions fail closed. */
export function decryptBackup(envelope, { key, now, expectedDumpSha256, allowExpired = false } = {}) {
  validateKey(key);
  now = timestamp(now);
  const { iv, tag, ciphertext, ...metadata } = envelope;
  if (metadata.format !== format) throw new Error("Unsupported backup format");
  if (!allowExpired && Date.parse(timestamp(now)) >= Date.parse(timestamp(metadata.expiresAt)))
    throw new Error("Backup has expired");
  if (Date.parse(timestamp(metadata.createdAt)) > Date.parse(now)) throw new Error("Backup is from the future");
  if (typeof ciphertext !== "string" || ciphertext.length > maxBytes * 3)
    throw new Error("Backup exceeds restore bound");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const payload = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  if (digest(payload) !== metadata.payloadSha256) throw new Error("Backup payload digest mismatch");
  const parsed = JSON.parse(payload.toString("utf8"));
  const databaseDump = Buffer.from(parsed.databaseDump, "base64");
  if (
    digest(databaseDump) !== metadata.dumpSha256 ||
    (expectedDumpSha256 && expectedDumpSha256 !== metadata.dumpSha256)
  ) {
    throw new Error("Database revision digest mismatch");
  }
  return { ...parsed, databaseDump, metadata };
}

export async function writeBackup(path, envelope) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(envelope));
      await file.sync();
    } finally {
      await file.close();
    }
    // A backup never overwrites an existing recovery point.
    await link(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(resolve(path)), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    format: "backup-write-receipt/v1",
    file: basename(path),
    dumpSha256: envelope.dumpSha256,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
  };
}

export async function readBackup(path, options) {
  if ((await stat(path)).size > maxBytes * 3) throw new Error("Backup file exceeds restore bound");
  return decryptBackup(JSON.parse(await readFile(path, "utf8")), options);
}

/** Only this directory's regular .lbbackup files are eligible; symlinks are skipped. */
export async function expireBackups(directory, { now, key }) {
  validateKey(key);
  const expired = [];
  const cutoff = Date.parse(timestamp(now));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".lbbackup")) continue;
    const path = join(resolve(directory), entry.name);
    if ((await stat(path)).size > maxBytes * 3) throw new Error("Backup file exceeds expiry bound");
    const envelope = JSON.parse(await readFile(path, "utf8"));
    if (envelope.format !== format) continue;
    decryptBackup(envelope, { key, now, allowExpired: true });
    if (Date.parse(timestamp(envelope.expiresAt)) <= cutoff) {
      await unlink(path);
      expired.push({ file: entry.name, dumpSha256: envelope.dumpSha256 });
    }
  }
  return { format: "backup-expiry-receipt/v1", at: new Date(cutoff).toISOString(), expired };
}

/** Restore executor must target an isolated empty DB. Verify state before returning success. */
export async function restoreBackup({
  envelope,
  key,
  now,
  expectedDumpSha256,
  assertEmptyTarget,
  restoreDatabase,
  inspectRestoredState,
  expectedState,
  reapplySuppressions,
  observedSourceCutoff,
}) {
  const started = performance.now();
  for (const callback of [assertEmptyTarget, restoreDatabase, inspectRestoredState, reapplySuppressions]) {
    if (typeof callback !== "function") throw new Error("All isolated restore and suppression callbacks are required");
  }
  if (!expectedState || typeof expectedState !== "object") throw new Error("Expected restored state is required");
  // Validate the comparison target before any database mutation.
  const expectedCanonical = canonical(expectedState);
  const decoded = decryptBackup(envelope, { key, now, expectedDumpSha256 });
  const observed = Date.parse(timestamp(observedSourceCutoff));
  const cutoff = Date.parse(decoded.metadata.sourceCutoff);
  if (observed > Date.parse(now)) throw new Error("Observed source cutoff is from the future");
  if (observed < cutoff) throw new Error("Observed source cutoff precedes backup cutoff");
  await assertEmptyTarget();
  await restoreDatabase(decoded.databaseDump);
  // Current deletion/opt-out tombstones must be applied before any restored data is public.
  await reapplySuppressions();
  const state = await inspectRestoredState();
  if (canonical(state) !== expectedCanonical)
    throw new Error("Restored state does not match the expected snapshot/correction state");
  return {
    format: "restore-drill-receipt/v1",
    restoredDumpSha256: decoded.metadata.dumpSha256,
    recoveryMilliseconds: Math.ceil(performance.now() - started),
    sourceGapMilliseconds: observed - cutoff,
    restoredSnapshotLoss: 0,
    postBackupDataLoss: null,
    restoredStateSha256: digest(canonical(state)),
    sourceReconciliationRequired: true,
    watermarksSha256: digest(JSON.stringify(decoded.watermarks)),
  };
}
