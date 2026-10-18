import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SoakFailures } from "../soak/failures.ts";
import { cleanupOwned } from "../soak/runtime.ts";
import { finalizeAttempt } from "../soak/receipt.ts";

test("unexpected errors retain the first cause per source, including falsy throws", () => {
  for (const cause of [undefined, null, false, 0, ""]) {
    const failures = new SoakFailures();
    failures.assertClear();
    for (const source of ["heartbeat", "route", "page"]) {
      failures.record(source, cause);
      failures.record(source, new Error("later error must not replace the first cause"));
    }
    for (let check = 0; check < 2; check++)
      assert.throws(
        () => failures.assertClear(),
        (error) => {
          assert(error instanceof AggregateError);
          assert.equal(error.errors.length, 3);
          for (const recorded of error.errors) assert.equal(recorded.cause, cause);
          return true;
        },
      );
  }
});

// Execute the actual final matrix section with synthetic browser/prerequisite
// stubs. This source-tail regression supplies no browser or duration evidence.
const source = await readFile(new URL("../soak/wall.soak.ts", import.meta.url), "utf8");
const begin = source.lastIndexOf("      await healthy();");
const end = source.indexOf("    } catch (error) {", begin);
assert(begin > 0 && end > begin, "The actual final matrix section must be located");
const body = source.slice(begin, end);
assert(body.includes('result = full ? "completed-full-real-duration-matrix"'));
const runTail = new Function(
  "assert",
  "SoakFailures",
  `
  return async function run(faultKind) {
    const failures = new SoakFailures();
    const healthy = async () => {}, requireAutomatic = async () => {};
    const record = async () => {};
    const measureResources = async () => {
      if (faultKind) failures.record(faultKind, new Error("injected late " + faultKind));
      return {};
    };
    const full = true, start = performance.now(), actionIndex = 20;
    const actions = Array.from({length: 20}, () => ({}));
    const counters = { networkAborts: 1 };
    const checks = Object.fromEntries([
      "networkCleared", "networkRecovered", "sourceCleared", "sourceRecovered",
      "suppressionApplied", "realCursorExpired", "realBackgroundCleared",
      "realForegroundRecovered", "revocationRecovered", "fourK", "deviceScale",
      "sourceStale", "sourceFreshAgain", "timezoneChanged"
    ].map(name => [name, true]));
    const page = {evaluate: async () => ({visibility: "visible", controlState: "Automatic page boundaries"})};
    const intent = {observe() {}, finish() {}}, history = {size: 16}, seen = {size: 5};
    const naturalRollover = true, cycles = {summary: () => ({completeCycles: 1})};
    const built = {sha256: "synthetic-compiled-hash"};
    const compiledOutputs = async () => built;
    const input = {tree: "synthetic-tree"};
    const git = (...args) => args[0] === "status" ? "" : input.tree;
    let result = "failed";
    ${body}
    return result;
  };
`,
)(assert, SoakFailures);

test("the actual final matrix section succeeds without unexpected errors", async () => {
  assert.equal(await runTail(null), "completed-full-real-duration-matrix");
});
for (const kind of ["heartbeat", "route", "page"])
  test(`the actual final matrix section rejects a ${kind} error during final resource collection`, async () => {
    await assert.rejects(runTail(kind), new RegExp("injected late " + kind));
  });

async function pendingAttempt(t) {
  const directory = await mkdtemp(join(tmpdir(), "pyai-soak-late-error-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attempt = { id: directory.split("/").at(-1), directory, startedAt: new Date().toISOString() };
  // This is an explicitly synthetic finalization input, never an execution receipt.
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify({
      attemptId: attempt.id,
      result: "pending-owned-cleanup",
      failure: null,
      matrixResult: "completed-full-real-duration-matrix",
      fullMatrix: true,
      requestedMinutes: 480,
      elapsedMilliseconds: 480 * 60_000,
    }) + "\n",
  );
  return attempt;
}

async function finishOwned(attempt, failures, inject) {
  for (const stage of ["service", "browser"])
    try {
      await cleanupOwned(
        join(attempt.directory, `${stage}-cleanup.json`),
        attempt.id,
        [
          [
            stage === "service" ? "finish public routes" : "stop owned browser",
            async () => {
              await Promise.resolve();
              inject?.(stage);
            },
          ],
          ["finish remaining owned cleanup", async () => {}],
        ],
        failures,
      );
    } catch (error) {
      assert(error instanceof AggregateError);
    }
  // Even a body already reported as passed cannot override a late cleanup error.
  return finalizeAttempt(attempt, "passed");
}

test("normal owned cleanup permits the pending primary result to finalize", async (t) => {
  const attempt = await pendingAttempt(t);
  assert.equal((await finishOwned(attempt, new SoakFailures())).completed, true);
});
for (const stage of ["service", "browser"])
  for (const kind of ["heartbeat", "route", "page"])
    test(`a ${kind} error captured during awaited ${stage} cleanup prevents primary success`, async (t) => {
      const attempt = await pendingAttempt(t);
      const failures = new SoakFailures();
      const outcome = await finishOwned(attempt, failures, (current) => {
        if (current === stage) failures.record(kind, new Error(`late ${kind} during ${stage}`));
      });
      assert.equal(outcome.completed, false);
      const summary = JSON.parse(await readFile(join(attempt.directory, "summary.json"), "utf8"));
      assert.equal(summary.result, "failed");
      assert.equal(summary.cleanupChecks[stage], false);
      assert(summary.cleanupFailures.some((failure) => failure.includes(`late ${kind} during ${stage}`)));
    });
