import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGithubObservation, triageMetadataNormalizationVersion } from "../dist/index.js";

// Synthetic verified envelopes test normalization semantics, not installed
// webhook permissions, source visibility discovery, or human activity.
const fixture = JSON.parse(await readFile(new URL("./fixtures/engineering.json", import.meta.url), "utf8"));
const cases = [
  ["labeled", "label", "labels_applied"],
  ["unlabeled", "label", "items_triaged"],
  ["assigned", "assignee", "assignments_coordinated"],
  ["unassigned", "assignee", "assignments_coordinated"],
  ["milestoned", "milestone", "milestones_curated"],
  ["demilestoned", "milestone", "milestones_curated"],
  ["issue_typed", "issue_type", "items_triaged"],
  ["issue_untyped", "issue_type", "items_triaged"],
  ["label_created", "label", "label_taxonomy"],
  ["label_edited", "label", "label_taxonomy"],
  ["label_deleted", "label", "label_taxonomy"],
  ["label_archived", "label", "label_taxonomy"],
  ["label_unarchived", "label", "label_taxonomy"],
  ["milestone_created", "milestone", "milestone_definitions"],
  ["milestone_edited", "milestone", "milestone_definitions"],
  ["milestone_closed", "milestone", "milestone_definitions"],
  ["milestone_reopened", "milestone", "milestone_definitions"],
  ["milestone_deleted", "milestone", "milestone_definitions"],
  ["pinned", null, "public_moderation"],
  ["unpinned", null, "public_moderation"],
  ["locked", null, "public_moderation"],
  ["unlocked", null, "public_moderation"],
];
let sequence = 0;
function envelope([action, kind], change) {
  const id = `synthetic-triage-json-${++sequence}`;
  const target =
    kind === "assignee"
      ? fixture.merger
      : {
          id: 90,
          node_id: `SYNTHETIC_${kind}_90`,
          html_url: `https://github.com/synthetic-owner/repository/${kind === "label" ? "labels/bug" : "milestone/1"}`,
        };
  return {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_webhook", revision: id, eventId: id, isSynthetic: true },
    family: "triage",
    action,
    occurredAt: "2026-10-07T10:00:00Z",
    observedAt: "2026-10-10T00:00:00Z",
    payload: { issue: fixture.issue, sender: fixture.merger, ...(kind ? { [kind]: target } : {}), change },
  };
}
function observation(row, change) {
  return normalizeGithubObservation(envelope(row, change));
}
function assertNoop(result) {
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.observations.length, 1);
  assert.ok(result.reasons.includes("no_op_metadata_change"));
}
function expectedMetrics(metric) {
  return ["labels_applied", "assignments_coordinated", "milestones_curated"].includes(metric)
    ? [metric, "items_triaged"].sort()
    : [metric];
}

test("triage object-member reordering emits no primary or derived fact for every supported action", async (t) => {
  for (const row of cases)
    await t.test(row[0], () => {
      assertNoop(
        observation(row, {
          before: {
            name: "same",
            nested: { enabled: true, metadata: { color: "blue", count: 2 } },
            list: [
              { name: "first", value: null },
              { value: 3, name: "second" },
            ],
          },
          after: {
            list: [
              { value: null, name: "first" },
              { name: "second", value: 3 },
            ],
            nested: { metadata: { count: 2, color: "blue" }, enabled: true },
            name: "same",
          },
        }),
      );
    });
});

test("real triage value changes retain every supported action's primary and derived facts", async (t) => {
  for (const row of cases)
    await t.test(row[0], () => {
      const result = observation(row, { before: { nested: { value: "old" } }, after: { nested: { value: "new" } } });
      assert.deepEqual(result.facts.map((fact) => fact.metricId).sort(), expectedMetrics(row[2]));
      assert.equal(result.reasons.includes("no_op_metadata_change"), false);
      assert.ok(result.facts.every((fact) => fact.actorId === String(fixture.merger.id) && fact.role === "triager"));
    });
});

test("triage metadata preserves array order, JSON scalar types, member presence, and literal strings", async (t) => {
  const row = cases.find(([action]) => action === "label_edited");
  for (const [name, before, after] of [
    ["array order", { values: [1, 2] }, { values: [2, 1] }],
    ["scalar type", { value: 1 }, { value: "1" }],
    ["null member", { name: "same" }, { name: "same", description: null }],
    ["literal string whitespace", { name: "same" }, { name: " same " }],
    ["missing versus null value", undefined, null],
    ["changed nested value", { outer: { count: 1, name: "same" } }, { outer: { name: "same", count: 2 } }],
  ])
    await t.test(name, () => {
      const result = observation(row, { before, after });
      assert.deepEqual(
        result.facts.map((fact) => fact.metricId),
        ["label_taxonomy"],
      );
      assert.equal(result.reasons.includes("no_op_metadata_change"), false);
    });
});

test("triage retains existing JSON projection semantics for unchanged metadata", async (t) => {
  const row = cases.find(([action]) => action === "milestone_edited");
  for (const [name, before, after] of [
    ["same scalar", "same", "same"],
    ["same null", null, null],
    ["both absent", undefined, undefined],
    ["omitted undefined member", { name: "same", omitted: undefined }, { name: "same" }],
    ["array undefined projection", [undefined], [null]],
    ["nonfinite projection", NaN, null],
  ])
    await t.test(name, () => assertNoop(observation(row, { before, after })));
});

test("triage compares each metadata operand's JSON projection once", () => {
  const calls = { before: 0, after: 0 };
  const result = observation(
    cases.find(([action]) => action === "label_edited"),
    {
      before: {
        toJSON() {
          calls.before += 1;
          return { name: "same", color: "blue" };
        },
      },
      after: {
        toJSON() {
          calls.after += 1;
          return { color: "blue", name: "same" };
        },
      },
    },
  );
  assert.deepEqual(calls, { before: 1, after: 1 });
  assertNoop(result);
});

test("triage keeps JSON serialization failures observable", async (t) => {
  for (const action of ["label_edited", "milestone_edited"])
    await t.test(action, () => {
      const row = cases.find(([candidate]) => candidate === action);
      const cyclic = {};
      cyclic.self = cyclic;
      assert.throws(() => observation(row, { before: cyclic, after: {} }), /circular/i);
      assert.throws(() => observation(row, { before: {}, after: 1n }), /BigInt/i);
    });
});

test("triage exports the metadata JSON-value normalization generation through the package index", () => {
  assert.equal(triageMetadataNormalizationVersion, "triage-metadata-json-values/v1");
});

test("triage no-ops retain the exact raw observation without evidence or private metadata", () => {
  const row = cases.find(([action]) => action === "label_edited");
  const input = envelope(row, {
    before: { name: "SYNTHETIC_PRIVATE_TRIAGE_VALUE", color: "blue" },
    after: { color: "blue", name: "SYNTHETIC_PRIVATE_TRIAGE_VALUE" },
  });
  const original = structuredClone(input);
  const noop = normalizeGithubObservation(input);
  const changed = normalizeGithubObservation({
    ...input,
    payload: {
      ...input.payload,
      change: { before: "SYNTHETIC_PRIVATE_TRIAGE_BEFORE", after: "SYNTHETIC_PRIVATE_TRIAGE_AFTER" },
    },
  });
  assertNoop(noop);
  assert.deepEqual(
    changed.facts.map((fact) => fact.metricId),
    ["label_taxonomy"],
  );
  assert.deepEqual(noop.observations, changed.observations);
  assert.deepEqual(noop.actors, changed.actors);
  assert.equal(noop.isSynthetic, true);
  assert.doesNotMatch(JSON.stringify([noop, changed]), /SYNTHETIC_PRIVATE_TRIAGE_/);
  assert.deepEqual(input, original);
});

test("triage preserves metadata getter and serialization order with root toJSON bindings", () => {
  const trace = [];
  const before = {
    toJSON(key) {
      assert.equal(key, "");
      assert.equal(this, before);
      trace.push("serialize-before");
      return { name: "same", color: "blue" };
    },
  };
  const after = {
    toJSON(key) {
      assert.equal(key, "");
      assert.equal(this, after);
      trace.push("serialize-after");
      return { color: "blue", name: "same" };
    },
  };
  const change = {
    get before() {
      trace.push("get-before");
      return before;
    },
    get after() {
      trace.push("get-after");
      return after;
    },
  };
  const input = envelope(
    cases.find(([action]) => action === "label_edited"),
    change,
  );
  Object.defineProperty(input.payload, "change", {
    enumerable: true,
    get() {
      trace.push("get-change");
      return change;
    },
  });
  const output = normalizeGithubObservation(input);
  assert.deepEqual(trace, [
    "get-change",
    "get-change",
    "get-before",
    "serialize-before",
    "get-change",
    "get-after",
    "serialize-after",
  ]);
  assertNoop(output);
});

test("triage reads after only after a before serializer replaces its value", () => {
  const trace = [];
  const change = {
    before: {
      toJSON() {
        trace.push("before");
        change.after = {
          toJSON() {
            trace.push("replacement-after");
            return { value: "changed" };
          },
        };
        return { value: "same" };
      },
    },
    after: {
      toJSON() {
        trace.push("superseded-after");
        return { value: "same" };
      },
    },
  };
  const output = observation(
    cases.find(([action]) => action === "label_edited"),
    change,
  );
  assert.deepEqual(trace, ["before", "replacement-after"]);
  assert.deepEqual(
    output.facts.map((fact) => fact.metricId),
    ["label_taxonomy"],
  );
  assert.equal(output.evidence.length, 1);
  assert.equal(output.reasons.includes("no_op_metadata_change"), false);
});

test("triage propagates the first getter or serialization error without reading later operands", async (t) => {
  const steps = ["get-before", "serialize-before", "get-after", "serialize-after"];
  for (const stage of steps) {
    await t.test(stage, () => {
      const trace = [];
      const sentinel = new Error("synthetic-" + stage);
      const record = (step) => {
        trace.push(step);
        if (step === stage) throw sentinel;
      };
      const change = {
        get before() {
          record("get-before");
          return {
            toJSON() {
              record("serialize-before");
              return { value: "same" };
            },
          };
        },
        get after() {
          record("get-after");
          return {
            toJSON() {
              record("serialize-after");
              return { value: "same" };
            },
          };
        },
      };
      assert.throws(
        () =>
          observation(
            cases.find(([action]) => action === "milestone_edited"),
            change,
          ),
        (error) => error === sentinel,
      );
      assert.deepEqual(trace, steps.slice(0, steps.indexOf(stage) + 1));
    });
  }
});

test("triage serializes aliased stateful operands once each instead of using reference equality", () => {
  let calls = 0;
  const value = {
    toJSON(key) {
      assert.equal(key, "");
      calls += 1;
      return { value: calls };
    },
  };
  const output = observation(
    cases.find(([action]) => action === "label_edited"),
    {
      before: value,
      after: value,
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    output.facts.map((fact) => fact.metricId),
    ["label_taxonomy"],
  );
  assert.equal(output.evidence.length, 1);
  assert.equal(output.reasons.includes("no_op_metadata_change"), false);
});

test("triage serializes both undefined projections once and retains the existing no-op", () => {
  const calls = [];
  const output = observation(
    cases.find(([action]) => action === "milestone_edited"),
    {
      before: {
        toJSON() {
          calls.push("before");
          return undefined;
        },
      },
      after: {
        toJSON() {
          calls.push("after");
          return undefined;
        },
      },
    },
  );
  assert.deepEqual(calls, ["before", "after"]);
  assertNoop(output);
});

test("triage missing and nonobject change envelopes retain their existing ordinary action", async (t) => {
  for (const [name, change] of [
    ["missing", undefined],
    ["explicit undefined", undefined],
    ["null", null],
    ["boolean", false],
    ["number", 0],
    ["string", "synthetic"],
    ["array", []],
  ]) {
    await t.test(name, () => {
      const input = envelope(
        cases.find(([action]) => action === "labeled"),
        change,
      );
      if (name === "missing") delete input.payload.change;
      const original = structuredClone(input);
      const output = normalizeGithubObservation(input);
      assert.deepEqual(output.facts.map((fact) => fact.metricId).sort(), ["items_triaged", "labels_applied"]);
      assert.equal(output.evidence.length, 2);
      assert.equal(output.observations.length, 1);
      assert.ok(output.facts.every((fact) => fact.actorId === String(fixture.merger.id) && fact.state === "observed"));
      assert.equal(output.reasons.includes("no_op_metadata_change"), false);
      assert.deepEqual(input, original);
    });
  }
});

test("triage an empty change object retains its existing two-absent-values no-op", () => {
  assertNoop(
    observation(
      cases.find(([action]) => action === "label_edited"),
      {},
    ),
  );
});
