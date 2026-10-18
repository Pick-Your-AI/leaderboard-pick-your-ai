import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateMetric, getMetricGroupingPolicy, metricRegistryV1 } from "../dist/index.js";

// Synthetic source observations exercise the normalizer/engine boundary. No
// collection permission, live evidence or production enablement is implied.
const fixture = JSON.parse(
  await readFile(new URL("../../github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const grouping = getMetricGroupingPolicy("items_triaged");
const definition = metricRegistryV1.metrics.find((metric) => metric.id === "items_triaged");
const policy = {
  metricId: definition.id,
  version: "synthetic-triage/v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: definition.definition.unit,
  aggregation: "count",
  dateBasis: grouping.date_basis,
  rankedStates: [grouping.state],
  roles: ["triager"],
  groupBy: grouping.group_by,
  groupingSeconds: grouping.grouping_seconds,
  groupingPolicyVersion: grouping.version,
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
};
const scope = {
  timezone: "UTC",
  from: "2026-10-07T00:00:00Z",
  to: "2026-10-08T00:00:00Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const normalize = (action, target, occurredAt = "2026-10-07T10:00:00Z") =>
  normalizeGithubObservation({
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: {
      verified: true,
      source: "github_webhook",
      revision: occurredAt,
      eventId: `synthetic-${action}-${occurredAt}`,
      isSynthetic: true,
    },
    family: "triage",
    action,
    occurredAt,
    observedAt: "2026-10-07T12:00:00Z",
    payload: {
      issue: {
        ...structuredClone(fixture.issue),
        user: fixture.author,
        labels: [{ id: 80 }],
        assignees: [{ id: 81 }],
        milestone: { id: 82 },
        issue_type: { id: 83 },
      },
      sender: fixture.merger,
      ...target,
    },
  });
const aggregate = (...results) =>
  aggregateMetric(
    {
      datasetId: "synthetic-normalized-triage",
      cutoff: scope.to,
      backfillRevision: "synthetic-1",
      repositoryIds: ["2"],
      actors: results[0].actors,
      facts: results.flatMap((out) => out.facts),
      coverage: [],
    },
    policy,
    scope,
  );

const transitions = [
  ["labeled", "label"],
  ["unlabeled", "label"],
  ["assigned", "assignee"],
  ["unassigned", "assignee"],
  ["milestoned", "milestone"],
  ["demilestoned", "milestone"],
  ["issue_typed", "issue_type"],
  ["issue_untyped", "issue_type"],
];

test("target-dependent triage with missing identity stays unknown through normalizer and engine", () => {
  for (const [action, field] of transitions) {
    for (const target of [undefined, {}, { name: "synthetic display name only" }, { id: null }]) {
      // An unrelated identified target must not make the action measurable.
      const otherField = field === "label" ? "milestone" : "label";
      const out = normalize(action, { [field]: target, [otherField]: { id: 99 } });
      const facts = out.facts.filter((fact) => fact.metricId === "items_triaged");
      assert.equal(facts.length, 1, action);
      assert.equal(facts[0].state, "unknown", action);
      assert.equal(facts[0].rawState, undefined, action);
      assert.ok(out.reasons.includes("unknown_metadata_target_identity"), action);
      const result = aggregate(out);
      assert.ok(
        result.rows.every((row) => row.value === null),
        action,
      );
      assert.ok(
        result.audit.some((entry) => entry.factIds.includes(facts[0].id) && entry.reason === "unknown_qualification"),
        action,
      );
      assert.equal(result.publicEnabled, false);
    }
  }
});

test("each triage transition preserves a proven target and counts its observed actor", () => {
  for (const [action, field] of transitions) {
    for (const target of [
      { [field]: { node_id: "SYNTHETIC_TARGET" } },
      { [field]: { id: 90 } },
      { target_id: "SYNTHETIC_TARGET" },
    ]) {
      const out = normalize(action, target);
      const fact = out.facts.find((fact) => fact.metricId === "items_triaged");
      assert.equal(fact.state, "observed", action);
      assert.match(fact.rawState, new RegExp(`^${action}:(SYNTHETIC_TARGET|github:metadata:90)$`));
      const result = aggregate(out);
      assert.equal(result.rows.find((row) => row.actorId === String(fixture.merger.id)).value, 1, action);
      assert.equal(
        result.rows.some((row) => row.actorId === String(fixture.author.id) && row.value > 0),
        false,
      );
    }
  }
});

test("same actor, item and raw state at 10:00 and 11:00 count two advertised UTC-hour groups", () => {
  const first = normalize("unlabeled", { label: { id: 90 } });
  const repeat = normalize("unlabeled", { label: { id: 90 } }, "2026-10-07T10:59:59Z");
  const nextHour = normalize("unlabeled", { label: { id: 90 } }, "2026-10-07T11:00:00Z");
  const result = aggregate(first, repeat, nextHour);
  assert.equal(result.rows.find((row) => row.actorId === String(fixture.merger.id)).value, 2);
  assert.equal(result.unit, "distinct actor-item-raw-state UTC-hour triage groups");
  assert.equal(result.unit, definition.definition.unit);
  assert.equal(definition.definition.numerator, definition.counting_rule);
  assert.match(definition.counting_rule, /3,600-second UTC bucket/);
  assert.match(definition.counting_rule, /triage-raw-state\/v1/);
  assert.equal(metricRegistryV1.policy_version, "candidate-0.1.1");
  assert.equal(grouping.version, "triage-raw-state/v1");
  assert.equal(grouping.grouping_seconds, 3600);
});
