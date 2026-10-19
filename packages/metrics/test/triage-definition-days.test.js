import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { metricRegistrySchema } from "@pick-your-ai/contracts";
import { applyRecognitionReceipt, groupTriageTransitions, normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateMetric, getMetricDefinition, getMetricGroupingPolicy, getMetricUi, metricRegistryV1, stableJSON, validateMetricPolicy } from "../dist/index.js";

// Synthetic, explicitly verified envelopes exercise implementation boundaries;
// they do not certify an installed webhook or a public source capability.
const fixture = JSON.parse(await readFile(new URL("../../github/test/fixtures/engineering.json", import.meta.url), "utf8"));
const metrics = ["label_taxonomy", "milestone_definitions"];
const scope = {
  timezone: "UTC", from: "2026-10-07T00:00:00Z", to: "2026-10-11T00:00:00Z",
  repos: [], projects: [], workstreams: [], roles: [], actors: "user", context: "event",
};
function policy(metricId, patch = {}) {
  const grouping = getMetricGroupingPolicy(metricId);
  assert.ok(grouping, `${metricId} requires its explicit definition-day policy`);
  return {
    metricId, version: "synthetic-definition-day/v1", definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit, aggregation: "count",
    dateBasis: grouping.date_basis, rankedStates: [grouping.state], roles: ["triager"],
    groupBy: grouping.group_by, groupingSeconds: grouping.grouping_seconds,
    groupingPolicyVersion: grouping.version, sources: ["github_webhook"], minimumSamples: 1, rank: true,
    ...patch,
  };
}
function observation(kind, action, id, patch = {}) {
  const { occurredAt = "2026-10-07T10:00:00Z", sender = fixture.merger, definition = {}, payload = {}, repositoryId = 2 } = patch;
  return normalizeGithubObservation({
    repository: { id: repositoryId, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_webhook", revision: id, eventId: id, isSynthetic: true },
    family: "triage", action, occurredAt, observedAt: "2026-10-10T00:00:00Z",
    payload: {
      [kind]: { id: 90, node_id: `SYNTHETIC_${kind}_90`, html_url: `https://github.com/synthetic-owner/repository/${kind === "label" ? "labels/bug" : "milestone/1"}`, ...definition },
      sender, ...payload,
    },
  });
}
function input(results) {
  return {
    datasetId: "synthetic-definition-days", cutoff: scope.to, backfillRevision: "synthetic-1",
    repositoryIds: [...new Set(results.flatMap(result => result.facts.map(fact => fact.repoId)))],
    actors: [...new Map(results.flatMap(result => result.actors).map(actor => [actor.id, actor])).values()],
    facts: results.flatMap(result => result.facts), coverage: [],
  };
}
function board(metricId, results, patch = {}, window = scope) {
  return aggregateMetric(input(results), policy(metricId, patch), window);
}
const values = result => result.rows.map(row => [row.actorId, row.value]);

test("definition-day policies pin their three evidence/clock pairs without changing raw item policy or UI enablement", () => {
  const raw = getMetricGroupingPolicy("items_triaged");
  assert.deepEqual(raw, {
    version: "triage-raw-state/v1", metric_id: "items_triaged", state: "observed", date_basis: "occurredAt",
    group_by: "actor_artifact_state_interval", grouping_seconds: 3600, interval_origin: "1970-01-01T00:00:00Z",
    raw_state_rule: "exact_source_value", repeated_state_rule: "one_actor_artifact_raw_state_per_interval",
    missing_state_or_time: "exclude_unknown", semantic_classifier: "none", public_enabled: false,
  });
  for (const metricId of metrics) {
    const grouping = getMetricGroupingPolicy(metricId);
    assert.equal(grouping.version, "triage-definition-day/v1");
    assert.equal(grouping.group_by, "actor_artifact_interval");
    assert.equal(grouping.grouping_seconds, 86400);
    assert.deepEqual(grouping.receipt_lenses, [
      { state: "qualified", date_basis: "occurredAt" },
      { state: "qualified", date_basis: "acceptedAt" },
    ]);
    validateMetricPolicy(policy(metricId));
    for (const dateBasis of ["occurredAt", "acceptedAt"])
      validateMetricPolicy(policy(metricId, { rankedStates: ["qualified"], dateBasis }));
    for (const patch of [
      { groupingPolicyVersion: undefined }, { groupingPolicyVersion: "triage-definition-day/v2" },
      { groupingSeconds: 3600 }, { groupBy: "canonical" }, { groupBy: "actor_artifact_state_interval" },
      { dateBasis: "acceptedAt" }, { rankedStates: ["reviewed"] }, { roles: ["author"] },
    ]) assert.throws(() => validateMetricPolicy(policy(metricId, patch)), /exact versioned grouping/);
    assert.equal(getMetricUi(metricId).default_combination, null);
    assert.deepEqual(getMetricUi(metricId).supported_combinations, []);
    assert.equal(grouping.public_enabled, false);
    for (const mutate of [
      grouping => { grouping.grouping_seconds = 3600; },
      grouping => { grouping.receipt_lenses[0].state = "observed"; },
    ]) {
      const registry = structuredClone(metricRegistryV1);
      mutate(registry.grouping_policies.find(grouping => grouping.metric_id === metricId));
      assert.equal(metricRegistrySchema.safeParse(registry).success, false);
    }
    const advertised = structuredClone(metricRegistryV1);
    const entry = advertised.ui_metadata.metrics.find(entry => entry.metric_id === metricId);
    entry.maturity = "synthetic_verified";
    entry.source_class = getMetricUi("items_triaged").source_class;
    entry.verification_cases = ["packages/metrics/test/triage-definition-days.test.js"];
    entry.supported_states = ["observed"];
    entry.supported_date_bases = ["acceptedAt"];
    entry.supported_combinations = [{ state: "observed", date_basis: "acceptedAt" }];
    entry.default_combination = entry.supported_combinations[0];
    const rejected = metricRegistrySchema.safeParse(advertised);
    assert.equal(rejected.success, false);
    assert.match(rejected.error.message, /Every triage selection must match/);
  }
});

test("definition facets, renames and reversals share one actor/definition/day while no-op metadata emits no fact", () => {
  for (const [kind, metricId, actions] of [
    ["label", "label_taxonomy", ["label_created", "label_edited", "label_archived", "label_unarchived", "label_deleted"]],
    ["milestone", "milestone_definitions", ["milestone_created", "milestone_edited", "milestone_closed", "milestone_reopened", "milestone_deleted"]],
  ]) {
    const results = actions.map((action, index) => observation(kind, action, `${kind}-${index}`, {
      occurredAt: `2026-10-07T${String(10 + index).padStart(2, "0")}:00:00Z`,
      definition: { name: index % 2 ? "renamed" : "original" },
      payload: { change: { before: index % 2 ? "original" : "renamed", after: index % 2 ? "renamed" : "original" } },
    }));
    const noop = observation(kind, `${kind}_edited`, `${kind}-noop`, { payload: { change: { before: "same", after: "same" } } });
    assert.equal(noop.facts.length, 0);
    assert.ok(noop.reasons.includes("no_op_metadata_change"));
    const result = board(metricId, [...results, noop]);
    assert.deepEqual(values(result), [[String(fixture.merger.id), 1]]);
    assert.equal(result.audit.filter(entry => entry.reason === "repeated_policy_unit").flatMap(entry => entry.factIds).length, 4);
    assert.equal(new Set(results.flatMap(result => result.facts.map(fact => fact.artifactId))).size, 1);
    assert.ok(results.flatMap(result => result.facts).every(fact => fact.state === "observed"));
    assert.equal(result.publicEnabled, false);
  }
});

test("fixed UTC days respect midnight, source-clock limits, exact duplicates and deterministic replay without changing frozen input", () => {
  const results = [
    observation("label", "label_edited", "before-midnight", { occurredAt: "2026-10-07T23:59:59.999Z" }),
    observation("label", "label_edited", "same-day-boundary", { occurredAt: "2026-10-07T23:59:59.999Z" }),
    observation("label", "label_edited", "midnight", { occurredAt: "2026-10-08T00:00:00Z" }),
    observation("label", "label_edited", "later-same-day", { occurredAt: "2026-10-08T18:00:00Z" }),
  ];
  const frozen = input(results), before = stableJSON(frozen);
  const result = aggregateMetric(frozen, policy("label_taxonomy"), scope);
  assert.deepEqual(values(result), [[String(fixture.merger.id), 2]]);
  assert.equal(stableJSON(frozen), before);
  assert.equal(stableJSON(board("label_taxonomy", [...results].reverse().concat(results[0]))), stableJSON(result));
  assert.deepEqual(values(board("label_taxonomy", results, {}, { ...scope, to: "2026-10-08T00:00:00Z" })), [[String(fixture.merger.id), 1]]);
  assert.deepEqual(values(board("label_taxonomy", results, {}, { ...scope, from: "2026-10-08T00:00:00Z" })), [[String(fixture.merger.id), 1]]);
  // This adapter/engine accepts canonical UTC instants to milliseconds. Keep
  // unsupported representations unknown; do not silently truncate or relabel them.
  for (const occurredAt of ["2026-10-07T23:59:59.999999Z", "2026-10-07T20:00:00-04:00"]) {
    const unsupported = observation("label", "label_edited", `unsupported-${occurredAt}`, { occurredAt });
    assert.ok(board("label_taxonomy", [unsupported]).rows.every(row => row.value === null));
    const invalidFact = input([results[0]]);
    invalidFact.facts[0].occurredAt = occurredAt;
    assert.throws(() => aggregateMetric(invalidFact, policy("label_taxonomy"), scope), /explicit UTC instant/);
  }
});

test("daily definition units preserve actors and repository namespaces and do not merge label with milestone kinds", () => {
  const first = observation("label", "label_edited", "namespace-first");
  const otherRepository = structuredClone(first);
  for (const fact of otherRepository.facts) {
    fact.id += ":other-repo"; fact.canonicalKey += ":other-repo"; fact.repoId = "3";
  }
  const otherActor = observation("label", "label_edited", "namespace-other-actor", { sender: fixture.author });
  const milestone = observation("milestone", "milestone_edited", "namespace-milestone");
  const result = board("label_taxonomy", [first, otherRepository, otherActor, milestone]);
  assert.equal(result.rows.find(row => row.actorId === String(fixture.merger.id)).value, 2);
  assert.equal(result.rows.find(row => row.actorId === String(fixture.author.id)).value, 1);
  assert.deepEqual(values(board("milestone_definitions", [first, otherRepository, otherActor, milestone])), [[String(fixture.merger.id), 1]]);
});

test("definition fallback identities separate repositories and kinds while numeric/string IDs and renames retain one artifact", () => {
  const label = observation("label", "label_edited", "fallback-label", { definition: { node_id: null } });
  const renamed = observation("label", "label_edited", "fallback-renamed", { definition: { node_id: null, id: "90", name: "new name" } });
  const milestone = observation("milestone", "milestone_edited", "fallback-milestone", { definition: { node_id: null } });
  const otherRepository = observation("label", "label_edited", "fallback-other-repository", { repositoryId: 3, definition: { node_id: null } });
  const results = [label, renamed, milestone, otherRepository];
  assert.deepEqual(results.map(result => result.facts[0].artifactId), [
    "github:2:label:90", "github:2:label:90", "github:2:milestone:90", "github:3:label:90",
  ]);
  assert.deepEqual(results.map(result => result.evidence[0].artifact.stableId), results.map(result => result.facts[0].artifactId));
  assert.equal(new Set(results.flatMap(result => result.facts.map(fact => fact.artifactId))).size, 3);
  assert.deepEqual(values(board("label_taxonomy", results)), [[String(fixture.merger.id), 2]]);
  assert.deepEqual(values(board("milestone_definitions", results)), [[String(fixture.merger.id), 1]]);
  for (const kind of ["label", "milestone"]) {
    const opaque = observation(kind, `${kind}_edited`, `fallback-opaque-${kind}`, { definition: { node_id: null, id: "provider:opaque-id" } });
    assert.equal(opaque.facts[0].artifactId, `github:2:${kind}:provider:opaque-id`);
    const node = observation(kind, `${kind}_edited`, `fallback-node-${kind}`, { definition: { node_id: "SYNTHETIC_STABLE_NODE", id: "different-fallback" } });
    assert.equal(node.facts[0].artifactId, "SYNTHETIC_STABLE_NODE");
    for (const id of [null, 0, -1, Number.NaN, "   "]) {
      const unknown = observation(kind, `${kind}_edited`, `fallback-unknown-${kind}-${String(id)}`, { definition: { node_id: null, id } });
      assert.equal(unknown.facts.length, 0);
      assert.ok(unknown.reasons.includes("missing_public_artifact_identity"));
    }
  }
});

test("definition ownership cannot come from a creator, current issue metadata or a missing event clock", () => {
  for (const [kind, metricId] of [["label", "label_taxonomy"], ["milestone", "milestone_definitions"]]) {
    const ghost = observation(kind, `${kind}_edited`, `${kind}-ghost`, { sender: null, definition: { user: fixture.author } });
    const missingTime = observation(kind, `${kind}_edited`, `${kind}-time`, { occurredAt: null });
    const missingIdentity = observation(kind, `${kind}_edited`, `${kind}-identity`, { definition: { id: null, node_id: null } });
    const result = board(metricId, [ghost, missingTime, missingIdentity]);
    assert.ok(result.rows.every(row => row.value === null));
    assert.equal(result.coverage, "incomplete");
    assert.equal(missingIdentity.facts.length, 0);
    const known = observation(kind, `${kind}_edited`, `${kind}-known`);
    const unknownArtifact = structuredClone(known);
    for (const fact of unknownArtifact.facts) fact.artifactId = null;
    assert.ok(board(metricId, [unknownArtifact]).audit.some(entry => entry.reason === "unknown_artifact_identity"));
  }
});

test("definition changes select their own artifact even alongside an issue; issue applications never become definition credit", () => {
  for (const [kind, metricId, action] of [["label", "label_taxonomy", "labeled"], ["milestone", "milestone_definitions", "milestoned"]]) {
    const definitions = Array.from({ length: 10 }, (_, index) => observation(kind, `${kind}_edited`, `${kind}-attached-${index}`, {
      payload: { issue: { ...fixture.issue, id: 1000 + index, node_id: `SYNTHETIC_ISSUE_${index}`, user: fixture.author } },
    }));
    assert.ok(definitions.every(result => result.facts.every(fact => fact.artifactId === `SYNTHETIC_${kind}_90`)));
    assert.deepEqual(values(board(metricId, definitions)), [[String(fixture.merger.id), 1]]);
    const applications = Array.from({ length: 10 }, (_, index) => observation(kind, action, `${kind}-application-${index}`, {
      payload: { issue: { ...fixture.issue, id: 1000 + index, node_id: `SYNTHETIC_ISSUE_${index}`, user: fixture.author } },
    }));
    assert.equal(applications.flatMap(result => result.facts).filter(fact => fact.metricId === metricId).length, 0);
    const missingDefinition = observation(kind, `${kind}_edited`, `${kind}-missing-definition`, {
      payload: { [kind]: null, issue: { ...fixture.issue, user: fixture.author } },
    });
    assert.equal(missingDefinition.facts.length, 0, "an issue cannot substitute for a missing definition artifact");
  }
});

test("independent receipt clocks remain separate from source days and never backfill a raw missing timestamp", () => {
  for (const [kind, metricId] of [["label", "label_taxonomy"], ["milestone", "milestone_definitions"]]) {
    const source = observation(kind, `${kind}_edited`, `${kind}-receipt-source`);
    const receipt = {
      id: `synthetic-${kind}-receipt`, verified: true, metricId, actorId: String(fixture.merger.id),
      reviewerId: "synthetic-independent-reviewer", acceptedAt: "2026-10-09T12:00:00Z", decision: "accepted",
      targetFactId: source.facts[0].id, evidenceIds: ["synthetic-reviewed-definition-proof"],
    };
    assert.throws(() => applyRecognitionReceipt(source, { ...receipt, reviewerId: receipt.actorId }, [receipt.actorId]), /Independent verified/);
    const accepted = applyRecognitionReceipt(source, receipt, [receipt.reviewerId]);
    assert.deepEqual(values(board(metricId, [accepted])), [[receipt.actorId, 1]]);
    for (const dateBasis of ["occurredAt", "acceptedAt"]) {
      const selected = board(metricId, [accepted], { rankedStates: ["qualified"], dateBasis });
      assert.deepEqual(values(selected), [[receipt.actorId, 1]]);
    }
    const originalDay = { ...scope, to: "2026-10-08T00:00:00Z" };
    assert.deepEqual(values(board(metricId, [accepted], { rankedStates: ["qualified"], dateBasis: "occurredAt" }, originalDay)), [[receipt.actorId, 1]]);
    assert.ok(board(metricId, [accepted], { rankedStates: ["qualified"], dateBasis: "acceptedAt" }, originalDay).rows.every(row => row.value === null));
    const unknownSource = observation(kind, `${kind}_edited`, `${kind}-receipt-time-unknown`, { occurredAt: null });
    const attested = applyRecognitionReceipt(unknownSource, { ...receipt, targetFactId: unknownSource.facts[0].id }, [receipt.reviewerId]);
    assert.ok(board(metricId, [attested]).rows.every(row => row.value === null));
    assert.ok(board(metricId, [attested], { rankedStates: ["qualified"], dateBasis: "occurredAt" }).rows.every(row => row.value === null));
    assert.deepEqual(values(board(metricId, [attested], { rankedStates: ["qualified"], dateBasis: "acceptedAt" })), [[receipt.actorId, 1]]);
  }
});

test("triage summaries distinguish raw actions, sessions, global artifacts and each actor's artifacts", () => {
  const event = (id, artifactId, actorId, occurredAt, patch = {}) => ({
    id, artifactId, actorId, occurredAt, facet: "label", targetId: "label:90", before: "absent", after: "present", ...patch,
  });
  const events = [
    event("a-1", "repo:1:issue:1", "a", "2026-10-07T10:00:00Z"),
    event("a-2", "repo:1:issue:1", "a", "2026-10-07T10:01:00Z", { before: "present", after: "absent" }),
    event("a-next-day", "repo:1:issue:1", "a", "2026-10-08T10:00:00Z"),
    event("b-same-artifact", "repo:1:issue:1", "b", "2026-10-07T10:00:00Z"),
    event("a-other-artifact", "repo:2:issue:1", "a", "2026-10-07T10:00:00Z"),
    event("missing-actor", "repo:1:issue:3", null, "2026-10-07T10:00:00Z"),
    event("missing-time", "repo:1:issue:4", "a", null),
    event("missing-artifact", "", "a", "2026-10-07T10:00:00Z"),
  ];
  const grouping = { version: "synthetic-sessions/v1", intervalSeconds: 300, cooldownSeconds: 3600 };
  const frozen = stableJSON(events), result = groupTriageTransitions(events.concat(events[0]), grouping);
  assert.equal(result.rawActions, 8);
  assert.equal(result.distinctArtifacts, 2);
  assert.equal(result.sessions.length, 4);
  assert.deepEqual(result.actorSummaries, [
    { actorId: "a", rawActions: 4, sessions: 3, distinctArtifacts: 2 },
    { actorId: "b", rawActions: 1, sessions: 1, distinctArtifacts: 1 },
  ]);
  assert.deepEqual(result.unknownEventIds, ["missing-actor", "missing-artifact", "missing-time"]);
  assert.equal(result.qualifiedOutcomes, 0);
  assert.equal(result.sessions.filter(session => session.reversalSuppressed).length, 1);
  assert.equal(stableJSON(groupTriageTransitions([...events].reverse(), grouping)), stableJSON(result));
  assert.equal(stableJSON(events), frozen);
});
