import { syntheticRepositoryClient } from "../../github/test/synthetic-client.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGithubCollectionSource } from "../../../apps/pipeline/src/github-source.mjs";
import { createGithubEvidenceNormalizer, normalizeGithubObservation } from "../../github/dist/index.js";
import { aggregateMetric, getMetricDefinition, metricRegistryV1, selectPortfolioFacts } from "../dist/index.js";

// The case labels come from the historical organization audit. Every payload,
// identity, timestamp, membership and receipt below is deliberately synthetic;
// none is a new observation of the four public issues or their current Projects.
const cases = [
  ["https://github.com/Pick-Your-AI/.github/issues/2", 9001, "synthetic-owner/community", 2],
  ["https://github.com/Pick-Your-AI/pickyour.ai/issues/31", 9002, "synthetic-owner/website", 31],
  ["https://github.com/Pick-Your-AI/pickyour.ai/issues/32", 9002, "synthetic-owner/website", 32],
  ["https://github.com/Pick-Your-AI/pickyour.ai/issues/33", 9002, "synthetic-owner/website", 33],
];
const at = "2026-10-05T00:00:00Z";
const observedAt = "2026-10-06T00:00:00Z";
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: "2026-11-01T00:00:00Z",
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const reporter = { id: 101, node_id: "U_synthetic_reporter", type: "User", login: "synthetic-reporter" };
const member = { id: 202, node_id: "U_synthetic_member", type: "User", login: "synthetic-member" };
function policy(metricId = "issues_opened", patch = {}) {
  return {
    metricId,
    version: "synthetic-source-boundary/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: ["reporter"],
    groupBy: "canonical",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
    ...patch,
  };
}
function frozen(outputs, patch = {}) {
  return {
    datasetId: "synthetic-source-boundaries",
    cutoff: scope.to,
    backfillRevision: "synthetic-boundary/v1",
    repositoryIds: ["9001", "9002"],
    actors: [...new Map(outputs.flatMap((out) => out.actors).map((actor) => [actor.id, actor])).values()],
    facts: outputs.flatMap((out) => out.facts),
    coverage: [],
    ...patch,
  };
}
function envelope(index = 0, patch = {}) {
  const [, id, slug, number] = cases[index];
  return {
    repository: { id, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: at, isSynthetic: true },
    family: "issue",
    observedAt,
    payload: {
      id: 1000 + number,
      node_id: `I_synthetic_${id}_${number}`,
      number,
      html_url: `https://github.com/${slug}/issues/${number}`,
      created_at: at,
      updated_at: at,
      user: reporter,
      state: "open",
      assignees: [member],
      author_association: "MEMBER",
    },
    ...patch,
  };
}

test("the source boundary suite names exactly the four audited unboarded issue cases", async () => {
  const plan = JSON.parse(
    await readFile(new URL("../../../planning/plan-review-resolution.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    cases.map(([source]) => source),
    plan.org_acceptance_fixtures.find((item) => item.id === "ORG-CASE-01").sources,
  );
});

for (const [index, [sourceCase]] of cases.entries()) {
  test(`${sourceCase}: collection and hydration retain an unboarded reporter without crediting the assignee`, async () => {
    const input = envelope(index);
    const reads = [];
    const repository = { ...input.repository, installationId: 1, families: ["issues"], allowedProjectIds: [] };
    const client = syntheticRepositoryClient(repository.id, {
      rest: async (_source, path) => {
        reads.push(path);
        return path === `/repos/${repository.slug}` ? { id: repository.id, private: false } : input.payload;
      },
      scanRest: async (scan) =>
        scan.select([
          input.payload,
          { ...input.payload, node_id: "PR_synthetic", number: 999, pull_request: { url: "synthetic-pr-marker" } },
        ]),
    });
    const source = createGithubCollectionSource({
      client,
      sourceId: "synthetic",
      repositories: [repository],
      isSynthetic: true,
    });
    const page = await source.readPage({
      repositoryId: repository.id,
      runId: "synthetic",
      family: "issues",
      cursor: null,
      limit: 10,
    });
    assert.equal(page.expectedCount, 1, "the REST issues endpoint also contains PRs, which must be excluded");
    assert.equal(page.nextCursor, null);
    const normalize = createGithubEvidenceNormalizer({
      client,
      source: "synthetic",
      allowedRepositoryIds: [repository.id],
      isSynthetic: true,
    });
    const out = await normalize({
      repository,
      family: "issues",
      factKey: "synthetic",
      observedAt,
      policyVersion: "synthetic/v1",
      fact: page.facts[0],
    });
    const result = aggregateMetric(frozen([out]), policy(), scope);
    assert.deepEqual(
      result.rows.map((row) => [row.actorId, row.value]),
      [["101", 1]],
    );
    assert.equal(result.publicEnabled, false);
    assert.equal(
      out.facts.some((fact) => fact.actorId === "202"),
      false,
    );
    assert.equal(
      out.facts.some((fact) => ["issue_resolution", "confirmed_bugs", "accepted_findings"].includes(fact.metricId)),
      false,
    );
    assert.ok(
      out.facts.every(
        (fact) => fact.state === "observed" && fact.eventContext === null && fact.currentContext === null,
      ),
    );
    for (const context of ["event", "current"]) {
      const filtered = aggregateMetric(frozen([out]), policy(), { ...scope, projects: ["PVT_synthetic"], context });
      assert.deepEqual(filtered.rows, [], "unknown Project membership cannot be invented from repository inclusion");
      assert.ok(filtered.audit.some((entry) => entry.reason === "unknown_membership_context"));
    }
    assert.ok(reads.every((path) => !path.includes("projects")));
  });
}

test("reobserving the same four source facts preserves units and their first observation independent of input order", () => {
  const first = cases.map((_, index) => normalizeGithubObservation(envelope(index)));
  const repeated = cases.map((_, index) =>
    normalizeGithubObservation(envelope(index, { observedAt: "2026-10-07T00:00:00Z" })),
  );
  for (let index = 0; index < first.length; index++)
    assert.equal(first[index].facts[0].id, repeated[index].facts[0].id);
  const expected = aggregateMetric(frozen(first), policy(), scope);
  assert.equal(expected.rows[0].value, 4);
  for (const outputs of [
    [...first, ...repeated],
    [...repeated, ...first],
  ]) {
    assert.deepEqual(aggregateMetric(frozen(outputs), policy(), scope), expected);
    assert.deepEqual(
      selectPortfolioFacts(frozen(outputs), policy(), scope),
      selectPortfolioFacts(frozen(first), policy(), scope),
    );
  }
});

test("same-revision semantic conflicts still quarantine a source fact even when observation times differ", () => {
  const original = normalizeGithubObservation(envelope());
  for (const patch of [
    { actorId: "202" },
    { role: "triager" },
    { artifactId: "I_synthetic_other" },
    { repoId: "9002" },
    { occurredAt: "2026-10-05T00:00:01Z" },
    { state: "excluded" },
    { acceptanceReceipt: "synthetic-conflicting-receipt" },
    { eventContext: { projects: ["PVT_synthetic"], workstreams: [] } },
  ]) {
    const facts = [original.facts[0], { ...original.facts[0], ...patch, observedAt: "2026-10-07T00:00:00Z" }];
    const result = aggregateMetric(frozen([original], { facts }), policy(), scope);
    assert.deepEqual(result.rows, []);
    assert.ok(result.audit.some((entry) => entry.reason === "conflicting_revision"));
  }
});

test("reobserved corrections retain the first reviewed revision and the frozen cutoff boundary", () => {
  const original = normalizeGithubObservation(envelope());
  const correction = {
    ...original.facts[0],
    revision: 1,
    correctionReceipt: "synthetic-reviewed-correction",
    state: "excluded",
    observedAt: "2026-10-15T00:00:00Z",
  };
  const repeat = { ...correction, observedAt: "2026-10-16T00:00:00Z" };
  const facts = [repeat, original.facts[0], correction];
  const result = aggregateMetric(frozen([original], { facts }), policy(), scope);
  assert.deepEqual(result.rows, []);
  assert.equal(
    result.audit.some((entry) => entry.reason === "conflicting_revision"),
    false,
  );
  const historic = { ...scope, to: "2026-10-10T00:00:00Z" };
  assert.equal(
    aggregateMetric(frozen([original], { facts, cutoff: historic.to }), policy(), historic).rows[0].value,
    1,
  );
  const unreviewed = { ...repeat, revision: 2, correctionReceipt: null, state: "observed" };
  const rejected = aggregateMetric(frozen([original], { facts: [...facts, unreviewed] }), policy(), scope);
  assert.deepEqual(rejected.rows, []);
  assert.ok(rejected.audit.some((entry) => entry.reason === "unreviewed_revision"));
});

test("equivalent observation timestamp spellings select a stable retained receipt", () => {
  const original = normalizeGithubObservation(envelope());
  const short = { ...original.facts[0], observedAt };
  const long = { ...short, observedAt: "2026-10-06T00:00:00.000Z" };
  const forward = aggregateMetric(frozen([original], { facts: [short, long] }), policy(), scope);
  const reverse = aggregateMetric(frozen([original], { facts: [long, short] }), policy(), scope);
  assert.equal(forward.rows[0].value, 1);
  assert.deepEqual(forward, reverse);
});

test("REST and GraphQL bot aliases remain one automation identity despite wasAutomated false", () => {
  const aliases = [
    { id: 303, node_id: "B_synthetic_303", type: "Bot", login: "synthetic-project-automation[bot]" },
    { databaseId: 303, id: "B_synthetic_303", __typename: "Bot", login: "synthetic-project-automation" },
  ];
  const outputs = aliases.map((sender, index) =>
    normalizeGithubObservation({
      ...envelope(),
      family: "field_change",
      action: "project_status_changed",
      occurredAt: at,
      proof: {
        verified: true,
        source: index ? "github_graphql" : "github_rest",
        revision: at,
        eventId: "synthetic-event",
        isSynthetic: true,
      },
      payload: {
        id: "E_synthetic_status",
        url: envelope().payload.html_url,
        sender,
        wasAutomated: false,
        change: { before: "Todo", after: "Done" },
      },
    }),
  );
  for (const out of outputs) {
    assert.deepEqual(
      out.actors.map((actor) => [actor.id, actor.kind, actor.executionMode]),
      [["303", "bot", "unknown"]],
    );
    assert.ok(out.facts.every((fact) => fact.actorId === "303" && fact.state === "observed"));
  }
  const p = policy("project_status_updates", { roles: ["triager"], groupBy: "actor_artifact" });
  assert.deepEqual(aggregateMetric(frozen(outputs), p, scope).rows, []);
  assert.deepEqual(
    aggregateMetric(frozen(outputs), p, { ...scope, actors: "automation" }).rows.map((row) => [row.actorId, row.value]),
    [["303", 1]],
  );
  const unknown = normalizeGithubObservation({
    ...envelope(),
    payload: { ...envelope().payload, user: { id: 303, login: aliases[0].login } },
  });
  assert.deepEqual(unknown.actors, [], "a login alias alone cannot establish actor kind or identity");
});
