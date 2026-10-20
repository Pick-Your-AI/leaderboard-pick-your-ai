// Fictional HTTP/native history, real GitHub client, default source, collection,
// normalization and private frozen readers. No live service or source evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { components, clock, harness, publicScope } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { readDecisionGenerations } from "../src/pull-request-decision-history.mjs";
import {
  decisionEvent,
  decisionFixture,
  decisionRepository,
  decisionSubject,
} from "../../../tests/fixtures/pull-request-decision-history.mjs";

const testOptions = { timeout: 120_000 };
const iso = (value) => new Date(value).toISOString();
const source = "synthetic-installation:1";
const metric = "pr_opened";
const rowClock = "to_char(fact.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
const accessError = { message: "active_configuration_revoked_source" };

function provider() {
  const native = decisionFixture();
  const { state, checkpoints } = native;
  const createdAt = iso(Date.now() - 3 * 86400_000);
  const updatedAt = iso(Date.now() - 86400_000);
  Object.assign(state.native, { createdAt, updatedAt });
  state.timelineUpdatedAt = updatedAt;
  Object.assign(state, {
    inventory: "one",
    forbidCollectedReads: false,
    forbidNormalization: false,
    normalized: 0,
    probes: 0,
    lists: 0,
    details: 0,
    graphql: 0,
    tokens: 0,
    beforeGraphqlResponse: null,
    decisionClock: clock,
  });
  const repository = {
    id: 2,
    full_name: decisionRepository.slug,
    private: false,
    default_branch: "main",
  };
  const pull = {
    id: decisionSubject.databaseId,
    node_id: decisionSubject.id,
    number: 7,
    html_url: decisionSubject.url,
    created_at: createdAt,
    updated_at: updatedAt,
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    closed_at: null,
    title: "Synthetic private decision observation",
    base: { ref: "main", repo: repository },
    user: {
      id: 101,
      node_id: "U_SYNTHETIC_AUTHOR",
      login: "synthetic-decision-author",
      type: "User",
    },
  };
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => {
      state.tokens++;
      return "synthetic-decision-token";
    },
    checkpoints,
    maxRetries: 0,
    fetch: async (value, request) => {
      const url = new URL(value);
      let body;
      const headers = { "content-type": "application/json" };
      if ((request?.method ?? "GET") === "POST") {
        assert.equal(state.forbidCollectedReads, false, "frozen reuse must not recollect native history");
        state.graphql++;
        const { query, variables } = JSON.parse(request.body);
        const operation = query.match(/query\s+([A-Za-z0-9_]+)/)?.[1];
        assert.ok(["PullRequestDecisionAnchor", "PullRequestDecisionHistory"].includes(operation));
        assert.equal(variables.owner, "synthetic-owner");
        assert.equal(variables.name, "repository");
        assert.equal(variables.number, 7);
        const call = { operation, query, variables };
        state.calls.push(call);
        const after = variables.after;
        const start = after === null || after === undefined ? 0 : Number(after.slice(2));
        const slice = state.events.slice(start, start + state.pageSize);
        const end = start + slice.length;
        const connection = { totalCount: state.totalCount, updatedAt: state.timelineUpdatedAt };
        if (operation === "PullRequestDecisionHistory")
          Object.assign(connection, {
            filteredCount: state.totalCount - start,
            pageCount: slice.length,
            pageInfo: { hasNextPage: end < state.totalCount, endCursor: slice.length ? "C_" + end : null },
            edges: slice.map((node, index) => ({ cursor: "C_" + (start + index + 1), node: structuredClone(node) })),
          });
        body = {
          data: {
            repository: {
              databaseId: 2,
              nameWithOwner: decisionRepository.slug,
              isPrivate: false,
              pullRequest: { ...structuredClone(state.native), timelineItems: connection },
            },
          },
        };
        state.transform?.(call, body);
        await state.beforeGraphqlResponse?.(call, body);
      } else if (url.pathname === "/repos/" + decisionRepository.slug) {
        // Frozen retries still verify current repository visibility.
        state.probes++;
        body = repository;
      } else if (url.pathname === "/repos/" + decisionRepository.slug + "/pulls") {
        assert.equal(state.forbidCollectedReads, false, "frozen reuse must not list source objects");
        state.lists++;
        if (state.inventory === "partial" && url.searchParams.get("page") === "2")
          return new Response(JSON.stringify({ message: "synthetic second inventory page unavailable" }), {
            status: 503,
            headers,
          });
        body = state.inventory === "empty" ? [] : [structuredClone(pull)];
        if (state.inventory === "partial")
          headers.link = "<https://api.synthetic.invalid/repos/" + decisionRepository.slug + "/pulls?page=2>; rel=\"next\"";
      } else if (url.pathname === "/repos/" + decisionRepository.slug + "/pulls/7") {
        assert.equal(state.forbidCollectedReads, false, "frozen reuse must not hydrate a source object");
        state.details++;
        body = structuredClone(pull);
      } else {
        assert.fail("unexpected synthetic provider path: " + url.pathname);
      }
      return new Response(JSON.stringify(body), { status: 200, headers });
    },
  });
  const selectedComponents = {
    ...components,
    github: {
      ...components.github,
      createGithubEvidenceNormalizer(options) {
        const normalize = components.github.createGithubEvidenceNormalizer(options);
        return async (input) => {
          assert.equal(state.forbidNormalization, false, "frozen reuse must use its retained normalization");
          state.normalized++;
          return normalize(input);
        };
      },
    },
  };
  return { client, state, pull, selectedComponents };
}

async function setup(t, { enabled = true, inventory = "one" } = {}) {
  const p = provider();
  p.state.inventory = inventory;
  const h = await harness(t, {
    memoryDatabase: true,
    components: p.selectedComponents,
    githubClient: p.client,
    sourceId: source,
    source: undefined,
    probeRepository: undefined,
    ...(enabled ? { pullRequestDecisionRepositoryIds: [2] } : {}),
    decisionHistoryNow: () => p.state.decisionClock(),
    configure(config) {
      config.repositories[0].slug = decisionRepository.slug;
      config.repositories[0].families = ["pull_requests"];
      const policy = {
        metricId: metric,
        version: "synthetic-private-decision-policy-v1",
        definitionVersion: components.metrics.metricRegistryV1.policy_version,
        unit: components.metrics.getMetricDefinition(metric).definition.unit,
        aggregation: "count",
        dateBasis: "occurredAt",
        rankedStates: ["observed"],
        roles: ["author"],
        groupBy: "actor_artifact",
        sources: ["github_rest"],
        minimumSamples: 1,
        rank: false,
      };
      config.policies = [{ policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-pr-policy" }];
      config.scopes = [publicScope];
    },
  });
  assert.equal(h.options.source, undefined);
  assert.equal(h.options.probeRepository, undefined);
  assert.equal(h.options.normalizer, undefined);
  assert.equal(h.options.githubEnrich, undefined);
  return { h, p, runtime: h.runtime };
}

const sourceRows = (h) =>
  h.db.query(
    "SELECT fact.fact_key,fact.repository_id::text AS repository_id,fact.family,fact.subject_id," +
      "fact.source_revision,fact.document,fact.first_run_id," + rowClock + " AS observed_at " +
      "FROM leaderboard_ingestion.source_facts AS fact ORDER BY fact.fact_key",
  ).then((result) => result.rows);
const normalizations = (h) =>
  h.db.query(
    "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
  ).then((result) => result.rows);
const scans = (h) =>
  h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations ORDER BY configuration_key").then((result) => result.rows);

async function frozen(h, publication) {
  const row = (await h.db.query(
    "SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1",
    [publication.snapshotId],
  )).rows[0];
  assert.ok(row);
  assert.equal(comparisonHash(row.document), row.document_hash);
  return row;
}

function onlyPublication(result) {
  assert.equal(result.state, "published");
  assert.equal(result.publications.length, 1);
  return result.publications[0];
}

async function noPublication(h) {
  for (const table of ["snapshots", "heads", "frozen_inputs"])
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline." + table)).rows, [], table);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
}

function revokeConfiguration(h) {
  h.controlsStore.transaction((state) => {
    state.configuration = {
      revision: 1,
      proposals: {},
      history: [],
      active: {
        version: "synthetic-decision-source-withdrawn",
        digest: "a".repeat(64),
        approval: { id: "synthetic-source-withdrawal" },
        document: { repositories: [], projects: [], metrics: [] },
      },
    };
  }, { publish: true });
}

function stopAfterNormalizationCommit(h, message) {
  const transaction = h.db.transaction;
  let entered = 0;
  h.db.transaction = async (work) => {
    let selected = false;
    const result = await transaction(async (tx) => work({
      query: async (sql, params) => {
        const value = await tx.query(sql, params);
        if (/INSERT\s+INTO\s+leaderboard_pipeline\.normalizations\b/.test(sql)) selected = true;
        return value;
      },
    }));
    if (selected && entered === 0) {
      entered++;
      throw new Error(message);
    }
    return result;
  };
  return {
    entered: () => entered,
    restore() { h.db.transaction = transaction; },
  };
}

async function captureFor(f, publication, progress) {
  const { h, p, runtime } = f;
  const saved = await frozen(h, publication);
  const capture = saved.document.identityAuthorization.pullRequestDecisionEvidence;
  assert.ok(capture);
  assert.equal(capture.schemaVersion, "pipeline-pr-decision-generations/v1");
  assert.equal(capture.source, source);
  assert.equal(capture.observationCutoff, saved.document.frozen.cutoff);
  assert.deepEqual(
    capture.runs.map((run) => ({ repositoryId: Number(run.repositoryId), runId: run.runId })),
    progress.filter((run) => run.family === "pull_requests").map(({ repositoryId, runId }) => ({ repositoryId, runId })),
  );
  assert.equal(publication.comparisonInput.state, "retained");
  const record = runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
  assert.deepEqual(record.authorization.pullRequestDecisionEvidence, capture);
  assert.equal(record.input.cutoff, capture.observationCutoff);
  const explanation = await runtime.aggregateExplanations.read(publication.snapshotId);
  assert.deepEqual(explanation.document.authorization.pullRequestDecisionEvidence, capture);
  assert.equal(explanation.document.cutoff, capture.observationCutoff);
  let restored = 0;
  await runtime.policyComparisons.withAuthorizedInputs([record.authorization], (_removed, authority) => {
    const input = authority.restoreInput(record.input, record.authorization);
    assert.deepEqual(input.facts, record.input.facts);
    assert.equal(input.cutoff, capture.observationCutoff);
    restored++;
  });
  assert.equal(restored, 1);
  const selected = await h.db.transaction((tx) => readDecisionGenerations(tx, {
    selectedRuns: capture.runs.map((run) => ({ repositoryId: Number(run.repositoryId), runId: run.runId })),
    repositories: h.config.repositories,
    source,
    asOf: capture.asOf,
    observationCutoff: capture.observationCutoff,
    dataMode: "synthetic",
    assertAuthorized() { assert.equal(p.state.authorized, true); },
    expected: capture,
  }));
  assert.deepEqual(selected.capture, capture);
  return { saved, capture, record, explanation, selected };
}

async function assertCapturedRow(row, capture) {
  const observation = row.document.pullRequestDecisionHistory;
  assert.equal(observation.schemaVersion, "pipeline-pr-decision-observation/v1");
  assert.equal(observation.sourceRevision, row.source_revision);
  assert.equal(observation.binding.semanticRevision, row.source_revision);
  assert.equal(observation.binding.source, source);
  assert.equal(observation.binding.subject.id, row.subject_id);
  assert.equal(observation.result.status, "captured");
  const validated = components.github.validatePullRequestDecisionHistory(observation.result.receipt, {
    binding: observation.binding,
    generation: observation.generation,
  });
  assert.equal(validated.status, "validated");
  assert.equal(validated.receipt.digest, observation.result.receipt.digest);
  assert.ok(components.contracts.compareSourceInstants(validated.receipt.capture.completedAt, row.observed_at) <= 0);
  assert.ok(components.contracts.compareSourceInstants(row.observed_at, capture.observationCutoff) <= 0);
  const retained = capture.runs.flatMap((run) => run.observations).find((item) => item.factKey === row.fact_key);
  assert.ok(retained);
  assert.equal(retained.observationHash, comparisonHash(observation));
  assert.equal(retained.sourceRevision, row.source_revision);
  assert.equal(components.contracts.compareSourceInstants(retained.observedAt, row.observed_at), 0);
  return observation;
}

async function assertPrivateOnly(f) {
  const rows = await normalizations(f.h);
  for (const row of rows)
    assert.doesNotMatch(JSON.stringify(row.document), /pullRequestDecisionHistory|pipeline-pr-decision-observation/);
  for (const path of [
    "/api/v1/boards?metric=" + metric,
    "/api/v1/exports?metric=" + metric + "&format=json",
  ]) {
    const response = await f.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /pullRequestDecisionEvidence|pipeline-pr-decision|github-pr-decision-history/);
  }
}

test("native decision observations retain new generations without rewriting the PR revision", testOptions, async (t) => {
  const f = await setup(t);
  const { h, p, runtime } = f;
  const cutoff = iso(Date.now() - 10_000);
  p.state.events = [
    decisionEvent("closed", iso(Date.parse(p.pull.created_at) + 3600_000), "E_SYNTHETIC_CLOSED"),
    decisionEvent("reopened", iso(Date.parse(p.pull.created_at) + 7200_000), "E_SYNTHETIC_REOPENED"),
  ];
  p.state.totalCount = p.state.events.length;
  const nativeBefore = JSON.stringify(p.pull);
  const first = await runtime.runOnce({ cutoff });
  const publication = onlyPublication(first);
  const a = await captureFor(f, publication, first.progress);
  const original = await sourceRows(h);
  assert.equal(original.length, 1);
  const firstObservation = await assertCapturedRow(original[0], a.capture);
  assert.equal(p.state.graphql, 3, "complete history uses both anchors and the native history request");
  assert.equal(p.state.normalized, 1);
  assert.equal(a.selected.selections.length, 1);
  assert.equal(a.selected.selections[0].selection.status, "selected");
  assert.equal(a.selected.selections[0].selection.outcome, "pending");
  assert.deepEqual(a.selected.selections[0].selection.sourceEventIds, ["E_SYNTHETIC_REOPENED"]);

  // A separate corrupt private row has a matching digest and bounded text.
  // The decoder must reject its depth before hashing, without touching A.
  const originalRow = h.controlsStore.db.prepare(
    "SELECT document,digest,expires FROM policy_preview_inputs WHERE id=?",
  ).get(publication.comparisonInput.inputId);
  const excessive = JSON.parse(originalRow.document);
  let deep = { value: "synthetic-private-depth" };
  for (let index = 0; index < 33; index++) deep = { next: deep };
  excessive.authorization.pullRequestDecisionEvidence.excessive = deep;
  const excessiveText = JSON.stringify(excessive);
  const excessiveDigest = comparisonHash(excessive);
  assert.ok(Buffer.byteLength(excessiveText) < 2 * 1024 * 1024);
  assert.notEqual(excessiveDigest, publication.comparisonInput.inputId);
  h.controlsStore.db.prepare("INSERT INTO policy_preview_inputs VALUES(?,?,?,?)").run(
    excessiveDigest, excessiveText, excessiveDigest, originalRow.expires,
  );
  try {
    assert.throws(() => runtime.policyComparisons.comparisons.input(excessiveDigest), {
      status: 409,
      message: "Private comparison integrity failure",
    });
  } finally {
    h.controlsStore.db.prepare("DELETE FROM policy_preview_inputs WHERE id=?").run(excessiveDigest);
  }
  assert.deepEqual(h.controlsStore.db.prepare(
    "SELECT document,digest,expires FROM policy_preview_inputs WHERE id=?",
  ).get(publication.comparisonInput.inputId), originalRow);
  assert.deepEqual(runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId), a.record);

  const later = await runtime.runOnce({ cutoff: iso(Date.parse(cutoff) + 1000) });
  const b = await captureFor(f, onlyPublication(later), later.progress);
  const retained = await sourceRows(h);
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.find((row) => row.fact_key === original[0].fact_key), original[0]);
  const next = retained.find((row) => row.fact_key !== original[0].fact_key);
  const nextObservation = await assertCapturedRow(next, b.capture);
  assert.equal(next.subject_id, original[0].subject_id);
  assert.equal(next.source_revision, original[0].source_revision);
  assert.equal(next.source_revision, p.pull.updated_at);
  assert.notEqual(nextObservation.generation.scanId, firstObservation.generation.scanId);
  assert.notEqual(nextObservation.generation.asOf, firstObservation.generation.asOf);
  assert.equal(firstObservation.generation.scanId, first.progress[0].runId);
  assert.equal(nextObservation.generation.scanId, later.progress[0].runId);
  assert.equal(JSON.stringify(p.pull), nativeBefore);
  assert.equal(p.state.graphql, 6);
  assert.equal(p.state.normalized, 2);
  const membership = (await h.db.query(
    "SELECT run_id,fact_key FROM leaderboard_ingestion.collection_items ORDER BY run_id,fact_key",
  )).rows;
  assert.equal(membership.length, 2);
  assert.ok(membership.some((item) => item.run_id === first.progress[0].runId && item.fact_key === original[0].fact_key));
  assert.ok(membership.some((item) => item.run_id === later.progress[0].runId && item.fact_key === next.fact_key));
  await captureFor(f, publication, first.progress);
  await assertPrivateOnly(f);
});

test("an unconfirmed frozen decision generation resumes after later unpublished capture without recollection", testOptions, async (t) => {
  const f = await setup(t);
  const { h, p, runtime } = f;
  const stopA = stopAfterNormalizationCommit(h, "synthetic_decision_stop_after_A_commit");
  try {
    await assert.rejects(runtime.runOnce(), { message: "synthetic_decision_stop_after_A_commit" });
  } finally {
    stopA.restore();
  }
  assert.equal(stopA.entered(), 1);
  const originalSources = await sourceRows(h);
  const originalNormalizations = await normalizations(h);
  const continuation = await scans(h);
  assert.equal(originalSources.length, 1);
  assert.equal(originalNormalizations.length, 1);
  assert.equal(continuation.length, 1);
  assert.notEqual(continuation[0].observation_cutoff, null);
  assert.ok(Object.values(continuation[0].scope_heads).every((head) => head === null));
  const aObservation = originalSources[0].document.pullRequestDecisionHistory;
  const aCutoff = iso(continuation[0].event_cutoff);
  const aFrozenCutoff = iso(continuation[0].observation_cutoff);
  assert.equal(aObservation.generation.asOf, aCutoff);
  assert.equal(p.state.graphql, 3);
  assert.equal(p.state.normalized, 1);
  await noPublication(h);

  const stopB = stopAfterNormalizationCommit(h, "synthetic_decision_stop_after_B_commit");
  try {
    await assert.rejects(runtime.runOnce({ cutoff: clock(), mode: "audit" }), {
      message: "synthetic_decision_stop_after_B_commit",
    });
  } finally {
    stopB.restore();
  }
  assert.equal(stopB.entered(), 1);
  const allSources = await sourceRows(h);
  const allNormalizations = await normalizations(h);
  assert.equal(allSources.length, 2);
  assert.equal(allNormalizations.length, 2);
  assert.deepEqual(allSources.find((row) => row.fact_key === originalSources[0].fact_key), originalSources[0]);
  assert.deepEqual(
    allNormalizations.find((row) => row.fact_key === originalNormalizations[0].fact_key),
    originalNormalizations[0],
  );
  const bRow = allSources.find((row) => row.fact_key !== originalSources[0].fact_key);
  assert.equal(bRow.source_revision, originalSources[0].source_revision);
  assert.notEqual(bRow.document.pullRequestDecisionHistory.generation.scanId, aObservation.generation.scanId);
  assert.ok(components.contracts.compareSourceInstants(bRow.observed_at, aFrozenCutoff) > 0);
  assert.deepEqual(await scans(h), continuation, "explicit B cannot retire or replace pending implicit A");
  await noPublication(h);

  const before = { graphql: p.state.graphql, lists: p.state.lists, details: p.state.details, normalized: p.state.normalized };
  const probes = p.state.probes;
  p.state.forbidCollectedReads = true;
  p.state.forbidNormalization = true;
  const resumed = await runtime.runOnce();
  const publication = onlyPublication(resumed);
  const a = await captureFor(f, publication, resumed.progress);
  assert.equal(a.capture.asOf, aCutoff);
  assert.equal(a.capture.observationCutoff, aFrozenCutoff);
  assert.deepEqual(a.capture.runs.map((run) => run.runId), [aObservation.generation.scanId]);
  assert.deepEqual(a.capture.runs.flatMap((run) => run.observations.map((item) => item.factKey)), [originalSources[0].fact_key]);
  assert.deepEqual(await sourceRows(h), allSources);
  assert.deepEqual(await normalizations(h), allNormalizations);
  assert.deepEqual(await scans(h), []);
  assert.deepEqual(
    { graphql: p.state.graphql, lists: p.state.lists, details: p.state.details, normalized: p.state.normalized },
    before,
  );
  assert.ok(p.state.probes > probes, "current visibility is still checked on the frozen retry");
});

for (const kind of ["pending", "history incomplete", "empty inventory"])
  test("decision capture distinguishes " + kind + " through the actual completed source run", testOptions, async (t) => {
    const f = await setup(t, { inventory: kind === "empty inventory" ? "empty" : "one" });
    const { h, p, runtime } = f;
    if (kind === "history incomplete") {
      p.state.transform = (call, body) => {
        if (call.operation === "PullRequestDecisionHistory")
          body.data.repository.pullRequest.timelineItems.pageInfo.hasNextPage = true;
      };
    }
    const run = await runtime.runOnce({ cutoff: iso(Date.now() - 10_000) });
    const publication = onlyPublication(run);
    assert.equal(run.progress.length, 1);
    assert.equal(run.progress[0].status, "complete");
    const binding = await captureFor(f, publication, run.progress);
    const rows = await sourceRows(h);
    if (kind === "empty inventory") {
      assert.deepEqual(rows, []);
      assert.deepEqual(binding.capture.runs[0].observations, []);
      assert.deepEqual(binding.selected.selections, []);
      assert.equal(p.state.graphql, 0);
      assert.equal(p.state.normalized, 0);
      assert.equal((await h.db.query("SELECT item_count,expected_count FROM leaderboard_ingestion.collection_runs")).rows[0].item_count, 0);
    } else {
      assert.equal(rows.length, 1);
      const result = rows[0].document.pullRequestDecisionHistory.result;
      assert.ok((await normalizations(h)).some((row) => row.document.facts.some((fact) => fact.metricId === metric)));
      assert.equal(binding.selected.selections.length, 1);
      if (kind === "pending") {
        await assertCapturedRow(rows[0], binding.capture);
        assert.equal(result.status, "captured");
        assert.deepEqual(result.receipt.history, []);
        assert.equal(result.receipt.pagination.totalCount, 0);
        assert.equal(result.receipt.pagination.terminal, true);
        assert.equal(binding.selected.selections[0].selection.status, "selected");
        assert.equal(binding.selected.selections[0].selection.outcome, "pending");
      } else {
        assert.deepEqual(result, { status: "unavailable", reason: "history_incomplete" });
        assert.deepEqual(binding.selected.selections[0].selection, { status: "unavailable", reason: "history_incomplete" });
      }
    }
    await assertPrivateOnly(f);
  });

test("a failed later REST inventory page cannot become a complete empty decision generation", testOptions, async (t) => {
  const f = await setup(t, { inventory: "partial" });
  const { h, p, runtime } = f;
  const result = await runtime.runOnce({ cutoff: iso(Date.now() - 10_000) });
  assert.equal(result.state, "collecting");
  assert.equal(result.progress.length, 1);
  assert.equal(result.progress[0].status, "failed");
  assert.equal(p.state.lists, 2);
  assert.equal(p.state.graphql, 0, "native history begins only after complete REST inventory");
  assert.equal(p.state.normalized, 0);
  const runs = (await h.db.query("SELECT state,item_count,expected_count FROM leaderboard_ingestion.collection_runs")).rows;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "failed");
  assert.equal(runs[0].item_count, 0);
  assert.equal(runs[0].expected_count, null);
  assert.deepEqual(await sourceRows(h), []);
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_ingestion.collection_items")).rows, []);
  await noPublication(h);
});


test("a valid native receipt captured after the database observation rolls back collection", testOptions, async (t) => {
  const f = await setup(t);
  const { h, p, runtime } = f;
  const cutoff = iso(Date.now() - 10_000);
  p.state.decisionClock = () => iso(Date.now() + 60_000);
  const transaction = h.db.transaction;
  const attempted = [];
  const failures = [];
  h.db.transaction = (work) => transaction(async (tx) => {
    let selected = false;
    try {
      return await work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (/INSERT\s+INTO\s+leaderboard_ingestion\.source_facts\b/.test(sql)) {
            selected = true;
            attempted.push({
              document: JSON.parse(params[5]),
              runId: params[6],
              returned: structuredClone(result.rows),
            });
          }
          return result;
        },
      });
    } catch (error) {
      if (selected) failures.push({ name: error.name, message: error.message });
      throw error;
    }
  });
  let result;
  try {
    result = await runtime.runOnce({ cutoff });
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(result.state, "collecting");
  assert.equal(result.progress.length, 1);
  assert.equal(result.progress[0].status, "failed");
  assert.equal(attempted.length, 1, "the actual source INSERT returned its database observation clock");
  assert.deepEqual(failures, [{ name: "Error", message: "pull_request_decision_persistence_binding_changed" }]);
  const inserted = attempted[0];
  assert.equal(inserted.returned.length, 1);
  assert.equal(String(inserted.returned[0].first_run_id), inserted.runId);
  assert.equal(inserted.runId, result.progress[0].runId);
  const observation = inserted.document.pullRequestDecisionHistory;
  assert.equal(observation.result.status, "captured");
  assert.equal(observation.generation.asOf, cutoff);
  const validated = components.github.validatePullRequestDecisionHistory(observation.result.receipt, {
    binding: observation.binding,
    generation: observation.generation,
  });
  assert.equal(validated.status, "validated", "the native receipt itself is complete and internally valid");
  assert.ok(components.contracts.compareSourceInstants(
    validated.receipt.capture.completedAt,
    inserted.returned[0].decision_observed_at,
  ) > 0, "the failure is C > actual database O, without rewriting an immutable source row");
  assert.equal(p.state.graphql, 3);
  assert.equal(p.state.normalized, 0);
  assert.deepEqual(await sourceRows(h), []);
  assert.deepEqual(await normalizations(h), []);
  for (const table of ["collection_items", "collection_pages"])
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_ingestion." + table)).rows, [], table);
  const runs = (await h.db.query(
    "SELECT state,reason,page_count,item_count,expected_count,last_success_at FROM leaderboard_ingestion.collection_runs",
  )).rows;
  assert.deepEqual(runs, [{
    state: "failed",
    reason: "source_commit_failed",
    page_count: 0,
    item_count: 0,
    expected_count: null,
    last_success_at: null,
  }]);
  await noPublication(h);
});

test("configuration withdrawal after a retained decision SQL result withholds the private input", testOptions, async (t) => {
  const f = await setup(t);
  const { h, p, runtime } = f;
  const run = await runtime.runOnce({ cutoff: iso(Date.now() - 10_000) });
  const publication = onlyPublication(run);
  const original = await captureFor(f, publication, run.progress);
  const beforeSources = await sourceRows(h);
  const beforeNormalizations = await normalizations(h);
  const beforeConfirmation = structuredClone(h.controlsStore.read().pipelinePublications[publication.snapshotId]);
  const calls = { graphql: p.state.graphql, lists: p.state.lists, details: p.state.details, normalized: p.state.normalized, probes: p.state.probes };
  p.state.forbidCollectedReads = true;
  p.state.forbidNormalization = true;
  const transaction = h.db.transaction;
  let entered = 0;
  let workEntered = 0;
  h.db.transaction = (work) => transaction((tx) => work({
    query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes("footprint.records AS decision_records")) {
        entered++;
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0].document.pullRequestDecisionHistory.result.status, "captured");
        assert.equal(result.rows[0].fact_key, beforeSources[0].fact_key);
        // The real bounded query has returned its selected observation; current
        // Controls authority changes before the helper's post-await fence.
        revokeConfiguration(h);
      }
      return result;
    },
  }));
  try {
    await assert.rejects(runtime.policyComparisons.withAuthorizedInputs(
      [original.record.authorization],
      (_removed, authority) => {
        workEntered++;
        return authority.restoreInput(original.record.input, original.record.authorization);
      },
    ), accessError);
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(entered, 1);
  assert.equal(workEntered, 0, "a verified receipt does not outlive current source authority");
  assert.deepEqual(await sourceRows(h), beforeSources);
  assert.deepEqual(await normalizations(h), beforeNormalizations);
  assert.deepEqual(await frozen(h, publication), original.saved);
  assert.deepEqual(runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId), original.record);
  assert.deepEqual(h.controlsStore.read().pipelinePublications[publication.snapshotId], beforeConfirmation);
  for (const suffix of ["", "&snapshot=" + publication.snapshotId]) {
    const response = await runtime.app.inject("/api/v1/boards?metric=" + metric + suffix);
    assert.equal(response.statusCode, 503, response.body);
    assert.doesNotMatch(response.body, /pullRequestDecisionEvidence|pipeline-pr-decision/);
  }
  assert.deepEqual(
    { graphql: p.state.graphql, lists: p.state.lists, details: p.state.details, normalized: p.state.normalized, probes: p.state.probes },
    calls,
    "private authority checks never recollect or normalize source history",
  );
});
test("configuration withdrawal during the actual native response prevents retaining a decision observation", testOptions, async (t) => {
  const f = await setup(t);
  const { h, p, runtime } = f;
  let entered = 0;
  p.state.beforeGraphqlResponse = (call) => {
    if (call.operation !== "PullRequestDecisionHistory") return;
    entered++;
    revokeConfiguration(h);
  };
  await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 10_000) }), accessError);
  assert.equal(entered, 1);
  assert.equal(p.state.graphql, 2);
  assert.equal(p.state.normalized, 0);
  assert.deepEqual(await sourceRows(h), []);
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_ingestion.collection_items")).rows, []);
  const runs = (await h.db.query("SELECT state FROM leaderboard_ingestion.collection_runs")).rows;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "failed");
  await noPublication(h);
});

test("withdrawal inside final Controls confirmation cannot expose the committed decision publication", testOptions, async (t) => {
  const f = await setup(t);
  const { h, p, runtime } = f;
  const sqlTransaction = h.db.transaction;
  const originalControlsTransaction = h.controlsStore.transaction;
  const controlsTransaction = originalControlsTransaction.bind(h.controlsStore);
  let sqlCommitted = 0;
  let controlsEntered = 0;
  h.db.transaction = async (work) => {
    let inserted = false;
    const value = await sqlTransaction((tx) => work({
      query: async (sql, params) => {
        const result = await tx.query(sql, params);
        if (/INSERT\s+INTO\s+leaderboard_pipeline\.snapshots\b/.test(sql)) inserted = true;
        return result;
      },
    }));
    if (inserted) sqlCommitted++;
    return value;
  };
  h.controlsStore.transaction = (work, options) => {
    if (sqlCommitted && controlsEntered === 0) {
      controlsEntered++;
      // Publish the source withdrawal using the real Controls transaction, just
      // before the already-entered publication calls its synchronous callback.
      const intercepted = h.controlsStore.transaction;
      h.controlsStore.transaction = controlsTransaction;
      try { revokeConfiguration(h); }
      finally { h.controlsStore.transaction = intercepted; }
    }
    return controlsTransaction(work, options);
  };
  try {
    await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 10_000) }), accessError);
  } finally {
    h.db.transaction = sqlTransaction;
    h.controlsStore.transaction = originalControlsTransaction;
  }
  assert.equal(sqlCommitted, 1);
  assert.equal(controlsEntered, 1);
  assert.equal(p.state.graphql, 3);
  assert.equal(p.state.normalized, 1);
  const snapshots = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.snapshots")).rows;
  assert.equal(snapshots.length, 1, "the causal boundary is after the real SQL commit");
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  const reads = { graphql: p.state.graphql, lists: p.state.lists, details: p.state.details, normalized: p.state.normalized };
  for (const suffix of ["", "&snapshot=" + snapshots[0].snapshot_id]) {
    const response = await runtime.app.inject("/api/v1/boards?metric=" + metric + suffix);
    assert.equal(response.statusCode, 503, response.body);
    assert.doesNotMatch(response.body, /pullRequestDecisionEvidence|pipeline-pr-decision/);
  }
  assert.deepEqual(
    { graphql: p.state.graphql, lists: p.state.lists, details: p.state.details, normalized: p.state.normalized },
    reads,
  );
});

for (const enabled of [true, false])
  test("content-identical replay retains " + (enabled ? "the original private generation" : "legacy absence") + " without upgrading immutable input", testOptions, async (t) => {
    const f = await setup(t, { enabled, inventory: "empty" });
    const { h, p } = f;
    let runtime = f.runtime;
    const cutoff = iso(Date.now() - 10_000);
    const first = await runtime.runOnce({ cutoff, mode: "reconcile" });
    const originalPublication = onlyPublication(first);
    const originalFrozen = await frozen(h, originalPublication);
    const originalRecord = runtime.policyComparisons.comparisons.input(originalPublication.comparisonInput.inputId);
    const originalExplanation = await runtime.aggregateExplanations.read(originalPublication.snapshotId);
    const originalConfirmation = structuredClone(h.controlsStore.read().pipelinePublications[originalPublication.snapshotId]);
    assert.equal(Object.hasOwn(originalFrozen.document.identityAuthorization, "pullRequestDecisionEvidence"), enabled);
    if (enabled) {
      const capture = originalFrozen.document.identityAuthorization.pullRequestDecisionEvidence;
      assert.equal(capture.runs.length, 1);
      assert.deepEqual(capture.runs[0].observations, []);
      assert.equal(capture.runs[0].runId, first.progress[0].runId);
    }
    if (!enabled) {
      await runtime.stop();
      runtime = await createPipeline({ ...h.options, pullRequestDecisionRepositoryIds: [2] });
    }
    try {
      const second = await runtime.runOnce({ cutoff, mode: "audit" });
      const repeated = onlyPublication(second);
      assert.notEqual(second.progress[0].runId, first.progress[0].runId);
      assert.equal(second.progress[0].status, "complete");
      assert.equal(repeated.snapshotId, originalPublication.snapshotId);
      assert.equal(repeated.revision, originalPublication.revision);
      assert.equal(repeated.changed, false);
      assert.equal(repeated.comparisonInput.inputId, originalPublication.comparisonInput.inputId);
      assert.deepEqual(await frozen(h, repeated), originalFrozen);
      assert.deepEqual(runtime.policyComparisons.comparisons.input(repeated.comparisonInput.inputId), originalRecord);
      assert.deepEqual(await runtime.aggregateExplanations.read(repeated.snapshotId), originalExplanation);
      assert.deepEqual(h.controlsStore.read().pipelinePublications[repeated.snapshotId], originalConfirmation);
      const runs = (await h.db.query("SELECT run_id,state,item_count FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.state === "complete" && run.item_count === 0));
      assert.deepEqual(await sourceRows(h), []);
      assert.equal(p.state.graphql, 0);
      assert.equal(p.state.normalized, 0);
      await runtime.policyComparisons.withAuthorizedInputs([originalRecord.authorization], (_removed, authority) => {
        assert.equal(authority.restoreInput(originalRecord.input, originalRecord.authorization).cutoff, originalRecord.input.cutoff);
      });
    } finally {
      if (!enabled) await runtime.stop();
    }
  });
