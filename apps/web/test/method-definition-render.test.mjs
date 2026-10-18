import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = new URL("../src/remote/MethodDefinition.tsx", import.meta.url);
const require = createRequire(source);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : pathToFileURL(require.resolve(specifier));
  return `from ${JSON.stringify(url.href)}`;
});
const { MethodDefinition } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const registry = JSON.parse(
  await readFile(new URL("../../../packages/metrics/src/v1/registry.json", import.meta.url), "utf8"),
);
const metric = (id) => structuredClone(registry.metrics.find((entry) => entry.id === id));
const render = (value) => renderToStaticMarkup(React.createElement(MethodDefinition, { metric: value }));

test("actual method renderer retains denominator guards, censoring and source acceptance examples", () => {
  assert.match(render(metric("pr_accepted_rate")), /No decided PRs =&gt; unavailable, not 0%/);
  const waiting = render(metric("review_wait"));
  assert.match(waiting, /n=0 =&gt; unavailable; never 0 hours/);
  assert.match(waiting, /unresolved right-censored PR count and missing-readiness-evidence count separately/);
  const taxonomy = render(metric("label_taxonomy"));
  assert.match(taxonomy, /<li>name\/description\/color edit<\/li>/);
  assert.match(taxonomy, /An event plus its confirming receipt is one underlying unit/);
  assert.match(taxonomy, /No implied|no implied Administration or Members expansion/);
  assert.match(taxonomy, /A label rename retains the same label identity/);
  assert.match(taxonomy, /No subjective quality inference from measured activity/);
  for (const entry of registry.metrics) {
    assert.doesNotMatch(render(entry), /exceeds the display limit|Unsupported definition value/);
  }
});

test("served extension values remain distinct and text cannot become active markup", () => {
  const served = metric("pr_accepted_rate");
  served.definition.denominator.zero_behavior = "Served-only denominator guard";
  served.definition.observation_limits = {
    stated_zero: 0,
    approved: false,
    threshold: null,
    examples: ["<script>private()</script>", { known: true }],
  };
  const before = structuredClone(served);
  const html = render(served);
  assert.match(html, /Served-only denominator guard/);
  assert.doesNotMatch(html, /No decided PRs|<script>/);
  assert.match(html, /<dt>Stated zero<\/dt><dd>0<\/dd>/);
  assert.match(html, /<dt>Approved<\/dt><dd>No<\/dd>/);
  assert.match(html, /<dt>Threshold<\/dt><dd>Not supplied<\/dd>/);
  assert.match(html, /&lt;script&gt;private\(\)&lt;\/script&gt;/);
  assert.deepEqual(served, before);
});

test("deep or excessive supplied detail stops with a visible incomplete-display explanation", () => {
  for (const extra of [
    Array.from({ length: 1_000 }, (_, index) => `entry ${index}`),
    Array.from({ length: 20 }).reduce((value) => ({ nested: value }), "too deep"),
  ]) {
    const served = metric("pr_accepted_rate");
    served.definition.additional_limits = extra;
    const html = render(served);
    assert.match(html, /Additional detail exceeds the display limit; this is not a complete definition display/);
    assert.doesNotMatch(html, /entry 999|too deep/);
  }
});
