import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { catalog, parameters, selection, uiHref } from "../src/remote/client.ts";
import {
  discoverMetrics,
  registryMetric,
  validateCatalogRoute,
  verifyBoardDefinition,
} from "../src/remote/registry.ts";

const servedRegistry = () => {
  const registry = structuredClone(metricRegistryV1);
  if (registry.ui_metadata.decision_state !== "candidate") throw new Error("Expected current metadata fixture");
  registry.ui_metadata.metrics.find((entry) => entry.metric_id === "pr_merged")!.synonyms = ["serverexclusivealias"];
  registry.ui_metadata.departments.find((entry) => entry.id === "delivery")!.label = "Served delivery label";
  return registry;
};

test("API catalog discovery uses the fetched registry including its aliases and department labels", () => {
  const registry = catalog(servedRegistry());
  assert.equal(discoverMetrics(registry, {}).length, 98);
  assert.deepEqual(
    discoverMetrics(registry, { catalogQuery: "serverexclusivealias" }).map((metric) => metric.id),
    ["pr_merged"],
  );
  assert.ok(
    discoverMetrics(registry, { catalogQuery: "Served delivery label" }).some((metric) => metric.id === "pr_merged"),
  );
  assert.equal(discoverMetrics(registry, { catalogQuery: "serverexclusivealias", department: "research" }).length, 0);
  assert.throws(() => discoverMetrics(registry, { department: "missing" }), /unknown_registry_department/);
  assert.equal(registryMetric(registry, "retained_lines").definition.release_eligibility, "deferred advanced");
  assert.throws(() => registryMetric(registry, "not_a_metric"), /unknown_metric_definition/);
});

test("catalog filters are bounded local navigation state and never become source filters", () => {
  const selected = selection("?ui=api&q=merged%20pull%20requests&department=delivery&snapshot=pin-1&repository=repo-1");
  assert.equal(selected.catalogQuery, "merged pull requests");
  assert.equal(selected.department, "delivery");
  const api = parameters(selected, { board: true });
  assert.equal(api.has("q"), false);
  assert.equal(api.has("department"), false);
  assert.equal(api.get("snapshot"), "pin-1");
  const catalogLink = new URL(uiHref("/leaderboards", selected), "https://example.invalid");
  assert.equal(catalogLink.searchParams.get("q"), selected.catalogQuery);
  assert.equal(catalogLink.searchParams.get("department"), "delivery");
  for (const path of ["/methodology/pr_merged", "/leaderboards/pr_merged", "/contributors", "/activity"]) {
    const link = new URL(uiHref(path, selected, { metric: "pr_merged" }), "https://example.invalid");
    assert.equal(link.searchParams.has("q"), false);
    assert.equal(link.searchParams.has("department"), false);
    assert.equal(link.searchParams.get("snapshot"), "pin-1");
  }
  for (const path of ["/leaderboards", "/methodology", "/methodology/changes"])
    assert.doesNotThrow(() => validateCatalogRoute(path, "?q=&department=delivery"));
  for (const path of ["/leaderboards/pr_merged", "/methodology/pr_merged", "/activity"])
    for (const query of ["?q=", "?q=merged", "?department=delivery", "?department="])
      assert.throws(() => validateCatalogRoute(path, query), /unsupported_catalog_filter_for_route/);
  for (const query of [
    "?q=" + "a".repeat(121),
    "?q=%0A",
    "?q=a&q=b",
    "?department=",
    "?department=delivery&department=research",
    "?state=qualified&date_basis=acceptedAt",
    "?state=&date_basis=",
  ])
    assert.throws(() => selection(query));
});

test("malformed API metadata and mismatched board definitions fail closed without a bundled fallback", () => {
  const raw = servedRegistry();
  if (raw.ui_metadata.decision_state !== "candidate") throw new Error("Expected metadata fixture");
  raw.ui_metadata.metrics.pop();
  assert.throws(() => catalog(raw), /invalid_metric_registry/);
  const registry = catalog(servedRegistry());
  const metric = registryMetric(registry, "pr_merged");
  verifyBoardDefinition(registry, structuredClone(metric));
  assert.throws(
    () => verifyBoardDefinition(registry, { ...metric, counting_rule: "A substituted meaning" }),
    /api_metric_definition_mismatch/,
  );
  const legacy = structuredClone(registry);
  legacy.ui_metadata = { decision_state: "unresolved", fields: ["department"], note: "Legacy synthetic fixture" };
  assert.equal(discoverMetrics(catalog(legacy), { catalogQuery: "serverexclusivealias" }).length, 0);
  assert.throws(() => discoverMetrics(catalog(legacy), { department: "delivery" }), /unknown_registry_department/);
});

test("API methods and discovery render supplied metadata without prototype records", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite");
  const server = await createServer({
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, ws: false },
    appType: "custom",
  });
  try {
    const { RegistryMetadata, RegistryCatalog } = await server.ssrLoadModule("/apps/web/src/remote/Registry.tsx");
    const registry = catalog(servedRegistry());
    const metadata = renderToStaticMarkup(
      React.createElement(RegistryMetadata, { registry, metric: registryMetric(registry, "pr_merged") }),
    );
    assert.match(metadata, /Served delivery label/);
    assert.match(metadata, /serverexclusivealias/);
    assert.match(metadata, /qualified \/ acceptedAt/);
    assert.match(metadata, /does not accept state\/date-basis filters/);
    const unavailable = renderToStaticMarkup(
      React.createElement(RegistryMetadata, { registry, metric: registryMetric(registry, "retained_lines") }),
    );
    assert.match(unavailable, /Deferred/);
    assert.match(unavailable, /not a measured zero/);
    for (const metricId of ["label_taxonomy", "milestone_definitions"]) {
      const definition = renderToStaticMarkup(
        React.createElement(RegistryMetadata, { registry, metric: registryMetric(registry, metricId) }),
      );
      assert.match(definition, /triage-definition-day\/v1/);
      assert.match(definition, /UTC calendar day/);
      assert.match(definition, /source or acceptance/);
      assert.match(definition, /No selectable candidate view registered/);
      assert.doesNotMatch(definition, /Raw triage grouping/);
    }
    const rawTriage = renderToStaticMarkup(
      React.createElement(RegistryMetadata, { registry, metric: registryMetric(registry, "items_triaged") }),
    );
    assert.match(rawTriage, /<dt>Raw triage grouping<\/dt>/);
    assert.match(rawTriage, /3600-second UTC buckets/);
    for (const [metricId, label, version] of [
      ["project_field_updates", "Project item-day grouping", "project-field-day/v1"],
      ["public_moderation", "Public stewardship item-day grouping", "public-stewardship-day/v1"],
    ]) {
      const html = renderToStaticMarkup(
        React.createElement(RegistryMetadata, { registry, metric: registryMetric(registry, metricId) }),
      );
      const detail = html.match(new RegExp("<dt>" + label + "</dt><dd>([\\s\\S]*?)</dd>"))?.[1];
      assert.ok(detail, metricId);
      const normalized = detail.replace(/\s+/g, " ");
      assert.ok(normalized.includes(version));
      assert.match(normalized, /per UTC calendar day within its repository/);
      assert.match(html, /No selectable candidate view registered/);
      assert.doesNotMatch(normalized, /stable definition|definition kind/);
      if (metricId === "project_field_updates") {
        assert.match(normalized, /one observed actor and stable Project item/);
        assert.match(normalized, /Different field facets, repeated changes and reversals share one item day/);
        assert.match(normalized, /Only the proven source event time chooses the day/);
        assert.match(normalized, /collection or acceptance time cannot replace it/);
        assert.doesNotMatch(normalized, /Independently qualified|source or acceptance day/);
      } else {
        assert.match(normalized, /one actor and stable item/);
        assert.match(normalized, /Pin, unpin, lock and unlock facets and repeated toggles share one daily unit/);
        assert.match(normalized, /Independently qualified same-metric receipts/);
        assert.match(normalized, /separate source or acceptance day lenses/);
        assert.match(normalized, /acceptance never supplies a missing raw event time/);
        assert.match(normalized, /Totals remain descriptive and are never ranked/);
      }
    }
    const catalogPage = renderToStaticMarkup(
      React.createElement(RegistryCatalog, {
        registry,
        selected: selection("?q=serverexclusivealias"),
        path: "/leaderboards",
        navigate: () => {},
      }),
    );
    assert.match(catalogPage, /1 of 98 defined measures/);
    assert.match(catalogPage, /methodology\/pr_merged/);
    assert.doesNotMatch(catalogPage, /synthetic-aster|syn-r42/);
  } finally {
    await server.close();
  }
});
