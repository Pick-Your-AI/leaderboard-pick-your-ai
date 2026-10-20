import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { coverageSchema } from "@pick-your-ai/contracts";

const source = new URL("../src/remote/Coverage.tsx", import.meta.url);
// Compile the real local TSX dependencies too, so this renderer exercises the
// same policy component that the production coverage view imports.
async function componentModuleUrl(source) {
  const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
    jsx: { runtime: "classic" },
  });
  let compiled = transformed.code;
  for (const [statement, specifier] of transformed.code.matchAll(/from "([^"]+)"/g)) {
    const dependency = specifier.startsWith(".") ? new URL(specifier, source) : new URL(import.meta.resolve(specifier));
    const url = dependency.pathname.endsWith(".tsx") ? await componentModuleUrl(dependency) : dependency.href;
    compiled = compiled.replace(statement, `from ${JSON.stringify(url)}`);
  }
  return `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
}
const { SnapshotCoverage } = await import(await componentModuleUrl(source));
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
  assert.match(html, /<dt>Observed since<\/dt><dd>Unknown\./);
  assert.match(html, /<dt>Imported or pre-organization history<\/dt><dd>Unknown\./);
  assert.doesNotMatch(html, /Reported history baselines/);
  assert.doesNotMatch(html, /0%|100%/);
  assert.match(html, /snapshot=served-snapshot&amp;repository=served-scope/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/Pick-Your-AI\/pick-your-ai-leaderboard\/blob\/main\/docs\/evidence-contributor-rights\.md"/,
  );
  assert.match(
    html,
    /href="https:\/\/github\.com\/Pick-Your-AI\/pick-your-ai-leaderboard\/blob\/main\/docs\/GOVERNANCE\.md"/,
  );
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
  assert.doesNotMatch(empty, /Matching reported dates/);
  const full = render(Array.from({ length: 500 }, (_, index) => record({ scopeId: `scope-${index}` })));
  assert.match(full, /Source records 1–20 of 500/);
  assert.equal((full.match(/role="rowheader"/g) ?? []).length, 20);
  assert.match(full, /Next source records/);
  assert.doesNotMatch(full, /Scope: scope-20</);
});

test("successful collection and known history do not invent observation or import provenance", () => {
  const html = render([
    record({
      state: "complete",
      knownStart: "2020-01-01T00:00:00.123456789Z",
      lastSuccessfulSync: "2026-10-18T07:10:00Z",
      sourceWatermark: "2026-10-18T07:00:00Z",
    }),
  ]);
  assert.match(html, /History known since: <time dateTime="2020-01-01T00:00:00.123456789Z">/);
  assert.match(html, /Last successful sync: <time dateTime="2026-10-18T07:10:00Z">/);
  assert.match(html, /Reconciled through: <time dateTime="2026-10-18T07:00:00Z">/);
  assert.match(html, /<dt>Observed since<\/dt><dd>Unknown\./);
  assert.match(html, /<dt>Imported or pre-organization history<\/dt><dd>Unknown\./);
  assert.match(html, /The known history start below is a separate boundary/);
});

test("equivalent offsets and trailing fractional zeroes retain matching reported boundaries only", () => {
  const input = [
    record({ knownStart: "2026-10-01T00:00:00.125Z" }),
    record({
      scopeId: "other-scope",
      windowStart: "2026-09-30T19:00:00.125000000-05:00",
      windowEnd: "2026-10-18T05:30:00.875000000+05:30",
      knownStart: "2026-10-01T09:00:00.125000000+09:00",
    }),
  ];
  const before = structuredClone(input);
  const html = render(input);
  assert.match(html, /<dt>Reported source windows<\/dt><dd>Matching reported dates\.<\/dd>/);
  assert.match(html, /<dt>Known history baselines<\/dt><dd>Matching reported dates\.<\/dd>/);
  assert.match(html, /Matching dates alone do not establish complete coverage or a valid rank comparison/);
  assert.match(html, /Reported state: unknown/);
  assert.doesNotMatch(html, /Different known dates/);
  assert.match(html, /dateTime="2026-09-30T19:00:00.125000000-05:00"/);
  assert.deepEqual(input, before);
});

for (const [field, value, label] of [
  ["windowStart", "2026-10-01T00:00:00.125000001Z", "Reported source windows"],
  ["windowEnd", "2026-10-18T00:00:00.875000001Z", "Reported source windows"],
  ["knownStart", "2026-10-01T00:00:00.125000001Z", "Known history baselines"],
]) {
  test(`a sub-millisecond difference in ${field} remains a visibly unequal baseline`, () => {
    const base = record({ knownStart: "2026-10-01T00:00:00.125Z" });
    const html = render([base, record({ ...base, scopeId: "other-scope", [field]: value })]);
    assert.match(html, new RegExp(`<dt>${label}</dt><dd>Different known dates\\.</dd>`));
    assert.match(html, new RegExp(`dateTime="${value.replaceAll(".", "\\.")}"`));
  });
}

test("unknown boundaries remain explicit alongside differences between other known records", () => {
  const known = record({ knownStart: "2026-10-01T00:00:00.125Z" });
  const missing = record({ scopeId: "unknown-scope", windowStart: null, windowEnd: null });
  const unknown = render([missing, known]);
  assert.match(unknown, /<dt>Reported source windows<\/dt><dd>Unknown;/);
  assert.match(unknown, /<dt>Known history baselines<\/dt><dd>Unknown;/);
  assert.doesNotMatch(unknown, /Matching reported dates/);
  const different = render([
    missing,
    known,
    record({
      scopeId: "later-scope",
      windowStart: "2026-10-02T00:00:00.125Z",
      knownStart: "2026-10-02T00:00:00.125Z",
    }),
  ]);
  assert.equal((different.match(/Different known dates; some dates remain unknown\./g) ?? []).length, 2);
  assert.match(different, /Reported state: unknown/);
  const partiallyKnownWindow = render([
    known,
    record({ scopeId: "partial-window", windowStart: null, windowEnd: "2026-10-19T00:00:00.875Z" }),
  ]);
  assert.match(
    partiallyKnownWindow,
    /<dt>Reported source windows<\/dt><dd>Different known dates; some dates remain unknown\.<\/dd>/,
  );
});

test("baseline warnings include the entire bounded inventory beyond the visible record page", () => {
  const input = Array.from({ length: 500 }, (_, index) =>
    record({ scopeId: `scope-${index}`, knownStart: "2026-10-01T00:00:00.125Z" }),
  );
  input[499] = record({
    scopeId: "scope-499",
    windowStart: "2026-10-02T00:00:00.125Z",
    knownStart: null,
  });
  const before = structuredClone(input);
  const html = render(input);
  assert.match(html, /Source records 1–20 of 500/);
  assert.match(html, /<dt>Reported source windows<\/dt><dd>Different known dates\.<\/dd>/);
  assert.match(html, /<dt>Known history baselines<\/dt><dd>Unknown;/);
  assert.match(html, /This comparison includes every supplied source record, across all pages/);
  assert.doesNotMatch(html, /Scope: scope-499</);
  assert.deepEqual(input, before);
});
