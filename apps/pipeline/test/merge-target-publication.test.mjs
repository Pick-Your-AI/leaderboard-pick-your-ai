// Fictional native provider responses, real collector/normalizer/storage/public
// handlers. No socket, GitHub credentials, public deployment or real evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { components, harness, publicScope } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { mergeTargetGenerationSignature } from "../src/pull-request-merge-target.mjs";

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
  const cutoff = iso(Date.now() - 1000);
  await assert.rejects(runtime.runOnce({ cutoff }), /synthetic_stop_after_combined_merge_field_freeze/);
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
  const resumed = await runtime.runOnce({ cutoff });
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
