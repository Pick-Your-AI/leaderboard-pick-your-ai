import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cases } from "./fixtures/github-enrichment-callbacks.mjs";

const fixture = fileURLToPath(new URL("./fixtures/github-enrichment-callbacks.mjs", import.meta.url));
test("GitHub enrichment callbacks retain fixed failures without native rejection leaks", async (t) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [fixture], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 128 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  const observations = JSON.parse(child.stdout);
  assert.deepEqual(
    observations.map(({ boundary, scenario }) => ({ boundary, scenario })),
    cases,
  );
  for (const [index, { boundary, scenario }] of cases.entries())
    await t.test(`${boundary}: ${scenario}`, () => {
      const actual = observations[index];
      const allowed = scenario === "valid synchronous result";
      assert.deepEqual(
        actual.error,
        allowed
          ? null
          : boundary === "repository binding"
            ? { name: "TypeError", message: "invalid_github_enrichment_options" }
            : { name: "Error", message: "github_enrichment_unavailable" },
      );
      assert.deepEqual(
        actual.result,
        allowed
          ? {
              sourceRevision: "a".repeat(40),
              acceptedOutcome: true,
              reviewState: null,
              additions: 9,
              deletions: 2,
              changedFiles: null,
            }
          : null,
      );
      assert.ok(actual.counters.callbackCalls > 0);
      assert.equal(actual.counters.providerReads, allowed ? 2 : 0);
      assert.equal(actual.counters.outcomeReads, allowed ? 1 : 0);
      assert.equal(actual.counters.foreignGetters, 0);
      assert.equal(actual.counters.foreignThenCalls, 0);
      assert.deepEqual(actual.unhandledRejections, []);
    });
});
