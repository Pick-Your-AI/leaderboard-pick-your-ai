import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { buildAggregateExplanation, AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { createPipeline } from "../src/index.mjs";
import { normalizationDocumentVersion } from "../src/private-attribution.mjs";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
import { ago, clock, components, harness, publicScope } from "./harness.mjs";
import { insertOperatorDelivery } from "./operator-harness.mjs";
import { assertRetainedSourceGeneration } from "./transfer-cache-generation-fixtures.mjs";

const version = "discussion-answer-chronology/v1";
const slug = "synthetic-org/synthetic-repo";
const actor = (id) => ({ id: `U_SYNTHETIC_${id}`, databaseId: id, login: `synthetic-${id}`, __typename: "User" });
const legacySignature = (config) =>
  comparisonHash([
    "project-membership-context/v1",
    comparisonHash([
      "verified-default-branch-merge-pins/v1",
      comparisonHash([
        normalizationDocumentVersion,
        comparisonHash(["current-state-selection-v1", "synthetic", config.policies.map((entry) => entry.signature)]),
      ]),
    ]),
    [],
  ]);
const currentSignature = (config) => comparisonHash(["github-issue-transfer-admission/v1", legacySignature(config)]);

test("pre-transfer versioned Discussion caches keep frozen public and private authority after restart", async (t) => {
  const h = await discussionHarness(t);
  await assertRetainedSourceGeneration({
    h,
    priorSignature: comparisonHash([version, legacySignature(h.config)]),
    request: previewRequest,
    assertPublic: (runtime, snapshot) => assertAnswer(runtime, 1, snapshot),
    restart,
  });
});

async function discussionHarness(t, extra = {}) {
  const issue = {
    id: 1001,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    html_url: `https://github.com/${slug}/issues/1`,
    created_at: ago(3),
    updated_at: ago(2),
    user: { id: 101, node_id: "U_SYNTHETIC_101", login: "synthetic-101", type: "User" },
  };
  const state = {
    value: {
      id: "D_SYNTHETIC_TIME",
      url: `https://github.com/${slug}/discussions/4`,
      createdAt: ago(3),
      updatedAt: ago(1),
      author: actor(101),
      answerChosenAt: ago(1),
      answerChosenBy: actor(202),
      answer: { id: "DC_SYNTHETIC_TIME", createdAt: ago(2), isAnswer: true, author: actor(303) },
    },
    hydrations: 0,
    fixedRevision: null,
  };
  const githubClient = syntheticRepositoryClient(2, {
    scanRest: async () => {
      assert.fail("this fixture collects through its explicit source reader");
    },
    rest: async (_source, path) => {
      if (path === `/repos/${slug}/issues/1`) return structuredClone(issue);
      assert.equal(path, `/repos/${slug}`);
      return { id: 2, private: false, full_name: slug, default_branch: "main" };
    },
    graphql: async (_source, query) => {
      assert.match(query, /answer\s*\{[^}]*\bcreatedAt\b/);
      state.hydrations++;
      return {
        repository: {
          databaseId: 2,
          isPrivate: false,
          hasDiscussionsEnabled: true,
          discussion: structuredClone(state.value),
        },
      };
    },
  });
  const h = await harness(t, {
    authorizePolicyPreview: async () => true,
    githubClient,
    source: {
      async readPage(request) {
        assert.ok(request.family === "discussions" || (extra.includeIssue && request.family === "issues"));
        const discussion = request.family === "discussions";
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: discussion ? state.value.id : issue.node_id,
              sourceRevision: discussion
                ? (state.fixedRevision ?? components.github.githubDiscussionRevision(state.value))
                : issue.updated_at,
              sourceUrl: discussion ? state.value.url : issue.html_url,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "present",
            },
          ],
        };
      },
    },
    configure(config) {
      const issuePolicy = config.policies[0];
      config.repositories[0].families = extra.includeIssue ? ["issues", "discussions"] : ["discussions"];
      const policy = {
        ...issuePolicy.policy,
        metricId: "discussion_answers",
        unit: components.metrics.getMetricDefinition("discussion_answers").definition.unit,
        roles: ["author"],
        sources: ["github_graphql"],
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-policy" },
      ];
      if (extra.includeIssue) config.policies.push(issuePolicy);
    },
    ...extra,
  });
  return { ...h, state, issue };
}
const previewRequest = (h, snapshotId) => ({
  snapshotId,
  policy: { ...h.config.policies[0].policy, version: "synthetic-discussion-preview", rank: false },
  operatorId: "201",
});
const paths = [
  "/api/v1/boards?metric=discussion_answers",
  "/api/v1/exports?metric=discussion_answers&format=json",
  "/api/v1/exports?metric=discussion_answers&format=csv",
];
async function assertDenied(runtime, snapshotId, current = true) {
  for (const path of paths) {
    if (current) assert.equal((await runtime.app.inject(path)).statusCode, 503, path);
    const response = await runtime.app.inject(`${path}&snapshot=${snapshotId}`);
    assert.equal(response.statusCode, 410, response.body);
    assert.doesNotMatch(response.body, /synthetic-303|D_SYNTHETIC_TIME|normalizationHashes|normalizationSources/);
  }
}
async function assertAnswer(runtime, value, snapshotId = null) {
  const response = await runtime.app.inject(`${paths[0]}${snapshotId ? `&snapshot=${snapshotId}` : ""}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .rows.filter((row) => row.result.value > 0)
      .map((row) => [row.actorId, row.result.value]),
    value ? [["303", value]] : [],
  );
  for (const path of paths) {
    const response = await runtime.app.inject(`${path}${snapshotId ? `&snapshot=${snapshotId}` : ""}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /discussionSourceNormalizationVersion|normalizationHashes|normalizationSources/);
  }
}

// A deliberately pre-upgrade fixture: actual source/cache, SQL frozen input and
// SQLite authorities retain valid hashes, but native Discussion chronology have no version
// assertion. Rebuild the private arithmetic receipt from the same frozen input.
async function retainLegacyDiscussion(h, publication, bindingMode) {
  const row = (
    await h.db.query(
      `SELECT n.* FROM leaderboard_pipeline.normalizations n
       JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family='discussions'`,
    )
  ).rows[0];
  const document = structuredClone(row.document);
  delete document.discussionSourceNormalizationVersion;
  const oldHash = comparisonHash(document);
  const signature = legacySignature(h.config);
  await h.db.query(
    `UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document=$3::jsonb,document_hash=$4
     WHERE fact_key=$1 AND policy_signature=$5`,
    [row.fact_key, signature, JSON.stringify(document), oldHash, row.policy_signature],
  );
  const retainedSources = (
    await h.db.query("SELECT fact_key,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key")
  ).rows.map((source) => ({ factKey: source.fact_key, documentHash: source.document_hash }));
  const replaceBinding = (authorization) => {
    if (bindingMode === "unbound") delete authorization.identityEvidence;
    else {
      authorization.identityEvidence.normalizationHashes = authorization.identityEvidence.normalizationHashes
        .map((hash) => (hash === row.document_hash ? oldHash : hash))
        .sort();
      if (bindingMode === "exact")
        authorization.identityEvidence.normalizationSources = (
          authorization.identityEvidence.normalizationSources ??
          retainedSources.filter((source) =>
            authorization.identityEvidence.normalizationHashes.includes(source.documentHash),
          )
        ).map((source) => (source.factKey === row.fact_key ? { ...source, documentHash: oldHash } : source));
      else delete authorization.identityEvidence.normalizationSources;
    }
  };
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  replaceBinding(frozen.identityAuthorization);
  await h.db.query(
    "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
    [publication.snapshotId, JSON.stringify(frozen), comparisonHash(frozen)],
  );
  const capture = {
    input: frozen.frozen,
    scope: frozen.engineScope,
    policies: frozen.policies.map((entry) => entry.policy),
    aggregates: frozen.policies.map((entry) =>
      components.metrics.aggregateMetric(frozen.frozen, entry.policy, frozen.engineScope),
    ),
    snapshot: { snapshotId: publication.snapshotId, revision: publication.revision },
    authorization: frozen.identityAuthorization,
  };
  const before = new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).document;
  const explanation = buildAggregateExplanation(capture, {
    scopeKey: before.scopeKey,
    computationVersion: before.snapshot.computationVersion,
  });
  const explanationHash = comparisonHash(explanation);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
    .run(JSON.stringify(explanation), explanationHash, publication.snapshotId);
  const oldInput = h.controlsStore.db
    .prepare("SELECT * FROM policy_preview_inputs WHERE id=?")
    .get(publication.comparisonInput.inputId);
  const input = JSON.parse(oldInput.document);
  replaceBinding(input.authorization);
  const inputId = comparisonHash(input);
  h.controlsStore.db
    .prepare("UPDATE policy_preview_inputs SET id=?,document=?,digest=? WHERE id=?")
    .run(inputId, JSON.stringify(input), inputId, oldInput.id);
  const receipt = (
    await h.db.query("SELECT receipt_id,document FROM leaderboard_pipeline.receipts WHERE kind='snapshot_published'")
  ).rows.find((entry) => entry.document.snapshotId === publication.snapshotId);
  receipt.document.comparisonInputHash = comparisonHash(capture);
  await h.db.query("UPDATE leaderboard_pipeline.receipts SET document=$2::jsonb,document_hash=$3 WHERE receipt_id=$1", [
    receipt.receipt_id,
    JSON.stringify(receipt.document),
    comparisonHash(receipt.document),
  ]);
  h.controlsStore.transaction((state) => {
    for (const confirmation of [
      state.pipelinePublications[publication.snapshotId],
      ...Object.values(state.pipelineHeads),
    ]) {
      if (confirmation.snapshotId !== publication.snapshotId) continue;
      delete confirmation.discussionSourceNormalizationVersion;
      confirmation.aggregateExplanationHash = explanationHash;
    }
  });
  assert.equal(new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).digest, explanationHash);
  assert.equal(h.runtime.policyComparisons.comparisons.input(inputId).id, inputId);
  return {
    factKey: row.fact_key,
    signature,
    document,
    documentHash: oldHash,
    inputId,
    authorization: input.authorization,
  };
}

async function restart(h, work) {
  await h.runtime.stop();
  h.controlsStore.close();
  // The common harness cleanup also closes its original handle.
  h.controlsStore.close = () => {};
  await h.reopenDatabase();
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const runtime = await createPipeline({ ...h.options, controlsStore });
  try {
    await work(runtime, controlsStore);
  } finally {
    await runtime.stop();
    controlsStore.close();
  }
}

for (const bindingMode of ["exact", "hash-only", "unbound"]) {
  test(`legacy Discussion ${bindingMode} cache/public/private authority is denied after real database reopen and recovers only from a new source`, async (t) => {
    const h = await discussionHarness(t);
    const cutoff = clock();
    const first = (await h.runtime.runOnce({ cutoff })).publications[0];
    await assertAnswer(h.runtime, 1);
    await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
    const legacy = await retainLegacyDiscussion(h, first, bindingMode);
    const before = (
      await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [first.snapshotId])
    ).rows[0];
    stateFreeze(h);
    h.state.value.answer.createdAt = new Date(Date.parse(h.state.value.answerChosenAt) + 1).toISOString();
    const hydrations = h.state.hydrations;
    await restart(h, async (runtime, controlsStore) => {
      await assertDenied(runtime, first.snapshotId);
      await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), /policy_input_revoked/);
      await assert.rejects(
        runtime.aggregateExplanations.read(first.snapshotId),
        /Frozen Discussion (normalization obsolete|evidence unavailable)/,
      );
      const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
      await assert.rejects(
        runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
          assert.fail("legacy Discussion gained private authority"),
        ),
        /Frozen Discussion (normalization obsolete|evidence unavailable)/,
      );
      controlsStore.transaction((state) => {
        state.pipelinePublications[first.snapshotId].discussionSourceNormalizationVersion = version;
        Object.values(state.pipelineHeads).forEach((head) => {
          head.discussionSourceNormalizationVersion = version;
        });
      });
      await assertDenied(runtime, first.snapshotId);
      const rebuilt = (await runtime.runOnce({ cutoff })).publications[0];
      assert.notEqual(rebuilt.snapshotId, first.snapshotId);
      assert.ok(
        h.state.hydrations > hydrations,
        "unchanged retained source must be rehydrated instead of reusing an old cache",
      );
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n,
        1,
      );
      await assertAnswer(runtime, 0);
      await assertDenied(runtime, first.snapshotId, false);
      await runtime.previewPolicy(previewRequest(h, rebuilt.snapshotId));
      const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
        .rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.find((row) => row.policy_signature === legacy.signature).document, legacy.document);
      assert.equal(rows.find((row) => row.policy_signature === legacy.signature).document_hash, legacy.documentHash);
      const current = rows.find((row) => row.policy_signature !== legacy.signature);
      assert.equal(current.policy_signature, comparisonHash([version, currentSignature(h.config)]));
      assert.equal(current.document.discussionSourceNormalizationVersion, version);
      assert.equal(
        current.document.facts.some((fact) => fact.metricId === "discussion_answers"),
        false,
      );
      assert.deepEqual(
        (
          await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
            first.snapshotId,
          ])
        ).rows[0],
        before,
      );
      h.state.fixedRevision = null;
      h.state.value.answer.createdAt = ago(2);
      h.state.value.answerChosenAt = ago(1);
      const recovered = (await runtime.runOnce()).publications[0];
      await assertAnswer(runtime, 1);
      await assertAnswer(runtime, 1, recovered.snapshotId);
      await runtime.previewPolicy(previewRequest(h, recovered.snapshotId));
      await assertDenied(runtime, first.snapshotId, false);
    });
  });
}
function stateFreeze(h) {
  h.state.fixedRevision = components.github.githubDiscussionRevision(h.state.value);
}

test("unrelated issue publications retain their original bytes, cache generation and private input across restart", async (t) => {
  const h = await harness(t, { authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const response = (await h.runtime.app.inject("/api/v1/boards?metric=issues_opened")).body;
  const privateBefore = await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
  const caches = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.ok(
    caches.every(
      (row) =>
        row.policy_signature === currentSignature(h.config) &&
        row.document.discussionSourceNormalizationVersion === undefined,
    ),
  );
  await restart(h, async (runtime) => {
    assert.equal((await runtime.app.inject("/api/v1/boards?metric=issues_opened")).body, response);
    assert.deepEqual(await runtime.previewPolicy(previewRequest(h, first.snapshotId)), privateBefore);
    assert.equal((await runtime.runOnce({ cutoff })).publications[0].snapshotId, first.snapshotId);
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
      caches,
    );
  });
});

for (const mode of ["normalizer", "enrichment"]) {
  test(`custom Discussion ${mode} requires an explicit chronology assertion before any cache reuse or call`, async (t) => {
    let h,
      calls = 0;
    const extra =
      mode === "normalizer"
        ? {
            normalizer: async () => {
              calls++;
              return { facts: [], actors: [], evidence: [] };
            },
          }
        : {
            githubEnrich: async (input) => {
              calls++;
              return {
                repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
                proof: {
                  verified: true,
                  source: "github_graphql",
                  revision: input.fact.sourceRevision,
                  isSynthetic: true,
                },
                family: "discussion",
                observedAt: input.observedAt,
                payload: structuredClone(h.state.value),
                discussionAnswerSelection: { verified: true },
              };
            },
          };
    h = await discussionHarness(t, extra);
    await assert.rejects(h.runtime.runOnce(), /discussion_normalizer_version_unverified/);
    assert.equal(calls, 0);
    const checked = await createPipeline({ ...h.options, discussionSourceNormalizationVersion: version });
    try {
      assert.equal((await checked.runOnce()).state, "published");
      assert.equal(calls, 1);
      assert.equal(
        (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows[0].document
          .discussionSourceNormalizationVersion,
        version,
      );
      if (mode === "enrichment") await assertAnswer(checked, 1);
      await assert.rejects(h.runtime.runOnce(), /discussion_normalizer_version_unverified/);
      assert.equal(calls, 1, "an existing current-generation cache cannot bypass the provider assertion");
    } finally {
      await checked.stop();
    }
  });
}

test("Discussion public selected and current-head views bind exact frozen scope, source and chronology generation", async (t) => {
  const h = await discussionHarness(t);
  const first = (await h.runtime.runOnce()).publications[0];
  h.state.value.answerChosenAt = ago(0.5);
  const head = (await h.runtime.runOnce()).publications[0];
  const saved = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
  ).rows[0];
  const replace = (id, doc, hash = comparisonHash(doc)) =>
    h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [id, JSON.stringify(doc), hash],
    );
  for (const mutate of [
    (doc) => {
      doc.scope = { ...publicScope, repository: "2" };
    },
    (doc) => {
      doc.frozen.datasetId = "synthetic-other-dataset";
    },
    (doc) => {
      doc.frozen.cutoff = ago(1);
    },
    (doc) => {
      doc.frozen.backfillRevision = "f".repeat(64);
    },
    (doc) => {
      doc.identityAuthorization.identityEvidence.normalizationSources[0].factKey = "e".repeat(64);
    },
    (doc) => {
      doc.identityAuthorization.sources[0].generation = "999";
    },
  ]) {
    const changed = structuredClone(saved.document);
    mutate(changed);
    await replace(first.snapshotId, changed);
    await assert.rejects(
      h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal),
      /public_discussion_frozen_input_integrity_error/,
    );
    await assertAnswer(h.runtime, 1);
    await replace(first.snapshotId, saved.document, saved.document_hash);
  }
  const savedHead = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [head.snapshotId])
  ).rows[0];
  await replace(head.snapshotId, saved.document, savedHead.document_hash);
  await assert.rejects(
    h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal),
    /public_discussion_frozen_input_integrity_error/,
  );
  await replace(head.snapshotId, savedHead.document, savedHead.document_hash);
  await assertAnswer(h.runtime, 1, first.snapshotId);
});

test("an interrupted dispatch cannot acknowledge a legacy Discussion publication or rewind its verified replacement", async (t) => {
  const h = await discussionHarness(t, { includeIssue: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertOperatorDelivery(h, 711, h.issue.created_at);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic loss before acknowledgment");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic loss before acknowledgment");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic loss before acknowledgment/);
  const saved = (await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.snapshots")).rows[0];
  const input = h.controlsStore.db
    .prepare("SELECT id,document FROM policy_preview_inputs")
    .all()
    .find((row) => JSON.parse(row.document).snapshot.snapshotId === saved.snapshot_id);
  const first = {
    snapshotId: saved.snapshot_id,
    revision: Number(saved.revision),
    comparisonInput: { inputId: input.id },
  };
  await retainLegacyDiscussion(h, first, "exact");
  const operation = (await h.db.query("SELECT event_key,operation FROM leaderboard_ingestion.outbox")).rows[0];
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  await restart(h, async (runtime) => {
    await assertDenied(runtime, first.snapshotId);
    assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
    const pending = (
      await h.db.query("SELECT state,completion,operation FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
        operation.event_key,
      ])
    ).rows[0];
    assert.equal(pending.state, "pending");
    assert.equal(pending.completion, null);
    assert.deepEqual(pending.operation, operation.operation);
    const recovery = (await runtime.runOnce()).publications[0];
    assert.notEqual(recovery.snapshotId, first.snapshotId);
    await assertAnswer(runtime, 1);
    await assertDenied(runtime, first.snapshotId, false);
    await h.db.query(
      "UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()+interval '1 hour' WHERE event_key=$1",
      [operation.event_key],
    );
    await insertOperatorDelivery({ ...h, runtime }, 712, h.issue.created_at);
    assert.equal(await runtime.inbox.complete(await runtime.inbox.claim()), true);
    assert.equal(await runtime.dispatchOnce(), "processed");
    const done = (await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox WHERE state='done'")).rows[0];
    assert.ok(done.completion.publications.every((publication) => publication.snapshotId !== first.snapshotId));
    await assertAnswer(runtime, 1);
  });
});
