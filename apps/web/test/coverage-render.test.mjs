import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { coverageSchema } from "@pick-your-ai/contracts";

const source = new URL("../src/remote/Coverage.tsx", import.meta.url);
const require = createRequire(source);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : pathToFileURL(require.resolve(specifier));
  return `from ${JSON.stringify(url.href)}`;
});
const { SnapshotCoverage } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const record = (overrides = {}) =>
  coverageSchema.parse({
    schemaVersion: "leaderboard/v1",
    source: "github_rest",
    state: "unknown",
    scopeId: "served-scope",
    windowStart: "2026-10-01T00:00:00.125Z",
    windowEnd: "2026-10-18T00:00:00.875Z",
    knownStart: null,
    lastSuccessfulSync: null,
    sourceWatermark: null,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
    ...overrides,
  });
const render = (coverage) =>
  renderToStaticMarkup(
    React.createElement(SnapshotCoverage, {
      coverage,
      snapshotId: "served-snapshot",
      expanded: true,
      correctionHref: "/corrections?ui=api&snapshot=served-snapshot&repository=served-scope",
    }),
  );

test("coverage keeps exact served windows, zero known gaps and unknown history distinct", () => {
  const input = [record()];
  const before = structuredClone(input);
  const html = render(input);
  assert.match(html, /Reported state: unknown/);
  assert.match(html, /Window start: <time dateTime="2026-10-01T00:00:00.125Z">2026-10-01T00:00:00.125Z<\/time>/);
  assert.match(html, /Window end \(exclusive\): <time dateTime="2026-10-18T00:00:00.875Z">/);
  for (const label of ["History known since", "Last successful sync", "Reconciled through"]) {
    assert.match(html, new RegExp(`${label}: Unknown`));
  }
  assert.match(html, /Known missing pages: 0/);
  assert.match(html, /Missing permissions: None reported/);
  assert.match(html, /A completeness percentage is unavailable/);
  assert.doesNotMatch(html, /0%|100%/);
  assert.match(html, /snapshot=served-snapshot&amp;repository=served-scope/);
  assert.deepEqual(input, before);
});

test("coverage exposes every supplied gap as escaped text and does not promote partial state", () => {
  const html = render([
    record({
      state: "partial",
      scopeId: null,
      missingPages: 3,
      permissionsMissing: ["Issues:read", "<script>private()</script>"],
      sourceErrors: ["page_missing", "partial_history"],
    }),
  ]);
  assert.match(html, /Scope: Unknown/);
  assert.match(html, /Reported state: partial/);
  assert.match(html, /Known missing pages: 3/);
  assert.match(html, /Issues:read; &lt;script&gt;private\(\)&lt;\/script&gt;/);
  assert.match(html, /page_missing; partial_history/);
  assert.doesNotMatch(html, /<script>/);
});

test("empty coverage stays unknown and large served inventories expose bounded navigation", () => {
  const empty = render([]);
  assert.match(empty, /No source coverage records were supplied for this snapshot. Coverage is unknown/);
  assert.doesNotMatch(empty, /<table/);
  const full = render(Array.from({ length: 500 }, (_, index) => record({ scopeId: `scope-${index}` })));
  assert.match(full, /Source records 1–20 of 500/);
  assert.equal((full.match(/role="rowheader"/g) ?? []).length, 20);
  assert.match(full, /Next source records/);
  assert.doesNotMatch(full, /Scope: scope-20</);
});
