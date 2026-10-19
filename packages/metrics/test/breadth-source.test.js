import assert from "node:assert/strict";
import test from "node:test";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../github/dist/index.js";
import {
  aggregateActivityBreadth,
  aggregateMetric,
  getMetricDefinition,
  metricRegistryV1,
  stableJSON,
} from "../dist/index.js";

// Deliberately synthetic provider payloads, authorized acceptance fixtures and
// event-time mappings. None represents a real contributor or live source grant.
const cutoff = "2026-10-19T12:00:00Z";
const observedAt = "2026-10-10T00:00:00Z";
const occurredAt = "2026-10-05T00:00:00Z";
const acceptedAt = "2026-10-09T00:00:00Z";
const author = { id: 101, node_id: "U_synthetic_101", type: "User", login: "synthetic-author" };
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: cutoff,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const context = (workstreams = ["engineering"], patch = {}) => ({
  projects: ["PVT_synthetic_one", "PVT_synthetic_two"],
  workstreams,
  workstreamsKnown: true,
  projectScope: ["PVT_synthetic_one", "PVT_synthetic_two"],
  workstreamScope: ["engineering", "research"],
  ...patch,
});
const sourcePolicy = (patch = {}) => {
  const metricId = patch.metricId ?? "pr_merged";
  return {
    metricId,
    version: "synthetic-source/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["qualified"],
    roles: ["author"],
    groupBy: "canonical",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
};
const breadthPolicy = (sourcePolicies = [sourcePolicy()], patch = {}) => ({
  version: "synthetic-breadth/v1",
  definitionVersion: metricRegistryV1.policy_version,
  sourcePolicies,
  ...patch,
});
function normalized(options = {}) {
  const repo = options.repo ?? 9001;
  const number = options.number ?? 1;
  const suppliedAuthor = options.author ?? author;
  const family = options.family ?? "pull_request";
  const source = {
    repository: {
      id: repo,
      slug: `synthetic-owner/repo-${repo}`,
      visibility: options.visibility ?? "public",
      defaultBranch: "main",
    },
    proof: { verified: true, source: "github_rest", revision: "synthetic-source", isSynthetic: true },
    family,
    observedAt: options.observedAt ?? observedAt,
    eventContext: Object.hasOwn(options, "eventContext") ? options.eventContext : context(),
    currentContext: context(["research"]),
    lineage: options.lineage ?? [],
    payload: {
      id: repo * 10 + number,
      node_id: `${family === "issue" ? "I" : "PR"}_synthetic_${repo}_${number}`,
      number,
      html_url: `https://github.com/synthetic-owner/repo-${repo}/${family === "issue" ? "issues" : "pull"}/${number}`,
      created_at: options.occurredAt ?? occurredAt,
      merged: true,
      merged_at: options.occurredAt ?? occurredAt,
      base: { ref: "main" },
      user: suppliedAuthor,
      assignees: [{ id: 202, node_id: "U_synthetic_202", type: "User", login: "synthetic-assignee" }],
      body: "Accepted, mirrored, imported and completed are merely untrusted payload text.",
    },
  };
  const out = normalizeGithubObservation(source);
  if (options.accept === false || out.facts.length === 0) return out;
  const metricId = family === "issue" ? "issues_opened" : "pr_merged";
  const target = out.facts.find((fact) => fact.metricId === metricId);
  return applyRecognitionReceipt(
    out,
    {
      id: `synthetic-acceptance-${repo}-${number}`,
      verified: true,
      metricId,
      actorId: String(suppliedAuthor.id),
      reviewerId: "303",
      acceptedAt: options.acceptedAt ?? acceptedAt,
      decision: "accepted",
      targetFactId: target.id,
      evidenceIds: [target.id],
    },
    ["303"],
  );
}
const accepted = (output) => output.facts.find((fact) => fact.state === "qualified");
function frozen(outputs, patch = {}) {
  return {
    datasetId: "synthetic-breadth",
    cutoff,
    backfillRevision: "synthetic-breadth/v1",
    repositoryIds: ["9001", "9002", "9003"],
    actors: [...new Map(outputs.flatMap((out) => out.actors).map((actor) => [actor.id, actor])).values()],
    facts: outputs.flatMap((out) => out.facts),
    coverage: [],
    ...patch,
  };
}
const calculate = (input, options = {}) =>
  aggregateActivityBreadth(input, options.policy ?? breadthPolicy(), options.scope ?? scope, options.lineage ?? []);
const values = (result, metricId) => result[metricId].rows.map((row) => [row.actorId, row.value, row.state]);
const completeCoverage = (repositoryIds = ["9001", "9002", "9003"]) =>
  repositoryIds.map((scopeId) => ({
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId,
    windowStart: scope.from,
    windowEnd: scope.to,
    knownStart: scope.from,
    lastSuccessfulSync: cutoff,
    sourceWatermark: cutoff,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  }));
const lineageFrom = (output) => output.lineage.map((link) => ({ ...link, verified: true, observedAt }));

for (const [field, id] of [
  ["projects", "PVT_synthetic_one"],
  ["workstreams", "engineering"],
  ["projectScope", "PVT_synthetic_one"],
  ["workstreamScope", "engineering"],
]) {
  for (const [shape, createIds] of [
    ["single hole", () => new Array(1)],
    ["leading hole", () => [, id]],
    ["trailing hole", () => Object.assign(new Array(2), { 0: id })],
    [
      "inherited identifier",
      () => Object.setPrototypeOf(new Array(1), Object.assign(Object.create(Array.prototype), { 0: id })),
    ],
    ["explicit undefined", () => [undefined]],
  ]) {
    test(`breadth membership rejects ${field} with ${shape}`, () => {
      const out = normalized();
      const ids = createIds();
      // Deliberately malformed frozen-engine inputs, after real normalization
      // and recognition. An absent slot cannot assert a known membership.
      for (const fact of out.facts) {
        fact.eventContext = {
          ...fact.eventContext,
          ...(field === "projectScope" ? { projects: [] } : {}),
          ...(field === "workstreamScope" ? { workstreams: [] } : {}),
          [field]: ids,
        };
      }
      const input = frozen([out], { coverage: completeCoverage() });
      const before = stableJSON(input);
      assert.throws(() => calculate(input), { message: "Invalid membership context" });
      assert.equal(stableJSON(input), before);
      assert.equal(input.facts[0].eventContext[field], ids);
    });
  }
  test(`breadth membership preserves dense frozen ${field}`, () => {
    const input = frozen([normalized()], { coverage: completeCoverage() });
    const expected = calculate(input);
    for (const fact of input.facts) Object.freeze(fact.eventContext[field]);
    const before = stableJSON(input);
    assert.deepEqual(calculate(input), expected);
    assert.equal(stableJSON(input), before);
  });
}

test("repositories: accepted source activities count distinct stable repositories and retain all proofs", () => {
  const outputs = [normalized(), normalized({ number: 2 }), normalized({ repo: 9002, number: 3 })];
  const result = calculate(frozen(outputs));
  assert.equal(outputs.flatMap((out) => out.facts).filter((fact) => fact.state === "qualified").length, 3);
  assert.deepEqual(values(result, "repositories"), [["101", 2, "partial"]]);
  assert.deepEqual(
    result.repositories.rows[0].units.map((unit) => [unit.id, unit.evidenceIds.length]),
    [
      ["9001", 2],
      ["9002", 1],
    ],
  );
  assert.deepEqual(
    result.repositories.rows[0].evidenceIds,
    outputs
      .map(accepted)
      .map((fact) => fact.id)
      .sort(),
  );
  assert.equal(result.repositories.rows[0].rank, null);
  assert.equal(result.repositories.publicEnabled, false);
});

test("workstreams: overlapping Project lenses count each verified event-time workstream once", () => {
  const outputs = [
    normalized(),
    normalized({ number: 2 }),
    normalized({ repo: 9002, eventContext: context(["engineering", "research"]) }),
  ];
  const result = calculate(frozen(outputs), {
    scope: { ...scope, projects: ["PVT_synthetic_one", "PVT_synthetic_two"] },
  });
  assert.deepEqual(values(result, "workstreams"), [["101", 2, "partial"]]);
  assert.deepEqual(
    result.workstreams.rows[0].units.map((unit) => [unit.id, unit.evidenceIds.length]),
    [
      ["engineering", 3],
      ["research", 1],
    ],
  );
  assert.deepEqual(result.workstreams.rows[0].unknownEvidenceIds, []);
  assert.equal(result.workstreams.publicEnabled, false);
  assert.equal(result.workstreams.rows[0].rank, null);
});

test("raw activity, an assignee and approval words never supply accepted breadth", () => {
  const out = normalized({ accept: false });
  assert.ok(out.facts.every((fact) => fact.state !== "qualified" && fact.state !== "reviewed"));
  const result = calculate(frozen([out]));
  assert.deepEqual(result.repositories.rows, []);
  assert.deepEqual(result.workstreams.rows, []);
  assert.ok(result.repositories.audit.some((entry) => entry.reason === "source_evidence_class_not_accepted"));
  assert.equal(
    out.facts.some((fact) => fact.actorId === "202"),
    false,
  );
});

test("unknown or partially mapped event context remains a separate bucket without erasing known units", () => {
  for (const eventContext of [
    null,
    context([], { workstreamsKnown: false }),
    context([], { workstreamsKnown: undefined }),
  ]) {
    const out = normalized({ eventContext });
    const result = calculate(frozen([out], { coverage: completeCoverage() }));
    assert.deepEqual(values(result, "repositories"), [["101", 1, "measured"]]);
    assert.deepEqual(values(result, "workstreams"), [["101", null, "unknown"]]);
    assert.deepEqual(result.workstreams.rows[0].unknownEvidenceIds, [accepted(out).id]);
    assert.equal(result.workstreams.coverage, "incomplete");
  }
  const out = normalized({ eventContext: context(["engineering"], { workstreamsKnown: false }) });
  const result = calculate(frozen([out], { coverage: completeCoverage() }));
  assert.deepEqual(values(result, "workstreams"), [["101", 1, "partial"]]);
  assert.deepEqual(result.workstreams.rows[0].unknownEvidenceIds, [accepted(out).id]);
});

test("known empty mapping yields zero only with complete source coverage", () => {
  const out = normalized({ eventContext: context([]) });
  assert.deepEqual(values(calculate(frozen([out])), "workstreams"), [["101", null, "unknown"]]);
  const complete = calculate(frozen([out], { coverage: completeCoverage() }));
  assert.deepEqual(values(complete, "workstreams"), [["101", 0, "zero"]]);
  assert.deepEqual(complete.workstreams.rows[0].unknownEvidenceIds, []);
  assert.equal(complete.workstreams.coverage, "complete");
  assert.deepEqual(
    calculate(frozen([], { coverage: completeCoverage(), actors: frozen([out]).actors })).repositories.rows,
    [],
  );
});

test("current membership never replaces historic workstream membership or silently changes its lens", () => {
  const input = frozen([normalized()]);
  assert.deepEqual(
    calculate(input).workstreams.rows[0].units.map((unit) => unit.id),
    ["engineering"],
  );
  assert.throws(() => calculate(input, { scope: { ...scope, context: "current" } }), /event-time context/);
  assert.equal(calculate(input, { scope: { ...scope, workstreams: ["engineering"] } }).repositories.rows[0].value, 1);
  const other = calculate(input, { scope: { ...scope, workstreams: ["research"] } });
  assert.deepEqual(other.repositories.rows, []);
  assert.ok(other.repositories.audit.some((entry) => entry.reason === "workstream_filter"));
});

test("workstream filters preserve verified positive OR matches and unknown outside-mapping negatives", () => {
  const input = frozen([normalized()]);
  assert.equal(
    calculate(input, { scope: { ...scope, workstreams: ["engineering", "outside"] } }).workstreams.rows[0].value,
    1,
  );
  const unknown = calculate(input, { scope: { ...scope, workstreams: ["research", "outside"] } });
  assert.deepEqual(unknown.workstreams.rows, []);
  assert.equal(unknown.workstreams.coverage, "incomplete");
  assert.ok(unknown.workstreams.audit.some((entry) => entry.reason === "unknown_membership_context"));
});

test("a workstream filter cannot turn unknown legacy membership into complete empty breadth", () => {
  for (const workstreams of [[], ["research"]]) {
    const eventContext = context(workstreams);
    delete eventContext.workstreamsKnown;
    const input = frozen([normalized({ eventContext })], { coverage: completeCoverage() });
    const original = stableJSON(input);
    assert.equal(calculate(input).workstreams.coverage, "incomplete");
    // This strict interpretation belongs to the new breadth selector. Existing
    // source-board handling of retained contexts remains compatible.
    const legacy = aggregateMetric(input, sourcePolicy(), { ...scope, workstreams: ["engineering"] });
    assert.deepEqual(legacy.rows, []);
    assert.equal(legacy.coverage, "complete");
    assert.ok(legacy.audit.some((entry) => entry.reason === "workstream_filter"));
    const result = calculate(input, { scope: { ...scope, workstreams: ["engineering"] } });
    for (const metric of ["repositories", "workstreams"]) {
      assert.deepEqual(result[metric].rows, []);
      assert.equal(result[metric].coverage, "incomplete");
      assert.ok(result[metric].audit.some((entry) => entry.reason === "unknown_membership_context"));
      assert.equal(
        result[metric].audit.some((entry) => entry.reason === "workstream_filter"),
        false,
      );
    }
    assert.equal(stableJSON(input), original);
  }
});

test("filtered breadth distinguishes explicit unknown membership from a known disjoint mapping", () => {
  for (const workstreamsKnown of [false, true]) {
    for (const workstreams of [[], ["research"]]) {
      const input = frozen([normalized({ eventContext: context(workstreams, { workstreamsKnown }) })], {
        coverage: completeCoverage(),
      });
      const result = calculate(input, { scope: { ...scope, workstreams: ["engineering"] } });
      for (const metric of ["repositories", "workstreams"]) {
        assert.deepEqual(result[metric].rows, []);
        assert.equal(result[metric].coverage, workstreamsKnown ? "complete" : "incomplete");
        assert.ok(
          result[metric].audit.some(
            (entry) => entry.reason === (workstreamsKnown ? "workstream_filter" : "unknown_membership_context"),
          ),
        );
      }
    }
  }
});

test("legacy positive workstream OR matches remain useful without inventing complete mappings", () => {
  const eventContext = context(["engineering"]);
  delete eventContext.workstreamsKnown;
  const input = frozen([normalized({ eventContext })], { coverage: completeCoverage() });
  const result = calculate(input, { scope: { ...scope, workstreams: ["engineering", "outside"] } });
  assert.deepEqual(values(result, "repositories"), [["101", 1, "measured"]]);
  assert.equal(result.repositories.coverage, "complete");
  assert.deepEqual(values(result, "workstreams"), [["101", 1, "partial"]]);
  assert.equal(result.workstreams.coverage, "incomplete");
  assert.deepEqual(result.workstreams.rows[0].unknownEvidenceIds, [
    input.facts.find((fact) => fact.state === "qualified").id,
  ]);
  assert.equal(
    result.repositories.audit.some((entry) => entry.reason === "unknown_membership_context"),
    false,
  );
});

test("verified mirror and import targets supply neither another repository nor another workstream", () => {
  const original = normalized();
  const copies = ["mirror_of", "imported_from"].map((relation, index) => {
    const repo = 9002 + index;
    return normalized({
      repo,
      eventContext: context(["research"]),
      lineage: [
        {
          relation,
          sourceIds: [accepted(original).artifactId],
          targetId: `PR_synthetic_${repo}_1`,
          evidenceIds: [`synthetic-lineage-${relation}`],
        },
      ],
    });
  });
  const input = frozen([original, ...copies]);
  const withoutProof = calculate(input);
  assert.equal(withoutProof.repositories.rows[0].value, 3);
  const result = calculate(input, { lineage: copies.flatMap(lineageFrom) });
  assert.deepEqual(values(result, "repositories"), [["101", 1, "partial"]]);
  assert.deepEqual(
    result.workstreams.rows[0].units.map((unit) => unit.id),
    ["engineering"],
  );
  assert.deepEqual(
    result.repositories.audit
      .filter((entry) => entry.reason === "mirrored_or_imported_copy")
      .flatMap((entry) => entry.factIds)
      .sort(),
    copies
      .map(accepted)
      .map((fact) => fact.id)
      .sort(),
  );
  assert.deepEqual(result.repositories.rows[0].evidenceIds, [accepted(original).id]);
});

test("other evidenced lineage is not treated as mirror or import duplication", () => {
  const original = normalized();
  for (const relation of ["squash_of", "cherry_pick_of", "reverted_by", "transferred_to"]) {
    const out = normalized({
      repo: 9002,
      lineage: [
        {
          relation,
          sourceIds: [accepted(original).artifactId],
          targetId: "PR_synthetic_9002_1",
          evidenceIds: ["synthetic-lineage"],
        },
      ],
    });
    assert.equal(calculate(frozen([original, out]), { lineage: lineageFrom(out) }).repositories.rows[0].value, 2);
  }
});

test("lineage must have explicit verified identities and evidence and cannot precede its observation cutoff", () => {
  const outputs = [normalized(), normalized({ repo: 9002 })];
  const input = frozen(outputs);
  const link = {
    verified: true,
    relation: "mirror_of",
    sourceIds: [accepted(outputs[0]).artifactId],
    targetId: accepted(outputs[1]).artifactId,
    evidenceIds: ["synthetic-lineage"],
    observedAt,
  };
  assert.equal(calculate(input, { lineage: [link] }).repositories.rows[0].value, 1);
  const future = calculate(input, { lineage: [{ ...link, observedAt: "2026-10-20T00:00:00Z" }] });
  assert.equal(future.repositories.rows[0].value, 2);
  assert.equal(future.repositories.lineageSignature, "[]");
  for (const patch of [
    { verified: false },
    { sourceIds: [] },
    { sourceIds: [link.targetId] },
    { sourceIds: ["x", "x"] },
    { evidenceIds: [] },
    { targetId: "" },
    { relation: "looks_similar" },
    { observedAt: null },
  ])
    assert.throws(() => calculate(input, { lineage: [{ ...link, ...patch }] }), /Source-verified lineage/);
  assert.throws(() => aggregateActivityBreadth(input, breadthPolicy(), scope), /Explicit frozen lineage/);
});

for (const field of ["sourceIds", "evidenceIds"]) {
  test(`lineage ${field} requires explicit own identifiers before excluding a copy`, () => {
    const outputs = [normalized(), normalized({ repo: 9002 })];
    const input = frozen(outputs);
    const link = {
      verified: true,
      relation: "mirror_of",
      sourceIds: [accepted(outputs[0]).artifactId],
      targetId: accepted(outputs[1]).artifactId,
      evidenceIds: ["synthetic-lineage"],
      observedAt,
    };
    const original = structuredClone(link);
    assert.equal(calculate(input, { lineage: [link] }).repositories.rows[0].value, 1);
    assert.throws(() => calculate(input, { lineage: [{ ...link, [field]: [undefined] }] }), /Source-verified lineage/);

    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: link[field][0] }));
    for (const ids of [new Array(1), [link[field][0], , "synthetic-additional-id"], inherited]) {
      assert.throws(() => calculate(input, { lineage: [{ ...link, [field]: ids }] }), /Source-verified lineage/);
    }

    const dense = Object.freeze([...link[field], "synthetic-additional-id"]);
    const retained = calculate(input, { lineage: [{ ...link, [field]: dense }] });
    assert.equal(retained.repositories.rows[0].value, 1);
    assert.deepEqual(JSON.parse(JSON.parse(retained.repositories.lineageSignature)[0])[field], [...dense].sort());
    assert.deepEqual(link, original);
  });
}

test("source occurrence uses half-open boundaries even when independent acceptance is later", () => {
  const window = { ...scope, from: "2026-10-05T00:00:00.001Z", to: "2026-10-06T00:00:00Z" };
  const outputs = [
    normalized({ repo: 9001, occurredAt: "2026-10-05T00:00:00Z" }),
    normalized({ repo: 9002, occurredAt: window.from }),
    normalized({ repo: 9003, occurredAt: window.to }),
  ];
  const result = calculate(frozen(outputs), {
    scope: window,
    policy: breadthPolicy([sourcePolicy({ dateBasis: "acceptedAt" })]),
  });
  assert.deepEqual(
    result.repositories.rows[0].units.map((unit) => unit.id),
    ["9002"],
  );
  assert.equal(result.repositories.rows[0].value, 1);
  // Both original observations and accepted revisions retain their own audit
  // identity. The two excluded activities must lose neither representation.
  assert.deepEqual(
    result.repositories.audit
      .filter((entry) => entry.reason === "outside_window")
      .flatMap((entry) => entry.factIds)
      .sort(),
    [outputs[0], outputs[2]]
      .flatMap((output) => output.facts.filter((fact) => fact.metricId === "pr_merged"))
      .map((fact) => fact.id)
      .sort(),
  );
});

test("future acceptance or source observation cannot enter a frozen breadth result", () => {
  const outputs = [
    normalized(),
    normalized({ repo: 9002, acceptedAt: "2026-10-20T00:00:00Z" }),
    normalized({ repo: 9003, observedAt: "2026-10-20T00:00:00Z" }),
  ];
  const result = calculate(frozen(outputs));
  assert.deepEqual(
    result.repositories.rows[0].units.map((unit) => unit.id),
    ["9001"],
  );
  assert.ok(result.repositories.audit.some((entry) => entry.reason === "acceptance_after_cutoff"));
  assert.ok(result.repositories.audit.some((entry) => entry.reason === "observation_after_cutoff"));
});

test("a reviewed source correction changes breadth and historical replay retains the prior accepted unit", () => {
  const outputs = [normalized(), normalized({ repo: 9002, eventContext: context(["research"]) })];
  const source = accepted(outputs[1]);
  const correction = {
    ...source,
    revision: 1,
    correctionReceipt: "synthetic-correction",
    state: "excluded",
    observedAt: "2026-10-12T00:00:00Z",
  };
  const input = frozen(outputs);
  input.facts.push(correction);
  assert.equal(calculate(input).repositories.rows[0].value, 1);
  assert.deepEqual(
    calculate(input).workstreams.rows[0].units.map((unit) => unit.id),
    ["engineering"],
  );
  const historicEnd = "2026-10-11T00:00:00Z";
  assert.equal(
    calculate({ ...input, cutoff: historicEnd }, { scope: { ...scope, to: historicEnd } }).repositories.rows[0].value,
    2,
  );
  const unreviewed = { ...correction, revision: 2, correctionReceipt: null, state: "qualified" };
  const refused = calculate({ ...input, facts: [...input.facts, unreviewed] });
  assert.equal(refused.repositories.rows[0].value, 1);
  assert.ok(refused.repositories.audit.some((entry) => entry.reason === "unreviewed_revision"));
});

test("conflicting source identity, missing canonical identity and absent artifact stay unqualified", () => {
  const out = normalized();
  const fact = accepted(out);
  for (const [patch, reason] of [
    [{ canonicalKey: null }, "unknown_canonical_identity"],
    [{ artifactId: null }, "unknown_artifact_identity"],
    [{ acceptanceReceipt: null }, "missing_independent_acceptance"],
    [{ acceptedBy: fact.actorId }, "missing_independent_acceptance"],
    [{ acceptedAt: null }, "unknown_acceptance_time"],
    [{ occurredAt: null }, "unknown_effective_time"],
  ]) {
    const input = frozen([out], { facts: [{ ...fact, ...patch }], coverage: completeCoverage() });
    const result = calculate(input);
    assert.deepEqual(result.repositories.rows, []);
    assert.equal(result.repositories.coverage, "incomplete");
    assert.ok(result.repositories.audit.some((entry) => entry.reason === reason));
  }
  const conflict = calculate(frozen([out], { facts: [fact, { ...fact, artifactId: "PR_synthetic_other" }] }));
  assert.deepEqual(conflict.repositories.rows, []);
  assert.ok(conflict.repositories.audit.some((entry) => entry.reason === "conflicting_revision"));
});

test("normalizer visibility, suppression and deleted-account presentation retain their existing boundaries", () => {
  for (const visibility of ["private", "unknown"]) {
    const out = normalized({ visibility });
    assert.ok(out.reasons.includes("public_visibility_unverified_or_revoked"));
    assert.deepEqual(calculate(frozen([out])).repositories.rows, []);
  }
  const input = frozen([normalized()]);
  assert.deepEqual(
    calculate({ ...input, actors: input.actors.map((actor) => ({ ...actor, publicState: "suppressed" })) }).repositories
      .rows,
    [],
  );
  const deleted = calculate({ ...input, actors: input.actors.map((actor) => ({ ...actor, publicState: "deleted" })) });
  assert.equal(deleted.repositories.rows[0].value, 1);
  assert.equal(deleted.repositories.rows[0].login, null);
});

test("repository, role and actor filters select source evidence without inventing member participation", () => {
  const outputs = [
    normalized(),
    normalized({
      repo: 9002,
      author: { id: 404, node_id: "B_synthetic_404", type: "Bot", login: "synthetic-bot[bot]" },
    }),
  ];
  const input = frozen(outputs);
  assert.deepEqual(values(calculate(input), "repositories"), [["101", 1, "partial"]]);
  assert.deepEqual(values(calculate(input, { scope: { ...scope, actors: "automation" } }), "repositories"), [
    ["404", 1, "partial"],
  ]);
  assert.deepEqual(calculate(input, { scope: { ...scope, roles: ["reviewer"] } }).repositories.rows, []);
  const allowed = calculate({ ...input, repositoryIds: ["9001"] }, { scope: { ...scope, actors: "all" } });
  assert.deepEqual(values(allowed, "repositories"), [["101", 1, "partial"]]);
  assert.ok(allowed.repositories.audit.some((entry) => entry.reason === "repository_not_allowed"));
  assert.deepEqual(calculate(input, { scope: { ...scope, repos: ["9002"] } }).repositories.rows, []);
});

test("self-review against the subject cannot enter accepted breadth through a changed role policy", () => {
  const out = normalized();
  const fact = { ...accepted(out), role: "reviewer" };
  const result = calculate(frozen([out], { facts: [fact] }), {
    policy: breadthPolicy([sourcePolicy({ roles: ["reviewer"] })]),
  });
  assert.deepEqual(result.repositories.rows, []);
  assert.ok(result.repositories.audit.some((entry) => entry.reason === "missing_independent_acceptance"));
});

test("qualified and reviewed policies remain separate and direct breadth facts are not a source shortcut", () => {
  const out = normalized();
  const fact = accepted(out);
  // The reviewed fixture is an explicit engine class, not a normalizer promotion.
  const input = frozen([out], {
    facts: [
      fact,
      { ...fact, id: "synthetic-reviewed", canonicalKey: "synthetic-reviewed", state: "reviewed", repoId: "9002" },
      { ...fact, id: "synthetic-forged-breadth", metricId: "repositories", repoId: "9003" },
    ],
  });
  assert.deepEqual(
    calculate(input).repositories.rows[0].units.map((unit) => unit.id),
    ["9001"],
  );
  const reviewed = calculate(input, { policy: breadthPolicy([sourcePolicy({ rankedStates: ["reviewed"] })]) });
  assert.deepEqual(
    reviewed.repositories.rows[0].units.map((unit) => unit.id),
    ["9002"],
  );
  assert.equal(reviewed.repositories.evidenceClass, "reviewed");
  assert.throws(
    () => calculate(input, { policy: breadthPolicy([sourcePolicy({ metricId: "repositories" })]) }),
    /canonical source policy/,
  );
});

test("the API requires a deliberate compatible source-policy set instead of an implicit global eligibility policy", () => {
  const input = frozen([normalized()]);
  for (const policy of [
    breadthPolicy([]),
    breadthPolicy([sourcePolicy(), sourcePolicy()]),
    breadthPolicy([sourcePolicy({ definitionVersion: "other" })]),
    breadthPolicy([sourcePolicy()], { version: "" }),
    breadthPolicy([
      sourcePolicy(),
      sourcePolicy({ metricId: "issues_opened", roles: ["reporter"], rankedStates: ["reviewed"] }),
    ]),
  ])
    assert.throws(() => calculate(input, { policy }), /unique source policies/);
  for (const policy of [
    sourcePolicy({ rankedStates: ["observed"] }),
    sourcePolicy({ groupBy: "actor_artifact" }),
    sourcePolicy({ metricId: "pr_accepted_rate", aggregation: "ratio", dateBasis: "acceptedAt" }),
  ])
    assert.throws(() => calculate(input, { policy: breadthPolicy([policy]) }), /canonical source policy/);
});

test("multiple accepted source families retain their distinct identities but count shared units once", () => {
  const outputs = [
    normalized(),
    normalized({ family: "issue" }),
    normalized({ family: "issue", repo: 9002, eventContext: context(["research"]) }),
  ];
  const policy = breadthPolicy([
    sourcePolicy(),
    sourcePolicy({ metricId: "issues_opened", roles: ["reporter"], dateBasis: "acceptedAt" }),
  ]);
  const result = calculate(frozen(outputs), { policy });
  assert.equal(result.repositories.rows[0].value, 2);
  assert.equal(result.workstreams.rows[0].value, 2);
  assert.equal(result.repositories.rows[0].evidenceIds.length, 3);
  const conflict = frozen(outputs);
  conflict.facts.find((fact) => fact.metricId === "issues_opened" && fact.state === "qualified").id = accepted(
    outputs[0],
  ).id;
  assert.throws(() => calculate(conflict, { policy }), /identity conflicts across policies/);
});

// Explicit engine fixtures isolate the sum-policy boundary after source admission.
// Relabelling these synthetic facts does not claim a provider line-classification receipt.
const sumSourcePolicy = () => sourcePolicy({ metricId: "pr_lines_added", aggregation: "sum" });
const sumInput = (quantities) => {
  const outputs = quantities.map((quantity, index) =>
    normalized({
      repo: 9001 + index,
      eventContext: context(index === 0 ? ["engineering"] : ["research"]),
    }),
  );
  return frozen(outputs, {
    facts: outputs.map((output, index) => ({
      ...accepted(output),
      metricId: "pr_lines_added",
      quantity: quantities[index],
    })),
    coverage: completeCoverage(),
  });
};

test("sum source: exact quantities admit distinct activity scopes without weighting them by line totals", () => {
  const input = sumInput([12, 31]);
  assert.equal(aggregateMetric(input, sumSourcePolicy(), scope).rows[0].value, 43);
  const result = calculate(input, { policy: breadthPolicy([sumSourcePolicy()]) });
  for (const metric of ["repositories", "workstreams"]) {
    assert.deepEqual(values(result, metric), [["101", 2, "measured"]]);
    assert.deepEqual(result[metric].rows[0].evidenceIds, input.facts.map((fact) => fact.id).sort());
    assert.equal(result[metric].coverage, "complete");
  }
});

test("sum source: absent quantity remains unknown and cannot certify a breadth unit", () => {
  const input = sumInput([undefined]);
  const source = aggregateMetric(input, sumSourcePolicy(), scope);
  assert.deepEqual(
    source.rows.map(({ value, state }) => ({ value, state })),
    [{ value: null, state: "unknown" }],
  );
  const result = calculate(input, { policy: breadthPolicy([sumSourcePolicy()]) });
  for (const metric of ["repositories", "workstreams"]) {
    assert.deepEqual(result[metric].rows, []);
    assert.equal(result[metric].coverage, "incomplete");
    assert.deepEqual(
      result[metric].audit.filter((entry) => entry.reason === "unknown_source_quantity"),
      [{ factIds: [input.facts[0].id], actorId: "101", reason: "unknown_source_quantity" }],
    );
  }
});

test("sum source: a missing quantity leaves known scopes partial and retains only their proof IDs", () => {
  const input = sumInput([12, undefined]);
  assert.equal(aggregateMetric(input, sumSourcePolicy(), scope).rows[0].value, null);
  const result = calculate(input, { policy: breadthPolicy([sumSourcePolicy()]) });
  for (const metric of ["repositories", "workstreams"]) {
    assert.deepEqual(values(result, metric), [["101", 1, "partial"]]);
    assert.deepEqual(result[metric].rows[0].evidenceIds, [input.facts[0].id]);
    assert.equal(result[metric].coverage, "incomplete");
    assert.deepEqual(
      result[metric].audit
        .filter((entry) => entry.reason === "unknown_source_quantity")
        .flatMap((entry) => entry.factIds),
      [input.facts[1].id],
    );
  }
  assert.deepEqual(
    result.repositories.rows[0].units.map((unit) => unit.id),
    ["9001"],
  );
  assert.deepEqual(
    result.workstreams.rows[0].units.map((unit) => unit.id),
    ["engineering"],
  );
});

test("sum source: numeric admission and contradictory canonical quantity rejection remain in force", () => {
  const policy = breadthPolicy([sumSourcePolicy()]);
  for (const quantity of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => calculate(sumInput([quantity]), { policy }), /Quantity|safe integers/);
  const input = sumInput([12]);
  input.facts.push({ ...input.facts[0], id: "synthetic-conflicting-sum", quantity: 13 });
  const result = calculate(input, { policy });
  for (const metric of ["repositories", "workstreams"]) {
    assert.deepEqual(result[metric].rows, []);
    assert.equal(result[metric].coverage, "incomplete");
    assert.deepEqual(
      result[metric].audit
        .filter((entry) => entry.reason === "ambiguous_canonical_action")
        .flatMap((entry) => entry.factIds)
        .sort(),
      input.facts.map((fact) => fact.id).sort(),
    );
  }
});

test("immutable permutation and reobservation replay retains the same units, evidence and source bindings", () => {
  const outputs = [
    normalized(),
    normalized({ number: 2, observedAt: "2026-10-11T00:00:00Z" }),
    normalized({ family: "issue", repo: 9002 }),
  ];
  const repeat = normalized({ observedAt: "2026-10-12T00:00:00Z" });
  const policy = breadthPolicy([sourcePolicy(), sourcePolicy({ metricId: "issues_opened", roles: ["reporter"] })]);
  const input = frozen([...outputs, repeat]);
  const freeze = (value) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  freeze(input);
  freeze(policy);
  const before = stableJSON([input, policy]);
  const result = calculate(input, { policy });
  const reversed = calculate(
    { ...input, facts: [...input.facts].reverse(), actors: [...input.actors].reverse() },
    { policy: { ...policy, sourcePolicies: [...policy.sourcePolicies].reverse() } },
  );
  assert.deepEqual(result, reversed);
  assert.deepEqual(result, calculate(frozen(outputs), { policy }));
  assert.equal(stableJSON([input, policy]), before);
});
