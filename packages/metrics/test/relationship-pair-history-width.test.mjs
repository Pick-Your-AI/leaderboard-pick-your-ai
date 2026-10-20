import assert from "node:assert/strict";
import test from "node:test";
import { relationshipPairNormalizationVersion } from "../../contracts/dist/index.js";
import { aggregateMetric, getMetricDefinition } from "../dist/index.js";
import { conserveRelationshipPairs } from "../dist/relationship-pairs.js";

function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

function descriptor(eventId, patch = {}) {
  return frozen({
    version: relationshipPairNormalizationVersion,
    kind: "closing",
    action: "connect",
    eventId,
    from: { repositoryId: "2", artifactId: "PR_synthetic_history", kind: "pull_request" },
    to: { repositoryId: "2", artifactId: "I_synthetic_history", kind: "issue" },
    ...patch,
  });
}

function fact(id, patch = {}) {
  return frozen({
    id,
    canonicalKey: id,
    metricId: "closing_links",
    actorId: "synthetic-actor",
    artifactId: "PR_synthetic_history",
    repoId: "2",
    role: "triager",
    state: "observed",
    occurredAt: "2026-10-04T10:00:00Z",
    observedAt: "2026-10-06T10:00:00Z",
    acceptedAt: null,
    acceptedBy: null,
    acceptanceReceipt: null,
    subjectActorId: "synthetic-actor",
    revision: 0,
    correctionReceipt: null,
    eventContext: null,
    currentContext: null,
    quantity: 1,
    relationshipPair: descriptor(id + "-event"),
    ...patch,
  });
}

function unbound(value, patch = {}) {
  const { relationshipPair, ...rest } = value;
  return frozen({ ...rest, ...patch });
}

const from = "2026-10-01T00:00:00Z";
const to = "2026-11-01T00:00:00Z";
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
  metricId: "closing_links",
  version: "synthetic-pair-history-width-policy/v1",
  definitionVersion: "synthetic-pair-history-width-definition/v1",
  unit: getMetricDefinition("closing_links").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["triager"],
  groupBy: "canonical",
  groupingPolicyVersion: relationshipPairNormalizationVersion,
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
});

function input(facts, datasetId) {
  return frozen({
    datasetId,
    cutoff: to,
    backfillRevision: "synthetic-pair-history-width/v1",
    repositoryIds: ["2"],
    actors: [{ id: "synthetic-actor", login: "synthetic-person", kind: "user", publicState: "visible" }],
    facts,
    coverage: [
      {
        schemaVersion: "leaderboard/v1",
        state: "complete",
        source: "github_rest",
        scopeId: "2",
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

function conserve(facts, rejected, history, repositoryIds = ["2"]) {
  const source = frozen({ facts, rejected, history, repositoryIds });
  const before = JSON.stringify(source);
  const result = conserveRelationshipPairs(source.facts, source.rejected, source.repositoryIds, source.history);
  assert.equal(JSON.stringify(source), before);
  return result;
}

function ambiguity(...facts) {
  return {
    factIds: [...new Set(facts.map((item) => item.id))].sort(),
    actorId: "synthetic-actor",
    reason: "ambiguous_relationship_pair",
  };
}

test("displaced pair history bounds source reads while matching compact aggregate uncertainty", (t) => {
  const width = 512;
  const original = fact("synthetic-displaced-pair");
  const left = unbound(original, { revision: 1, correctionReceipt: "synthetic-correction", quantity: 7 });
  const right = frozen({ ...left, quantity: 9 });
  const later = fact("synthetic-later-pair", { occurredAt: "2026-10-05T10:00:00Z" });
  let armed = false,
    reads = 0;
  const budget = 16 * (2 * width + 2);
  const observed = Object.freeze({
    ...original,
    get relationshipPair() {
      if (armed) {
        reads++;
        assert.ok(reads <= budget, "displaced history must not rescan every prior for every rejection");
      }
      return original.relationshipPair;
    },
  });
  const source = input(
    [
      ...Array.from({ length: width }, () => observed),
      ...Array.from({ length: width }, () => left),
      right,
      later,
    ],
    "synthetic-bounded-pair-history",
  );
  const compact = aggregateMetric(
    input([original, left, right, later], "synthetic-compact-pair-history"),
    policy,
    scope,
  );
  assert.deepEqual(compact.rows, []);
  assert.equal(compact.coverage, "incomplete");
  assert.deepEqual(compact.audit, [
    ambiguity(original, later),
    { factIds: [original.id], actorId: original.actorId, reason: "conflicting_revision" },
  ]);
  const reversed = input([...source.facts].reverse(), "synthetic-reversed-pair-history");
  for (const candidate of [source, reversed]) {
    const before = JSON.stringify(candidate);
    let actual;
    // Only calculation is metered. Fixture freezing and equality checks may read
    // the same immutable descriptor without representing a history traversal.
    reads = 0;
    armed = true;
    try {
      actual = aggregateMetric(candidate, policy, scope);
    } finally {
      armed = false;
    }
    assert.ok(reads > 0);
    assert.ok(reads <= budget);
    t.diagnostic(candidate.datasetId + " descriptor reads: " + reads + "; linear budget: " + budget);
    assert.deepEqual(actual, { ...compact, datasetId: candidate.datasetId });
    assert.equal(actual.publicEnabled, false);
    assert.equal(JSON.stringify(candidate), before);
  }
});

test("unresolved pair thresholds retain the maximum revision in either order and source channel", () => {
  const prior = fact("synthetic-maximum-prior", { revision: 1, correctionReceipt: "synthetic-prior-review" });
  const later = fact("synthetic-maximum-later", { occurredAt: "2026-10-05T10:00:00Z" });
  const low = unbound(prior, { revision: 1, correctionReceipt: "synthetic-low-review" });
  const high = unbound(prior, { revision: 3, correctionReceipt: "synthetic-high-review" });
  const expected = { facts: [], audit: [ambiguity(prior, later)] };
  for (const rejected of [
    [low, high],
    [high, low],
  ]) {
    assert.deepEqual(conserve([later], rejected, [prior]), expected);
    assert.deepEqual(conserve([later], [...rejected, ...rejected], [prior, prior]), expected);
  }
  assert.deepEqual(conserve([later, high], [low], [prior]), {
    facts: [],
    audit: [
      { factIds: [high.id], actorId: high.actorId, reason: "relationship_pair_unverified" },
      ambiguity(prior, later),
    ],
  });
});

test("unresolved history thresholds keep same-ID reference and closing metrics separate", () => {
  for (const kind of ["closing", "reference"]) {
    const metricId = kind === "closing" ? "closing_links" : "reference_links";
    const otherMetricId = kind === "closing" ? "reference_links" : "closing_links";
    const pair = descriptor("synthetic-metric-prior", { kind, action: kind === "closing" ? "connect" : "reference" });
    const prior = fact("synthetic-shared-history-id", {
      metricId,
      revision: 1,
      correctionReceipt: "synthetic-prior-review",
      relationshipPair: pair,
    });
    const later = fact("synthetic-metric-later", {
      metricId,
      occurredAt: "2026-10-05T10:00:00Z",
      relationshipPair: frozen({ ...pair, eventId: "synthetic-metric-later-event" }),
    });
    const same = unbound(prior, { revision: 1, correctionReceipt: "synthetic-same-review" });
    const other = unbound(prior, {
      metricId: otherMetricId,
      revision: 3,
      correctionReceipt: "synthetic-other-review",
    });
    assert.deepEqual(conserve([later], [other, same], [prior]), { facts: [later], audit: [] });
    assert.deepEqual(conserve([later], [same, other], [prior]), { facts: [later], audit: [] });
    const higherSame = frozen({ ...same, revision: 2 });
    assert.deepEqual(conserve([later], [other, higherSame], [prior]), {
      facts: [],
      audit: [ambiguity(prior, later)],
    });
  }
});

test("admitted later reviewed pair revisions resolve only older rejected revisions", () => {
  const prior = fact("synthetic-resolved-prior");
  const corrected = fact(prior.id, {
    revision: 2,
    correctionReceipt: "synthetic-resolved-review",
    occurredAt: "2026-10-05T10:00:00Z",
    relationshipPair: descriptor("synthetic-resolved-event"),
  });
  const later = fact("synthetic-resolved-later", { occurredAt: "2026-10-06T10:00:00Z" });
  const rejected = unbound(prior, { revision: 1, correctionReceipt: "synthetic-rejected-review" });
  assert.deepEqual(conserve([corrected, later], [rejected], [prior]), {
    facts: [corrected],
    audit: [{ factIds: [later.id], actorId: later.actorId, reason: "repeated_relationship_pair" }],
  });
  for (const revision of [2, 3])
    assert.deepEqual(conserve([corrected, later], [frozen({ ...rejected, revision })], [prior]), {
      facts: [],
      audit: [ambiguity(prior, later)],
    });
});

test("historical uncertainty retains strict revision descriptor disconnect clock and endpoint gates", () => {
  const prior = fact("synthetic-gated-prior");
  const later = fact("synthetic-gated-later", { occurredAt: "2026-10-05T10:00:00Z" });
  const rejected = unbound(prior, { revision: 2, correctionReceipt: "synthetic-gated-review" });
  const cases = [
    ["earlier supported revision", prior, true],
    ["unrelated fact ID", fact("synthetic-unrelated-history-id"), false],
    ["equal revision", fact(prior.id, { revision: 2, correctionReceipt: "synthetic-equal-review" }), false],
    ["later revision", fact(prior.id, { revision: 3, correctionReceipt: "synthetic-later-review" }), false],
    ["missing descriptor", unbound(prior), false],
    ["invalid descriptor", fact(prior.id, { relationshipPair: { ...prior.relationshipPair, extra: true } }), false],
    ["wrong metric descriptor", fact(prior.id, { metricId: "reference_links" }), false],
    ["wrong evidence endpoint", fact(prior.id, { artifactId: "synthetic-unrelated-artifact" }), false],
    ["disconnect", fact(prior.id, { relationshipPair: { ...prior.relationshipPair, action: "disconnect" } }), false],
    ["later historical clock", fact(prior.id, { occurredAt: "2026-10-06T10:00:00Z" }), false],
    ["unknown historical clock", fact(prior.id, { occurredAt: null }), true],
  ];
  for (const [label, history, blocked] of cases)
    assert.deepEqual(
      conserve([later], [rejected], [history]),
      blocked ? { facts: [], audit: [ambiguity(prior, later)] } : { facts: [later], audit: [] },
      label,
    );
  for (const missing of ["from", "to"]) {
    const pair = descriptor("synthetic-private-history", {
      [missing]: { ...prior.relationshipPair[missing], repositoryId: "3" },
    });
    const artifactId = missing === "from" ? pair.to.artifactId : pair.from.artifactId;
    const history = fact(prior.id, { artifactId, relationshipPair: pair });
    const unavailable = fact("synthetic-unavailable-current", {
      artifactId,
      relationshipPair: frozen({ ...pair, eventId: "synthetic-unavailable-current-event" }),
    });
    assert.deepEqual(conserve([later, unavailable], [rejected], [history]), {
      facts: [later],
      audit: [
        {
          factIds: [unavailable.id],
          actorId: unavailable.actorId,
          reason: "relationship_pair_repository_unavailable",
        },
      ],
    });
  }
});
