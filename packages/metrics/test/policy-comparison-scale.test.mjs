import assert from "node:assert/strict";
import test from "node:test";
import { comparePolicies, getMetricDefinition } from "../dist/index.js";

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const at = "2026-10-05T00:00:00Z";
const pad = (value) => String(value).padStart(5, "0");
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const scope = freeze({
  timezone: "UTC",
  from,
  to,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
});
const policy = (patch = {}) =>
  freeze({
    metricId: "pr_merged",
    version: "synthetic-comparison-policy/v1",
    definitionVersion: "synthetic-comparison-definition/v1",
    unit: getMetricDefinition(patch.metricId ?? "pr_merged").definition.unit,
    aggregation: "count",
    dateBasis: "acceptedAt",
    rankedStates: ["qualified"],
    roles: ["author"],
    groupBy: "canonical",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: true,
    ...patch,
  });
const actor = (id, login = "synthetic-" + id) => ({ id, login, kind: "user", publicState: "visible" });
const fact = (id, actorId, patch = {}) => ({
  id,
  actorId,
  canonicalKey: "synthetic-action-" + id,
  metricId: "pr_merged",
  artifactId: "synthetic-artifact-" + id,
  repoId: "synthetic-repo",
  role: "author",
  state: "qualified",
  occurredAt: at,
  acceptedAt: at,
  observedAt: at,
  revision: 0,
  correctionReceipt: null,
  acceptanceReceipt: "synthetic-independent-acceptance",
  acceptedBy: "synthetic-independent-reviewer",
  subjectActorId: "synthetic-other-subject",
  eventContext: null,
  currentContext: null,
  ...patch,
});
const input = (actors, facts) =>
  freeze({
    datasetId: "synthetic-policy-comparison-dataset",
    cutoff: to,
    backfillRevision: "synthetic-policy-comparison-history/v1",
    repositoryIds: ["synthetic-repo"],
    actors,
    facts,
    coverage: [
      {
        schemaVersion: "leaderboard/v1",
        state: "complete",
        source: "github_rest",
        scopeId: "synthetic-repo",
        windowStart: from,
        windowEnd: to,
        knownStart: from,
        lastSuccessfulSync: to,
        sourceWatermark: to,
        missingPages: 0,
        permissionsMissing: [],
        sourceErrors: [],
      },
    ],
  });

// Observe the actual generated-row and evidence-array reads, including those
// made by indexed implementations. No timers or production instrumentation.
// The call is synchronous: restore the prototype and all row descriptors before
// returning or throwing, so assertions and other tests see ordinary results.
function lookupReads(run) {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push");
  const originalPush = descriptor.value;
  const observed = [];
  const seen = new WeakSet();
  let actorReads = 0;
  let evidenceReads = 0;
  Object.defineProperty(Array.prototype, "push", {
    ...descriptor,
    value: function (...items) {
      for (const row of items) {
        if (
          row === null ||
          typeof row !== "object" ||
          seen.has(row) ||
          !Object.hasOwn(row, "actorId") ||
          !Object.hasOwn(row, "rank") ||
          !Object.hasOwn(row, "tied") ||
          !Object.hasOwn(row, "sampleCount") ||
          !Array.isArray(row.pendingEvidence) ||
          !Array.isArray(row.evidenceIds)
        )
          continue;
        seen.add(row);
        const actorDescriptor = Object.getOwnPropertyDescriptor(row, "actorId");
        const evidenceDescriptor = Object.getOwnPropertyDescriptor(row, "evidenceIds");
        Reflect.apply(originalPush, observed, [{ row, actorDescriptor, evidenceDescriptor }]);
        Object.defineProperty(row, "actorId", {
          configurable: actorDescriptor.configurable,
          enumerable: actorDescriptor.enumerable,
          get() {
            actorReads++;
            return actorDescriptor.value;
          },
        });
        row.evidenceIds = new Proxy(evidenceDescriptor.value, {
          get(target, property, receiver) {
            if (typeof property === "string" && /^(0|[1-9][0-9]*)$/.test(property)) evidenceReads++;
            return Reflect.get(target, property, receiver);
          },
        });
      }
      return Reflect.apply(originalPush, this, items);
    },
  });
  try {
    const result = run();
    return { result, actorReads, evidenceReads, observedRows: observed.length };
  } finally {
    Object.defineProperty(Array.prototype, "push", descriptor);
    for (const { row, actorDescriptor, evidenceDescriptor } of observed) {
      Object.defineProperty(row, "actorId", actorDescriptor);
      Object.defineProperty(row, "evidenceIds", evidenceDescriptor);
    }
  }
}

test("10,000-contributor policy comparison preserves every change with bounded row reads", (t) => {
  const size = 10_000;
  const ids = Array.from({ length: size }, (_, index) => "actor-" + pad(index));
  const frozen = input(
    ids.map((id, index) => actor(id, "synthetic-" + pad(size - index))),
    ids.flatMap((id, index) =>
      ["a", "b"].map((suffix) =>
        fact("synthetic-evidence-" + pad(index) + "-" + suffix, id, { artifactId: "synthetic-artifact-" + index }),
      ),
    ),
  );
  const before = policy();
  const after = policy({ version: "synthetic-comparison-policy/v2", groupBy: "actor_artifact" });
  const counted = lookupReads(() => comparePolicies(frozen, before, after, scope));
  const { result } = counted;
  assert.equal(counted.observedRows, 2 * size, "instrumentation must observe both complete aggregate row sets");
  assert.equal(result.before.rows.length, size);
  assert.equal(result.after.rows.length, size);
  assert.equal(result.changes.length, size);
  for (let index = 0; index < size; index++) {
    const suffix = pad(index);
    assert.deepEqual(result.changes[index], {
      actorId: ids[index],
      beforeValue: 2,
      afterValue: 1,
      beforeRank: 1,
      afterRank: 1,
      included: [],
      excluded: ["synthetic-evidence-" + suffix + "-b"],
    });
    // Aggregate login order is deliberately the reverse of change actor order.
    for (const [aggregate, value, endings] of [
      [result.before, 2, ["a", "b"]],
      [result.after, 1, ["a"]],
    ]) {
      const row = aggregate.rows[size - index - 1];
      assert.equal(row.actorId, ids[index]);
      assert.equal(row.value, value);
      assert.equal(row.rank, 1);
      assert.equal(row.tied, true);
      assert.equal(row.state, "measured");
      assert.deepEqual(
        row.evidenceIds,
        endings.map((ending) => "synthetic-evidence-" + suffix + "-" + ending),
      );
    }
  }
  assert.equal(result.datasetId, frozen.datasetId);
  assert.equal(result.cutoff, frozen.cutoff);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.releaseNotesRequired, true);
  assert.equal(result.before.publicEnabled, false);
  assert.equal(result.after.publicEnabled, false);
  assert.equal(result.before.policyVersion, before.version);
  assert.equal(result.after.policyVersion, after.version);
  t.diagnostic(
    "Generated actor/evidence reads for " + size + " contributors: " + counted.actorReads + "/" + counted.evidenceReads,
  );
  assert.ok(
    counted.actorReads > 0 && counted.actorReads <= size * 30,
    "actor reads exceeded linear budget: " + counted.actorReads,
  );
  assert.ok(
    counted.evidenceReads > 0 && counted.evidenceReads <= size * 30,
    "evidence reads exceeded linear budget: " + counted.evidenceReads,
  );
});

test("one contributor's 4,000 evidence records compare with bounded membership reads", (t) => {
  const size = 2_000;
  const facts = Array.from({ length: size }, (_, index) =>
    ["a", "b"].map((suffix) =>
      fact("synthetic-evidence-" + pad(index) + "-" + suffix, "one", { artifactId: "synthetic-artifact-" + index }),
    ),
  ).flat();
  const frozen = input([actor("one")], facts);
  const before = policy();
  const after = policy({ version: "synthetic-comparison-policy/v2", groupBy: "actor_artifact" });
  const counted = lookupReads(() => comparePolicies(frozen, before, after, scope));
  assert.equal(counted.observedRows, 2, "instrumentation must observe both complete aggregate row sets");
  assert.deepEqual(
    counted.result.before.rows[0].evidenceIds,
    facts.map((entry) => entry.id),
  );
  assert.deepEqual(
    counted.result.after.rows[0].evidenceIds,
    facts.filter((_, index) => index % 2 === 0).map((entry) => entry.id),
  );
  assert.deepEqual(counted.result.changes, [
    {
      actorId: "one",
      beforeValue: size * 2,
      afterValue: size,
      beforeRank: 1,
      afterRank: 1,
      included: [],
      excluded: facts.filter((_, index) => index % 2 === 1).map((entry) => entry.id),
    },
  ]);
  t.diagnostic(
    "Generated actor/evidence reads for " +
      size * 2 +
      " evidence records: " +
      counted.actorReads +
      "/" +
      counted.evidenceReads,
  );
  assert.ok(
    counted.actorReads > 0 && counted.actorReads <= size * 30,
    "actor reads exceeded linear budget: " + counted.actorReads,
  );
  assert.ok(
    counted.evidenceReads > 0 && counted.evidenceReads <= size * 30,
    "evidence reads exceeded linear budget: " + counted.evidenceReads,
  );
});

test("policy differences preserve zeroes, unknowns, one-sided evidence and pending-only omission", () => {
  const facts = [
    fact("gone", "a-gone", { quantity: 5 }),
    fact("new", "b-new", { quantity: 4, role: "reviewer" }),
    fact("shared-before", "c-shared", { quantity: 7 }),
    fact("shared-after", "c-shared", { quantity: 7, role: "reviewer" }),
    fact("zero", "constructor", { quantity: 0 }),
    fact("unknown", "__proto__"),
    fact("pending", "z-pending", { state: "pending", acceptedAt: null }),
  ].map((entry) => ({ ...entry, metricId: "pr_lines_changed" }));
  const ids = ["a-gone", "b-new", "c-shared", "constructor", "__proto__", "z-pending"];
  const frozen = input(
    ids.map((id) => actor(id)),
    facts,
  );
  const before = policy({ metricId: "pr_lines_changed", aggregation: "sum" });
  const after = policy({ ...before, version: "synthetic-comparison-policy/v2", roles: ["reviewer"] });
  const result = comparePolicies(frozen, before, after, scope);
  assert.deepEqual(result.changes, [
    {
      actorId: "__proto__",
      beforeValue: null,
      afterValue: null,
      beforeRank: null,
      afterRank: null,
      included: [],
      excluded: ["unknown"],
    },
    {
      actorId: "a-gone",
      beforeValue: 5,
      afterValue: null,
      beforeRank: 2,
      afterRank: null,
      included: [],
      excluded: ["gone"],
    },
    {
      actorId: "b-new",
      beforeValue: null,
      afterValue: 4,
      beforeRank: null,
      afterRank: 2,
      included: ["new"],
      excluded: [],
    },
    {
      actorId: "c-shared",
      beforeValue: 7,
      afterValue: 7,
      beforeRank: 1,
      afterRank: 1,
      included: ["shared-after"],
      excluded: ["shared-before"],
    },
    {
      actorId: "constructor",
      beforeValue: 0,
      afterValue: null,
      beforeRank: 3,
      afterRank: null,
      included: [],
      excluded: ["zero"],
    },
  ]);
  assert.ok(result.before.rows.some((row) => row.actorId === "z-pending" && row.pending === 1 && row.value === null));
  assert.ok(!result.after.rows.some((row) => row.actorId === "z-pending"));
  assert.ok(!result.changes.some((row) => row.actorId === "z-pending"));
  assert.deepEqual(
    comparePolicies(input([...frozen.actors].reverse(), [...facts].reverse()), before, after, scope),
    result,
  );
  const rollback = comparePolicies(frozen, after, before, scope);
  assert.deepEqual(rollback.before, result.after);
  assert.deepEqual(rollback.after, result.before);
  assert.deepEqual(
    rollback.changes,
    result.changes.map((row) => ({
      actorId: row.actorId,
      beforeValue: row.afterValue,
      afterValue: row.beforeValue,
      beforeRank: row.afterRank,
      afterRank: row.beforeRank,
      included: row.excluded,
      excluded: row.included,
    })),
  );
  assert.deepEqual(
    comparePolicies(frozen, before, policy({ ...before, version: "synthetic-comparison-policy/v3" }), scope).changes,
    [],
  );
  assert.throws(
    () => comparePolicies(frozen, before, { ...after, version: before.version }, scope),
    /new policy version/,
  );
  assert.throws(() => comparePolicies(frozen, before, policy(), scope), /same metric/);
});

test("regrouping preserves changes caused only by another contributor's dense rank", () => {
  const ids = ["a", "b", "c"];
  const facts = ids.flatMap((id, index) =>
    Array.from({ length: 4 - index }, (_, n) =>
      fact(id + n, id, {
        artifactId: id === "a" ? "synthetic-same-artifact" : "synthetic-distinct-" + id + n,
      }),
    ),
  );
  const before = policy();
  const after = policy({ version: "synthetic-comparison-policy/v2", groupBy: "actor_artifact" });
  const result = comparePolicies(
    input(
      ids.map((id) => actor(id)),
      facts,
    ),
    before,
    after,
    scope,
  );
  assert.deepEqual(result.changes, [
    {
      actorId: "a",
      beforeValue: 4,
      afterValue: 1,
      beforeRank: 1,
      afterRank: 3,
      included: [],
      excluded: ["a1", "a2", "a3"],
    },
    { actorId: "b", beforeValue: 3, afterValue: 3, beforeRank: 2, afterRank: 1, included: [], excluded: [] },
    { actorId: "c", beforeValue: 2, afterValue: 2, beforeRank: 3, afterRank: 2, included: [], excluded: [] },
  ]);
});
