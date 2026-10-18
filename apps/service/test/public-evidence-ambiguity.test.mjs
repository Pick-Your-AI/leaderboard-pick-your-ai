import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

function nonPublicCopy(entry, visibility) {
  const copy = structuredClone(entry);
  copy.artifact.visibility = visibility;
  delete copy.artifact.publicUrl;
  return copy;
}

for (const visibility of ["private", "unknown", "deleted", "unavailable"]) {
  test(`a ${visibility} duplicate proof cannot be discarded to publish the same contribution ID`, () => {
    for (const first of [false, true]) {
      const input = readFixture();
      const duplicate = nonPublicCopy(input.selected.evidence[0], visibility);
      if (first) input.selected.evidence.unshift(duplicate);
      else input.selected.evidence.push(duplicate);
      assert.throws(() => projectRead(input, input.selected.scope, null), {
        status: 503,
        code: "public_projection_unavailable",
      });
    }
  });
}

test("conflicting proof visibility cannot reuse pinned board, detail or export responses", async (t) => {
  const input = readFixture();
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  const evidenceId = input.selected.evidence[0].contribution.contributionId;
  const paths = [
    "/api/v1/boards?metric=pr_merged",
    `/api/v1/evidence/${evidenceId}`,
    "/api/v1/exports?metric=pr_merged&format=json",
    "/api/v1/exports?metric=pr_merged&format=csv",
  ].map((path) => `${path}${path.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}`);
  const previous = new Map();
  for (const path of paths) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200, path);
    previous.set(path, response.headers.etag);
  }
  input.selected.evidence.push(nonPublicCopy(input.selected.evidence[0], "private"));
  for (const url of paths) {
    const response = await app.inject({ url, headers: { "if-none-match": previous.get(url) } });
    assert.equal(response.statusCode, 503, url);
    assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("a unique private proof still removes its dependent aggregate while other actors remain", () => {
  const input = readFixture();
  const removed = input.selected.evidence[0];
  input.selected.evidence[0] = nonPublicCopy(removed, "private");
  const projected = projectRead(input, input.selected.scope, null);
  assert.ok(projected.selected.rows.length > 0);
  assert.ok(projected.selected.rows.every((row) => row.actorId !== removed.contribution.actorId));
  assert.ok(
    projected.selected.evidence.every(
      (entry) => entry.contribution.contributionId !== removed.contribution.contributionId,
    ),
  );
});

test("the same legitimate proof may appear in distinct accepted and portfolio collections", () => {
  const input = readFixture();
  input.selected.portfolioEvidence = input.selected.evidence.map((entry) => ({
    ...structuredClone(entry),
    activityState: "accepted",
    observedAt: at,
  }));
  const projected = projectRead(input, input.selected.scope, null);
  assert.equal(projected.selected.rows.length, input.selected.rows.length);
  assert.equal(projected.selected.evidence.length, input.selected.evidence.length);
  assert.equal(projected.selected.portfolioEvidence.length, input.selected.portfolioEvidence.length);
});
