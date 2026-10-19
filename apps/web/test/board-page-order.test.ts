import assert from "node:assert/strict";
import test from "node:test";
import type { Board } from "../src/remote/client.ts";
import {
  boardColumnOrder,
  boardContributorName,
  boardPageOrders,
  orderBoardPage,
} from "../src/remote/board-page-order.ts";

function row(actorId: string, rank: number | null, value?: number): Board["rows"][number] {
  return {
    actorId,
    rank,
    actor: { schemaVersion: "leaderboard/v1", identityState: "unresolved", kind: "unknown", executionMode: "unknown" },
    result: {
      schemaVersion: "leaderboard/v1",
      metricId: "pr_merged",
      state: value === undefined ? "unknown" : value === 0 ? "zero" : "measured",
      ...(value === undefined ? {} : { value }),
      coverage: {
        schemaVersion: "leaderboard/v1",
        state: "complete",
        source: "github_rest",
        scopeId: "synthetic-sort-scope",
        windowStart: "2026-10-01T00:00:00.000Z",
        windowEnd: "2026-10-18T00:00:00.000Z",
        knownStart: "2026-10-01T00:00:00.000Z",
        lastSuccessfulSync: "2026-10-18T00:00:00.000Z",
        sourceWatermark: "2026-10-18T00:00:00.000Z",
        missingPages: 0,
        permissionsMissing: [],
        sourceErrors: [],
      },
    },
    evidenceIds: [`synthetic-proof-${actorId}`],
  };
}
const ids = (rows: ReturnType<typeof orderBoardPage>) => rows.map((entry) => entry.actorId);

test("rank and numeric sorting retain zero, unknown, stable ties and original source ranks", () => {
  const input = [
    row("unknown-1", null),
    row("high", 1, 9),
    row("tie-b", 2, 4),
    row("tie-a", 2, 4),
    row("zero", 3, 0),
    row("unknown-2", null),
  ];
  assert.deepEqual(ids(orderBoardPage(input, "rank_ascending")), [
    "high",
    "tie-b",
    "tie-a",
    "zero",
    "unknown-1",
    "unknown-2",
  ]);
  assert.deepEqual(ids(orderBoardPage(input, "rank_descending")), [
    "zero",
    "tie-b",
    "tie-a",
    "high",
    "unknown-1",
    "unknown-2",
  ]);
  assert.deepEqual(ids(orderBoardPage(input, "value_ascending")), [
    "zero",
    "tie-b",
    "tie-a",
    "high",
    "unknown-1",
    "unknown-2",
  ]);
  assert.deepEqual(ids(orderBoardPage(input, "value_descending")), [
    "high",
    "tie-b",
    "tie-a",
    "zero",
    "unknown-1",
    "unknown-2",
  ]);
  assert.deepEqual(
    input.map((entry) => entry.rank),
    [null, 1, 2, 2, 3, null],
  );
});

test("all orderings conserve every original row object and leave the entire API page immutable", () => {
  const input = [row("z", 2, 1), row("a", 1, 2), row("b", 2, 1)];
  const before = structuredClone(input);
  for (const item of input) {
    Object.freeze(item.actor);
    Object.freeze(item.result.coverage);
    Object.freeze(item.result);
    Object.freeze(item.evidenceIds);
    Object.freeze(item);
  }
  Object.freeze(input);
  for (const { value } of boardPageOrders) {
    const output = orderBoardPage(input, value);
    assert.notEqual(output, input);
    assert.equal(output.length, input.length);
    assert.deepEqual(new Set(output), new Set(input));
    for (const item of output)
      assert.equal(
        item,
        input.find((original) => original.actorId === item.actorId),
      );
  }
  assert.deepEqual(input, before);
  assert.deepEqual(ids(orderBoardPage(input, "api")), ["z", "a", "b"]);
});

test("contributor ordering follows exactly the displayed name and preserves equal-label API order", () => {
  const input = [row("id-z", 1, 1), row("id-b", 1, 1), row("id-a", 1, 1), row("id-c", 1, 1)];
  input[0]!.actor.displayName = "Beta";
  input[0]!.actor.login = "aaa-unused";
  input[1]!.actor.login = "alpha";
  input[2]!.actor.displayName = "ALPHA";
  assert.equal(boardContributorName(input[0]!), "Beta");
  assert.equal(boardContributorName(input[3]!), "id-c");
  assert.deepEqual(ids(orderBoardPage(input, "contributor_ascending")), ["id-b", "id-a", "id-z", "id-c"]);
  assert.deepEqual(ids(orderBoardPage(input, "contributor_descending")), ["id-c", "id-z", "id-b", "id-a"]);
});

test("wide and fractional published numbers sort numerically without rounding or text conversion", () => {
  const input = [
    row("wide", null, Number.MAX_VALUE),
    row("fraction", null, 0.00001),
    row("ten", null, 10),
    row("two", null, 2),
  ];
  assert.deepEqual(ids(orderBoardPage(input, "value_ascending")), ["fraction", "two", "ten", "wide"]);
  assert.deepEqual(ids(orderBoardPage(input, "value_descending")), ["wide", "ten", "two", "fraction"]);
  assert.equal(input[0]!.result.value, Number.MAX_VALUE);
});

test("empty and single-row pages do not add placeholders or derive a rank", () => {
  for (const { value } of boardPageOrders) {
    assert.deepEqual(orderBoardPage([], value), []);
    const input = [row("unknown", null)];
    assert.deepEqual(orderBoardPage(input, value), input);
  }
});

test("the semantic column state identifies only the active display ordering", () => {
  for (const { value } of boardPageOrders) {
    const active = (["rank", "contributor", "value"] as const).map((column) => boardColumnOrder(value, column));
    assert.equal(active.filter((entry) => entry !== "none").length, value === "api" ? 0 : 1);
    if (value !== "api") assert.ok(active.includes(value.endsWith("ascending") ? "ascending" : "descending"));
  }
});
