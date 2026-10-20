// Fictional native provider responses, real collector/normalizer/storage/public
// handlers. No socket, GitHub credentials, public deployment or real evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { components, harness, publicScope } from "./harness.mjs";
import { createPipeline } from "../src/runtime.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { mergeTargetGenerationSignature, mergeTargetNormalizationVersion } from "../src/pull-request-merge-target.mjs";

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

const triageVersion = components.github.triageMetadataNormalizationVersion;
const fieldVersion = components.github.fieldChangeNormalizationVersion;
const deliveryVersion = components.github.defaultDeliveryNormalizationVersion;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = /triage_metadata_normalizer_version_unverified/;

function metadataOutput(input, pull, family) {
  return components.github.normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public" },
    proof: {
      verified: true,
      source: "github_rest",
      revision: input.fact.sourceRevision,
      eventId: "synthetic-merge-" + family + "-" + pull.number,
      isSynthetic: true,
    },
    family,
    action: family === "triage" ? "unlabeled" : "issue_field_changed",
    occurredAt: pull.merged_at,
    observedAt: input.observedAt,
    payload: {
      pull_request: structuredClone(pull),
      sender: structuredClone(pull.user),
      label: { id: 80 },
      change:
        family === "triage"
          ? {
              before: { alpha: 1, nested: { left: true, right: null } },
              after: { nested: { right: null, left: true }, alpha: 1 },
            }
          : { before: { state: "open" }, after: { state: "closed" } },
    },
  });
}
function combine(output, additional) {
  return {
    ...output,
    facts: [...output.facts, ...additional.facts],
    actors: [...new Map([...output.actors, ...additional.actors].map((actor) => [actor.id, actor])).values()],
    evidence: [...output.evidence, ...additional.evidence],
    observations: [...output.observations, ...additional.observations],
    reasons: [...output.reasons, ...additional.reasons],
  };
}
async function setup(t, { includeField = false, faultAfterFreeze = true } = {}) {
  const p = provider(true);
  const custom = { calls: 0, triageNoops: 0 };
  const h = await harness(t, {
    memoryDatabase: true,
    payloads: p.payloads,
    githubClient: p.client,
    now: p.now,
    defaultDeliveryNormalizationVersion: deliveryVersion,
    fieldChangeNormalizationVersion: fieldVersion,
    triageMetadataNormalizationVersion: triageVersion,
    pullRequestMergeTargetNormalizationVersion: components.github.pullRequestMergeTargetNormalizationVersion,
    probeRepository: async () => ({ repositoryId: 2, installationId: 1, visibility: "public", checkedAt: p.now() }),
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.scopes = [plain, scope];
      config.policies = ["pr_opened", "pr_merged"].map((metricId) => {
        const value = policy(metricId);
        return {
          policy: value,
          signature: components.metrics.stableJSON(value),
          approvalReceipt: "synthetic-merge-triage-policy",
        };
      });
    },
    normalizerFactory(options) {
      const normalize = components.github.createGithubEvidenceNormalizer({
        client: p.client,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        assertAuthorized: () => assert.equal(options.dataMode, "synthetic"),
        pullRequestMergeTargetRepositoryIds: [2],
        now: p.now,
      });
      return async (input) => {
        custom.calls++;
        let output = await normalize(input);
        const pull = p.payloads.find((entry) => entry.node_id === input.fact.subjectId);
        assert.ok(pull);
        const triage = metadataOutput(input, pull, "triage");
        assert.deepEqual(triage.facts, [], "the real comparator excludes the reordered equal metadata");
        assert.deepEqual(triage.evidence, []);
        assert.equal(triage.observations.length, 1);
        assert.ok(triage.reasons.includes("no_op_metadata_change"));
        custom.triageNoops++;
        output = combine(output, triage);
        if (includeField) {
          const field = metadataOutput(input, pull, "field_change");
          assert.deepEqual(
            field.facts.map((fact) => fact.metricId),
            ["issue_field_updates"],
          );
          output = combine(output, field);
        }
        return output;
      };
    },
  });
  await h.runtime.stop();
  const faults = { afterFreeze: faultAfterFreeze, frozen: false };
  const run = async (query, sql, params) => {
    if (sql.includes("UPDATE leaderboard_pipeline.scan_continuations SET observation_cutoff")) faults.frozen = true;
    if (
      faults.afterFreeze &&
      faults.frozen &&
      sql.startsWith("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access")
    ) {
      faults.afterFreeze = false;
      throw new Error("synthetic_stop_after_merge_triage_capture_freeze");
    }
    return query(sql, params);
  };
  const db = {
    query: (sql, params) => run(h.db.query.bind(h.db), sql, params),
    transaction: (work) =>
      h.db.transaction((tx) => work({ query: (sql, params) => run(tx.query.bind(tx), sql, params) })),
  };
  const live = { ...h.options, db };
  const runtime = await createPipeline(live);
  t.after(() => runtime.stop());
  return { h, p, runtime, live, custom, faults, includeField };
}
const caches = (h) =>
  h.db
    .query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations WHERE document ? 'pullRequestMergeTargetNormalization' ORDER BY fact_key,policy_signature",
    )
    .then((result) => result.rows);
const readScope = (runtime, selected = scope) => runtime.source.read(selected, null, new AbortController().signal);
function assertMixedRows(rows, includeField) {
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const marker = row.document.pullRequestMergeTargetNormalization;
    assert.equal(marker.schemaVersion, mergeTargetNormalizationVersion);
    const merge = mergeTargetGenerationSignature(marker.baseSignature, marker.generation, digest);
    let signature = digest([deliveryVersion, merge]);
    if (includeField) signature = digest([fieldVersion, signature]);
    assert.equal(row.policy_signature, digest([triageVersion, signature]));
    assert.equal(row.document.triageMetadataNormalizationVersion, triageVersion);
    assert.equal(row.document.fieldChangeNormalizationVersion, includeField ? fieldVersion : undefined);
    assert.ok(row.document.reasons.includes("no_op_metadata_change"));
    assert.equal(
      row.document.facts.some((fact) => fact.metricId === "items_triaged"),
      false,
    );
    assert.equal(
      row.document.facts.some((fact) => fact.metricId === "issue_field_updates"),
      includeField,
    );
    const capture = row.document.pullRequestMergeTargets[0];
    assert.equal(capture.status, "known");
    assert.equal(capture.event.mergeRefName, target);
    assert.equal(
      row.document.facts.find((fact) => fact.metricId === "pr_merged").mergeTarget.proofHash,
      capture.proofHash,
    );
  }
}
async function freeze(fixture) {
  const { h, p, runtime, custom, faults, includeField } = fixture;
  await assert.rejects(runtime.runOnce(), /synthetic_stop_after_merge_triage_capture_freeze/);
  assert.equal(faults.frozen, true);
  const before = await caches(h);
  assertMixedRows(before, includeField);
  assert.equal(p.state.graphql, 5);
  assert.equal(custom.calls, 5);
  assert.equal(custom.triageNoops, 5);
  const calls = [...p.state.calls];
  p.state.forbid = true;
  return { before, calls };
}
async function assertPublished(fixture, completed) {
  const { h, runtime } = fixture;
  assert.equal(completed.state, "published");
  const board = await runtime.app.inject("/api/v1/boards?" + query());
  assert.equal(board.statusCode, 200, board.body);
  assert.equal(board.json().rows.length, 5);
  const head = h.controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(scope)];
  assert.ok(head);
  const publication = completed.publications.find((entry) => entry.snapshotId === head.snapshotId);
  assert.ok(publication);
  assert.equal(publication.comparisonInput.state, "retained");
  assert.equal(publication.triageMetadataNormalizationVersion, triageVersion);
  assert.equal((await readScope(runtime)).selected.rows.length, 5);
  return { publication, board };
}
async function assertPrivateReplay(fixture, publication) {
  const { runtime } = fixture;
  const comparisons = runtime.policyComparisons.comparisons;
  const record = comparisons.input(publication.comparisonInput.inputId);
  let reached = false;
  const value = await runtime.policyComparisons.withAuthorizedInputs(
    [record.authorization],
    async (_removed, authority) => {
      reached = true;
      const restored = authority.restoreInput(structuredClone(record.input), record.authorization);
      const merged = restored.facts.filter((fact) => fact.metricId === "pr_merged" && fact.state !== "excluded");
      assert.equal(merged.length, 5);
      assert.ok(merged.every((fact) => fact.mergeTarget?.branch === target));
      assert.equal(
        restored.facts.some((fact) => fact.metricId === "issue_field_updates"),
        fixture.includeField,
      );
      return "authorized-real-frozen-input";
    },
  );
  assert.equal(reached, true);
  assert.equal(value, "authorized-real-frozen-input");
}
async function assertCorrection(fixture, board) {
  const { h, p, runtime } = fixture;
  const factId = board.json().rows.find((row) => row.actorId === "101").evidenceIds[0];
  const requestId = "11111111-1111-4111-8111-000000000075";
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
    factId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  const receipt = await runtime.applyCorrection(decision);
  assert.equal(receipt.status, "applied");
  const retained = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])
  ).rows[0];
  assert.equal(retained.document.fact.state, "excluded");
  assert.equal(Object.hasOwn(retained.document.fact, "mergeTarget"), false);
  assert.deepEqual(await runtime.applyCorrection(decision), receipt);
}
for (const includeField of [false, true]) {
  test(
    includeField
      ? "M plus field and triage generations survive cached frozen public and private reads"
      : "M plus triage no-op generation survives cached frozen reads and correction selection",
    async (t) => {
      const fixture = await setup(t, { includeField });
      const { h, p, runtime, live, custom } = fixture;
      const frozen = await freeze(fixture);
      const completed = await runtime.runOnce();
      const { publication, board } = await assertPublished(fixture, completed);
      assert.deepEqual(await caches(h), frozen.before);
      assert.deepEqual(p.state.calls, frozen.calls);
      assert.equal(custom.calls, 5, "frozen retry must reuse compatible M/T caches");
      await assertPrivateReplay(fixture, publication);
      // A confirmed immutable capture does not borrow a new provider declaration.
      live.triageMetadataNormalizationVersion = "triage-metadata-json-values/obsolete";
      assert.equal((await readScope(runtime)).selected.rows.length, 5);
      await assertPrivateReplay(fixture, publication);
      live.triageMetadataNormalizationVersion = triageVersion;
      if (!includeField) await assertCorrection(fixture, board);
      assert.deepEqual(await caches(h), frozen.before);
      assert.deepEqual(p.state.calls, frozen.calls);
    },
  );
}
test("an obsolete selected triage declaration blocks frozen merge confirmation and recovers from the same caches", async (t) => {
  const fixture = await setup(t);
  const { h, p, runtime, live, custom } = fixture;
  const frozen = await freeze(fixture);
  live.triageMetadataNormalizationVersion = "triage-metadata-json-values/obsolete";
  await assert.rejects(runtime.runOnce(), unavailable);
  assert.deepEqual(await caches(h), frozen.before);
  assert.deepEqual((await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.snapshots")).rows, []);
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  assert.deepEqual(p.state.calls, frozen.calls);
  live.triageMetadataNormalizationVersion = triageVersion;
  await assertPublished(fixture, await runtime.runOnce());
  assert.deepEqual(await caches(h), frozen.before);
  assert.deepEqual(p.state.calls, frozen.calls);
  assert.equal(custom.calls, 5);
});
