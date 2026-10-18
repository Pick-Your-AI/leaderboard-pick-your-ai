// Synthetic publication inputs only; these checks do not establish source acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

function harness(t, input) {
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  return app;
}

function unavailable(response) {
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "public_projection_unavailable" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
}

function alias(input, { first = false, conflictingClock = false } = {}) {
  const copy = structuredClone(input.selected.pendingEvidence[0]);
  copy.contribution.contributionId = ` \t${copy.contribution.contributionId}\n`;
  if (conflictingClock) copy.observedAt = "2026-10-17T11:30:00.000Z";
  if (first) input.selected.pendingEvidence.unshift(copy);
  else input.selected.pendingEvidence.push(copy);
  return copy;
}

for (const [name, padding] of [
  ["spaces", " "],
  ["tabs and newlines", "\t\n"],
  ["Unicode spaces", "\u00a0"],
]) {
  test(`a unique pending ID normalized from ${name} retains its exact observation clock`, async (t) => {
    const input = readFixture();
    const original = input.selected.pendingEvidence[0];
    const id = original.contribution.contributionId;
    original.observedAt = "2026-10-17T11:30:00.123456789Z";
    original.contribution.contributionId = `${padding}${id}${padding}`;
    const before = structuredClone(input);
    const projected = projectRead(input, input.selected.scope, null);
    const pending = projected.selected.pendingEvidence.find((entry) => entry.contribution.contributionId === id);
    assert.equal(pending.observedAt, original.observedAt);
    const app = harness(t, input);
    for (const suffix of ["", `?snapshot=${input.head.snapshotId}`]) {
      const response = await app.inject(`/api/v1/evidence/${id}${suffix}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().contribution.contributionId, id);
      assert.equal(response.json().observedAt, original.observedAt);
    }
    assert.deepEqual(input, before, "Projection must not rewrite source evidence");
  });
}

for (const first of [false, true]) {
  for (const conflictingClock of [false, true]) {
    test(`normalized pending aliases reject ${conflictingClock ? "different" : "matching"} clocks with alias ${first ? "first" : "last"}`, async (t) => {
      const input = readFixture();
      const id = input.selected.pendingEvidence[0].contribution.contributionId;
      alias(input, { first, conflictingClock });
      const app = harness(t, input);
      for (const url of [
        "/api/v1/boards?metric=pr_merged",
        `/api/v1/evidence/${id}`,
        `/api/v1/evidence/${id}?snapshot=${input.head.snapshotId}`,
      ])
        unavailable(await app.inject(url));
    });
  }
}

for (const hidden of ["unknown actor", "suppressed artifact"]) {
  test(`normalized pending aliases reject before filtering a copy with ${hidden}`, async (t) => {
    const input = readFixture();
    const copy = alias(input);
    if (hidden === "unknown actor") copy.contribution.actorId = null;
    else input.controls.suppressedArtifactIds.push(copy.artifact.stableId);
    unavailable(await harness(t, input).inject("/api/v1/boards?metric=pr_merged"));
  });
}

test("pending alias corruption cannot reuse cached current or pinned reads and repair restores the original response", async (t) => {
  const input = readFixture();
  const id = input.selected.pendingEvidence[0].contribution.contributionId;
  const app = harness(t, input);
  const urls = [
    "/api/v1/boards?metric=pr_merged",
    `/api/v1/evidence/${id}`,
    "/api/v1/exports?metric=pr_merged&format=json",
    "/api/v1/exports?metric=pr_merged&format=csv",
  ].flatMap((url) => [url, `${url}${url.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}`]);
  const requests = [];
  for (const url of urls) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.ok(response.headers.etag);
    requests.push({ url, headers: { "if-none-match": response.headers.etag } });
  }
  alias(input);
  for (const request of requests) unavailable(await app.inject(request));
  input.selected.pendingEvidence.pop();
  for (const request of requests) assert.equal((await app.inject(request)).statusCode, 304);
});

test("exact duplicate pending IDs remain rejected", async (t) => {
  const input = readFixture();
  input.selected.pendingEvidence.push(structuredClone(input.selected.pendingEvidence[0]));
  unavailable(await harness(t, input).inject("/api/v1/boards?metric=pr_merged"));
});

test("distinct pending identities retain their separate clocks and accepted totals", async (t) => {
  const input = readFixture();
  const original = structuredClone(input);
  input.selected.pendingEvidence[0].observedAt = "2026-10-17T11:30:00.000Z";
  const projected = projectRead(input, input.selected.scope, null);
  assert.equal(new Set(projected.selected.pendingEvidence.map((entry) => entry.contribution.contributionId)).size, 3);
  assert.deepEqual(
    projected.selected.pendingEvidence.map((entry) => entry.observedAt),
    ["2026-10-17T11:30:00.000Z", at, at],
  );
  const response = await harness(t, input).inject("/api/v1/boards?metric=pr_merged");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response
      .json()
      .rows.map((row) => row.result.value)
      .sort((a, b) => a - b),
    original.selected.rows.map((row) => row.result.value).sort((a, b) => a - b),
  );
});
