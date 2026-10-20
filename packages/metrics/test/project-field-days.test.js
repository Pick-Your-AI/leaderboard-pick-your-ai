import assert from "node:assert/strict";
import test from "node:test";
import { metricRegistrySchema } from "@pick-your-ai/contracts";
import { normalizeGithubObservation } from "../../github/dist/index.js";
import {
  aggregateMetric,
  getMetricDefinition,
  getMetricGroupingPolicy,
  getMetricUi,
  metricRegistryV1,
  stableJSON,
  validateMetricPolicy,
} from "../dist/index.js";

// Protected, explicitly enriched synthetic item observations. These are not
// raw projects_v2_item webhook payloads or an installed source-capability test.
const metricId = "project_field_updates";
const projectId = "PVT_SYNTHETIC_PROJECT";
const observedAt = "2026-10-10T00:00:00Z";
const editor = { id: 202, node_id: "U_SYNTHETIC_EDITOR", login: "synthetic-editor", type: "User" };
const contextAuthor = { id: 101, node_id: "U_SYNTHETIC_AUTHOR", login: "synthetic-author", type: "User" };
const scope = {
  timezone: "UTC",
  from: "2026-10-07T00:00:00Z",
  to: "2026-10-11T00:00:00Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
function envelope(id, patch = {}) {
  const {
    occurredAt = "2026-10-07T10:00:00Z",
    itemId = "PVTI_SYNTHETIC_ITEM",
    repositoryId = 2,
    sender = editor,
    before = "backlog",
    after = "ready",
    workstream = "research",
    fieldId = "PVTSSF_SYNTHETIC_PRIORITY",
  } = patch;
  return {
    repository: { id: repositoryId, slug: "synthetic-owner/repository", visibility: "public" },
    proof: { verified: true, source: "github_webhook", revision: id, eventId: id, isSynthetic: true },
    family: "field_change",
    action: "project_item_field_changed",
    occurredAt,
    observedAt,
    eventContext: { projects: [projectId], workstreams: [workstream], workstreamsKnown: true },
    payload: {
      node_id: itemId,
      html_url: "https://github.com/orgs/synthetic-owner/projects/6",
      project_node_id: projectId,
      user: contextAuthor,
      sender,
      field_node_id: fieldId,
      change: { before, after },
    },
  };
}
function observation(id, patch = {}, alter = () => {}) {
  const value = envelope(id, patch);
  alter(value);
  const frozen = stableJSON(value);
  const result = normalizeGithubObservation(value);
  assert.equal(stableJSON(value), frozen);
  assert.equal(result.isSynthetic, true);
  return result;
}
function policy(patch = {}) {
  return {
    metricId,
    version: "synthetic-project-field-day/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["triager"],
    groupBy: "actor_artifact_interval",
    groupingSeconds: 86400,
    groupingPolicyVersion: "project-field-day/v1",
    sources: ["github_webhook"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
}
function input(results) {
  return {
    datasetId: "synthetic-project-field-days",
    cutoff: scope.to,
    backfillRevision: "synthetic-project-field-days/v1",
    repositoryIds: [...new Set(results.flatMap((result) => result.facts.map((fact) => fact.repoId)))],
    actors: [...new Map(results.flatMap((result) => result.actors).map((actor) => [actor.id, actor])).values()],
    facts: results.flatMap((result) => result.facts),
    coverage: [],
  };
}
function board(results, selectedScope = scope) {
  const frozen = input(results);
  const before = stableJSON(frozen);
  const result = aggregateMetric(frozen, policy(), selectedScope);
  assert.equal(stableJSON(frozen), before);
  assert.equal(result.publicEnabled, false);
  assert.equal(result.coverage, "incomplete");
  assert.ok(result.rows.every((row) => row.rank === null));
  return result;
}
const values = (result) => result.rows.map((row) => [row.actorId, row.value]);
const noMeasuredCount = (result) => assert.ok(result.rows.every((row) => row.value === null));

test("Project field day policy pins observed source time and retains unavailable public metadata", () => {
  const grouping = getMetricGroupingPolicy(metricId);
  assert.deepEqual(grouping, {
    version: "project-field-day/v1",
    metric_id: metricId,
    state: "observed",
    date_basis: "occurredAt",
    group_by: "actor_artifact_interval",
    grouping_seconds: 86400,
    interval_origin: "1970-01-01T00:00:00Z",
    raw_state_rule: "field_facets_share_item_unit",
    repeated_state_rule: "one_actor_item_per_utc_day",
    missing_state_or_time: "exclude_unknown",
    semantic_classifier: "none",
    public_enabled: false,
  });
  validateMetricPolicy(policy());
  assert.equal(metricRegistryV1.metrics.length, 98);
  assert.equal(getMetricUi(metricId).maturity, "definition_only");
  assert.equal(getMetricUi(metricId).default_combination, null);
  assert.deepEqual(getMetricUi(metricId).supported_combinations, []);
  assert.equal(metricRegistryV1.ui_metadata.public_enabled, false);
  for (const patch of [
    { groupingPolicyVersion: undefined },
    { groupingPolicyVersion: "project-field-day/v2" },
    { groupingSeconds: 3600 },
    { groupBy: "canonical" },
    { groupBy: "actor_artifact" },
    { groupBy: "actor_artifact_state_interval" },
    { dateBasis: "acceptedAt" },
    { rankedStates: ["qualified"] },
    { rankedStates: ["reviewed"] },
    { roles: ["author"] },
    { roles: ["triager", "author"] },
  ]) {
    assert.throws(() => validateMetricPolicy(policy(patch)));
  }
});

test("Project field registry rejects altered day units and incompatible advertised selections", () => {
  for (const [field, value] of [
    ["metric_id", "project_updates"],
    ["grouping_seconds", 3600],
    ["interval_origin", "2026-01-01T00:00:00Z"],
    ["date_basis", "acceptedAt"],
    ["state", "qualified"],
    ["semantic_classifier", "meaningful"],
    ["public_enabled", true],
    ["receipt_lenses", [{ state: "qualified", date_basis: "acceptedAt" }]],
  ]) {
    const registry = structuredClone(metricRegistryV1);
    registry.grouping_policies.find((entry) => entry.metric_id === metricId)[field] = value;
    assert.equal(metricRegistrySchema.safeParse(registry).success, false);
  }
  const registry = structuredClone(metricRegistryV1);
  const entry = registry.ui_metadata.metrics.find((candidate) => candidate.metric_id === metricId);
  entry.maturity = "synthetic_verified";
  entry.source_class = getMetricUi("items_triaged").source_class;
  entry.verification_cases = ["packages/metrics/test/project-field-days.test.js"];
  entry.supported_states = ["observed"];
  entry.supported_date_bases = ["acceptedAt"];
  entry.supported_combinations = [{ state: "observed", date_basis: "acceptedAt" }];
  entry.default_combination = entry.supported_combinations[0];
  const parsed = metricRegistrySchema.safeParse(registry);
  assert.equal(parsed.success, false);
  assert.match(parsed.error.message, /Every triage selection must match/);
});

test("different field facets and reversals retain raw events but share one observed editor item day", () => {
  const results = [
    observation("priority-change", { occurredAt: "2026-10-07T10:00:00Z", before: "low", after: "high" }),
    observation("workstream-change", {
      occurredAt: "2026-10-07T11:00:00Z",
      fieldId: "PVTSSF_SYNTHETIC_WORKSTREAM",
      before: "research",
      after: "application",
    }),
    observation("priority-reversal", { occurredAt: "2026-10-07T12:00:00Z", before: "high", after: "low" }),
  ];
  assert.equal(results.flatMap((result) => result.observations).length, 3);
  assert.equal(results.flatMap((result) => result.facts).length, 3);
  for (const result of results) {
    const fact = result.facts[0];
    assert.equal(fact.artifactId, "PVTI_SYNTHETIC_ITEM");
    assert.notEqual(fact.artifactId, projectId);
    assert.equal(result.evidence[0].artifact.stableId, fact.artifactId);
    assert.equal(fact.actorId, "202");
    assert.equal(fact.subjectActorId, "101");
    assert.equal(fact.role, "triager");
    assert.equal(fact.state, "observed");
    assert.equal(fact.acceptanceReceipt, null);
    assert.equal(fact.acceptedAt, null);
  }
  const result = board(results);
  assert.deepEqual(values(result), [["202", 1]]);
  assert.deepEqual(result.rows[0].evidenceIds, [results[0].facts[0].id]);
  const repeated = result.audit
    .filter((entry) => entry.reason === "repeated_policy_unit")
    .flatMap((entry) => entry.factIds);
  assert.deepEqual(repeated.sort(), results.slice(1).map((entry) => entry.facts[0].id).sort());
});

test("UTC midnight and half-open windows use the source clock rather than later collection time", () => {
  const results = [
    observation("before-midnight", { occurredAt: "2026-10-07T23:59:59.999Z" }),
    observation("midnight", { occurredAt: "2026-10-08T00:00:00Z" }),
    observation("same-next-day", { occurredAt: "2026-10-08T18:00:00Z" }),
  ];
  assert.deepEqual(values(board(results)), [["202", 2]]);
  assert.deepEqual(values(board(results, { ...scope, to: "2026-10-08T00:00:00Z" })), [["202", 1]]);
  assert.deepEqual(values(board(results, { ...scope, from: "2026-10-08T00:00:00Z" })), [["202", 1]]);
  noMeasuredCount(board(results, { ...scope, from: observedAt }));
  for (const occurredAt of ["2026-10-07T23:59:59.999999Z", "2026-10-07T20:00:00-04:00", null]) {
    const result = observation("unknown-source-clock-" + occurredAt, { occurredAt });
    assert.equal(result.facts[0].occurredAt, null);
    assert.equal(result.facts[0].state, "unknown");
    noMeasuredCount(board([result]));
  }
});

test("reordering, exact duplicate delivery and another observation time do not add an item day", () => {
  const first = observation("replay-first");
  const later = observation("replay-later", { occurredAt: "2026-10-07T11:00:00Z" });
  const result = board([first, later]);
  assert.deepEqual(board([later, first, first]), result);
  const reobserved = structuredClone(first);
  reobserved.facts[0].observedAt = "2026-10-10T01:00:00.000Z";
  assert.deepEqual(board([reobserved, later, first]), result);
  assert.deepEqual(values(result), [["202", 1]]);
});

test("distinct Project items and editors remain separate even within one Project and day", () => {
  const otherEditor = { id: 303, node_id: "U_SYNTHETIC_OTHER", login: "synthetic-other", type: "User" };
  const results = [
    observation("item-a"),
    observation("item-b", { itemId: "PVTI_SYNTHETIC_SECOND" }),
    observation("other-repository-item", { repositoryId: 3, itemId: "PVTI_SYNTHETIC_OTHER_REPO" }),
    observation("other-editor", { sender: otherEditor }),
  ];
  assert.ok(results.every((result) => result.facts[0].eventContext.projects[0] === projectId));
  assert.deepEqual(values(board(results)), [["202", 3], ["303", 1]]);
  assert.deepEqual(values(board(results, { ...scope, repos: ["2"] })), [["202", 2], ["303", 1]]);
  const ambiguous = [2, 3].map((repositoryId) =>
    observation("ambiguous-legacy-" + repositoryId, { repositoryId }, (value) => {
      delete value.payload.node_id;
      value.payload.id = 42;
    }),
  );
  const denied = board(ambiguous);
  noMeasuredCount(denied);
  assert.ok(denied.audit.some((entry) => entry.reason === "conflicting_revision"));
});

test("time and event-workstream filters run before daily representative selection", () => {
  const results = [
    observation("earlier-unselected", { occurredAt: "2026-10-07T08:00:00Z", workstream: "research" }),
    observation("later-selected", { occurredAt: "2026-10-07T12:00:00Z", workstream: "application" }),
  ];
  for (const selectedScope of [
    { ...scope, from: "2026-10-07T10:00:00Z" },
    { ...scope, workstreams: ["application"] },
  ]) {
    const result = board(results, selectedScope);
    assert.deepEqual(values(result), [["202", 1]]);
    assert.deepEqual(result.rows[0].evidenceIds, [results[1].facts[0].id]);
  }
});

test("missing editor, item identity, source time or event proof cannot create an observed item day", () => {
  for (const [index, patch, reason] of [
    [0, { sender: null }, "unknown_actor"],
    [1, { occurredAt: null }, "unknown_event_time"],
    [2, { itemId: null }, "missing_public_artifact_identity"],
  ]) {
    const unknown = observation("missing-input-" + index, patch);
    assert.ok(unknown.reasons.includes(reason));
    if (index === 2) assert.deepEqual(unknown.facts, []);
    else {
      assert.equal(unknown.facts.length, 1);
      assert.equal(unknown.facts[0].state, "unknown");
      if (index === 0) assert.equal(unknown.facts[0].actorId, null);
      else assert.equal(unknown.facts[0].occurredAt, null);
    }
    noMeasuredCount(board([unknown]));
  }
  const noProof = observation("missing-event-proof", {}, (value) => {
    delete value.proof.eventId;
  });
  assert.deepEqual(noProof.facts, []);
  assert.ok(noProof.reasons.includes("unsupported_or_unproven_field_subtype"));
  noMeasuredCount(board([noProof]));
  assert.throws(
    () => observation("unverified-envelope", {}, (value) => {
      value.proof.verified = false;
    }),
    /Verified repository/,
  );
  const known = observation("explicit-unknown-artifact");
  known.facts[0].artifactId = null;
  const result = board([known]);
  noMeasuredCount(result);
  assert.ok(result.audit.some((entry) => entry.reason === "unknown_artifact_identity"));
});

test("no-op fields, snapshots and different raw subtypes do not become Project field days", () => {
  const noOp = observation("same-json-value", {
    before: { id: "option", value: "ready" },
    after: { value: "ready", id: "option" },
  });
  assert.equal(noOp.observations.length, 1);
  assert.deepEqual(noOp.facts, []);
  assert.ok(noOp.reasons.includes("no_op_field_change"));
  noMeasuredCount(board([noOp]));
  const snapshot = observation("current-project-snapshot", {}, (value) => {
    value.family = "project_snapshot";
    value.action = "snapshot";
  });
  assert.equal(snapshot.observations.length, 1);
  assert.deepEqual(snapshot.facts, []);
  assert.ok(snapshot.reasons.includes("current_project_context_does_not_prove_editor_or_time"));
  noMeasuredCount(board([snapshot]));
  for (const [action, expectedMetric] of [
    ["issue_field_changed", "issue_field_updates"],
    ["project_status_changed", "project_status_updates"],
    ["project_progress_published", "project_updates"],
    ["unknown_subtype", null],
  ]) {
    const other = observation("other-subtype-" + action, {}, (value) => {
      value.action = action;
      if (action === "issue_field_changed") {
        value.payload.node_id = "I_SYNTHETIC_OTHER";
        value.payload.html_url = "https://github.com/synthetic-owner/repository/issues/1";
      }
    });
    assert.deepEqual(other.facts.map((fact) => fact.metricId), expectedMetric ? [expectedMetric] : []);
    noMeasuredCount(board([other]));
  }
  for (const field of ["before", "after"]) {
    const incomplete = observation("missing-value-" + field, {}, (value) => {
      delete value.payload.change[field];
    });
    assert.deepEqual(incomplete.facts, []);
    noMeasuredCount(board([incomplete]));
  }
});

test("prequalified correction revision precedes day grouping and keeps the frozen raw journal", () => {
  const source = [
    observation("corrected-source"),
    observation("uncorrected-next-day", { occurredAt: "2026-10-08T10:00:00Z" }),
  ];
  const frozen = input(source);
  frozen.facts.push({
    ...frozen.facts[0],
    revision: 1,
    correctionReceipt: "synthetic-reviewed-source-correction",
    state: "excluded",
  });
  const before = stableJSON(frozen);
  const result = aggregateMetric(frozen, policy(), scope);
  assert.deepEqual(values(result), [["202", 1]]);
  assert.deepEqual(result.rows[0].evidenceIds, [source[1].facts[0].id]);
  assert.ok(result.audit.some((entry) => entry.reason === "excluded_by_policy_or_correction"));
  assert.equal(stableJSON(frozen), before);
  assert.equal(source[0].facts[0].state, "observed");
  assert.equal(source[0].facts[0].revision, 0);
});

test("observed User-account automation stays raw and does not establish manual work or acceptance", () => {
  const automated = observation("known-automated-user", {}, (value) => {
    value.payload.execution_mode = "automated";
  });
  const actor = automated.actors.find((candidate) => candidate.id === "202");
  assert.equal(actor.kind, "user");
  assert.equal(actor.executionMode, "automated");
  assert.equal(automated.facts[0].acceptedAt, null);
  assert.equal(automated.facts[0].acceptanceReceipt, null);
  assert.deepEqual(values(board([automated])), [["202", 1]]);
  assert.deepEqual(values(board([automated], { ...scope, actors: "automation" })), [["202", 1]]);
  const unknownMode = observation("unknown-execution-mode");
  assert.equal(unknownMode.actors.find((candidate) => candidate.id === "202").executionMode, "unknown");
});
