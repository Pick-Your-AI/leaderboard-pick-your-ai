import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceEventSchema } from "@pick-your-ai/contracts";
import { canonicalizeObservations } from "../dist/index.js";

const fixture = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/contracts/v1/observation-pair.json", import.meta.url), "utf8"),
);

function observations(actors) {
  return actors.map((actor, index) =>
    sourceEventSchema.parse({
      ...structuredClone(fixture[index % fixture.length]),
      eventId: `event:synthetic:${index}`,
      observationIds: [`observation:synthetic:${index}`],
      actor: {
        schemaVersion: "leaderboard/v1",
        identityState: "resolved",
        kind: "user",
        executionMode: "unknown",
        ...actor,
      },
    }),
  );
}

test("matching node IDs cannot hide contradictory known database IDs", () => {
  const input = observations([
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 102 },
  ]);
  const [result] = canonicalizeObservations(input);
  assert.equal(result.state, "ambiguous");
  assert.deepEqual(result.observations, input);
  assert.deepEqual(
    result.observationIds,
    input.flatMap((event) => event.observationIds),
  );
});

test("an observation without a database ID cannot conceal a conflicting pair", () => {
  const input = observations([
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
    { githubNodeId: "node:synthetic:1" },
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 102 },
  ]);
  const expected = canonicalizeObservations(input);
  assert.equal(expected[0].state, "ambiguous");
  assert.deepEqual(canonicalizeObservations([input[2], input[0], input[1]]), expected);
  assert.deepEqual(canonicalizeObservations([...input].reverse()), expected);
});

test("node and database identifier namespaces are not interchangeable", () => {
  const input = observations([{ githubNodeId: "101", githubDatabaseId: 101 }, { githubDatabaseId: 101 }]);
  assert.equal(canonicalizeObservations(input)[0].state, "ambiguous");
  assert.equal(canonicalizeObservations([...input].reverse())[0].state, "ambiguous");
});

for (const [name, actors] of [
  [
    "same verified node and database IDs",
    [
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
    ],
  ],
  [
    "same node with a missing optional database ID",
    [{ githubNodeId: "node:synthetic:1", githubDatabaseId: 101 }, { githubNodeId: "node:synthetic:1" }],
  ],
  ["node-only observations", [{ githubNodeId: "node:synthetic:1" }, { githubNodeId: "node:synthetic:1" }]],
  ["database-only observations", [{ githubDatabaseId: 101 }, { githubDatabaseId: 101 }]],
  [
    "changed display labels on the same verified source identity",
    [
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101, login: "synthetic-old" },
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101, login: "synthetic-new" },
    ],
  ],
]) {
  test(`${name} retain their canonical group`, () => {
    const input = observations(actors);
    const [result] = canonicalizeObservations(input);
    assert.equal(result.state, "canonical");
    assert.deepEqual(result.observations, input);
    assert.equal(result.observationIds.length, 2);
  });
}

for (const identityState of ["unresolved", "deleted", "suspended", "unavailable"]) {
  test(`${identityState} actor remains ambiguous despite supplied provider identifiers`, () => {
    const input = observations([
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
      { identityState, githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
    ]);
    assert.equal(canonicalizeObservations(input)[0].state, "ambiguous");
  });
}

test("one database ID cannot reconcile different nodes or matching display names", () => {
  const input = observations([
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 101, login: "same-label" },
    { githubNodeId: "node:synthetic:2", githubDatabaseId: 101, login: "same-label" },
  ]);
  assert.equal(canonicalizeObservations(input)[0].state, "ambiguous");
});

test("conflicting groups preserve unrelated keys, unkeyed unknowns and original inputs", () => {
  const input = observations([
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 102 },
    { githubNodeId: "node:synthetic:2", githubDatabaseId: 201 },
    { githubNodeId: "node:synthetic:2", githubDatabaseId: 201 },
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
  ]);
  input[2].dedupeKey = input[3].dedupeKey = "dedupe:synthetic:unrelated";
  delete input[4].dedupeKey;
  const before = structuredClone(input);
  const results = canonicalizeObservations(input);
  assert.equal(results.length, 3);
  assert.equal(results.find((row) => row.dedupeKey === input[0].dedupeKey).state, "ambiguous");
  assert.equal(results.find((row) => row.dedupeKey === input[2].dedupeKey).state, "canonical");
  assert.equal(results.find((row) => row.dedupeKey === null).state, "unknown");
  assert.deepEqual(input, before);
  assert.equal(
    results.reduce((sum, row) => sum + row.observations.length, 0),
    input.length,
  );
});
