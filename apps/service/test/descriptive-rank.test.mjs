import test from "node:test";
import assert from "node:assert/strict";
import { metricRegistryV1 } from "../../../packages/metrics/dist/index.js";
import { readFixture } from "../../../tests/fixtures/pending-metric.mjs";
import { createService } from "../dist/app.js";

const url = "/api/v1/boards?metric=pr_merged";
test("public rank validation uses the configured registry and preserves eligible count ranking", async (t) => {
  const registry = structuredClone(metricRegistryV1);
  registry.metrics.find((metric) => metric.id === "pr_merged").definition.release_eligibility = "descriptive-only";
  for (const configured of [false, true]) {
    let value = readFixture();
    const app = createService({
      source: { read: async () => structuredClone(value) },
      ...(configured ? { registry } : {}),
    });
    t.after(() => app.close());
    const first = await app.inject(url);
    assert.equal(first.statusCode, configured ? 503 : 200, first.body);
    if (!configured)
      assert.deepEqual(
        first.json().rows.map((row) => row.rank),
        [1, 2],
      );
    value.selected.ranking[0].rank = false;
    const unranked = await app.inject(url);
    assert.equal(unranked.statusCode, 200, unranked.body);
    assert.ok(unranked.json().rows.every((row) => row.rank === null));
  }
});

test("conditional reads revalidate descriptive ranking instead of returning a cached success", async (t) => {
  const value = readFixture();
  for (const row of value.selected.rows) row.result.metricId = "active_periods";
  for (const evidence of [...value.selected.evidence, ...(value.selected.pendingEvidence ?? [])])
    evidence.contribution.metricIds = ["active_periods"];
  value.selected.ranking = [{ metricId: "active_periods", direction: "descending", rank: false }];
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const path = "/api/v1/boards?metric=active_periods";
  const first = await app.inject(path);
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.headers.etag);
  value.selected.ranking[0].rank = true;
  const next = await app.inject({ url: path, headers: { "if-none-match": first.headers.etag } });
  assert.equal(next.statusCode, 503, next.body);
  assert.equal(next.headers.etag, undefined);
  assert.doesNotMatch(next.body, /synthetic-pending/);
});
