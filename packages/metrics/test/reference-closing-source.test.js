import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGithubObservation, relationshipPairNormalizationVersion } from "../../github/dist/index.js";
import {
  aggregateMetric,
  getMetricDefinition,
  metricRegistryV1,
  stableJSON,
  validateMetricPolicy,
} from "../dist/index.js";

// Synthetic, explicitly enriched relationship observations. These exercise the
// real normalizer and engine, not native timeline collection or a live grant.
const actor = { id: 202, node_id: "U_synthetic_202", type: "User", login: "synthetic-linker" };
const author = { id: 101, node_id: "U_synthetic_101", type: "User", login: "synthetic-author" };
const assignee = { id: 303, node_id: "U_synthetic_303", type: "User", login: "synthetic-assignee" };
const occurredAt = "2026-10-05T10:00:00Z";
const observedAt = "2026-10-10T10:00:00Z";
const cutoff = "2026-10-12T00:00:00Z";
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-11T00:00:00Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const kinds = [
  { kind: "reference", metricId: "reference_links", action: "referenced" },
  { kind: "closing", metricId: "closing_links", action: "connected" },
];

function source({ kind, action }, options = {}) {
  const number = options.number ?? 20;
  return {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: {
      verified: true,
      source: "github_graphql",
      revision: "synthetic-relationship-source/v1",
      eventId: options.eventId ?? "synthetic-link-event-1",
      isSynthetic: true,
    },
    family: "relationship",
    action: options.action ?? action,
    occurredAt: options.occurredAt ?? occurredAt,
    observedAt: options.observedAt ?? observedAt,
    payload: {
      repository: { id: 2, private: false },
      issue: {
        id: number,
        node_id: `I_synthetic_${number}`,
        number,
        html_url: `https://github.com/synthetic-owner/repository/issues/${number}`,
        created_at: "2026-09-01T00:00:00Z",
        user: author,
        assignees: [assignee],
        body: "Untrusted text: accepted, resolves #20, blocked by #20.",
      },
      sender: actor,
      relationship: {
        kind,
        from: options.from ?? "PR_synthetic_10",
        to: options.to ?? `I_synthetic_${number}`,
        intentional: true,
        publicEndpointsVerified: true,
        pair: {
          version: relationshipPairNormalizationVersion,
          kind,
          action:
            kind === "reference"
              ? "reference"
              : (options.action ?? action) === "disconnected"
                ? "disconnect"
                : "connect",
          eventId: options.eventId ?? "synthetic-link-event-1",
          from: {
            repositoryId: "2",
            artifactId: options.from ?? "PR_synthetic_10",
            kind: options.fromKind ?? "pull_request",
          },
          to: { repositoryId: "2", artifactId: options.to ?? `I_synthetic_${number}`, kind: options.toKind ?? "issue" },
        },
      },
    },
  };
}

function policy(metricId) {
  return {
    metricId,
    version: "synthetic-relationship-source/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["triager"],
    groupBy: "canonical",
    groupingPolicyVersion: relationshipPairNormalizationVersion,
    sources: ["github_graphql"],
    minimumSamples: 1,
    rank: false,
  };
}

function frozen(outputs) {
  return {
    datasetId: "synthetic-reference-closing",
    cutoff,
    backfillRevision: "synthetic-reference-closing/v1",
    repositoryIds: ["2"],
    actors: [...new Map(outputs.flatMap((output) => output.actors).map((item) => [item.id, item])).values()],
    facts: outputs.flatMap((output) => output.facts),
    coverage: [],
  };
}

const calculate = (outputs, metricId) => aggregateMetric(frozen(outputs), policy(metricId), scope);
const quantity = (result) => result.rows.map((row) => [row.actorId, row.value, row.state, row.rank]);

for (const definition of kinds) {
  const { kind, metricId } = definition;

  test(`${metricId} counts distinct enriched pairs for the connection actor, not the author or assignee`, () => {
    const inputs = [source(definition), source(definition, { number: 21, eventId: "synthetic-link-event-2" })];
    const before = stableJSON(inputs);
    const outputs = inputs.map((input) => normalizeGithubObservation(input));
    assert.equal(stableJSON(inputs), before);
    assert.deepEqual(
      outputs.flatMap((output) => output.facts.map((fact) => [fact.metricId, fact.actorId, fact.role, fact.rawState])),
      [
        [metricId, "202", "triager", kind],
        [metricId, "202", "triager", kind],
      ],
    );
    for (const output of outputs) {
      assert.equal(output.isSynthetic, true);
      assert.equal(output.facts[0].subjectActorId, "101");
      assert.equal(output.facts[0].occurredAt, "2026-10-05T10:00:00.000Z");
      assert.equal(output.facts[0].state, "observed");
      assert.equal(output.facts[0].acceptanceReceipt, null);
      assert.equal(output.facts[0].acceptedAt, null);
      assert.deepEqual(output.evidence[0].contribution.reasonCodes, ["raw_observed_only"]);
    }
    const result = calculate(outputs, metricId);
    assert.deepEqual(quantity(result), [["202", 2, "partial", null]]);
    assert.equal(result.rows[0].evidenceIds.length, 2);
    assert.equal(result.coverage, "incomplete");
    assert.equal(result.publicEnabled, false);
  });

  test(`${metricId} conserves one event across replay, later observation and input order`, () => {
    const first = normalizeGithubObservation(source(definition));
    const later = normalizeGithubObservation(source(definition, { observedAt: "2026-10-11T10:00:00Z" }));
    assert.equal(first.facts[0].id, later.facts[0].id);
    assert.equal(first.facts[0].canonicalKey, later.facts[0].canonicalKey);
    const forward = frozen([first, later, first]);
    const before = stableJSON(forward);
    const result = aggregateMetric(forward, policy(metricId), scope);
    assert.deepEqual(quantity(result), [["202", 1, "partial", null]]);
    assert.deepEqual(result, calculate([later, first, later], metricId));
    assert.equal(stableJSON(forward), before);
  });

  test(`${metricId} excludes automatic, incomplete and private or unverified endpoint observations`, () => {
    const cases = [
      ["automatic reference", (input) => (input.payload.relationship.intentional = false)],
      ["missing intention", (input) => delete input.payload.relationship.intentional],
      ["missing event proof", (input) => delete input.proof.eventId],
      ["missing source endpoint", (input) => delete input.payload.relationship.from],
      ["missing target endpoint", (input) => delete input.payload.relationship.to],
      ["private endpoint", (input) => (input.payload.relationship.publicEndpointsVerified = false)],
      ["unknown endpoint visibility", (input) => delete input.payload.relationship.publicEndpointsVerified],
      ["private repository", (input) => (input.payload.repository.private = true)],
    ];
    for (const [label, change] of cases) {
      const input = source(definition);
      change(input);
      const output = normalizeGithubObservation(input);
      assert.deepEqual(output.facts, [], label);
      assert.deepEqual(output.evidence, [], label);
      const result = calculate([output], metricId);
      assert.deepEqual(result.rows, [], label);
      assert.equal(result.coverage, "incomplete", label);
      assert.equal(result.publicEnabled, false, label);
    }
    const unverified = source(definition);
    unverified.proof.verified = false;
    assert.throws(() => normalizeGithubObservation(unverified), /Verified repository\/source envelope is required/);
  });

  test(`${metricId} does not borrow a missing actor or event time from the issue or observation`, () => {
    for (const missing of ["actor", "time"]) {
      const input = source(definition);
      if (missing === "actor") delete input.payload.sender;
      else input.occurredAt = null;
      const output = normalizeGithubObservation(input);
      assert.equal(output.facts.length, 1);
      assert.equal(output.facts[0].state, "unknown");
      if (missing === "actor") assert.equal(output.facts[0].actorId, null);
      else assert.equal(output.facts[0].occurredAt, null);
      const result = calculate([output], metricId);
      assert.deepEqual(result.rows, []);
      assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
      assert.equal(result.coverage, "incomplete");
    }
  });

  test(`${metricId} uses source event time in the half-open window, not later observation time`, () => {
    const outputs = ["2026-09-30T23:59:59Z", scope.from, "2026-10-10T23:59:59Z", scope.to].map((at, index) =>
      normalizeGithubObservation(
        source(definition, {
          number: 30 + index,
          eventId: `synthetic-boundary-${index}`,
          occurredAt: at,
          observedAt: "2026-10-11T10:00:00Z",
        }),
      ),
    );
    const result = calculate(outputs, metricId);
    assert.deepEqual(quantity(result), [["202", 2, "partial", null]]);
    assert.deepEqual(new Set(result.rows[0].evidenceIds), new Set([outputs[1].facts[0].id, outputs[2].facts[0].id]));
    assert.equal(result.audit.filter((entry) => entry.reason === "outside_window").length, 2);
  });
}

test("reference_links preserves direction instead of collapsing opposite source and target pairs", () => {
  const definition = kinds[0];
  const forward = normalizeGithubObservation(source(definition));
  const reverse = normalizeGithubObservation(
    source(definition, {
      from: "I_synthetic_20",
      fromKind: "issue",
      to: "PR_synthetic_10",
      toKind: "pull_request",
      eventId: "synthetic-reverse-event",
    }),
  );
  assert.notEqual(forward.facts[0].canonicalKey, reverse.facts[0].canonicalKey);
  assert.deepEqual(quantity(calculate([forward, reverse], "reference_links")), [["202", 2, "partial", null]]);
  assert.deepEqual(calculate([forward, reverse], "closing_links").rows, []);
  assert.deepEqual(calculate([forward, reverse], "blocker_links").rows, []);
});

test("closing_links requires explicit closing semantics rather than reference text or accepted-judgment words", () => {
  const reference = normalizeGithubObservation(source(kinds[0]));
  const closing = normalizeGithubObservation(source(kinds[1], { eventId: "synthetic-closing-event" }));
  assert.deepEqual(calculate([reference], "closing_links").rows, []);
  assert.deepEqual(quantity(calculate([reference, closing], "reference_links")), [["202", 1, "partial", null]]);
  assert.deepEqual(quantity(calculate([reference, closing], "closing_links")), [["202", 1, "partial", null]]);
  assert.ok([reference, closing].every((output) => output.facts.every((fact) => fact.state === "observed")));
  assert.deepEqual(calculate([reference, closing], "issue_resolution").rows, []);
  assert.deepEqual(calculate([reference, closing], "accepted_findings").rows, []);
});

test("closing_links conserves one canonical PR and issue pair through disconnect and reconnect", () => {
  // The decided metric definition says disconnect/reconnect cannot multiply
  // delivery. All three observations concern the same actor and endpoint pair.
  const outputs = [
    ["connected", "2026-10-05T10:00:00Z"],
    ["disconnected", "2026-10-05T11:00:00Z"],
    ["connected", "2026-10-05T12:00:00Z"],
  ].map(([action, at], index) =>
    normalizeGithubObservation(
      source(kinds[1], { action, occurredAt: at, eventId: `synthetic-closing-transition-${index}` }),
    ),
  );
  const result = calculate(outputs, "closing_links");
  assert.deepEqual(quantity(result), [["202", 1, "partial", null]]);
  assert.deepEqual(result, calculate([...outputs].reverse(), "closing_links"));
});

function mirror(input) {
  const copy = structuredClone(input);
  copy.payload.pull_request = {
    id: 10,
    node_id: "PR_synthetic_10",
    number: 10,
    html_url: "https://github.com/synthetic-owner/repository/pull/10",
    user: assignee,
  };
  delete copy.payload.issue;
  return copy;
}

for (const definition of kinds) {
  const { metricId } = definition;
  test(`${metricId} retains only the first independently identified pair event and its actor`, () => {
    const first = source(definition);
    const later = source(definition, { eventId: "synthetic-new-event", occurredAt: "2026-10-06T10:00:00Z" });
    later.payload.sender = assignee;
    const outputs = [first, later].map((input) => normalizeGithubObservation(input));
    assert.notEqual(outputs[0].observations[0].id, outputs[1].observations[0].id);
    const result = calculate(outputs, metricId);
    assert.deepEqual(quantity(result), [["202", 1, "partial", null]]);
    assert.deepEqual(result.rows[0].evidenceIds, [outputs[0].facts[0].id]);
    assert.ok(result.audit.some((entry) => entry.reason === "repeated_relationship_pair"));
    assert.deepEqual(result, calculate(outputs.reverse(), metricId));
  });

  test(`${metricId} does not move an old pair into a later reporting window or actor lens`, () => {
    const first = source(definition, { occurredAt: "2026-09-30T10:00:00Z" });
    first.payload.sender = { ...actor, type: "Bot" };
    const later = source(definition, { eventId: "synthetic-later-user", occurredAt: "2026-10-06T10:00:00Z" });
    later.payload.sender = assignee;
    const outputs = [first, later].map((input) => normalizeGithubObservation(input));
    assert.deepEqual(calculate(outputs, metricId).rows, []);
    assert.deepEqual(aggregateMetric(frozen(outputs), policy(metricId), { ...scope, actors: "all" }).rows, []);
  });

  test(`${metricId} cannot promote a later event past an unknown first actor or unorderable clock`, () => {
    for (const missing of ["actor", "time"]) {
      const first = source(definition);
      if (missing === "actor") delete first.payload.sender;
      else first.occurredAt = null;
      const later = source(definition, { eventId: "synthetic-after-unknown", occurredAt: "2026-10-06T10:00:00Z" });
      const outputs = [first, later].map((input) => normalizeGithubObservation(input));
      const result = calculate(outputs, metricId);
      assert.deepEqual(result.rows, [], missing);
      assert.ok(
        result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"),
        missing,
      );
    }
  });

  test(`${metricId} leaves tied first actors ambiguous instead of awarding both or sorting one`, () => {
    const first = source(definition);
    const other = source(definition, { eventId: "synthetic-tied-other-actor" });
    other.payload.sender = assignee;
    const outputs = [first, other].map((input) => normalizeGithubObservation(input));
    const result = calculate(outputs, metricId);
    assert.deepEqual(result.rows, []);
    assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
    assert.deepEqual(result, calculate(outputs.reverse(), metricId));
  });

  test(`${metricId} conserves same-scope endpoint mirrors while retaining native action and truthful artifact kinds`, () => {
    const input = source(definition);
    const outputs = [input, mirror(input)].map((input) => normalizeGithubObservation(input));
    assert.equal(outputs[0].observations[0].id, outputs[1].observations[0].id);
    assert.notEqual(outputs[0].facts[0].id, outputs[1].facts[0].id);
    assert.deepEqual(
      outputs.map((output) => output.evidence[0].artifact.kind),
      ["issue", "pull_request"],
    );
    const result = calculate(outputs, metricId);
    assert.deepEqual(quantity(result), [["202", 1, "partial", null]]);
    assert.deepEqual(result, calculate(outputs.reverse(), metricId));
    assert.equal(outputs.flatMap((output) => output.observations).length, 2);
  });

  test(`${metricId} treats equivalent reordered membership sets as the same mirror scope`, () => {
    const input = source(definition);
    const other = mirror(input);
    input.eventContext = input.currentContext = {
      projects: ["synthetic-project-a", "synthetic-project-b"],
      workstreams: ["synthetic-workstream-a", "synthetic-workstream-b"],
      workstreamsKnown: true,
      projectScope: ["synthetic-project-a", "synthetic-project-b"],
      workstreamScope: ["synthetic-workstream-a", "synthetic-workstream-b"],
    };
    other.eventContext = other.currentContext = {
      ...input.eventContext,
      projects: [...input.eventContext.projects].reverse(),
      workstreams: [...input.eventContext.workstreams].reverse(),
      projectScope: [...input.eventContext.projectScope].reverse(),
      workstreamScope: [...input.eventContext.workstreamScope].reverse(),
    };
    const outputs = [input, other].map((value) => normalizeGithubObservation(value));
    const before = stableJSON(outputs);
    assert.deepEqual(quantity(calculate(outputs, metricId)), [["202", 1, "partial", null]]);
    assert.deepEqual(calculate(outputs, metricId), calculate([...outputs].reverse(), metricId));
    assert.equal(stableJSON(outputs), before);
    const replay = structuredClone(outputs[0]);
    replay.facts[0].eventContext = structuredClone(outputs[1].facts[0].eventContext);
    replay.facts[0].currentContext = structuredClone(outputs[1].facts[0].currentContext);
    assert.deepEqual(quantity(calculate([outputs[0], replay], metricId)), [["202", 1, "partial", null]]);
    assert.deepEqual(calculate([outputs[0], replay], metricId), calculate([replay, outputs[0]], metricId));
    replay.facts[0].id = "synthetic-other-adapter";
    assert.deepEqual(quantity(calculate([outputs[0], replay], metricId)), [["202", 1, "partial", null]]);
    outputs[1].facts[0].currentContext.workstreamsKnown = false;
    assert.deepEqual(calculate(outputs, metricId).rows, []);
  });

  test(`${metricId} rejects ambiguous mirror membership and cross-repository attribution`, () => {
    const input = source(definition);
    const differentContext = mirror(input);
    differentContext.eventContext = { projects: ["synthetic-project"], workstreams: [] };
    const contextResult = calculate(
      [input, differentContext].map((input) => normalizeGithubObservation(input)),
      metricId,
    );
    assert.deepEqual(contextResult.rows, []);
    assert.ok(contextResult.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));

    const cross = source(definition);
    cross.payload.relationship.pair.from.repositoryId = "3";
    const crossMirror = mirror(cross);
    crossMirror.repository = { ...crossMirror.repository, id: 3, slug: "synthetic-owner/other" };
    crossMirror.payload.repository.id = 3;
    crossMirror.payload.pull_request.html_url = "https://github.com/synthetic-owner/other/pull/10";
    const outputs = [cross, crossMirror].map((input) => normalizeGithubObservation(input));
    const inputSet = { ...frozen(outputs), repositoryIds: ["2", "3"] };
    const result = aggregateMetric(inputSet, policy(metricId), scope);
    assert.deepEqual(result.rows, []);
    assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
  });

  test(`${metricId} requires a bound private descriptor and both authorized endpoint repositories`, () => {
    const changes = [
      (input) => delete input.payload.relationship.pair,
      (input) => {
        input.payload.relationship.pair.version = "future-version";
      },
      (input) => {
        input.payload.relationship.pair.eventId = "wrong-event";
      },
      (input) => {
        input.payload.relationship.pair.to.artifactId = "unbound-target";
      },
      (input) => {
        input.payload.relationship.pair.to.kind = "pull_request";
      },
      (input) => {
        input.payload.relationship.pair.extra = true;
      },
      (input) => {
        input.action = "snapshot";
      },
    ];
    for (const change of changes) {
      const input = source(definition);
      change(input);
      const output = normalizeGithubObservation(input);
      assert.equal(output.observations.length, 1);
      assert.deepEqual(calculate([output], metricId).rows, []);
    }
    const cross = source(definition);
    cross.payload.relationship.pair.from.repositoryId = "3";
    const result = calculate([normalizeGithubObservation(cross)], metricId);
    assert.deepEqual(result.rows, []);
    assert.ok(result.audit.some((entry) => entry.reason === "relationship_pair_repository_unavailable"));
  });

  test(`${metricId} does not promote a later pair after an identifiable earlier revision or canonical conflict`, () => {
    const first = normalizeGithubObservation(source(definition));
    const later = normalizeGithubObservation(
      source(definition, { eventId: "synthetic-later-valid", occurredAt: "2026-10-06T10:00:00Z" }),
    );
    for (const conflict of ["revision", "canonical", "unreviewed"]) {
      const input = frozen([first, later]);
      const bad = structuredClone(first.facts[0]);
      if (conflict === "unreviewed") {
        bad.revision = 1;
        bad.correctionReceipt = null;
      } else {
        bad.actorId = "101";
        if (conflict === "canonical") bad.id += ":other-view";
      }
      input.facts.push(bad);
      const result = aggregateMetric(input, policy(metricId), scope);
      assert.deepEqual(result.rows, [], conflict);
      assert.ok(
        result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"),
        conflict,
      );
    }
  });

  test(`${metricId} keeps an independent known positive pair partial alongside ambiguous history`, () => {
    const unknown = source(definition);
    unknown.occurredAt = null;
    const positive = source(definition, { number: 21, eventId: "synthetic-independent-positive" });
    const result = calculate(
      [unknown, positive].map((input) => normalizeGithubObservation(input)),
      metricId,
    );
    assert.deepEqual(quantity(result), [["202", 1, "partial", null]]);
    assert.equal(result.coverage, "incomplete");
    assert.equal(result.publicEnabled, false);
  });
}

test("closing_links canonicalizes reversed typed endpoint representation without changing the native events", () => {
  const first = source(kinds[1]);
  const reverse = source(kinds[1], {
    from: "I_synthetic_20",
    fromKind: "issue",
    to: "PR_synthetic_10",
    toKind: "pull_request",
    eventId: "synthetic-reverse-closing",
  });
  const outputs = [first, reverse].map((input) => normalizeGithubObservation(input));
  assert.notEqual(outputs[0].observations[0].id, outputs[1].observations[0].id);
  assert.deepEqual(quantity(calculate(outputs, "closing_links")), [["202", 1, "partial", null]]);
});

test("closing_links disconnect alone creates no credit and never resets the original period", () => {
  const disconnected = normalizeGithubObservation(source(kinds[1], { action: "disconnected" }));
  assert.equal(disconnected.facts[0].state, "excluded");
  assert.deepEqual(calculate([disconnected], "closing_links").rows, []);
  assert.equal(disconnected.observations[0].action, "disconnected");
});

test("relationship conservation precedes Project filtering and a reviewed exclusion does not elect a later actor", () => {
  const first = source(kinds[1]);
  first.eventContext = { projects: ["old-project"], workstreams: [] };
  const later = source(kinds[1], { eventId: "synthetic-other-project", occurredAt: "2026-10-06T10:00:00Z" });
  later.eventContext = { projects: ["new-project"], workstreams: [] };
  const outputs = [first, later].map((input) => normalizeGithubObservation(input));
  assert.deepEqual(
    aggregateMetric(frozen(outputs), policy("closing_links"), { ...scope, projects: ["new-project"] }).rows,
    [],
  );
  const corrected = frozen(outputs);
  corrected.facts.push({
    ...outputs[0].facts[0],
    state: "excluded",
    revision: 1,
    correctionReceipt: "synthetic-reviewed-correction",
  });
  assert.deepEqual(aggregateMetric(corrected, policy("closing_links"), scope).rows, []);
});

test("a conflicting native event clock stays ambiguous while a future observation does not rewrite the frozen past", () => {
  const first = normalizeGithubObservation(source(kinds[0]));
  const changed = normalizeGithubObservation(source(kinds[0], { occurredAt: "2026-10-06T10:00:00Z" }));
  const result = calculate([first, changed], "reference_links");
  assert.deepEqual(result.rows, []);
  assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
  changed.facts[0].observedAt = "2026-10-13T00:00:00Z";
  assert.deepEqual(quantity(calculate([first, changed], "reference_links")), [["202", 1, "partial", null]]);
});

test("relationship policies cannot collapse pairs by artifact, replace the first clock or change the evidence lens", () => {
  for (const { metricId } of kinds) {
    const base = policy(metricId);
    validateMetricPolicy(base);
    for (const changed of [
      { groupBy: "actor_artifact" },
      { groupBy: "actor_artifact_state_interval", groupingSeconds: 3600 },
      { dateBasis: "acceptedAt" },
      { rankedStates: ["qualified"] },
      { roles: ["author"] },
      { roles: ["triager", "author"] },
      { groupingPolicyVersion: undefined },
      { groupingPolicyVersion: "future" },
      { groupingSeconds: 3600 },
    ])
      assert.throws(() => validateMetricPolicy({ ...base, ...changed }), /Relationship pairs require/);
  }
});

test("one native relationship event cannot acquire two different endpoint pairs", () => {
  for (const definition of kinds) {
    const first = source(definition);
    const contradictory = source(definition, { from: "PR_synthetic_11" });
    const outputs = [first, contradictory].map((input) => normalizeGithubObservation(input));
    assert.notEqual(outputs[0].facts[0].id, outputs[1].facts[0].id);
    const result = calculate(outputs, definition.metricId);
    assert.deepEqual(result.rows, []);
    assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_event"));
    assert.deepEqual(result, calculate(outputs.reverse(), definition.metricId));
  }
});

test("one native event cannot claim both reference and closing semantics, while independent events remain separate", () => {
  const reference = normalizeGithubObservation(source(kinds[0]));
  const closing = normalizeGithubObservation(source(kinds[1]));
  for (const { metricId } of kinds) {
    const result = calculate([reference, closing], metricId);
    assert.deepEqual(result.rows, []);
    assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_event"));
    assert.deepEqual(result, calculate([closing, reference], metricId));
  }
  const separate = normalizeGithubObservation(source(kinds[1], { eventId: "synthetic-independent-closing" }));
  assert.deepEqual(quantity(calculate([reference, separate], "reference_links")), [["202", 1, "partial", null]]);
  assert.deepEqual(quantity(calculate([reference, separate], "closing_links")), [["202", 1, "partial", null]]);
});

test("a later reviewed revision resolves its own old rejected value but not an unresolved newer revision", () => {
  for (const definition of kinds) {
    const output = normalizeGithubObservation(source(definition));
    const original = output.facts[0];
    const stale = { ...original, revision: 1, correctionReceipt: null };
    const current = { ...original, revision: 2, correctionReceipt: "synthetic-reviewed-current" };
    const input = frozen([output]);
    input.facts.push(stale, current);
    assert.deepEqual(quantity(aggregateMetric(input, policy(definition.metricId), scope)), [
      ["202", 1, "partial", null],
    ]);
    input.facts.push({ ...current, revision: 3, correctionReceipt: null });
    const unresolved = aggregateMetric(input, policy(definition.metricId), scope);
    assert.deepEqual(unresolved.rows, []);
    assert.ok(unresolved.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
  }
});

for (const definition of kinds) {
  test(`${definition.metricId} keeps an unbound reviewed revision's prior pair as uncertainty without reviving old credit`, () => {
    const first = normalizeGithubObservation(source(definition, { eventId: "synthetic-lineage-first" }));
    const later = normalizeGithubObservation(
      source(definition, {
        eventId: "synthetic-lineage-later",
        occurredAt: "2026-10-06T10:00:00Z",
      }),
    );
    for (const patch of [
      { relationshipPair: undefined, occurredAt: "2026-10-09T10:00:00Z" },
      { relationshipPair: { ...first.facts[0].relationshipPair, version: "unsupported" }, occurredAt: null },
    ]) {
      const current = { ...first.facts[0], ...patch, revision: 2, correctionReceipt: "synthetic-reviewed-unbound" };
      const input = { ...frozen([first, later]), facts: [first.facts[0], current, later.facts[0]] };
      const before = stableJSON(input);
      const result = aggregateMetric(input, policy(definition.metricId), scope);
      assert.deepEqual(result.rows, []);
      assert.equal(result.coverage, "incomplete");
      assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
      assert.deepEqual(
        result,
        aggregateMetric({ ...input, facts: [...input.facts].reverse() }, policy(definition.metricId), scope),
      );
      assert.deepEqual(
        aggregateMetric(input, policy(definition.metricId), { ...scope, from: "2026-10-06T00:00:00Z" }).rows,
        [],
      );
      assert.equal(stableJSON(input), before);
    }
    const corrected = normalizeGithubObservation(
      source(definition, {
        eventId: "synthetic-lineage-first",
        from: "PR_synthetic_11",
      }),
    );
    const current = {
      ...corrected.facts[0],
      id: first.facts[0].id,
      revision: 2,
      correctionReceipt: "synthetic-reviewed-bound",
    };
    const input = { ...frozen([first, corrected, later]), facts: [first.facts[0], current, later.facts[0]] };
    assert.deepEqual(quantity(aggregateMetric(input, policy(definition.metricId), scope)), [
      ["202", 2, "partial", null],
    ]);
    const selected = aggregateMetric(input, policy(definition.metricId), { ...scope, from: "2026-10-06T00:00:00Z" });
    assert.deepEqual(quantity(selected), [["202", 1, "partial", null]]);
    assert.deepEqual(selected.rows[0].evidenceIds, [later.facts[0].id]);
  });

  test(`${definition.metricId} withholds a bound pair when its newer unreviewed revision loses its descriptor or changes clock`, () => {
    const output = normalizeGithubObservation(source(definition));
    const current = { ...output.facts[0], revision: 2, correctionReceipt: "synthetic-reviewed-current" };
    for (const patch of [
      { relationshipPair: undefined },
      { relationshipPair: { version: "invalid" } },
      { relationshipPair: undefined, occurredAt: "2026-10-08T10:00:00Z" },
      { relationshipPair: undefined, occurredAt: null },
    ]) {
      const newer = { ...current, ...patch, revision: 3, correctionReceipt: null };
      const input = { ...frozen([output]), facts: [current, newer] };
      const before = stableJSON(input);
      const result = aggregateMetric(input, policy(definition.metricId), scope);
      assert.deepEqual(result.rows, []);
      assert.equal(result.coverage, "incomplete");
      assert.ok(result.audit.some((entry) => entry.reason === "ambiguous_relationship_pair"));
      assert.deepEqual(
        result,
        aggregateMetric({ ...input, facts: [newer, current] }, policy(definition.metricId), scope),
      );
      assert.equal(stableJSON(input), before);
      const stale = { ...newer, revision: 1 };
      assert.deepEqual(
        quantity(aggregateMetric({ ...input, facts: [stale, current] }, policy(definition.metricId), scope)),
        [["202", 1, "partial", null]],
      );
    }
  });
}

test("cross-kind conflict audit is metric-scoped and future counterparts cannot alter the frozen past", () => {
  const reference = normalizeGithubObservation(source(kinds[0]));
  const closing = normalizeGithubObservation(source(kinds[1]));
  const result = calculate([reference, closing], "reference_links");
  assert.ok(result.audit.every((entry) => entry.factIds.every((id) => id === reference.facts[0].id)));
  closing.facts[0].observedAt = "2026-10-13T00:00:00Z";
  assert.deepEqual(quantity(calculate([reference, closing], "reference_links")), [["202", 1, "partial", null]]);
});

for (const definition of kinds) {
  const { metricId } = definition;
  test(`${metricId} keeps pair credits independent of merge-target branch scopes`, () => {
    const input = frozen([normalizeGithubObservation(source(definition))]);
    const before = stableJSON(input);
    assert.deepEqual(quantity(aggregateMetric(input, policy(metricId), scope)), [["202", 1, "partial", null]]);
    assert.throws(
      () => aggregateMetric(input, policy(metricId), { ...scope, repos: ["2"], branch: "main" }),
      /Merge-target filtering is unsupported for this metric/,
    );
    assert.equal(stableJSON(input), before);
  });
}

// Frozen JSON facts can omit unknown contexts. Keep two independently supported
// native events here so canonical replay deduplication cannot hide the pair tie.
function tiedPairInput(definition) {
  const outputs = ["a", "b"].map((suffix) =>
    normalizeGithubObservation(source(definition, { eventId: `synthetic-context-tie-${suffix}` })),
  );
  assert.notEqual(outputs[0].observations[0].id, outputs[1].observations[0].id);
  const input = frozen(outputs);
  assert.equal(input.facts.length, 2);
  const [first, second] = input.facts;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.canonicalKey, second.canonicalKey);
  assert.notEqual(first.relationshipPair.eventId, second.relationshipPair.eventId);
  assert.deepEqual(first.relationshipPair.from, second.relationshipPair.from);
  assert.deepEqual(first.relationshipPair.to, second.relationshipPair.to);
  assert.equal(first.occurredAt, second.occurredAt);
  for (const fact of input.facts) {
    for (const field of ["eventContext", "currentContext"]) {
      assert.equal(Object.hasOwn(fact, field), true);
      assert.equal(fact[field], null);
    }
  }
  return input;
}

function aggregatePairInput(input, metricId, selectedScope = scope) {
  const before = structuredClone(input);
  const result = aggregateMetric(input, policy(metricId), selectedScope);
  assert.deepEqual(input, before);
  for (const [index, fact] of input.facts.entries()) {
    for (const field of ["eventContext", "currentContext"]) {
      assert.equal(Object.hasOwn(fact, field), Object.hasOwn(before.facts[index], field));
    }
  }
  return result;
}

function assertConservedPair(input, result) {
  const ids = input.facts.map((fact) => fact.id).sort();
  assert.deepEqual(quantity(result), [["202", 1, "partial", null]]);
  assert.deepEqual(result.rows[0].evidenceIds, [ids[0]]);
  assert.deepEqual(result.audit, [
    { factIds: [ids[0]], actorId: "202", reason: "included_count_observed" },
    { factIds: [ids[1]], actorId: "202", reason: "repeated_relationship_pair" },
  ]);
  assert.equal(result.coverage, "incomplete");
  assert.equal(result.publicEnabled, false);
}

for (const definition of kinds) {
  const { metricId } = definition;
  for (const fields of [["eventContext"], ["currentContext"], ["eventContext", "currentContext"]]) {
    test(`${metricId} conserves tied independent events with omitted ${fields.join(" and ")}`, () => {
      const input = tiedPairInput(definition);
      const control = aggregatePairInput(input, metricId);
      assertConservedPair(input, control);
      for (const omittedIndex of [0, 1]) {
        const candidate = structuredClone(input);
        for (const field of fields) {
          delete candidate.facts[omittedIndex][field];
          assert.equal(Object.hasOwn(candidate.facts[omittedIndex], field), false);
        }
        for (const facts of [candidate.facts, [...candidate.facts].reverse()]) {
          assert.deepEqual(aggregatePairInput({ ...candidate, facts }, metricId), control);
        }
      }
    });
  }

  for (const field of ["eventContext", "currentContext"]) {
    test(`${metricId} withholds tied events with conflicting known or unknown ${field}`, () => {
      const input = tiedPairInput(definition);
      const context = {
        projects: ["synthetic-project-a"],
        workstreams: ["synthetic-workstream-a"],
        workstreamsKnown: true,
      };
      for (const fact of input.facts) fact[field] = structuredClone(context);
      assertConservedPair(input, aggregatePairInput(input, metricId));
      for (const conflict of ["different", "null", "omitted"]) {
        const candidate = structuredClone(input);
        if (conflict === "different") {
          candidate.facts[1][field].projects = ["synthetic-project-b"];
          candidate.facts[1][field].workstreams = ["synthetic-workstream-b"];
        } else if (conflict === "null") candidate.facts[1][field] = null;
        else delete candidate.facts[1][field];
        const expectedAudit = [
          {
            factIds: candidate.facts.map((fact) => fact.id).sort(),
            actorId: "202",
            reason: "ambiguous_relationship_pair",
          },
        ];
        for (const facts of [candidate.facts, [...candidate.facts].reverse()]) {
          const result = aggregatePairInput({ ...candidate, facts }, metricId);
          assert.deepEqual(result.rows, [], conflict);
          assert.deepEqual(result.audit, expectedAudit, conflict);
          assert.equal(result.coverage, "incomplete", conflict);
          assert.equal(result.publicEnabled, false, conflict);
        }
      }
    });

    test(`${metricId} keeps unknown ${field} unavailable to selected membership lenses`, () => {
      const input = tiedPairInput(definition);
      delete input.facts[1][field];
      assert.equal(Object.hasOwn(input.facts[1], field), false);
      assertConservedPair(input, aggregatePairInput(input, metricId));
      const ids = input.facts.map((fact) => fact.id).sort();
      const known = structuredClone(input);
      for (const fact of known.facts) {
        fact[field] = {
          projects: ["synthetic-project-a"],
          workstreams: ["synthetic-workstream-a"],
          workstreamsKnown: true,
        };
      }
      for (const [filter, value] of [
        ["projects", "synthetic-project-a"],
        ["workstreams", "synthetic-workstream-a"],
      ]) {
        const selectedScope = {
          ...scope,
          context: field === "eventContext" ? "event" : "current",
          [filter]: [value],
        };
        assertConservedPair(known, aggregatePairInput(known, metricId, selectedScope));
        for (const facts of [input.facts, [...input.facts].reverse()]) {
          const result = aggregatePairInput({ ...input, facts }, metricId, selectedScope);
          assert.deepEqual(result.rows, []);
          assert.deepEqual(result.audit, [
            { factIds: [ids[1]], actorId: "202", reason: "repeated_relationship_pair" },
            { factIds: [ids[0]], actorId: "202", reason: "unknown_membership_context" },
          ]);
          assert.equal(result.coverage, "incomplete");
          assert.equal(result.publicEnabled, false);
        }
      }
    });
  }
}
