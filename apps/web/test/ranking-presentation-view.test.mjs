import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { createRankingPresentationHarness } from "../../../tests/fixtures/ranking-presentation.mjs";
import { board, selection } from "../src/remote/client.ts";

const source = new URL("../src/remote/RankingPresentation.tsx", import.meta.url);
const require = createRequire(source);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : pathToFileURL(require.resolve(specifier));
  return `from ${JSON.stringify(url.href)}`;
});
const { RankingPresentation } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

for (const scenario of [
  {
    name: "ranked partial-source cohort",
    options: {},
    label: /This cohort qualifies for displayed ranks/,
    count: /5 comparable contributors and 1 unrankable contributors among 6/,
  },
  {
    name: "small measured cohort",
    options: { values: [4, 0, undefined] },
    label: /Small cohort: values and evidence remain visible without ranks or rank movement/,
    count: /2 comparable contributors and 1 unrankable contributors among 3/,
  },
  {
    name: "legacy unknown policy",
    options: { policy: false, values: [4] },
    label: /no recorded cohort display policy/,
    count: /legacy ranks do not establish the current five-contributor convention/,
  },
]) {
  test(`the renderer discloses ${scenario.name} from the actual validated service receipt`, async (t) => {
    const h = createRankingPresentationHarness(scenario.options);
    t.after(() => h.app.close());
    const response = await h.app.inject("/api/v1/boards?metric=pr_merged&limit=1");
    assert.equal(response.statusCode, 200, response.body);
    const value = board(response.json(), selection("?metric=pr_merged&limit=1"));
    const original = structuredClone(value);
    const html = renderToStaticMarkup(React.createElement(RankingPresentation, { board: value }));
    assert.match(html, scenario.label);
    assert.match(html, scenario.count);
    assert.match(html, /aria-label="Ranking presentation policy"/);
    if (scenario.options.policy !== false) {
      assert.match(html, /counted before pagination/);
      assert.match(html, /including zero and partial results/);
      assert.match(html, /Missing values do not become zero/);
      assert.match(html, /not a privacy or statistical assurance/);
    } else assert.doesNotMatch(html, /0 comparable|0 unrankable|requires at least/);
    assert.deepEqual(value, original);
  });
}
