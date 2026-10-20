import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createService } from "../dist/app.js";
import { PUBLIC_EXPORT_LIMITS } from "../dist/exports.js";
import { metricRegistryV1 } from "../../../packages/metrics/dist/index.js";
import { readFixture } from "../../../tests/fixtures/pending-metric.mjs";
import { exportPage, ReadFailure, selection } from "../../web/src/remote/client.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedMetric = metricRegistryV1.metrics.find((metric) => metric.id === "pr_merged");
const failure = (code) => (error) => error instanceof ReadFailure && error.code === code;

// Pad synthetic public URLs within their existing source bound. Every proof is
// still attached to its original aggregate; source revisions and rows stay intact.
async function paddedExport(t, format, encoding, target) {
  const input = readFixture(100);
  const originalRows = structuredClone(input.selected.rows);
  const evidence = [...input.selected.evidence, ...input.selected.pendingEvidence];
  for (const entry of evidence) entry.artifact.publicUrl += "/";
  if (encoding === "multibyte") {
    for (const entry of input.selected.actors) entry.actor.login += "界";
  }
  const selected = selection(`?metric=pr_merged&snapshot=${input.selected.snapshot.snapshotId}&limit=100`);
  const app = createService({ source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  const path = `/api/v1/exports?metric=pr_merged&snapshot=${selected.snapshot}&limit=100&format=${format}`;
  const baseline = await app.inject(path);
  assert.equal(baseline.statusCode, 200);
  const gap = target - Buffer.byteLength(baseline.body);
  assert.ok(gap > 0);
  const each = Math.floor(gap / evidence.length);
  const remainder = gap % evidence.length;
  evidence.forEach((entry, index) => {
    entry.artifact.publicUrl += "x".repeat(each + (index < remainder ? 1 : 0));
    assert.ok(entry.artifact.publicUrl.length <= 2048);
  });
  assert.equal(input.selected.rows.length, 100);
  assert.deepEqual(input.selected.rows, originalRows);
  t.mock.method(globalThis, "fetch", async (raw, init) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    const url = new URL(String(raw), "https://synthetic.invalid");
    const actual = await app.inject(url.pathname + url.search);
    return new Response(actual.body, { status: actual.statusCode, headers: actual.headers });
  });
  return { app, path, selected };
}

for (const format of ["json", "csv"]) {
  for (const encoding of ["ascii", "multibyte"]) {
    for (const target of [2_000_000, 2_000_001, PUBLIC_EXPORT_LIMITS.bytes]) {
      test(`actual ${format} export ${encoding} at ${target} bytes reaches its downloader unchanged`, async (t) => {
        const { app, path, selected } = await paddedExport(t, format, encoding, target);
        const response = await app.inject(path);
        assert.equal(response.statusCode, 200);
        assert.equal(Buffer.byteLength(response.body), target);
        assert.equal(response.headers["cache-control"], "no-store");
        if (encoding === "multibyte") assert.ok(response.body.length < target);
        const blob = await exportPage("/api/v1", selected, format, new AbortController().signal, expectedMetric);
        assert.equal(blob.size, target);
        assert.equal(hash(Buffer.from(await blob.arrayBuffer())), hash(response.rawPayload));
      });
    }
    test(`actual ${format} export ${encoding} above the producer byte cap rejects the entire download`, async (t) => {
      const { app, path, selected } = await paddedExport(t, format, encoding, PUBLIC_EXPORT_LIMITS.bytes + 1);
      const response = await app.inject(path);
      assert.equal(response.statusCode, 413);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json(), { error: "export_too_large" });
      await assert.rejects(
        () => exportPage("/api/v1", selected, format, new AbortController().signal, expectedMetric),
        failure("export_http_413"),
      );
    });
  }
  for (const advertised of ["oversized", "absent", "false"]) {
    test(`${format} download enforces its byte cap with ${advertised} length and releases its stream`, async (t) => {
      const selected = selection("?metric=pr_merged&snapshot=synthetic-pending-1&limit=100");
      const chunks = [new Uint8Array(PUBLIC_EXPORT_LIMITS.bytes), new Uint8Array(1), new Uint8Array(1)];
      const state = { reads: 0, cancelled: false };
      const body = new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(chunks[state.reads++]);
          },
          cancel() {
            state.cancelled = true;
            return new Promise(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const headers = { "content-type": format === "json" ? "application/json" : "text/csv" };
      if (advertised === "oversized") headers["content-length"] = String(PUBLIC_EXPORT_LIMITS.bytes + 1);
      if (advertised === "false") headers["content-length"] = "2";
      t.mock.method(globalThis, "fetch", async () => new Response(body, { headers }));
      await assert.rejects(
        () => exportPage("/api/v1", selected, format, new AbortController().signal, expectedMetric),
        failure("api_response_too_large"),
      );
      assert.equal(state.reads, advertised === "oversized" ? 0 : 2);
      assert.equal(state.cancelled, true);
      assert.equal(body.locked, false);
    });
  }
}
