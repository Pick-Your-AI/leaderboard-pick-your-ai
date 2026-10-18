import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeAttempt } from "../soak/receipt.ts";

const fullResult = "completed-full-real-duration-matrix";
const shortResult = "completed-short-rehearsal-only";
const json = async (attempt, name) => JSON.parse(await readFile(join(attempt.directory, name), "utf8"));
const write = async (attempt, name, value) => writeFile(join(attempt.directory, name), JSON.stringify(value) + "\n");
async function fixture(t, summary = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pyai-soak-finalization-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attempt = { id: directory.split("/").at(-1), directory, startedAt: new Date().toISOString() };
  await write(attempt, "summary.json", {
    attemptId: attempt.id,
    result: "pending-owned-cleanup",
    matrixResult: fullResult,
    failure: null,
    requestedMinutes: 480,
    elapsedMilliseconds: 480 * 60_000,
    fullMatrix: true,
    ...summary,
  });
  for (const stage of ["service", "browser"])
    await write(attempt, `${stage}-cleanup.json`, { attemptId: attempt.id, failures: [] });
  return attempt;
}

test("a completed matrix remains pending until both owned cleanups allow final publication", async (t) => {
  const attempt = await fixture(t);
  assert.equal((await json(attempt, "summary.json")).result, "pending-owned-cleanup");
  assert.deepEqual(await finalizeAttempt(attempt, "passed"), {
    completed: true,
    result: fullResult,
    testStatus: "passed",
  });
  const summary = await json(attempt, "summary.json");
  assert.equal(summary.result, fullResult);
  assert.equal(summary.failure, null);
  assert.deepEqual(summary.cleanupChecks, { service: true, browser: true });
  assert.deepEqual(summary.cleanupFailures, []);
  assert.equal(summary.attemptId, attempt.id);
  assert.equal((await json(attempt, "run-status.json")).result, fullResult);
  const event = JSON.parse((await readFile(join(attempt.directory, "events.jsonl"), "utf8")).trim());
  assert.equal(event.event, "attempt-end");
  assert.equal(event.attemptId, attempt.id);
});

test("a short rehearsal retains its limited result after successful cleanup", async (t) => {
  const attempt = await fixture(t, {
    matrixResult: shortResult,
    requestedMinutes: 2,
    elapsedMilliseconds: 120_001,
    fullMatrix: false,
  });
  assert.equal((await finalizeAttempt(attempt, "passed")).result, shortResult);
  assert.equal((await json(attempt, "summary.json")).fullMatrix, false);
});

test("either cleanup failure, missing receipt, malformed receipt or wrong identity prevents primary success", async (t) => {
  for (const stage of ["service", "browser"]) {
    for (const mode of ["failed", "missing", "malformed", "wrong identity", "missing failure list"]) {
      await t.test(`${stage}: ${mode}`, async (t) => {
        const attempt = await fixture(t);
        const name = `${stage}-cleanup.json`;
        if (mode === "missing") await rm(join(attempt.directory, name));
        else if (mode === "malformed") await writeFile(join(attempt.directory, name), "{unfinished");
        else
          await write(attempt, name, {
            attemptId: mode === "wrong identity" ? "previous-attempt" : attempt.id,
            ...(mode === "missing failure list"
              ? {}
              : { failures: mode === "failed" ? ["owned process has not exited"] : [] }),
          });
        assert.equal((await finalizeAttempt(attempt, "passed")).completed, false);
        const summary = await json(attempt, "summary.json");
        assert.equal(summary.result, "failed");
        assert.equal(summary.testStatus, "failed");
        assert.equal(summary.cleanupChecks[stage], false);
        assert(summary.cleanupFailures.length > 0);
        assert.equal((await json(attempt, "run-status.json")).testStatus, "failed");
      });
    }
  }
});

test("failed, timed-out and interrupted test bodies cannot publish a completed matrix", async (t) => {
  for (const status of ["failed", "timedOut", "interrupted", "unknown"]) {
    const attempt = await fixture(t);
    const expected = status === "interrupted" ? "interrupted" : "failed";
    assert.deepEqual(await finalizeAttempt(attempt, status), {
      completed: false,
      result: expected,
      testStatus: expected,
    });
    assert.equal((await json(attempt, "summary.json")).result, expected);
    assert.equal((await json(attempt, "run-status.json")).bodyStatus, status);
  }
});

test("an interruption before the body summary produces an explicit interrupted primary receipt", async (t) => {
  const attempt = await fixture(t);
  await rm(join(attempt.directory, "summary.json"));
  await rm(join(attempt.directory, "service-cleanup.json"));
  assert.equal((await finalizeAttempt(attempt, "interrupted")).result, "interrupted");
  const summary = await json(attempt, "summary.json");
  assert.equal(summary.attemptId, attempt.id);
  assert.equal(summary.result, "interrupted");
  assert.equal(summary.cleanupChecks.service, false);
  assert.match(summary.failure, /summary.json is missing or invalid/);
});

test("incomplete durations, mixed full/short labels, old successes and mismatched attempts fail closed", async (t) => {
  for (const mutation of [
    { elapsedMilliseconds: 480 * 60_000 - 1 },
    { requestedMinutes: 2, elapsedMilliseconds: 120_000 },
    { matrixResult: shortResult },
    { fullMatrix: false },
    { requestedMinutes: "480" },
    { failure: "matrix assertion failed" },
    { result: fullResult },
    { attemptId: "previous-attempt" },
  ]) {
    const attempt = await fixture(t, mutation);
    assert.equal((await finalizeAttempt(attempt, "passed")).result, "failed");
    assert.equal((await json(attempt, "summary.json")).testStatus, "failed");
  }
});

test("a final receipt write failure cannot leave primary success", async (t) => {
  const attempt = await fixture(t);
  await mkdir(join(attempt.directory, "summary.finalizing.json"));
  await assert.rejects(finalizeAttempt(attempt, "passed"), { code: "EEXIST" });
  assert.equal((await json(attempt, "summary.json")).result, "pending-owned-cleanup");
});
