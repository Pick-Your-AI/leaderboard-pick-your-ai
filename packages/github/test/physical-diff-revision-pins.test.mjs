import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyPhysicalDiff, pinnedSha, readPinnedGitDiff } from "../src/physical-diff.ts";

// Node 24 executes this stdlib-only source directly. All Git objects are synthetic
// and local to disposable repositories; no contribution evidence is modified.
const mixedCase = (value) =>
  [...value].map((character, index) => (index % 2 ? character.toUpperCase() : character)).join("");
const aliases = (value) => [
  [value, value.toUpperCase()],
  [value.toUpperCase(), value],
  [mixedCase(value), value],
];
const file = { path: "source.txt", additions: 1, deletions: 0 };

async function repository(t, format) {
  const directory = await mkdtemp(join(tmpdir(), `physical-revision-pins-${format}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...arguments_) =>
    execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-C",
        directory,
        "-c",
        "core.hooksPath=",
        "-c",
        "core.autocrlf=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Synthetic Fixture",
        "-c",
        "user.email=synthetic@example.invalid",
        ...arguments_,
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    ).trim();
  git("init", "--quiet", `--object-format=${format}`);
  await writeFile(join(directory, "source.txt"), "first\n");
  git("add", "source.txt");
  git("commit", "--quiet", "-m", "Synthetic first object");
  const before = git("rev-parse", "HEAD");
  await writeFile(join(directory, "source.txt"), "first\nsecond\n");
  git("add", "source.txt");
  git("commit", "--quiet", "-m", "Synthetic second object");
  const after = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "Synthetic distinct commit with identical tree");
  return { directory, before, after, equalTree: git("rev-parse", "HEAD") };
}

for (const [format, length] of [
  ["sha1", 40],
  ["sha256", 64],
]) {
  const pin = "abcdef01".repeat(length / 8);
  const distinctPin = "fedcba98".repeat(length / 8);

  test(`${format}: classifier rejects case aliases of one revision`, () => {
    for (const [before, after] of aliases(pin)) {
      assert.notEqual(before, after);
      assert.equal(pinnedSha(before), true);
      assert.equal(pinnedSha(after), true);
      assert.throws(
        () => classifyPhysicalDiff({ before, after, complete: true, files: [file] }),
        /Distinct pinned before\/after SHAs are required/,
      );
    }
  });

  test(`${format}: classifier still rejects the identical pin spelling`, () => {
    assert.throws(
      () => classifyPhysicalDiff({ before: pin, after: pin, complete: true, files: [file] }),
      /Distinct pinned before\/after SHAs are required/,
    );
  });

  test(`${format}: classifier preserves distinct mixed-case pins and completeness`, () => {
    for (const complete of [false, true]) {
      const input = { before: mixedCase(pin), after: distinctPin.toUpperCase(), complete, files: [file] };
      const original = structuredClone(input);
      const classified = classifyPhysicalDiff(input);
      assert.equal(classified.complete, complete);
      assert.equal(classified.changed, complete ? 1 : null);
      assert.deepEqual(classified.reasons, complete ? [] : ["incomplete_or_truncated_diff"]);
      assert.deepEqual(input, original);
    }
  });

  test(`${format}: local reader rejects the same real object under every pin spelling`, async (t) => {
    const repo = await repository(t, format);
    for (const [before, after] of [...aliases(repo.after), [repo.after, repo.after]]) {
      const input = { repositoryPath: repo.directory, before, after };
      const original = structuredClone(input);
      await assert.rejects(readPinnedGitDiff(input), {
        message: "Distinct pinned before/after SHAs are required for Git fallback",
      });
      assert.deepEqual(input, original);
    }
  });

  test(`${format}: equivalent pins fail admission before an unusable Git repository is read`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "physical-revision-admission-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const repositoryPath = join(directory, "absent-repository");
    for (const [before, after] of [...aliases(pin), [pin, pin]]) {
      await assert.rejects(readPinnedGitDiff({ repositoryPath, before, after }), {
        message: "Distinct pinned before/after SHAs are required for Git fallback",
      });
    }
  });

  test(`${format}: local reader preserves distinct mixed-case pins and equal-tree commits`, async (t) => {
    const repo = await repository(t, format);
    const before = mixedCase(repo.before);
    const after = repo.after.toUpperCase();
    const input = { repositoryPath: repo.directory, before, after };
    const original = structuredClone(input);
    const diff = await readPinnedGitDiff(input);
    assert.equal(diff.before, before);
    assert.equal(diff.after, after);
    assert.equal(diff.complete, true);
    assert.equal(diff.files.length, 1);
    assert.equal(diff.files[0].path, "source.txt");
    assert.equal(diff.files[0].additions, 1);
    assert.equal(diff.files[0].deletions, 0);
    assert.equal(classifyPhysicalDiff(diff).changed, 1);
    assert.deepEqual(input, original);

    const equalBefore = repo.after.toUpperCase();
    const equalAfter = mixedCase(repo.equalTree);
    assert.notEqual(equalBefore.toLowerCase(), equalAfter.toLowerCase());
    const empty = await readPinnedGitDiff({ repositoryPath: repo.directory, before: equalBefore, after: equalAfter });
    assert.equal(empty.before, equalBefore);
    assert.equal(empty.after, equalAfter);
    assert.equal(empty.complete, true);
    assert.deepEqual(empty.files, []);
    assert.equal(classifyPhysicalDiff(empty).changed, 0);
  });
}
