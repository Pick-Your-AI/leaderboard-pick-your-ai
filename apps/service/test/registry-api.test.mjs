import test from "node:test";
import assert from "node:assert/strict";
import { metricRegistrySchema } from "@pick-your-ai/contracts";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { createService } from "../dist/app.js";

test("catalog serves all versioned metadata without implying or reading snapshot availability", async () => {
  let reads = 0;
  const registry = structuredClone(metricRegistryV1);
  registry.ui_metadata.metrics.find((entry) => entry.metric_id === "pr_merged").synonyms = ["served-only-alias"];
  const app = createService({
    registry,
    source: {
      async read() {
        reads++;
        throw new Error("Synthetic source unavailable");
      },
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/metrics" });
    assert.equal(response.statusCode, 200);
    const value = metricRegistrySchema.parse(response.json());
    assert.equal(value.metrics.length, 98);
    assert.equal(value.ui_metadata.version, "leaderboard-ui/v1");
    assert.equal(value.ui_metadata.public_enabled, false);
    assert.deepEqual(value.ui_metadata.metrics.find((entry) => entry.metric_id === "pr_merged").synonyms, [
      "served-only-alias",
    ]);
    assert.equal(reads, 0);
    for (const query of [
      "state=qualified&date_basis=acceptedAt",
      "state=&date_basis=",
      "department=delivery",
      "q=docs",
    ])
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/metrics?${query}` })).statusCode, 400);
    assert.equal(reads, 0);
  } finally {
    await app.close();
  }
});
