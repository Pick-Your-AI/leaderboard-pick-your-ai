import assert from "node:assert/strict";
import test from "node:test";
import { createRankingPresentationHarness } from "../../../tests/fixtures/ranking-presentation.mjs";
import { createRankComparisonHarness } from "../../../tests/fixtures/rank-comparison.mjs";
import { board, selection, validateExport } from "../../web/src/remote/client.ts";
import { parseCSVExport } from "../../web/src/remote/csv-export.ts";
import { rankingPresentationSchema, currentRankingPresentationPolicy } from "@pick-your-ai/contracts";

function harness(t, options) {
  const h = createRankingPresentationHarness(options);
  t.after(() => h.app.close());
  return h;
}
const query = "?metric=pr_merged";
const snapshot = "synthetic-cohort-snapshot";
async function read(h, path = "/api/v1/boards" + query) {
  const response = await h.app.inject(path);
  assert.equal(response.statusCode, 200, response.body);
  return response;
}
test("complete current enumeration counts approved numeric values independently of historical coverage", async (t) => {
  const h = harness(t),
    original = structuredClone(h.input);
  const response = await read(h),
    data = response.json();
  assert.deepEqual(data.rankingPresentation, {
    ...currentRankingPresentationPolicy,
    snapshotId: snapshot,
    metricId: "pr_merged",
    enumeration: "complete",
    totalContributors: 6,
    comparableContributors: 5,
    unrankableContributors: 1,
    state: "ranked",
  });
  assert.deepEqual(
    data.rows.map((r) => r.rank),
    [1, 2, 2, 3, 4, null],
  );
  assert.deepEqual(
    data.rows.map((r) => r.result.value),
    [9, 8, 8, 3, 0, undefined],
  );
  assert.equal(data.rows[0].result.coverage.state, "partial");
  assert.equal(data.rows[1].result.state, "partial");
  assert.equal(data.rows[4].result.state, "zero");
  assert.equal(data.rows[5].result.state, "unknown");
  assert.deepEqual(board(data, selection(query)).rankingPresentation, data.rankingPresentation);
  assert.deepEqual(h.input, original);
});
test("four comparable actors retain values and proofs without ranks and one unknown is not a fifth", async (t) => {
  const h = harness(t, { values: [9, 8, 3, 1, undefined] });
  const data = (await read(h)).json();
  assert.equal(data.rankingPresentation.state, "small_cohort");
  assert.equal(data.rankingPresentation.comparableContributors, 4);
  assert.equal(data.rankingPresentation.unrankableContributors, 1);
  assert.ok(data.rows.every((r) => r.rank === null));
  assert.deepEqual(
    data.rows.map((r) => r.result.value),
    [9, 8, 3, 1, undefined],
  );
  assert.equal(
    data.rows.slice(0, 4).every((r) => r.evidenceIds.length === 1),
    true,
  );
  assert.doesNotThrow(() => board(data, selection(query)));
});
test("the page limit and tied cursor continuation never become a cohort-size estimate", async (t) => {
  const h = harness(t);
  const first = (await read(h, "/api/v1/boards?metric=pr_merged&limit=2")).json();
  assert.equal(first.rows.length, 2);
  assert.equal(first.rankingPresentation.comparableContributors, 5);
  assert.equal(first.rankingPresentation.totalContributors, 6);
  assert.deepEqual(
    first.rows.map((r) => r.rank),
    [1, 2],
  );
  assert.ok(first.nextCursor);
  const next = (
    await read(h, `/api/v1/boards?metric=pr_merged&limit=2&snapshot=${snapshot}&cursor=${first.nextCursor}`)
  ).json();
  assert.deepEqual(
    next.rows.map((r) => r.rank),
    [2, 3],
  );
  assert.deepEqual(next.rankingPresentation, first.rankingPresentation);
  for (const limit of ["0", "101", "all"])
    assert.equal((await h.app.inject("/api/v1/boards?metric=pr_merged&limit=" + limit)).statusCode, 400);
});
test("current actor withdrawal recalculates a historical pin before rendering or exporting ranks", async (t) => {
  const h = harness(t),
    prior = await read(h);
  h.input.controls.suppressedActorIds = ["synthetic-cohort-1"];
  h.input.controls.version = "synthetic-cohort-withdrawal";
  const response = await h.app.inject({
    url: "/api/v1/boards" + query + "&snapshot=" + snapshot,
    headers: { "if-none-match": prior.headers.etag },
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  assert.equal(data.rankingPresentation.comparableContributors, 4);
  assert.equal(data.rankingPresentation.totalContributors, 5);
  assert.equal(data.rankingPresentation.state, "small_cohort");
  assert.equal(
    data.rows.some((r) => r.actorId === "synthetic-cohort-1"),
    false,
  );
  assert.ok(data.rows.every((r) => r.rank === null));
  for (const format of ["json", "csv"]) {
    const exportResponse = await read(h, `/api/v1/exports?metric=pr_merged&snapshot=${snapshot}&format=${format}`);
    assert.doesNotMatch(exportResponse.body, /synthetic-cohort-(?:proof-|pr-)?1(?:["\\]|&quot;)/);
    const output = format === "json" ? exportResponse.json() : parseCSVExport(exportResponse.body, data.metric, 50);
    assert.ok(output.rows.every((r) => r.rank === null));
    assert.equal(output.rankingPresentation.comparableContributors, 4);
    validateExport(output, selection(query + "&snapshot=" + snapshot), output.metric);
  }
});
test("lost aggregate proof removes its entire row before the displayed cohort is counted", async (t) => {
  const h = harness(t);
  h.input.controls.suppressedArtifactIds = ["synthetic-cohort-pr-2"];
  const data = (await read(h)).json();
  assert.equal(data.rankingPresentation.comparableContributors, 4);
  assert.equal(data.rankingPresentation.totalContributors, 5);
  assert.equal(
    data.rows.some((r) => r.actorId === "synthetic-cohort-2"),
    false,
  );
  assert.ok(data.rows.every((r) => r.rank === null));
});
test("actor filters count their complete eligible view and never reuse the broader stored count", async (t) => {
  const h = harness(t);
  const data = (await read(h, "/api/v1/boards?metric=pr_merged&actors=user")).json();
  assert.equal(data.rankingPresentation.totalContributors, 5);
  assert.equal(data.rankingPresentation.comparableContributors, 4);
  assert.equal(data.rankingPresentation.state, "small_cohort");
  assert.ok(data.rows.every((r) => r.actor.kind === "user" && r.rank === null));
});
test("disabled ranking is not activated by a numerically large cohort", async (t) => {
  const h = harness(t);
  h.input.selected.ranking[0].rank = false;
  const data = (await read(h)).json();
  assert.equal(data.rankingPresentation.state, "not_ranked");
  assert.equal(data.rankingPresentation.comparableContributors, 0);
  assert.equal(data.rankingPresentation.unrankableContributors, 6);
  assert.ok(data.rows.every((r) => r.rank === null));
});
test("invalid retained policy and duplicated contributor identity fail closed rather than minting a cohort", async (t) => {
  for (const mutate of [
    (h) => {
      h.input.selected.rankingPresentationPolicy.minimumComparableContributors = 4;
    },
    (h) => {
      h.input.selected.rankingPresentationPolicy.version = "ranking-presentation/v2";
    },
    (h) => {
      h.input.selected.rankingPresentationPolicy.privateInputs = "secret";
    },
    (h) => {
      h.input.selected.rows.push(structuredClone(h.input.selected.rows[0]));
    },
  ]) {
    const h = harness(t);
    mutate(h);
    const response = await h.app.inject("/api/v1/boards" + query);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.headers.etag, undefined);
    assert.doesNotMatch(response.body, /secret|synthetic-cohort-proof/);
  }
});
test("legacy policy absence is not retroactively assigned a threshold or a new export schema", async (t) => {
  const h = harness(t, { values: [9, 3], policy: false });
  const response = await read(h),
    data = response.json();
  assert.equal(Object.hasOwn(data, "rankingPresentation"), false);
  assert.equal(board(data, selection(query)).rankingPresentation, null);
  assert.deepEqual(
    data.rows.map((r) => r.rank),
    [1, 2],
  );
  const json = (await read(h, "/api/v1/exports?metric=pr_merged&format=json")).json();
  assert.equal(json.exportSchemaVersion, "public-export/v1");
  assert.equal(Object.hasOwn(json, "rankingPresentation"), false);
  validateExport(json, selection(query + "&snapshot=" + snapshot), json.metric);
});
test("v4 JSON and CSV carry the same closed current receipt while older scope variants stay intact", async (t) => {
  for (const [scope, extra, legacyVersion] of [
    [{}, "", "public-export/v1"],
    [
      { projects: ["SYNTHETIC_PROJECT"], context: "event" },
      "&project=SYNTHETIC_PROJECT&context=event",
      "public-export/v2",
    ],
    [{ roles: ["author"] }, "&role=author", "public-export/v3"],
  ]) {
    for (const policy of [false, true]) {
      const h = harness(t, { policy, scope });
      const json = (await read(h, "/api/v1/exports?metric=pr_merged&format=json" + extra)).json();
      const csvResponse = await read(h, "/api/v1/exports?metric=pr_merged&format=csv" + extra);
      const csv = parseCSVExport(csvResponse.body, json.metric, 50);
      assert.deepEqual(csv, json);
      assert.equal(json.exportSchemaVersion, policy ? "public-export/v4" : legacyVersion);
      assert.equal(Object.hasOwn(json, "rankingPresentation"), policy);
      validateExport(json, selection(query + "&snapshot=" + snapshot + extra), json.metric);
      validateExport(csv, selection(query + "&snapshot=" + snapshot + extra), json.metric);
    }
  }
});
test("clients reject mismatched cohort identities, altered policy and ranks hidden by current policy", async (t) => {
  const h = harness(t),
    data = (await read(h)).json();
  for (const mutate of [
    (v) => {
      v.rankingPresentation.snapshotId = "other";
    },
    (v) => {
      v.rankingPresentation.metricId = "pr_opened";
    },
    (v) => {
      v.rankingPresentation.totalContributors = 5;
    },
    (v) => {
      v.rankingPresentation.enumeration = "unknown";
    },
    (v) => {
      v.rankingPresentation.minimumComparableContributors = 4;
    },
    (v) => {
      v.rankingPresentation.comparableContributors = 4;
      v.rankingPresentation.unrankableContributors = 2;
      v.rankingPresentation.state = "small_cohort";
    },
    (v) => {
      v.rows[5].rank = 5;
    },
    (v) => {
      v.rows[0].rank = null;
    },
    (v) => {
      v.rows[0].rank = 6;
    },
  ]) {
    const copy = structuredClone(data);
    mutate(copy);
    assert.throws(() => board(copy, selection(query)), /invalid_ranking_presentation/);
  }
  const json = (await read(h, "/api/v1/exports?metric=pr_merged&format=json")).json();
  for (const mutate of [
    (v) => {
      delete v.rankingPresentation;
    },
    (v) => {
      v.exportSchemaVersion = "public-export/v1";
    },
    (v) => {
      v.rankingPresentation = null;
    },
  ]) {
    const copy = structuredClone(json);
    mutate(copy);
    assert.throws(() => validateExport(copy, selection(query + "&snapshot=" + snapshot), json.metric));
  }
});
test("missing policy in either compared snapshot keeps its independently retained values but withholds movement", async (t) => {
  for (const side of ["current", "previous"]) {
    const h = createRankComparisonHarness();
    t.after(() => h.app.close());
    assert.ok(h.pair.current.selected.rankingPresentationPolicy);
    assert.ok(h.pair.previous.selected.rankingPresentationPolicy);
    delete h.pair[side].selected.rankingPresentationPolicy;
    const response = await h.app.inject("/api/v1/boards?" + h.params);
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.comparison.snapshotId, null);
    assert.ok(
      data.rows.every(
        (r) => r.movement.state === "unavailable" && r.movement.reason === "ranking_presentation_policy_unknown",
      ),
    );
  }
});
test("the closed receipt distinguishes an unrankable value from incomplete enumeration", () => {
  const receipt = {
    ...currentRankingPresentationPolicy,
    snapshotId: snapshot,
    metricId: "pr_merged",
    enumeration: "complete",
    totalContributors: 6,
    comparableContributors: 5,
    unrankableContributors: 1,
    state: "ranked",
  };
  assert.equal(rankingPresentationSchema.safeParse(receipt).success, true);
  for (const patch of [
    { comparableContributors: 4 },
    { enumeration: "unknown" },
    { state: "small_cohort" },
    { comparableContributors: 0, unrankableContributors: 6, state: "ranked" },
    { totalContributors: 10001 },
    { unrelated: true },
  ])
    assert.equal(rankingPresentationSchema.safeParse({ ...receipt, ...patch }).success, false);
});

test("paired movement binds both current cohort receipts through board and JSON/CSV exports", async (t) => {
  const h = createRankComparisonHarness();
  t.after(() => h.app.close());
  const response = await h.app.inject("/api/v1/boards?" + h.params);
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json(),
    selected = selection(h.params.toString(), { comparison: true });
  assert.equal(data.rankingPresentation.snapshotId, h.afterId);
  assert.equal(data.rankingPresentation.comparableContributors, 5);
  assert.equal(data.comparison.rankingPresentation.snapshotId, h.beforeId);
  assert.equal(data.comparison.rankingPresentation.state, "ranked");
  assert.ok(data.comparison.rankingPresentation.comparableContributors >= 5);
  assert.ok(data.rows.some((row) => row.movement.state === "comparable" && row.movement.delta !== 0));
  assert.doesNotThrow(() => board(data, selected));
  for (const format of ["json", "csv"]) {
    const exported = await h.app.inject(`/api/v1/exports?${h.params}&format=${format}`);
    assert.equal(exported.statusCode, 200, exported.body);
    const document = format === "json" ? exported.json() : parseCSVExport(exported.body, data.metric, 50);
    assert.equal(document.exportSchemaVersion, "public-export/v4");
    assert.deepEqual(document.rankingPresentation, data.rankingPresentation);
    assert.deepEqual(document.comparison.rankingPresentation, data.comparison.rankingPresentation);
    validateExport(document, selected, data.metric);
    for (const mutate of [
      (value) => {
        delete value.comparison.rankingPresentation;
      },
      (value) => {
        value.comparison.rankingPresentation.snapshotId = h.afterId;
      },
      (value) => {
        value.comparison.rankingPresentation.metricId = "pr_opened";
      },
      (value) => {
        value.comparison.rankingPresentation.minimumComparableContributors = 4;
      },
      (value) => {
        value.comparison.rankingPresentation.state = "small_cohort";
        value.comparison.rankingPresentation.comparableContributors = 4;
        value.comparison.rankingPresentation.unrankableContributors =
          value.comparison.rankingPresentation.totalContributors - 4;
      },
      (value) => {
        value.comparison.rankingPresentation.privateActors = ["hidden-synthetic-actor"];
      },
      (value) => {
        const row = value.rows.find((entry) => entry.movement.state === "comparable");
        row.movement.delta = value.comparison.rankingPresentation.comparableContributors + 1 - row.rank;
      },
    ]) {
      const copy = structuredClone(document);
      mutate(copy);
      assert.throws(() => validateExport(copy, selected, data.metric), /invalid_rank_comparison/);
    }
  }
});

test("a newly small current or baseline cohort withholds movement after current privacy filtering", async (t) => {
  for (const side of ["current", "previous"]) {
    const h = createRankComparisonHarness();
    t.after(() => h.app.close());
    const initial = await h.app.inject("/api/v1/boards?" + h.params);
    assert.equal(initial.statusCode, 200, initial.body);
    if (side === "current") h.suppressActor(h.actorIds.a);
    else {
      const visible = h.pair.previous.selected.rows.map((row) => row.actorId);
      for (const actorId of visible.slice(4)) h.hideBaselineActor(actorId);
    }
    const response = await h.app.inject({
      url: "/api/v1/boards?" + h.params,
      headers: { "if-none-match": initial.headers.etag },
    });
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.comparison.snapshotId, null);
    assert.equal(Object.hasOwn(data.comparison, "rankingPresentation"), false);
    assert.ok(
      data.rows.every(
        (row) =>
          row.movement.state === "unavailable" && row.movement.reason === "ranking_presentation_cohort_unavailable",
      ),
    );
    assert.equal(data.rankingPresentation.state, side === "current" ? "small_cohort" : "ranked");
    assert.equal(
      data.rows.every((row) => row.rank === null),
      side === "current",
    );
    assert.doesNotThrow(() => board(data, selection(h.params.toString(), { comparison: true })));
    const exported = await h.app.inject(`/api/v1/exports?${h.params}&format=json`);
    assert.equal(exported.statusCode, 200, exported.body);
    assert.deepEqual(
      exported.json().rows.map((row) => [row.actorId, row.rank, row.movement]),
      data.rows.map((row) => [row.actorId, row.rank, row.movement]),
    );
  }
});

test("a board page cannot contain more observed contributors than its recorded complete cohort", async (t) => {
  const h = harness(t, { values: [9, 8, undefined, undefined, undefined] });
  const data = (await read(h, "/api/v1/boards?metric=pr_merged&limit=2")).json();
  const selected = selection("?metric=pr_merged&limit=2");
  assert.doesNotThrow(() => board(data, selected));
  assert.equal(data.rows.length, 2);
  data.totalRows = 1;
  Object.assign(data.rankingPresentation, {
    totalContributors: 1,
    comparableContributors: 1,
    unrankableContributors: 0,
  });
  assert.throws(() => board(data, selected), /invalid_ranking_presentation/);
});

for (const scenario of [
  {
    name: "numeric",
    values: [9, 8, undefined, undefined, undefined],
    counts: { comparableContributors: 1, unrankableContributors: 4 },
  },
  {
    name: "missing-valued",
    values: [undefined, undefined, 9, 8, undefined],
    counts: { comparableContributors: 4, unrankableContributors: 1 },
  },
]) {
  test(`board and serialized JSON/CSV pages cannot exceed the recorded ${scenario.name} subset`, async (t) => {
    const h = harness(t, { values: scenario.values });
    const selected = selection(`?metric=pr_merged&limit=2&snapshot=${snapshot}`);
    const data = (await read(h, `/api/v1/boards?metric=pr_merged&limit=2&snapshot=${snapshot}`)).json();
    assert.equal(data.rows.length, 2);
    const changed = structuredClone(data);
    Object.assign(changed.rankingPresentation, scenario.counts);
    await t.test("board", () => assert.throws(() => board(changed, selected), /invalid_ranking_presentation/));
    for (const format of ["json", "csv"]) {
      const response = await read(h, `/api/v1/exports?metric=pr_merged&limit=2&snapshot=${snapshot}&format=${format}`);
      const original = format === "json" ? response.json() : parseCSVExport(response.body, data.metric, 2);
      validateExport(original, selected, data.metric);
      const invalidReceipt = { ...original.rankingPresentation, ...scenario.counts };
      const encoded = (value) =>
        format === "json" ? JSON.stringify(value) : '"' + JSON.stringify(value).replaceAll('"', '""') + '"';
      const raw = response.body.replaceAll(encoded(original.rankingPresentation), encoded(invalidReceipt));
      assert.notEqual(raw, response.body);
      const invalid = format === "json" ? JSON.parse(raw) : parseCSVExport(raw, data.metric, 2);
      assert.deepEqual(invalid.rows, original.rows);
      await t.test(format, () =>
        assert.throws(() => validateExport(invalid, selected, data.metric), /invalid_ranking_presentation/),
      );
    }
  });
}
