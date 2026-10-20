import assert from "node:assert/strict";
import test from "node:test";
import { relationshipPairNormalizationVersion } from "../../contracts/dist/index.js";
import { aggregateMetric, getMetricDefinition, participationView, selectPortfolioFacts } from "../dist/index.js";

const width = 200_000;
const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
const metricId = "pr_lines_changed";
function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
const scope = frozen({
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
const policy = frozen({
  metricId,
  version: "synthetic-revision-width-policy/v1",
  definitionVersion: "synthetic-revision-width-definition/v1",
  unit: getMetricDefinition(metricId).definition.unit,
  aggregation: "sum",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: true,
});
function fact(patch = {}) {
  return frozen({
    id: "synthetic-repeated-fact",
    canonicalKey: "synthetic-repeated-action",
    metricId,
    actorId: "synthetic-actor",
    artifactId: "synthetic-artifact",
    repoId: "synthetic-repo",
    role: "author",
    state: "qualified",
    occurredAt: "2026-10-04T10:00:00Z",
    acceptedAt: "2026-10-05T10:00:00Z",
    observedAt: "2026-10-06T10:00:00Z",
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: "synthetic-independent-acceptance",
    acceptedBy: "synthetic-reviewer",
    subjectActorId: "synthetic-actor",
    eventContext: null,
    currentContext: null,
    quantity: 1,
    ...patch,
  });
}
function input(facts, datasetId) {
  return frozen({
    datasetId,
    cutoff: to,
    backfillRevision: "synthetic-revision-width-history/v1",
    repositoryIds: ["synthetic-repo"],
    actors: [{ id: "synthetic-actor", login: "synthetic-person", kind: "user", publicState: "visible" }],
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
}
function repeated(value) {
  // Retain every array entry without allocating unrelated copies of immutable data.
  return Array.from({ length: width }, () => value);
}
function compareAggregate(t, facts, compact) {
  const source = input(facts, "synthetic-wide-history");
  const before = source.facts.slice();
  const expected = aggregateMetric(input(compact, "synthetic-compact-history"), policy, scope);
  t.diagnostic(`Synthetic immutable fact history: ${facts.length} entries`);
  const actual = aggregateMetric(source, policy, scope);
  // The two explicit dataset identities remain distinct; all calculation fields agree.
  assert.deepEqual(actual, { ...expected, datasetId: source.datasetId });
  assert.deepEqual(source.facts, before);
  assert.equal(actual.publicEnabled, false);
  assert.equal(actual.policyVersion, policy.version);
  assert.equal(actual.definitionVersion, policy.definitionVersion);
  return actual;
}

test("wide same-revision observations retain one fact and its earliest observation", (t) => {
  const earlier = fact();
  const later = fact({ observedAt: "2026-10-07T10:00:00Z" });
  const result = compareAggregate(t, [later, earlier, ...repeated(later)], [later, earlier]);
  assert.equal(result.coverage, "complete");
  assert.equal(result.rows.length, 1);
  assert.deepEqual([result.rows[0].value, result.rows[0].sampleCount, result.rows[0].rank], [1, 1, 1]);
  assert.equal(result.rows[0].evidence[0].observedAt, earlier.observedAt);
  assert.deepEqual(result.rows[0].evidenceIds, [earlier.id]);
});

for (const position of ["first", "last"]) {
  test(`wide history selects the greatest reviewed revision placed ${position}`, (t) => {
    const original = fact();
    const lower = fact({ revision: 1, correctionReceipt: "synthetic-correction-1", quantity: 3 });
    const highest = fact({
      revision: Number.MAX_SAFE_INTEGER,
      correctionReceipt: "synthetic-correction-highest",
      quantity: 7,
    });
    const facts =
      position === "first" ? [highest, ...repeated(original), lower] : [lower, ...repeated(original), highest];
    const result = compareAggregate(t, facts, [original, lower, highest]);
    assert.equal(result.rows[0].value, 7);
    assert.equal(JSON.parse(result.rows[0].evidence[0].comparisonSignature)[1], Number.MAX_SAFE_INTEGER);
  });
}

test("wide history preserves cutoff and unreviewed-correction exclusions", (t) => {
  const original = fact();
  const reviewed = fact({ revision: 1, correctionReceipt: "synthetic-correction-1", quantity: 7 });
  const unreviewed = fact({ revision: 2, quantity: 11 });
  const future = fact({
    revision: 3,
    correctionReceipt: "synthetic-future-correction",
    observedAt: "2026-11-02T00:00:00Z",
    state: "excluded",
  });
  const result = compareAggregate(
    t,
    [future, ...repeated(original), reviewed, unreviewed],
    [original, reviewed, unreviewed, future],
  );
  assert.deepEqual([result.rows[0].value, result.rows[0].state, result.coverage], [7, "partial", "incomplete"]);
  assert.deepEqual(
    result.audit.map((entry) => entry.reason),
    ["included_sum_qualified", "observation_after_cutoff", "unreviewed_revision"],
  );
});

test("wide history keeps conflicting latest revisions unavailable", (t) => {
  const original = fact();
  const left = fact({ revision: 1, correctionReceipt: "synthetic-correction-1", quantity: 7 });
  const right = fact({ ...left, quantity: 9 });
  const result = compareAggregate(t, [left, ...repeated(original), right], [original, left, right]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.coverage, "incomplete");
  assert.deepEqual(result.audit, [
    { factIds: [original.id], actorId: original.actorId, reason: "conflicting_revision" },
  ]);
});

test("wide history does not revive a fact excluded by its latest reviewed revision", (t) => {
  const original = fact();
  const excluded = fact({ revision: 1, correctionReceipt: "synthetic-exclusion", state: "excluded" });
  const result = compareAggregate(t, [excluded, ...repeated(original)], [original, excluded]);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(
    result.audit.map((entry) => entry.reason),
    ["excluded_by_policy_or_correction"],
  );
});

test("portfolio selection accepts wide immutable histories without changing the selected fact", (t) => {
  const earlier = fact();
  const later = fact({ observedAt: "2026-10-07T10:00:00Z" });
  const source = input([...repeated(later), earlier], "synthetic-wide-portfolio");
  const before = source.facts.slice();
  t.diagnostic(`Synthetic immutable fact history: ${source.facts.length} entries`);
  assert.deepEqual(selectPortfolioFacts(source, policy, scope), [earlier]);
  assert.deepEqual(source.facts, before);
});

test("participation retains unknown history and one active week for wide repeated observations", (t) => {
  const original = fact();
  const source = input(repeated(original), "synthetic-wide-participation");
  const compact = input([original], "synthetic-compact-participation");
  const before = source.facts.slice();
  t.diagnostic(`Synthetic immutable fact history: ${source.facts.length} entries`);
  const result = participationView(source, policy, scope);
  assert.deepEqual(result, participationView(compact, policy, scope));
  assert.equal(result.length, 1);
  assert.equal(result[0].newcomer, null);
  assert.equal(result[0].historyCoverage, "incomplete");
  assert.deepEqual(result[0].activeWeeks, ["2026-10-05T00:00:00.000Z"]);
  assert.deepEqual(source.facts, before);
});

test("empty revision history preserves empty aggregates and selectors", () => {
  const source = input([], "synthetic-empty-history");
  assert.deepEqual(aggregateMetric(source, policy, scope).rows, []);
  assert.deepEqual(selectPortfolioFacts(source, policy, scope), []);
  assert.deepEqual(participationView(source, policy, scope), []);
});

test("invalid revisions still fail admission before revision selection", () => {
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    const source = input(
      [fact(), fact({ revision, correctionReceipt: "synthetic-invalid-correction" })],
      "synthetic-invalid-history",
    );
    assert.throws(() => aggregateMetric(source, policy, scope), /Invalid fact revision/);
  }
});

test("wide conflicting highest-revision buckets remain unavailable", (t) => {
  const original = fact();
  const left = fact({ revision: 1, correctionReceipt: "synthetic-correction-1", quantity: 7 });
  const right = fact({ ...left, quantity: 9 });
  const result = compareAggregate(t, [original, ...repeated(left), right], [original, left, right]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.coverage, "incomplete");
  assert.deepEqual(result.audit, [
    { factIds: [original.id], actorId: original.actorId, reason: "conflicting_revision" },
  ]);
});

test("wide relationship-pair audits retain every unbound fact and conflicting pair", (t) => {
  const pairMetricId = "closing_links";
  const pairPolicy = frozen({
    ...policy,
    metricId: pairMetricId,
    unit: getMetricDefinition(pairMetricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["triager"],
    groupBy: "canonical",
    groupingPolicyVersion: relationshipPairNormalizationVersion,
    rank: false,
  });
  const pairFact = (id, patch = {}) =>
    fact({
      id,
      canonicalKey: id,
      metricId: pairMetricId,
      repoId: "2",
      role: "triager",
      state: "observed",
      acceptedAt: null,
      acceptedBy: null,
      acceptanceReceipt: null,
      ...patch,
    });
  const pairInput = (facts, datasetId) => {
    const source = input(facts, datasetId);
    return frozen({
      ...source,
      repositoryIds: ["2"],
      coverage: source.coverage.map((entry) => ({ ...entry, scopeId: "2" })),
    });
  };
  const pair = (eventId) => ({
    version: relationshipPairNormalizationVersion,
    kind: "closing",
    action: "connect",
    eventId,
    from: { repositoryId: "2", artifactId: "synthetic-artifact", kind: "pull_request" },
    to: { repositoryId: "2", artifactId: "synthetic-target", kind: "issue" },
  });
  const left = pairFact("synthetic-bound-left", {
    relationshipPair: pair("synthetic-bound-event-left"),
    eventContext: { projects: [], workstreams: [] },
  });
  const right = pairFact("synthetic-bound-right", {
    relationshipPair: pair("synthetic-bound-event-right"),
    eventContext: { projects: ["synthetic-project"], workstreams: [] },
  });
  // Distinct identities reach conservation individually. Repeated observations
  // of one ID would collapse before the audit append being exercised here.
  const unbound = Array.from({ length: width }, (_, index) =>
    pairFact("synthetic-unbound-" + String(index).padStart(6, "0")),
  );
  const compact = aggregateMetric(
    pairInput([unbound[0], left, right], "synthetic-compact-pair-audit"),
    pairPolicy,
    scope,
  );
  assert.deepEqual(compact.rows, []);
  assert.equal(compact.coverage, "incomplete");
  assert.deepEqual(compact.audit, [
    {
      factIds: [left.id, right.id],
      actorId: left.actorId,
      reason: "ambiguous_relationship_pair",
    },
    {
      factIds: [unbound[0].id],
      actorId: unbound[0].actorId,
      reason: "relationship_pair_unverified",
    },
  ]);
  const source = pairInput([left, ...unbound, right], "synthetic-wide-pair-audit");
  const before = source.facts.slice();
  t.diagnostic("Synthetic immutable pair audit: " + (width + 1) + " expected entries");
  const actual = aggregateMetric(source, pairPolicy, scope);
  assert.deepEqual(actual, {
    ...compact,
    datasetId: source.datasetId,
    audit: [compact.audit[0]].concat(
      unbound.map((item) => ({
        factIds: [item.id],
        actorId: item.actorId,
        reason: "relationship_pair_unverified",
      })),
    ),
  });
  assert.equal(actual.audit.length, width + 1);
  assert.equal(actual.publicEnabled, false);
  assert.deepEqual(source.facts, before);
});
