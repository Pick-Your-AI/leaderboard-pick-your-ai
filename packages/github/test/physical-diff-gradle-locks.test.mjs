import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyPhysicalDiff, readPinnedGitDiff } from "../dist/index.js";

// Constructed fixtures exercise physical Git accounting, not real contribution evidence.
async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "physical-diff-gradle-"));
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
  const write = async (path, content) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  };
  git("init", "--quiet");
  await write("src/base.ts", "export const syntheticBase = true;\n");
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "Synthetic physical accounting fixture");
    return git("rev-parse", "HEAD");
  };
  return { directory, write, commit };
}

test("real Git accounting excludes root and module Gradle locks while retaining added and deleted raw lines", async (t) => {
  const repo = await repository(t);
  await repo.write("gradle.lockfile", "synthetic:root:1=runtime\n");
  await repo.write("core/gradle.lockfile", "synthetic:core:1=runtime\n");
  await repo.write("removed/gradle.lockfile", "synthetic:removed:1=runtime\n");
  const before = repo.commit();
  await repo.write("gradle.lockfile", "synthetic:root:2=runtime\n");
  await repo.write("core/gradle.lockfile", "synthetic:core:2=runtime\n");
  await rm(join(repo.directory, "removed/gradle.lockfile"));
  await repo.write("added/gradle.lockfile", "synthetic:added:3=runtime\n");
  await repo.write("src/Feature.kt", "val syntheticFeature = true\n");
  const after = repo.commit();
  const result = classifyPhysicalDiff(await readPinnedGitDiff({ repositoryPath: repo.directory, before, after }));
  assert.equal(result.complete, true);
  assert.equal(result.rawAdditions, 4);
  assert.equal(result.rawDeletions, 3);
  const locks = result.files.filter((file) => file.path.endsWith("gradle.lockfile"));
  assert.deepEqual(locks.map((file) => file.path).sort(), [
    "added/gradle.lockfile",
    "core/gradle.lockfile",
    "gradle.lockfile",
    "removed/gradle.lockfile",
  ]);
  for (const file of locks) {
    assert.equal(file.classification, "lock", file.path);
    assert.equal(file.eligible, false, file.path);
    assert.equal(file.reason, "lock", file.path);
  }
  assert.equal(result.files.find((file) => file.path === "src/Feature.kt").eligible, true);
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 0);
  assert.equal(result.changed, 1);
  assert.equal(result.net, 1);
  assert.equal(result.filesChanged, 1);
});

test("Gradle lock exclusion preserves source paths with a prefix, suffix or directory-only name match", async (t) => {
  const repo = await repository(t);
  const before = repo.commit();
  for (const path of ["src/custom-gradle.lockfile", "src/gradle.lockfile.kt", "src/gradle.lockfile/holder.kt"])
    await repo.write(path, "// Constructed source path control\n");
  const after = repo.commit();
  const result = classifyPhysicalDiff(await readPinnedGitDiff({ repositoryPath: repo.directory, before, after }));
  assert.equal(result.complete, true);
  assert.equal(result.files.length, 3);
  for (const file of result.files) {
    assert.equal(file.classification, "source", file.path);
    assert.equal(file.eligible, true, file.path);
    assert.equal(file.reason, null, file.path);
  }
  assert.equal(result.rawAdditions, 3);
  assert.equal(result.rawDeletions, 0);
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 0);
  assert.equal(result.filesChanged, 3);
});

test("a forty-file synthetic formatting batch retains raw churn and only admits its substantive source control", async (t) => {
  const repo = await repository(t);
  for (let index = 0; index < 40; index++)
    await repo.write(`src/fixture-${index}.ts`, `export function synthetic${index}() {\n  return ${index};\n}\n`);
  const before = repo.commit();
  for (let index = 0; index < 40; index++)
    await repo.write(`src/fixture-${index}.ts`, `export function synthetic${index}() {\n    return ${index};\n}\n`);
  await repo.write("src/substantive.ts", "export const syntheticControl = true;\n");
  const after = repo.commit();
  const result = classifyPhysicalDiff(await readPinnedGitDiff({ repositoryPath: repo.directory, before, after }));
  assert.equal(result.complete, true);
  assert.equal(result.rawAdditions, 41);
  assert.equal(result.rawDeletions, 40);
  assert.equal(result.files.length, 41);
  const formatting = result.files.filter((file) => file.path !== "src/substantive.ts");
  assert.equal(formatting.length, 40);
  for (const file of formatting) {
    assert.equal(file.classification, "source", file.path);
    assert.equal(file.formattingOnly, true, file.path);
    assert.equal(file.eligible, false, file.path);
    assert.equal(file.reason, "formatting_only", file.path);
  }
  assert.equal(result.files.find((file) => file.path === "src/substantive.ts").eligible, true);
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 0);
  assert.equal(result.changed, 1);
  assert.equal(result.net, 1);
  assert.equal(result.filesChanged, 1);
});
