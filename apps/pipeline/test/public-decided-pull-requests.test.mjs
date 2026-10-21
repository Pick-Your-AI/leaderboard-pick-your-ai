// Fictional native HTTP responses; real client, default collector/normalizer,
// file checkpoints, PGlite, Controls, frozen restore and public service routes.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { components, clock, harness, publicScope } from "./harness.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { board, selection, validateExport } from "../../web/src/remote/client.ts";

const metric = "pr_accepted_rate";
const source = "synthetic-decided-installation:1";
const slug = "synthetic-owner/decided-repository";
const options = { timeout: 120_000 };
const iso = (value) => new Date(value).toISOString();

async function setup(t, { memoryDatabase = true, enabled = true, empty = false, incomplete = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-decided-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = Math.floor(Date.now() / 1000) * 1000 - 8 * 86400_000;
  const at = (day) => iso(base + day * 86400_000);
  const windows = {
    early: { ...publicScope, start: at(3.5), end: at(4) },
    late: { ...publicScope, start: at(4.5), end: at(6) },
  };
  const repository = { id: 2, full_name: slug, private: false, default_branch: "main" };
  const nativeRepository = { databaseId: 2, nameWithOwner: slug, isPrivate: false };
  const state = {
    forbidCollection: false,
    forbidNormalization: false,
    unavailable: new Set(),
    normalized: 0,
    lists: 0,
    details: 0,
    graphql: 0,
    probes: 0,
  };
  const pulls = new Map();
  const events = new Map();
  const add = (number, transitions = [], createdAt = at(0), author = true) => {
    const last = transitions.at(-1);
    const merged = last?.kind === "merged";
    const closed = merged || last?.kind === "closed";
    const pull = {
      id: 1000 + number,
      node_id: "PR_SYNTHETIC_DECIDED_" + number,
      number,
      html_url: "https://github.com/" + slug + "/pull/" + number,
      title: "Synthetic decision " + number,
      created_at: createdAt,
      updated_at: at(7),
      state: closed ? "closed" : "open",
      merged,
      merged_at: merged ? last.at : null,
      closed_at: closed ? last.at : null,
      draft: false,
      base: { ref: "main", repo: repository },
      user: author
        ? { id: 101, node_id: "U_SYNTHETIC_DECIDED_AUTHOR", login: "synthetic-decided-author", type: "User" }
        : null,
    };
    const parent = {
      __typename: "PullRequest",
      id: pull.node_id,
      databaseId: pull.id,
      number,
      url: pull.html_url,
      repository: nativeRepository,
    };
    pulls.set(number, pull);
    events.set(
      number,
      transitions.map((event, index) => ({
        __typename: { closed: "ClosedEvent", reopened: "ReopenedEvent", merged: "MergedEvent" }[event.kind],
        id: "E_SYNTHETIC_DECIDED_" + number + "_" + index,
        createdAt: event.at,
        ...(event.kind === "merged" ? { pullRequest: parent, commit: { oid: "a".repeat(40) } } : { closable: parent }),
      })),
    );
  };
  if (!empty) {
    add(1, [{ kind: "merged", at: at(5) }]);
    add(2, [
      { kind: "closed", at: at(2) },
      { kind: "reopened", at: at(3) },
      { kind: "closed", at: at(5.5) },
    ]);
    add(3);
  }
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-decided-token",
    checkpoints: new components.github.FileCheckpointStore(directory),
    maxRetries: 0,
    fetch: async (value, request) => {
      const url = new URL(value);
      assert.equal(url.origin, "https://api.synthetic.invalid");
      const headers = { "content-type": "application/json" };
      let body;
      if ((request?.method ?? "GET") === "POST") {
        assert.equal(state.forbidCollection, false, "frozen reads cannot recollect native history");
        state.graphql++;
        const { query, variables } = JSON.parse(request.body);
        const operation = query.match(/query\s+([A-Za-z0-9_]+)/)?.[1];
        assert.ok(["PullRequestDecisionAnchor", "PullRequestDecisionHistory"].includes(operation));
        assert.equal(variables.owner, "synthetic-owner");
        assert.equal(variables.name, "decided-repository");
        const pull = pulls.get(variables.number);
        assert.ok(pull);
        const history = events.get(variables.number);
        const connection = { totalCount: history.length, updatedAt: pull.updated_at };
        if (operation === "PullRequestDecisionHistory")
          Object.assign(connection, {
            filteredCount: history.length,
            pageCount: history.length,
            pageInfo: {
              hasNextPage: state.unavailable.has(pull.number),
              endCursor: history.length ? "SYNTHETIC_" + (history.length - 1) : null,
            },
            edges: history.map((node, index) => ({ cursor: "SYNTHETIC_" + index, node: structuredClone(node) })),
          });
        body = {
          data: {
            repository: {
              ...nativeRepository,
              pullRequest: {
                id: pull.node_id,
                databaseId: pull.id,
                number: pull.number,
                url: pull.html_url,
                createdAt: pull.created_at,
                updatedAt: pull.updated_at,
                state: pull.merged ? "MERGED" : pull.state === "closed" ? "CLOSED" : "OPEN",
                closedAt: pull.closed_at,
                mergedAt: pull.merged_at,
                author: pull.user ? { __typename: "User", id: pull.user.node_id, databaseId: pull.user.id } : null,
                timelineItems: connection,
              },
            },
          },
        };
      } else if (url.pathname === "/repos/" + slug) {
        state.probes++;
        body = repository;
      } else if (url.pathname === "/repos/" + slug + "/pulls") {
        assert.equal(state.forbidCollection, false, "frozen reads cannot recollect the inventory");
        state.lists++;
        if (incomplete && url.searchParams.get("page") === "2")
          return new Response(JSON.stringify({ message: "synthetic inventory unavailable" }), { status: 503, headers });
        body = [...pulls.values()].map((pull) => structuredClone(pull));
        if (incomplete) headers.link = "<https://api.synthetic.invalid/repos/" + slug + '/pulls?page=2>; rel="next"';
      } else {
        assert.equal(state.forbidCollection, false, "frozen reads cannot rehydrate source records");
        const number = Number(url.pathname.match(/\/pulls\/(\d+)$/)?.[1]);
        assert.ok(pulls.has(number), "only exact synthetic PR detail routes are available");
        state.details++;
        body = structuredClone(pulls.get(number));
      }
      return new Response(JSON.stringify(body), { status: 200, headers });
    },
  });
  const selectedComponents = {
    ...components,
    github: {
      ...components.github,
      createGithubEvidenceNormalizer(value) {
        const normalize = components.github.createGithubEvidenceNormalizer(value);
        return async (input) => {
          assert.equal(state.forbidNormalization, false, "frozen reads use retained ordinary normalizations");
          state.normalized++;
          return normalize(input);
        };
      },
    },
  };
  const h = await harness(t, {
    memoryDatabase,
    components: selectedComponents,
    githubClient: client,
    sourceId: source,
    source: undefined,
    probeRepository: undefined,
    ...(enabled ? { pullRequestDecisionRepositoryIds: [2] } : {}),
    decisionHistoryNow: clock,
    configure(config) {
      config.repositories[0].slug = slug;
      config.repositories[0].families = ["pull_requests"];
      const policy = {
        metricId: metric,
        version: "synthetic-native-decided-v1",
        definitionVersion: components.metrics.metricRegistryV1.policy_version,
        unit: components.metrics.getMetricDefinition(metric).definition.unit,
        aggregation: "ratio",
        dateBasis: "acceptedAt",
        rankedStates: ["observed"],
        roles: ["author"],
        groupBy: "actor_artifact",
        sources: ["github_rest"],
        minimumSamples: 2,
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-decided-policy" },
      ];
      config.scopes = Object.values(windows);
    },
  });
  assert.equal(h.options.source, undefined);
  assert.equal(h.options.probeRepository, undefined);
  assert.equal(h.options.normalizer, undefined);
  assert.equal(h.options.githubEnrich, undefined);
  return { h, state, pulls, events, add, at, windows, cutoff: iso(Date.now() - 10_000) };
}

function query(scope, extra = {}) {
  return new URLSearchParams({ metric, start: scope.start, end: scope.end, ...extra }).toString();
}
async function publicBoard(h, scope, pin = null) {
  const qs = query(scope, pin === null ? {} : { snapshot: pin });
  const response = await h.runtime.app.inject("/api/v1/boards?" + qs);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const parsed = board(body, selection("?" + qs));
  assert.deepEqual(parsed.rows, body.rows);
  return body;
}
const row = (body) => body.rows.find((value) => value.actorId === "101");
const diagnostic = (body) => body.diagnostics.find((value) => value.actorId === "101");
const reads = (state) => ({
  lists: state.lists,
  details: state.details,
  graphql: state.graphql,
  normalized: state.normalized,
});
async function frozen(h, pin) {
  const saved = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      pin,
    ])
  ).rows[0];
  assert.ok(saved);
  assert.equal(comparisonHash(saved.document), saved.document_hash);
  return saved;
}
async function publicExports(h, scope, body) {
  const qs = query(scope, { snapshot: body.snapshotId });
  const json = await h.runtime.app.inject("/api/v1/exports?" + qs + "&format=json");
  assert.equal(json.statusCode, 200, json.body);
  const exported = json.json();
  validateExport(exported, selection("?" + qs), body.metric);
  assert.deepEqual(row(exported).pending, row(body).pending);
  assert.equal(row(exported).rank, null);
  const csv = await h.runtime.app.inject("/api/v1/exports?" + qs + "&format=csv");
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(csv.body, /"pending","pending_evidence"/);
  assert.doesNotMatch(
    json.body + csv.body,
    /pullRequestDecision|decisionAsOf|captureHash|factHashes|history_incomplete|E_SYNTHETIC_DECIDED/,
  );
  return exported;
}
function revokeConfiguration(h) {
  h.controlsStore.transaction(
    (state) => {
      state.configuration = {
        revision: 1,
        proposals: {},
        history: [],
        active: {
          version: "synthetic-decided-source-withdrawn",
          digest: "a".repeat(64),
          approval: { id: "synthetic-decided-withdrawal" },
          document: { repositories: [], projects: [], metrics: [] },
        },
      };
    },
    { publish: true },
  );
}

test("one native collection yields exact earlier pending and later decided public windows", options, async (t) => {
  const f = await setup(t);
  const { h, state, windows } = f;
  const run = await h.runtime.runOnce({ cutoff: f.cutoff });
  assert.equal(run.state, "published");
  assert.equal(run.publications.length, 2);
  assert.ok(state.graphql > 0);
  assert.ok(state.normalized >= 3);
  const early = await publicBoard(h, windows.early);
  const late = await publicBoard(h, windows.late);
  assert.equal(row(early).result.state, "unknown");
  assert.equal(row(early).pending.count, 3);
  assert.equal(row(early).pending.state, "partial");
  assert.equal(diagnostic(early).denominator, 0);
  assert.equal(row(late).result.value, 0.5);
  assert.equal(diagnostic(late).numerator, 1);
  assert.equal(diagnostic(late).denominator, 2);
  assert.equal(row(late).pending.count, 1);
  assert.equal(row(late).pending.state, "partial");
  assert.equal(row(late).rank, null);
  assert.equal(new Set(row(late).evidenceIds).size, 2);
  const exposed = await publicExports(h, windows.late, late);
  assert.equal(exposed.pendingEvidence.length, 1);
  assert.equal(exposed.pendingEvidence[0].sourceUrl, "https://github.com/" + slug + "/pull/3");
  assert.ok(exposed.pendingEvidence[0].occurredAt < windows.late.start);
  for (const evidence of exposed.pendingEvidence) {
    const detail = await h.runtime.app.inject(
      "/api/v1/evidence/" + evidence.evidenceId + "?" + query(windows.late, { snapshot: late.snapshotId }),
    );
    assert.equal(detail.statusCode, 200, detail.body);
    const entry = detail.json();
    assert.equal(entry.activityState, "pending");
    assert.equal(entry.artifact.stableId, "PR_SYNTHETIC_DECIDED_3");
    assert.equal(entry.artifact.publicUrl, evidence.sourceUrl);
    assert.equal(entry.contribution.contributionId, evidence.evidenceId);
  }
  const a = await frozen(h, early.snapshotId);
  const b = await frozen(h, late.snapshotId);
  const retainedClocks = b.document.identityAuthorization.pullRequestDecisionEvidence.runs.flatMap((run) =>
    run.observations.map((observation) => observation.observedAt),
  );
  const nativeFacts = b.document.frozen.facts.filter((fact) => fact.metricId === metric);
  assert.ok(nativeFacts.length > 0);
  for (const fact of nativeFacts) {
    assert.match(fact.observedAt, /\.\d{6}Z$/);
    assert.ok(retainedClocks.includes(fact.observedAt), "frozen metrics preserve exact SQL observation clocks");
  }
  assert.deepEqual(
    a.document.identityAuthorization.pullRequestDecisionEvidence,
    b.document.identityAuthorization.pullRequestDecisionEvidence,
  );
  assert.equal(a.document.identityAuthorization.pullRequestDecisionEvidence.asOf, f.cutoff);
  assert.equal(a.document.identityAuthorization.pullRequestDecisionProjection.asOf, windows.early.end);
  assert.equal(b.document.identityAuthorization.pullRequestDecisionProjection.asOf, windows.late.end);
  assert.equal(a.document.frozen.facts.filter((fact) => fact.metricId === metric).length, 3);
  assert.equal(b.document.frozen.facts.filter((fact) => fact.metricId === metric).length, 3);
  const stored = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows;
  assert.ok(stored.some((value) => value.document.facts.some((fact) => fact.metricId === "pr_opened")));
  assert.ok(stored.every((value) => !JSON.stringify(value).includes("decisionAsOf")));
});

test("native creation and decision boundaries conserve one unit and exclude unknown histories", options, async (t) => {
  const f = await setup(t);
  f.add(4, [], f.windows.early.end);
  f.add(5);
  f.state.unavailable.add(5);
  f.add(6, [], f.at(0), false);
  const run = await f.h.runtime.runOnce({ cutoff: f.cutoff });
  assert.equal(run.state, "published");
  const early = await publicBoard(f.h, f.windows.early);
  const late = await publicBoard(f.h, f.windows.late);
  assert.equal(row(early).pending.count, 3, "creation at the exclusive end is not a pending unit");
  assert.equal(row(late).pending.count, 2, "a known later creation joins the later backlog");
  assert.equal(diagnostic(late).denominator, 2, "old close/reopen transitions do not multiply the final decision");
  assert.equal(row(late).result.value, 0.5);
  assert.deepEqual(row(late).result.coverage.sourceErrors, ["source_collection_failed"]);
  const saved = await frozen(f.h, late.snapshotId);
  assert.ok(
    saved.document.frozen.coverage.some(
      (coverage) =>
        coverage.source === "github_rest" &&
        coverage.scopeId === "2" &&
        coverage.windowEnd === f.windows.late.end &&
        coverage.sourceErrors.includes("decision_history_unavailable"),
    ),
  );
  const exported = await publicExports(f.h, f.windows.late, late);
  const sourceUrls = [...exported.evidence, ...exported.pendingEvidence].map((value) => value.sourceUrl);
  assert.ok(!sourceUrls.includes("https://github.com/" + slug + "/pull/5"));
  assert.ok(!sourceUrls.includes("https://github.com/" + slug + "/pull/6"));
  const stored = (await f.h.db.query("SELECT document FROM leaderboard_ingestion.source_facts")).rows;
  const unavailable = stored.find((value) => value.document.subjectId === "PR_SYNTHETIC_DECIDED_5");
  assert.equal(unavailable.document.pullRequestDecisionHistory.result.status, "unavailable");
});

test("empty or disabled native history never invents a ratio or measured pending zero", options, async (t) => {
  for (const controls of [{ empty: true }, { enabled: false }]) {
    const f = await setup(t, controls);
    assert.equal((await f.h.runtime.runOnce({ cutoff: f.cutoff })).state, "published");
    const body = await publicBoard(f.h, f.windows.late);
    assert.equal(body.rows.length, 0);
    const publicRead = await f.h.runtime.source.read(f.windows.late, body.snapshotId, new AbortController().signal);
    assert.deepEqual(publicRead.selected.evidence, []);
    assert.deepEqual(publicRead.selected.pendingEvidence, []);
    const saved = await frozen(f.h, body.snapshotId);
    if (controls.enabled === false) {
      assert.equal(saved.document.identityAuthorization.pullRequestDecisionEvidence, undefined);
      assert.equal(saved.document.identityAuthorization.pullRequestDecisionProjection, undefined);
      assert.equal(f.state.graphql, 0);
    } else {
      assert.deepEqual(saved.document.identityAuthorization.pullRequestDecisionProjection.factHashes, []);
    }
  }
});

test("an incomplete native outer inventory cannot publish a misleading complete empty cohort", options, async (t) => {
  const f = await setup(t, { incomplete: true });
  const result = await f.h.runtime.runOnce({ cutoff: f.cutoff });
  assert.equal(result.state, "collecting");
  assert.equal((await f.h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
  assert.equal(await f.h.runtime.source.read(f.windows.late, null, new AbortController().signal), null);
});

test("native A and B survive reopen with current privacy", options, async (t) => {
  const f = await setup(t, { memoryDatabase: false });
  const { h, state, windows } = f;
  const first = await h.runtime.runOnce({ cutoff: f.cutoff });
  const a = await publicBoard(h, windows.late);
  const savedA = await frozen(h, a.snapshotId);
  const sourcesA = (
    await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
  ).rows;
  // A later synthetic native revision reports an earlier transition. It cannot
  // overwrite the source state actually captured for A or its publication.
  f.add(3, [{ kind: "merged", at: f.at(5.75) }]);
  f.pulls.get(3).updated_at = f.at(7.1);
  const second = await h.runtime.runOnce({ cutoff: iso(Date.parse(f.cutoff) + 1000) });
  assert.equal(second.state, "published");
  const b = await publicBoard(h, windows.late);
  assert.notEqual(b.snapshotId, a.snapshotId);
  assert.equal(diagnostic(b).numerator, 2);
  assert.equal(diagnostic(b).denominator, 3);
  assert.equal(row(b).pending.state, "unknown");
  assert.equal(row(b).pending.count, null);
  assert.deepEqual(await frozen(h, a.snapshotId), savedA);
  const sourcesB = (
    await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key")
  ).rows;
  for (const original of sourcesA)
    assert.deepEqual(
      sourcesB.find((value) => value.fact_key === original.fact_key),
      original,
    );
  const beforeReads = reads(state);
  const retainedNormalizations = (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
  state.forbidCollection = true;
  state.forbidNormalization = true;
  await h.reopenDatabase();
  const pinned = await publicBoard(h, windows.late, a.snapshotId);
  assert.deepEqual(await frozen(h, a.snapshotId), savedA);
  assert.equal(row(pinned).result.value, 0.5);
  assert.equal(row(pinned).pending.count, 1);
  await publicExports(h, windows.late, pinned);
  assert.equal(diagnostic(await publicBoard(h, windows.late)).denominator, 3);
  const publication = first.publications.find((value) => value.snapshotId === a.snapshotId);
  assert.ok(publication);
  const record = h.runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
  let restored = 0;
  await h.runtime.policyComparisons.withAuthorizedInputs([record.authorization], (_removed, authority) => {
    assert.deepEqual(authority.restoreInput(record.input, record.authorization).facts, record.input.facts);
    const changed = structuredClone(record.input);
    const fact = changed.facts.find((value) => value.metricId === metric && value.outcome === "merged");
    fact.outcome = "closed_unmerged";
    assert.throws(
      () => authority.restoreInput(changed, record.authorization),
      /decision_history_projection_binding_changed/,
    );
    restored++;
  });
  assert.equal(restored, 1);
  for (const changeBinding of [
    (authorization) => {
      authorization.pullRequestDecisionProjection.asOf = windows.early.end;
    },
    (authorization) => {
      delete authorization.pullRequestDecisionProjection;
    },
  ]) {
    const changed = structuredClone(record.authorization);
    changeBinding(changed);
    await assert.rejects(
      h.runtime.policyComparisons.withAuthorizedInputs([changed], (_removed, authority) =>
        authority.restoreInput(record.input, changed),
      ),
      /decision_history_projection_binding_changed/,
    );
  }
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
      )
    ).rows,
    retainedNormalizations,
  );
  assert.deepEqual(reads(state), beforeReads);
  h.controlsStore.transaction(
    (value) => {
      value.profiles["101"] = { suppressed: true };
    },
    { publish: true },
  );
  assert.equal((await publicBoard(h, windows.late, a.snapshotId)).rows.length, 0);
  const hidden = await h.runtime.app.inject(
    "/api/v1/exports?" + query(windows.late, { snapshot: a.snapshotId, format: "json" }),
  );
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.deepEqual(hidden.json().pendingEvidence, []);
  assert.doesNotMatch(hidden.body, /synthetic-decided-author/);
  assert.deepEqual(await frozen(h, a.snapshotId), savedA);
  revokeConfiguration(h);
  await assert.rejects(
    h.runtime.source.read(windows.late, a.snapshotId, new AbortController().signal),
    /revoked_source|authorization_changed|source_unavailable/,
  );
  const denied = await h.runtime.app.inject("/api/v1/boards?" + query(windows.late, { snapshot: a.snapshotId }));
  assert.equal(denied.statusCode, 503, denied.body);
  assert.equal(denied.json().error, "public_projection_unavailable");
  assert.deepEqual(reads(state), beforeReads);
});
