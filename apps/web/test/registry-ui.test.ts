import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { metricRegistryV1, getLeadMetrics, getMetricUi, selectMetricView } from "@pick-your-ai/metrics";
import { families, metrics, searchMetrics } from "../src/data/registry.ts";
import { buildSelectedBoard, resolveWallBoards, wallMetricIds } from "../src/data/metric-selection.ts";
import { fixtureMetrics } from "../src/data/synthetic.ts";
import { defaultScope, parseScope, routeParams, serializeScope, type Scope } from "../src/lib/scope.ts";

const latest = "syn-r42";

test("discovery and wall choices are derived from the same registry version", () => {
  assert.equal(metrics.length, 98);
  assert.deepEqual(
    families,
    metricRegistryV1.ui_metadata.decision_state === "candidate" ? metricRegistryV1.ui_metadata.departments : [],
  );
  assert.ok(searchMetrics("merged pull requests").some((metric) => metric.id === "pr_merged"));
  assert.ok(searchMetrics("docs").some((metric) => metric.id === "documentation"));
  assert.deepEqual(
    wallMetricIds(),
    getLeadMetrics("wall")
      .filter((metric) => fixtureMetrics[metric.id])
      .map((metric) => metric.id),
  );
  assert.ok(!wallMetricIds().includes("retained_lines"));
});

test("every fixture uses the registry's exact state/date pair and unsupported requests fail closed", () => {
  for (const metricId of Object.keys(fixtureMetrics)) {
    const ui = getMetricUi(metricId)!;
    const selected = ui.default_combination!;
    const board = buildSelectedBoard(metricId, defaultScope, latest, selected)!;
    assert.ok(board.fixture);
    assert.deepEqual(board.fixture.rankStates, [selected.state]);
    for (const state of ["observed", "qualified", "reviewed", "pending", "", "invented"]) {
      for (const date_basis of ["occurredAt", "acceptedAt", "observedAt", "", "invented"]) {
        if (state === selected.state && date_basis === selected.date_basis) continue;
        assert.throws(
          () => buildSelectedBoard(metricId, defaultScope, latest, { state, date_basis }),
          /Unsupported metric view/,
        );
      }
    }
  }
});

test("unrelated scope changes preserve explicit empty or invalid metric selections", () => {
  const patches: Partial<Scope>[] = [
    { period: "7d" },
    { repos: ["syn-repo-research"] },
    { projects: ["syn-proj-web"] },
    { actor: "all" },
    { snapshot: "syn-r41" },
    { density: "compact" },
  ];
  for (const query of [
    "?state=&date_basis=acceptedAt",
    "?state=qualified&date_basis=",
    "?state=&date_basis=",
    "?state=observed&date_basis=acceptedAt",
    "?state=qualified&date_basis=observedAt",
  ]) {
    const original = routeParams(query);
    const scope = parseScope(query).scope;
    assert.throws(() => buildSelectedBoard("pr_merged", scope, latest, original), /Unsupported metric view/);
    for (const patch of patches) {
      const changed = serializeScope({ ...scope, ...patch }, original);
      assert.deepEqual(routeParams(changed), original);
      assert.throws(
        () => buildSelectedBoard("pr_merged", parseScope(changed).scope, latest, routeParams(changed)),
        /Unsupported metric view/,
      );
    }
    const corrected = serializeScope(scope, { ...original, state: "qualified", date_basis: "acceptedAt" });
    assert.equal(buildSelectedBoard("pr_merged", scope, latest, routeParams(corrected))!.status, "measured");
  }
  const emptyWall = serializeScope({ ...defaultScope, period: "7d" }, routeParams("?mode=single&boards="));
  assert.equal(routeParams(emptyWall).boards, "");
  assert.throws(() => resolveWallBoards(routeParams(emptyWall).boards), /Unsupported wall selection/);
});

test("unimplemented definitions stay not measured and cannot borrow another view", () => {
  for (const metric of metrics.filter((metric) => !fixtureMetrics[metric.id])) {
    const board = buildSelectedBoard(metric.id, defaultScope, latest)!;
    assert.equal(board.status, "not_measured");
    assert.deepEqual(board.rows, []);
    assert.throws(
      () => buildSelectedBoard(metric.id, defaultScope, latest, { state: "observed", date_basis: "occurredAt" }),
      /Unsupported metric view/,
    );
  }
});

test("domain candidate metadata preserves the documentation prototype and cannot invent other data adapters", () => {
  const domainMetrics = metrics.filter((metric) =>
    getMetricUi(metric.id)!.verification_cases.includes("apps/pipeline/test/domain-recognition.test.mjs"),
  );
  assert.equal(domainMetrics.length, 24);
  for (const metric of domainMetrics) {
    const ui = getMetricUi(metric.id)!;
    assert.equal(ui.maturity, metric.id === "incidents" ? "definition_only" : "synthetic_verified");
    if (metric.id === "incidents") {
      assert.deepEqual(ui.supported_combinations, []);
      assert.equal(ui.default_combination, null);
      assert.throws(() => selectMetricView(metric.id), /No supported selectable view/);
    }
    for (const pair of ui.supported_combinations) {
      assert.deepEqual(selectMetricView(metric.id, pair), pair);
      if (metric.id === "documentation" && pair.date_basis === "acceptedAt") {
        assert.equal(buildSelectedBoard(metric.id, defaultScope, latest, pair)!.status, "measured");
      } else {
        assert.throws(() => buildSelectedBoard(metric.id, defaultScope, latest, pair), /Unsupported metric view/);
      }
    }
    if (metric.id !== "documentation") {
      assert.equal(buildSelectedBoard(metric.id, defaultScope, latest)!.status, "not_measured");
      assert.deepEqual(ui.lead_view, { overview: false, wall: false, order: null });
    }
  }
  const documentation = getMetricUi("documentation")!;
  assert.deepEqual(documentation.default_combination, { state: "qualified", date_basis: "acceptedAt" });
  assert.deepEqual(documentation.lead_view, { overview: true, wall: true, order: 5 });
  assert.equal(buildSelectedBoard("documentation", defaultScope, latest)!.status, "measured");
});

test("an invalid explicit wall selection never falls back or drops an unsupported board", () => {
  assert.deepEqual(resolveWallBoards(undefined), wallMetricIds().slice(0, 1));
  assert.deepEqual(resolveWallBoards("pr_merged,pr_merged"), ["pr_merged"]);
  for (const request of ["", "missing", "pr_merged,retained_lines", "pr_merged,", "items_triaged"])
    assert.throws(() => resolveWallBoards(request), /Unsupported wall selection/);
});

test("rendered methods, paired filters and invalid wall errors consume registry metadata", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createServer } = await import("vite");
  const server = await createServer({
    root: fileURLToPath(new URL("../../..", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, ws: false },
    appType: "custom",
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/leaderboards/pr_merged", search: "?state=observed&date_basis=acceptedAt" } },
  });
  try {
    const { RouterProvider } = await server.ssrLoadModule("/apps/web/src/lib/router.tsx");
    const { MethodSheetPage } = await server.ssrLoadModule("/apps/web/src/routes/Reference.tsx");
    const { BoardPage } = await server.ssrLoadModule("/apps/web/src/routes/Board.tsx");
    const { ScopeBar } = await server.ssrLoadModule("/apps/web/src/components/ScopeBar.tsx");
    const render = (element: React.ReactNode) =>
      renderToStaticMarkup(React.createElement(RouterProvider, null, element));
    for (const metric of metrics) {
      const html = render(React.createElement(MethodSheetPage, { metricId: metric.id }));
      assert.match(html, /leaderboard-ui\/v1/);
      assert.ok(html.includes(getMetricUi(metric.id)!.maturity));
      if (metric.id === "items_triaged") assert.match(html, /triage-raw-state\/v1/);
      if (["label_taxonomy", "milestone_definitions"].includes(metric.id)) {
        assert.match(html, /triage-definition-day\/v1/);
        assert.match(html, /UTC calendar day/);
        assert.match(html, /source or acceptance/);
        assert.match(html, /No selectable view; not measured/);
        assert.doesNotMatch(html, /Raw triage grouping policy/);
      }
      if (["project_field_updates", "public_moderation"].includes(metric.id)) {
        const label =
          metric.id === "project_field_updates" ? "Project item-day grouping" : "Public stewardship item-day grouping";
        const detail = html.match(new RegExp("<dt>" + label + " policy</dt><dd>([\\s\\S]*?)</dd>"))?.[1];
        assert.ok(detail, metric.id);
        const normalized = detail.replace(/\s+/g, " ");
        assert.match(normalized, /per UTC calendar day within its repository/);
        assert.match(html, /No selectable view; not measured/);
        assert.doesNotMatch(normalized, /stable definition|definition kind/);
        if (metric.id === "project_field_updates") {
          assert.match(normalized, /project-field-day\/v1/);
          assert.match(normalized, /one observed actor and stable Project item/);
          assert.match(normalized, /Different field facets, repeated changes and reversals share one item day/);
          assert.match(normalized, /Only the proven source event time chooses the day/);
          assert.match(normalized, /collection or acceptance time cannot replace it/);
          assert.doesNotMatch(normalized, /Independently qualified|source or acceptance day/);
        } else {
          assert.match(normalized, /public-stewardship-day\/v1/);
          assert.match(normalized, /one actor and stable item/);
          assert.match(normalized, /Pin, unpin, lock and unlock facets and repeated toggles share one daily unit/);
          assert.match(normalized, /Independently qualified same-metric receipts/);
          assert.match(normalized, /separate source or acceptance day lenses/);
          assert.match(normalized, /acceptance never supplies a missing raw event time/);
          assert.match(normalized, /Totals remain descriptive and are never ranked/);
        }
      }
    }
    const filter = render(React.createElement(ScopeBar, { metricId: "pr_merged", timeWindow: null }));
    assert.match(filter, /Unsupported: observed:acceptedAt/);
    assert.match(filter, /value="qualified:acceptedAt"/);
    assert.doesNotMatch(filter, /value="qualified:occurredAt"/);
    const invalidBoard = render(React.createElement(BoardPage, { metricId: "pr_merged" }));
    assert.match(invalidBoard, /Unsupported metric view/);
    assert.doesNotMatch(invalidBoard, /board-table/);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/live", search: "?mode=single&boards=retained_lines" } },
    });
    const { LivePage } = await server.ssrLoadModule("/apps/web/src/routes/Live.tsx");
    const wall = render(React.createElement(LivePage));
    assert.match(wall, /Unsupported wall selection/);
    assert.doesNotMatch(wall, /mini-board|wall-table/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    await server.close();
  }
});
