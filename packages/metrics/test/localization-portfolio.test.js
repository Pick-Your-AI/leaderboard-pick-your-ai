import assert from "node:assert/strict";
import test from "node:test";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateMetric, getMetricDefinition, selectPortfolioFacts } from "../dist/index.js";

// Every source, identity, path, review and timestamp in this suite is synthetic.
// The real normalizer and recognition adapter supply the facts under test.
const before = "b".repeat(40);
const after = "c".repeat(40);
const firstObservation = "2026-10-08T10:00:00.000Z";
const laterObservation = "2026-10-09T10:00:00.000Z";
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const metricPolicy = {
  metricId: "localization",
  version: "synthetic-localization-portfolio/v1",
  definitionVersion: "synthetic-definition/v1",
  unit: getMetricDefinition("localization").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["qualified"],
  roles: ["author", "coauthor"],
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
};
const pathPolicy = {
  repositoryId: 2,
  version: "synthetic-locales-v1",
  documentationPaths: ["docs/"],
  researchPaths: [],
  generatedPaths: [],
  importedPaths: [],
  localizationPaths: [
    { locale: "fr", category: "documentation", paths: ["docs/fr/"] },
    { locale: "de", category: "documentation", paths: ["docs/de/"] },
  ],
};

function observe(observedAt) {
  const files = ["docs/fr/guide.md", "docs/de/guide.md"].map((path) => ({ path, additions: 1, deletions: 0 }));
  return normalizeGithubObservation(
    {
      repository: { id: 2, slug: "synthetic-owner/locales", visibility: "public", defaultBranch: "main" },
      proof: { verified: true, source: "github_rest", revision: after, isSynthetic: true },
      family: "pull_request",
      observedAt,
      payload: {
        pull_request: {
          number: 10,
          node_id: "PR_SYNTHETIC_LOCALES",
          html_url: "https://github.com/synthetic-owner/locales/pull/10",
          user: { id: 101, node_id: "U_SYNTHETIC_AUTHOR", type: "User", login: "synthetic-author" },
          merged_by: { id: 202, node_id: "U_SYNTHETIC_MERGER", type: "User", login: "synthetic-merger" },
          merged: true,
          merged_at: "2026-10-07T10:00:00.000Z",
          merge_commit_sha: after,
          base: { ref: "main" },
        },
      },
      integration: {
        before,
        after,
        targetBranch: "main",
        defaultBranch: "main",
        canonicalChangeId: "synthetic-locale-merge",
        commitShas: [after],
        diff: { before, after, complete: true, files },
      },
    },
    pathPolicy,
  );
}
const locale = (output, code) =>
  output.facts.find((fact) => fact.metricId === "localization" && fact.rawState.includes(`:${code}:`));
function accept(output) {
  const target = locale(output, "fr");
  return applyRecognitionReceipt(
    output,
    {
      id: "synthetic-locale-review",
      verified: true,
      metricId: "localization",
      actorId: "101",
      reviewerId: "303",
      acceptedAt: laterObservation,
      sourceRevision: after,
      decision: "accepted",
      targetFactId: target.id,
      evidenceIds: [target.id],
    },
    ["303"],
  );
}
function input(outputs, overrides = {}) {
  return {
    datasetId: "synthetic-localization-portfolio",
    cutoff: scope.to,
    backfillRevision: "synthetic/v1",
    repositoryIds: ["2", "3"],
    actors: [...new Map(outputs.flatMap((output) => output.actors).map((actor) => [actor.id, actor])).values()],
    facts: outputs.flatMap((output) => output.facts),
    coverage: [],
    ...overrides,
  };
}
const selected = (frozen, requestedScope = scope) => selectPortfolioFacts(frozen, metricPolicy, requestedScope);

test("reobserved localization acceptance replaces exactly its raw portfolio entry", () => {
  const first = observe(firstObservation);
  const accepted = accept(observe(laterObservation));
  const recognized = accepted.facts.find((fact) => fact.state === "qualified");
  const expected = [recognized.id, locale(first, "de").id].sort();
  const baseline = input([accepted]);
  assert.deepEqual(
    selected(baseline)
      .map((fact) => fact.id)
      .sort(),
    expected,
  );
  for (const outputs of [
    [first, accepted],
    [accepted, first],
  ]) {
    const frozen = input(outputs);
    const original = structuredClone(frozen);
    const portfolio = selected(frozen);
    assert.deepEqual(portfolio.map((fact) => fact.id).sort(), expected);
    assert.equal(portfolio.filter((fact) => fact.state === "qualified").length, 1);
    assert.equal(portfolio.find((fact) => fact.id === locale(first, "de").id).observedAt, firstObservation);
    const board = aggregateMetric(frozen, metricPolicy, scope);
    assert.equal(board.rows[0].value, 1);
    assert.equal(board.publicEnabled, false);
    assert.deepEqual(frozen, original, "selection cannot mutate retained source or review facts");
  }
});

test("repeated accepted observations retain one accepted activity and the unrelated raw locale", () => {
  const first = observe(firstObservation);
  const accepted = accept(observe(laterObservation));
  const repeated = structuredClone(accepted);
  for (const fact of repeated.facts) fact.observedAt = "2026-10-10T10:00:00.000Z";
  for (const outputs of [
    [repeated, first, accepted],
    [accepted, repeated, first],
  ]) {
    const portfolio = selected(input(outputs));
    assert.equal(portfolio.length, 2);
    assert.equal(portfolio.find((fact) => fact.state === "qualified").observedAt, laterObservation);
    assert.equal(portfolio.filter((fact) => fact.state === "observed").length, 1);
  }
});

test("collection time cannot weaken the source identity and locale binding", () => {
  const first = observe(firstObservation);
  const accepted = accept(observe(laterObservation));
  const rawIds = [locale(first, "fr").id, locale(first, "de").id].sort();
  const changes = [
    { recognitionSourceFactId: "synthetic-unrelated-source" },
    { recognitionSourceFactId: locale(first, "de").id },
    { actorId: "202" },
    { artifactId: "synthetic-other-pr" },
    { repoId: "3" },
    { role: "coauthor" },
    { rawState: "synthetic-other-locale" },
    { occurredAt: "2026-10-08T10:00:00.000Z" },
  ];
  for (const change of changes) {
    const altered = structuredClone(accepted);
    Object.assign(
      altered.facts.find((fact) => fact.state === "qualified"),
      change,
    );
    const portfolio = selected(input([first, altered]));
    assert.deepEqual(
      portfolio
        .filter((fact) => fact.state === "observed")
        .map((fact) => fact.id)
        .sort(),
      rawIds,
      JSON.stringify(change),
    );
  }
});

test("invalid, future and withdrawn acceptance keep the original raw portfolio activities", () => {
  const first = observe(firstObservation);
  const accepted = accept(observe(laterObservation));
  const rawIds = [locale(first, "fr").id, locale(first, "de").id].sort();
  for (const change of [
    { acceptedBy: "101" },
    { acceptanceReceipt: null },
    { acceptedAt: null },
    { acceptedAt: "2026-11-02T10:00:00.000Z" },
  ]) {
    const altered = structuredClone(accepted);
    Object.assign(
      altered.facts.find((fact) => fact.state === "qualified"),
      change,
    );
    assert.deepEqual(
      selected(input([first, altered]))
        .map((fact) => fact.id)
        .sort(),
      rawIds,
    );
  }
  const recognized = accepted.facts.find((fact) => fact.state === "qualified");
  const withdrawn = {
    ...recognized,
    revision: 1,
    state: "excluded",
    correctionReceipt: "synthetic-withdrawal",
    observedAt: "2026-10-11T10:00:00.000Z",
  };
  assert.deepEqual(
    selected(input([first, accepted], { facts: [...first.facts, ...accepted.facts, withdrawn] }))
      .map((fact) => fact.id)
      .sort(),
    rawIds,
  );
  const cutoff = "2026-10-09T00:00:00.000Z";
  const historical = input([first, accepted], { cutoff });
  assert.deepEqual(
    selected(historical, { ...scope, to: cutoff })
      .map((fact) => fact.id)
      .sort(),
    rawIds,
  );
});
