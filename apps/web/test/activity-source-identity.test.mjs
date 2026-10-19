import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { readFixture } from "../../../tests/fixtures/pending-metric.mjs";
import { artifactSchema } from "@pick-your-ai/contracts";
import { activity, activityDetail, selection } from "../src/remote/client.ts";

const query = "?snapshot=synthetic-pending-1&limit=100&category=pr_merged";
const selected = selection(query);
const originalId = "artifact-synthetic-101-0";
const sourceIds = [
  ["padded source node ID", Buffer.from("011:PullRequest10").toString("base64")],
  ["source ID beyond the route identifier length", "A".repeat(201)],
];
function harness(t, artifactId = originalId) {
  const input = readFixture();
  for (const entry of input.selected.evidence) {
    if (entry.artifact.stableId !== originalId) continue;
    // Keep this source in its own hour so its preview does not depend on a fact-ID tie.
    entry.occurredAt = "2026-10-17T11:00:00.000Z";
    entry.artifact.stableId = artifactId;
    entry.contribution.artifactId = artifactId;
  }
  const before = structuredClone(input);
  const app = createService({
    cursorSecret: "synthetic-activity-source-identity-000000",
    source: { read: async () => structuredClone(input) },
  });
  t.after(() => {
    assert.deepEqual(input, before, "service and client reads must not rewrite source identities");
    return app.close();
  });
  return app;
}
async function feed(app) {
  const response = await app.inject("/api/v1/activity" + query);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function proofs(app, group) {
  const response = await app.inject("/api/v1/activity/" + group.groupId + query);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
test("the valid public fixture admits activity feed and proof responses", async (t) => {
  const app = harness(t);
  const value = await feed(app);
  const parsed = activity(value, selected);
  assert.ok(parsed.groups.length);
  const group = value.groups.find((item) => item.artifactPreview.some((proof) => proof.artifactId === originalId));
  assert.ok(group);
  assert.ok(activityDetail(await proofs(app, group), selected).proofs.length);
});
for (const [label, id] of sourceIds) {
  test("activity feed preserves an opaque " + label, async (t) => {
    const app = harness(t, id);
    const value = await feed(app);
    const group = value.groups.find((item) => item.artifactPreview.some((proof) => proof.artifactId === id));
    assert.ok(group, "the actual service must retain the exact public artifact identity");
    const before = structuredClone(value);
    const parsed = activity(value, selected);
    assert.ok(parsed.groups.some((item) => item.artifactPreview.some((proof) => proof.artifactId === id)));
    assert.deepEqual(value, before);
  });
  test("activity proof preserves an opaque " + label, async (t) => {
    const app = harness(t, id);
    const value = await feed(app);
    const group = value.groups.find((item) => item.artifactPreview.some((proof) => proof.artifactId === id));
    assert.ok(group);
    const detail = await proofs(app, group);
    assert.ok(detail.proofs.some((proof) => proof.artifact.stableId === id));
    const before = structuredClone(detail);
    const parsed = activityDetail(detail, selected);
    assert.ok(parsed.proofs.some((proof) => proof.artifact.stableId === id));
    assert.deepEqual(detail, before);
  });
}
test("activity preview rejects noncanonical artifact identity without trimming it", async (t) => {
  const value = await feed(harness(t));
  for (const invalid of [null, 42, "", " ", " padded ", "padded\n"]) {
    const input = structuredClone(value);
    input.groups[0].artifactPreview[0].artifactId = invalid;
    const before = structuredClone(input);
    assert.throws(() => activity(input, selected));
    assert.deepEqual(input, before);
  }
  const valid = value.groups[0].artifactPreview[0];
  assert.equal(
    artifactSchema.parse({
      schemaVersion: "leaderboard/v1",
      source: "github",
      visibility: "public",
      kind: valid.kind,
      stableId: valid.artifactId,
      publicUrl: valid.publicUrl,
    }).stableId,
    valid.artifactId,
  );
});
test("opaque artifact admission does not relax actor or group route identifiers", async (t) => {
  const value = await feed(harness(t));
  for (const field of ["actorId", "groupId"]) {
    const input = structuredClone(value);
    input.groups[0][field] = sourceIds[0][1];
    assert.throws(() => activity(input, selected));
  }
});
