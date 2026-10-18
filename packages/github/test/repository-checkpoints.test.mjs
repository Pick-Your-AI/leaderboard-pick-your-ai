import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CheckpointLimitError, FileCheckpointStore } from "../dist/checkpoints.js";
import { GithubReadClient } from "../dist/client.js";

const binding = {
  operationId: "synthetic-retirement-1",
  policyId: "synthetic-policy-v1",
  authorizationId: "synthetic-approval-1",
};
const hash = (key) => createHash("sha256").update(key).digest("hex") + ".json";
const namespace = (cache, repositoryId) => join(cache, "repositories-v1", String(repositoryId));
const markerPath = (cache, repositoryId) => cache + ".repository-retention/" + repositoryId + ".json";
const absent = (path) => assert.rejects(access(path), (error) => error.code === "ENOENT");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "github-repository-retirement-"));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "cache");
  return { directory, cache, store: new FileCheckpointStore(cache) };
}

test("retirement deletes one explicit repository and preserves legacy bytes, quota and unrelated scopes", async (t) => {
  const { cache, store } = await fixture(t);
  const first = store.forRepository(41);
  const second = store.forRepository(42);
  await store.save("pause:shared-installation", { version: 1, until: 7 });
  await store.save("http:legacy-unscoped", { body: "synthetic legacy bytes" });
  await first.save("same-opaque-key", { body: "synthetic first repository" });
  await second.save("same-opaque-key", { body: "synthetic second repository" });
  assert.deepEqual(await first.load("same-opaque-key"), { body: "synthetic first repository" });
  assert.deepEqual(await second.load("same-opaque-key"), { body: "synthetic second repository" });
  assert.equal(first.repositoryId, 41);
  assert.throws(() => {
    first.repositoryId = 42;
  }, TypeError);
  const receipt = await first.retire(binding);
  assert.deepEqual(receipt, {
    schemaVersion: "repository-checkpoint-retirement/v1",
    repositoryId: 41,
    ...binding,
    checkpointPayloadsRemoved: true,
    legacyUnscopedPayloads: "outside_scope",
  });
  await absent(namespace(cache, 41));
  assert.deepEqual(await second.load("same-opaque-key"), { body: "synthetic second repository" });
  assert.deepEqual(await store.load("pause:shared-installation"), { version: 1, until: 7 });
  assert.deepEqual(await store.load("http:legacy-unscoped"), { body: "synthetic legacy bytes" });
  for (const operation of [
    () => first.assertActive(),
    () => first.load("same-opaque-key"),
    () => first.save("same-opaque-key", { body: "synthetic replacement" }),
  ])
    await assert.rejects(operation(), /repository_checkpoint_retired/);
  const marker = JSON.parse(await readFile(markerPath(cache, 41), "utf8"));
  assert.deepEqual(marker, { schemaVersion: "repository-checkpoint-tombstone/v1", repositoryId: 41, ...binding });
  assert.equal(JSON.stringify(marker).includes("synthetic first repository"), false);
  assert.equal(Object.hasOwn(marker, "checkpointPayloadsRemoved"), false);
  if (process.platform !== "win32") {
    assert.equal((await lstat(markerPath(cache, 41))).mode & 0o777, 0o600);
    assert.equal((await lstat(cache + ".repository-retention")).mode & 0o777, 0o700);
  }
});

test("restart and restoration of old payloads cannot undo the permanent marker; matching retry cleans them", async (t) => {
  const { cache, store } = await fixture(t);
  const first = store.forRepository(41);
  await first.save("finished-scan", { complete: true, items: ["synthetic removed result"] });
  const path = join(namespace(cache, 41), hash("finished-scan"));
  const oldPayload = await readFile(path);
  const originalReceipt = await first.retire(binding);
  await mkdir(namespace(cache, 41), { recursive: true });
  await writeFile(path, oldPayload);
  const reopened = new FileCheckpointStore(cache).forRepository(41);
  await assert.rejects(reopened.assertActive(), /repository_checkpoint_retired/);
  await assert.rejects(reopened.load("finished-scan"), /repository_checkpoint_retired/);
  assert.deepEqual(await reopened.retire(binding), originalReceipt);
  await absent(namespace(cache, 41));
  for (const key of ["operationId", "policyId", "authorizationId"]) {
    await assert.rejects(reopened.retire({ ...binding, [key]: "different-binding" }), /retirement_conflict/);
  }
  assert.deepEqual(await reopened.retire(binding), originalReceipt);
});

test("scope and binding validation reject ambiguous inputs before creating cache or authority", async (t) => {
  const { cache, store } = await fixture(t);
  for (const repositoryId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "41", null]) {
    assert.throws(() => store.forRepository(repositoryId), /invalid_checkpoint_repository/);
  }
  for (const invalid of [
    null,
    [],
    {},
    { ...binding, operationId: "" },
    { ...binding, policyId: "unsafe/policy" },
    { ...binding, authorizationId: "a".repeat(129) },
    { ...binding, extra: "payload" },
    { ...binding, operationId: undefined },
  ])
    await assert.rejects(store.forRepository(41).retire(invalid), /invalid_repository_checkpoint_retirement/);
  await absent(cache);
  await absent(cache + ".repository-retention");
  for (const tombstoneDirectory of [cache, join(cache, "authority"), dirname(cache)]) {
    assert.throws(() => new FileCheckpointStore(cache, { tombstoneDirectory }), /outside the cache/);
  }
});

test("explicit independent authority survives retirement of a repository with no prior cache", async (t) => {
  const { directory, cache } = await fixture(t);
  const tombstoneDirectory = join(directory, "private-authority");
  const scoped = new FileCheckpointStore(cache, { tombstoneDirectory }).forRepository(41);
  await scoped.retire(binding);
  await absent(cache);
  const reopened = new FileCheckpointStore(cache, { tombstoneDirectory }).forRepository(41);
  await assert.rejects(reopened.load("never-collected"), /repository_checkpoint_retired/);
  assert.equal((await readdir(tombstoneDirectory)).length, 1);
});

test("corrupt, oversized and wrong-scope marker bytes block reads, writes and retirement without deleting payload", async (t) => {
  const { cache, store } = await fixture(t);
  const scoped = store.forRepository(41);
  await scoped.save("synthetic-key", { body: "synthetic retained until verified cleanup" });
  await mkdir(cache + ".repository-retention");
  const valid = { schemaVersion: "repository-checkpoint-tombstone/v1", repositoryId: 41, ...binding };
  for (const body of [
    "{",
    " ".repeat(4097),
    JSON.stringify({ ...valid, repositoryId: 42 }),
    JSON.stringify({ ...valid, extra: "unexpected" }),
    JSON.stringify({ ...valid, authorizationId: "" }),
    JSON.stringify(valid).replace('"repositoryId":41', '"repositoryId":42,"repositoryId":41'),
  ]) {
    await writeFile(markerPath(cache, 41), body);
    await assert.rejects(scoped.assertActive(), /authority is unreadable or corrupt/);
    await assert.rejects(scoped.load("synthetic-key"), /authority is unreadable or corrupt/);
    await assert.rejects(scoped.save("synthetic-key", { replacement: true }), /authority is unreadable or corrupt/);
    await assert.rejects(scoped.retire(binding), /authority is unreadable or corrupt/);
    assert.deepEqual(JSON.parse(await readFile(join(namespace(cache, 41), hash("synthetic-key")), "utf8")), {
      body: "synthetic retained until verified cleanup",
    });
  }
});

test("a held durable save and retirement serialize across separate FileCheckpointStore instances", async (t) => {
  const { cache, store } = await fixture(t);
  const scoped = store.forRepository(41);
  await store.forRepository(42).save("unrelated", "synthetic retained");
  const entered = deferred();
  const release = deferred();
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (dirname(to) === namespace(cache, 41)) {
      entered.resolve();
      await release.promise;
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const saving = scoped.save("response", { body: "synthetic in-flight response" });
    await entered.promise;
    const otherInstance = new FileCheckpointStore(cache).forRepository(41);
    const retiring = otherInstance.retire(binding);
    const lateSave = assert.rejects(scoped.save("later-response", { body: "must not persist" }), /checkpoint_retired/);
    const lateLoad = assert.rejects(otherInstance.load("response"), /checkpoint_retired/);
    release.resolve();
    await saving;
    await retiring;
    await Promise.all([lateSave, lateLoad]);
    await absent(namespace(cache, 41));
    assert.equal(await store.forRepository(42).load("unrelated"), "synthetic retained");
  } finally {
    release.resolve();
    fs.rename = originalRename;
    syncBuiltinESMExports();
  }
});

test("ancestor aliases share the retirement queue even when the cache has not been created", async (t) => {
  const { directory, cache, store } = await fixture(t);
  const alias = join(directory, "ancestor-alias");
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasCache = join(alias, "cache");
  const aliased = new FileCheckpointStore(aliasCache).forRepository(41);
  const original = store.forRepository(41);
  const entered = deferred();
  const release = deferred();
  const originalMkdir = fs.mkdir;
  let firstWrite = true;
  fs.mkdir = async (path, options) => {
    if (path === namespace(cache, 41) && firstWrite) {
      firstWrite = false;
      entered.resolve();
      await release.promise;
    }
    return originalMkdir(path, options);
  };
  syncBuiltinESMExports();
  try {
    const saving = original.save("response", "synthetic in-flight bytes");
    await entered.promise;
    let retired = false;
    const retiring = aliased.retire(binding).then((receipt) => {
      retired = true;
      return receipt;
    });
    const lateSave = assert.rejects(aliased.save("late", "must not recreate payload"), /checkpoint_retired/);
    // The blocked writer is deliberately held while the other instance has a
    // chance to perform real filesystem I/O. It cannot acknowledge retirement.
    await new Promise((done) => setTimeout(done, 40));
    assert.equal(retired, false, "an alias must not retire behind a still-authorized pending write");
    release.resolve();
    await saving;
    await retiring;
    await lateSave;
    await absent(namespace(cache, 41));
    await assert.rejects(original.load("response"), /checkpoint_retired/);
    await assert.rejects(aliased.load("response"), /checkpoint_retired/);
  } finally {
    release.resolve();
    fs.mkdir = originalMkdir;
    syncBuiltinESMExports();
  }
});

test("cleanup failure retains a durable denial and no completion receipt, then a real retry removes payload", async (t) => {
  const { cache, store } = await fixture(t);
  const scoped = store.forRepository(41);
  await scoped.save("response", { body: "synthetic pending deletion" });
  const originalRemove = fs.rm;
  fs.rm = async (path, options) => {
    if (path === namespace(cache, 41))
      throw Object.assign(new Error("synthetic filesystem removal failure"), { code: "EIO" });
    return originalRemove(path, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(scoped.retire(binding), /synthetic filesystem removal failure/);
  } finally {
    fs.rm = originalRemove;
    syncBuiltinESMExports();
  }
  await access(markerPath(cache, 41));
  await access(join(namespace(cache, 41), hash("response")));
  const restarted = new FileCheckpointStore(cache).forRepository(41);
  await assert.rejects(restarted.load("response"), /checkpoint_retired/);
  assert.equal((await restarted.retire(binding)).checkpointPayloadsRemoved, true);
  await absent(namespace(cache, 41));
});

test("an authority directory sync failure stops deletion and remains recoverable by the same binding", async (t) => {
  if (process.platform === "win32") {
    t.skip("Directory fsync is POSIX-only");
    return;
  }
  const { cache, store } = await fixture(t);
  const scoped = store.forRepository(41);
  await scoped.save("response", "synthetic payload");
  const originalOpen = fs.open;
  let failed = false;
  fs.open = async (path, ...args) => {
    const file = await originalOpen(path, ...args);
    if (path === cache + ".repository-retention" && !failed) {
      const originalSync = file.sync.bind(file);
      file.sync = async () => {
        const exists = await access(markerPath(cache, 41)).then(
          () => true,
          () => false,
        );
        if (exists && !failed) {
          failed = true;
          throw new Error("synthetic authority directory sync failure");
        }
        return originalSync();
      };
    }
    return file;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(scoped.retire(binding), /synthetic authority directory sync failure/);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(failed, true);
  await access(join(namespace(cache, 41), hash("response")));
  const reopened = new FileCheckpointStore(cache).forRepository(41);
  await assert.rejects(reopened.assertActive(), /checkpoint_retired/);
  await reopened.retire(binding);
  await absent(namespace(cache, 41));
});

for (const phase of ["before_remove", "after_remove"]) {
  test("actual process exit " + phase + " resumes from durable authority after restart", async (t) => {
    const { cache, store } = await fixture(t);
    await store.forRepository(41).save("response", { body: "synthetic crash-boundary payload" });
    await store.forRepository(42).save("response", { body: "synthetic unrelated payload" });
    const source = [
      'import fs from "node:fs/promises";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const [cache, payload, phase, moduleUrl, bindingJson] = process.argv.slice(1);",
      "const original = fs.rm;",
      "fs.rm = async (path, options) => {",
      "  if (path !== payload) return original(path, options);",
      '  if (phase === "before_remove") process.exit(73);',
      "  await original(path, options);",
      "  process.exit(74);",
      "};",
      "syncBuiltinESMExports();",
      "const { FileCheckpointStore } = await import(moduleUrl);",
      "await new FileCheckpointStore(cache).forRepository(41).retire(JSON.parse(bindingJson));",
      'throw new Error("Expected actual abrupt process exit");',
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        source,
        cache,
        namespace(cache, 41),
        phase,
        new URL("../dist/checkpoints.js", import.meta.url).href,
        JSON.stringify(binding),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.error, undefined, "The actual crash probe must launch without a subprocess error");
    assert.equal(result.status, phase === "before_remove" ? 73 : 74, result.stderr);
    assert.equal(result.signal, null);
    await access(markerPath(cache, 41));
    if (phase === "before_remove") await access(join(namespace(cache, 41), hash("response")));
    const restarted = new FileCheckpointStore(cache);
    await assert.rejects(restarted.forRepository(41).load("response"), /checkpoint_retired/);
    await assert.rejects(restarted.forRepository(41).save("response", "must not return"), /checkpoint_retired/);
    assert.equal((await restarted.forRepository(41).retire(binding)).checkpointPayloadsRemoved, true);
    await absent(namespace(cache, 41));
    assert.deepEqual(await restarted.forRepository(42).load("response"), { body: "synthetic unrelated payload" });
  });
}

test("retirement removes owned nested/temp payloads without traversing links to unrelated bytes", async (t) => {
  const { directory, cache, store } = await fixture(t);
  const scoped = store.forRepository(41);
  await scoped.save("response", "synthetic owned bytes");
  const owned = namespace(cache, 41);
  await mkdir(join(owned, "interrupted-child"));
  await writeFile(join(owned, "interrupted-child", "payload.tmp"), "synthetic interrupted write");
  const unrelated = join(directory, "unrelated");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "keep.json"), "synthetic unrelated bytes");
  await symlink(unrelated, join(owned, "link-to-unrelated"), process.platform === "win32" ? "junction" : "dir");
  await scoped.retire(binding);
  await absent(owned);
  assert.equal(await readFile(join(unrelated, "keep.json"), "utf8"), "synthetic unrelated bytes");
});

test("symlinked authority and payload roots fail closed without removing their targets", async (t) => {
  const { directory, cache, store } = await fixture(t);
  const unrelated = join(directory, "unrelated");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "keep.json"), "synthetic protected bytes");
  const authority = cache + ".repository-retention";
  await symlink(unrelated, authority, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.forRepository(41).assertActive(), /Unsafe checkpoint directory/);
  await assert.rejects(store.forRepository(41).retire(binding), /Unsafe checkpoint directory/);
  await rm(authority);
  await mkdir(join(cache, "repositories-v1"), { recursive: true });
  await symlink(unrelated, namespace(cache, 41), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.forRepository(41).load("response"), /Unsafe checkpoint directory/);
  await assert.rejects(store.forRepository(41).retire(binding), /Unsafe checkpoint directory/);
  await access(markerPath(cache, 41));
  assert.equal(await readFile(join(unrelated, "keep.json"), "utf8"), "synthetic protected bytes");
});

test("scoped records preserve exact UTF-8 limits and accepted bytes after capacity or serialization failure", async (t) => {
  const { cache } = await fixture(t);
  const value = { text: "synthetic 🐙 é" };
  const serialized = JSON.stringify(value);
  const maxBytes = Buffer.byteLength(serialized);
  const store = new FileCheckpointStore(cache, { maxBytes }).forRepository(41);
  await store.save("response", value);
  assert.deepEqual(await new FileCheckpointStore(cache, { maxBytes }).forRepository(41).load("response"), value);
  const limitError = (error) => error instanceof CheckpointLimitError && error.maxBytes === maxBytes;
  await assert.rejects(store.save("response", { text: value.text + "x" }), limitError);
  for (const invalid of [undefined, 1n]) await assert.rejects(store.save("response", invalid), TypeError);
  const circular = {};
  circular.self = circular;
  await assert.rejects(store.save("response", circular), TypeError);
  assert.equal(await readFile(join(namespace(cache, 41), hash("response")), "utf8"), serialized);
  assert.deepEqual(await readdir(namespace(cache, 41)), [hash("response")]);
  await assert.rejects(
    new FileCheckpointStore(cache, { maxBytes: maxBytes - 1 }).forRepository(41).load("response"),
    (error) => error instanceof CheckpointLimitError && error.maxBytes === maxBytes - 1,
  );
});

test("scoped capacity rejects before creating payload paths and does not prevent retirement of oversized restored bytes", async (t) => {
  const { cache } = await fixture(t);
  const store = new FileCheckpointStore(cache, { maxBytes: 8 }).forRepository(41);
  await assert.rejects(store.save("response", "synthetic too large"), CheckpointLimitError);
  await absent(cache);
  await absent(cache + ".repository-retention");
  await mkdir(namespace(cache, 41), { recursive: true });
  const restored = JSON.stringify({ body: "x".repeat(4096) });
  await writeFile(join(namespace(cache, 41), hash("response")), restored);
  await assert.rejects(store.load("response"), CheckpointLimitError);
  assert.equal(await readFile(join(namespace(cache, 41), hash("response")), "utf8"), restored);
  const receipt = await store.retire(binding);
  assert.equal(receipt.checkpointPayloadsRemoved, true);
  await absent(namespace(cache, 41));
  await assert.rejects(store.load("response"), /checkpoint_retired/);
});

test("scoped reads consume only the configured limit plus one byte when the held file grows", async (t) => {
  const { cache, store } = await fixture(t);
  await store.forRepository(41).save("response", {});
  const path = join(namespace(cache, 41), hash("response"));
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  let bytes = 0;
  let calls = 0;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await originalRead.apply(this, args);
    bytes += result.bytesRead;
    if (++calls === 1) await appendFile(path, " ".repeat(256));
    return result;
  });
  await assert.rejects(
    new FileCheckpointStore(cache, { maxBytes: 64 }).forRepository(41).load("response"),
    CheckpointLimitError,
  );
  assert.equal(bytes, 65);
  assert.equal(calls, 2);
});

test("scoped reads retain one descriptor when the pathname is replaced with an oversized record", async (t) => {
  const { cache, store } = await fixture(t);
  const expected = { text: "synthetic original" };
  await store.forRepository(41).save("response", expected);
  const path = join(namespace(cache, 41), hash("response"));
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  let replaced = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!replaced) {
      replaced = true;
      await rename(path, path + ".old");
      await writeFile(path, JSON.stringify({ text: "x".repeat(4096) }));
    }
    return result;
  });
  const scoped = new FileCheckpointStore(cache, { maxBytes: 64 }).forRepository(41);
  assert.deepEqual(await scoped.load("response"), expected);
  assert.equal(replaced, true);
  await assert.rejects(scoped.load("response"), CheckpointLimitError);
});

test("scoped scan capacity preserves its accepted first page and resumes only the failed page after restart", async (t) => {
  const { cache } = await fixture(t);
  const calls = [];
  const scan = {
    source: "synthetic-shared-installation",
    key: "synthetic-scoped-scan",
    url: "https://api.synthetic.invalid/issues?page=1",
    maxPages: 2,
    select: (body) => body,
  };
  const client = (maxBytes) =>
    new GithubReadClient({
      apiOrigin: "https://api.synthetic.invalid",
      token: async () => undefined,
      checkpoints: new FileCheckpointStore(cache, { maxBytes }),
      maxRetries: 0,
      fetch: async (url) => {
        calls.push(url);
        const second = url.endsWith("page=2");
        return new Response(JSON.stringify(second ? ["x".repeat(600)] : ["synthetic-first"]), {
          headers: second ? {} : { link: '<https://api.synthetic.invalid/issues?page=2>; rel="next"' },
        });
      },
    }).forRepository(41);
  await assert.rejects(
    client(512).scanRest(scan),
    (error) => error instanceof CheckpointLimitError && error.maxBytes === 512,
  );
  const files = await readdir(namespace(cache, 41));
  assert.equal(files.length, 1);
  const accepted = JSON.parse(await readFile(join(namespace(cache, 41), files[0]), "utf8"));
  assert.deepEqual(accepted.items, ["synthetic-first"]);
  assert.equal(accepted.complete, false);
  assert.equal(accepted.next, "https://api.synthetic.invalid/issues?page=2");
  assert.deepEqual(await client(2048).scanRest(scan), ["synthetic-first", "x".repeat(600)]);
  assert.deepEqual(calls, [scan.url, accepted.next, accepted.next]);
});
