import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlStore } from "../src/store.mjs";
import { PolicyComparisonStore, comparisonHash } from "../src/policy-comparison.mjs";
import * as metrics from "../../../packages/metrics/dist/index.js";

// Synthetic source facts and host authorization; no live source or policy grant.
const cutoff = "2026-10-18T00:00:00.000Z";
const now = Date.parse(cutoff);
const policy = {
  metricId: "issues_opened",
  version: "synthetic-policy/v1",
  definitionVersion: "candidate-0.1.1",
  unit: metrics.getMetricDefinition("issues_opened").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["reporter"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
const fact = (id, patch = {}) => ({
  id,
  canonicalKey: `synthetic-action-${id}`,
  metricId: policy.metricId,
  actorId: "101",
  artifactId: `synthetic-artifact-${id}`,
  repoId: "2",
  role: "reporter",
  state: "observed",
  occurredAt: "2026-10-05T00:00:00.000Z",
  acceptedAt: null,
  observedAt: "2026-10-06T00:00:00.000Z",
  revision: 0,
  correctionReceipt: null,
  acceptanceReceipt: null,
  acceptedBy: null,
  subjectActorId: null,
  eventContext: { projects: [], workstreams: [] },
  currentContext: { projects: [], workstreams: [] },
  ...patch,
});

function captureInput(count) {
  const corrections = Array.from({ length: count }, (_, index) =>
    fact(`corrected-${index}`, {
      revision: 1,
      correctionReceipt: `synthetic-reviewed-${index}`,
      state: "excluded",
    }),
  );
  return {
    input: {
      datasetId: "synthetic-capture",
      cutoff,
      backfillRevision: "synthetic-revision",
      repositoryIds: ["2"],
      actors: [{ id: "101", login: "synthetic-101", kind: "user", publicState: "visible" }],
      facts: [
        ...corrections.map((entry) => fact(entry.id)),
        ...corrections,
        ...Array.from({ length: count }, (_, index) => fact(`visible-${index}`)),
      ],
      coverage: [
        {
          schemaVersion: "leaderboard/v1",
          state: "complete",
          source: "github_rest",
          scopeId: "2",
          windowStart: "2026-10-01T00:00:00.000Z",
          windowEnd: cutoff,
          knownStart: "2026-10-01T00:00:00.000Z",
          lastSuccessfulSync: cutoff,
          sourceWatermark: cutoff,
          missingPages: 0,
          permissionsMissing: [],
          sourceErrors: [],
        },
      ],
    },
    scope: {
      timezone: "UTC",
      from: "2026-10-01T00:00:00.000Z",
      to: cutoff,
      repos: ["2"],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
    policies: [policy],
    snapshot: { snapshotId: "synthetic-snapshot", revision: 1 },
    authorization: {
      configurationHash: "synthetic-config",
      controlsConfigurationRevision: 0,
      dataMode: "synthetic",
      sources: [{ repositoryId: "2", generation: "0" }],
    },
  };
}

function database(work) {
  const directory = mkdtempSync(join(tmpdir(), "policy-capture-corrections-"));
  const filename = join(directory, "controls.sqlite");
  let store = new ControlStore(filename);
  let comparisons = new PolicyComparisonStore(store, metrics, { now: () => now });
  const fixture = {
    capture: (input) => store.transaction((state) => comparisons.capture(state, input)),
    read: (id) => comparisons.input(id),
    reopen: () => {
      store.close();
      store = new ControlStore(filename);
      comparisons = new PolicyComparisonStore(store, metrics, { now: () => now });
    },
  };
  try {
    return work(fixture);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  }
}

test("correction capture traverses audit and row evidence linearly as the corrected input doubles", (t) => {
  const measured = [];
  for (const count of [128, 256]) {
    database(({ capture, read, reopen }) => {
      const input = captureInput(count);
      const aggregate = metrics.aggregateMetric(input.input, policy, input.scope);
      assert.equal(aggregate.rows.length, 1);
      assert.equal(aggregate.rows[0].value, count);
      assert.equal(aggregate.rows[0].evidenceIds.length, count);
      const reads = { audit: 0, row: 0 };
      const observed = (values, kind) =>
        new Proxy(values, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) reads[kind]++;
            return Reflect.get(target, key, receiver);
          },
        });
      // Count actual array-member reads without replacing the engine, capture,
      // comparison hashes or SQLite transaction. Serialization is counted too.
      const instrumented = {
        ...aggregate,
        audit: aggregate.audit.map((entry) => ({ ...entry, factIds: observed(entry.factIds, "audit") })),
        rows: aggregate.rows.map((row) => ({ ...row, evidenceIds: observed(row.evidenceIds, "row") })),
      };
      const retained = capture({ ...input, aggregates: [instrumented] });
      assert.equal(retained.state, "retained");
      measured.push({ count, ...reads, total: reads.audit + reads.row });
      const expected = input.input.facts
        .filter((entry) => entry.revision === 1)
        .map((entry) => ({ artifactId: entry.artifactId, hash: comparisonHash(entry) }));
      const document = read(retained.inputId);
      assert.deepEqual(document.authorization.corrections, expected);
      assert.equal(document.baseline[0].rows[0].value, count);
      assert.equal(capture({ ...input, aggregates: [aggregate] }).inputId, retained.inputId);
      reopen();
      assert.deepEqual(read(retained.inputId), document);
    });
  }
  t.diagnostic(JSON.stringify({ membershipReads: measured }));
  assert.ok(
    measured[1].total <= measured[0].total * 2 + 32,
    `doubling corrected facts must not square baseline membership reads: ${JSON.stringify(measured)}`,
  );
});

test("correction capture retains only reviewed excluded revisions observed by the frozen cutoff", () => {
  database(({ capture, read }) => {
    const input = captureInput(1);
    const rejected = [
      fact("revision-zero", { state: "excluded", correctionReceipt: "synthetic-review" }),
      fact("missing-receipt", { revision: 1, state: "excluded" }),
      fact("blank-receipt", { revision: 1, state: "excluded", correctionReceipt: "  " }),
      fact("still-observed", { revision: 1, correctionReceipt: "synthetic-review" }),
      fact("after-cutoff", {
        revision: 1,
        state: "excluded",
        correctionReceipt: "synthetic-review",
        observedAt: "2026-10-19T00:00:00.000Z",
      }),
    ];
    input.input.facts.push(...rejected.map((entry) => fact(entry.id)), ...rejected);
    const expected = input.input.facts.find((entry) => entry.id === "corrected-0" && entry.revision === 1);
    const result = capture(input);
    assert.equal(result.state, "retained");
    assert.deepEqual(read(result.inputId).authorization.corrections, [
      { artifactId: expected.artifactId, hash: comparisonHash(expected) },
    ]);
  });
});

test("correction capture requires matching metric and exclusion reason and rejects row counterevidence", () => {
  database(({ capture, read }) => {
    const input = captureInput(1);
    const baseline = metrics.aggregateMetric(input.input, policy, input.scope);
    const mismatched = structuredClone(baseline);
    mismatched.metricId = "pull_requests_opened";
    const wrongReason = structuredClone(baseline);
    wrongReason.audit = wrongReason.audit.map((entry) => ({ ...entry, reason: "actor_opted_out" }));
    const retainedInRow = structuredClone(baseline);
    retainedInRow.rows[0].evidenceIds.push("corrected-0");
    // The trusted host can supply aggregate projections. Contradictory or
    // other-metric projections must not authorize the matching correction.
    for (const aggregate of [mismatched, wrongReason, retainedInRow]) {
      const result = capture({ ...input, aggregates: [aggregate] });
      assert.equal(result.state, "retained");
      assert.deepEqual(read(result.inputId).authorization.corrections, []);
    }
  });
});

test("correction eligibility remains local to each aggregate before combining the same metric", () => {
  database(({ capture, read }) => {
    const input = captureInput(1);
    const excluded = metrics.aggregateMetric(input.input, policy, input.scope);
    const retained = structuredClone(excluded);
    retained.rows[0].evidenceIds.push("corrected-0");
    const correction = input.input.facts.find((entry) => entry.id === "corrected-0" && entry.revision === 1);
    for (const aggregates of [
      [retained, excluded],
      [excluded, retained],
    ]) {
      const result = capture({ ...input, aggregates });
      assert.equal(result.state, "retained");
      assert.deepEqual(read(result.inputId).authorization.corrections, [
        { artifactId: correction.artifactId, hash: comparisonHash(correction) },
      ]);
    }
  });
});

test("correction capture preserves input order, repeated receipts and full revision hashes", () => {
  database(({ capture, read, reopen }) => {
    const input = captureInput(2);
    const first = input.input.facts.find((entry) => entry.id === "corrected-0" && entry.revision === 1);
    const second = input.input.facts.find((entry) => entry.id === "corrected-1" && entry.revision === 1);
    const newer = { ...first, revision: 2, correctionReceipt: "synthetic-second-review" };
    input.input.facts = [fact(first.id), fact(second.id), second, newer, first, { ...second }, fact("visible")];
    const expected = [second, newer, first, second].map((entry) => ({
      artifactId: entry.artifactId,
      hash: comparisonHash(entry),
    }));
    const result = capture(input);
    assert.equal(result.state, "retained");
    const document = read(result.inputId);
    assert.deepEqual(document.authorization.corrections, expected);
    assert.notEqual(expected[1].hash, expected[2].hash);
    reopen();
    assert.deepEqual(read(result.inputId), document);
    assert.equal(capture(input).inputId, result.inputId);
  });
});

test("correction capture uses indexed member values without invoking custom evidence iterators", () => {
  database(({ capture, read }) => {
    const input = captureInput(1);
    const baseline = metrics.aggregateMetric(input.input, policy, input.scope);
    const original = capture({ ...input, aggregates: [baseline] });
    let iterations = 0;
    for (const values of [
      ...baseline.audit.map((entry) => entry.factIds),
      ...baseline.rows.map((row) => row.evidenceIds),
    ]) {
      values[Symbol.iterator] = () => {
        iterations++;
        throw Error("synthetic custom iterator must not replace indexed membership");
      };
    }
    const repeated = capture({ ...input, aggregates: [baseline] });
    assert.deepEqual(repeated, original);
    assert.equal(iterations, 0);
    assert.equal(read(repeated.inputId).authorization.corrections.length, 1);
  });
});
