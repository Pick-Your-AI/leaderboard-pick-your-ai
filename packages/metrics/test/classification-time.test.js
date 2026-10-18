import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMetric, getMetricDefinition, selectPortfolioFacts } from "../dist/index.js";
import { classificationTimes, cutoff, frozenInput } from "../../../tests/fixtures/service-account-time.mjs";

const policy = {
  metricId: "pr_merged",
  version: "synthetic-classification-time/v1",
  definitionVersion: "synthetic-classification-time/v1",
  unit: getMetricDefinition("pr_merged").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: cutoff,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "all",
  context: "event",
};

for (const [name, select] of [
  ["aggregation", aggregateMetric],
  ["portfolio", selectPortfolioFacts],
])
  for (const [label, reviewedAt, admitted] of classificationTimes)
    test(name + " classification review cutoff preserves " + label, () => {
      const input = frozenInput(reviewedAt);
      const original = structuredClone(input);
      for (const actors of ["user", "automation", "all"]) {
        const run = () => select(input, policy, { ...scope, actors });
        if (!admitted) assert.throws(run, /frozen cutoff/);
        else {
          const result = run();
          const rows = name === "aggregation" ? result.rows : result;
          assert.equal(rows.length, actors === "user" ? 0 : 1);
          if (actors !== "user") {
            assert.equal(rows[0].actorId, "101");
            if (name === "aggregation") {
              assert.equal(rows[0].value, 1);
              assert.equal(rows[0].rank, 1);
            } else assert.equal(rows[0].id, "synthetic-classification-time-fact");
          }
        }
      }
      assert.deepEqual(input, original);
    });

test("classification source instants do not widen frozen metric clocks", () => {
  for (const value of ["2026-10-03T01:00:00.123+01:00", "2026-10-03T00:00:00.123000001Z", "2026-10-03T00:00:00.1230Z"])
    for (const select of [aggregateMetric, selectPortfolioFacts]) {
      assert.throws(() => select({ ...frozenInput(), cutoff: value }, policy, scope), /explicit UTC instant/);
      assert.throws(() => select(frozenInput(), policy, { ...scope, to: value }), /explicit UTC instant/);
    }
});
