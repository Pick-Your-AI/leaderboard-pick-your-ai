import assert from "node:assert/strict";
import test from "node:test";
import { metadata, ReadFailure, selection } from "../src/remote/client.ts";

const at = "2026-10-18T00:00:00.000Z";
const original = {
  schemaVersion: "leaderboard/v1",
  scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
  head: { snapshotId: "public-1", revision: 1, publishedAt: at },
  snapshotId: "public-1",
  revision: 1,
  generatedAt: at,
  metricDefinitionVersion: "candidate-0.1.0",
  computationVersion: "synthetic-only",
  policyVersion: "policy-1",
  coverage: [],
};

for (const field of ["generatedAt", "head.publishedAt"] as const) {
  const withDate = (value: unknown) =>
    field === "generatedAt"
      ? { ...original, generatedAt: value }
      : { ...original, head: { ...original.head, publishedAt: value } };

  test(`metadata rejects malformed ${field} with a bounded public failure`, () => {
    for (const value of [
      undefined,
      null,
      0,
      [],
      {},
      "",
      "not-a-date",
      "2026-10-18",
      "2026-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-10-18T00:00:00",
      "2026-10-18T00:00:60Z",
      "2026-10-18T00:00:00+24:00",
      "2026-10-18T00:00:00+02:60",
      "2026-10-18T00:00:00." + "1".repeat(4096) + "Z",
    ]) {
      assert.throws(
        () => metadata(withDate(value), selection("")),
        (error: unknown) => {
          assert.ok(error instanceof ReadFailure);
          assert.equal(error.status, 502);
          assert.equal(error.code, "invalid_api_response");
          return true;
        },
        `${field}: ${JSON.stringify(value)}`,
      );
    }
  });

  test(`metadata preserves contract-valid ${field} offsets and precision without inventing ordering`, () => {
    for (const value of [
      at,
      "2026-10-18T02:00:00+02:00",
      "2026-10-17T19:00:00-05:00",
      "2024-02-29T23:59:59.123456789Z",
    ]) {
      const result = metadata(withDate(value), selection(""));
      assert.equal(field === "generatedAt" ? result.generatedAt : result.head.publishedAt, value);
    }
  });
}
