// Fictional native provider responses, real collector/normalizer/storage/public
// handlers. No socket, GitHub credentials, public deployment or real evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { components, fixtureId, harness, publicScope } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { mergeTargetGenerationSignature } from "../src/pull-request-merge-target.mjs";
import { pairPolicy } from "./relationship-pair-fixtures.mjs";
import { AggregateExplanationStore } from "../src/aggregate-explanations.mjs";

const slug = "synthetic-org/synthetic-repo",
  target = "release/previous-target";
const sha = "b".repeat(40),
  iso = (value) => new Date(value).toISOString();
const scope = components.contracts.canonicalPublicScope({ ...publicScope, repository: "2", branch: target });
const plain = { ...publicScope, repository: "2" };
const query = (extra = {}) =>
  new URLSearchParams({ ...components.contracts.publicScopeParameters(scope), metric: "pr_merged", ...extra });
const policy = (metricId) => ({
  metricId,
  version: `synthetic-${metricId}-merge-target-v1`,
  definitionVersion: components.metrics.metricRegistryV1.policy_version,
  unit: components.metrics.getMetricDefinition(metricId).definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["observed"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
});
function provider(known) {
  const mergedAt = iso(Date.now() - 86400_000),
    updatedAt = iso(Date.now() - 3600_000);
  const repository = { id: 2, node_id: "R_BRANCH_FIXTURE", full_name: slug, private: false, default_branch: "main" };
  const payloads = Array.from({ length: 5 }, (_, index) => ({
    id: 10 + index,
    node_id: `PR_BRANCH_${index}`,
    number: 10 + index,
    html_url: `https://github.com/${slug}/pull/${10 + index}`,
    created_at: iso(Date.parse(mergedAt) - 3600_000),
    updated_at: updatedAt,
    state: "closed",
    merged: true,
    draft: false,
    merged_at: mergedAt,
    merge_commit_sha: sha,
    base: { ref: "today-retargeted-main", repo: repository },
    user: { id: 101 + index, node_id: `U_BRANCH_${index}`, login: `synthetic-branch-${index}`, type: "User" },
  }));
  const state = { known, clock: iso(Date.now() + 10_000), graphql: 0, calls: [], forbid: false };
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value, options) => {
      assert.equal(state.forbid, false, "frozen publication must not revisit the native provider");
      const url = new URL(value);
      state.calls.push(url.pathname);
      let body;
      if ((options?.method ?? "GET") === "POST") {
        state.graphql++;
        const request = JSON.parse(options.body);
        assert.match(request.query, /itemTypes:\[MERGED_EVENT\]/);
        const pull = payloads.find((entry) => entry.number === request.variables.number);
        assert.ok(pull);
        const repo = { databaseId: 2, isPrivate: false, nameWithOwner: slug };
        const identity = { id: pull.node_id, number: pull.number, url: pull.html_url, repository: repo };
        body = {
          data: {
            repository: {
              ...repo,
              pullRequest: {
                ...identity,
                merged: true,
                mergedAt,
                mergeCommit: { oid: sha },
                timelineItems: {
                  nodes: state.known
                    ? [
                        {
                          __typename: "MergedEvent",
                          id: `MERGE_${pull.number}`,
                          createdAt: mergedAt,
                          mergeRefName: target,
                          mergeRef: null,
                          commit: { oid: sha },
                          pullRequest: identity,
                        },
                      ]
                    : [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        };
      } else if (url.pathname === `/repos/${slug}`) body = repository;
      else body = payloads.find((entry) => url.pathname === `/repos/${slug}/pulls/${entry.number}`);
      assert.ok(body, `unexpected provider path ${url.pathname}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { client, payloads, state, now: () => state.clock };
}
async function setup(
  t,
  { known = true, faultAfterFreeze = false, memoryDatabase = false, configuredScopes = [plain, scope] } = {},
) {
  const p = provider(known);
  const h = await harness(t, {
    memoryDatabase,
    payloads: p.payloads,
    githubClient: p.client,
    now: p.now,
    probeRepository: async () => ({ repositoryId: 2, installationId: 1, visibility: "public", checkedAt: p.now() }),
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.scopes = configuredScopes;
      config.policies = ["pr_opened", "pr_merged"].map((metricId) => {
        const value = policy(metricId);
        return {
          policy: value,
          signature: components.metrics.stableJSON(value),
          approvalReceipt: "synthetic-branch-policy",
        };
      });
    },
  });
  assert.equal(h.options.normalizer, undefined);
  assert.equal(h.options.githubEnrich, undefined);
  let runtime = h.runtime;
  const faults = { afterFreeze: faultAfterFreeze, frozen: false };
  if (faultAfterFreeze) {
    await h.runtime.stop();
    const run = async (query, sql, params) => {
      if (sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff")) faults.frozen = true;
      if (
        faults.afterFreeze &&
        faults.frozen &&
        sql.startsWith("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access")
      ) {
        faults.afterFreeze = false;
        throw new Error("synthetic_stop_after_merge_capture_freeze");
      }
      return query(sql, params);
    };
    const db = {
      query: (sql, params) => run(h.db.query.bind(h.db), sql, params),
      transaction: (work) =>
        h.db.transaction((tx) => work({ query: (sql, params) => run(tx.query.bind(tx), sql, params) })),
    };
    runtime = await createPipeline({ ...h.options, db });
    t.after(() => runtime.stop());
  }
  return { h, p, runtime, faults };
}
const caches = (db) =>
  db
    .query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE document ? 'pullRequestMergeTargetNormalization' ORDER BY fact_key,policy_signature",
    )
    .then((result) => result.rows);
const readScope = (runtime, selected = scope) => runtime.source.read(selected, null, new AbortController().signal);

test("native merge-event collection reaches retained proof, selected public board, source links and v5 exports", async (t) => {
  const { h, p, runtime } = await setup(t);
  const result = await runtime.runOnce({ cutoff: iso(Date.now() - 1000) });
  assert.equal(result.state, "published");
  assert.equal(p.state.graphql, 5);
  const saved = await caches(h.db);
  assert.equal(saved.length, 5);
  for (const row of saved) {
    const record = row.document.pullRequestMergeTargets[0];
    assert.equal(record.status, "known");
    assert.equal(record.event.mergeRefName, target);
    assert.equal(record.sourceRevision, p.payloads[0].updated_at);
    assert.deepEqual(await components.contracts.verifyGithubPullRequestMergeTargetCapture(record), record);
    assert.equal(
      row.document.facts.find((fact) => fact.metricId === "pr_merged").mergeTarget.proofHash,
      record.proofHash,
    );
  }
  const selected = await readScope(runtime);
  assert.equal(selected.selected.rows.length, 5);
  assert.ok(selected.selected.rows.every((row) => row.result.metricId === "pr_merged" && row.result.value === 1));
  const unfiltered = await readScope(runtime, plain);
  assert.ok(unfiltered.selected.rows.some((row) => row.result.metricId === "pr_opened"));
  const board = await runtime.app.inject(`/api/v1/boards?${query()}`);
  assert.equal(board.statusCode, 200, board.body);
  assert.deepEqual(board.json().scope, scope);
  assert.equal(board.json().rows.length, 5);
  const evidenceId = board.json().rows[0].evidenceIds[0];
  const proof = await runtime.app.inject(`/api/v1/evidence/${encodeURIComponent(evidenceId)}?${query()}`);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.match(proof.body, /https:\/\/github.com\/synthetic-org\/synthetic-repo\/pull\//);
  for (const format of ["json", "csv"]) {
    const response = await runtime.app.inject(
      `/api/v1/exports?${query({ format, snapshot: board.json().snapshotId })}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /public-export\/v5/);
    assert.doesNotMatch(response.body, /proofHash|pullRequestMergeTargets|MERGE_1|today-retargeted-main/);
  }
  const before = p.state.calls.length;
  const unsupported = await runtime.app.inject(`/api/v1/boards?${query({ metric: "pr_accepted_rate" })}`);
  assert.equal(unsupported.statusCode, 400);
  assert.equal(p.state.calls.length, before);
  h.controlsStore.transaction((state) => {
    state.profiles["101"] = { ...(state.profiles["101"] ?? {}), suppressed: true };
  });
  const hidden = await runtime.app.inject(`/api/v1/exports?${query({ snapshot: board.json().snapshotId })}`);
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.ok(hidden.json().rows.every((row) => row.actorId !== "101"));
});

test("a fresh run refreshes unknown proof for the identical PR revision without overwriting frozen generations", async (t) => {
  const { h, p, runtime } = await setup(t, { known: false });
  const cutoff = iso(Date.now() - 1000);
  assert.equal((await runtime.runOnce({ cutoff })).state, "published");
  const previous = await caches(h.db);
  assert.equal(previous.length, 5);
  assert.ok(previous.every((row) => row.document.pullRequestMergeTargets[0].status === "unknown"));
  const unknown = await readScope(runtime);
  assert.equal(unknown.selected.rows.length, 0, "missing proof must not manufacture measured zero rows");
  const oldSnapshot = unknown.selected.snapshot.snapshotId;
  p.state.known = true;
  p.state.clock = iso(Date.parse(p.state.clock) + 60_000);
  const nextCutoff = iso(Date.parse(cutoff) + 30_000);
  assert.equal((await runtime.runOnce({ cutoff: nextCutoff })).state, "published");
  assert.equal(p.state.graphql, 10);
  const current = await caches(h.db);
  assert.equal(current.length, 10);
  for (const row of previous)
    assert.deepEqual(
      current.find((next) => next.fact_key === row.fact_key && next.policy_signature === row.policy_signature),
      row,
    );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::integer AS count FROM leaderboard_ingestion.source_facts WHERE family='pull_requests'",
      )
    ).rows[0].count,
    5,
  );
  const known = await readScope(runtime);
  assert.equal(known.selected.rows.length, 5);
  const retained = await runtime.source.read(scope, oldSnapshot, new AbortController().signal);
  assert.equal(retained.selected.rows.length, 0);
  assert.notEqual(known.selected.snapshot.snapshotId, oldSnapshot);
});

test("an empty unknown branch publication still loses public authority if its retained capture is unavailable", async (t) => {
  const { h, runtime } = await setup(t, { known: false });
  await runtime.runOnce({ cutoff: iso(Date.now() - 1000) });
  const before = await readScope(runtime);
  assert.equal(before.selected.rows.length, 0);
  await h.db.query(
    "DELETE FROM leaderboard_pipeline.normalizations WHERE document ? 'pullRequestMergeTargetNormalization'",
  );
  await assert.rejects(readScope(runtime), /Frozen identity evidence unavailable/);
  const unavailable = await runtime.app.inject(
    `/api/v1/boards?${query({ snapshot: before.selected.snapshot.snapshotId })}`,
  );
  assert.equal(unavailable.statusCode, 503);
});

test("a frozen retry reuses exact native capture bytes without any additional proof lookup", async (t) => {
  const { h, p, runtime, faults } = await setup(t, { faultAfterFreeze: true });
  await assert.rejects(runtime.runOnce(), /synthetic_stop_after_merge_capture_freeze/);
  assert.equal(faults.frozen, true);
  const before = await caches(h.db);
  assert.equal(before.length, 5);
  const calls = p.state.graphql;
  assert.equal(calls, 5);
  p.state.forbid = true;
  const retry = await runtime.runOnce();
  assert.equal(retry.state, "published");
  assert.equal(p.state.graphql, calls);
  assert.deepEqual(await caches(h.db), before);
  assert.equal((await readScope(runtime)).selected.rows.length, 5);
});

test("a corrected merge stays excluded across a fresh proof generation and authorized private comparison", async (t) => {
  const { h, p, runtime } = await setup(t, { memoryDatabase: true });
  const cutoff = iso(Date.now() - 1000);
  assert.equal((await runtime.runOnce({ cutoff })).state, "published");
  const previous = await caches(h.db);
  assert.equal(previous.length, 5);
  assert.ok(previous.every((row) => row.document.pullRequestMergeTargets[0].status === "known"));
  const before = await runtime.app.inject(`/api/v1/boards?${query()}`);
  assert.equal(before.statusCode, 200, before.body);
  const originalFactId = before.json().rows.find((row) => row.actorId === "101").evidenceIds[0];
  const requestId = "11111111-1111-4111-8111-000000000065";
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "101",
      locator: p.payloads[0].html_url,
      status: "pending",
      version: 1,
      createdAt: Date.parse(p.state.clock),
      updatedAt: Date.parse(p.state.clock),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId: originalFactId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  const receipt = await runtime.applyCorrection(decision);
  assert.equal(receipt.status, "applied");
  const correctionRow = () =>
    h.db
      .query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])
      .then((result) => result.rows[0]);
  const originalCorrection = await correctionRow();
  assert.equal(originalCorrection.document.fact.state, "excluded");
  assert.equal(originalCorrection.document.fact.correctionReceipt, decision.approvalReceipt);

  p.state.clock = iso(Date.parse(p.state.clock) + 5000);
  const current = await runtime.runOnce({ cutoff: iso(Date.parse(cutoff) + 2000) });
  assert.equal(current.state, "published");
  assert.equal(p.state.graphql, 10);
  const generations = await caches(h.db);
  assert.equal(generations.length, 10);
  for (const old of previous) {
    assert.deepEqual(
      generations.find((row) => row.fact_key === old.fact_key && row.policy_signature === old.policy_signature),
      old,
    );
    const fresh = generations.find(
      (row) => row.fact_key === old.fact_key && row.policy_signature !== old.policy_signature,
    );
    assert.ok(fresh);
    assert.equal(fresh.document.pullRequestMergeTargets[0].status, "known");
    assert.equal(
      fresh.document.pullRequestMergeTargets[0].sourceRevision,
      old.document.pullRequestMergeTargets[0].sourceRevision,
    );
    assert.notEqual(
      fresh.document.pullRequestMergeTargets[0].proofHash,
      old.document.pullRequestMergeTargets[0].proofHash,
    );
  }
  const selectedHead = h.controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(scope)];
  assert.ok(selectedHead, "the branch publication has a current durable confirmation");
  const publication = current.publications.find((entry) => entry.snapshotId === selectedHead.snapshotId);
  assert.ok(publication, "the current run returned the confirmed branch snapshot");
  assert.equal(publication.revision, selectedHead.revision);
  assert.equal(publication.comparisonInput.state, "retained");
  const comparisons = runtime.policyComparisons.comparisons;
  const record = comparisons.input(publication.comparisonInput.inputId);
  const excluded = record.input.facts.find((fact) => fact.id === originalFactId && fact.state === "excluded");
  assert.deepEqual(excluded, originalCorrection.document.fact);
  const candidate = { ...policy("pr_merged"), version: "synthetic-corrected-merge-target-preview-v2" };
  const expectedActors = ["102", "103", "104", "105"];
  const result = await runtime.policyComparisons.withAuthorizedInputs(
    [record.authorization],
    async (removed, authority) =>
      h.controlsStore.transaction((state) => {
        // This is the protected manager's compare-before-redact path. Direct
        // SQL preview intentionally has a separate public-suppression guard.
        const compared = comparisons.compare(record, candidate, authority.restoreInput);
        for (const aggregate of [compared.document.before, compared.document.after])
          assert.deepEqual(aggregate.rows.map((row) => row.actorId).sort(), expectedActors);

        // Exclusions must not weaken the current capture binding of another
        // contributor's positive fact, even when its PR revision is unchanged.
        const forged = structuredClone(record.input);
        const positive = forged.facts.find(
          (fact) => fact.actorId === "102" && fact.metricId === "pr_merged" && fact.state !== "excluded",
        );
        const oldPositive = previous
          .flatMap((row) => row.document.facts)
          .find((fact) => fact.actorId === "102" && fact.metricId === "pr_merged");
        assert.ok(positive?.mergeTarget);
        assert.ok(oldPositive?.mergeTarget);
        assert.notEqual(positive.mergeTarget.proofHash, oldPositive.mergeTarget.proofHash);
        positive.mergeTarget.proofHash = oldPositive.mergeTarget.proofHash;
        assert.throws(
          () => authority.restoreInput(forged, record.authorization),
          /merge_target_normalization_binding_unavailable/,
        );
        return comparisons.redact(compared, record, state, removed);
      }),
  );
  assert.equal(result.status, "candidate_preview");
  for (const aggregate of [result.before, result.after])
    assert.deepEqual(aggregate.rows.map((row) => row.actorId).sort(), expectedActors);
  assert.equal(Object.hasOwn(originalCorrection.document.fact, "mergeTarget"), false);
  assert.deepEqual(await runtime.applyCorrection(decision), receipt);
  assert.deepEqual(await correctionRow(), originalCorrection);
});

test("invalid merge-target scopes reject at the approved run boundary before provider access", async (t) => {
  for (const [name, invalidScope] of [
    ["unknown public role", { ...scope, roles: ["unknown"] }],
    ["operator is not a public role", { ...scope, roles: ["operator"] }],
    [
      "legacy scope version cannot carry merge-target roles",
      { ...scope, schemaVersion: "public-scope/v2", context: "current", projects: [], roles: ["reporter"] },
    ],
  ])
    await t.test(name, async (subtest) => {
      const { h, p, runtime } = await setup(subtest, {
        memoryDatabase: true,
        configuredScopes: [invalidScope],
      });
      assert.deepEqual(p.state.calls, [], "construction does not read the provider");
      await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 1000) }), /invalid_public_scope/);
      assert.deepEqual(p.state.calls, [], "invalid approved scope cannot start provider collection");
      await assert.rejects(readScope(runtime), /invalid_public_scope/);
      assert.deepEqual(p.state.calls, [], "invalid scope cannot reach provider access through a read");
      for (const table of ["leaderboard_ingestion.collection_runs", "leaderboard_pipeline.heads"]) {
        const rows = (await h.db.query(`SELECT count(*) AS count FROM ${table}`)).rows;
        assert.equal(Number(rows[0].count), 0, "invalid scope cannot allocate " + table);
      }
    });
});

const mergeProviderUnavailable = /merge_target_normalizer_version_unverified/;
const mergeSnapshots = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
async function assertNoMergePublication(h) {
  assert.deepEqual(await caches(h.db), []);
  assert.deepEqual(await mergeSnapshots(h), []);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
}
async function replacementSetup(t, after = async () => {}) {
  const current = await setup(t, { memoryDatabase: true, configuredScopes: [scope] });
  const { h, p } = current;
  await h.runtime.stop();
  const custom = { calls: 0 };
  const normalize = components.github.createGithubEvidenceNormalizer({
    client: p.client,
    source: h.options.sourceId,
    allowedRepositoryIds: [2],
    isSynthetic: true,
    // Fixture authority; the enclosing runtime checks its live authorization.
    assertAuthorized: () => assert.equal(h.options.dataMode, "synthetic"),
    pullRequestMergeTargetRepositoryIds: [2],
    now: p.now,
  });
  h.options.defaultDeliveryNormalizationVersion = components.github.defaultDeliveryNormalizationVersion;
  h.options.pullRequestMergeTargetNormalizationVersion = components.github.pullRequestMergeTargetNormalizationVersion;
  h.options.normalizer = async (input) => {
    custom.calls++;
    const output = await normalize(input);
    await after(h.options, input, output);
    return output;
  };
  const runtime = await createPipeline(h.options);
  t.after(() => runtime.stop());
  return { ...current, runtime, custom };
}
function afterMergeTransaction(h, predicate, after) {
  const transaction = h.db.transaction;
  h.db.transaction = async (work) => {
    let matched = false;
    const result = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          matched ||= predicate(sql);
          return value;
        },
      }),
    );
    if (matched) after();
    return result;
  };
}
const removeMergeCompatibility = (options) => {
  delete options.normalizer;
  delete options.pullRequestMergeTargetNormalizationVersion;
};

test("a retained merge-target replacement cannot borrow built-in compatibility after its option is removed", async (t) => {
  const { h, runtime, custom } = await replacementSetup(t);
  removeMergeCompatibility(h.options);
  await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 1000) }), mergeProviderUnavailable);
  assert.equal(custom.calls, 0);
  await assertNoMergePublication(h);
});

test("merge-target compatibility lost across the awaited replacement result cannot be persisted", async (t) => {
  const { h, runtime, custom } = await replacementSetup(t, async (options) => {
    await Promise.resolve();
    removeMergeCompatibility(options);
  });
  await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 1000) }), mergeProviderUnavailable);
  assert.equal(custom.calls, 1);
  await assertNoMergePublication(h);
});

test("merge-target compatibility is checked after the source lock and before cache insertion", async (t) => {
  let armed = false,
    changed = false;
  const { h, runtime, custom } = await replacementSetup(t, async () => {
    armed = true;
  });
  const transaction = h.db.transaction;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          if (armed && sql.includes("leaderboard_ingestion.repository_access") && /FOR UPDATE/.test(sql)) {
            removeMergeCompatibility(h.options);
            armed = false;
            changed = true;
          }
          return value;
        },
      }),
    );
  await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 1000) }), mergeProviderUnavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  await assertNoMergePublication(h);
});

test("merge-target compatibility lost during new cache dependency retention rolls back the cache", async (t) => {
  let armed = false,
    changed = false;
  const { h, runtime, custom } = await replacementSetup(t, async () => {
    armed = true;
  });
  const transaction = h.db.transaction;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          if (
            armed &&
            sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") &&
            sql.includes("FOR UPDATE")
          ) {
            removeMergeCompatibility(h.options);
            armed = false;
            changed = true;
          }
          return value;
        },
      }),
    );
  await assert.rejects(runtime.runOnce({ cutoff: iso(Date.now() - 1000) }), mergeProviderUnavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 1);
  await assertNoMergePublication(h);
});

test("a retained merge-target cache is withheld when compatibility disappears during dependency capture", async (t) => {
  const { h, p, runtime, custom } = await replacementSetup(t);
  const cutoff = iso(Date.now() - 1000);
  assert.equal((await runtime.runOnce({ cutoff })).state, "published");
  assert.equal(custom.calls, 5);
  const beforeCaches = await caches(h.db),
    beforeSnapshots = await mergeSnapshots(h),
    beforeControls = h.controlsStore.read();
  let changed = false;
  afterMergeTransaction(
    h,
    (sql) =>
      sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") && sql.includes("FOR UPDATE"),
    () => {
      removeMergeCompatibility(h.options);
      changed = true;
    },
  );
  await assert.rejects(runtime.runOnce({ cutoff }), mergeProviderUnavailable);
  assert.equal(changed, true);
  assert.equal(custom.calls, 5);
  assert.equal(p.state.graphql, 5);
  assert.deepEqual(await caches(h.db), beforeCaches);
  assert.deepEqual(await mergeSnapshots(h), beforeSnapshots);
  assert.deepEqual(h.controlsStore.read().pipelinePublications, beforeControls.pipelinePublications);
  assert.deepEqual(h.controlsStore.read().pipelineHeads, beforeControls.pipelineHeads);
});

test("SQL merge-target publication cannot gain SQLite visibility after provider compatibility is lost", async (t) => {
  const { h, p, runtime, custom } = await replacementSetup(t);
  const cutoff = iso(Date.now() - 1000);
  let changed = false;
  afterMergeTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
    () => {
      if (changed) return;
      removeMergeCompatibility(h.options);
      changed = true;
    },
  );
  await assert.rejects(runtime.runOnce({ cutoff }), mergeProviderUnavailable);
  assert.equal(changed, true);
  const saved = await mergeSnapshots(h),
    savedCaches = await caches(h.db);
  assert.equal(saved.length, 1);
  assert.equal(savedCaches.length, 5);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  h.options.pullRequestMergeTargetNormalizationVersion = components.github.pullRequestMergeTargetNormalizationVersion;
  assert.equal((await runtime.runOnce({ cutoff })).state, "published");
  assert.equal(custom.calls, 5);
  assert.equal(p.state.graphql, 5);
  assert.deepEqual(await mergeSnapshots(h), saved);
  assert.deepEqual(await caches(h.db), savedCaches);
  const visible = await readScope(runtime);
  assert.equal(visible.selected.snapshot.snapshotId, saved[0].snapshot_id);
  assert.equal(visible.selected.rows.length, 5);
});

test("an explicitly compatible replacement preserves native merge proof and selected publication", async (t) => {
  const { h, p, runtime, custom } = await replacementSetup(t);
  assert.equal((await runtime.runOnce({ cutoff: iso(Date.now() - 1000) })).state, "published");
  assert.equal(custom.calls, 5);
  assert.equal(p.state.graphql, 5);
  const saved = await caches(h.db);
  assert.equal(saved.length, 5);
  for (const row of saved) {
    const record = row.document.pullRequestMergeTargets[0];
    assert.equal(record.status, "known");
    assert.equal(record.event.mergeRefName, target);
    assert.deepEqual(await components.contracts.verifyGithubPullRequestMergeTargetCapture(record), record);
  }
  assert.equal((await readScope(runtime)).selected.rows.length, 5);
});

test("adding an unused replacement option does not reclassify the captured built-in merge provider", async (t) => {
  const { h, p, runtime } = await setup(t, { memoryDatabase: true, configuredScopes: [scope] });
  let unused = 0;
  h.options.normalizer = async () => {
    unused++;
    throw new Error("unused merge-target replacement");
  };
  assert.equal((await runtime.runOnce({ cutoff: iso(Date.now() - 1000) })).state, "published");
  assert.equal(unused, 0);
  assert.equal(p.state.graphql, 5);
  assert.equal((await readScope(runtime)).selected.rows.length, 5);
});

async function fieldMergeSetup(t) {
  const { h, p } = await setup(t, { memoryDatabase: true, configuredScopes: [scope] });
  await h.runtime.stop();
  const state = { calls: 0, afterFreeze: true, frozen: false };
  const normalizerOptions = {
    client: p.client,
    source: h.options.sourceId,
    allowedRepositoryIds: [2],
    isSynthetic: true,
    assertAuthorized: () => assert.equal(h.options.dataMode, "synthetic"),
    now: p.now,
  };
  const native = components.github.createGithubEvidenceNormalizer({
    ...normalizerOptions,
    pullRequestMergeTargetRepositoryIds: [2],
  });
  const enriched = components.github.createGithubEvidenceNormalizer({
    ...normalizerOptions,
    enrich: async (input) => {
      const pull = p.payloads.find((entry) => entry.node_id === input.fact.subjectId);
      assert.ok(pull);
      return {
        repository: { id: 2, slug, visibility: "public" },
        proof: {
          verified: true,
          source: "github_rest",
          revision: input.fact.sourceRevision,
          eventId: `synthetic-field-${pull.number}`,
          isSynthetic: true,
        },
        family: "field_change",
        action: "issue_field_changed",
        occurredAt: pull.merged_at,
        observedAt: input.observedAt,
        payload: { issue: pull, sender: pull.user, change: { before: { priority: 1 }, after: { priority: 2 } } },
      };
    },
  });
  h.options.normalizer = async (input) => {
    state.calls++;
    const merge = await native(input);
    const field = await enriched(input);
    assert.equal(field.facts.length, 1);
    assert.equal(field.facts[0].metricId, "issue_field_updates");
    // Real native and enrichment normalizers supply both sets of facts. This
    // fixture never supplies a merge projection or a cache version marker.
    return {
      ...merge,
      facts: [...merge.facts, ...field.facts],
      actors: [...new Map([...merge.actors, ...field.actors].map((actor) => [actor.id, actor])).values()],
      evidence: [...merge.evidence, ...field.evidence],
    };
  };
  h.options.defaultDeliveryNormalizationVersion = components.github.defaultDeliveryNormalizationVersion;
  h.options.pullRequestMergeTargetNormalizationVersion = components.github.pullRequestMergeTargetNormalizationVersion;
  h.options.fieldChangeNormalizationVersion = components.github.fieldChangeNormalizationVersion;
  const query = async (run, sql, params) => {
    if (sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff")) state.frozen = true;
    if (
      state.afterFreeze &&
      state.frozen &&
      sql.startsWith("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access")
    ) {
      state.afterFreeze = false;
      throw new Error("synthetic_stop_after_combined_merge_field_freeze");
    }
    return run(sql, params);
  };
  const db = {
    query: (sql, params) => query(h.db.query.bind(h.db), sql, params),
    transaction: (work) =>
      h.db.transaction((tx) => work({ query: (sql, params) => query(tx.query.bind(tx), sql, params) })),
  };
  const runtime = await createPipeline({ ...h.options, db });
  t.after(() => runtime.stop());
  return { h, p, runtime, state };
}

test("field-enriched native merge generations retain current, frozen and correction authority", async (t) => {
  const { h, p, runtime, state } = await fieldMergeSetup(t);
  const cutoff = p.state.clock;
  await assert.rejects(runtime.runOnce(), /synthetic_stop_after_combined_merge_field_freeze/);
  assert.equal(state.frozen, true);
  assert.equal(state.calls, 5);
  assert.equal(p.state.graphql, 5);
  const frozen = await caches(h.db);
  assert.equal(frozen.length, 5);
  const fieldVersion = components.github.fieldChangeNormalizationVersion;
  for (const row of frozen) {
    const marker = row.document.pullRequestMergeTargetNormalization;
    const merge = mergeTargetGenerationSignature(marker.baseSignature, marker.generation, comparisonHash);
    const inner =
      row.document.defaultDeliveryNormalizationVersion === undefined
        ? merge
        : comparisonHash([components.github.defaultDeliveryNormalizationVersion, merge]);
    assert.equal(row.document.fieldChangeNormalizationVersion, fieldVersion);
    assert.equal(row.policy_signature, comparisonHash([fieldVersion, inner]));
    assert.ok(row.document.facts.some((fact) => fact.metricId === "issue_field_updates"));
    const native = row.document.pullRequestMergeTargets[0];
    assert.equal(native.status, "known");
    assert.deepEqual(await components.contracts.verifyGithubPullRequestMergeTargetCapture(native), native);
    assert.equal(
      row.document.facts.find((fact) => fact.metricId === "pr_merged").mergeTarget.proofHash,
      native.proofHash,
    );
  }

  p.state.forbid = true;
  const resumed = await runtime.runOnce();
  assert.equal(resumed.state, "published");
  assert.equal(state.calls, 5);
  assert.equal(p.state.graphql, 5);
  assert.deepEqual(await caches(h.db), frozen);
  const selected = await readScope(runtime);
  assert.equal(selected.selected.rows.length, 5);
  assert.equal(
    (await runtime.source.read(scope, selected.selected.snapshot.snapshotId, new AbortController().signal)).selected
      .rows.length,
    5,
  );
  const board = await runtime.app.inject(`/api/v1/boards?${query()}`);
  assert.equal(board.statusCode, 200, board.body);
  assert.equal(board.json().rows.length, 5);
  assert.doesNotMatch(board.body, /fieldChangeNormalizationVersion|pullRequestMergeTargets|proofHash/);
  const originalFactId = board.json().rows.find((row) => row.actorId === "101").evidenceIds[0];
  const requestId = "11111111-1111-4111-8111-000000004593";
  h.controlsStore.transaction((value) => {
    value.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "101",
      locator: p.payloads[0].html_url,
      status: "pending",
      version: 1,
      createdAt: Date.parse(p.state.clock),
      updatedAt: Date.parse(p.state.clock),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId: originalFactId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  const receipt = await runtime.applyCorrection(decision);
  assert.equal(receipt.status, "applied");
  const correction = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])
  ).rows[0];
  assert.equal(correction.document.fact.state, "excluded");
  assert.equal(Object.hasOwn(correction.document.fact, "mergeTarget"), false);

  p.state.forbid = false;
  p.state.clock = iso(Date.parse(p.state.clock) + 5000);
  const fresh = await runtime.runOnce({ cutoff: iso(Date.parse(cutoff) + 2000) });
  assert.equal(fresh.state, "published");
  assert.equal(state.calls, 10);
  assert.equal(p.state.graphql, 10);
  const generations = await caches(h.db);
  assert.equal(generations.length, 10);
  for (const old of frozen)
    assert.deepEqual(
      generations.find((row) => row.fact_key === old.fact_key && row.policy_signature === old.policy_signature),
      old,
    );
  p.state.forbid = true;
  const expectedActors = ["102", "103", "104", "105"];
  const currentBoard = await runtime.app.inject(`/api/v1/boards?${query()}`);
  assert.equal(currentBoard.statusCode, 200, currentBoard.body);
  assert.ok(currentBoard.json().rows.every((row) => row.actorId !== "101"));
  const head = h.controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(scope)];
  assert.ok(head);
  const publication = fresh.publications.find((entry) => entry.snapshotId === head.snapshotId);
  assert.ok(publication);
  assert.equal(publication.comparisonInput.state, "retained");
  const comparisons = runtime.policyComparisons.comparisons;
  const record = comparisons.input(publication.comparisonInput.inputId);
  assert.deepEqual(
    record.input.facts.find((fact) => fact.id === originalFactId && fact.state === "excluded"),
    correction.document.fact,
  );
  const result = await runtime.policyComparisons.withAuthorizedInputs(
    [record.authorization],
    async (removed, authority) =>
      h.controlsStore.transaction((value) => {
        const compared = comparisons.compare(
          record,
          { ...policy("pr_merged"), version: "synthetic-field-merge-comparison-v1" },
          authority.restoreInput,
        );
        for (const aggregate of [compared.document.before, compared.document.after])
          assert.deepEqual(aggregate.rows.map((row) => row.actorId).sort(), expectedActors);
        const forged = structuredClone(record.input);
        const positive = forged.facts.find((fact) => fact.actorId === "102" && fact.metricId === "pr_merged");
        const previous = frozen
          .flatMap((row) => row.document.facts)
          .find((fact) => fact.actorId === "102" && fact.metricId === "pr_merged");
        assert.ok(positive?.mergeTarget);
        assert.ok(previous?.mergeTarget);
        assert.notEqual(positive.mergeTarget.proofHash, previous.mergeTarget.proofHash);
        positive.mergeTarget.proofHash = previous.mergeTarget.proofHash;
        assert.throws(
          () => authority.restoreInput(forged, record.authorization),
          /merge_target_normalization_binding_unavailable/,
        );
        return comparisons.redact(compared, record, value, removed);
      }),
  );
  assert.equal(result.status, "candidate_preview");
  for (const aggregate of [result.before, result.after])
    assert.deepEqual(aggregate.rows.map((row) => row.actorId).sort(), expectedActors);
  assert.deepEqual(await runtime.applyCorrection(decision), receipt);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])).rows[0],
    correction,
  );
  assert.equal(state.calls, 10);
  assert.equal(p.state.graphql, 10);
});

async function pairFieldMergeSetup(t, { freeze = true, replay = false } = {}) {
  const p = provider(true);
  const issue = {
    id: 9472,
    node_id: "I_SYNTHETIC_MERGE_REPLAY",
    number: 9472,
    html_url: "https://github.com/" + slug + "/issues/9472",
    created_at: p.payloads[0].created_at,
    updated_at: p.payloads[0].updated_at,
    state: "open",
    user: p.payloads[0].user,
  };
  const state = {
    calls: 0,
    collections: 0,
    forbid: false,
    afterFreeze: freeze,
    frozen: false,
    unboundSubject: null,
    unboundObservedAt: null,
  };
  const h = await harness(t, {
    memoryDatabase: true,
    githubClient: p.client,
    now: p.now,
    webhookDispatch: replay,
    probeRepository: async () => ({ repositoryId: 2, installationId: 1, visibility: "public", checkedAt: p.now() }),
    source: {
      async readPage(request) {
        assert.equal(state.forbid, false, "confirmed history must not recollect provider observations");
        state.collections++;
        assert.ok(request.family === "pull_requests" || (replay && request.family === "issues"));
        const items = request.family === "pull_requests" ? p.payloads : [issue];
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: items.length,
          facts: items.map((item) => ({
            subjectId: item.node_id,
            sourceRevision: item.updated_at,
            sourceUrl: item.html_url,
            evidence: "current_state",
            actorId: null,
            occurredAt: null,
            state: "present",
          })),
        };
      },
    },
    configure(config) {
      const issuePolicy = config.policies[0];
      config.repositories[0].families = replay ? ["pull_requests", "issues"] : ["pull_requests"];
      config.scopes = [plain, scope];
      const fieldPolicy = {
        ...policy("pr_merged"),
        metricId: "issue_field_updates",
        unit: components.metrics.getMetricDefinition("issue_field_updates").definition.unit,
        version: "synthetic-pair-field-merge-policy-v1",
        roles: ["triager"],
      };
      config.policies = [policy("pr_merged"), pairPolicy(), fieldPolicy].map((value) => ({
        policy: value,
        signature: components.metrics.stableJSON(value),
        approvalReceipt: "synthetic-pair-field-merge-policy",
      }));
      if (replay) config.policies.push(issuePolicy);
    },
  });
  await h.runtime.stop();
  const native = components.github.createGithubEvidenceNormalizer({
    client: p.client,
    source: h.options.sourceId,
    allowedRepositoryIds: [2],
    isSynthetic: true,
    assertAuthorized: () => assert.equal(h.options.dataMode, "synthetic"),
    pullRequestMergeTargetRepositoryIds: [2],
    now: p.now,
  });
  h.options.normalizer = async (input) => {
    assert.equal(state.forbid, false, "confirmed history must not invoke the withdrawn producer");
    if (input.family === "issues") {
      assert.equal(input.fact.subjectId, issue.node_id);
      return components.github.normalizeGithubObservation({
        repository: { id: 2, slug, visibility: "public" },
        proof: {
          verified: true,
          source: "github_rest",
          revision: input.fact.sourceRevision,
          eventId: "synthetic-merge-replay-issue-created",
          isSynthetic: true,
        },
        family: "issue",
        action: "opened",
        occurredAt: issue.created_at,
        observedAt: input.observedAt,
        payload: { issue, sender: issue.user },
      });
    }
    assert.equal(input.family, "pull_requests");
    state.calls++;
    const pull = p.payloads.find((entry) => entry.node_id === input.fact.subjectId);
    assert.ok(pull);
    const merge = await native(input);
    const eventId = "synthetic-pair-merge-" + pull.number;
    const unbound = state.unboundSubject === pull.node_id;
    const pair = components.github.normalizeGithubObservation({
      repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
      proof: {
        verified: true,
        source: "github_graphql",
        revision: input.fact.sourceRevision,
        eventId,
        isSynthetic: true,
      },
      family: "relationship",
      action: "connected",
      occurredAt: pull.merged_at,
      observedAt: unbound ? state.unboundObservedAt : input.observedAt,
      payload: {
        repository: { id: 2, private: false, full_name: slug },
        pull_request: pull,
        sender: { id: 202, node_id: "U_SYNTHETIC_MERGE_PAIR", login: "synthetic-merge-linker", type: "User" },
        relationship: {
          kind: "closing",
          from: pull.node_id,
          to: "I_SYNTHETIC_MERGE_PAIR",
          intentional: true,
          publicEndpointsVerified: true,
          ...(unbound
            ? {}
            : {
                pair: {
                  version: components.github.relationshipPairNormalizationVersion,
                  kind: "closing",
                  action: "connect",
                  eventId,
                  from: { repositoryId: "2", artifactId: pull.node_id, kind: "pull_request" },
                  to: { repositoryId: "2", artifactId: "I_SYNTHETIC_MERGE_PAIR", kind: "issue" },
                },
              }),
        },
      },
    });
    const field = components.github.normalizeGithubObservation({
      repository: { id: 2, slug, visibility: "public" },
      proof: {
        verified: true,
        source: "github_rest",
        revision: input.fact.sourceRevision,
        eventId: "synthetic-pair-merge-field-" + pull.number,
        isSynthetic: true,
      },
      family: "field_change",
      action: "issue_field_changed",
      occurredAt: pull.merged_at,
      observedAt: input.observedAt,
      payload: { issue: pull, sender: pull.user, change: { before: { priority: 1 }, after: { priority: 2 } } },
    });
    assert.equal(pair.facts.length, 1);
    assert.equal(pair.facts[0].metricId, "closing_links");
    assert.equal(field.facts.length, 1);
    assert.equal(field.facts[0].metricId, "issue_field_updates");
    // Actual normalizers supply all claims; the runtime supplies generation markers.
    return {
      ...merge,
      facts: [...merge.facts, ...pair.facts, ...field.facts],
      actors: [
        ...new Map([...merge.actors, ...pair.actors, ...field.actors].map((actor) => [actor.id, actor])).values(),
      ],
      evidence: [...merge.evidence, ...pair.evidence, ...field.evidence],
    };
  };
  for (const name of [
    "defaultDeliveryNormalizationVersion",
    "fieldChangeNormalizationVersion",
    "relationshipPairNormalizationVersion",
    "pullRequestMergeTargetNormalizationVersion",
  ])
    h.options[name] = components.github[name];
  const guardedQuery = async (run, sql, params) => {
    if (sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff")) state.frozen = true;
    if (
      state.afterFreeze &&
      state.frozen &&
      sql.startsWith("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access")
    ) {
      state.afterFreeze = false;
      throw new Error("synthetic_stop_after_pair_field_merge_freeze");
    }
    return run(sql, params);
  };
  h.options.db = {
    query: (sql, params) => guardedQuery(h.db.query.bind(h.db), sql, params),
    transaction: (work) =>
      h.db.transaction((tx) => work({ query: (sql, params) => guardedQuery(tx.query.bind(tx), sql, params) })),
  };
  const runtime = await createPipeline(h.options);
  t.after(() => runtime.stop());
  return { h, p, runtime, state, issue };
}

function pairMergePublication(result, h, selected = plain) {
  const head = h.controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(selected)];
  assert.ok(head);
  const publication = result.publications.find((entry) => entry.snapshotId === head.snapshotId);
  assert.ok(publication);
  assert.equal(publication.comparisonInput.state, "retained");
  return publication;
}

async function assertPairMergeQuantity(runtime, expected) {
  const ordinary = await readScope(runtime, plain);
  assert.deepEqual(
    ordinary.selected.rows
      .filter((row) => row.result.metricId === "closing_links" && row.result.value > 0)
      .map((row) => [row.actorId, row.result.value]),
    [["202", expected]],
  );
  const branch = await readScope(runtime);
  assert.equal(branch.selected.rows.length, 5);
  assert.ok(branch.selected.rows.every((row) => row.result.metricId === "pr_merged"));
  const unsupported = await runtime.app.inject("/api/v1/boards?" + query({ metric: "closing_links" }));
  assert.equal(unsupported.statusCode, 400, unsupported.body);
  assert.match(unsupported.body, /unsupported_merge_target_metric/);
}

async function assertPairMergeCapture(h, runtime, publication, rows) {
  const frozen = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0];
  assert.equal(comparisonHash(frozen.document), frozen.document_hash);
  const record = runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
  const explanation = new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).document;
  const captured = frozen.document.identityAuthorization.relationshipPairEvidence;
  assert.equal(captured.schemaVersion, "pipeline-relationship-pair-authority/v4");
  assert.deepEqual(record.authorization.relationshipPairEvidence, captured);
  assert.deepEqual(explanation.authorization.relationshipPairEvidence, captured);
  for (const row of rows) {
    const binding = captured.bindings.find(
      (entry) =>
        entry.factKey === row.fact_key &&
        entry.documentHash === row.document_hash &&
        entry.policySignature === row.policy_signature,
    );
    assert.ok(binding);
    assert.equal(comparisonHash(row.document), row.document_hash);
    for (const fact of row.document.facts.filter((entry) => entry.metricId === "closing_links"))
      assert.ok(binding.factHashes.includes(comparisonHash(fact)));
  }
  const pairs = (input) =>
    input.facts
      .filter((fact) => fact.metricId === "closing_links")
      .sort((left, right) => comparisonHash(left).localeCompare(comparisonHash(right)));
  assert.equal(pairs(frozen.document.frozen).length, 5);
  assert.deepEqual(pairs(record.input), pairs(frozen.document.frozen));
  await runtime.policyComparisons.withAuthorizedInputs([record.authorization], async (_removed, authority) => {
    const compared = runtime.policyComparisons.comparisons.compare(
      record,
      { ...pairPolicy(), version: "synthetic-pair-merge-preview-v2" },
      authority.restoreInput,
    );
    for (const aggregate of [compared.document.before, compared.document.after])
      assert.deepEqual(
        aggregate.rows.map((row) => [row.actorId, row.value]),
        [["202", 5]],
      );
  });
  await runtime.aggregateExplanations.read(publication.snapshotId);
}

async function retainedPairMergeState(h) {
  const snapshots = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id")).rows;
  const frozen = (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id")).rows;
  const normalized = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature")
  ).rows;
  return structuredClone({
    snapshots,
    frozen,
    normalized,
    privateInputs: h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs ORDER BY id").all(),
    explanations: h.controlsStore.db
      .prepare("SELECT * FROM pipeline_aggregate_explanations ORDER BY snapshot_id")
      .all(),
    confirmations: structuredClone(h.controlsStore.read().pipelinePublications),
    heads: structuredClone(h.controlsStore.read().pipelineHeads),
  });
}

test("pair and field enriched merge generations preserve frozen authority and withdraw a later unbound pair", async (t) => {
  const { h, p, runtime, state } = await pairFieldMergeSetup(t);
  const cutoff = p.state.clock;
  await assert.rejects(runtime.runOnce(), /synthetic_stop_after_pair_field_merge_freeze/);
  assert.equal(state.calls, 5);
  assert.equal(p.state.graphql, 5);
  const original = await caches(h.db);
  assert.equal(original.length, 5);
  for (const row of original) {
    const marker = row.document.pullRequestMergeTargetNormalization;
    const merge = mergeTargetGenerationSignature(marker.baseSignature, marker.generation, comparisonHash);
    const delivery = comparisonHash([components.github.defaultDeliveryNormalizationVersion, merge]);
    const field = comparisonHash([components.github.fieldChangeNormalizationVersion, delivery]);
    assert.equal(row.policy_signature, comparisonHash([components.github.relationshipPairNormalizationVersion, field]));
    assert.equal(
      row.document.defaultDeliveryNormalizationVersion,
      components.github.defaultDeliveryNormalizationVersion,
    );
    assert.equal(row.document.fieldChangeNormalizationVersion, components.github.fieldChangeNormalizationVersion);
    assert.equal(
      row.document.relationshipPairNormalizationVersion,
      components.github.relationshipPairNormalizationVersion,
    );
    assert.ok(row.document.facts.some((fact) => fact.relationshipPair?.kind === "closing"));
    assert.equal(row.document.pullRequestMergeTargets[0].status, "known");
  }
  p.state.forbid = true;
  const resumed = await runtime.runOnce();
  assert.equal(resumed.state, "published");
  assert.equal(state.calls, 5);
  assert.equal(p.state.graphql, 5);
  assert.deepEqual(await caches(h.db), original);
  await assertPairMergeQuantity(runtime, 5);
  const originalPublication = pairMergePublication(resumed, h);
  await assertPairMergeCapture(h, runtime, originalPublication, original);

  p.state.forbid = false;
  p.state.clock = iso(Date.parse(p.state.clock) + 5000);
  const nextCutoff = iso(Date.parse(cutoff) + 2000);
  const fresh = await runtime.runOnce({ cutoff: nextCutoff });
  assert.equal(fresh.state, "published");
  assert.equal(state.calls, 10);
  assert.equal(p.state.graphql, 10);
  const generations = await caches(h.db);
  assert.equal(generations.length, 10);
  for (const old of original)
    assert.deepEqual(
      generations.find((row) => row.fact_key === old.fact_key && row.policy_signature === old.policy_signature),
      old,
    );
  await assertPairMergeQuantity(runtime, 5);
  const historical = await runtime.source.read(plain, originalPublication.snapshotId, new AbortController().signal);
  assert.deepEqual(
    historical.selected.rows
      .filter((row) => row.result.metricId === "closing_links" && row.result.value > 0)
      .map((row) => [row.actorId, row.result.value]),
    [["202", 5]],
  );
  await assertPairMergeCapture(h, runtime, originalPublication, original);
  const branchPublication = pairMergePublication(fresh, h, scope);
  const record = runtime.policyComparisons.comparisons.input(branchPublication.comparisonInput.inputId);
  await runtime.policyComparisons.withAuthorizedInputs([record.authorization], async (_removed, authority) => {
    authority.restoreInput(record.input, record.authorization);
    const forged = structuredClone(record.input);
    const fact = forged.facts.find((entry) => entry.metricId === "pr_merged" && entry.actorId === "101");
    const previous = original
      .flatMap((row) => row.document.facts)
      .find((entry) => entry.metricId === "pr_merged" && entry.actorId === "101");
    assert.ok(fact?.mergeTarget);
    assert.ok(previous?.mergeTarget);
    assert.notEqual(fact.mergeTarget.proofHash, previous.mergeTarget.proofHash);
    fact.mergeTarget.proofHash = previous.mergeTarget.proofHash;
    assert.throws(
      () => authority.restoreInput(forged, record.authorization),
      /merge_target_normalization_binding_unavailable/,
    );
  });

  // One native event becomes unresolved; retaining its older proof must not
  // silently restore its positive credit. The other four pairs remain supported.
  state.unboundSubject = p.payloads[0].node_id;
  state.unboundObservedAt = iso(Date.parse(nextCutoff) + 1000);
  p.state.clock = iso(Date.parse(p.state.clock) + 5000);
  const unresolved = await runtime.runOnce({ cutoff: iso(Date.parse(nextCutoff) + 2000) });
  assert.equal(unresolved.state, "published");
  assert.equal(state.calls, 15);
  assert.equal(p.state.graphql, 15);
  const retained = await caches(h.db);
  assert.equal(retained.length, 15);
  for (const old of generations)
    assert.deepEqual(
      retained.find((row) => row.fact_key === old.fact_key && row.policy_signature === old.policy_signature),
      old,
    );
  const unknown = retained
    .filter(
      (row) =>
        !generations.some((old) => old.fact_key === row.fact_key && old.policy_signature === row.policy_signature),
    )
    .flatMap((row) => row.document.facts)
    .find((fact) => fact.metricId === "closing_links" && fact.artifactId === state.unboundSubject);
  assert.equal(unknown?.state, "unknown");
  assert.equal(Object.hasOwn(unknown, "relationshipPair"), false);
  await assertPairMergeQuantity(runtime, 4);

  // A fresh generation must validate every retained predecessor of its first
  // source before classification; an old marker cannot hide a broken hash.
  const saved = await retainedPairMergeState(h);
  const beforeTamperCalls = state.calls;
  const beforeTamperNative = [...p.state.calls];
  const previous = original[0];
  const firstSource = (
    await h.db.query(
      "SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE family='pull_requests' ORDER BY fact_key",
    )
  ).rows[0];
  assert.equal(previous.fact_key, firstSource.fact_key);
  const tampered = structuredClone(previous.document);
  delete tampered.pullRequestMergeTargetNormalization;
  p.state.clock = iso(Date.parse(p.state.clock) + 5000);
  p.state.forbid = true;
  try {
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb WHERE fact_key=$1 AND policy_signature=$2",
      [previous.fact_key, previous.policy_signature, JSON.stringify(tampered)],
    );
    await assert.rejects(
      runtime.runOnce({ cutoff: iso(Date.parse(nextCutoff) + 4000) }),
      /normalization_integrity_error/,
    );
  } finally {
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb WHERE fact_key=$1 AND policy_signature=$2",
      [previous.fact_key, previous.policy_signature, JSON.stringify(previous.document)],
    );
  }
  assert.equal(state.calls, beforeTamperCalls);
  assert.deepEqual(p.state.calls, beforeTamperNative);
  assert.deepEqual(await retainedPairMergeState(h), saved);
  await assertPairMergeQuantity(runtime, 4);
});

test("already confirmed pair field and merge publications acknowledge without a withdrawn producer", async (t) => {
  const { h, p, runtime, state, issue } = await pairFieldMergeSetup(t, { freeze: false, replay: true });
  assert.equal((await runtime.runOnce({ cutoff: iso(Date.parse(p.state.clock) - 1000) })).state, "published");
  p.state.clock = iso(Date.parse(p.state.clock) + 2000);
  await runtime.inbox.insert({
    deliveryId: fixtureId(9472),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: fixtureId(9472),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: issue.node_id,
      sourceUrl: issue.html_url,
      actorId: null,
      occurredAt: issue.created_at,
    },
  });
  assert.equal(await runtime.inbox.complete(await runtime.inbox.claim()), true);
  runtime.outbox.complete = runtime.outbox.fail = async () => {
    throw new Error("synthetic combined merge acknowledgment loss");
  };
  await assert.rejects(runtime.dispatchOnce(), /synthetic combined merge acknowledgment loss/);
  const saved = await retainedPairMergeState(h);
  const ordinaryHead = saved.heads[components.contracts.publicScopeKey(plain)];
  assert.equal(ordinaryHead.defaultDeliveryNormalizationVersion, components.github.defaultDeliveryNormalizationVersion);
  assert.equal(ordinaryHead.fieldChangeNormalizationVersion, components.github.fieldChangeNormalizationVersion);
  assert.equal(
    ordinaryHead.relationshipPairNormalizationVersion,
    components.github.relationshipPairNormalizationVersion,
  );
  const before = (await h.db.query("SELECT event_key,operation FROM leaderboard_ingestion.outbox")).rows[0];
  assert.ok(before);
  const dispatchReceipts = (
    await h.db.query(
      "SELECT scope_key,snapshot_id FROM leaderboard_pipeline.dispatch_publications WHERE operation_key=$1 ORDER BY scope_key",
      [before.operation.operationKey],
    )
  ).rows;
  assert.deepEqual(
    dispatchReceipts.map((entry) => entry.scope_key),
    [plain, scope].map(components.contracts.publicScopeKey).sort(),
  );
  for (const entry of dispatchReceipts) {
    const confirmation = saved.confirmations[entry.snapshot_id];
    assert.ok(confirmation);
    assert.equal(confirmation.scopeKey, entry.scope_key);
    assert.equal(confirmation.snapshotId, entry.snapshot_id);
    assert.equal(saved.heads[entry.scope_key]?.snapshotId, entry.snapshot_id);
  }
  const calls = state.calls;
  const collections = state.collections;
  const nativeCalls = [...p.state.calls];
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  for (const name of [
    "defaultDeliveryNormalizationVersion",
    "fieldChangeNormalizationVersion",
    "relationshipPairNormalizationVersion",
    "pullRequestMergeTargetNormalizationVersion",
  ])
    delete h.options[name];
  state.forbid = true;
  p.state.forbid = true;
  await runtime.stop();
  const verifyConfiguration = h.options.verifyConfiguration;
  let hostApproved = true,
    deniedApprovalReads = 0;
  h.options.verifyConfiguration = async (value) => {
    if (!hostApproved) {
      deniedApprovalReads++;
      return false;
    }
    return verifyConfiguration(value);
  };
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const dispatchRow = async () =>
    (await h.db.query("SELECT * FROM leaderboard_ingestion.outbox WHERE event_key=$1", [before.event_key])).rows[0];
  const receiptRows = async () =>
    (await h.db.query("SELECT * FROM leaderboard_pipeline.receipts ORDER BY receipt_id")).rows;
  const boundDispatchRows = async () =>
    (
      await h.db.query(
        "SELECT * FROM leaderboard_pipeline.dispatch_publications WHERE operation_key=$1 ORDER BY scope_key",
        [before.operation.operationKey],
      )
    ).rows;
  const savedReceipts = await receiptRows();
  const savedDispatchRows = await boundDispatchRows();
  assert.equal((await dispatchRow()).attempts, 1);
  const assertRefused = async (attempt, reason, expected) => {
    const row = await dispatchRow();
    assert.equal(row.state, "pending");
    assert.equal(row.completion, null);
    assert.equal(row.attempts, attempt);
    assert.equal(row.reason_code, reason);
    assert.deepEqual(row.operation, before.operation);
    assert.deepEqual(await retainedPairMergeState(h), expected);
    assert.deepEqual(await receiptRows(), savedReceipts);
    assert.deepEqual(await boundDispatchRows(), savedDispatchRows);
    assert.equal(state.calls, calls);
    assert.equal(state.collections, collections);
    assert.deepEqual(p.state.calls, nativeCalls);
  };
  const readyRetry = () =>
    h.db.query(
      "UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp() WHERE event_key=$1 AND state='pending'",
      [before.event_key],
    );

  // A partial private confirmation set must fall back to the live producer guards.
  const missingSnapshotId = dispatchReceipts[0].snapshot_id;
  const partial = structuredClone(saved);
  delete partial.confirmations[missingSnapshotId];
  h.controlsStore.transaction((value) => {
    delete value.pipelinePublications[missingSnapshotId];
  });
  try {
    assert.equal(await restarted.dispatchOnce(), "retry_scheduled");
    await assertRefused(2, "publication_unavailable", partial);
  } finally {
    h.controlsStore.transaction((value) => {
      value.pipelinePublications[missingSnapshotId] = structuredClone(saved.confirmations[missingSnapshotId]);
    });
  }
  assert.deepEqual(await retainedPairMergeState(h), saved);

  // Updating the SQL hash cannot retarget the originally confirmed calculation.
  const originalFrozen = saved.frozen.find((row) => row.snapshot_id === ordinaryHead.snapshotId);
  assert.ok(originalFrozen);
  const changedDocument = structuredClone(originalFrozen.document);
  const changedPair = changedDocument.frozen.facts.find(
    (fact) => fact.metricId === "closing_links" && fact.relationshipPair,
  );
  assert.ok(changedPair);
  changedPair.relationshipPair.eventId += "-retained-tamper";
  const changedHash = comparisonHash(changedDocument);
  assert.notEqual(changedHash, originalFrozen.document_hash);
  const changedState = structuredClone(saved);
  const changedRow = changedState.frozen.find((row) => row.snapshot_id === originalFrozen.snapshot_id);
  changedRow.document = changedDocument;
  changedRow.document_hash = changedHash;
  await h.db.query(
    "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
    [originalFrozen.snapshot_id, JSON.stringify(changedDocument), changedHash],
  );
  try {
    await readyRetry();
    assert.equal(await restarted.dispatchOnce(), "retry_scheduled");
    await assertRefused(3, "publication_unavailable", changedState);
  } finally {
    await h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [originalFrozen.snapshot_id, JSON.stringify(originalFrozen.document), originalFrozen.document_hash],
    );
  }
  assert.deepEqual(await retainedPairMergeState(h), saved);

  // Revoke only after the real awaited claim, beyond the dispatch entry approval.
  await readyRetry();
  const claim = restarted.outbox.claim;
  let revokedClaims = 0;
  restarted.outbox.claim = async (...args) => {
    const lease = await claim.apply(restarted.outbox, args);
    assert.ok(lease);
    assert.equal(hostApproved, true);
    hostApproved = false;
    revokedClaims++;
    return lease;
  };
  try {
    assert.equal(await restarted.dispatchOnce(), "retry_scheduled");
    assert.equal(revokedClaims, 1);
    assert.ok(deniedApprovalReads > 0, "the claimed reuse path must recheck current host approval");
    await assertRefused(4, "source_unavailable", saved);
  } finally {
    restarted.outbox.claim = claim;
    hostApproved = true;
  }

  await readyRetry();
  assert.equal(await restarted.dispatchOnce(), "processed");
  assert.equal((await dispatchRow()).attempts, 5);
  assert.deepEqual(await receiptRows(), savedReceipts);
  assert.deepEqual(await boundDispatchRows(), savedDispatchRows);
  const after = (await h.db.query("SELECT event_key,state,operation FROM leaderboard_ingestion.outbox")).rows[0];
  assert.equal(after.state, "done");
  assert.equal(after.event_key, before.event_key);
  assert.deepEqual(after.operation, before.operation);
  assert.deepEqual(await retainedPairMergeState(h), saved);
  assert.equal(state.calls, calls);
  assert.equal(state.collections, collections);
  assert.deepEqual(p.state.calls, nativeCalls);
  await assertPairMergeQuantity(restarted, 5);
  await assert.rejects(
    restarted.runOnce(),
    /(?:merge_target|default_delivery|field_change|relationship_pair)_normalizer_version_unverified/,
  );
  assert.equal(state.calls, calls);
  assert.equal(state.collections, collections);
  assert.deepEqual(p.state.calls, nativeCalls);
  assert.deepEqual(await retainedPairMergeState(h), saved);
});

async function pendingPairMergeRetry(t) {
  const fixture = await pairFieldMergeSetup(t);
  const { h, p, runtime, state } = fixture;
  const sourceRows = async () =>
    structuredClone((await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows);
  const scanRows = async () =>
    structuredClone(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.scan_continuations ORDER BY configuration_key")).rows,
    );
  const cutoff = p.state.clock;
  await assert.rejects(runtime.runOnce(), /synthetic_stop_after_pair_field_merge_freeze/);
  assert.equal(state.calls, 5);
  assert.equal(state.collections, 1);
  assert.equal(p.state.graphql, 5);
  const original = structuredClone(await caches(h.db));
  const sources = await sourceRows();
  const scans = await scanRows();
  assert.equal(original.length, 5);
  assert.equal(sources.length, 5);
  assert.equal(scans.length, 1);
  assert.equal(iso(scans[0].event_cutoff), cutoff);
  assert.equal(iso(scans[0].observation_cutoff), cutoff);
  assert.ok(Object.values(scans[0].scope_heads).every((head) => head === null));
  assert.deepEqual(
    original.map((row) => row.fact_key),
    sources.map((row) => row.fact_key),
  );

  // B changes only its capture clock and generation. Its native source rows
  // remain A's exact five observations, and neither cycle has a publication.
  const payloads = JSON.stringify(p.payloads);
  p.state.clock = iso(Date.parse(cutoff) + 5000);
  let committed = 0;
  const transaction = h.db.transaction;
  afterMergeTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.normalizations\b/.test(sql),
    () => {
      if (++committed === 5) throw new Error("synthetic_stop_after_later_merge_generation_commit");
    },
  );
  try {
    await assert.rejects(
      runtime.runOnce({ cutoff: iso(Date.parse(cutoff) + 2000) }),
      /synthetic_stop_after_later_merge_generation_commit/,
    );
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(committed, 5, "the fault follows all five committed B normalizations");
  assert.equal(state.calls, 10);
  assert.equal(state.collections, 2);
  assert.equal(p.state.graphql, 10);
  assert.equal(JSON.stringify(p.payloads), payloads);
  assert.deepEqual(await sourceRows(), sources);
  assert.deepEqual(await scanRows(), scans);
  const all = structuredClone(await caches(h.db));
  assert.equal(all.length, 10);
  const later = all.filter(
    (row) =>
      !original.some((prior) => prior.fact_key === row.fact_key && prior.policy_signature === row.policy_signature),
  );
  assert.equal(later.length, 5);
  assert.deepEqual(
    later.map((row) => row.fact_key),
    original.map((row) => row.fact_key),
  );
  for (const prior of original) {
    assert.deepEqual(
      all.find((row) => row.fact_key === prior.fact_key && row.policy_signature === prior.policy_signature),
      prior,
    );
    const next = later.find((row) => row.fact_key === prior.fact_key);
    assert.notEqual(next.policy_signature, prior.policy_signature);
    assert.notEqual(
      next.document.pullRequestMergeTargetNormalization.generation,
      prior.document.pullRequestMergeTargetNormalization.generation,
    );
    assert.equal(prior.document.pullRequestMergeTargets.length, 1);
    assert.equal(next.document.pullRequestMergeTargets.length, 1);
    const before = await components.contracts.verifyGithubPullRequestMergeTargetCapture(
      prior.document.pullRequestMergeTargets[0],
    );
    const after = await components.contracts.verifyGithubPullRequestMergeTargetCapture(
      next.document.pullRequestMergeTargets[0],
    );
    assert.equal(before.status, "known");
    assert.equal(after.status, "known");
    assert.equal(before.observedAt, cutoff);
    assert.equal(after.observedAt, p.state.clock);
    assert.ok(after.observedAt > cutoff);
    const { observedAt: _beforeClock, proofHash: _beforeHash, ...beforeMeaning } = before;
    const { observedAt: _afterClock, proofHash: _afterHash, ...afterMeaning } = after;
    assert.deepEqual(afterMeaning, beforeMeaning);
    assert.equal(comparisonHash(prior.document), prior.document_hash);
    assert.equal(comparisonHash(next.document), next.document_hash);
    assert.ok(prior.document.facts.some((fact) => fact.metricId === "closing_links" && fact.relationshipPair));
    assert.ok(next.document.facts.some((fact) => fact.metricId === "closing_links" && fact.relationshipPair));
    assert.equal(prior.document.fieldChangeNormalizationVersion, components.github.fieldChangeNormalizationVersion);
    assert.equal(next.document.fieldChangeNormalizationVersion, components.github.fieldChangeNormalizationVersion);
  }
  const pending = await retainedPairMergeState(h);
  for (const key of ["snapshots", "frozen", "privateInputs", "explanations"]) assert.equal(pending[key].length, 0);
  assert.equal(Object.keys(pending.confirmations ?? {}).length, 0);
  assert.equal(Object.keys(pending.heads ?? {}).length, 0);
  assert.equal(pending.normalized.length, 10);
  state.forbid = true;
  p.state.forbid = true;
  const calls = { normalized: state.calls, collections: state.collections, graphql: p.state.graphql };
  const nativeCalls = [...p.state.calls];
  return {
    ...fixture,
    cutoff,
    original,
    later,
    all,
    pending,
    sources,
    scans,
    sourceRows,
    scanRows,
    assertNoRecollection() {
      assert.deepEqual({ normalized: state.calls, collections: state.collections, graphql: p.state.graphql }, calls);
      assert.deepEqual(p.state.calls, nativeCalls);
    },
  };
}

async function assertPendingPairMergeRetry(fixture, expected = fixture.pending) {
  fixture.assertNoRecollection();
  assert.deepEqual(await fixture.sourceRows(), fixture.sources);
  assert.deepEqual(await fixture.scanRows(), fixture.scans);
  assert.deepEqual(await retainedPairMergeState(fixture.h), expected);
}

async function completePairMergeRetry(fixture) {
  const { h, runtime, cutoff, original, all } = fixture;
  await assertPendingPairMergeRetry(fixture);
  const result = await runtime.runOnce();
  assert.equal(result.state, "published");
  assert.equal(result.publications.length, 2);
  fixture.assertNoRecollection();
  assert.deepEqual(await fixture.sourceRows(), fixture.sources);
  assert.deepEqual(await caches(h.db), all);
  assert.deepEqual(await fixture.scanRows(), [], "only successful confirmation retires A's continuation");
  await assertPairMergeQuantity(runtime, 5);
  const publication = pairMergePublication(result, h);
  await assertPairMergeCapture(h, runtime, publication, original);
  const expectedBindings = original
    .map((row) => JSON.stringify([row.fact_key, row.policy_signature, row.document_hash]))
    .sort();
  const originalProofs = new Set(
    original.flatMap((row) => row.document.pullRequestMergeTargets.map((p) => p.proofHash)),
  );
  const laterProofs = new Set(
    fixture.later.flatMap((row) => row.document.pullRequestMergeTargets.map((p) => p.proofHash)),
  );
  for (const selected of result.publications) {
    const frozen = (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        selected.snapshotId,
      ])
    ).rows[0];
    const record = runtime.policyComparisons.comparisons.input(selected.comparisonInput.inputId);
    const explanation = new AggregateExplanationStore(h.controlsStore).read(selected.snapshotId).document;
    assert.equal(comparisonHash(frozen.document), frozen.document_hash);
    assert.equal(frozen.document.frozen.cutoff, cutoff);
    assert.equal(record.input.cutoff, cutoff);
    assert.equal(explanation.cutoff, cutoff);
    const capture = frozen.document.identityAuthorization.relationshipPairEvidence;
    assert.equal(capture.schemaVersion, "pipeline-relationship-pair-authority/v4");
    assert.deepEqual(
      capture.bindings
        .map((entry) => JSON.stringify([entry.factKey, entry.policySignature, entry.documentHash]))
        .sort(),
      expectedBindings,
      "only A's exact five bindings authorize the resumed frozen publication",
    );
    assert.deepEqual(record.authorization.relationshipPairEvidence, capture);
    assert.deepEqual(explanation.authorization.relationshipPairEvidence, capture);
    const proofs = frozen.document.frozen.facts
      .filter((fact) => fact.mergeTarget)
      .map((fact) => fact.mergeTarget.proofHash);
    assert.ok(proofs.length >= 5);
    assert.ok(proofs.every((proof) => originalProofs.has(proof) && !laterProofs.has(proof)));
  }
  fixture.assertNoRecollection();
  assert.deepEqual(await caches(h.db), all);
  return publication;
}

async function writePairMergeRetryCache(h, row, document, hash = comparisonHash(document)) {
  const result = await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2 RETURNING document_hash",
    [row.fact_key, row.policy_signature, JSON.stringify(document), hash],
  );
  assert.deepEqual(result.rows, [{ document_hash: hash }]);
}

test("an unconfirmed pair and field merge cycle retries before a later unconfirmed generation", async (t) => {
  await completePairMergeRetry(await pendingPairMergeRetry(t));
});

for (const malformed of ["hash", "pair fact"]) {
  test("an unconfirmed retry validates a future merge generation's " + malformed, async (t) => {
    const fixture = await pendingPairMergeRetry(t);
    const previous = fixture.later[0];
    const document = structuredClone(previous.document);
    if (malformed === "hash") document.reasons.push("synthetic_future_hash_mismatch");
    else document.facts.find((fact) => fact.metricId === "closing_links").id = 17;
    const hash = malformed === "hash" ? previous.document_hash : comparisonHash(document);
    await writePairMergeRetryCache(fixture.h, previous, document, hash);
    try {
      const altered = await retainedPairMergeState(fixture.h);
      await assert.rejects(
        fixture.runtime.runOnce(),
        malformed === "hash" ? /normalization_integrity_error/ : /relationship_pair_authority_integrity_error/,
      );
      await assertPendingPairMergeRetry(fixture, altered);
    } finally {
      await writePairMergeRetryCache(fixture.h, previous, previous.document, previous.document_hash);
    }
    await completePairMergeRetry(fixture);
  });
}

test("a frozen retry cannot admit its selected merge proof after the original cutoff", async (t) => {
  const fixture = await pendingPairMergeRetry(t);
  const previous = fixture.original[0];
  const document = structuredClone(previous.document);
  const capture = document.pullRequestMergeTargets[0];
  const { proofHash, ...body } = capture;
  body.observedAt = fixture.p.state.clock;
  const replacement = { ...body, proofHash: await components.contracts.githubPullRequestMergeTargetHash(body) };
  await components.contracts.verifyGithubPullRequestMergeTargetCapture(replacement);
  document.pullRequestMergeTargets[0] = replacement;
  for (const fact of document.facts)
    if (fact.mergeTarget?.proofHash === proofHash) fact.mergeTarget.proofHash = replacement.proofHash;
  assert.ok(replacement.observedAt > fixture.cutoff);
  await writePairMergeRetryCache(fixture.h, previous, document);
  try {
    const altered = await retainedPairMergeState(fixture.h);
    await assert.rejects(fixture.runtime.runOnce(), /merge_target_normalization_binding_unavailable/);
    await assertPendingPairMergeRetry(fixture, altered);
  } finally {
    await writePairMergeRetryCache(fixture.h, previous, previous.document, previous.document_hash);
  }
  await completePairMergeRetry(fixture);
});

async function assertRetriedPairMergeWithdrawn(fixture, publication) {
  const { runtime } = fixture;
  for (const snapshot of [null, publication.snapshotId]) {
    const parameters = new URLSearchParams({
      ...components.contracts.publicScopeParameters(plain),
      metric: "closing_links",
      ...(snapshot ? { snapshot } : {}),
    });
    for (const suffix of ["/boards", "/exports"]) {
      const response = await runtime.app.inject("/api/v1" + suffix + "?" + parameters);
      if (response.statusCode === 200) {
        if (suffix === "/boards")
          assert.deepEqual(
            response.json().rows.filter((row) => row.result.value > 0),
            [],
          );
        else assert.doesNotMatch(response.body, /synthetic-merge-linker/);
      } else assert.equal(response.statusCode, snapshot ? 410 : 503, response.body);
      assert.doesNotMatch(response.body, /I_SYNTHETIC_MERGE_PAIR|PR_BRANCH_|relationshipPair|normalizationSources/);
    }
  }
  const record = runtime.policyComparisons.comparisons.input(publication.comparisonInput.inputId);
  await assert.rejects(
    runtime.policyComparisons.withAuthorizedInputs([record.authorization], () => {
      assert.fail("withdrawn current authority must not reach private restoration");
    }),
    /Frozen|unavailable|changed/,
  );
  await assert.rejects(runtime.aggregateExplanations.read(publication.snapshotId), /Frozen|unavailable|changed/);
  fixture.assertNoRecollection();
}

test("a retried pair and field merge publication still withdraws a currently deleted endpoint", async (t) => {
  const fixture = await pendingPairMergeRetry(t);
  const publication = await completePairMergeRetry(fixture);
  const { h, p, runtime } = fixture;
  const before = await retainedPairMergeState(h);
  const runId = fixtureId(9641);
  await runtime.collection.start({
    runId,
    repositoryId: 2,
    family: "issues",
    mode: "audit",
    since: null,
    until: p.state.clock,
  });
  assert.equal(
    await runtime.collection.step(runId, {
      async readPage(request) {
        assert.equal(request.repositoryId, 2);
        assert.equal(request.family, "issues");
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          expectedCount: 1,
          nextCursor: null,
          facts: [
            {
              subjectId: "I_SYNTHETIC_MERGE_PAIR",
              sourceRevision: "synthetic-frozen-pair-endpoint-deleted-v1",
              sourceUrl: "https://github.com/" + slug + "/issues/9473",
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "deleted",
            },
          ],
        };
      },
    }),
    "complete",
  );
  assert.deepEqual(
    (
      await h.db.query(
        "SELECT subject_id,reason FROM leaderboard_ingestion.object_suppressions WHERE repository_id=2 ORDER BY subject_id",
      )
    ).rows,
    [{ subject_id: "I_SYNTHETIC_MERGE_PAIR", reason: "deleted" }],
  );
  assert.equal(
    (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0].state,
    "public",
  );
  await assertRetriedPairMergeWithdrawn(fixture, publication);
  assert.deepEqual(await retainedPairMergeState(h), before);
});

test("a retried pair and field merge publication still withdraws a currently private repository", async (t) => {
  const fixture = await pendingPairMergeRetry(t);
  const publication = await completePairMergeRetry(fixture);
  const before = await retainedPairMergeState(fixture.h);
  assert.equal(
    await fixture.runtime.collection.suppress(fixtureId(9642), "d".repeat(64), 1, [2], "private"),
    "accepted",
  );
  const access = await fixture.h.db.query(
    "SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2",
  );
  assert.equal(access.rows[0].state, "unavailable");
  await assertRetriedPairMergeWithdrawn(fixture, publication);
  assert.deepEqual(await retainedPairMergeState(fixture.h), before);
});

// Exercise the actual protected-history SQL projection through a real native
// publication. The wrapper observes unchanged query results and never rewrites them.
async function boundedMergeSourceRead(h, runtime) {
  const transaction = h.db.transaction;
  let captured = null;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.startsWith("WITH retained AS MATERIALIZED") && sql.includes("history_records")) {
            captured ??= { sql, params: structuredClone(params), rows: structuredClone(result.rows) };
          }
          return result;
        },
      }),
    );
  try {
    const read = await runtime.source.read(scope, null, new AbortController().signal, undefined, false, true);
    assert.ok(captured, "history read must execute its bounded normalization query");
    return { read, captured };
  } finally {
    h.db.transaction = transaction;
  }
}

test("bounded history reads retain native merge-target source authority without provider reads", async (t) => {
  const { h, p, runtime } = await setup(t, { memoryDatabase: true, configuredScopes: [scope] });
  assert.equal((await runtime.runOnce({ cutoff: iso(Date.now() - 1000) })).state, "published");
  const ordinary = await readScope(runtime);
  const saved = await caches(h.db);
  const requests = p.state.calls.length;
  p.state.forbid = true;
  const { read, captured } = await boundedMergeSourceRead(h, runtime);
  assert.ok(read);
  assert.deepEqual(read.selected.snapshot, ordinary.selected.snapshot);
  assert.deepEqual(read.selected.rows, ordinary.selected.rows);
  assert.equal(read.controls.version, ordinary.controls.version);
  assert.equal(captured.rows.length, 5);
  for (const row of captured.rows) {
    assert.deepEqual(Object.keys(row.source_document).sort(), ["sourceRevision", "sourceUrl", "subjectId"]);
    assert.equal(typeof row.policy_signature, "string");
    assert.equal(String(row.repository_id), "2");
    assert.ok(Number(row.history_bytes) > 0 && Number(row.history_bytes) <= 8_000_000);
  }
  assert.equal(p.state.calls.length, requests);
  assert.deepEqual(await caches(h.db), saved);
});

test("bounded history SQL minimizes source documents and withholds oversized merge bindings", async (t) => {
  const { h, p, runtime } = await setup(t, { memoryDatabase: true, configuredScopes: [scope] });
  assert.equal((await runtime.runOnce({ cutoff: iso(Date.now() - 1000) })).state, "published");
  const { read, captured } = await boundedMergeSourceRead(h, runtime);
  const savedCaches = await caches(h.db);
  const savedSnapshots = await mergeSnapshots(h);
  const savedControls = h.controlsStore.read();
  const requests = p.state.calls.length;
  p.state.forbid = true;
  const original = captured.rows[0];
  const syntheticFactKeys = [];
  // Append hostile synthetic copies for the identical production query only.
  // Existing immutable source facts, frozen inputs and confirmation rows stay exact.
  for (const [label, field, oversized] of [
    ["unselected metadata", "ignoredFixturePadding", false],
    ["selected source binding", "sourceUrl", true],
  ]) {
    const key = comparisonHash(["synthetic-history-merge-binding", label, original.fact_key]);
    syntheticFactKeys.push(key);
    await h.db.query(
      `INSERT INTO leaderboard_ingestion.source_facts
        (fact_key,repository_id,family,subject_id,source_revision,document,first_run_id,observed_at)
       SELECT $1,repository_id,family,subject_id,source_revision,
         document || jsonb_build_object($3::text,repeat('x',8000001)),first_run_id,observed_at
       FROM leaderboard_ingestion.source_facts WHERE fact_key=$2`,
      [key, original.fact_key, field],
    );
    await h.db.query(
      `INSERT INTO leaderboard_pipeline.normalizations (fact_key,policy_signature,document,document_hash)
       SELECT $1,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations
       WHERE fact_key=$2 AND policy_signature=$3`,
      [key, original.fact_key, original.policy_signature],
    );
    const params = structuredClone(captured.params);
    params[0] = [original.document_hash];
    params[3] = JSON.stringify([{ fact_key: key, document_hash: original.document_hash }]);
    const rows = (await h.db.query(captured.sql, params)).rows;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(Number(row.history_records), 1);
    if (oversized) {
      assert.ok(Number(row.history_bytes) > 8_000_000);
      assert.equal(row.document, null);
      assert.equal(row.source_document, null);
      assert.equal(row.policy_signature, null);
      assert.ok(Buffer.byteLength(JSON.stringify(row)) < 1024, "oversized source data never reaches the reader");
    } else {
      assert.deepEqual(row.document, original.document);
      assert.deepEqual(row.source_document, original.source_document);
      assert.equal(row.policy_signature, original.policy_signature);
      const expected = (
        await h.db.query(
          "SELECT octet_length($1::jsonb::text)+octet_length($2::jsonb::text)+octet_length($3::text) AS bytes",
          [JSON.stringify(original.document), JSON.stringify(original.source_document), original.policy_signature],
        )
      ).rows[0];
      assert.equal(Number(row.history_bytes), Number(expected.bytes));
      assert.ok(Number(row.history_bytes) < 8_000_000);
    }
  }
  // The profiled OR branch admits retained generation signatures before the
  // JS validator sees them. Many individually indexable signatures must also
  // stay within the aggregate transport budget, independently of document size.
  const mergeDocument = {
    pullRequestMergeTargetNormalization: structuredClone(original.document.pullRequestMergeTargetNormalization),
    facts: [],
    actors: [],
    evidence: [],
  };
  const mergeHash = comparisonHash(mergeDocument);
  const signatureCount = 3600;
  const signatureBytes = 2300;
  const bindingBytes = Number(
    (
      await h.db.query("SELECT octet_length($1::jsonb::text)+octet_length($2::jsonb::text) AS bytes", [
        JSON.stringify(mergeDocument),
        JSON.stringify(original.source_document),
      ])
    ).rows[0].bytes,
  );
  assert.ok(bindingBytes * signatureCount <= 8_000_000, "documents and source bindings alone fit the budget");
  assert.ok(signatureBytes * signatureCount > 8_000_000, "the signature bytes alone exceed the budget");
  await h.db.query(
    `INSERT INTO leaderboard_pipeline.normalizations (fact_key,policy_signature,document,document_hash)
     SELECT $1,lpad(fixture.n::text,8,'0') || repeat('x',2292),$2::jsonb,$3
     FROM generate_series(1,3600) AS fixture(n)`,
    [original.fact_key, JSON.stringify(mergeDocument), mergeHash],
  );
  const mergeParams = structuredClone(captured.params);
  mergeParams[0] = [mergeHash];
  mergeParams[3] = JSON.stringify([{ fact_key: original.fact_key, document_hash: mergeHash }]);
  assert.deepEqual(mergeParams[1], captured.params[1], "the admitted signature allowlist stays unchanged");
  const oversizedRows = (await h.db.query(captured.sql, mergeParams)).rows;
  assert.equal(oversizedRows.length, signatureCount);
  assert.ok(
    oversizedRows.every(
      (row) =>
        Number(row.history_records) === signatureCount &&
        Number(row.history_bytes) === (bindingBytes + signatureBytes) * signatureCount &&
        row.document === null &&
        row.source_document === null &&
        row.policy_signature === null,
    ),
    "the captured SQL must withhold every variable field before returning oversized profiled signatures",
  );
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedRows)) < 2_000_000);

  // Without the generation marker, a foreign signature is never admitted by
  // the unchanged digest allowlist. This does not invent a giant legacy allowlist.
  const legacyDocument = { facts: [], actors: [], evidence: [] };
  const legacyHash = comparisonHash(legacyDocument);
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.normalizations (fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
    [original.fact_key, "u".repeat(signatureBytes), JSON.stringify(legacyDocument), legacyHash],
  );
  const legacyParams = structuredClone(captured.params);
  legacyParams[0] = [legacyHash];
  legacyParams[3] = JSON.stringify([{ fact_key: original.fact_key, document_hash: legacyHash }]);
  assert.deepEqual(legacyParams[1], captured.params[1]);
  assert.deepEqual((await h.db.query(captured.sql, legacyParams)).rows, []);

  // Remove only the SQL controls' normalization rows before the full current
  // pair-history read. Their synthetic source facts remain immutable and retained.
  await h.db.query(
    `DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND document_hash=$2
      AND policy_signature IN (
        SELECT lpad(fixture.n::text,8,'0') || repeat('x',2292)
        FROM generate_series(1,$3::integer) AS fixture(n)
      )`,
    [original.fact_key, mergeHash, signatureCount],
  );
  await h.db.query(
    "DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2 AND document_hash=$3",
    [original.fact_key, "u".repeat(signatureBytes), legacyHash],
  );
  await h.db.query("DELETE FROM leaderboard_pipeline.normalizations WHERE fact_key=ANY($1::text[])", [
    syntheticFactKeys,
  ]);

  const after = await boundedMergeSourceRead(h, runtime);
  assert.deepEqual(after.read.selected.snapshot, read.selected.snapshot);
  assert.deepEqual(after.read.selected.rows, read.selected.rows);
  assert.deepEqual(await mergeSnapshots(h), savedSnapshots);
  assert.deepEqual(h.controlsStore.read(), savedControls);
  const originals = new Set(savedCaches.map((row) => JSON.stringify([row.fact_key, row.policy_signature])));
  assert.deepEqual(
    (await caches(h.db)).filter((row) => originals.has(JSON.stringify([row.fact_key, row.policy_signature]))),
    savedCaches,
  );
  assert.equal(p.state.calls.length, requests);
});

test("pair and triage no-op generations compose through frozen reuse, current reads and correction", { timeout: 120_000 }, async (t) => {
  const fixture = await pairFieldMergeSetup(t);
  const { h, p, state } = fixture;
  await fixture.runtime.stop();
  const originalNormalizer = h.options.normalizer;
  const triageVersion = components.github.triageMetadataNormalizationVersion;
  assert.equal(triageVersion, "triage-metadata-json-values/v1");
  let triageNoops = 0;
  h.options.normalizer = async (input) => {
    const output = await originalNormalizer(input);
    const pull = p.payloads.find((entry) => entry.node_id === input.fact.subjectId);
    assert.ok(pull);
    const triage = components.github.normalizeGithubObservation({
      repository: { id: 2, slug, visibility: "public" },
      proof: {
        verified: true,
        source: "github_rest",
        revision: input.fact.sourceRevision,
        eventId: "synthetic-pair-triage-merge-" + pull.number,
        isSynthetic: true,
      },
      family: "triage",
      action: "unlabeled",
      occurredAt: pull.merged_at,
      observedAt: input.observedAt,
      payload: {
        pull_request: structuredClone(pull),
        sender: structuredClone(pull.user),
        label: { id: 80 },
        change: {
          before: { alpha: 1, nested: { left: true, right: null } },
          after: { nested: { right: null, left: true }, alpha: 1 },
        },
      },
    });
    assert.deepEqual(triage.facts, []);
    assert.deepEqual(triage.evidence, []);
    assert.equal(triage.observations.length, 1);
    assert.deepEqual(triage.reasons, ["no_op_metadata_change"]);
    triageNoops++;
    return {
      ...output,
      observations: [...output.observations, ...triage.observations],
      reasons: [...output.reasons, ...triage.reasons],
    };
  };
  h.options.triageMetadataNormalizationVersion = triageVersion;
  const runtime = await createPipeline(h.options);
  t.after(() => runtime.stop());
  const cutoff = p.state.clock;
  await assert.rejects(runtime.runOnce(), /synthetic_stop_after_pair_field_merge_freeze/);
  assert.equal(state.frozen, true);
  assert.equal(state.calls, 5);
  assert.equal(triageNoops, 5);
  assert.equal(p.state.graphql, 5);
  const saved = await caches(h.db);
  assert.equal(saved.length, 5);
  for (const row of saved) {
    const marker = row.document.pullRequestMergeTargetNormalization;
    const merge = mergeTargetGenerationSignature(marker.baseSignature, marker.generation, comparisonHash);
    const delivery = comparisonHash([components.github.defaultDeliveryNormalizationVersion, merge]);
    const field = comparisonHash([components.github.fieldChangeNormalizationVersion, delivery]);
    const triage = comparisonHash([triageVersion, field]);
    assert.equal(row.policy_signature, comparisonHash([components.github.relationshipPairNormalizationVersion, triage]));
    assert.equal(row.document.fieldChangeNormalizationVersion, components.github.fieldChangeNormalizationVersion);
    assert.equal(row.document.relationshipPairNormalizationVersion, components.github.relationshipPairNormalizationVersion);
    assert.equal(row.document.triageMetadataNormalizationVersion, triageVersion);
    assert.ok(row.document.facts.some((fact) => fact.metricId === "closing_links" && fact.relationshipPair));
    assert.ok(row.document.facts.some((fact) => fact.metricId === "issue_field_updates"));
    assert.equal(row.document.facts.some((fact) => fact.metricId === "items_triaged"), false);
    assert.ok(row.document.reasons.includes("no_op_metadata_change"));
    const capture = row.document.pullRequestMergeTargets[0];
    assert.equal(capture.status, "known");
    assert.equal(capture.event.mergeRefName, target);
    assert.equal(
      row.document.facts.find((fact) => fact.metricId === "pr_merged").mergeTarget.proofHash,
      capture.proofHash,
    );
  }
  const calls = [...p.state.calls];
  state.forbid = true;
  p.state.forbid = true;
  for (const [name, message] of [
    ["relationshipPairNormalizationVersion", "relationship_pair_normalizer_version_unverified"],
    ["triageMetadataNormalizationVersion", "triage_metadata_normalizer_version_unverified"],
  ]) {
    const version = h.options[name];
    h.options[name] = "obsolete";
    try {
      await assert.rejects(runtime.runOnce(), { message });
      assert.deepEqual(await caches(h.db), saved);
      assert.deepEqual((await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.snapshots")).rows, []);
      assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
    } finally {
      h.options[name] = version;
    }
  }
  const resumed = await runtime.runOnce();
  assert.equal(resumed.state, "published");
  const publication = pairMergePublication(resumed, h);
  const confirmed = h.controlsStore.read().pipelinePublications[publication.snapshotId];
  assert.equal(confirmed.relationshipPairNormalizationVersion, components.github.relationshipPairNormalizationVersion);
  assert.equal(confirmed.triageMetadataNormalizationVersion, triageVersion);
  await assertPairMergeQuantity(runtime, 5);
  await assertPairMergeCapture(h, runtime, publication, saved);
  assert.deepEqual(await caches(h.db), saved);
  assert.deepEqual(p.state.calls, calls);
  assert.equal(state.calls, 5);
  assert.equal(triageNoops, 5);

  // Confirmed immutable reads use saved authority; only new work needs the
  // currently selected provider's declaration.
  const pairVersion = h.options.relationshipPairNormalizationVersion;
  h.options.relationshipPairNormalizationVersion = "obsolete";
  h.options.triageMetadataNormalizationVersion = "obsolete";
  try {
    await assertPairMergeQuantity(runtime, 5);
    await assertPairMergeCapture(h, runtime, publication, saved);
  } finally {
    h.options.relationshipPairNormalizationVersion = pairVersion;
    h.options.triageMetadataNormalizationVersion = triageVersion;
  }
  const board = await runtime.app.inject("/api/v1/boards?" + query());
  assert.equal(board.statusCode, 200, board.body);
  assert.doesNotMatch(board.body, /relationshipPair|triageMetadataNormalizationVersion|pullRequestMergeTargets/);
  const factId = board.json().rows.find((row) => row.actorId === "101").evidenceIds[0];
  const requestId = "11111111-1111-4111-8111-000000455477";
  h.controlsStore.transaction((value) => {
    value.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "101",
      locator: p.payloads[0].html_url,
      status: "pending",
      version: 1,
      createdAt: Date.parse(p.state.clock),
      updatedAt: Date.parse(p.state.clock),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId,
    operatorId: "201",
    approvalReceipt: "synthetic-pair-triage-correction",
  };
  const receipt = await runtime.applyCorrection(decision);
  assert.equal(receipt.status, "applied");
  const correction = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])
  ).rows[0];
  assert.equal(correction.document.fact.state, "excluded");
  assert.equal(Object.hasOwn(correction.document.fact, "mergeTarget"), false);
  assert.deepEqual(await runtime.applyCorrection(decision), receipt);
  assert.deepEqual(await caches(h.db), saved);
  assert.deepEqual(p.state.calls, calls);
  state.forbid = false;
  p.state.forbid = false;
  p.state.clock = iso(Date.parse(p.state.clock) + 5000);
  const fresh = await runtime.runOnce({ cutoff: iso(Date.parse(cutoff) + 2000) });
  assert.equal(fresh.state, "published");
  assert.equal(state.calls, 10);
  assert.equal(triageNoops, 10);
  assert.equal(p.state.graphql, 10);
  const generations = await caches(h.db);
  assert.equal(generations.length, 10);
  for (const old of saved)
    assert.deepEqual(
      generations.find((row) => row.fact_key === old.fact_key && row.policy_signature === old.policy_signature),
      old,
    );
  const current = await runtime.app.inject("/api/v1/boards?" + query());
  assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json().rows.map((row) => row.actorId).sort(), ["102", "103", "104", "105"]);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])).rows[0],
    correction,
  );
});
