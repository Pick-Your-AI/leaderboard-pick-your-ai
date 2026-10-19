import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scenarios } from "./fixtures/metadata-current-authority.mjs";

const fixture = fileURLToPath(new URL("./fixtures/metadata-current-authority.mjs", import.meta.url));
test("synchronous metadata authority observes only native rejected promises", async (t) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [fixture], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  const observations = JSON.parse(child.stdout);
  const expected = ["pipeline", "ingestion"].flatMap((boundary) =>
    scenarios.map((scenario) => ({ boundary, scenario })),
  );
  assert.deepEqual(
    observations.map(({ boundary, scenario }) => ({ boundary, scenario })),
    expected,
  );
  for (const [index, { boundary, scenario }] of expected.entries())
    await t.test(`${boundary}: ${scenario}`, () => {
      const actual = observations[index];
      assert.equal(actual.boundary, boundary);
      assert.equal(actual.scenario, scenario);
      const allowed = ["literal true", "asynchronous authorize"].includes(scenario);
      if (allowed) {
        assert.equal(actual.error, null);
        assert.deepEqual(actual.result, [
          {
            factKey: "1".repeat(64),
            sourceRevision: "synthetic-revision",
            state: "failed",
            attempts: 1,
            reason: "enrichment_unavailable",
          },
        ]);
      } else {
        assert.equal(actual.error, "enrichment_authorization_changed");
        assert.equal(actual.result, null);
      }
      assert.equal(actual.counters.recordReads, allowed || scenario === "revoked after transaction" ? 1 : 0);
      assert.ok(actual.counters.callbacks > 0);
      assert.equal(actual.counters.metadataCalls, 0);
      assert.equal(actual.counters.foreignGetters, 0);
      assert.equal(actual.counters.foreignThenCalls, 0);
      assert.deepEqual(actual.unhandledRejections, []);
      if (scenario === "asynchronous authorize") {
        assert.ok(actual.counters.authorizations > 0);
        assert.equal(actual.counters.asynchronousAuthorizations, actual.counters.authorizations);
      }
    });
});
