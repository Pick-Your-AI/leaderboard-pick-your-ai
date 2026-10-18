import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistrySchema } from "@pick-your-ai/contracts";
import { aggregateMetric, getMetricUi, getMetricGroupingPolicy, getRegistryDepartments, getLeadMetrics, metricRegistryV1, selectMetricView, validateMetricPolicy } from "../dist/index.js";

const clone = () => structuredClone(metricRegistryV1);

test("all 98 definitions have unique UI mappings, departments and explicit unavailable states", () => {
  const registry = metricRegistrySchema.parse(clone());
  assert.equal(registry.ui_metadata.public_enabled, false);
  const departments = getRegistryDepartments(registry);
  assert.equal(departments.length, 10);
  assert.equal(registry.ui_metadata.metrics.length, 98);
  for (const metric of registry.metrics) {
    const ui = getMetricUi(metric.id, registry);
    assert.ok(ui);
    assert.equal(ui.department, metric.family);
    assert.ok(departments.some(department => department.id === ui.department));
    if (ui.supported_combinations.length) {
      assert.deepEqual(selectMetricView(metric.id, {}, registry), ui.default_combination);
      assert.ok(ui.verification_cases.length);
    } else {
      assert.equal(ui.default_combination, null);
      assert.throws(() => selectMetricView(metric.id, {}, registry), /No supported/);
    }
  }
  assert.equal(getMetricUi("missing"), undefined);
});

test("strict registry validation rejects broken mappings, fake enablement and unsupported defaults", () => {
  for (const mutate of [
    r => { r.ui_metadata.metrics[0].metric_id = r.ui_metadata.metrics[1].metric_id; },
    r => { r.ui_metadata.metrics[0].department = "invented"; },
    r => { r.ui_metadata.public_enabled = true; },
    r => { r.ui_metadata.metrics.find(m => m.metric_id === "pr_merged").supported_states.push("observed"); },
    r => { r.ui_metadata.metrics.find(m => m.metric_id === "pr_merged").default_combination.date_basis = "occurredAt"; },
    r => { r.ui_metadata.metrics.find(m => m.metric_id === "pr_merged").verification_cases = []; },
    r => { r.ui_metadata.metrics.find(m => m.metric_id === "retained_lines").lead_view.wall = true; },
    r => { r.grouping_policies = []; },
    r => { r.grouping_policies[0].grouping_seconds = 1; },
    r => { r.ui_metadata.departments[0].order = r.ui_metadata.departments[1].order; },
  ]) {
    const registry = clone(); mutate(registry);
    assert.equal(metricRegistrySchema.safeParse(registry).success, false);
  }
});

test("localization exposes only its independently qualified source-merge candidate view", () => {
  const ui = getMetricUi("localization");
  const pair = { state: "qualified", date_basis: "occurredAt" };
  assert.equal(ui.maturity, "synthetic_verified");
  assert.equal(ui.source_class, "evidence_reviewed");
  assert.deepEqual(ui.supported_states, [pair.state]);
  assert.deepEqual(ui.supported_date_bases, [pair.date_basis]);
  assert.deepEqual(ui.supported_combinations, [pair]);
  assert.deepEqual(selectMetricView("localization"), pair);
  for (const unsupported of [
    { state: "observed", date_basis: "occurredAt" },
    { state: "qualified", date_basis: "acceptedAt" },
    { state: "reviewed", date_basis: "occurredAt" },
  ]) assert.throws(() => selectMetricView("localization", unsupported), /Unsupported/);
  validateMetricPolicy({
    metricId: "localization", version: "synthetic-localization/v1", definitionVersion: metricRegistryV1.policy_version,
    unit: metricRegistryV1.metrics.find(metric => metric.id === "localization").definition.unit,
    aggregation: "count", dateBasis: pair.date_basis, rankedStates: [pair.state], roles: ["author"],
    groupBy: "canonical", sources: ["github_rest"], minimumSamples: 1, rank: false,
  });
  assert.ok(ui.verification_cases.includes("apps/pipeline/test/localization.test.mjs"));
  assert.ok(ui.verification_cases.includes("packages/github/test/localization.test.mjs"));
  assert.equal(metricRegistryV1.ui_metadata.public_enabled, false);
  assert.deepEqual(ui.lead_view, { overview: false, wall: false, order: null });
});

test("every advertised triage combination must match the pinned engine grouping policy", () => {
  for (const invalid of [
    {state: "qualified", date_basis: "acceptedAt"},
    {state: "observed", date_basis: "acceptedAt"},
    {state: "qualified", date_basis: "occurredAt"},
  ]) {
    for (const retainValid of [false, true]) {
      const registry = clone();
      const entry = registry.ui_metadata.metrics.find(m => m.metric_id === "items_triaged");
      entry.supported_combinations = retainValid ? [...entry.supported_combinations, invalid] : [invalid];
      entry.supported_states = [...new Set(entry.supported_combinations.map(pair => pair.state))];
      entry.supported_date_bases = [...new Set(entry.supported_combinations.map(pair => pair.date_basis))];
      if (!retainValid) entry.default_combination = invalid;
      const parsed = metricRegistrySchema.safeParse(registry);
      assert.equal(parsed.success, false);
      assert.match(parsed.error.message, /Every triage selection must match/);
    }
  }
  const valid = metricRegistrySchema.parse(clone());
  assert.deepEqual(selectMetricView("items_triaged", {}, valid), {state: "observed", date_basis: "occurredAt"});
});

test("selectors validate pairs rather than independently valid state/date lists", () => {
  const registry = clone();
  const entry = registry.ui_metadata.metrics.find(m => m.metric_id === "pr_merged");
  entry.supported_states.push("observed");
  entry.supported_date_bases.push("occurredAt");
  entry.supported_combinations.push({ state: "observed", date_basis: "occurredAt" });
  metricRegistrySchema.parse(registry);
  assert.throws(() => selectMetricView("pr_merged", { state: "observed", date_basis: "acceptedAt" }, registry), /Unsupported/);
  assert.throws(() => selectMetricView("pr_merged", { state: "qualified", date_basis: "occurredAt" }, registry), /Unsupported/);
  assert.deepEqual(selectMetricView("pr_merged", { state: "observed", date_basis: "occurredAt" }, registry), { state: "observed", date_basis: "occurredAt" });
  assert.throws(() => selectMetricView("labels_applied", { state: "qualified" }), /Unsupported/);
  assert.throws(() => selectMetricView("pr_merged", { date_basis: "observedAt" }), /Unsupported/);
});

test("legacy unresolved registries cannot invent selectable views or wall choices", () => {
  const registry = clone();
  registry.ui_metadata = { decision_state: "unresolved", fields: ["department"], note: "Legacy candidate" };
  metricRegistrySchema.parse(registry);
  assert.equal(getMetricUi("pr_merged", registry), undefined);
  assert.deepEqual(getLeadMetrics("wall", registry), []);
  assert.throws(() => selectMetricView("pr_merged", {}, registry), /No supported/);
});

test("raw triage policy pins exact-source state, UTC hour buckets and repeated-state suppression", () => {
  const grouping = getMetricGroupingPolicy("items_triaged");
  const policy = {
    metricId: "items_triaged", version: "synthetic-triage/v1", definitionVersion: metricRegistryV1.policy_version,
    unit: metricRegistryV1.metrics.find(m => m.id === "items_triaged").definition.unit,
    aggregation: "count", dateBasis: grouping.date_basis, rankedStates: [grouping.state], roles: ["triager"],
    groupBy: grouping.group_by, groupingSeconds: grouping.grouping_seconds, groupingPolicyVersion: grouping.version,
    sources: ["github_rest"], minimumSamples: 1, rank: true,
  };
  validateMetricPolicy(policy);
  for (const patch of [{ groupingPolicyVersion: undefined }, { groupingSeconds: 60 }, { groupBy: "canonical" }, { dateBasis: "acceptedAt" }, { rankedStates: ["qualified"] }, { roles: ["author"] }])
    assert.throws(() => validateMetricPolicy({ ...policy, ...patch }), /exact versioned grouping/);
  const fact = (id, occurredAt, rawState, artifactId = "issue-1") => ({
    id, canonicalKey: id, metricId: "items_triaged", actorId: "a", artifactId, repoId: "synthetic-repo", role: "triager", state: "observed",
    occurredAt, acceptedAt: null, observedAt: "2026-10-04T12:00:00Z", revision: 0, correctionReceipt: null,
    acceptanceReceipt: null, acceptedBy: null, subjectActorId: null, eventContext: {projects:[],workstreams:[]}, currentContext: null, rawState,
  });
  const facts = [
    fact("first", "2026-10-04T10:00:00Z", "labeled:raw-bug"),
    fact("repeat", "2026-10-04T10:59:59Z", "labeled:raw-bug"),
    fact("boundary", "2026-10-04T11:00:00Z", "labeled:raw-bug"),
    fact("literal", "2026-10-04T10:20:00Z", "labeled:Raw-Bug"),
    fact("other-issue", "2026-10-04T10:20:00Z", "labeled:raw-bug", "issue-2"),
    fact("missing", "2026-10-04T10:20:00Z", undefined),
    fact("missing-time", null, "labeled:raw-bug"),
    {...fact("missing-actor", "2026-10-04T10:20:00Z", "labeled:raw-bug"), actorId: null},
    fact("missing-artifact", "2026-10-04T10:20:00Z", "labeled:raw-bug", null),
  ];
  const scope = { timezone: "UTC", from: "2026-10-04T00:00:00Z", to: "2026-10-05T00:00:00Z", repos: [], projects: [], workstreams: [], roles: [], actors: "user", context: "event" };
  const input = { datasetId: "synthetic-triage", cutoff: scope.to, backfillRevision: "synthetic-1", repositoryIds: ["synthetic-repo"], actors: [{ id: "a", login: "synthetic-a", kind: "user", publicState: "visible" }], facts, coverage: [] };
  const result = aggregateMetric(input, policy, scope);
  assert.equal(result.rows[0].value, 4);
  assert.equal(result.publicEnabled, false);
  const earlier = aggregateMetric(input, policy, {...scope, to: "2026-10-04T11:00:00Z"});
  const later = aggregateMetric(input, policy, {...scope, from: "2026-10-04T11:00:00Z"});
  assert.equal(earlier.rows[0].value, 3);
  assert.equal(later.rows[0].value, 1);
  assert.ok(result.audit.some(entry => entry.reason === "unknown_raw_state_or_time"));
  assert.deepEqual(aggregateMetric({...input, facts: [...facts].reverse()}, policy, scope), result);
  assert.equal(grouping.semantic_classifier, "none");
});
