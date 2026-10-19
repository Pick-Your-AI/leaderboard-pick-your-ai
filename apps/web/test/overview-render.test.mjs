import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { catalog, selection } from "../src/remote/client.ts";

const source = new URL("../src/remote/Overview.tsx", import.meta.url);
const transformed = await transformWithOxc(await readFile(source, "utf8"), fileURLToPath(source), {
  jsx: { runtime: "classic" },
});
const compiled = transformed.code.replace(/from "([^"]+)"/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, source).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { OverviewNavigation, OverviewAcceptedWork } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const render = (registry, selected = selection("?snapshot=served-pin")) =>
  renderToStaticMarkup(React.createElement(OverviewNavigation, { registry: catalog(registry), selected }));
const fixture = () => structuredClone(metricRegistryV1);
const links = (html) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map((match) => ({
    url: new URL(match[1].replaceAll("&amp;", "&"), "https://example.invalid"),
    text: match[2],
  }));

test("overview follows served labels and ordering while retaining unsupported departments and documentation discovery", () => {
  const registry = fixture();
  registry.ui_metadata.departments.find((entry) => entry.id === "review").label = "Served review department";
  registry.ui_metadata.departments.find((entry) => entry.id === "community").order = 100;
  registry.ui_metadata.departments.reverse();
  const before = structuredClone(registry);
  const html = render(registry);
  const departmentLinks = links(html).filter((link) => link.url.searchParams.has("department"));
  assert.equal(departmentLinks.length, 10);
  assert.deepEqual(
    departmentLinks.map((link) => link.url.searchParams.get("department")),
    ["research", "issues", "triage", "delivery", "review", "craft", "lines", "operations", "breadth", "community"],
  );
  assert.match(html, /Served review department/);
  assert.match(html, /Documentation contributions/);
  assert.equal((html.match(/No overview example is selected for this department\./g) ?? []).length, 3);
  assert.doesNotMatch(html, /<table|class="rank"|synthetic-aster|syn-r42|0 contributions/);
  assert.deepEqual(registry, before);
});

test("every overview destination preserves the actual scope and pin while clearing list-only filters", () => {
  const selected = selection(
    "?organization=Pick-Your-AI&repository=repo-1&workstream=T6&context=current&project=PVT_B%3D,PVT_A" +
      "&role=reviewer,author&actors=user&start=2026-10-01T00:00:00.000Z&end=2026-10-18T00:00:00.000Z" +
      "&snapshot=served-pin&tz=America%2FNew_York&limit=37&search=someone&category=review" +
      "&q=oldquery&department=delivery&cursor=AA.BB",
  );
  const before = structuredClone(selected);
  const destinations = links(render(fixture(), selected));
  for (const { url } of destinations) {
    assert.deepEqual(
      Object.fromEntries(
        [
          "organization",
          "repository",
          "workstream",
          "context",
          "project",
          "role",
          "actors",
          "start",
          "end",
          "snapshot",
          "tz",
          "limit",
        ].map((key) => [key, url.searchParams.get(key)]),
      ),
      {
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
        tz: "America/New_York",
        limit: "37",
      },
    );
    for (const key of ["cursor", "search", "category", "q", "proof"]) assert.equal(url.searchParams.has(key), false);
    if (url.pathname !== "/leaderboards") assert.equal(url.searchParams.has("department"), false);
    if (url.pathname.startsWith("/leaderboards/"))
      assert.equal(url.searchParams.get("metric"), url.pathname.split("/").at(-1));
  }
  assert.deepEqual(selected, before);
  const directory = destinations.find((entry) => entry.text === "All contributors in this scope");
  assert.equal(directory.url.pathname, "/contributors");
});

test("a supplied department with no definitions stays discoverable with unknown activity", () => {
  const registry = fixture();
  registry.ui_metadata.departments.push({ id: "future", label: "Future department", order: 10 });
  const html = render(registry);
  assert.ok(links(html).some((link) => link.url.searchParams.get("department") === "future"));
  assert.match(html, /No metric definitions are supplied for this department\. Activity is unknown\./);
  assert.doesNotMatch(html, /\b0 (?:metric definitions|contributors|contributions)\b/);
});

test("unresolved navigation metadata has an explicit explanation and complete-catalog link without bundled labels", () => {
  const registry = fixture();
  registry.ui_metadata = { decision_state: "unresolved", fields: ["department"], note: "Synthetic legacy fixture" };
  const html = render(registry);
  assert.match(html, /Department navigation is unavailable in this registry\./);
  assert.doesNotMatch(html, /<h3|Research|Code delivery|Documentation contributions/);
  assert.deepEqual(
    links(html).map((link) => link.url.pathname),
    ["/contributors", "/activity", "/leaderboards"],
  );
});

test("served department labels are escaped rather than treated as markup", () => {
  const registry = fixture();
  registry.ui_metadata.departments[0].label = '<img src=x onerror="alert(1)">';
  const html = render(registry);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
});

test("large department inventories have a bounded first page and explicit continuation", () => {
  const registry = fixture();
  for (let i = 0; i < 30; i++)
    registry.ui_metadata.departments.push({ id: `future-${i}`, label: `Future ${i}`, order: 10 + i });
  const html = render(registry);
  assert.equal((html.match(/<h3>/g) ?? []).length, 12);
  assert.match(html, /Departments 1–12 of 40/);
  assert.match(html, /Next departments/);
  assert.doesNotMatch(html, />Future 2<|>Future 29</);
});

const acceptedGroup = (index, activityState = "accepted", latestOccurredAt = "2026-10-18T12:00:00.000Z") => ({
  groupId: String(index).padStart(64, "0"),
  actorId: `served-actor-${index}`,
  actor: { displayName: `Served contributor ${index}` },
  repositoryId: "served-repository",
  activityState,
  latestOccurredAt,
  categoryIds: ["pr_opened", "documentation"],
});
const renderAccepted = (state, selected = selection("?snapshot=served-pin")) =>
  renderToStaticMarkup(React.createElement(OverviewAcceptedWork, { state, selected }));

test("accepted-work preview preserves server order, caps accepted groups at three and leaves action clocks unknown", () => {
  const groups = [
    acceptedGroup(0, "observed"),
    acceptedGroup(1),
    acceptedGroup(2, "pending"),
    acceptedGroup(3),
    acceptedGroup(4, "unknown"),
    acceptedGroup(5, "accepted", null),
    acceptedGroup(6),
  ];
  const before = structuredClone(groups);
  const html = renderAccepted({ status: "ready", value: { groups } });
  assert.deepEqual(
    links(html)
      .filter(({ url }) => url.pathname.startsWith("/contributors/"))
      .map(({ text }) => text),
    ["Served contributor 1", "Served contributor 3", "Served contributor 5"],
  );
  assert.doesNotMatch(html, /Served contributor [0246]/);
  assert.match(html, /Latest source action: Unknown; no action date is inferred/);
  assert.equal((html.match(/<time /g) ?? []).length, 2);
  assert.match(html, /first 20 public activity groups/);
  assert.match(html, /not a complete accepted-work count/);
  assert.match(html, /Categories and work states can overlap; do not add their counts/);
  assert.deepEqual(groups, before);
});

test("accepted-work actor, proof and full-activity links retain the same public scope and pin without list filters", () => {
  const selected = selection(
    "?organization=Pick-Your-AI&repository=served-repository&workstream=T6&context=current&project=PVT_B%3D,PVT_A&role=reviewer,author&actors=user&start=2026-10-01T00:00:00.000Z&end=2026-10-19T00:00:00.000Z&snapshot=served-pin&tz=America%2FNew_York&limit=37&search=someone&category=review&q=old&department=delivery&cursor=AA.BB",
  );
  const html = renderAccepted({ status: "ready", value: { groups: [acceptedGroup(1)] } }, selected);
  const destinations = links(html);
  assert.deepEqual(
    destinations.map(({ url }) => url.pathname),
    ["/activity", "/contributors/served-actor-1", `/activity/${"1".padStart(64, "0")}`],
  );
  for (const { url } of destinations) {
    assert.deepEqual(
      Object.fromEntries(
        [
          "organization",
          "repository",
          "workstream",
          "context",
          "project",
          "role",
          "actors",
          "start",
          "end",
          "snapshot",
          "tz",
          "limit",
        ].map((key) => [key, url.searchParams.get(key)]),
      ),
      {
        organization: "Pick-Your-AI",
        repository: "served-repository",
        workstream: "T6",
        context: "current",
        project: "PVT_A,PVT_B=",
        role: "author,reviewer",
        actors: "user",
        start: "2026-10-01T00:00:00.000Z",
        end: "2026-10-19T00:00:00.000Z",
        snapshot: "served-pin",
        tz: "America/New_York",
        limit: "20",
      },
    );
    for (const key of ["search", "category", "cursor", "q", "department", "proof"])
      assert.equal(url.searchParams.has(key), false);
  }
});

test("empty, checking and unavailable previews preserve uncertainty and the complete-activity entry", () => {
  for (const groups of [[], [acceptedGroup(0, "observed"), acceptedGroup(1, "pending"), acceptedGroup(2, "unknown")]]) {
    const html = renderAccepted({ status: "ready", value: { groups } });
    assert.match(html, /No independently accepted groups appear in this first page/);
    assert.match(html, /does not establish zero accepted work/);
    assert.doesNotMatch(html, /<h3|<time/);
  }
  for (const status of ["loading", "unavailable"]) {
    const html = renderAccepted({ status });
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /<h3|<time|zero accepted work/);
    assert.deepEqual(
      links(html).map(({ url }) => url.pathname),
      ["/activity"],
    );
  }
});

test("accepted-work names and repository identities are rendered as escaped text", () => {
  const group = acceptedGroup(1);
  group.actor.displayName = '<img src=x onerror="alert(1)">';
  group.repositoryId = "<script>not code</script>";
  const html = renderAccepted({ status: "ready", value: { groups: [group] } });
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;not code&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
});
