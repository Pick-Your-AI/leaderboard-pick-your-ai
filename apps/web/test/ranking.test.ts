import assert from "node:assert/strict";
import test from "node:test";
import { cutWithTies, denseRank, formatRank } from "../src/lib/ranking.ts";

const rows = [
  { id: "d", value: 3 },
  { id: "a", value: 9 },
  { id: "c", value: 5 },
  { id: "b", value: 5 },
  { id: "e", value: 1 },
];

test("dense ranks share a rank and skip nothing", () => {
  const ranked = denseRank(rows, (row) => row.value, (row) => row.id);
  assert.deepEqual(ranked.map((entry) => `${entry.item.id}:${formatRank(entry)}`), ["a:1", "b:=2", "c:=2", "d:3", "e:4"]);
});

test("tie order is a stable key with no rank effect", () => {
  const reversed = denseRank([...rows].reverse(), (row) => row.value, (row) => row.id);
  assert.deepEqual(reversed.map((entry) => entry.item.id), ["a", "b", "c", "d", "e"]);
});

test("a top-N cut never splits a tie", () => {
  const ranked = denseRank(rows, (row) => row.value, (row) => row.id);
  const { shown, remaining } = cutWithTies(ranked, 2);
  assert.deepEqual(shown.map((entry) => entry.item.id), ["a", "b", "c"]);
  assert.equal(remaining, 2);
  assert.equal(cutWithTies(ranked, 10).remaining, 0);
});
