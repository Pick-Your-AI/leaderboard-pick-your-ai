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

test("missing descriptive ranking descriptors fail closed before boards, profiles and exports", async (t) => {
  const value = readFixture();
  for (const row of value.selected.rows) row.result.metricId = "active_periods";
  for (const evidence of [...value.selected.evidence, ...(value.selected.pendingEvidence ?? [])])
    evidence.contribution.metricIds = ["active_periods"];
  value.selected.ranking = [];
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  for (const path of [
    "boards?metric=active_periods",
    "contributors/synthetic-pending-a?metric=active_periods",
    "exports?metric=active_periods&format=json",
    "exports?metric=active_periods&format=csv",
  ]) {
    const response = await app.inject(`/api/v1/${path}`);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.headers.etag, undefined);
  }
});

test("JSON downloads bind descriptive semantics to the loaded registry definition", async (t) => {
  const { exportPage, selection } = await import("../../web/src/remote/client.ts");
  const value = readFixture();
  for (const row of value.selected.rows) row.result.metricId = "active_periods";
  for (const evidence of [...value.selected.evidence, ...(value.selected.pendingEvidence ?? [])])
    evidence.contribution.metricIds = ["active_periods"];
  value.selected.ranking = [{ metricId: "active_periods", direction: "descending", rank: false }];
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const response = await app.inject("/api/v1/exports?metric=active_periods&format=json");
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  const expected = metricRegistryV1.metrics.find((metric) => metric.id === "active_periods");
  const selected = selection(`?metric=active_periods&snapshot=${payload.snapshotId}`);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
  );
  const download = () => exportPage("/api/v1", selected, "json", new AbortController().signal, expected);
  assert.deepEqual(JSON.parse(await (await download()).text()), payload);
  payload.metric.definition.release_eligibility = "automatic-baseline";
  payload.metric.definition.aggregation = "count";
  payload.ranking.rank = true;
  payload.rows[0].rank = 1;
  await assert.rejects(download, /invalid_export_response/);
  // Definition substitution is rejected even when it keeps rows unranked.
  payload.ranking.rank = false;
  payload.rows[0].rank = null;
  await assert.rejects(download, /invalid_export_response/);
});
