import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createService } from "../../service/dist/app.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";
import { activity, activityDetail, evidence, selection } from "../src/remote/client.ts";

// Exercise the actual service projection and shared Activity/Receipt components.
// The provider below supplies fictional publication data, not recognition authority.
async function rendererUrl(source, replacements = new Map()) {
  const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
    jsx: { runtime: "classic" },
  });
  const code = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
    const target =
      replacements.get(specifier) ??
      (specifier.startsWith(".") ? new URL(specifier, source).href : import.meta.resolve(specifier));
    return `from ${JSON.stringify(target)}`;
  });
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const receipt = await rendererUrl(new URL("../src/remote/Evidence.tsx", import.meta.url));
const { ActivityProofs } = await import(
  await rendererUrl(new URL("../src/remote/Activity.tsx", import.meta.url), new Map([["./Evidence.tsx", receipt]]))
);
const sourceAt = "2026-10-16T10:00:00.0001Z";
const acceptedAt = "2026-10-17T10:00:00.0002Z";
const revision = "c".repeat(40);
const noteReasons = [
  "domain_metric:documentation",
  "domain_clock:merged_at",
  "domain_authorship:authored",
  "documentation_path_policy:fictional-notes-v1",
  "documentation_purpose:release_notes",
];
const maintenanceReasons = [
  "maintenance_classification_policy:maintenance-classification/v1",
  "maintenance_kind:dependency_maintenance",
  "maintenance_kind:build_fix",
  "maintenance_kind:accepted_bug_fix",
];
function fixture(metric, reasons, portfolio = true) {
  const input = readFixture();
  const proof = input.selected.evidence[0];
  const actorId = proof.contribution.actorId;
  Object.assign(proof.contribution, {
    metricIds: [metric],
    roles: ["author"],
    reasonCodes: ["independent_recognition_receipt", ...reasons, "PRIVATE_LEGACY_RATIONALE", "reviewer:private-id"],
  });
  Object.assign(proof, {
    occurredAt: sourceAt,
    sourceRevision: revision,
    sourceRevisionUrl: "https://github.com/synthetic-org/synthetic-repo/commit/" + revision,
    evidenceMetadata: {
      schemaVersion: "leaderboard-evidence/v1",
      artifactTitle: null,
      sourceAction: "recognition_accepted",
      sourceOccurredAt: sourceAt,
      observedAt: at,
      activityState: "accepted",
      acceptedAt,
      history: { coverage: "not_supplied", records: [] },
    },
  });
  const row = input.selected.rows.find((entry) => entry.actorId === actorId);
  row.result.metricId = metric;
  row.result.value = 1;
  row.evidenceIds = [proof.contribution.contributionId];
  delete row.pending;
  input.selected.actors = input.selected.actors.filter((entry) => entry.actorId === actorId);
  input.selected.rows = [row];
  input.selected.evidence = [proof];
  if (portfolio)
    input.selected.portfolioEvidence = [{ ...structuredClone(proof), activityState: "accepted", observedAt: at }];
  input.selected.pendingEvidence = [];
  input.selected.diagnostics = [];
  input.selected.ranking = [{ metricId: metric, direction: "descending", rank: false }];
  input.selected.methodology[0].metricId = metric;
  return input;
}
function harness(t, input) {
  const app = createService({ now: () => Date.parse(at), source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  return app;
}
async function readProofs(app, input, metric) {
  const params = new URLSearchParams({ category: metric, snapshot: input.head.snapshotId });
  const selected = selection("?" + params);
  const response = await app.inject("/api/v1/activity?" + params);
  assert.equal(response.statusCode, 200, response.body);
  const feed = activity(response.json(), selected);
  assert.equal(feed.totalGroups, 1);
  assert.equal(feed.groups.length, 1);
  const detailResponse = await app.inject("/api/v1/activity/" + feed.groups[0].groupId + "?" + params);
  assert.equal(detailResponse.statusCode, 200, detailResponse.body);
  const detail = activityDetail(detailResponse.json(), selected);
  const canonicalResponse = await app.inject(
    "/api/v1/evidence/" + input.selected.evidence[0].contribution.contributionId + "?snapshot=" + input.head.snapshotId,
  );
  assert.equal(canonicalResponse.statusCode, 200, canonicalResponse.body);
  const canonical = evidence(canonicalResponse.json(), selected);
  const html = renderToStaticMarkup(React.createElement(ActivityProofs, { value: detail, selected }));
  return { feed, detail, canonical, html, params };
}
function assertConserved(result, input) {
  const proof = result.detail.proofs[0];
  const original = input.selected.evidence[0];
  assert.equal(result.detail.proofs.length, 1);
  assert.equal(result.detail.group.artifactCount, 1);
  assert.equal(result.detail.group.factCount, 1);
  assert.equal(result.detail.group.proofCount, 1);
  for (const key of [
    "contributionId",
    "canonicalEventId",
    "artifactId",
    "actorId",
    "roles",
    "metricIds",
    "qualification",
  ])
    assert.deepEqual(proof.contribution[key], original.contribution[key], key);
  assert.deepEqual(proof.artifact, original.artifact);
  assert.equal(proof.occurredAt, sourceAt);
  assert.equal(proof.observedAt, at);
  assert.equal(proof.sourceRevision, revision);
  assert.equal(proof.sourceRevisionUrl, original.sourceRevisionUrl);
  assert.deepEqual(proof.evidenceMetadata, original.evidenceMetadata);
  assert.equal(proof.activityState, "accepted");
  assert.doesNotMatch(JSON.stringify(result.detail), /PRIVATE_LEGACY_RATIONALE|reviewer:private-id/);
  assert.doesNotMatch(result.html, /PRIVATE_LEGACY_RATIONALE|reviewer:private-id/);
}

test("Activity service and shared Receipt retain the canonical authored-notes purpose", async (t) => {
  const input = fixture("documentation", noteReasons);
  const before = structuredClone(input);
  const result = await readProofs(harness(t, input), input, "documentation");
  assertConserved(result, input);
  assert.ok(result.canonical.contribution.reasonCodes.includes("documentation_purpose:release_notes"));
  assert.deepEqual(result.detail.proofs[0].contribution.reasonCodes, result.canonical.contribution.reasonCodes);
  assert.match(result.html, /Authored release notes/);
  assert.match(result.html, /same documentation contribution/);
  assert.match(result.html, /does not establish release publication or coordination/);
  assert.doesNotMatch(result.html, /Purpose not established|documentation_purpose:/);
  assert.deepEqual(input, before);
});

test("Activity service and shared Receipt retain reviewed maintenance facets without extra units", async (t) => {
  const input = fixture("maintenance", maintenanceReasons);
  const before = structuredClone(input);
  const result = await readProofs(harness(t, input), input, "maintenance");
  assertConserved(result, input);
  assert.ok(result.canonical.contribution.reasonCodes.includes("maintenance_kind:build_fix"));
  assert.deepEqual(result.detail.proofs[0].contribution.reasonCodes, result.canonical.contribution.reasonCodes);
  for (const label of ["Dependency maintenance", "Build fix", "Accepted bug fix", "do not add counted units"])
    assert.ok(result.html.includes(label), label);
  assert.doesNotMatch(result.html, /Not established|maintenance_kind:|maintenance_classification_policy:/);
  assert.deepEqual(input, before);
});

test("Activity preserves unknown classifications and withholds arbitrary legacy reasons", async (t) => {
  for (const metric of ["documentation", "maintenance", "pr_merged"]) {
    // The legacy primary-only path can supply arbitrary provider reasons. Activity
    // must still withhold them rather than copying all canonical reason strings.
    const input = fixture(metric, [], false);
    const before = structuredClone(input);
    const result = await readProofs(harness(t, input), input, metric);
    assertConserved(result, input);
    assert.deepEqual(result.detail.proofs[0].contribution.reasonCodes, ["public_accepted_work"]);
    if (metric === "documentation") assert.match(result.html, /Purpose not established; omission remains unknown/);
    if (metric === "maintenance") assert.match(result.html, /Not established; omitted kinds remain unknown/);
    if (metric === "pr_merged")
      assert.ok(result.canonical.contribution.reasonCodes.includes("PRIVATE_LEGACY_RATIONALE"));
    assert.deepEqual(input, before);
  }
});

test("current artifact suppression withdraws previously visible Activity explanations from a pinned selection", async (t) => {
  const input = fixture("documentation", noteReasons);
  const app = harness(t, input);
  const result = await readProofs(app, input, "documentation");
  const original = input.selected.evidence[0];
  input.controls.suppressedArtifactIds.push(original.artifact.stableId);
  const response = await app.inject("/api/v1/activity?" + result.params);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().groups, []);
  assert.equal(response.json().totalGroups, 0);
  for (const path of ["activity/" + result.detail.group.groupId, "evidence/" + original.contribution.contributionId]) {
    const hidden = await app.inject("/api/v1/" + path + "?snapshot=" + input.head.snapshotId);
    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(hidden.headers["cache-control"], "no-store");
    assert.doesNotMatch(hidden.body, /release_notes|Authored release notes|PRIVATE_LEGACY_RATIONALE/);
  }
});
