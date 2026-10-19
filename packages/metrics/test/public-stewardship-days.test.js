import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { metricRegistrySchema } from "@pick-your-ai/contracts";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../github/dist/index.js";
import {
  aggregateMetric,
  getMetricDefinition,
  getMetricGroupingPolicy,
  getMetricUi,
  metricRegistryV1,
  selectMetricView,
  selectPortfolioFacts,
  stableJSON,
  validateMetricPolicy,
} from "../dist/index.js";

// Synthetic, explicitly verified source envelopes exercise existing admission
// and grouping. They are not installed-source, consent or moderation evidence.
const fixture = JSON.parse(
  await readFile(new URL("../../github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const metricId = "public_moderation";
const grouping = {
  version: "public-stewardship-day/v1",
  metric_id: metricId,
  state: "observed",
  date_basis: "occurredAt",
  group_by: "actor_artifact_interval",
  grouping_seconds: 86400,
  interval_origin: "1970-01-01T00:00:00Z",
  raw_state_rule: "facets_share_stewardship_unit",
  repeated_state_rule: "one_actor_item_per_utc_day",
  missing_state_or_time: "exclude_unknown",
  semantic_classifier: "none",
  public_enabled: false,
  receipt_lenses: [
    { state: "qualified", date_basis: "occurredAt" },
    { state: "qualified", date_basis: "acceptedAt" },
  ],
};
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
const actions = ["pinned", "unpinned", "locked", "unlocked"];
function policy(patch = {}) {
  return {
    metricId,
    version: "synthetic-public-stewardship/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: grouping.date_basis,
    rankedStates: [grouping.state],
    roles: ["triager"],
    groupBy: grouping.group_by,
    groupingSeconds: grouping.grouping_seconds,
    groupingPolicyVersion: grouping.version,
    sources: ["github_webhook"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
}
function observation(action, id, patch = {}) {
  const {
    occurredAt = "2026-10-07T10:00:00Z",
    observedAt = "2026-10-10T00:00:00Z",
    sender = fixture.merger,
    issue = {},
    payload = {},
    repositoryId = 2,
    visibility = "public",
    proof = {},
  } = patch;
  return normalizeGithubObservation({
    repository: {
      id: repositoryId,
      slug: "synthetic-owner/repository",
      visibility,
      defaultBranch: "main",
    },
    proof: {
      verified: true,
      source: "github_webhook",
      revision: id,
      eventId: id,
      isSynthetic: true,
      ...proof,
    },
    family: "triage",
    action,
    occurredAt,
    observedAt,
    payload: { issue: { ...structuredClone(fixture.issue), user: fixture.author, ...issue }, sender, ...payload },
  });
}
function input(results) {
  return {
    datasetId: "synthetic-public-stewardship-days",
    cutoff: scope.to,
    backfillRevision: "synthetic-1",
    repositoryIds: [...new Set(results.flatMap((result) => result.facts.map((fact) => fact.repoId)))],
    actors: [...new Map(results.flatMap((result) => result.actors).map((actor) => [actor.id, actor])).values()],
    facts: results.flatMap((result) => result.facts),
    coverage: [],
  };
}
function board(results, patch = {}, window = scope) {
  return aggregateMetric(input(results), policy(patch), window);
}
const values = (result) => result.rows.filter((row) => row.value !== null).map((row) => [row.actorId, row.value]);
function receipt(source, patch = {}) {
  return {
    verified: true,
    id: "synthetic-stewardship-acceptance",
    metricId,
    actorId: String(fixture.merger.id),
    reviewerId: String(fixture.reviewer.id),
    acceptedAt: "2026-10-09T12:00:00Z",
    decision: "accepted",
    targetFactId: source.facts[0].id,
    evidenceIds: ["synthetic-sanitized-review-reference"],
    ...patch,
  };
}
function accepted(source, patch = {}) {
  const decision = receipt(source, patch);
  return applyRecognitionReceipt(source, decision, [String(fixture.reviewer.id)]);
}

test("public stewardship causal: the exact day profile is admitted by the strict registry", () => {
  const candidate = structuredClone(metricRegistryV1);
  candidate.grouping_policies = candidate.grouping_policies.filter((entry) => entry.metric_id !== metricId);
  candidate.grouping_policies.push(structuredClone(grouping));
  const parsed = metricRegistrySchema.safeParse(candidate);
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message);
});

test("public stewardship causal: raw canonical event counting cannot replace actor/item/day grouping", () => {
  assert.throws(
    () =>
      validateMetricPolicy(
        policy({ groupBy: "canonical", groupingSeconds: undefined, groupingPolicyVersion: undefined }),
      ),
    /exact versioned grouping/,
  );
});

test("public stewardship causal: pin, unpin, lock and unlock share one actor/item/day", () => {
  const results = actions.map((action, i) =>
    observation(action, `synthetic-transition-${i}`, {
      occurredAt: `2026-10-07T${String(10 + i).padStart(2, "0")}:00:00Z`,
    }),
  );
  const result = board(results);
  assert.deepEqual(values(result), [[String(fixture.merger.id), 1]]);
  assert.equal(result.rows[0].sampleCount, 1);
  assert.equal(
    result.audit.filter((entry) => entry.reason === "repeated_policy_unit").flatMap((entry) => entry.factIds).length,
    3,
  );
  assert.equal(result.rows[0].rank, null);
  assert.equal(result.publicEnabled, false);
});

test("public stewardship baseline: existing raw transitions retain action, actor, source time and identities", () => {
  const results = actions.map((action, i) => observation(action, `synthetic-raw-${i}`));
  const facts = results.flatMap((result) => result.facts);
  assert.equal(facts.length, 4);
  assert.equal(new Set(facts.map((fact) => fact.canonicalKey)).size, 4);
  assert.equal(new Set(facts.map((fact) => fact.id)).size, 4);
  for (const [i, fact] of facts.entries()) {
    assert.equal(fact.metricId, metricId);
    assert.equal(fact.actorId, String(fixture.merger.id));
    assert.equal(fact.role, "triager");
    assert.equal(fact.occurredAt, "2026-10-07T10:00:00.000Z");
    assert.equal(fact.state, "observed");
    assert.equal(fact.rawState, `${actions[i]}:unknown`);
    assert.equal(fact.acceptedAt, null);
    assert.equal(fact.acceptanceReceipt, null);
    assert.equal(results[i].evidence[0].evidenceMetadata.sourceAction, actions[i]);
  }
});

test("public stewardship baseline: the 98-definition registry leaves this descriptive view unadvertised", () => {
  metricRegistrySchema.parse(metricRegistryV1);
  assert.equal(metricRegistryV1.metrics.length, 98);
  assert.equal(getMetricDefinition(metricId).definition.release_eligibility, "descriptive-only");
  const ui = getMetricUi(metricId);
  assert.equal(ui.maturity, "definition_only");
  assert.deepEqual(ui.supported_states, []);
  assert.deepEqual(ui.supported_date_bases, []);
  assert.deepEqual(ui.supported_combinations, []);
  assert.equal(ui.default_combination, null);
  assert.deepEqual(ui.lead_view, { overview: false, wall: false, order: null });
  assert.throws(() => selectMetricView(metricId), /No supported selectable view/);
});

test("public stewardship: the profile permits exactly three separate evidence/clock lenses and no rank", () => {
  assert.deepEqual(getMetricGroupingPolicy(metricId), grouping);
  validateMetricPolicy(policy());
  for (const dateBasis of ["occurredAt", "acceptedAt"]) {
    validateMetricPolicy(policy({ rankedStates: ["qualified"], dateBasis }));
  }
  assert.throws(() => validateMetricPolicy(policy({ rank: true })), /Descriptive metrics cannot rank/);
  for (const patch of [
    { groupBy: "actor_artifact" },
    { groupBy: "actor_artifact_state_interval" },
    { groupingPolicyVersion: "triage-definition-day/v1" },
    { groupingPolicyVersion: "public-stewardship-day/v2" },
    { groupingSeconds: 3600 },
    { groupingSeconds: 172800 },
    { rankedStates: ["observed"], dateBasis: "acceptedAt" },
    { rankedStates: ["reviewed"] },
    { roles: ["author"] },
    { roles: ["triager", "author"] },
  ])
    assert.throws(() => validateMetricPolicy(policy(patch)), /exact versioned grouping/, JSON.stringify(patch));
  assert.throws(
    () => validateMetricPolicy(policy({ rankedStates: ["observed", "qualified"] })),
    /Exactly one evidence class/,
  );
});

test("public stewardship: strict schema rejects widened profiles, duplicate mappings and invented UI clock pairs", () => {
  for (const patch of [
    { version: "triage-definition-day/v1" },
    { metric_id: "labels_applied" },
    { group_by: "actor_artifact_state_interval" },
    { grouping_seconds: 3600 },
    { interval_origin: "2026-10-07T00:00:00Z" },
    { raw_state_rule: "exact_source_value" },
    { repeated_state_rule: "one_actor_definition_per_utc_day" },
    { missing_state_or_time: "fill_from_observed_at" },
    { semantic_classifier: "moderation_quality" },
    { public_enabled: true },
    { receipt_lenses: [{ state: "observed", date_basis: "acceptedAt" }] },
    { unexpected: true },
  ]) {
    const candidate = structuredClone(metricRegistryV1);
    Object.assign(
      candidate.grouping_policies.find((entry) => entry.metric_id === metricId),
      patch,
    );
    assert.equal(metricRegistrySchema.safeParse(candidate).success, false, JSON.stringify(patch));
  }
  const duplicate = structuredClone(metricRegistryV1);
  duplicate.grouping_policies.push(structuredClone(grouping));
  assert.equal(metricRegistrySchema.safeParse(duplicate).success, false);
  const advertised = structuredClone(metricRegistryV1);
  const ui = advertised.ui_metadata.metrics.find((entry) => entry.metric_id === metricId);
  Object.assign(ui, {
    maturity: "synthetic_verified",
    verification_cases: ["synthetic-case"],
    supported_states: ["observed"],
    supported_date_bases: ["acceptedAt"],
    supported_combinations: [{ state: "observed", date_basis: "acceptedAt" }],
    default_combination: { state: "observed", date_basis: "acceptedAt" },
  });
  const parsed = metricRegistrySchema.safeParse(advertised);
  assert.equal(parsed.success, false);
  assert.match(parsed.error.message, /Every triage selection must match/);
});

test("public stewardship: UTC midnight, exact replay and input ordering preserve daily units and raw portfolio facts", () => {
  const results = [
    observation("pinned", "synthetic-before-midnight", { occurredAt: "2026-10-07T23:59:59.999Z" }),
    observation("unpinned", "synthetic-same-last-instant", { occurredAt: "2026-10-07T23:59:59.999Z" }),
    observation("locked", "synthetic-midnight", { occurredAt: "2026-10-08T00:00:00Z" }),
    observation("unlocked", "synthetic-later-day", { occurredAt: "2026-10-08T23:59:59.999Z" }),
  ];
  const frozen = input(results),
    before = stableJSON(frozen);
  const result = aggregateMetric(frozen, policy(), scope);
  assert.deepEqual(values(result), [[String(fixture.merger.id), 2]]);
  assert.equal(stableJSON(board([...results].reverse().concat(results[0]))), stableJSON(result));
  assert.deepEqual(values(board(results, {}, { ...scope, to: "2026-10-08T00:00:00Z" })), [
    [String(fixture.merger.id), 1],
  ]);
  assert.deepEqual(values(board(results, {}, { ...scope, from: "2026-10-08T00:00:00Z" })), [
    [String(fixture.merger.id), 1],
  ]);
  const raw = selectPortfolioFacts(frozen, policy(), scope);
  assert.deepEqual(raw.map((fact) => fact.id).sort(), frozen.facts.map((fact) => fact.id).sort());
  assert.equal(stableJSON(frozen), before);
});

test("public stewardship: actors, item identities and repository namespaces remain separate without author credit", () => {
  const first = observation("pinned", "synthetic-first");
  const nextItem = observation("unpinned", "synthetic-other-item", { issue: { id: 21, node_id: "I_synthetic_21" } });
  const nextRepo = structuredClone(first);
  for (const fact of nextRepo.facts) {
    fact.id += ":other-repository";
    fact.canonicalKey += ":other-repository";
    fact.repoId = "3";
  }
  const nextActor = observation("locked", "synthetic-other-actor", { sender: fixture.reviewer });
  const results = [first, nextItem, nextRepo, nextActor];
  assert.deepEqual(values(board(results)), [
    [String(fixture.merger.id), 3],
    [String(fixture.reviewer.id), 1],
  ]);
  assert.equal(
    board(results).rows.some((row) => row.actorId === String(fixture.author.id)),
    false,
  );
});

test("public stewardship: existing item IDs stay exact, repository keys separate them and aliases are not guessed", () => {
  const results = [
    observation("pinned", "synthetic-fallback-number", { issue: { node_id: null } }),
    observation("unpinned", "synthetic-fallback-rename", {
      issue: { node_id: null, title: "Changed display title" },
    }),
    observation("locked", "synthetic-fallback-repository", { repositoryId: 3, issue: { node_id: null } }),
  ];
  assert.equal(results[0].facts[0].artifactId, "github:issue:20");
  assert.equal(results[0].facts[0].artifactId, results[1].facts[0].artifactId);
  assert.equal(results[0].facts[0].artifactId, results[2].facts[0].artifactId);
  assert.notEqual(results[0].facts[0].repoId, results[2].facts[0].repoId);
  assert.deepEqual(values(board(results)), [[String(fixture.merger.id), 2]]);
  const opaque = observation("locked", "synthetic-opaque-id", { issue: { node_id: null, id: "20" } });
  assert.equal(opaque.facts[0].artifactId, "20", "The existing opaque provider identity is not rewritten");
  assert.notEqual(opaque.facts[0].artifactId, results[0].facts[0].artifactId);
  assert.deepEqual(values(board([...results, opaque])), [[String(fixture.merger.id), 3]]);
});

test("public stewardship: unknown actor, item or occurrence never borrows a current actor, title or collection time", () => {
  const unknownActor = observation("pinned", "synthetic-unknown-actor", { sender: null });
  assert.ok(unknownActor.reasons.includes("unknown_actor"));
  assert.deepEqual(values(board([unknownActor])), []);
  const unknownItem = observation("pinned", "synthetic-unknown-item", {
    issue: { id: null, node_id: null, title: "An item title is not identity" },
  });
  assert.deepEqual(unknownItem.facts, []);
  assert.ok(unknownItem.reasons.includes("missing_public_artifact_identity"));
  for (const occurredAt of [null, "not-an-instant", "2026-10-07T10:00:00-04:00", "2026-10-07T10:00:00.000000001Z"]) {
    const result = observation("locked", "synthetic-unknown-clock", { occurredAt });
    assert.equal(result.facts[0].occurredAt, null);
    assert.equal(result.facts[0].state, "unknown");
    assert.deepEqual(values(board([result])), [], String(occurredAt));
  }
  const missingItemFact = input([observation("locked", "synthetic-missing-item-fact")]);
  missingItemFact.facts[0].artifactId = null;
  const result = aggregateMetric(missingItemFact, policy(), scope);
  assert.deepEqual(values(result), []);
  assert.ok(result.audit.some((entry) => entry.reason === "unknown_artifact_identity"));
});

test("public stewardship: unsupported snapshots and actions cannot manufacture pin or moderation history", () => {
  for (const action of ["snapshot", "comment_pinned", "discussion_locked", "member_banned", "report_resolved"]) {
    const result = observation(action, `synthetic-unsupported-${action}`, {
      issue: { pinnedBy: fixture.merger, pinnedAt: "2026-10-07T10:00:00Z", locked: true },
    });
    assert.deepEqual(result.facts, [], action);
    assert.ok(result.reasons.includes("unsupported_or_unproven_triage_action"), action);
  }
  const missingEvent = observation("pinned", "synthetic-missing-event", { proof: { eventId: undefined } });
  assert.deepEqual(missingEvent.facts, []);
  assert.ok(missingEvent.reasons.includes("unsupported_or_unproven_triage_action"));
});

test("public stewardship: private or revoked sources and suppressed actors remain outside the descriptive result", () => {
  for (const patch of [
    { visibility: "private" },
    { visibility: "unknown" },
    { payload: { repository: { id: 2, private: true } } },
    { payload: { repository: { id: 3, private: false } } },
  ])
    assert.deepEqual(observation("locked", "synthetic-nonpublic", patch).facts, []);
  const frozen = input([observation("locked", "synthetic-suppressed")]);
  frozen.actors.find((actor) => actor.id === String(fixture.merger.id)).publicState = "suppressed";
  const result = aggregateMetric(frozen, policy(), scope);
  assert.deepEqual(values(result), []);
  assert.ok(result.audit.some((entry) => entry.reason === "suppressed"));
});

test("public stewardship: projected public evidence excludes restricted reasons and does not infer justification", () => {
  const privateMarker = "synthetic-private-reason-not-public-evidence";
  const result = observation("locked", "synthetic-redaction", {
    issue: { active_lock_reason: privateMarker, moderation_report: privateMarker, body: privateMarker },
    payload: { reason: privateMarker, private_report: privateMarker, sanction: privateMarker },
  });
  assert.equal(result.facts.length, 1);
  assert.equal(stableJSON(result).includes(privateMarker), false);
  assert.equal(result.facts[0].acceptedAt, null);
  assert.equal(result.facts[0].acceptanceReceipt, null);
  assert.equal(result.evidence[0].evidenceMetadata.activityState, "observed");
  assert.deepEqual(values(board([result])), [[String(fixture.merger.id), 1]]);
});

test("public stewardship: independent same-metric receipts never add another source-day unit or mix evidence classes", () => {
  const source = observation("locked", "synthetic-receipt-source");
  const before = stableJSON(source);
  const first = accepted(source);
  const alias = accepted(source, { id: "synthetic-second-receipt", changesetId: "synthetic-distinct-receipt-alias" });
  const results = [source, first, alias];
  assert.equal(stableJSON(source), before);
  assert.equal(first.facts[1].occurredAt, source.facts[0].occurredAt);
  for (const patch of [
    {},
    { rankedStates: ["qualified"], dateBasis: "occurredAt" },
    { rankedStates: ["qualified"], dateBasis: "acceptedAt" },
  ]) {
    assert.deepEqual(values(board(results, patch)), [[String(fixture.merger.id), 1]]);
    assert.equal(board(results, patch).rows[0].evidenceIds.length, 1);
  }
  const beforeAcceptanceDay = { ...scope, to: "2026-10-08T00:00:00Z" };
  assert.deepEqual(
    values(board([first], { rankedStates: ["qualified"], dateBasis: "occurredAt" }, beforeAcceptanceDay)),
    [[String(fixture.merger.id), 1]],
  );
  assert.deepEqual(
    values(board([first], { rankedStates: ["qualified"], dateBasis: "acceptedAt" }, beforeAcceptanceDay)),
    [],
  );
});

test("public stewardship: receipt time stays separate from missing source time and no arbitrary action gains qualification", () => {
  const unknownSource = observation("locked", "synthetic-receipt-unknown-clock", { occurredAt: null });
  const qualified = accepted(unknownSource);
  assert.deepEqual(values(board([qualified])), []);
  assert.deepEqual(values(board([qualified], { rankedStates: ["qualified"], dateBasis: "occurredAt" })), []);
  assert.deepEqual(values(board([qualified], { rankedStates: ["qualified"], dateBasis: "acceptedAt" })), [
    [String(fixture.merger.id), 1],
  ]);
  assert.equal(qualified.facts[0].occurredAt, null);
  assert.equal(qualified.facts[1].occurredAt, null);
  const source = observation("locked", "synthetic-receipt-guard");
  for (const patch of [
    { verified: false },
    { reviewerId: String(fixture.merger.id) },
    { reviewerId: "999" },
    { actorId: String(fixture.author.id) },
    { evidenceIds: [] },
    { acceptedAt: "not-a-time" },
  ])
    assert.throws(() => accepted(source, patch), /Independent verified recognition receipt/);
  const unrelated = observation("labeled", "synthetic-unrelated-source", { payload: { label: { id: 90 } } });
  assert.throws(() => accepted(unrelated), /Independent verified recognition receipt/);
});

test("public stewardship: reviewed corrections remove only their actual event and preserve the other daily evidence", () => {
  const results = actions.map((action, i) => observation(action, `synthetic-correction-${i}`));
  const frozen = input(results),
    before = stableJSON(frozen);
  const correction = (fact) => ({
    ...fact,
    state: "excluded",
    revision: 1,
    correctionReceipt: "synthetic-reviewed-source-correction",
    observedAt: "2026-10-10T12:00:00Z",
  });
  const oneRemoved = { ...frozen, facts: [...frozen.facts, correction(frozen.facts[0])] };
  assert.deepEqual(values(aggregateMetric(oneRemoved, policy(), scope)), [[String(fixture.merger.id), 1]]);
  const allRemoved = { ...frozen, facts: [...frozen.facts, ...frozen.facts.map(correction)] };
  assert.deepEqual(values(aggregateMetric(allRemoved, policy(), scope)), []);
  const beforeCorrection = { ...scope, to: "2026-10-10T06:00:00Z" };
  const historical = { ...allRemoved, cutoff: beforeCorrection.to };
  assert.deepEqual(values(aggregateMetric(historical, policy(), beforeCorrection)), [[String(fixture.merger.id), 1]]);
  assert.equal(stableJSON(frozen), before);
});
