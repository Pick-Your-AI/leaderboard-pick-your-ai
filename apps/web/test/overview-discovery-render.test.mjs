import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { selection } from "../src/remote/client.ts";
import { spotlights } from "../src/remote/recognition-client.ts";

const source = new URL("../src/remote/OverviewDiscovery.tsx", import.meta.url);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { FirstContributionsEntry, EditorialRotation } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const item = (id, category = "Research") => ({
  id,
  actorId: `actor-${id}`,
  claimId: `claim-${id}`,
  category,
  sourceUrl: `https://github.com/synthetic-discovery/example/issues/1`,
  selectionExplanation: `Reviewed explanation ${id}`,
  selectedAt: "2026-10-18T12:00:00.000Z",
  bio: null,
  ruleVersion: "reviewed-opt-in/v1",
});
const approved = (items) =>
  spotlights({
    ruleVersion: "reviewed-opt-in/v1",
    ordering: "round-robin-category-oldest-selection-first",
    spotlights: items,
  });

test("first-contributions entry preserves the complete displayed scope and pin without implying a cohort filter", () => {
  const selected = selection(
    "?organization=Pick-Your-AI&repository=repo-1&workstream=T6&context=current&project=PVT_B%3D,PVT_A&role=reviewer,author&actors=user&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z&snapshot=served-pin&tz=America%2FNew_York&metric=prs_reviewed&limit=37&search=old&category=review&q=old&department=review&cursor=AA.BB",
  );
  const before = structuredClone(selected);
  const html = render(FirstContributionsEntry, { selected });
  const href = new URL(html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&"), "https://example.invalid");
  assert.equal(href.pathname, "/contributors");
  assert.deepEqual(Object.fromEntries(href.searchParams), {
    organization: "Pick-Your-AI",
    repository: "repo-1",
    workstream: "T6",
    context: "current",
    project: "PVT_A,PVT_B=",
    role: "author,reviewer",
    actors: "user",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-18T00:00:00.000Z",
    snapshot: "served-pin",
    metric: "prs_reviewed",
    limit: "37",
    tz: "America/New_York",
    ui: "api",
  });
  assert.match(html, /unranked contributor directory/);
  assert.match(html, /does not certify a newcomer cohort/);
  assert.match(html, /Missing history does not establish zero activity or newcomer status/);
  assert.doesNotMatch(html, /<time|<table|<h3/);
  assert.deepEqual(selected, before);
});

test("spotlight presentation begins with the supplied first item and retains its complete transparent proof", () => {
  const items = approved([item("z", "Review"), item("a", "Community")]);
  const before = structuredClone(items);
  const html = render(EditorialRotation, { items });
  assert.match(html, /Spotlight 1 of 2/);
  assert.match(html, />Review<\/h3>/);
  assert.match(html, /Reviewed explanation z/);
  assert.match(html, /dateTime="2026-10-18T12:00:00.000Z"/);
  assert.match(html, /href="https:\/\/github.com\/synthetic-discovery\/example\/issues\/1"/);
  assert.match(html, /Previous spotlight/);
  assert.match(html, /Next spotlight/);
  assert.doesNotMatch(html, /Reviewed explanation a|>Community<|disabled=""/);
  assert.deepEqual(items, before);
});

test("single and empty approved collections have no misleading navigation or invented selection", () => {
  const html = render(EditorialRotation, { items: approved([item("only")]) });
  assert.match(html, /Spotlight 1 of 1/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.equal(render(EditorialRotation, { items: [] }), "");
});

test("maximum valid inventory renders one escaped current item without sorting or retaining other contributor text", () => {
  const items = approved(Array.from({ length: 10_000 }, (_, i) => item(String(i))));
  items[0].category = '<img src=x onerror="alert(1)">';
  items[0].bio = "<script>synthetic text</script>";
  const html = render(EditorialRotation, { items });
  assert.equal((html.match(/<article\b/g) ?? []).length, 1);
  assert.equal((html.match(/Reviewed public evidence/g) ?? []).length, 1);
  assert.match(html, /Spotlight 1 of 10000/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;synthetic text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|Reviewed explanation 9999/);
  assert.ok(html.length < 3000);
});
