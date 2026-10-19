// Fictional PRs pass through the actual collector, normalizer, retained stores and
// createPipeline/runOnce publication. No fixture combines or deduplicates actors.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, components, publicScope, ago } from "./harness.mjs";

const mergedAt = ago(3);
const acceptedAt = ago(1);
const user = (id = 101, overrides = {}) => ({
  id,
  node_id: `U_fixture_${id}`,
  login: `fixture-contributor-${id}`,
  type: "User",
  ...overrides,
});
const pull = (number, author = user(), overrides = {}) => ({
  id: 1000 + number,
  node_id: `PR_fixture_${number}`,
  number,
  html_url: `https://github.com/example-org/example-repo/pull/${number}`,
  title: `Example tooling change ${number}`,
  created_at: ago(4),
  updated_at: mergedAt,
  merged_at: mergedAt,
  closed_at: mergedAt,
  state: "closed",
  merged: true,
  draft: false,
  base: { ref: "main" },
  head: { sha: "a".repeat(40) },
  user: author,
  merged_by: user(202),
  ...overrides,
});

async function setup(t, category, payloads, extra = {}) {
  let receiptCalls = 0;
  const policyVersion = `${category}-runtime-policy-v1`;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads,
    ...extra,
    components: {
      ...components,
      github: {
        ...components.github,
        applyRecognitionReceipt(...args) {
          receiptCalls++;
          return components.github.applyRecognitionReceipt(...args);
        },
      },
    },
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.recognitionBindings = [
        {
          category,
          scope: `repository:2:${category}:pr_merged`,
          policyVersion,
          metricId: category,
          sourceMetricId: "pr_merged",
          repositoryId: "2",
          reviewerIds: ["303"],
        },
      ];
      const policy = {
        ...config.policies[0].policy,
        metricId: category,
        version: policyVersion,
        unit: components.metrics.getMetricDefinition(category).definition.unit,
        dateBasis: "occurredAt",
        groupBy: "canonical",
        rankedStates: ["qualified"],
        roles: ["author", "coauthor"],
        rank: false,
      };
      config.policies = [
        {
          policy,
          signature: components.metrics.stableJSON(policy),
          approvalReceipt: "fixture-runtime-policy-approval",
        },
      ];
    },
  });
  function accept(pr) {
    const decision = {
      id: `fixture-${category}-decision-${pr.number}`,
      action: "accepted",
      actor: "303",
      at: Date.parse(acceptedAt),
      policyVersion,
    };
    const request = {
      id: `fixture-${category}-request-${pr.number}`,
      kind: "evidence",
      status: "accepted",
      owner: String(pr.user.id),
      category,
      scope: `repository:2:${category}:pr_merged`,
      policyVersion,
      locator: pr.html_url,
      collaborators: {},
      history: [decision],
    };
    h.controlsStore.transaction((state) => {
      state.requests[request.id] = request;
      state.audit.push(structuredClone(decision));
    });
  }
  return { ...h, accept, receiptCalls: () => receiptCalls };
}

async function publication(h, category, expected) {
  const result = await h.runtime.runOnce();
  assert.equal(result.state, "published");
  assert.equal(result.publications.length, 1);
  const id = result.publications[0].snapshotId;
  const response = await h.runtime.app.inject(`/api/v1/boards?metric=${category}&snapshot=${id}`);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.rows.map((row) => [row.actorId, row.result.value]).sort(), expected);
  const read = await h.runtime.source.read(publicScope, id, new AbortController().signal);
  assert.ok(read);
  for (const entry of read.selected.evidence.filter((proof) => proof.contribution.metricIds.includes(category))) {
    assert.equal(entry.occurredAt, mergedAt);
    assert.equal(entry.evidenceMetadata.acceptedAt, acceptedAt);
  }
  return body;
}

async function retained(h) {
  const rows = (
    await h.db.query(`
    SELECT fact.fact_key,fact.first_run_id,fact.observed_at,normalization.document
    FROM leaderboard_ingestion.source_facts AS fact
    JOIN leaderboard_pipeline.normalizations AS normalization USING(fact_key)
    ORDER BY fact.fact_key
  `)
  ).rows;
  assert.equal(rows.length, 2, "both independently stored PR observations must participate");
  assert.equal(new Set(rows.map((row) => row.fact_key)).size, 2);
  for (const row of rows) {
    assert.equal(row.document.facts.filter((fact) => fact.metricId === "pr_merged").length, 1);
    assert.equal(row.document.actors.filter((actor) => actor.id === "202").length, 1);
  }
  return rows;
}

for (const category of ["maintenance", "automation"]) {
  test(`${category}: two stored same-author PRs retain both accepted units without fixture actor deduplication`, async (t) => {
    const first = pull(10),
      second = pull(11);
    const h = await setup(t, category, [first, second]);
    h.accept(first);
    h.accept(second);
    const body = await publication(h, category, [["101", 2]]);
    assert.equal(h.receiptCalls(), 2);
    assert.equal(body.rows[0].evidenceIds.length, 2);
    const rows = await retained(h);
    assert.equal(rows.flatMap((row) => row.document.actors).filter((actor) => actor.id === "101").length, 2);
  });

  test(`${category}: an unclaimed second stored PR cannot make the first contributor unavailable`, async (t) => {
    const first = pull(10),
      second = pull(11);
    const h = await setup(t, category, [first, second]);
    h.accept(first);
    const body = await publication(h, category, [["101", 1]]);
    assert.equal(h.receiptCalls(), 1);
    assert.equal(body.rows[0].evidenceIds.length, 1);
    const rows = await retained(h);
    assert.equal(rows.flatMap((row) => row.document.actors).filter((actor) => actor.id === "101").length, 2);
  });

  test(`${category}: different stored PR authors retain distinct public contributors`, async (t) => {
    const first = pull(10),
      second = pull(11, user(102));
    const h = await setup(t, category, [first, second]);
    h.accept(first);
    h.accept(second);
    await publication(h, category, [
      ["101", 1],
      ["102", 1],
    ]);
    assert.equal(h.receiptCalls(), 2);
    await retained(h);
  });

  test(`${category}: a verified later source rename retains accepted units and accumulated automated execution`, async (t) => {
    const first = pull(10);
    first.sender = structuredClone(first.user);
    first.execution_mode = "automated";
    const h = await setup(t, category, [first], { reverseNormalizationRows: true });
    h.accept(first);
    const before = await publication(h, category, [["101", 1]]);
    assert.equal(before.rows[0].actor.executionMode, "automated");
    const second = pull(11, user(101, { login: "fixture-renamed-contributor" }), {
      updated_at: new Date().toISOString(),
    });
    h.add(second);
    h.accept(second);
    const after = await publication(h, category, [["101", 2]]);
    const actor = after.rows[0].actor;
    assert.equal(actor.login, "fixture-renamed-contributor");
    assert.equal(actor.githubNodeId, "U_fixture_101");
    assert.equal(actor.githubDatabaseId, 101);
    assert.equal(actor.kind, "user");
    assert.equal(actor.executionMode, "automated");
    const rows = await retained(h);
    assert.equal(new Set(rows.map((row) => row.first_run_id)).size, 2);
    assert.equal(new Set(rows.map((row) => new Date(row.observed_at).toISOString())).size, 2);
    assert.deepEqual(rows.map((row) => row.document.actors.find((actor) => actor.id === "101").login).sort(), [
      "fixture-contributor-101",
      "fixture-renamed-contributor",
    ]);
  });

  for (const [name, overrides] of [
    ["immutable provider identity", { node_id: "U_fixture_conflicting_identity" }],
    ["actor kind", { type: "Bot" }],
  ]) {
    test(`${category}: conflicting ${name} across stored observations is rejected before receipt materialization`, async (t) => {
      const first = pull(10),
        second = pull(11, user(101, overrides));
      const h = await setup(t, category, [first, second]);
      h.accept(first);
      await assert.rejects(h.runtime.runOnce(), /conflicting_actor_metadata/);
      assert.equal(h.receiptCalls(), 0);
      await retained(h);
      assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
    });
  }
}
