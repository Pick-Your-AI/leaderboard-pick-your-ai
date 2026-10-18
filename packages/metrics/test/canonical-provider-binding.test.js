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

function separateKeys(input) {
  return input.map((event, index) => ({ ...event, dedupeKey: `dedupe:synthetic:separate:${index}` }));
}

test("conflicting node bindings withhold separate groups and partial identities without merging keys", () => {
  const input = separateKeys(
    observations([
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 102 },
      { githubNodeId: "node:synthetic:1" },
      { githubDatabaseId: 101 },
      { githubNodeId: "node:synthetic:unrelated", githubDatabaseId: 201 },
    ]),
  );
  const before = structuredClone(input);
  const result = canonicalizeObservations(input);
  assert.deepEqual(
    result.map((group) => group.state),
    ["ambiguous", "ambiguous", "ambiguous", "ambiguous", "canonical"],
  );
  assert.deepEqual(
    result.map((group) => group.dedupeKey),
    input.map((event) => event.dedupeKey),
  );
  assert.deepEqual(canonicalizeObservations([...input].reverse()), result);
  assert.deepEqual(input, before);
  assert.deepEqual(
    result.flatMap((group) => group.observations),
    input,
  );
});

test("inverse provider conflicts reach node-only and database-only groups", () => {
  const input = separateKeys(
    observations([
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
      { githubNodeId: "node:synthetic:2", githubDatabaseId: 101 },
      { githubNodeId: "node:synthetic:1" },
      { githubNodeId: "node:synthetic:2" },
      { githubDatabaseId: 101 },
    ]),
  );
  assert.ok(canonicalizeObservations(input).every((group) => group.state === "ambiguous"));
});

test("binding conflicts propagate over explicit identifier pairs in any source order", () => {
  const input = separateKeys(
    observations([
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 102 },
      { githubNodeId: "node:synthetic:2", githubDatabaseId: 102 },
      { githubNodeId: "node:synthetic:2", githubDatabaseId: 103 },
      { githubDatabaseId: 103 },
    ]),
  );
  const expected = canonicalizeObservations(input);
  assert.ok(expected.every((group) => group.state === "ambiguous"));
  assert.deepEqual(canonicalizeObservations([input[4], input[2], input[0], input[3], input[1]]), expected);
});

for (const kind of ["bot", "service_account"]) {
  test(`known user/${kind} disagreement cannot certify one canonical actor`, () => {
    const input = observations([
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101, kind: "user" },
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101, kind },
    ]);
    assert.equal(canonicalizeObservations(input)[0].state, "ambiguous");
    assert.ok(canonicalizeObservations(separateKeys(input)).every((group) => group.state === "ambiguous"));
  });
}

test("an unknown-kind bridge cannot conceal conflicting known kinds on partial identities", () => {
  const input = separateKeys(
    observations([
      { githubNodeId: "node:synthetic:1", kind: "user" },
      { githubNodeId: "node:synthetic:1", githubDatabaseId: 101, kind: "unknown" },
      { githubDatabaseId: 101, kind: "bot" },
    ]),
  );
  const result = canonicalizeObservations(input);
  assert.ok(result.every((group) => group.state === "ambiguous"));
  assert.deepEqual(canonicalizeObservations([...input].reverse()), result);
});

for (const kinds of [
  ["user", "unknown"],
  ["unknown", "unknown"],
  ["service_account", "service_account"],
]) {
  test(`consistent ${kinds.join("/")} kinds preserve canonical grouping and distinct keys`, () => {
    const input = observations(
      kinds.map((kind) => ({ githubNodeId: "node:synthetic:1", githubDatabaseId: 101, kind })),
    );
    assert.equal(canonicalizeObservations(input)[0].state, "canonical");
    const separate = canonicalizeObservations(separateKeys(input));
    assert.equal(separate.length, 2);
    assert.ok(separate.every((group) => group.state === "canonical"));
  });
}

test("resolved bindings on an unkeyed observation can withhold keyed conflicts while remaining unknown", () => {
  const input = observations([
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
    { githubNodeId: "node:synthetic:1", githubDatabaseId: 102 },
  ]);
  delete input[1].dedupeKey;
  const result = canonicalizeObservations(input);
  assert.equal(result.find((group) => group.dedupeKey === input[0].dedupeKey).state, "ambiguous");
  const unkeyed = result.find((group) => group.dedupeKey === null);
  assert.equal(unkeyed.state, "unknown");
  assert.deepEqual(unkeyed.observations, [input[1]]);
  assert.deepEqual(unkeyed.observationIds, input[1].observationIds);
});

for (const identityState of ["unresolved", "deleted", "suspended", "unavailable"]) {
  test(`${identityState} identifiers cannot supply a resolved actor binding`, () => {
    const input = separateKeys(
      observations([
        { githubNodeId: "node:synthetic:1", githubDatabaseId: 101 },
        { githubNodeId: "node:synthetic:1", githubDatabaseId: 102, identityState, kind: "bot" },
      ]),
    );
    assert.deepEqual(
      canonicalizeObservations(input).map((group) => group.state),
      ["canonical", "ambiguous"],
    );
  });
}

test("equal text in different provider namespaces does not connect unrelated actors", () => {
  const input = separateKeys(
    observations([
      { githubNodeId: "101", kind: "user" },
      { githubDatabaseId: 101, kind: "bot" },
    ]),
  );
  assert.deepEqual(
    canonicalizeObservations(input).map((group) => group.state),
    ["canonical", "canonical"],
  );
});
