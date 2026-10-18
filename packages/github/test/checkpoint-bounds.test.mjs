import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { CheckpointLimitError, FileCheckpointStore, GithubReadClient } from "../dist/index.js";

const key = "synthetic-checkpoint";
const pathFor = (directory, value = key) => join(directory, `${createHash("sha256").update(value).digest("hex")}.json`);
const limitError = (limit) => (error) => error instanceof CheckpointLimitError && error.maxBytes === limit;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "github-checkpoint-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("checkpoint bounds count UTF-8 bytes and accept the exact limit through restart", async (t) => {
  const directory = await fixture(t);
  const value = { text: "synthetic 🐙 é" };
  const encoded = JSON.stringify(value);
  const limit = Buffer.byteLength(encoded);
  assert.ok(limit > encoded.length);
  const store = new FileCheckpointStore(directory, { maxBytes: limit });
  assert.equal(await store.load(key), undefined);
  await store.save(key, value);
  assert.deepEqual(await new FileCheckpointStore(directory, { maxBytes: limit }).load(key), value);
  await assert.rejects(new FileCheckpointStore(directory, { maxBytes: limit - 1 }).load(key), limitError(limit - 1));
  await assert.rejects(store.save(key, { text: `${value.text}x` }), limitError(limit));
  assert.equal(await readFile(pathFor(directory), "utf8"), encoded);
  assert.deepEqual(await readdir(directory), [basename(pathFor(directory))]);
});

test("oversized replacement fails before creating a new checkpoint directory", async (t) => {
  const directory = join(await fixture(t), "not-created");
  const store = new FileCheckpointStore(directory, { maxBytes: 8 });
  await assert.rejects(store.save(key, "synthetic too large"), limitError(8));
  await assert.rejects(readdir(directory), { code: "ENOENT" });
});

test("an oversized on-disk record is rejected even when its JSON is valid", async (t) => {
  const directory = await fixture(t);
  const serialized = JSON.stringify({ text: "x".repeat(4096) });
  await writeFile(pathFor(directory), serialized);
  await assert.rejects(new FileCheckpointStore(directory, { maxBytes: 64 }).load(key), limitError(64));
  assert.equal(await readFile(pathFor(directory), "utf8"), serialized);
});

test("a file that grows during reading consumes at most the limit plus one byte", async (t) => {
  const directory = await fixture(t);
  const path = pathFor(directory);
  await writeFile(path, "{}");
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let total = 0;
  let calls = 0;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await read.apply(this, args);
    total += result.bytesRead;
    if (++calls === 1) await appendFile(path, " ".repeat(256));
    return result;
  });
  await assert.rejects(new FileCheckpointStore(directory, { maxBytes: 64 }).load(key), limitError(64));
  assert.equal(total, 65);
  assert.equal(calls, 2);
});

test("path replacement does not switch the file being read", async (t) => {
  const directory = await fixture(t);
  const path = pathFor(directory);
  const value = { text: "synthetic accepted value" };
  await writeFile(path, JSON.stringify(value));
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let replaced = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await read.apply(this, args);
    if (!replaced) {
      replaced = true;
      await rename(path, `${path}.old`);
      await writeFile(path, JSON.stringify({ text: "x".repeat(4096) }));
    }
    return result;
  });
  assert.deepEqual(await new FileCheckpointStore(directory, { maxBytes: 64 }).load(key), value);
  assert.equal(replaced, true);
  await assert.rejects(new FileCheckpointStore(directory, { maxBytes: 64 }).load(key), limitError(64));
});

test("invalid limits and malformed or unserializable records cannot replace saved progress", async (t) => {
  const directory = await fixture(t);
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => new FileCheckpointStore(directory, { maxBytes }), RangeError);
  const store = new FileCheckpointStore(directory, { maxBytes: 64 });
  await store.save(key, { accepted: true });
  for (const value of [undefined, 1n]) await assert.rejects(store.save(key, value), TypeError);
  assert.deepEqual(await store.load(key), { accepted: true });
  await writeFile(pathFor(directory), "{invalid");
  await assert.rejects(store.load(key), /Checkpoint is unreadable or corrupt/);
});

test("an oversized second scan page preserves the resumable first-page checkpoint", async (t) => {
  const directory = await fixture(t);
  const calls = [];
  const scan = {
    source: "synthetic-installation",
    key: "synthetic-issues",
    url: "https://api.synthetic.invalid/issues?page=1",
    maxPages: 2,
    select: (body) => body,
  };
  const create = (maxBytes) =>
    new GithubReadClient({
      apiOrigin: "https://api.synthetic.invalid",
      token: async () => undefined,
      checkpoints: new FileCheckpointStore(directory, { maxBytes }),
      maxRetries: 0,
      fetch: async (url) => {
        calls.push(url);
        const second = url.endsWith("page=2");
        return new Response(JSON.stringify(second ? ["x".repeat(600)] : ["synthetic-first"]), {
          headers: second ? {} : { link: '<https://api.synthetic.invalid/issues?page=2>; rel="next"' },
        });
      },
    });
  await assert.rejects(create(512).scanRest(scan), limitError(512));
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const accepted = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
  assert.deepEqual(accepted.items, ["synthetic-first"]);
  assert.equal(accepted.complete, false);
  assert.equal(accepted.next, "https://api.synthetic.invalid/issues?page=2");
  assert.deepEqual(await create(2048).scanRest(scan), ["synthetic-first", "x".repeat(600)]);
  assert.deepEqual(calls, [scan.url, accepted.next, accepted.next]);
});
