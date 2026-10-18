import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import {
  board,
  selection,
  validateExport,
  parameters,
  portfolioParameters,
  uiHref,
  liveParameters,
} from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";
import { proofHref, isProofTransition } from "../src/remote/proof.ts";
import { createRankComparisonHarness } from "../../../tests/fixtures/rank-comparison.mjs";

const metric = metricRegistryV1.metrics.find((entry) => entry.id === "pr_merged");
const cases = [
  ["legacy", {}, 5],
  ["current without Projects", { context: "current" }, 5],
  ["current Project union", { context: "current", projects: ["PVT_A", "PVT_B="] }, 5],
  ["event Project membership", { context: "event", projects: ["PVT_PAST"] }, 5],
  [
    "current Project and role unions",
    { context: "current", projects: ["PVT_A", "PVT_B="], roles: ["author", "reviewer"] },
    5,
  ],
  ["nonmatching role", { context: "current", projects: ["PVT_A"], roles: ["reviewer"] }, 0],
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

for (const [name, filters, rows] of cases) {
  test(`real engine/service comparison retains the complete ${name} scope in board and exports`, async (t) => {
    const h = await documents(t, filters);
    const actual = board(h.board, h.selected);
    assert.deepEqual(actual.scope, h.scope);
    assert.deepEqual(actual.comparison.scope, h.previousScope);
    assert.equal(actual.comparison.snapshotId, h.beforeId);
    assert.equal(actual.totalRows, rows);
    assert.equal(actual.rows.length, rows);
    const csv = parseCSVExport(h.csv, metric, Number(h.selected.limit));
    for (const body of [h.json, csv]) {
      assert.doesNotThrow(() => validateExport(body, h.selected, metric));
      assert.deepEqual(body.scope, h.scope);
      assert.deepEqual(body.comparison.scope, h.previousScope);
      assert.deepEqual(
        body.rows.map((row) => row.movement),
        actual.rows.map((row) => row.movement),
      );
    }
    assert.equal(
      h.json.exportSchemaVersion,
      h.scope.roles?.length ? "public-export/v3" : h.scope.schemaVersion ? "public-export/v2" : "public-export/v1",
    );
    if (rows) {
      assert.equal(
        actual.rows.reduce((sum, row) => sum + row.result.value, 0),
        10,
        "a fact shared by two Projects is counted once",
      );
      const byActor = new Map(actual.rows.map((row) => [row.actorId, row]));
      assert.deepEqual(byActor.get(h.actorIds.b).movement, {
        actorId: h.actorIds.b,
        state: "comparable",
        delta: 1,
        reason: null,
      });
      assert.deepEqual(byActor.get(h.actorIds.a).movement, {
        actorId: h.actorIds.a,
        state: "comparable",
        delta: -1,
        reason: null,
      });
      assert.equal(byActor.get(h.actorIds.c).movement.state, "new_entrant");
      assert.equal(byActor.get(h.actorIds.d).rank, byActor.get(h.actorIds.e).rank);
    }
  });
}

// Re-encode only service-produced synthetic cells to reach the baseline validator.
function rewriteCSV(raw, mutate) {
  const rows = [],
    matcher = /"((?:[^"]|"")*)"(,|\r\n)/gy;
  let row = [],
    end = 0;
  for (let match; (match = matcher.exec(raw));) {
    row.push(match[1].replaceAll('""', '"'));
    end = matcher.lastIndex;
    if (match[2] === "\r\n") {
      rows.push(row);
      row = [];
    }
  }
  assert.equal(end, raw.length);
  assert.deepEqual(row, []);
  mutate(rows);
  return rows.map((record) => record.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",") + "\r\n").join("");
}

for (const filters of [cases[2][1], cases[4][1]]) {
  test(`baseline ${filters.roles ? "v3" : "v2"} scope cannot be substituted or downgraded in boards, JSON or CSV`, async (t) => {
    const h = await documents(t, filters);
    const mutations = [
      (scope) => delete scope.schemaVersion,
      (scope) => (scope.schemaVersion = "public-scope/v9"),
      (scope) => delete scope.context,
      (scope) => (scope.context = "event"),
      (scope) => delete scope.projects,
      (scope) => (scope.projects = ["PVT_FOREIGN"]),
      (scope) => scope.projects.reverse(),
      (scope) => scope.projects.push(scope.projects[0]),
      (scope) => (scope.currentContext = { projects: ["private-source"] }),
      ...(filters.roles
        ? [
            (scope) => delete scope.roles,
            (scope) => (scope.roles = []),
            (scope) => (scope.roles = ["reporter"]),
            (scope) => scope.roles.reverse(),
            (scope) => (scope.schemaVersion = "public-scope/v2"),
          ]
        : [(scope) => (scope.roles = []), (scope) => (scope.schemaVersion = "public-scope/v3")]),
    ];
    for (const mutate of mutations) {
      const badBoard = structuredClone(h.board),
        badJSON = structuredClone(h.json);
      mutate(badBoard.comparison.scope);
      mutate(badJSON.comparison.scope);
      assert.throws(() => board(badBoard, h.selected), undefined, String(mutate));
      assert.throws(() => validateExport(badJSON, h.selected, metric), undefined, String(mutate));
      const badCSV = rewriteCSV(h.csv, (rows) => {
        const column = rows[0].indexOf("comparison");
        for (const row of rows.slice(1)) {
          const comparison = JSON.parse(row[column]);
          mutate(comparison.scope);
          row[column] = JSON.stringify(comparison);
        }
      });
      assert.throws(
        () => validateExport(parseCSVExport(badCSV, metric, 50), h.selected, metric),
        undefined,
        String(mutate),
      );
    }
    const parsed = board(h.board, h.selected),
      retained = structuredClone(parsed.comparison.scope);
    h.board.comparison.scope.projects.push("PVT_AFTER_PARSE");
    if (h.board.comparison.scope.roles) h.board.comparison.scope.roles.push("reporter");
    assert.deepEqual(parsed.comparison.scope, retained, "retained baseline scope is detached from the response object");
  });
}

test("comparison CSV chooses the complete versioned header and enforces repeated baseline metadata", async (t) => {
  const h = await documents(t, cases[4][1]);
  for (const mutate of [
    (rows) => {
      const column = rows[0].indexOf("roles");
      for (const row of rows) row.splice(column, 1);
    },
    (rows) => {
      rows[0][rows[0].indexOf("scope_schema_version")] = "scope_version";
    },
    (rows) => {
      rows[0].reverse();
    },
    (rows) => {
      rows[1][rows[0].indexOf("movement")] = "{}";
    },
    (rows) => {
      const column = rows[0].indexOf("comparison");
      const value = JSON.parse(rows[2][column]);
      value.scope.roles = ["reviewer"];
      rows[2][column] = JSON.stringify(value);
    },
    (rows) => {
      for (const row of rows) row.splice(-2, 2);
    },
  ]) {
    const bad = rewriteCSV(h.csv, mutate);
    assert.throws(() => validateExport(parseCSVExport(bad, metric, 50), h.selected, metric), undefined, String(mutate));
  }
});

test("complete scoped comparison navigation keeps its pair only on board routes and never on live or proof requests", async (t) => {
  const h = await documents(t, cases[4][1]);
  const value = { ...h.selected, cursor: "old.signature", timeZone: "America/New_York" };
  const keys = ["context", "project", "role", "compare", "compareStart", "compareEnd"];
  const expected = parameters(value, { board: true });
  for (const path of ["/leaderboards/pr_merged", "/projects/engineering"]) {
    const href = new URL(uiHref(path, value, { cursor: value.cursor }), "https://synthetic.invalid");
    for (const key of keys) assert.equal(href.searchParams.get(key), expected.get(key));
    assert.equal(href.searchParams.get("tz"), value.timeZone);
    const proof = new URL(proofHref(path, value, "synthetic-b1"), href);
    assert.equal(
      isProofTransition({ pathname: path, search: href.search }, { pathname: path, search: proof.search }),
      true,
    );
    for (const key of keys) assert.equal(proof.searchParams.get(key), expected.get(key));
  }
  for (const params of [parameters(value), portfolioParameters(value), liveParameters("/api/v1", value)]) {
    for (const key of ["context", "project", "role"]) assert.equal(params.get(key), expected.get(key));
    for (const key of ["compare", "compareStart", "compareEnd", "tz"]) assert.equal(params.has(key), false);
  }
  for (const path of ["/contributors", "/activity", "/contributions/synthetic-b1", "/live", "/methodology"]) {
    const href = new URL(uiHref(path, value), "https://synthetic.invalid");
    for (const key of ["context", "project", "role"]) assert.equal(href.searchParams.get(key), expected.get(key));
    for (const key of ["compare", "compareStart", "compareEnd"]) assert.equal(href.searchParams.has(key), false);
  }
});
