import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { board, parameters, selection, uiHref, validateExport } from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";
import { proofHref } from "../src/remote/proof.ts";
import { createRankComparisonHarness } from "../../../tests/fixtures/rank-comparison.mjs";

const metric = metricRegistryV1.metrics.find((entry) => entry.id === "pr_merged");
const scopes = [
  ["current membership", { context: "current", projects: ["PVT_A", "PVT_B="] }, "public-export/v2"],
  ["event membership", { context: "event", projects: ["PVT_A"] }, "public-export/v2"],
  [
    "current membership and roles",
    { context: "current", projects: ["PVT_A", "PVT_B="], roles: ["author", "reviewer"] },
    "public-export/v3",
  ],
  ["event roles", { roles: ["author"] }, "public-export/v3"],
];

async function documents(t, filters) {
  const h = createRankComparisonHarness(filters);
  t.after(() => h.app.close());
  const responses = await Promise.all([
    h.app.inject(`/api/v1/boards?${h.params}`),
    h.app.inject(`/api/v1/exports?${h.params}&format=json`),
    h.app.inject(`/api/v1/exports?${h.params}&format=csv`),
  ]);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  return {
    ...h,
    selected: selection(h.params.toString(), { comparison: true }),
    board: responses[0].json(),
    json: responses[1].json(),
    csv: responses[2].body,
  };
}

// Mutate real service CSV cells without sharing the parser's validation rules.
function rewriteCSV(raw, mutate) {
  const rows = [],
    cells = /"((?:[^"]|"")*)"(,|\r\n)/gy;
  let row = [];
  for (;;) {
    const match = cells.exec(raw);
    if (!match) break;
    row.push(match[1].replaceAll('""', '"'));
    if (match[2] === "\r\n") {
      rows.push(row);
      row = [];
      if (cells.lastIndex === raw.length) break;
    }
  }
  assert.equal(row.length, 0);
  assert.ok(rows.length > 2);
  mutate(rows);
  return rows.map((record) => record.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",") + "\r\n").join("");
}

for (const [name, filters, legacyVersion] of scopes) {
  test(`comparison retains actual engine movement and both complete ${name} scopes in board, JSON and CSV`, async (t) => {
    const h = await documents(t, filters);
    assert.equal(h.board.comparison.snapshotId, h.beforeId);
    assert.deepEqual(h.board.comparison.scope, h.previousScope);
    assert.equal(h.json.exportSchemaVersion, "public-export/v4");
    assert.ok(["public-export/v2", "public-export/v3"].includes(legacyVersion));
    assert.equal(h.json.rankingPresentation.state, "ranked");
    const parsed = board(h.board, h.selected);
    assert.deepEqual(parsed.scope, h.scope);
    assert.deepEqual(parsed.comparison.scope, h.previousScope);
    assert.deepEqual(
      parsed.rows.map((row) => row.rank),
      [1, 2, 3, 3, 3],
    );
    assert.deepEqual(
      parsed.rows.map((row) => row.movement.state),
      ["comparable", "comparable", "new_entrant", "comparable", "comparable"],
    );
    assert.deepEqual(
      parsed.rows.map((row) => row.movement.delta),
      [1, -1, null, 0, 0],
    );
    validateExport(h.json, h.selected, metric);
    const csv = parseCSVExport(h.csv, metric, 50);
    validateExport(csv, h.selected, metric);
    assert.deepEqual(csv.scope, h.scope);
    assert.deepEqual(csv.comparison, h.json.comparison);
    assert.deepEqual(
      csv.rows.map(({ actorId, rank, movement }) => ({ actorId, rank, movement })),
      h.json.rows.map(({ actorId, rank, movement }) => ({ actorId, rank, movement })),
    );
    const url = new URL(
      proofHref("/leaderboards/pr_merged", { ...h.selected, timeZone: "Pacific/Honolulu" }, "synthetic-proof"),
      "https://synthetic.invalid",
    );
    assert.equal(url.searchParams.get("compare"), h.beforeId);
    assert.equal(url.searchParams.get("compareStart"), h.previousScope.start);
    assert.equal(url.searchParams.get("tz"), "Pacific/Honolulu");
    assert.deepEqual(selection(url.search, { comparison: true }).projects, h.selected.projects);
    assert.deepEqual(selection(url.search, { comparison: true }).roles, h.selected.roles);
    const api = parameters(h.selected, { board: true });
    assert.equal(api.get("context"), h.params.get("context"));
    assert.equal(api.get("project"), h.params.get("project"));
    assert.equal(api.get("role"), h.params.get("role"));
    assert.equal(api.has("tz"), false);
    for (const key of ["compare", "compareStart", "compareEnd"]) assert.equal(parameters(h.selected).has(key), false);
    const other = new URL(uiHref("/contributors/synthetic-rank-a", h.selected), url);
    assert.equal(other.searchParams.has("compare"), false);
    assert.equal(other.searchParams.get("role"), h.params.get("role"));
  });

  test(`comparison rejects substituted, downgraded and private ${name} baseline scopes`, async (t) => {
    const h = await documents(t, filters);
    const mutations = [
      (scope) => {
        scope.context = scope.context === "current" ? "event" : "current";
      },
      (scope) => {
        scope.projects = ["PVT_OTHER"];
      },
      (scope) => {
        delete scope.schemaVersion;
      },
      (scope) => {
        delete scope.projects;
      },
      (scope) => {
        scope.privateMembership = ["hidden"];
      },
      (scope) => {
        scope.roles = ["merger"];
      },
      (scope) => {
        scope.schemaVersion = "public-scope/v1";
      },
    ];
    for (const [original, validate] of [
      [h.board, (v) => board(v, h.selected)],
      [h.json, (v) => validateExport(v, h.selected, metric)],
    ]) {
      assert.doesNotThrow(() => validate(original), "intact current service response must be accepted first");
      for (const mutate of mutations) {
        const bad = structuredClone(original);
        mutate(bad.comparison.scope);
        assert.throws(() => validate(bad));
      }
    }
    for (const mutate of [
      (rows) => {
        rows[0][rows[0].indexOf("movement")] = "private_history";
      },
      (rows) => {
        rows[1][rows[0].indexOf("movement")] = "{}";
      },
      (rows) => {
        rows[2][rows[0].indexOf("comparison")] = "{}";
      },
      (rows) => {
        for (const row of rows.slice(1)) row[rows[0].indexOf("export_schema_version")] = "public-export/v1";
      },
      (rows) => {
        const column = rows[0].indexOf("comparison");
        const baseline = JSON.parse(rows[1][column]);
        baseline.scope.projects = ["PVT_OTHER"];
        for (const row of rows.slice(1)) row[column] = JSON.stringify(baseline);
      },
      (rows) => {
        rows[2].push("hidden");
      },
      (rows) => {
        rows[2].pop();
      },
    ]) {
      assert.throws(() => validateExport(parseCSVExport(rewriteCSV(h.csv, mutate), metric, 50), h.selected, metric));
    }
  });
}
