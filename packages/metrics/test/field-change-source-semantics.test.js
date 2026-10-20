import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateMetric, getMetricDefinition, getMetricGroupingPolicy, metricRegistryV1 } from "../dist/index.js";

// Synthetic source-to-metric cases for explicitly supplied enriched envelopes.
// These do not represent native webhook acquisition or publicly activated metrics.
const at = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const cases = [
  ["issue_field_changed", "issue_field_updates"],
  ["project_item_field_changed", "project_field_updates"],
  ["project_status_changed", "project_status_updates"],
  ["project_progress_published", "project_updates"],
];
const actor = { id: 202, node_id: "U_synthetic_editor", login: "synthetic-editor", type: "User" };
const author = { id: 101, node_id: "U_synthetic_author", login: "synthetic-author", type: "User" };
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: observedAt,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
function envelope(action, before, after) {
  const project = action.startsWith("project");
  return {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public" },
    proof: {
      verified: true,
      source: "github_webhook",
      revision: "synthetic-field-noop-revision",
      eventId: "synthetic-field-noop:" + action,
      isSynthetic: true,
    },
    family: "field_change",
    action,
    occurredAt: at,
    observedAt,
    payload: {
      id: project ? "P_synthetic_noop" : "I_synthetic_noop",
      html_url: project
        ? "https://github.com/orgs/synthetic-owner/projects/6"
        : "https://github.com/synthetic-owner/repository/issues/1",
      user: author,
      sender: actor,
      change: { before, after },
    },
  };
}
function run(action, metric, before, after, alter = () => {}) {
  const input = envelope(action, before, after);
  alter(input);
  const out = normalizeGithubObservation(input);
  const grouping = getMetricGroupingPolicy(metric);
  if (metric === "project_field_updates") assert.equal(grouping?.version, "project-field-day/v1");
  const aggregate = aggregateMetric(
    {
      datasetId: "synthetic-field-noop-witness",
      cutoff: observedAt,
      backfillRevision: "synthetic/v1",
      repositoryIds: ["2"],
      actors: out.actors,
      facts: out.facts,
      coverage: [],
    },
    {
      metricId: metric,
      version: "synthetic-field-noop/v1",
      definitionVersion: metricRegistryV1.policy_version,
      unit: getMetricDefinition(metric).definition.unit,
      aggregation: "count",
      dateBasis: "occurredAt",
      rankedStates: ["observed"],
      roles: ["triager"],
      groupBy: "canonical",
      ...(grouping
        ? {
            groupBy: grouping.group_by,
            groupingSeconds: grouping.grouping_seconds,
            groupingPolicyVersion: grouping.version,
          }
        : {}),
      sources: ["github_webhook"],
      minimumSamples: 1,
      rank: false,
    },
    scope,
  );
  assert.equal(out.isSynthetic, true);
  assert.equal(aggregate.publicEnabled, false);
  assert.equal(aggregate.coverage, "incomplete");
  assert.ok(aggregate.rows.every((row) => row.rank === null));
  return { input, out, aggregate };
}
function noChange(result) {
  assert.equal(result.out.observations.length, 1, "Keep the raw observation even when no change is counted");
  assert.deepEqual(result.out.facts, [], "Equivalent field values cannot produce a normalized change unit");
  assert.ok(result.out.reasons.includes("no_op_field_change"));
  assert.deepEqual(result.aggregate.rows, [], "Equivalent values cannot create an editor count");
}
function changed(result, metric) {
  assert.equal(result.out.observations.length, 1);
  assert.equal(result.out.facts.length, 1);
  const fact = result.out.facts[0];
  assert.equal(fact.metricId, metric);
  assert.equal(fact.actorId, "202");
  assert.equal(fact.subjectActorId, "101");
  assert.equal(fact.role, "triager");
  assert.equal(fact.state, "observed");
  assert.equal(fact.occurredAt, "2026-10-07T10:00:00.000Z");
  assert.equal(fact.acceptedAt, null);
  assert.equal(fact.acceptanceReceipt, null);
  assert.deepEqual(
    result.aggregate.rows.map((row) => [row.actorId, row.value]),
    [["202", 1]],
  );
}
for (const [action, metric] of cases) {
  test(action + ": object member order alone does not create a field update", () => {
    const before = { optionId: "OPTION_SYNTHETIC", value: "ready" };
    const after = { value: "ready", optionId: "OPTION_SYNTHETIC" };
    assert.deepEqual(before, after);
    noChange(run(action, metric, before, after));
  });
}
test("field changes ignore object member order recursively inside arrays", () => {
  const before = { rows: [{ id: "OPTION_SYNTHETIC", value: { label: "ready", color: "blue" } }], kind: "selection" };
  const after = { kind: "selection", rows: [{ value: { color: "blue", label: "ready" }, id: "OPTION_SYNTHETIC" }] };
  assert.deepEqual(before, after);
  noChange(run("project_item_field_changed", "project_field_updates", before, after));
});
test("identical scalars and same-order objects retain no-op observations without metric units", () => {
  for (const [action, metric] of cases) {
    for (const value of [null, false, 0, "", "ready", { optionId: "OPTION_SYNTHETIC", value: "ready" }, ["a", "b"]]) {
      noChange(run(action, metric, structuredClone(value), structuredClone(value)));
    }
  }
});
test("a changed scalar remains one raw unit with the observed editor and source clock", () => {
  for (const [action, metric] of cases) changed(run(action, metric, "backlog", "ready"), metric);
});
test("array order remains significant for field transitions", () => {
  for (const [action, metric] of cases) changed(run(action, metric, ["a", "b"], ["b", "a"]), metric);
});
test("missing transition values or event proof never admit a field update", () => {
  for (const [action, metric] of cases) {
    for (const alter of [
      (input) => {
        delete input.payload.change.before;
      },
      (input) => {
        delete input.payload.change.after;
      },
      (input) => {
        delete input.payload.change;
      },
      (input) => {
        delete input.proof.eventId;
      },
    ]) {
      const { out, aggregate } = run(action, metric, "backlog", "ready", alter);
      assert.deepEqual(out.facts, []);
      assert.ok(out.reasons.includes("unsupported_or_unproven_field_subtype"));
      assert.deepEqual(aggregate.rows, []);
    }
  }
});
test("real nested values, object shape and scalar types remain distinct field changes", () => {
  const pairs = [
    [{ value: { label: "backlog", color: "blue" } }, { value: { color: "blue", label: "ready" } }],
    [{ value: "ready" }, { value: "ready", optionId: null }],
    [{ value: "ready" }, { optionId: "ready" }],
    [null, ""],
    [false, 0],
    [1, "1"],
    [[], {}],
    [["a"], ["a", "a"]],
    [
      [{ id: "a" }, { id: "b" }],
      [{ id: "b" }, { id: "a" }],
    ],
  ];
  for (const [action, metric] of cases) {
    for (const [before, after] of pairs) changed(run(action, metric, before, after), metric);
  }
});
test("all own JSON object names participate without prototype-key collisions", () => {
  const before = JSON.parse('{"__proto__":{"optionId":"OPTION_SYNTHETIC","value":"ready"},"constructor":"synthetic"}');
  const reordered = JSON.parse(
    '{"constructor":"synthetic","__proto__":{"value":"ready","optionId":"OPTION_SYNTHETIC"}}',
  );
  const different = JSON.parse(
    '{"constructor":"synthetic","__proto__":{"value":"backlog","optionId":"OPTION_SYNTHETIC"}}',
  );
  for (const [action, metric] of cases) {
    noChange(run(action, metric, before, reordered));
    changed(run(action, metric, before, different), metric);
  }
});
test("field-value comparison does not retain private raw before and after values", () => {
  const before = { value: "SYNTHETIC_PRIVATE_FIELD_BEFORE", nested: { option: "SYNTHETIC_PRIVATE_OPTION" } };
  const after = { nested: { option: "SYNTHETIC_PRIVATE_OPTION" }, value: "SYNTHETIC_PRIVATE_FIELD_AFTER" };
  for (const [action, metric] of cases) {
    const result = run(action, metric, before, after);
    changed(result, metric);
    assert.doesNotMatch(JSON.stringify({ out: result.out, aggregate: result.aggregate }), /SYNTHETIC_PRIVATE_/);
  }
});
