import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import {
  board,
  exportPage,
  parameters,
  portfolioParameters,
  rankComparisonPath,
  selection,
  uiHref,
  validateExport,
} from "../src/remote/client.ts";
import { parseCSVExport } from "../src/remote/csv-export.ts";
import { parseExportJSON } from "../src/remote/export-json.ts";
import { isProofTransition, proofHref } from "../src/remote/proof.ts";
import { createRankComparisonHarness } from "../../../tests/fixtures/rank-comparison.mjs";

const metric = metricRegistryV1.metrics.find((entry) => entry.id === "pr_merged");
const selected = (query) => selection(query, { comparison: true });
const comparisonKeys = ["compare", "compareStart", "compareEnd"];
const beforeStart = "2026-09-17T00:00:00.000Z";
const beforeEnd = "2026-10-17T00:00:00.000Z";

async function documents(t, patch = () => {}) {
  const h = createRankComparisonHarness();
  t.after(() => h.app.close());
  patch(h.pair);
  const params = new URLSearchParams(h.params);
  params.set("snapshot", h.afterId);
  const paths = [
    `/api/v1/boards?${params}`,
    `/api/v1/exports?${params}&format=json`,
    `/api/v1/exports?${params}&format=csv`,
  ];
  const responses = await Promise.all(paths.map((path) => h.app.inject(path)));
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  return {
    ...h,
    params,
    selected: selected(params.toString()),
    board: responses[0].json(),
    json: responses[1].json(),
    csv: responses[2].body,
  };
}

// Rewrite known service-produced fixture cells to exercise hostile CSV inputs.
// This helper imposes no validation policy and is never used by the client.
function rewriteCSV(raw, mutate) {
  const rows = [];
  let row = [];
  const cells = /"((?:[^"]|"")*)"(,|\r\n)/gy;
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
  assert.equal(rows.length > 2, true);
  mutate(rows);
  return rows.map((record) => record.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",") + "\r\n").join("");
}

test("comparison selection requires an explicit board capability and exact paired UTC bounds", () => {
  const query = `?compare=before&compareStart=${beforeStart}&compareEnd=${beforeEnd}`;
  const value = selected(query);
  assert.equal(value.compare, "before");
  assert.equal(value.compareStart, beforeStart);
  assert.equal(value.compareEnd, beforeEnd);
  assert.throws(() => selection(query), /comparison_requires_board/);
  assert.equal(selected("?compare=before").compareStart, null);
  assert.equal(selected("?compare=before").compareEnd, null);
  assert.equal(Object.hasOwn(selection(""), "compare"), false);
  for (const path of ["/leaderboards/pr_merged", "/projects/synthetic-workstream"])
    assert.equal(rankComparisonPath(path), true);
  for (const path of ["/leaderboards", "/methodology/pr_merged", "/contributors", "/live", "/coverage"])
    assert.equal(rankComparisonPath(path), false);
  for (const bad of [
    "?compare=",
    "?compare=before&compare=after",
    "?compare=bad%20id",
    "?compare=" + "a".repeat(201),
    `?compareStart=${beforeStart}&compareEnd=${beforeEnd}`,
    `?compare=before&compareStart=${beforeStart}`,
    `?compare=before&compareEnd=${beforeEnd}`,
    `?compare=before&compareStart=${beforeEnd}&compareEnd=${beforeStart}`,
    `?compare=before&compareStart=${beforeEnd}&compareEnd=${beforeEnd}`,
    "?compare=before&compareStart=2026-02-30T00:00:00.000Z&compareEnd=2026-03-31T00:00:00.000Z",
    "?compare=before&compareStart=2026-09-17T00:00:00Z&compareEnd=2026-10-17T00:00:00.000Z",
    "?compare=before&compareStart=2026-09-17T00:00:00.001Z&compareEnd=2026-10-17T00:00:00.000Z",
    "?compare=before&compareStart=2025-01-01T00:00:00.000Z&compareEnd=2026-01-03T00:00:00.000Z",
    query + "&compareStart=" + beforeStart,
    query + "&priorActor=hidden",
  ])
    assert.throws(() => selected(bad), bad);
});

test("only boards and exports receive comparison selectors; proof URLs and cursor pages retain their background", () => {
  const value = selected(
    `?compare=before&compareStart=${beforeStart}&compareEnd=${beforeEnd}` +
      "&snapshot=after&repository=synthetic-repo&workstream=synthetic-workstream&metric=pr_merged" +
      "&actors=user&limit=4&cursor=old.signature&proof=synthetic-evidence",
  );
  const exact = parameters(value, { board: true, cursor: value.cursor });
  for (const key of comparisonKeys) assert.equal(exact.get(key), value[key]);
  for (const key of ["snapshot", "repository", "workstream", "metric", "actors", "limit", "cursor"])
    assert.equal(exact.get(key), value[key]);
  assert.equal(exact.has("proof"), false);
  for (const params of [parameters(value), portfolioParameters(value), portfolioParameters(value, true)])
    for (const key of comparisonKeys) assert.equal(params.has(key), false);
  for (const path of ["/leaderboards/pr_merged", "/projects/synthetic-workstream"]) {
    const next = new URL(uiHref(path, value, { cursor: "next.signature" }), "https://example.invalid");
    for (const key of comparisonKeys) assert.equal(next.searchParams.get(key), value[key]);
    assert.equal(next.searchParams.get("cursor"), "next.signature");
    assert.equal(next.searchParams.get("snapshot"), "after");
    const proof = new URL(proofHref(path, value, "synthetic-evidence"), next);
    assert.equal(proof.searchParams.get("cursor"), "old.signature");
    assert.equal(proof.searchParams.get("compare"), "before");
    const background = { pathname: path, search: new URL(uiHref(path, value, { cursor: value.cursor }), next).search };
    assert.equal(isProofTransition(background, { pathname: path, search: proof.search }), true);
    proof.searchParams.set("compare", "different");
    assert.equal(isProofTransition(background, { pathname: path, search: proof.search }), false);
  }
  for (const path of ["/", "/coverage", "/activity", "/contributors/a", "/contributions/e", "/methodology", "/live"]) {
    const target = new URL(uiHref(path, value), "https://example.invalid");
    for (const key of comparisonKeys) assert.equal(target.searchParams.has(key), false);
    assert.equal(target.searchParams.get("snapshot"), "after");
    assert.equal(target.searchParams.has("cursor"), false);
  }
});

test("actual engine and service comparison retains upward, downward, neutral and entrant states with dense ties", async (t) => {
  const h = await documents(t);
  const parsed = board(h.board, h.selected);
  assert.equal(parsed.comparison.snapshotId, h.beforeId);
  assert.deepEqual(parsed.comparison.scope, h.previousScope);
  assert.equal(parsed.totalRows, 5);
  const actors = new Map(parsed.rows.map((row) => [row.actorId, row]));
  for (const [id, rank, delta] of [
    ["b", 1, 1],
    ["a", 2, -1],
    ["d", 3, 0],
    ["e", 3, 0],
  ]) {
    const actorId = h.actorIds[id];
    assert.equal(actors.get(actorId).rank, rank);
    assert.deepEqual(actors.get(actorId).movement, { actorId, state: "comparable", delta, reason: null });
  }
  assert.equal(actors.get(h.actorIds.c).rank, 3);
  assert.deepEqual(actors.get(h.actorIds.c).movement, {
    actorId: h.actorIds.c,
    state: "new_entrant",
    delta: null,
    reason: null,
  });
  validateExport(h.json, h.selected, metric);
  const csv = parseCSVExport(h.csv, metric, Number(h.selected.limit));
  validateExport(csv, h.selected, metric);
  assert.deepEqual(csv.comparison, h.json.comparison);
  assert.deepEqual(
    csv.rows.map((row) => [row.actorId, row.rank, row.movement]),
    h.json.rows.map((row) => [row.actorId, row.rank, row.movement]),
  );
  for (const value of [h.board, h.json, csv]) {
    const encoded = JSON.stringify(value);
    for (const privateField of [
      "private-acceptance-secret",
      "private-rank-evidence",
      "backfillRevision",
      "evidenceSignatures",
    ])
      assert.equal(encoded.includes(privateField), false);
  }
});

test("publication generation time does not invent a different comparison-cutoff policy", async (t) => {
  const h = await documents(t, (pair) => {
    pair.previous.selected.snapshot.generatedAt = "2026-10-18T00:00:01.000Z";
    pair.previous.head.publishedAt = "2026-10-18T00:00:01.000Z";
  });
  assert.equal(h.board.comparison.generatedAt > h.board.generatedAt, true);
  assert.equal(
    board(h.board, h.selected).rows.some((row) => row.movement.state === "comparable"),
    true,
  );
  validateExport(h.json, h.selected, metric);
  validateExport(parseCSVExport(h.csv, metric, 50), h.selected, metric);
});

test("comparison rejects an explicitly disabled selected metric before presenting movement", async (t) => {
  const h = await documents(t);
  assert.doesNotThrow(() => board(h.board, h.selected));
  const contradictory = structuredClone(h.board);
  contradictory.disabledMetrics = [
    { id: metric.id, reason: "explicitly_disabled", policyVersion: "synthetic-policy-v1", policyLink: null },
  ];
  assert.throws(() => board(contradictory, h.selected), /invalid_rank_comparison/);
});

test("unrelated disabled metrics preserve actual-service comparisons and explicit unavailable movement", async (t) => {
  const unrelated = metricRegistryV1.metrics.find((entry) => entry.id !== metric.id).id;
  const h = await documents(t, (pair) => {
    pair.current.selected.disabledMetrics = [
      { id: unrelated, reason: "explicitly_disabled", policyVersion: "synthetic-policy-v1", policyLink: null },
    ];
  });
  const parsed = board(h.board, h.selected);
  assert.deepEqual(parsed.disabledMetrics, [
    { id: unrelated, reason: "explicitly_disabled", policyVersion: "synthetic-policy-v1", policyLink: null },
  ]);
  assert.equal(
    parsed.rows.some((row) => row.movement.state === "comparable"),
    true,
  );
  validateExport(h.json, h.selected, metric);
  validateExport(parseCSVExport(h.csv, metric, 50), h.selected, metric);
  const unavailable = structuredClone(h.board);
  unavailable.comparison = { snapshotId: null, scope: null, generatedAt: null };
  for (const row of unavailable.rows)
    row.movement = { actorId: row.actorId, state: "unavailable", delta: null, reason: "comparison_unavailable" };
  assert.equal(
    board(unavailable, h.selected).rows.every((row) => row.movement.state === "unavailable"),
    true,
  );
  unavailable.ranking = null;
  unavailable.rankingPresentation = {
    ...unavailable.rankingPresentation,
    state: "not_ranked",
    comparableContributors: 0,
    unrankableContributors: unavailable.totalRows,
  };
  for (const row of unavailable.rows) row.rank = null;
  assert.equal(
    board(unavailable, h.selected).rows.every((row) => row.rank === null && row.movement.state === "unavailable"),
    true,
  );
});

test("actual service rejects selected-disabled comparisons for boards and both export formats", async (t) => {
  const h = await documents(t);
  h.pair.current.selected.disabledMetrics = [
    { id: metric.id, reason: "explicitly_disabled", policyVersion: "synthetic-policy-v1", policyLink: null },
  ];
  for (const path of [
    `/api/v1/boards?${h.params}`,
    `/api/v1/exports?${h.params}&format=json`,
    `/api/v1/exports?${h.params}&format=csv`,
  ]) {
    const response = await h.app.inject(path);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, "metric_disabled");
    assert.equal(response.json().metric.id, metric.id);
    assert.equal(Object.hasOwn(response.json(), "rows"), false);
  }
});

test("ordinary service responses remain compatible without comparison fields or CSV columns", async (t) => {
  const h = await documents(t);
  // Preserve the actual pre-policy export contract rather than relabelling a v4 response.
  delete h.pair.current.selected.rankingPresentationPolicy;
  const params = new URLSearchParams(h.params);
  for (const key of comparisonKeys) params.delete(key);
  const plain = selection(params.toString());
  const response = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(response.statusCode, 200, response.body);
  const parsed = board(response.json(), plain);
  assert.equal(Object.hasOwn(parsed, "comparison"), false);
  assert.equal(
    parsed.rows.some((row) => Object.hasOwn(row, "movement")),
    false,
  );
  const csv = await h.app.inject(`/api/v1/exports?${params}&format=csv`);
  assert.equal(csv.statusCode, 200, csv.body);
  rewriteCSV(csv.body, (rows) => assert.equal(rows[0].length, 41));
  validateExport(parseCSVExport(csv.body, metric, Number(plain.limit)), plain, metric);
  assert.throws(() => board(h.board, plain), /invalid_rank_comparison/);
  assert.throws(() => validateExport(h.json, plain, metric), /invalid_rank_comparison/);
});

test("cursor pages retain the service's tied rank and reject a substituted comparison selection", async (t) => {
  const h = await documents(t);
  const params = new URLSearchParams(h.params);
  params.set("limit", "4");
  const first = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(first.statusCode, 200, first.body);
  const page = board(first.json(), selected(params.toString()));
  assert.deepEqual(
    page.rows.map((row) => row.rank),
    [1, 2, 3, 3],
  );
  assert.equal(typeof page.nextCursor, "string");
  params.set("cursor", page.nextCursor);
  const next = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(next.statusCode, 200, next.body);
  const last = board(next.json(), selected(params.toString()));
  assert.deepEqual(
    last.rows.map((row) => row.rank),
    [3],
  );
  assert.equal(last.rows[0].movement.delta, 0);
  params.set("compare", "synthetic-substitution");
  const substituted = await h.app.inject(`/api/v1/boards?${params}`);
  assert.notEqual(substituted.statusCode, 200);
});

const malformed = [
  [
    "missing comparison",
    (value) => {
      delete value.comparison;
    },
  ],
  [
    "mixed unavailable identity",
    (value) => {
      value.comparison.scope = null;
    },
  ],
  [
    "substituted baseline",
    (value) => {
      value.comparison.snapshotId = "synthetic-other";
    },
  ],
  [
    "substituted baseline scope",
    (value) => {
      value.comparison.scope.repository = "synthetic-other";
    },
  ],
  [
    "substituted baseline window",
    (value) => {
      value.comparison.scope.start = beforeEnd;
    },
  ],
  [
    "private comparison field",
    (value) => {
      value.comparison.privateHistory = "secret";
    },
  ],
  [
    "private scope field",
    (value) => {
      value.comparison.scope.actorIds = ["hidden"];
    },
  ],
  [
    "invalid baseline clock",
    (value) => {
      value.comparison.generatedAt = "yesterday";
    },
  ],
  [
    "invalid current clock",
    (value) => {
      value.generatedAt = "yesterday";
    },
  ],
  [
    "missing movement",
    (value) => {
      delete value.rows[0].movement;
    },
  ],
  [
    "substituted actor",
    (value) => {
      value.rows[0].movement.actorId = "hidden";
    },
  ],
  [
    "private movement field",
    (value) => {
      value.rows[0].movement.priorActor = "hidden";
    },
  ],
  [
    "fractional delta",
    (value) => {
      value.rows[0].movement.delta = 0.5;
    },
  ],
  [
    "unsafe delta",
    (value) => {
      value.rows[0].movement.delta = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    "impossible previous rank",
    (value) => {
      value.rows[0].movement.delta = -1;
    },
  ],
  [
    "non-null comparable reason",
    (value) => {
      value.rows[0].movement.reason = "insufficient_history";
    },
  ],
  [
    "unknown movement state",
    (value) => {
      value.rows[0].movement.state = "improved";
    },
  ],
  [
    "numeric entrant",
    (value) => {
      value.rows[0].movement.state = "new_entrant";
    },
  ],
  [
    "unavailable with delta",
    (value) => {
      value.rows[0].movement.state = "unavailable";
      value.rows[0].movement.reason = "insufficient_history";
    },
  ],
  [
    "unavailable without reason",
    (value) => {
      value.rows[0].movement.state = "unavailable";
      value.rows[0].movement.delta = null;
    },
  ],
  [
    "unranked comparable",
    (value) => {
      value.rows[0].rank = null;
    },
  ],
  [
    "missing ranking policy",
    (value) => {
      value.ranking = null;
    },
  ],
  [
    "missing ranking metric identity",
    (value) => {
      delete value.ranking.metricId;
    },
  ],
  [
    "foreign ranking metric identity",
    (value) => {
      value.ranking.metricId = "unrelated_metric";
    },
  ],
  [
    "non-string ranking direction",
    (value) => {
      value.ranking.direction = ["descending"];
    },
  ],
  [
    "unknown value",
    (value) => {
      value.rows[0].result.state = "unknown";
      delete value.rows[0].result.value;
    },
  ],
  [
    "unavailable identity with numeric movement",
    (value) => {
      value.comparison = { snapshotId: null, scope: null, generatedAt: null };
    },
  ],
  [
    "duplicate actor rows",
    (value) => {
      value.rows[1] = structuredClone(value.rows[0]);
    },
  ],
];

for (const [name, mutate] of malformed) {
  test(`board and export reject ${name} before presentation or download`, async (t) => {
    const h = await documents(t);
    for (const [original, validate] of [
      [h.board, (value) => board(value, h.selected)],
      [h.json, (value) => validateExport(value, h.selected, metric)],
    ]) {
      assert.doesNotThrow(() => validate(original), `${name}: intact service response`);
      const invalid = structuredClone(original);
      mutate(invalid);
      assert.throws(() => validate(invalid), name);
    }
  });
}

test("explicit unavailable states remain null and never accept filtered-cohort numeric claims", async (t) => {
  const h = await documents(t);
  for (const reason of [
    "comparison_unavailable",
    "current_authority_changed",
    "mixed_computation_versions",
    "insufficient_evidence_history",
    "history_or_visible_cohort_changed",
    "filtered_cohort_unavailable",
    "different_metric",
    "mixed_policy_versions",
    "different_scope_or_window",
    "insufficient_history",
    "backfill_or_reconciliation",
    "reversed_snapshots",
    "late_history",
    "corrected_or_removed_evidence",
    "unranked_metric",
    "future_compatible_machine_code",
  ]) {
    const value = structuredClone(h.board);
    value.rows = value.rows.map((row) => ({
      ...row,
      movement: { actorId: row.actorId, state: "unavailable", delta: null, reason },
    }));
    const parsed = board(value, h.selected);
    assert.equal(
      parsed.rows.every((row) => row.movement.delta === null && row.movement.reason === reason),
      true,
    );
    value.comparison = { snapshotId: null, scope: null, generatedAt: null };
    assert.equal(board(value, h.selected).comparison.snapshotId, null);
  }
  for (const reason of ["", "secret human text", "<script>", "a".repeat(121), null]) {
    const value = structuredClone(h.board);
    value.rows[0].movement = { actorId: value.rows[0].actorId, state: "unavailable", delta: null, reason };
    assert.throws(() => board(value, h.selected));
  }
  const filtered = structuredClone(h.board);
  filtered.actorFilter = "user";
  assert.throws(() => board(filtered, { ...h.selected, actors: "user" }), /invalid_rank_comparison/);
  const tooMany = { ...h.selected, limit: "4" };
  assert.throws(() => board(h.board, tooMany));
});

test("CSV comparison cells remain repeated exact metadata with no hidden fields, duplicate keys or formulas", async (t) => {
  const h = await documents(t);
  let column;
  rewriteCSV(h.csv, (rows) => {
    column = rows[0].indexOf("comparison");
    assert.equal(column, 43); // v4 includes policy and physical-context columns; movement is still adjacent.
    assert.equal(rows[0][column - 1], "physical_context");
    assert.equal(rows[1][column - 1], "", "the metadata record has no per-row physical context");
    assert.ok(
      rows.slice(2).every((row) => row[column - 1] === "null"),
      "this non-LOC metric has explicit null context",
    );
    assert.equal(rows[0][column + 1], "movement");
  });
  for (const mutate of [
    (rows) => {
      rows[0][column + 1] = "private_history";
    },
    (rows) => {
      rows[1][column + 1] = "{}";
    },
    (rows) => {
      rows[2][column] = "{}";
    },
    (rows) => {
      rows[2][column + 1] = "";
    },
    (rows) => {
      rows[2][column + 1] = '{"actorId":"b","actorId":"hidden"}';
    },
    (rows) => {
      rows[2][column + 1] = '=HYPERLINK("https://example.invalid")';
    },
    (rows) => {
      rows[2].pop();
    },
    (rows) => {
      rows[2].push("hidden");
    },
    (rows) => {
      const value = JSON.parse(rows[2][column + 1]);
      value.privateHistory = "hidden";
      rows[2][column + 1] = JSON.stringify(value);
    },
    (rows) => {
      const value = JSON.parse(rows[1][column]);
      value.snapshotId = "synthetic-substitution";
      for (const row of rows.slice(1)) row[column] = JSON.stringify(value);
    },
  ]) {
    const invalid = rewriteCSV(h.csv, mutate);
    assert.throws(() => validateExport(parseCSVExport(invalid, metric, 50), h.selected, metric));
  }
});

for (const format of ["json", "csv"]) {
  test(`actual ${format} comparison downloads retain exact source bytes and the displayed page selection`, async (t) => {
    const h = await documents(t);
    const raw = format === "json" ? JSON.stringify(h.json) : h.csv;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const request = new URL(url, "https://example.invalid");
      assert.equal(request.pathname, "/api/v1/exports");
      for (const key of [...comparisonKeys, "snapshot", "metric", "limit"])
        assert.equal(request.searchParams.get(key), h.selected[key]);
      assert.equal(init.credentials, "omit");
      assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "error");
      return new Response(raw, { headers: { "content-type": format === "json" ? "application/json" : "text/csv" } });
    });
    const blob = await exportPage("/api/v1", h.selected, format, new AbortController().signal, metric);
    assert.equal(await blob.text(), raw);
  });

  test(`a malformed ${format} comparison cannot fall back to an ordinary export`, async (t) => {
    const h = await documents(t);
    const bad = structuredClone(h.json);
    delete bad.comparison;
    for (const row of bad.rows) delete row.movement;
    const raw =
      format === "json"
        ? JSON.stringify(bad)
        : rewriteCSV(h.csv, (rows) => {
            const column = rows[0].indexOf("comparison");
            assert.equal(column, 43);
            assert.equal(rows[0][column + 1], "movement");
            for (const row of rows) row.splice(column, 2);
          });
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(raw, {
          headers: { "content-type": format === "json" ? "application/json" : "text/csv" },
        }),
    );
    await assert.rejects(
      () => exportPage("/api/v1", h.selected, format, new AbortController().signal, metric),
      /invalid_export_response/,
    );
  });
}

test("a late comparison export response is discarded after its selection is aborted", async (t) => {
  const h = await documents(t);
  const controller = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
  await assert.rejects(
    () => exportPage("/api/v1", h.selected, "json", controller.signal, metric),
    (error) => error.name === "AbortError",
  );
  assert.equal(cancelled, true);
  assert.throws(() => parseExportJSON('{"comparison":{"snapshotId":"a","snapshotId":"b"}}'));
});
