import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { classifyPhysicalDiff, readPinnedGitDiff } from "../dist/index.js";

// Real Git objects and transports in disposable repositories; no contribution
// evidence, external network service or existing repository is modified.
async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "physical-diff-objects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const git = (at, ...args) =>
    execFileSync(
      "git",
      [
        "-C",
        at,
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Synthetic Fixture",
        "-c",
        "user.email=synthetic@example.invalid",
        ...args,
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    ).trim();
  git(directory, "init", "--quiet", source);
  const commit = () => {
    git(source, "add", "--all");
    git(source, "commit", "--quiet", "-m", "Synthetic pinned diff fixture");
    return git(source, "rev-parse", "HEAD");
  };
  await writeFile(join(source, "source.txt"), "first\n");
  await writeFile(join(source, "format.txt"), "const value = 1;\n");
  const before = commit();
  await writeFile(join(source, "source.txt"), "first\nsecond\n");
  await writeFile(join(source, "format.txt"), "const    value   =  1;\n");
  const after = commit();
  const read = (repositoryPath = source) => readPinnedGitDiff({ repositoryPath, before, after });
  const partial = () => {
    git(source, "config", "uploadpack.allowFilter", "true");
    const clone = join(directory, "partial.git");
    git(directory, "clone", "--quiet", "--bare", "--filter=blob:none", pathToFileURL(source).href, clone);
    return clone;
  };
  return { directory, source, git, before, after, read, partial };
}

for (const [kind, suffix] of [
  ["commit", ""],
  ["tree", "^{tree}"],
  ["blob", ":source.txt"],
]) {
  test(`pinned physical changes ignore local ${kind} replacement without modifying it`, async (t) => {
    const repo = await repository(t);
    const expected = await repo.read();
    assert.equal(expected.complete, true);
    assert.equal(expected.files.find((file) => file.path === "source.txt").additions, 1);
    assert.equal(expected.files.find((file) => file.path === "format.txt").formattingOnly, true);
    assert.equal(classifyPhysicalDiff(expected).changed, 1);
    const original = repo.git(repo.source, "rev-parse", repo.after + suffix);
    const replacement = repo.git(repo.source, "rev-parse", repo.before + suffix);
    repo.git(repo.source, "replace", original, replacement);
    const replacementRef = `refs/replace/${original}`;
    const statusBefore = repo.git(repo.source, "status", "--porcelain");

    assert.deepEqual(await repo.read(), expected);
    assert.equal(repo.git(repo.source, "rev-parse", replacementRef), replacement);
    assert.equal(repo.git(repo.source, "status", "--porcelain"), statusBefore);
  });
}

test("an in-flight read keeps its original revision pins when the caller reuses its options", async (t) => {
  const repo = await repository(t);
  const expected = await repo.read();
  const options = { repositoryPath: repo.source, before: repo.before, after: repo.after };
  const pending = readPinnedGitDiff(options);
  options.before = repo.after;
  options.after = repo.before;

  assert.deepEqual(await pending, expected);
});

test("both comparisons keep the original repository when the caller reuses its options", async (t) => {
  const repo = await repository(t);
  const expected = await repo.read();
  const options = { repositoryPath: repo.source, before: repo.before, after: repo.after };
  const pending = readPinnedGitDiff(options);
  options.repositoryPath = join(repo.directory, "not-the-requested-repository");

  assert.deepEqual(await pending, expected);
});

test("an in-flight read copies caller-owned imported and generated path lists", async (t) => {
  const repo = await repository(t);
  const importedPaths = ["source.txt"];
  const generatedPaths = ["format.txt"];
  const options = {
    repositoryPath: repo.source,
    before: repo.before,
    after: repo.after,
    importedPaths,
    generatedPaths,
  };
  const expected = await readPinnedGitDiff(options);
  const pending = readPinnedGitDiff(options);
  importedPaths.length = 0;
  generatedPaths.length = 0;
  options.importedPaths = ["format.txt"];
  options.generatedPaths = ["source.txt"];

  assert.deepEqual(await pending, expected);
});

test("missing promisor blobs fail the local read without fetching or hydrating the object store", async (t) => {
  const repo = await repository(t);
  const clone = repo.partial();
  const blob = repo.git(repo.source, "rev-parse", `${repo.after}:source.txt`);
  const absent = () => assert.throws(() => repo.git(clone, "--no-lazy-fetch", "cat-file", "-e", blob));
  absent();
  const objectsBefore = (await readdir(join(clone, "objects"), { recursive: true })).sort();
  await assert.rejects(repo.read(clone));
  absent();
  assert.deepEqual((await readdir(join(clone, "objects"), { recursive: true })).sort(), objectsBefore);
});

test("an explicitly hydrated promisor repository retains exact changes and formatting exclusions", async (t) => {
  const repo = await repository(t);
  const expected = await repo.read();
  const clone = repo.partial();
  // Explicit fixture setup, separate from the read-only function being tested.
  // Keep background maintenance from racing the object-store snapshots below.
  repo.git(clone, "fetch", "--quiet", "--no-auto-maintenance", "--no-filter", "--refetch", "origin");
  const objectsBefore = (await readdir(join(clone, "objects"), { recursive: true })).sort();
  assert.deepEqual(await repo.read(clone), expected);
  assert.deepEqual((await readdir(join(clone, "objects"), { recursive: true })).sort(), objectsBefore);
});
