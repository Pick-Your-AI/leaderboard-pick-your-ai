import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { publicPhysicalContextSchema } from "@pick-your-ai/contracts";
import { physicalFiles } from "../../pipeline/test/fixtures/physical-context.mjs";
import { createPhysicalContextHarness } from "../../../tests/fixtures/physical-context.mjs";

const source = new URL("../src/remote/PhysicalContext.tsx", import.meta.url);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { PhysicalContext } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

// The stock normalizer and actual public service produce every available receipt.
// Current privacy and original source-hash binding also have service/pipeline tests.
async function contextFor(metricId = "pr_lines_added", files = physicalFiles, sampleCount = 1) {
  const fixture = createPhysicalContextHarness({ metricId, files, sampleCount });
  try {
    const response = await fixture.app.inject({ method: "GET", url: `/api/v1/boards?metric=${metricId}` });
    assert.equal(response.statusCode, 200, response.body);
    return publicPhysicalContextSchema.parse(response.json().rows[0].physicalContext);
  } finally {
    await fixture.app.close();
  }
}
function render(context, metricId = context?.metricId ?? "pr_lines_added") {
  return renderToStaticMarkup(React.createElement(PhysicalContext, { context, metricId }));
}

for (const metricId of ["pr_lines_added", "pr_lines_removed", "pr_lines_changed", "files_changed"]) {
  test(`${metricId} shows complete classified volume and exact source pins without changing the receipt`, async () => {
    const context = await contextFor(metricId);
    const original = structuredClone(context);
    const html = render(context);
    assert.match(html, /role="group" aria-label="Change-size context"/);
    assert.match(html, /17 added lines; 8 removed lines; \+9 net lines/);
    assert.match(html, /25 changed lines; 3 file changes/);
    assert.match(html, /PR sample count:<\/strong> 1 verified default-branch integration sample/);
    assert.match(html, new RegExp(`${context.unitCount} selected evidence record`));
    assert.match(html, /Raw examined change:<\/strong> 88 added lines; 56 removed lines; 9 file changes/);
    assert.match(html, /Excluded from delivered totals:<\/strong> 6 file changes; 71 added lines; 48 removed lines/);
    assert.match(html, /Formatting-only exclusions:<\/strong> 1 file change; 4 added lines; 4 removed lines/);
    assert.match(html, /complete examined file inventory for these samples/);
    assert.match(html, /Source-history coverage and freshness remain those shown for the board/);
    assert.match(html, /do not measure effort, quality or overall contributor merit/);
    assert.match(html, /<summary>Inspect classification and source pins<\/summary>/);
    for (const label of ["Source", "Tests", "Documentation", "Generated", "Vendor", "Lockfiles", "Binary", "Imported"])
      assert.ok(html.includes(`<dt>${label}</dt>`), label);
    for (const sample of context.samples) {
      for (const url of [sample.sourceUrl, sample.beforeUrl, sample.afterUrl])
        assert.ok(html.includes(`href="${url}"`));
      assert.ok(html.includes(`<time dateTime="${sample.integratedAt}">${sample.integratedAt}</time>`));
      for (const id of sample.evidenceIds) assert.ok(html.includes(id));
    }
    for (const file of physicalFiles) assert.equal(html.includes(file.path), false, file.path);
    assert.doesNotMatch(html, /synthetic-physical-integration|canonicalKey|canonicalIntegrationId/);
    assert.deepEqual(context, original);
  });
}

for (const [reason, message] of [
  ["retained_context_unavailable", /did not retain a complete change-size breakdown/],
  ["selected_units_unbound", /selected evidence records do not have a complete, matching change-size record/],
  ["current_context_unavailable", /unavailable under current publication controls/],
  ["context_budget_exceeded", /complete change-size breakdown exceeds the response limit/],
]) {
  test(`${reason} stays count-free without source pins or a misleading zero`, async () => {
    const available = await contextFor();
    const context = publicPhysicalContextSchema.parse({
      schemaVersion: available.schemaVersion,
      snapshotId: available.snapshotId,
      actorId: available.actorId,
      metricId: available.metricId,
      policyVersion: available.policyVersion,
      policySignature: available.policySignature,
      state: "unknown",
      reason,
    });
    const html = render(context);
    assert.match(html, message);
    assert.match(html, /Missing context does not mean zero change/);
    assert.doesNotMatch(html, /<a |<details|Eligible delivered change:|Raw examined change:|0 added|0 changed/);
  });
}

test("legacy absence stays unknown and an unrelated metric has no physical context display", async () => {
  assert.match(render(undefined), /This snapshot has no retained change-size context/);
  assert.doesNotMatch(render(undefined), /<a |<details|0 added|0 changed/);
  assert.equal(render(undefined, "pr_merged"), "");
  assert.equal(render(await contextFor(), "pr_merged"), "");
});

test("a neighboring metric's context cannot be presented as this row's breakdown", async () => {
  const html = render(await contextFor(), "files_changed");
  assert.match(html, /matching change-size breakdown is unavailable for this metric/);
  assert.doesNotMatch(html, /<a |<details|17 added|88 added|gh:/);
});

test("examined zero remains an available zero and net change retains its descriptive sign", async () => {
  const empty = render(await contextFor("pr_lines_added", []));
  assert.match(empty, /0 added lines; 0 removed lines; 0 net lines/);
  assert.match(empty, /0 changed lines; 0 file changes/);
  assert.doesNotMatch(empty, /unavailable|\+0 net/);
  const reduced = render(
    await contextFor("pr_lines_removed", [{ path: "src/reduced.ts", additions: 2, deletions: 10 }]),
  );
  assert.match(reduced, /2 added lines; 10 removed lines; -8 net lines/);
  assert.match(reduced, /12 changed lines; 1 file change/);
});

test("the same paths across two integrations count as file changes without becoming extra PR samples", async () => {
  const context = await contextFor("files_changed", physicalFiles, 2);
  const html = render(context);
  assert.match(html, /34 added lines; 16 removed lines; \+18 net lines/);
  assert.match(html, /50 changed lines; 6 file changes/);
  assert.match(html, /2 verified default-branch integration samples; 6 selected evidence records/);
  assert.match(html, /File changes count repository\/path\/PR units; the same path can contribute again in another PR/);
  assert.equal(context.samples.length, 2);
});
