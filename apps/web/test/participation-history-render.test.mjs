import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createService } from "../../service/dist/app.js";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { participationHistorySource, historyPath } from "../../../tests/fixtures/participation-history.mjs";

const source = new URL("../src/remote/ParticipationHistory.tsx", import.meta.url);
const require = createRequire(source);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : pathToFileURL(require.resolve(specifier));
  return `from ${JSON.stringify(url.href)}`;
});
const { OrganizationHistorySummary } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const render = (history, metrics = metricRegistryV1.metrics) =>
  renderToStaticMarkup(React.createElement(OrganizationHistorySummary, { history, metrics }));
async function fixture(t, path = historyPath) {
  const input = participationHistorySource();
  const app = createService({ source: input.source });
  t.after(() => app.close());
  const response = await app.inject(path);
  assert.equal(response.statusCode, 200, response.body);
  return { ...input, app, history: response.json().history };
}

test("the actual history renderer retains precise first/observed clocks and full organization basis", async (t) => {
  const { history } = await fixture(t),
    before = structuredClone(history),
    html = render(history);
  assert.match(html, /dateTime="2026-02-01T00:00:00.000000001Z"/);
  assert.match(html, /Observed <time dateTime="2026-10-17T00:00:00.000Z"/);
  assert.match(html, /falls outside the selected start-inclusive, end-exclusive period/);
  assert.match(html, /History begins <time dateTime="2026-01-01T00:00:00.000Z"/);
  assert.match(html, /Repository 2; github_rest/);
  assert.match(html, /Repository 3; github_rest/);
  for (const policy of history.basis.policies) {
    assert.ok(html.includes(policy.version));
    assert.ok(html.includes(policy.signature));
    assert.ok(html.includes(policy.roles.join(", ")));
  }
  assert.doesNotMatch(html, /joining date|new employee|first-ever|score|0%|100%/);
  assert.deepEqual(history, before);
});

test("each unavailable history state stays unknown without a false zero or first-proof affordance", async (t) => {
  const { app, state } = await fixture(t);
  state.authorized = false;
  const history = (await app.inject(historyPath)).json().history;
  for (const reason of [
    "reviewed_history_unavailable",
    "history_incomplete",
    "history_evidence_unavailable",
    "qualifying_policy_unavailable",
    "qualifying_actor_unavailable",
    "no_qualifying_evidence",
  ]) {
    const html = render({ ...history, reason });
    assert.match(html, /First qualifying contribution is unknown/);
    assert.match(html, /Missing history does not establish zero activity or newcomer status/);
    assert.doesNotMatch(html, /<time|<a |<button|undefined|falls within|falls outside/);
  }
});

test("all-time and unfinished periods expose their exact qualification while a completed containing period is positive", async (t) => {
  const { app } = await fixture(t);
  const historyAt = async (query) => {
    const response = await app.inject("/api/v1/contributors/101/participation-history" + query);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().history;
  };
  const all = await historyAt("");
  assert.match(render(all), /all-time selection has no completed-period newcomer assessment/);
  const future = await historyAt("?start=2026-01-01T00:00:00.000Z&end=2026-11-01T00:00:00.000Z");
  assert.match(render(future), /observation cutoff precedes the selected period end/);
  const included = await historyAt("?start=2026-01-01T00:00:00.000Z&end=2026-03-01T00:00:00.000Z");
  assert.match(render(included), /falls within the selected start-inclusive, end-exclusive period/);
});

test("supplied category names remain escaped text and the public summary never renders private provider receipts", async (t) => {
  const { history, state } = await fixture(t);
  const metrics = structuredClone(metricRegistryV1.metrics);
  metrics.find((entry) => entry.id === "pr_merged").name = "<script>synthetic label</script>";
  const html = render(history, metrics);
  assert.match(html, /&lt;script&gt;synthetic label&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  for (const privateValue of [
    state.pair.history.admission.decisionId,
    state.pair.history.dataset.sha256,
    state.pair.history.dataset.backfillRevision,
    state.pair.selectedInput.sha256,
  ])
    assert.equal(html.includes(privateValue), false);
});
