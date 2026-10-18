import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyPhysicalDiff, readPinnedGitDiff } from "../dist/index.js";

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "physical-diff-utf8-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-C",
        directory,
        "-c",
        "core.hooksPath=",
        "-c",
        "user.name=Synthetic Fixture",
        "-c",
        "user.email=synthetic@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "docs"));
  await writeFile(join(directory, "src", "base.ts"), "export const base = true;\n");
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "Synthetic physical diff fixture");
    return git("rev-parse", "HEAD");
  };
  const rawPath = (bytes) =>
    Buffer.concat([Buffer.from(join(directory, "src") + "/"), Buffer.from(bytes), Buffer.from(".ts")]);
  return { directory, commit, rawPath };
}

for (const [kind, bytes] of [
  ["invalid leading byte", [0xff]],
  ["unfinished multibyte sequence", [0xc3]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
]) {
  test(`bounded Git fallback rejects an ${kind} instead of changing the manifest path`, async (t) => {
    const repo = await repository(t);
    const before = repo.commit();
    await writeFile(repo.rawPath(bytes), "export const changed = true;\n");
    const after = repo.commit();
    await assert.rejects(readPinnedGitDiff({ repositoryPath: repo.directory, before, after }), {
      code: "ERR_ENCODING_INVALID_ENCODED_DATA",
    });
  });
}

test("bounded Git fallback rejects malformed bytes in a rename's original path", async (t) => {
  const repo = await repository(t);
  const original = repo.rawPath([0xff]);
  await writeFile(original, "export const renamed = true;\n");
  const before = repo.commit();
  await rename(original, join(repo.directory, "src", "renamed.ts"));
  const after = repo.commit();
  await assert.rejects(readPinnedGitDiff({ repositoryPath: repo.directory, before, after }), {
    code: "ERR_ENCODING_INVALID_ENCODED_DATA",
  });
});

test("bounded Git fallback preserves valid Unicode paths and exact provenance selectors", async (t) => {
  const repo = await repository(t);
  const before = repo.commit();
  for (const path of ["src/�.ts", "src/É.ts", "docs/設計.md"])
    await writeFile(join(repo.directory, path), "synthetic physical line\n");
  const after = repo.commit();
  const diff = await readPinnedGitDiff({
    repositoryPath: repo.directory,
    before,
    after,
    importedPaths: ["src/É.ts"],
    generatedPaths: ["docs/設計.md"],
  });
  assert.equal(diff.complete, true);
  assert.deepEqual(diff.files.map((file) => file.path).sort(), ["docs/設計.md", "src/É.ts", "src/�.ts"].sort());
  const classified = classifyPhysicalDiff(diff);
  assert.equal(classified.rawAdditions, 3);
  assert.equal(classified.additions, 1);
  assert.equal(classified.deletions, 0);
  assert.equal(classified.changed, 1);
  assert.equal(classified.net, 1);
  assert.equal(classified.filesChanged, 1);
  assert.equal(classified.files.find((file) => file.path === "src/É.ts").reason, "imported");
  assert.equal(classified.files.find((file) => file.path === "docs/設計.md").reason, "generated");
  assert.equal(classified.files.find((file) => file.path === "src/�.ts").eligible, true);
});

test("bounded Git fallback preserves both exact Unicode rename paths and known zero lines", async (t) => {
  const repo = await repository(t);
  await writeFile(join(repo.directory, "src", "原名.ts"), "export const renamed = true;\n");
  const before = repo.commit();
  await rename(join(repo.directory, "src", "原名.ts"), join(repo.directory, "src", "新名.ts"));
  const after = repo.commit();
  const diff = await readPinnedGitDiff({ repositoryPath: repo.directory, before, after });
  assert.equal(diff.complete, true);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].path, "src/新名.ts");
  assert.equal(diff.files[0].previousPath, "src/原名.ts");
  const classified = classifyPhysicalDiff(diff);
  assert.equal(classified.additions, 0);
  assert.equal(classified.deletions, 0);
  assert.equal(classified.changed, 0);
  assert.equal(classified.net, 0);
});

test("byte decoding retains the configured subprocess output bound", async (t) => {
  const repo = await repository(t);
  const before = repo.commit();
  await writeFile(join(repo.directory, "src", "é.ts"), "export const changed = true;\n");
  const after = repo.commit();
  await assert.rejects(readPinnedGitDiff({ repositoryPath: repo.directory, before, after, maxBytes: 1 }), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
});
