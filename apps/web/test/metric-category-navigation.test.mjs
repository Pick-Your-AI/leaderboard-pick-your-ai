import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithOxc } from "vite";
import { getRegistryDepartments, metricRegistryV1 } from "@pick-your-ai/metrics";
import { catalog, parameters, selection } from "../src/remote/client.ts";

const source = new URL("../src/remote/MetricCategoryNavigation.tsx", import.meta.url);
const require = createRequire(source);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source) : pathToFileURL(require.resolve(specifier));
  return `from ${JSON.stringify(url.href)}`;
});
const { MetricCategoryNavigation } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const render = (departments, selected = selection("?ui=api"), path = "/leaderboards") =>
  renderToStaticMarkup(React.createElement(MetricCategoryNavigation, { departments, selected, path }));
const links = (html) =>
  [...html.matchAll(/<a\b([^>]+)>(.*?)<\/a>/g)].map((match) => ({
    attributes: match[1],
    href: new URL(match[1].match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&"), "https://frontend.invalid"),
    label: match[2],
  }));

test("category navigation uses the validated served identities, order and escaped labels without modifying the registry", () => {
  const raw = structuredClone(metricRegistryV1);
  raw.ui_metadata.departments.find((entry) => entry.id === "delivery").label = "Served <delivery> & routes";
  const registry = catalog(raw);
  const before = structuredClone(registry);
  const departments = getRegistryDepartments(registry);
  const html = render(departments, selection("?ui=api&department=delivery"));
  const entries = links(html);
  assert.deepEqual(
    entries.map((entry) => entry.href.searchParams.get("department")),
    [null, ...departments.map((entry) => entry.id)],
  );
  assert.equal(entries.filter((entry) => entry.attributes.includes('aria-current="page"')).length, 1);
  assert.equal(
    entries.find((entry) => entry.attributes.includes('aria-current="page"')).href.searchParams.get("department"),
    "delivery",
  );
  assert.match(html, /Served &lt;delivery&gt; &amp; routes/);
  assert.doesNotMatch(html, /<delivery>|role="tab"|role="tabpanel"/);
  assert.deepEqual(registry, before);
});

test("category URLs preserve the complete selected scope and search while retiring page, proof and comparison state", () => {
  const selected = selection(
    "?ui=api&organization=Pick-Your-AI&repository=repo-1&workstream=docs&context=event&project=PVT_native&role=author&actors=user&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z&snapshot=immutable-pin&limit=25&cursor=old.signature&proof=old-proof&compare=old-comparison&q=serverexclusivealias&department=delivery&tz=Asia%2FKathmandu",
    { comparison: true },
  );
  const before = structuredClone(selected);
  for (const path of ["/leaderboards", "/methodology", "/methodology/changes"]) {
    const entries = links(render(getRegistryDepartments(metricRegistryV1), selected, path));
    for (const { href } of entries) {
      assert.equal(href.pathname, path);
      const restored = selection(href.search);
      for (const key of [
        "organization",
        "repository",
        "workstream",
        "context",
        "projects",
        "roles",
        "actors",
        "start",
        "end",
        "snapshot",
        "limit",
        "catalogQuery",
        "timeZone",
      ])
        assert.deepEqual(restored[key], selected[key], key);
      for (const key of ["cursor", "proof", "compare", "compareStart", "compareEnd"])
        assert.equal(href.searchParams.has(key), false, key);
      const request = parameters(restored, { board: true });
      for (const key of ["department", "q", "tz"]) assert.equal(request.has(key), false, key);
    }
    assert.equal(entries[0].href.searchParams.has("department"), false);
  }
  assert.deepEqual(selected, before);
});

test("large inventories expose a bounded definition page containing the copied selected category", () => {
  const departments = Array.from({ length: 101 }, (_, index) => ({
    id: `category-${index}`,
    label: `Served category ${index}`,
    order: index,
  }));
  const first = render(departments);
  assert.equal(links(first).length, 13);
  assert.equal(links(first)[0].attributes.includes('aria-current="page"'), true);
  assert.match(first, /Category page 1 of 9/);
  assert.doesNotMatch(first, /Previous categories/);
  assert.match(first, /Next categories/);
  const last = render(departments, selection("?ui=api&department=category-100"));
  assert.deepEqual(
    links(last).map((entry) => entry.href.searchParams.get("department")),
    [null, "category-96", "category-97", "category-98", "category-99", "category-100"],
  );
  assert.match(last, /Category page 9 of 9/);
  assert.match(last, /Previous categories/);
  assert.doesNotMatch(last, /Next categories/);
  assert.equal(links(last).at(-1).attributes.includes('aria-current="page"'), true);
  assert.match(last, /definitions, not contributor ranks/);
});

test("unresolved metadata supplies no category links or implied empty measured cohort", () => {
  const raw = structuredClone(metricRegistryV1);
  raw.ui_metadata = { decision_state: "unresolved", fields: ["department"], note: "Synthetic unresolved metadata" };
  const registry = catalog(raw);
  const html = render(getRegistryDepartments(registry));
  assert.match(html, /Category navigation is unavailable in this registry/);
  assert.match(html, /complete metric catalog remains below/);
  assert.doesNotMatch(html, /<nav|<a |<button|measured zero|0 contributors/);
});
