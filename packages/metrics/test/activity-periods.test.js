import assert from "node:assert/strict";
import test from "node:test";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateActivityPeriods, getMetricDefinition, metricRegistryV1, stableJSON } from "../dist/index.js";

// Fictional source payloads and protected acceptance fixtures, never live grants
// or contributor history. Exercise the actual normalizer and acceptance boundary.
const cutoff = "2026-11-01T00:00:00Z";
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
const sourcePolicy = (patch = {}) => ({
  metricId: "pr_merged",
  version: "synthetic-source/v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition(patch.metricId ?? "pr_merged").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
  ...patch,
});
const periodPolicy = (patch = {}) => ({
  version: "synthetic-periods/v1",
  definitionVersion: metricRegistryV1.policy_version,
  calendarUnit: "week",
  sourcePolicies: [sourcePolicy()],
  ...patch,
});
function normalized(options = {}) {
  const repo = options.repo ?? 9001;
  const number = options.number ?? 1;
  const occurredAt = options.occurredAt ?? "2026-10-05T10:00:00Z";
  const author = options.author ?? {
    id: 101,
    node_id: "U_synthetic_period_author",
    type: "User",
    login: "synthetic-period-author",
  };
  const family = options.family ?? "pull_request";
  const output = normalizeGithubObservation({
    repository: { id: repo, slug: `synthetic-owner/periods-${repo}`, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: "synthetic-period-source", isSynthetic: true },
    family,
    observedAt: options.observedAt ?? cutoff,
    eventContext: { projects: ["PVT_periods"], workstreams: ["engineering"], workstreamsKnown: true },
    currentContext: { projects: ["PVT_other"], workstreams: ["research"], workstreamsKnown: true },
    payload: {
      id: repo * 10 + number,
      node_id: `${family}_synthetic_period_${repo}_${number}`,
      number,
      html_url: `https://github.com/synthetic-owner/periods-${repo}/${family === "issue" ? "issues" : "pull"}/${number}`,
      created_at: occurredAt,
      merged_at: occurredAt,
      merged: true,
      base: { ref: "main" },
      user: author,
    },
  });
  if (options.accept === false) return output;
  const metricId = family === "issue" ? "issues_opened" : "pr_merged";
  const target = output.facts.find((fact) => fact.metricId === metricId);
  return applyRecognitionReceipt(
    output,
    {
      id: `synthetic-period-acceptance-${repo}-${number}`,
      verified: true,
      metricId,
      actorId: String(author.id),
      reviewerId: "303",
      acceptedAt: options.acceptedAt ?? occurredAt,
      decision: "accepted",
      targetFactId: target.id,
      evidenceIds: [target.id],
    },
    ["303"],
  );
}
const accepted = (output) => output.facts.find((fact) => fact.state === "qualified");
function frozen(outputs, selectedScope = scope, patch = {}) {
  return {
    datasetId: "synthetic-activity-periods",
    cutoff,
    backfillRevision: "synthetic-periods/v1",
    repositoryIds: ["9001", "9002"],
    actors: [...new Map(outputs.flatMap((out) => out.actors).map((actor) => [actor.id, actor])).values()],
    facts: outputs.flatMap((out) => out.facts),
    coverage: ["9001", "9002"].map((scopeId) => ({
      schemaVersion: "leaderboard/v1",
      state: "complete",
      source: "github_rest",
      scopeId,
      windowStart: selectedScope.from ?? scope.from,
      windowEnd: selectedScope.to,
      knownStart: selectedScope.from ?? scope.from,
      lastSuccessfulSync: cutoff,
      sourceWatermark: selectedScope.to,
      missingPages: 0,
      permissionsMissing: [],
      sourceErrors: [],
    })),
    ...patch,
  };
}
const calculate = (input, options = {}) =>
  aggregateActivityPeriods(input, options.policy ?? periodPolicy(), options.scope ?? scope);
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

test("weeks deduplicate events, repositories and accepted source metrics while retaining all proof IDs", () => {
  const selected = { ...scope, from: "2026-10-05T00:00:00Z", to: "2026-10-26T00:00:00Z" };
  const outputs = [
    normalized(),
    normalized({ repo: 9002, occurredAt: "2026-10-11T23:59:59.999Z" }),
    normalized({ family: "issue", number: 2, occurredAt: "2026-10-06T10:00:00Z" }),
    normalized({ number: 3, occurredAt: "2026-10-12T00:00:00Z" }),
  ];
  const policy = periodPolicy({
    sourcePolicies: [sourcePolicy(), sourcePolicy({ metricId: "issues_opened", roles: ["reporter"] })],
  });
  const result = calculate(frozen(outputs, selected), { scope: selected, policy });
  const row = result.rows[0];
  assert.equal(row.value, 2);
  assert.equal(row.state, "measured");
  assert.deepEqual(
    row.periods.map((period) => [period.start, period.end, period.evidenceIds.length]),
    [
      ["2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z", 3],
      ["2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z", 1],
    ],
  );
  assert.deepEqual(
    row.evidenceIds,
    outputs
      .map(accepted)
      .map((fact) => fact.id)
      .sort(),
  );
  assert.deepEqual([row.numerator, row.denominator, row.share], [2, 3, 2 / 3]);
  assert.equal(result.fullyCoveredCalendarPeriods, 3);
  assert.equal(result.shareUnavailableReason, null);
  assert.equal(row.rank, null);
  assert.equal(result.publicEnabled, false);
  assert.equal(result.sourceClock, "occurredAt");
  assert.equal(result.weekStartsOn, "monday");
});

test("partial edge weeks count raw activity but cannot enter either covered share term", () => {
  const selected = { ...scope, from: "2026-10-01T00:00:00Z", to: "2026-10-22T00:00:00Z" };
  const outputs = [
    "2026-10-01T00:00:00Z",
    "2026-10-05T00:00:00Z",
    "2026-10-12T00:00:00Z",
    "2026-10-21T23:59:59.999Z",
  ].map((occurredAt, number) => normalized({ occurredAt, number: number + 1 }));
  const result = calculate(frozen(outputs, selected), { scope: selected });
  assert.deepEqual(
    [result.rows[0].value, result.rows[0].numerator, result.rows[0].denominator, result.rows[0].share],
    [4, 2, 2, 1],
  );
  const edges = calculate(frozen([outputs[0], outputs[3]], selected), { scope: selected });
  assert.deepEqual(
    [edges.rows[0].value, edges.rows[0].numerator, edges.rows[0].denominator, edges.rows[0].share],
    [2, 0, 2, 0],
  );
});

test("a complete short window has no full calendar denominator and never reports a zero share", () => {
  const selected = { ...scope, from: "2026-10-05T09:00:00Z", to: "2026-10-05T11:00:00Z" };
  const result = calculate(frozen([normalized()], selected), { scope: selected });
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.rows[0].state, "measured");
  assert.deepEqual([result.rows[0].numerator, result.rows[0].denominator, result.rows[0].share], [0, 0, null]);
  assert.equal(result.fullyCoveredCalendarPeriods, 0);
  assert.equal(result.shareUnavailableReason, "no_fully_covered_periods");
});

test("calendar months preserve leap days and exclude partial edge months from shares", () => {
  const selected = { ...scope, from: "2024-01-15T00:00:00Z", to: "2024-04-15T00:00:00Z" };
  const outputs = [
    "2024-01-31T23:59:59.999Z",
    "2024-02-29T23:59:59.999Z",
    "2024-03-01T00:00:00Z",
    "2024-04-01T00:00:00Z",
  ].map((occurredAt, number) => normalized({ occurredAt, number: number + 1 }));
  const result = calculate(frozen(outputs, selected), {
    scope: selected,
    policy: periodPolicy({ calendarUnit: "month" }),
  });
  assert.deepEqual(
    result.rows[0].periods.map((period) => [period.start, period.end]),
    [
      ["2024-01-01T00:00:00.000Z", "2024-02-01T00:00:00.000Z"],
      ["2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
      ["2024-03-01T00:00:00.000Z", "2024-04-01T00:00:00.000Z"],
      ["2024-04-01T00:00:00.000Z", "2024-05-01T00:00:00.000Z"],
    ],
  );
  assert.deepEqual(
    [result.rows[0].value, result.rows[0].numerator, result.rows[0].denominator, result.rows[0].share],
    [4, 2, 2, 1],
  );
  assert.equal(result.weekStartsOn, null);
});

test("calendar arithmetic preserves years below 100 and remains bounded over a long interval", () => {
  const selected = { ...scope, from: "0099-12-01T00:00:00Z", to: "0100-02-01T00:00:00Z" };
  const outputs = ["0099-12-31T23:59:59Z", "0100-01-01T00:00:00Z"].map((occurredAt, number) =>
    normalized({ occurredAt, number: number + 1 }),
  );
  const policy = periodPolicy({ calendarUnit: "month" });
  const result = calculate(frozen(outputs, selected), { scope: selected, policy });
  assert.deepEqual(
    result.rows[0].periods.map((period) => period.start),
    ["0099-12-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"],
  );
  assert.deepEqual([result.rows[0].value, result.rows[0].denominator, result.rows[0].share], [2, 2, 1]);
  const long = { ...scope, from: "0001-01-01T00:00:00Z", to: "9999-01-01T00:00:00Z" };
  const large = calculate(frozen(outputs, long, { cutoff: long.to }), { scope: long, policy });
  assert.equal(large.fullyCoveredCalendarPeriods, 9998 * 12);
  assert.equal(large.rows[0].periods.length, 2);
});

test("original occurrence clocks and half-open boundaries survive late acceptance and observation", () => {
  const selected = { ...scope, from: "2026-10-05T00:00:00Z", to: "2026-10-19T00:00:00Z" };
  const outputs = [
    normalized({ occurredAt: "2026-10-05T00:00:00Z", acceptedAt: "2026-10-30T00:00:00Z" }),
    normalized({ number: 2, occurredAt: "2026-10-04T23:59:59.999Z" }),
    normalized({ number: 3, occurredAt: "2026-10-19T00:00:00Z" }),
  ];
  const result = calculate(frozen(outputs, selected), {
    scope: selected,
    policy: periodPolicy({ sourcePolicies: [sourcePolicy({ dateBasis: "acceptedAt" })] }),
  });
  assert.equal(result.rows[0].value, 1);
  assert.deepEqual(result.rows[0].evidenceIds, [accepted(outputs[0]).id]);
  assert.equal(result.rows[0].periods[0].start, "2026-10-05T00:00:00.000Z");
  assert.equal(result.rows[0].share, 1 / 2);
});

test("the frozen cutoff rejects future windows and later observations cannot add an active period", () => {
  const output = normalized();
  assert.throws(() => calculate(frozen([output], scope, { cutoff: "2026-10-31T23:59:59.999Z" })), /frozen cutoff/);
  const future = normalized({ number: 2, occurredAt: "2026-10-20T00:00:00Z", observedAt: "2026-11-01T00:00:00.001Z" });
  const result = calculate(frozen([output, future]));
  assert.equal(result.rows[0].value, 1);
  assert.deepEqual(result.rows[0].evidenceIds, [accepted(output).id]);
  assert.ok(result.audit.some((entry) => entry.factIds.includes(accepted(future).id)));
});

test("incomplete coverage withholds both share terms while preserving known activity as partial", () => {
  const patches = [
    { state: "partial" },
    { knownStart: null },
    { sourceWatermark: null },
    { sourceWatermark: "2026-10-31T23:59:59.999999999Z" },
    { windowStart: "2026-10-01T00:00:00.000000001Z" },
    { missingPages: 1 },
    { permissionsMissing: ["issues:read"] },
    { sourceErrors: ["synthetic_missing_page"] },
  ];
  for (const patch of patches) {
    const input = frozen([normalized()]);
    input.coverage[1] = { ...input.coverage[1], ...patch };
    const result = calculate(input);
    assert.equal(result.rows[0].value, 1, JSON.stringify(patch));
    assert.equal(result.rows[0].state, "partial", JSON.stringify(patch));
    assert.deepEqual([result.rows[0].numerator, result.rows[0].denominator, result.rows[0].share], [null, null, null]);
    assert.equal(result.fullyCoveredCalendarPeriods, null);
    assert.equal(result.shareUnavailableReason, "source_or_qualification_incomplete");
  }
});

test("all-time history preserves known periods without inventing a denominator or newcomer status", () => {
  const selected = { ...scope, from: null };
  const result = calculate(frozen([normalized()], selected), { scope: selected });
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.rows[0].state, "partial");
  assert.equal(result.fullyCoveredCalendarPeriods, null);
  assert.equal(result.rows[0].share, null);
  assert.equal(result.shareUnavailableReason, "unbounded_window");
  assert.equal(Object.hasOwn(result, "newcomer"), false);
});

test("unknown source dates and missing sum quantities cannot certify periods or an exact share", () => {
  const outputs = [normalized(), normalized({ number: 2, occurredAt: "2026-10-12T00:00:00Z" })];
  const missingDate = frozen(outputs);
  missingDate.facts = outputs
    .map(accepted)
    .map((fact, index) => ({ ...fact, occurredAt: index === 0 ? fact.occurredAt : null }));
  const dates = calculate(missingDate);
  assert.equal(dates.rows[0].value, 1);
  assert.equal(dates.rows[0].state, "partial");
  assert.equal(dates.rows[0].share, null);
  assert.deepEqual(dates.rows[0].evidenceIds, [accepted(outputs[0]).id]);
  // Explicit synthetic protected sum-source records; this does not claim line collection.
  const missingQuantity = frozen(outputs, scope, {
    facts: outputs
      .map(accepted)
      .map((fact, index) => ({ ...fact, metricId: "pr_lines_added", quantity: index === 0 ? 12 : undefined })),
  });
  const policy = periodPolicy({ sourcePolicies: [sourcePolicy({ metricId: "pr_lines_added", aggregation: "sum" })] });
  const sums = calculate(missingQuantity, { policy });
  assert.equal(sums.rows[0].value, 1);
  assert.equal(sums.rows[0].state, "partial");
  assert.equal(sums.rows[0].share, null);
  assert.ok(sums.audit.some((entry) => entry.reason === "unknown_source_quantity"));
});

test("unaccepted work, suppressed identities and automated accounts cannot create periods", () => {
  assert.deepEqual(calculate(frozen([normalized({ accept: false })])).rows, []);
  const input = frozen([normalized()]);
  input.actors = input.actors.map((actor) => ({ ...actor, publicState: "suppressed" }));
  assert.deepEqual(calculate(input).rows, []);
  const bot = normalized({
    author: { id: 404, node_id: "BOT_periods", type: "Bot", login: "synthetic-period-bot[bot]" },
  });
  assert.deepEqual(calculate(frozen([bot])).rows, []);
  assert.deepEqual(calculate(frozen([])).rows, []);
});

test("current filters, contradictory identities and unsupported policy selections retain their rejection boundaries", () => {
  const input = frozen([normalized()]);
  assert.throws(() => calculate(input, { scope: { ...scope, context: "current" } }), /event-time context/);
  const alias = { ...input, actors: [...input.actors, { ...input.actors[0], id: "202", githubDatabaseId: 202 }] };
  assert.throws(() => calculate(alias), /identity|node/i);
  for (const source of [
    sourcePolicy({ rankedStates: ["observed"] }),
    sourcePolicy({ groupBy: "actor_artifact" }),
    sourcePolicy({ metricId: "active_periods" }),
  ])
    assert.throws(() => calculate(input, { policy: periodPolicy({ sourcePolicies: [source] }) }));
  for (const sourcePolicies of [
    new Array(1),
    [sourcePolicy(), sourcePolicy()],
    [sourcePolicy(), sourcePolicy({ metricId: "issues_opened", roles: ["reporter"], rankedStates: ["reviewed"] })],
  ])
    assert.throws(() => calculate(input, { policy: periodPolicy({ sourcePolicies }) }));
  assert.throws(() => calculate(input, { policy: periodPolicy({ calendarUnit: "rolling_7_days" }) }));
});

test("reviewed corrections can withdraw a period without reusing the original active count", () => {
  const outputs = [normalized(), normalized({ number: 2, occurredAt: "2026-10-12T00:00:00Z" })];
  const input = frozen(outputs);
  const before = calculate(input);
  assert.equal(before.rows[0].value, 2);
  const target = accepted(outputs[1]);
  const corrected = {
    ...input,
    backfillRevision: "synthetic-correction/v2",
    facts: [
      ...input.facts,
      {
        ...target,
        id: "synthetic-period-withdrawal",
        revision: 1,
        correctionReceipt: "synthetic-reviewed-correction",
        state: "excluded",
      },
    ],
  };
  const after = calculate(corrected);
  assert.equal(after.rows[0].value, 1);
  assert.deepEqual(after.rows[0].evidenceIds, [accepted(outputs[0]).id]);
  assert.notEqual(after.backfillRevision, before.backfillRevision);
  assert.equal(before.rows[0].value, 2);
});

test("frozen replay and source-policy permutation preserve the exact result and source bindings", () => {
  const outputs = [normalized(), normalized({ repo: 9002, number: 2 }), normalized({ family: "issue", number: 3 })];
  const input = freeze(frozen(outputs));
  const policy = freeze(
    periodPolicy({
      sourcePolicies: [sourcePolicy(), sourcePolicy({ metricId: "issues_opened", roles: ["reporter"] })],
    }),
  );
  const before = stableJSON([input, policy]);
  const result = calculate(input, { policy });
  const reversed = calculate(
    { ...input, facts: [...input.facts].reverse(), actors: [...input.actors].reverse() },
    { policy: { ...policy, sourcePolicies: [...policy.sourcePolicies].reverse() } },
  );
  assert.deepEqual(result, reversed);
  assert.deepEqual(result, calculate(input, { policy }));
  assert.equal(stableJSON([input, policy]), before);
  assert.equal(result.rows[0].value, 1);
  assert.equal(result.sourcePolicySignatures.length, 2);
});
