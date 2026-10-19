// Fictional native responses and a disposable database exercise the stock host
// composition. These cases claim no GitHub release, deployment or human review.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ScanContinuationStore } from "../src/scan-continuation.mjs";
import { configurationOverlay } from "../../controls/src/overlay.mjs";
import { components, harness, publicScope } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { releaseReviewRequest } from "../../controls/src/release-review.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";

const slug = "example-org/example-repo";
const prefix = `/repos/${slug}`;
const api = "https://api.fixture.invalid";
const mergeSha = "b".repeat(40),
  tagSha = "c".repeat(40);
const iso = (value) => new Date(value).toISOString();
const elapsed = (value, milliseconds) => iso(Date.parse(value) + milliseconds);

function transport() {
  const mergedAt = iso(Date.now() - 86_400_000);
  const repository = {
    id: 2,
    node_id: "R_clock_fixture",
    full_name: slug,
    private: false,
    visibility: "public",
    default_branch: "main",
    url: `${api}${prefix}`,
  };
  const pull = {
    id: 10,
    node_id: "PR_clock_fixture",
    number: 10,
    url: `${api}${prefix}/pulls/10`,
    html_url: `https://github.com/${slug}/pull/10`,
    created_at: elapsed(mergedAt, -60_000),
    updated_at: mergedAt,
    state: "closed",
    merged: true,
    draft: false,
    merged_at: mergedAt,
    merge_commit_sha: mergeSha,
    base: { ref: "main", repo: repository },
    user: { id: 101, node_id: "U_clock_fixture", login: "fixture-author", type: "User" },
  };
  const state = { logicalTime: null, publishedAt: null, calls: [], events: [] };
  const now = () => {
    const at = state.logicalTime ?? new Date().toISOString();
    state.events.push({ kind: "clock", at });
    return at;
  };
  const client = new components.github.GithubReadClient({
    apiOrigin: api,
    token: async () => "fixture-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value, options) => {
      assert.equal(options?.method ?? "GET", "GET");
      const url = new URL(value),
        path = url.pathname + url.search;
      if (state.logicalTime) state.logicalTime = elapsed(state.logicalTime, 10);
      state.calls.push(path);
      state.events.push({ kind: "http", path, at: state.logicalTime ?? new Date().toISOString() });
      let body;
      if (path === prefix) body = repository;
      else if (path === `${prefix}/pulls/10`) body = pull;
      else if (path === `${prefix}/releases/700`) {
        assert.ok(state.publishedAt, "a release lookup cannot precede this fixture's publication");
        body = {
          id: 700,
          node_id: "RE_clock_fixture",
          url: `${api}${prefix}/releases/700`,
          immutable: true,
          draft: false,
          prerelease: false,
          published_at: state.publishedAt,
          tag_name: "v-clock",
        };
      } else if (path === `${prefix}/git/ref/tags/v-clock`)
        body = {
          ref: "refs/tags/v-clock",
          node_id: "REF_clock_fixture",
          url: `${api}${prefix}/git/refs/tags/v-clock`,
          object: { type: "commit", sha: tagSha, url: `${api}${prefix}/git/commits/${tagSha}` },
        };
      else if (path === `${prefix}/compare/${mergeSha}...${tagSha}?per_page=1&page=1`)
        body = {
          url: `${api}${prefix}/compare/${mergeSha}...${tagSha}`,
          base_commit: { sha: mergeSha },
          merge_base_commit: { sha: mergeSha },
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
        };
      else assert.fail(`unexpected normalization transport path: ${path}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const expectedRecord = (observedAt) => ({
    schemaVersion: "github-release-inclusion/v1",
    source: "github_rest",
    observedAt,
    request: { repositoryId: 2, repositorySlug: slug, releaseId: 700, pullRequestNumber: 10 },
    repository: { id: 2, nodeId: repository.node_id, slug, visibility: "public" },
    release: {
      id: 700,
      nodeId: "RE_clock_fixture",
      tagName: "v-clock",
      publishedAt: state.publishedAt,
      immutable: true,
      draft: false,
      currentPrerelease: false,
    },
    pullRequest: {
      id: 10,
      nodeId: pull.node_id,
      number: 10,
      repositoryId: 2,
      repositoryNodeId: repository.node_id,
      repositorySlug: slug,
      mergedAt,
      mergeCommitSha: mergeSha,
      author: { id: pull.user.id, nodeId: pull.user.node_id, type: "User" },
    },
    tag: {
      ref: "refs/tags/v-clock",
      nodeId: "REF_clock_fixture",
      object: { type: "commit", sha: tagSha },
      annotatedTags: [],
      commitSha: tagSha,
    },
    comparison: {
      requestedBaseSha: mergeSha,
      requestedHeadSha: tagSha,
      baseCommitSha: mergeSha,
      mergeBaseCommitSha: mergeSha,
      status: "ahead",
      aheadBy: 2,
      behindBy: 0,
    },
  });
  return { client, now, state, pull, expectedRecord };
}

function metricPolicy(metricId) {
  return {
    metricId,
    version: `${metricId}-clock-v1`,
    definitionVersion: components.metrics.metricRegistryV1.policy_version,
    unit: components.metrics.getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: metricId === "release_changes" ? ["qualified"] : ["observed"],
    roles: ["author"],
    groupBy: metricId === "release_changes" ? "canonical" : "actor_artifact",
    ...(metricId === "release_changes" ? { groupingPolicyVersion: "release-inclusion-units/v1" } : {}),
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: metricId !== "release_changes",
  };
}
const signed = (policy) => ({
  policy,
  signature: components.metrics.stableJSON(policy),
  approvalReceipt: "fixture-policy-approval",
});
const sourceRows = (db) =>
  db
    .query(
      "SELECT fact_key,source_revision,observed_at,document,first_run_id FROM leaderboard_ingestion.source_facts WHERE repository_id=2 AND family='pull_requests' ORDER BY fact_key",
    )
    .then((value) => value.rows.map((row) => ({ ...row, observed_at: iso(row.observed_at) })));

async function persistedBeforeRelease(t) {
  const provider = transport();
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [provider.pull],
    githubClient: provider.client,
    now: provider.now,
    // The protected host probe is separate from the actual stock normalizer's
    // REST reads counted below. Collection uses the existing harness source.
    probeRepository: async () => ({
      repositoryId: 2,
      installationId: 1,
      visibility: "public",
      checkedAt: provider.now(),
    }),
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.policies = [signed(metricPolicy("pr_merged")), signed(metricPolicy("release_changes"))];
    },
  });
  assert.equal(h.options.normalizer, undefined, "the stock normalizer must be constructed by the runtime");
  assert.equal(h.options.githubEnrich, undefined, "the fixture supplies no prequalified enrichment");
  const first = await h.runtime.runOnce({ cutoff: iso(Date.now() - 1_000) });
  assert.equal(first.state, "published");
  const originals = await sourceRows(h.db);
  assert.equal(originals.length, 1);
  const original = originals[0];
  assert.equal(original.source_revision, provider.pull.updated_at);
  const prior = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1", [
      original.fact_key,
    ])
  ).rows;
  assert.equal(prior.length, 1);
  const target = prior[0].document.facts.find((fact) => fact.metricId === "pr_merged");
  assert.ok(target);
  assert.equal(target.observedAt, original.observed_at);
  assert.equal(prior[0].document.releaseInclusions, undefined);
  assert.equal(
    provider.state.calls.some((path) => path.includes("/releases/")),
    false,
  );
  await h.runtime.stop();

  provider.state.publishedAt = elapsed(original.observed_at, 60_000);
  provider.state.logicalTime = elapsed(original.observed_at, 120_000);
  const policy = metricPolicy("release_changes");
  // This literal reviewed target is only an expected private audit pin. No
  // record is supplied to the normalizer, whose transport must collect it.
  const review = {
    targetFactId: target.id,
    releaseId: 700,
    pullRequestNumber: 10,
    proofHash: components.github.githubReleaseInclusionHash(provider.expectedRecord(provider.state.logicalTime)),
    policyVersion: policy.version,
  };
  const decision = {
    id: "private-clock-decision",
    receipt: "private-clock-request",
    action: "accepted",
    actor: "303",
    at: Date.parse(elapsed(provider.state.publishedAt, 30_000)),
    version: 2,
    policyVersion: policy.version,
    releaseInclusion: structuredClone(review),
  };
  const request = {
    id: decision.receipt,
    kind: "evidence",
    status: "accepted",
    version: 2,
    owner: target.actorId,
    category: "release_changes",
    scope: "repository:2:release:700:pull:10",
    locator: provider.pull.html_url,
    policyVersion: policy.version,
    collaborators: {},
    history: [decision],
  };
  attachSyntheticEvidenceIntake(request);
  decision.evidenceRequest = releaseReviewRequest(request);
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: policy.version,
    metricId: "release_changes",
    sourceMetricId: "pr_merged",
    repositoryId: "2",
    reviewerIds: ["303"],
    releaseInclusion: structuredClone(review),
  };
  h.controlsStore.transaction((state) => {
    state.requests = { [request.id]: request };
    state.audit = [structuredClone(decision)];
  });
  const config = structuredClone(h.config);
  assert.deepEqual(config.policies.find((entry) => entry.policy.metricId === "release_changes").policy, policy);
  config.releaseInclusionTargets = [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }];
  config.recognitionBindings = [binding];
  const faults = { afterFreeze: false };
  const recordQuery = async (query, sql, parameters) => {
    if (sql.includes("SET context_hash=$2,cycle_token=$3")) {
      provider.state.events.push({
        kind: "scan-context",
        token: parameters[2],
        contextHash: parameters[1],
        at: parameters[3],
      });
    }
    if (
      faults.afterFreeze &&
      provider.state.events.some((event) => event.kind === "freeze") &&
      sql.startsWith("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access")
    ) {
      faults.afterFreeze = false;
      throw new Error("fixture_stop_after_freeze");
    }
    if (sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff")) {
      provider.state.events.push({ kind: "freeze", at: parameters[1] });
    }
    return query(sql, parameters);
  };
  const database = {
    query: (sql, parameters) => recordQuery(h.db.query.bind(h.db), sql, parameters),
    transaction: (work) =>
      h.db.transaction((tx) => work({ query: (sql, parameters) => recordQuery(tx.query.bind(tx), sql, parameters) })),
  };
  const options = { ...h.options, config, db: database };
  const runtime = await createPipeline(options);
  t.after(() => runtime.stop());
  return { h, provider, original, prior: prior[0], target, runtime, options, policy, faults };
}

async function releaseCache(s) {
  const rows = (
    await s.h.db.query(
      "SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1",
      [s.original.fact_key],
    )
  ).rows;
  const withProof = rows.filter((row) => row.document.releaseInclusions?.length);
  assert.equal(withProof.length, 1);
  return withProof[0];
}

async function assertReleasePublication(s, publication) {
  assert.equal(publication.state, "published");
  assert.equal(publication.publications.length, 1);
  const read = await s.runtime.source.read(
    publicScope,
    publication.publications[0].snapshotId,
    new AbortController().signal,
  );
  assert.ok(read);
  assert.equal(read.selected.rows.find((row) => row.result.metricId === "release_changes")?.result.value, 1);
  assert.equal(read.selected.rows.find((row) => row.result.metricId === "pr_merged")?.result.value, 1);
  const evidence = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("release_changes"));
  assert.equal(evidence?.occurredAt, s.provider.state.publishedAt);
  assert.doesNotMatch(JSON.stringify(read.selected), /releaseInclusions|proofHash|private-clock|annotatedTags/);
}

test("release collection clock: an unchanged previously stored PR can be included later before freeze and replay without proof HTTP", async (t) => {
  const s = await persistedBeforeRelease(t);
  const publication = await s.runtime.runOnce();
  await assertReleasePublication(s, publication);
  assert.deepEqual(
    await sourceRows(s.h.db),
    [s.original],
    "collection must retain the original PR observation and first run",
  );
  const cached = await releaseCache(s);
  const proof = cached.document.releaseInclusions[0];
  assert.ok(Date.parse(proof.observedAt) > Date.parse(s.original.observed_at));
  assert.equal(cached.document.facts.find((fact) => fact.metricId === "pr_merged").observedAt, s.original.observed_at);
  const lastHttp = s.provider.state.events.findLastIndex((event) => event.kind === "http");
  const freeze = s.provider.state.events.findLastIndex((event) => event.kind === "freeze");
  assert.ok(freeze > lastHttp, "all proof HTTP must finish before the observation cutoff is frozen");
  assert.ok(Date.parse(proof.observedAt) >= Date.parse(s.provider.state.events[lastHttp].at));
  assert.ok(Date.parse(proof.observedAt) <= Date.parse(s.provider.state.events[freeze].at));
  const frozen = (
    await s.h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.publications[0].snapshotId,
    ])
  ).rows[0].document;
  assert.equal(frozen.frozen.cutoff, s.provider.state.events[freeze].at);
  const calls = [...s.provider.state.calls];
  s.provider.state.logicalTime = elapsed(s.provider.state.logicalTime, 60_000);
  const replay = await s.runtime.runOnce({ cutoff: frozen.frozen.cutoff });
  await assertReleasePublication(s, replay);
  assert.deepEqual(
    s.provider.state.calls,
    calls,
    "compatible normalization/proof cache must avoid new transport calls",
  );
  assert.deepEqual(await releaseCache(s), cached, "replay must not advance or rewrite cached proof observation");
  assert.deepEqual(await sourceRows(s.h.db), [s.original]);
});

const digest = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const scans = async (s) =>
  (
    await s.h.db.query(
      "SELECT configuration_key,context_hash,cycle_token,event_cutoff,observation_cutoff,scope_heads FROM leaderboard_pipeline.scan_continuations ORDER BY configuration_key",
    )
  ).rows.map((row) => ({
    ...row,
    event_cutoff: iso(row.event_cutoff),
    observation_cutoff: row.observation_cutoff === null ? null : iso(row.observation_cutoff),
  }));

async function stopWithFrozenProof(t) {
  const s = await persistedBeforeRelease(t);
  s.faults.afterFreeze = true;
  // The injected failure is after the real freeze transaction commits and
  // before publication reads its source gate. It cannot roll back that freeze.
  await assert.rejects(s.runtime.runOnce(), /fixture_stop_after_freeze/);
  const pending = await scans(s);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].observation_cutoff);
  const cache = await releaseCache(s);
  assert.equal(digest(cache.document), cache.document_hash);
  assert.ok(Date.parse(cache.document.releaseInclusions[0].observedAt) <= Date.parse(pending[0].observation_cutoff));
  assert.equal(
    Number((await s.h.db.query("SELECT count(*) AS count FROM leaderboard_pipeline.snapshots")).rows[0].count),
    1,
  );
  return { ...s, pending: pending[0], cache };
}

test("release collection clock: a compatible frozen proof replays the original cutoff without recollection", async (t) => {
  const s = await stopWithFrozenProof(t);
  const calls = [...s.provider.state.calls];
  s.provider.state.logicalTime = elapsed(s.provider.state.logicalTime, 60_000);
  const publication = await s.runtime.runOnce();
  await assertReleasePublication(s, publication);
  assert.deepEqual(s.provider.state.calls, calls);
  assert.deepEqual(await releaseCache(s), s.cache);
  const frozen = (
    await s.h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.publications[0].snapshotId,
    ])
  ).rows[0].document;
  assert.equal(frozen.frozen.cutoff, s.pending.observation_cutoff);
  assert.deepEqual(await sourceRows(s.h.db), [s.original]);
  assert.deepEqual(await scans(s), []);
});

for (const unavailable of ["missing", "after cutoff"]) {
  test(`release collection clock: an already frozen scan rejects ${unavailable} proof cache without new HTTP or a moved cutoff`, async (t) => {
    const s = await stopWithFrozenProof(t);
    if (unavailable === "missing") {
      await s.h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2", [
        s.original.fact_key,
        s.cache.policy_signature,
      ]);
    } else {
      const document = structuredClone(s.cache.document);
      document.releaseInclusions[0].observedAt = elapsed(s.pending.observation_cutoff, 1);
      // A valid current hash ensures this reaches the clock fence, rather than
      // passing accidentally because an unrelated integrity check rejected it.
      components.github.validateGithubReleaseInclusion(document.releaseInclusions[0]);
      await s.h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
        [s.original.fact_key, s.cache.policy_signature, JSON.stringify(document), digest(document)],
      );
    }
    const calls = [...s.provider.state.calls];
    s.provider.state.logicalTime = elapsed(s.provider.state.logicalTime, 60_000);
    await assert.rejects(s.runtime.runOnce(), /release_inclusion_frozen_normalization_unavailable/);
    assert.deepEqual(s.provider.state.calls, calls);
    assert.deepEqual(await scans(s), [s.pending]);
    assert.deepEqual(await sourceRows(s.h.db), [s.original]);
    assert.equal(
      Number((await s.h.db.query("SELECT count(*) AS count FROM leaderboard_pipeline.snapshots")).rows[0].count),
      1,
    );
  });
}

// Exact preceding cf499 release authority body; only its declaration name is
// local. This is a historical input fixture, never a current-hash oracle.
function precedingReleaseFingerprint(state, bindings = []) {
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  const decisionIds = new Set(
    requests.flatMap((r) => (r.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id)),
  );
  // A receipt's current audit entry is part of the authority used below. Fence
  // publication and pinned reads when it disappears, changes or is duplicated.
  const audit = (state.audit ?? [])
    .filter((event) => decisionIds.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  // Version the target/clock authority and include exact current bindings. An old
  // unbound locale publication cannot remain authorized after this correction.
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  // Earlier generic data-quality receipts did not qualify correction provenance.
  // Retire their publication authority without changing unaffected bindings.
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  // Generic reproduction receipts had no scenario/environment/result boundary.
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // Earlier generic bug receipts admitted non-issue and explicitly synthetic sources.
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Earlier answer receipts could precede their known source occurrence. Retire
  // only configurations whose destination is affected by that missing bound.
  if (bindings.some((binding) => binding.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  // Prior maintenance receipts lacked merged-participant, clock and unit admission.
  if (bindings.some((binding) => binding.metricId === "maintenance"))
    authority.push("maintenance-merged-participant/v1");
  // Tooling receipts independently require verified merged participation as well.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  // Older generic operations receipts lack the current source, public artifact
  // and affected-owner evidence boundary. Unrelated configurations stay exact.
  if (bindings.some((binding) => ["governance", "deployment_work", "incidents"].includes(binding.metricId)))
    authority.push("operations-contribution-evidence/v1");
  // Generic release receipts lacked a collected immutable inclusion and publication clock.
  if (bindings.some((binding) => binding.metricId === "release_changes"))
    authority.push("release-inclusion-recognition/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("release collection clock: the scoped version change replaces an incompatible frozen v1 scan token", async (t) => {
  const s = await persistedBeforeRelease(t);
  const sources = (
    await s.h.db.query(
      "SELECT repository_id,generation FROM leaderboard_ingestion.repository_access WHERE state='public' ORDER BY repository_id",
    )
  ).rows.map((row) => ({ repositoryId: Number(row.repository_id), generation: String(row.generation) }));
  const state = s.h.controlsStore.read();
  // Literal v1 run context predates the appended release normalization clock
  // version. Use the retained preceding authority function, not today's hash.
  const requested = {
    key: digest(["bounded-scan/v1", s.options.config, "public", "reconcile"]),
    contextHash: digest([
      configurationOverlay(state).revision,
      precedingReleaseFingerprint(state, s.options.config.recognitionBindings),
      sources,
    ]),
    cutoff: elapsed(s.original.observed_at, 100),
    sources,
  };
  const store = new ScanContinuationStore(s.h.db);
  let historical = await store.claim(
    requested,
    () => {},
    () => requested.cutoff,
    () => [components.contracts.publicScopeKey(publicScope)],
  );
  historical = await store.freeze(historical, elapsed(s.original.observed_at, 500), () => {});
  assert.ok(Date.parse(historical.observationCutoff) < Date.parse(s.provider.state.publishedAt));
  const old = (await scans(s))[0];
  assert.equal(old.cycle_token, historical.token);
  const publication = await s.runtime.runOnce();
  await assertReleasePublication(s, publication);
  const current = s.provider.state.events.findLast((event) => event.kind === "scan-context");
  assert.ok(current, "the existing scan claim must atomically replace its incompatible context");
  assert.notEqual(current.token, historical.token);
  assert.notEqual(current.contextHash, requested.contextHash);
  assert.ok(Date.parse(current.at) >= Date.parse(s.provider.state.publishedAt));
  const cached = await releaseCache(s);
  assert.ok(Date.parse(cached.document.releaseInclusions[0].observedAt) > Date.parse(historical.observationCutoff));
  assert.deepEqual(await sourceRows(s.h.db), [s.original]);
  assert.deepEqual(await scans(s), []);
});
