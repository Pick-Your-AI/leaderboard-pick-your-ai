// Synthetic compatibility fixtures only. The published registry and its UI
// enablement remain unchanged; SQL databases here are always in memory.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createPublicationWindowIndex } from "../src/publication-window-index.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore, buildAggregateExplanation } from "../src/aggregate-explanations.mjs";
import { createPipeline } from "../src/index.mjs";
import { components, harness, ago, clock, publicScope, fixtureId } from "./harness.mjs";
import { currentSignature, paths, previewRequest, assertMetric, assertDenied } from "./default-delivery-fixtures.mjs";
import { operatorAllow, operatorSettings, queueOperatorReplay } from "./operator-harness.mjs";

const version = "triage-metadata-json-values/v1";
const actions = {
  unlabeled: "items_triaged",
  labeled: "labels_applied",
  assigned: "assignments_coordinated",
  milestoned: "milestones_curated",
  label_edited: "label_taxonomy",
  milestone_edited: "milestone_definitions",
  locked: "public_moderation",
};
const slug = "synthetic-org/synthetic-repo";
const actor = { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" };

async function triageHarness(t, action = "unlabeled", extra = {}) {
  const {
    configure: configureExtra,
    sourceFamily = "issues",
    includeIssueCreation = false,
    includeFieldChange = false,
    onlyMetric = false,
    ...options
  } = extra;
  const at = ago(2);
  const definition = action.startsWith("label_") ? "label" : action.startsWith("milestone_") ? "milestone" : null;
  // Collection retains an admitted issue coordinate. The explicit synthetic
  // enrichment can describe a separate definition; this does not add a native
  // definition collector or enable a selectable registry view.
  const subjectId = "SYNTHETIC_ISSUE_1";
  const sourceUrl = "https://github.com/" + slug + "/issues/1";
  const state = { before: { alpha: 1, beta: 2 }, after: { alpha: 1, beta: 3 }, revision: at, hydrations: 0 };
  const issue = {
    id: 1001,
    node_id: "SYNTHETIC_ISSUE_1",
    number: 1,
    html_url: "https://github.com/" + slug + "/issues/1",
    user: actor,
    created_at: at,
    updated_at: at,
    state: "open",
  };
  const target = {
    id: 81,
    node_id: definition ? "SYNTHETIC_" + definition.toUpperCase() + "_1" : subjectId,
    html_url: definition
      ? "https://github.com/" + slug + (definition === "label" ? "/labels/synthetic" : "/milestone/1")
      : sourceUrl,
  };
  const envelope = (input, family = "triage") => ({
    repository: { id: 2, slug, visibility: "public" },
    proof: {
      verified: true,
      source: "github_rest",
      revision: input.fact.sourceRevision,
      eventId: "synthetic-" + family + "-event",
      isSynthetic: true,
    },
    family,
    action: family === "triage" ? action : family === "field_change" ? "issue_field_changed" : "opened",
    occurredAt: at,
    observedAt: input.observedAt,
    payload:
      family === "triage"
        ? {
            ...(definition ? { [definition]: target } : { issue }),
            sender: actor,
            ...(!definition
              ? {
                  label: { id: 80 },
                  assignee: { id: 202, node_id: "U_SYNTHETIC_B", login: "synthetic-bob", type: "User" },
                  milestone: { id: 82 },
                }
              : {}),
            change: structuredClone({ before: state.before, after: state.after }),
          }
        : family === "field_change"
          ? { issue, sender: actor, change: { before: { status: "open" }, after: { status: "closed" } } }
          : { issue, sender: actor },
  });
  const enrich = async (input) => {
    state.hydrations++;
    assert.equal(input.family, sourceFamily);
    return envelope(input);
  };
  const custom = includeIssueCreation || includeFieldChange || onlyMetric;
  const h = await harness(t, {
    memoryDatabase: true,
    authorizePolicyPreview: async () => true,
    ...(sourceFamily === "reviews"
      ? { reviewSourceNormalizationVersion: components.github.reviewSourceNormalizationVersion }
      : {}),
    githubEnrich: enrich,
    payloads: [issue],
    source: {
      async readPage(request) {
        assert.equal(request.family, sourceFamily);
        return {
          repositoryId: 2,
          visibility: "public",
          isSynthetic: true,
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId,
              sourceRevision: state.revision,
              sourceUrl,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "present",
            },
          ],
        };
      },
    },
    ...(custom
      ? {
          triageMetadataNormalizationVersion: version,
          ...(includeFieldChange
            ? { fieldChangeNormalizationVersion: components.github.fieldChangeNormalizationVersion }
            : {}),
          normalizerFactory: (provider) => {
            const builtin = components.github.createGithubEvidenceNormalizer({
              client: provider.githubClient,
              source: provider.sourceId,
              allowedRepositoryIds: [2],
              isSynthetic: true,
              enrich,
            });
            return async (input) => {
              let output = await builtin(input);
              if (onlyMetric) {
                const facts = output.facts.filter((fact) => fact.metricId === actions[action]);
                const ids = new Set(facts.map((fact) => fact.id));
                output = {
                  ...output,
                  facts,
                  evidence: output.evidence.filter((entry) => ids.has(entry.contribution.contributionId)),
                };
              }
              for (const family of [
                ...(includeFieldChange ? ["field_change"] : []),
                ...(includeIssueCreation ? ["issue"] : []),
              ]) {
                const additional = components.github.normalizeGithubObservation(envelope(input, family));
                output = {
                  ...output,
                  facts: [...output.facts, ...additional.facts],
                  actors: [
                    ...new Map([...output.actors, ...additional.actors].map((entry) => [entry.id, entry])).values(),
                  ],
                  evidence: [...output.evidence, ...additional.evidence],
                };
              }
              return output;
            };
          },
        }
      : {}),
    ...options,
    configure(config) {
      const issuePolicy = config.policies[0];
      config.repositories[0].families = [sourceFamily];
      const metricId = actions[action];
      const grouping = components.metrics.getMetricGroupingPolicy(metricId);
      const policy = {
        ...issuePolicy.policy,
        metricId,
        unit: components.metrics.getMetricDefinition(metricId).definition.unit,
        roles: ["triager"],
        sources: ["github_rest"],
        rank: false,
        ...(grouping
          ? {
              dateBasis: grouping.date_basis,
              rankedStates: [grouping.state],
              groupBy: grouping.group_by,
              groupingSeconds: grouping.grouping_seconds,
              groupingPolicyVersion: grouping.version,
            }
          : {}),
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-triage-policy" },
      ];
      if (includeFieldChange) {
        const field = {
          ...issuePolicy.policy,
          metricId: "issue_field_updates",
          unit: components.metrics.getMetricDefinition("issue_field_updates").definition.unit,
          roles: ["triager"],
          rank: false,
        };
        config.policies.push({
          policy: field,
          signature: components.metrics.stableJSON(field),
          approvalReceipt: "synthetic-field-policy",
        });
      }
      if (includeIssueCreation) config.policies.push(issuePolicy);
      configureExtra?.(config);
    },
  });
  assert.equal(h.options.memoryDatabase, true);
  return { ...h, state, sourceFamily, subjectId, sourceUrl, at, metric: actions[action], enrich };
}

// The SQL engine remains the same in-memory instance. Only the runtime and the
// real SQLite connection reopen; no case here claims a file-backed SQL reopen.
async function restartRuntime(h, work, extra = {}) {
  await h.runtime.stop();
  h.controlsStore.close();
  h.controlsStore.close = () => {};
  const controlsStore = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const runtime = await createPipeline({ ...h.options, controlsStore, ...extra });
  try {
    await work(runtime, controlsStore);
  } finally {
    await runtime.stop();
    controlsStore.close();
  }
}

const equalJSONValues = (h) => {
  h.state.after = { beta: 2, alpha: 1 };
};
const sourceRow = async (h) =>
  (
    await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE family=$1 AND document->>'subjectId'=$2", [
      h.sourceFamily,
      h.subjectId,
    ])
  ).rows[0];
const caches = async (h) =>
  (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature")).rows;
const triageRows = (rows) => rows.filter((row) => row.document.triageMetadataNormalizationVersion === version);
async function assertTriage(runtime, metric, value, snapshot = null) {
  await assertMetric(runtime, metric, value, snapshot);
  for (const path of paths(metric))
    assert.doesNotMatch(
      (await runtime.app.inject(path + (snapshot ? "&snapshot=" + snapshot : ""))).body,
      /triageMetadataNormalizationVersion|normalizationSources|normalizationHashes/,
    );
}

// Reconstruct an integrity-valid pre-upgrade fixture, including its SQL and
// SQLite authorities. These explicit fixture writes never run in production.
async function retainLegacyTriage(h, publication, bindingMode, legacyDelivery = false) {
  const row = (
    await h.db.query(
      `SELECT n.* FROM leaderboard_pipeline.normalizations n
       JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family=$1 AND f.document->>'subjectId'=$2`,
      [h.sourceFamily, h.subjectId],
    )
  ).rows[0];
  const document = structuredClone(row.document);
  delete document.triageMetadataNormalizationVersion;
  if (legacyDelivery)
    document.defaultDeliveryNormalizationVersion = components.github.defaultDeliveryNormalizationVersion;
  const oldHash = comparisonHash(document);
  const ordinarySignature =
    h.sourceFamily === "reviews"
      ? comparisonHash([components.github.reviewSourceNormalizationVersion, currentSignature(h.config)])
      : currentSignature(h.config);
  let signature = legacyDelivery
    ? comparisonHash([components.github.defaultDeliveryNormalizationVersion, ordinarySignature])
    : ordinarySignature;
  if (document.fieldChangeNormalizationVersion === components.github.fieldChangeNormalizationVersion)
    signature = comparisonHash([components.github.fieldChangeNormalizationVersion, signature]);
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
  let explanationHash, input, inputId;
  if (publication.comparisonInput) {
    const before = new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).document;
    const explanation = buildAggregateExplanation(capture, {
      scopeKey: before.scopeKey,
      computationVersion: before.snapshot.computationVersion,
    });
    explanationHash = comparisonHash(explanation);
    h.controlsStore.db
      .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
      .run(JSON.stringify(explanation), explanationHash, publication.snapshotId);
    const oldInput = h.controlsStore.db
      .prepare("SELECT * FROM policy_preview_inputs WHERE id=?")
      .get(publication.comparisonInput.inputId);
    input = JSON.parse(oldInput.document);
    replaceBinding(input.authorization);
    inputId = comparisonHash(input);
    h.controlsStore.db
      .prepare("UPDATE policy_preview_inputs SET id=?,document=?,digest=? WHERE id=?")
      .run(inputId, JSON.stringify(input), inputId, oldInput.id);
  }
  const receipt = (
    await h.db.query("SELECT receipt_id,document FROM leaderboard_pipeline.receipts WHERE kind='snapshot_published'")
  ).rows.find((entry) => entry.document.snapshotId === publication.snapshotId);
  receipt.document.comparisonInputHash = comparisonHash(capture);
  await h.db.query("UPDATE leaderboard_pipeline.receipts SET document=$2::jsonb,document_hash=$3 WHERE receipt_id=$1", [
    receipt.receipt_id,
    JSON.stringify(receipt.document),
    comparisonHash(receipt.document),
  ]);
  if (publication.comparisonInput) {
    h.controlsStore.transaction((state) => {
      for (const confirmation of [
        state.pipelinePublications[publication.snapshotId],
        ...Object.values(state.pipelineHeads),
      ]) {
        if (confirmation.snapshotId !== publication.snapshotId) continue;
        delete confirmation.triageMetadataNormalizationVersion;
        confirmation.aggregateExplanationHash = explanationHash;
      }
    });
    assert.equal(new AggregateExplanationStore(h.controlsStore).read(publication.snapshotId).digest, explanationHash);
    assert.equal(h.runtime.policyComparisons.comparisons.input(inputId).id, inputId);
  }
  return {
    factKey: row.fact_key,
    signature,
    document,
    documentHash: oldHash,
    inputId,
    authorization: input?.authorization ?? frozen.identityAuthorization,
  };
}

test("fresh empty triage output keeps a versioned cache and reuses it without hydration", async (t) => {
  const h = await triageHarness(t);
  equalJSONValues(h);
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const rows = await caches(h);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document.triageMetadataNormalizationVersion, version);
  assert.equal(rows[0].policy_signature, comparisonHash([version, currentSignature(h.config)]));
  assert.deepEqual(rows[0].document.facts, []);
  assert.ok(rows[0].document.reasons.includes("no_op_metadata_change"));
  assert.equal(h.state.hydrations, 1);
  await assertTriage(h.runtime, h.metric, 0, first.snapshotId);
  const repeated = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(repeated.snapshotId, first.snapshotId);
  assert.equal(h.state.hydrations, 1);
  assert.deepEqual(await caches(h), rows);
});

// The first publication supplies a real, valid changed-triage document. The
// explicit fixture below models its preceding unversioned authority. Equal
// values are then supplied for the SAME immutable collected observation. The
// separate source-semantic regression proves the historical comparator defect;
// this suite proves migration and retained-view behavior without forging logs.
for (const bindingMode of ["exact", "hash-only", "unbound"])
  for (const legacyDelivery of [false])
    test(
      "triage history survives runtime and SQLite reopen with retained in-memory SQL; binding=" +
        bindingMode +
        "; old-delivery=" +
        legacyDelivery,
      async (t) => {
        const h = await triageHarness(t);
        const cutoff = clock();
        const first = (await h.runtime.runOnce({ cutoff })).publications[0];
        await assertTriage(h.runtime, h.metric, 1);
        const legacy = await retainLegacyTriage(h, first, bindingMode, legacyDelivery);
        const originalSource = await sourceRow(h);
        const originalCache = (await caches(h)).find((row) => row.policy_signature === legacy.signature);
        const originalFrozen = (
          await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
        ).rows[0];
        const originalSnapshot = (
          await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [first.snapshotId])
        ).rows[0];
        const count = h.state.hydrations;
        equalJSONValues(h);
        await restartRuntime(h, async (runtime, controlsStore) => {
          await assertDenied(runtime, h.metric, first.snapshotId);
          await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), /policy_input_revoked/);
          await assert.rejects(
            runtime.aggregateExplanations.read(first.snapshotId),
            /Frozen (triage.metadata|normalization).* (obsolete|unavailable)/,
          );
          const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
          await assert.rejects(
            runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
              assert.fail("obsolete private triage facts reached the manager"),
            ),
            /Frozen (triage.metadata|normalization).* (obsolete|unavailable)/,
          );
          // A current-looking confirmation never upgrades its retained old input.
          controlsStore.transaction((state) => {
            for (const value of [state.pipelinePublications[first.snapshotId], ...Object.values(state.pipelineHeads)])
              if (value.snapshotId === first.snapshotId) value.triageMetadataNormalizationVersion = version;
          });
          await assertDenied(runtime, h.metric, first.snapshotId);
          const fresh = (await runtime.runOnce({ cutoff })).publications[0];
          assert.notEqual(fresh.snapshotId, first.snapshotId);
          assert.equal(h.state.hydrations, count + 1, "the same collected row must be freshly normalized once");
          assert.deepEqual(await sourceRow(h), originalSource);
          assert.equal(
            (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n,
            1,
          );
          await assertTriage(runtime, h.metric, 0);
          await assertTriage(runtime, h.metric, 0, fresh.snapshotId);
          await assertDenied(runtime, h.metric, first.snapshotId, false);
          const all = await caches(h),
            current = triageRows(all);
          assert.equal(all.length, 2);
          assert.deepEqual(
            all.find((row) => row.policy_signature === legacy.signature),
            originalCache,
          );
          assert.equal(current.length, 1);
          assert.equal(current[0].policy_signature, comparisonHash([version, legacy.signature]));
          assert.deepEqual(current[0].document.facts, []);
          assert.equal(current[0].document_hash, comparisonHash(current[0].document));
          assert.ok(current[0].document.reasons.includes("no_op_metadata_change"));
          assert.deepEqual(
            (
              await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
                first.snapshotId,
              ])
            ).rows[0],
            originalFrozen,
          );
          assert.deepEqual(
            (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [first.snapshotId]))
              .rows[0],
            originalSnapshot,
          );
          const preview = await runtime.previewPolicy(previewRequest(h, fresh.snapshotId));
          await runtime.aggregateExplanations.read(fresh.snapshotId);
          const repeated = (await runtime.runOnce({ cutoff })).publications[0];
          assert.equal(repeated.snapshotId, fresh.snapshotId);
          assert.equal(
            h.state.hydrations,
            count + 1,
            "a corrected empty generation must not fall back to the positive predecessor",
          );
          assert.deepEqual(await caches(h), all);
          assert.deepEqual(await runtime.previewPolicy(previewRequest(h, fresh.snapshotId)), preview);
          // A genuine new source revision can recover exactly one observed fact.
          h.state.after = { beta: 3, alpha: 1 };
          h.state.revision = h.state.revision + "-real-change";
          const recovered = (await runtime.runOnce()).publications[0];
          await assertTriage(runtime, h.metric, 1, recovered.snapshotId);
          await assertDenied(runtime, h.metric, first.snapshotId, false);
        });
      },
    );

for (const action of Object.keys(actions).filter((name) => name !== "unlabeled"))
  test(action + ": every triage metric checks its actual cross-family retained claims", async (t) => {
    const h = await triageHarness(t, action, { onlyMetric: true });
    const initial = await h.runtime.runOnce();
    assert.equal(initial.state, "published");
    assert.equal(initial.publications.length, 1);
    const first = initial.publications[0];
    await assertTriage(h.runtime, h.metric, 1);
    const normalized = (await caches(h))[0].document;
    assert.deepEqual([...new Set(normalized.facts.map((fact) => fact.metricId))], [h.metric]);
    if (["label_edited", "milestone_edited"].includes(action)) {
      const definition = action === "label_edited" ? "label" : "milestone";
      const id = "SYNTHETIC_" + definition.toUpperCase() + "_1";
      const url = "https://github.com/" + slug + (definition === "label" ? "/labels/synthetic" : "/milestone/1");
      const collected = await sourceRow(h);
      assert.equal(collected.subject_id, "SYNTHETIC_ISSUE_1");
      assert.equal(collected.document.sourceUrl, "https://github.com/" + slug + "/issues/1");
      assert.deepEqual(
        normalized.facts.map((fact) => fact.artifactId),
        [id],
      );
      assert.deepEqual(
        normalized.evidence.map((entry) => [entry.artifact.kind, entry.artifact.stableId, entry.artifact.publicUrl]),
        [["other", id, url]],
      );
      assert.equal(components.metrics.getMetricUi(h.metric).default_combination, null);
      assert.deepEqual(components.metrics.getMetricUi(h.metric).supported_combinations, []);
    }
    await retainLegacyTriage(h, first, "exact");
    equalJSONValues(h);
    await restartRuntime(h, async (runtime) => {
      await assertDenied(runtime, h.metric, first.snapshotId);
      const fresh = (await runtime.runOnce()).publications[0];
      await assertTriage(runtime, h.metric, 0, fresh.snapshotId);
      await assertDenied(runtime, h.metric, first.snapshotId, false);
    });
  });

test("unrelated issue cache, snapshots, exports and private comparisons keep their exact generation", async (t) => {
  const h = await harness(t, { memoryDatabase: true, authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const rows = await caches(h);
  assert.ok(rows.every((row) => row.policy_signature === currentSignature(h.config)));
  assert.ok(rows.every((row) => row.document.triageMetadataNormalizationVersion === undefined));
  const responses = await Promise.all(
    paths("issues_opened").map(async (path) => (await h.runtime.app.inject(path)).body),
  );
  const preview = await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
  await restartRuntime(h, async (runtime) => {
    assert.deepEqual(
      await Promise.all(paths("issues_opened").map(async (path) => (await runtime.app.inject(path)).body)),
      responses,
    );
    assert.deepEqual(await runtime.previewPolicy(previewRequest(h, first.snapshotId)), preview);
    assert.equal((await runtime.runOnce({ cutoff })).publications[0].snapshotId, first.snapshotId);
    assert.deepEqual(await caches(h), rows);
    // Existing unrelated historical public behavior also allows absent old caches.
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations");
    for (const path of paths("issues_opened"))
      assert.equal((await runtime.app.inject(path + "&snapshot=" + first.snapshotId)).statusCode, 200);
  });
});

test("a custom provider needs an explicit compatible declaration even when its returned marker looks current", async (t) => {
  let calls = 0;
  const h = await triageHarness(t, "unlabeled", {
    normalizerFactory: (options) => {
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: options.githubEnrich,
      });
      return async (input) => {
        calls++;
        return { ...(await builtin(input)), triageMetadataNormalizationVersion: version };
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /triage_metadata_normalizer_version_unverified/);
  assert.equal(calls, 1, "a generic enriched source must actually produce the affected claim");
  assert.deepEqual(await caches(h), []);
  const qualified = await createPipeline({ ...h.options, triageMetadataNormalizationVersion: version });
  try {
    assert.equal((await qualified.runOnce()).state, "published");
    await assertTriage(qualified, h.metric, 1);
  } finally {
    await qualified.stop();
  }
  await assert.rejects(h.runtime.runOnce(), /triage_metadata_normalizer_version_unverified/);
});

test("an older builtin cannot be blessed by a host option, including through enrichment", async (t) => {
  const h = await triageHarness(t, "unlabeled", {
    components: { ...components, github: { ...components.github, triageMetadataNormalizationVersion: undefined } },
    triageMetadataNormalizationVersion: version,
  });
  await assert.rejects(h.runtime.runOnce(), /triage_metadata_normalizer_version_unverified/);
  assert.equal(h.state.hydrations, 1);
  assert.deepEqual(await caches(h), []);
});

test("cached triage dependency capture rechecks a declaration changed after awaited SQL", async (t) => {
  const h = await triageHarness(t, "unlabeled", { includeIssueCreation: true });
  await h.runtime.runOnce();
  const rows = await caches(h);
  const snapshots = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows;
  const transaction = h.db.transaction;
  let changes = 0;
  h.db.transaction = (work) =>
    transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          if (
            sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") &&
            sql.includes("FOR UPDATE")
          ) {
            delete h.options.triageMetadataNormalizationVersion;
            changes++;
          }
          return value;
        },
      }),
    );
  try {
    await assert.rejects(h.runtime.runOnce(), /triage_metadata_normalizer_version_unverified/);
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(changes, 1);
  assert.deepEqual(await caches(h), rows);
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows, snapshots);
});

for (const mutation of ["hash", "mode"])
  test(
    "valid current triage output cannot hide a corrupted plain predecessor beside delivery; " + mutation,
    async (t) => {
      const h = await triageHarness(t);
      const first = (await h.runtime.runOnce()).publications[0];
      const old = await retainLegacyTriage(h, first, "exact");
      const delivery = {
        ...structuredClone(old.document),
        defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
      };
      await h.db.query(
        "INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash) VALUES($1,$2,$3::jsonb,$4)",
        [
          old.factKey,
          comparisonHash([components.github.defaultDeliveryNormalizationVersion, old.signature]),
          JSON.stringify(delivery),
          comparisonHash(delivery),
        ],
      );
      equalJSONValues(h);
      await h.runtime.runOnce();
      assert.equal(triageRows(await caches(h)).length, 1);
      const bad = structuredClone(old.document);
      if (mutation === "hash") bad.facts = [];
      else bad.isSynthetic = false;
      await h.db.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
        [old.factKey, old.signature, JSON.stringify(bad), mutation === "hash" ? old.documentHash : comparisonHash(bad)],
      );
      await assert.rejects(
        h.runtime.runOnce(),
        mutation === "hash" ? /normalization_integrity_error/ : /normalization_data_mode_mismatch/,
      );
    },
  );

test("triage, review and default-delivery generations compose without overwriting their predecessor", async (t) => {
  const h = await triageHarness(t, "unlabeled", { sourceFamily: "reviews" });
  const first = (await h.runtime.runOnce()).publications[0];
  const old = await retainLegacyTriage(h, first, "exact", true);
  equalJSONValues(h);
  await h.runtime.runOnce();
  const all = await caches(h),
    fresh = triageRows(all);
  assert.equal(all.length, 2);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].policy_signature, comparisonHash([version, old.signature]));
  assert.equal(fresh[0].document.reviewSourceNormalizationVersion, components.github.reviewSourceNormalizationVersion);
  assert.equal(
    fresh[0].document.defaultDeliveryNormalizationVersion,
    components.github.defaultDeliveryNormalizationVersion,
  );
  assert.deepEqual(fresh[0].document.facts, []);
  assert.equal(all.find((row) => row.policy_signature === old.signature).document_hash, old.documentHash);
});

test("a corrected selected snapshot cannot borrow authority from an obsolete current head", async (t) => {
  const h = await triageHarness(t);
  const first = (await h.runtime.runOnce()).publications[0];
  await retainLegacyTriage(h, first, "exact");
  const key = components.contracts.publicScopeKey(publicScope);
  const oldHead = structuredClone(h.controlsStore.read().pipelineHeads[key]);
  equalJSONValues(h);
  const fresh = (await h.runtime.runOnce()).publications[0];
  const newHead = structuredClone(h.controlsStore.read().pipelineHeads[key]);
  await assertTriage(h.runtime, h.metric, 0, fresh.snapshotId);
  h.controlsStore.transaction((state) => {
    state.pipelineHeads[key] = oldHead;
  });
  try {
    await assertDenied(h.runtime, h.metric, fresh.snapshotId);
  } finally {
    h.controlsStore.transaction((state) => {
      state.pipelineHeads[key] = newHead;
    });
  }
  await assertTriage(h.runtime, h.metric, 0);
  await assertDenied(h.runtime, h.metric, first.snapshotId, false);
});

test("named-period publication accepts and retains the optional triage normalization version", async (t) => {
  const h = await triageHarness(t, "unlabeled", {
    discoveryAuthority: true,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.ok(publication);
  const confirmation = h.controlsStore.read().pipelinePublications[publication.snapshotId];
  assert.equal(confirmation.triageMetadataNormalizationVersion, version);
  const head = Object.values(h.controlsStore.read().pipelineHeads).find(
    (value) => value.snapshotId === publication.snapshotId,
  );
  assert.deepEqual(head, confirmation);

  const state = h.controlsStore.read();
  const entries = Object.values(state.pipelineWindowIndex).flatMap((namespace) => Object.values(namespace.entries));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].period, "30d");
  assert.deepEqual(entries[0].confirmation, confirmation);
  const saved = (await snapshotRows(h)).find((row) => row.snapshot_id === publication.snapshotId);
  const visible = await h.runtime.source.read(
    saved.document.scope,
    publication.snapshotId,
    new AbortController().signal,
  );
  assert.ok(visible.selected);
  assert.doesNotMatch(
    JSON.stringify(visible),
    /triageMetadataNormalizationVersion|fieldChangeNormalizationVersion|normalizationSources|normalizationHashes/,
  );
});

async function insertDelivery(h, n) {
  await h.runtime.inbox.insert({
    deliveryId: fixtureId(n),
    bodyHash: "a".repeat(64),
    envelope: {
      version: "github-delivery/v1",
      deliveryId: fixtureId(n),
      event: "issues",
      action: "opened",
      installationId: 1,
      repositoryId: 2,
      subjectId: h.subjectId,
      sourceUrl: h.sourceUrl,
      actorId: null,
      occurredAt: h.at,
    },
  });
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
}
async function savedPublication(h) {
  const row = (
    await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.snapshots ORDER BY revision DESC LIMIT 1")
  ).rows[0];
  assert.ok(row);
  const input = h.controlsStore.db
    .prepare("SELECT id,document FROM policy_preview_inputs")
    .all()
    .find((entry) => JSON.parse(entry.document).snapshot.snapshotId === row.snapshot_id);
  return {
    snapshotId: row.snapshot_id,
    revision: Number(row.revision),
    ...(input ? { comparisonInput: { inputId: input.id } } : {}),
  };
}

test("an interrupted dispatch cannot acknowledge retained obsolete triage claims after runtime and SQLite reopen with retained SQL", async (t) => {
  const h = await triageHarness(t, "unlabeled", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 901);
  h.runtime.outbox.complete = h.runtime.outbox.fail = async () => {
    throw Error("synthetic triage acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic triage acknowledgment loss/);
  const first = await savedPublication(h);
  await retainLegacyTriage(h, first, "exact");
  const operation = (await h.db.query("SELECT event_key,operation FROM leaderboard_ingestion.outbox")).rows[0];
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  equalJSONValues(h);
  await restartRuntime(h, async (runtime) => {
    await assertDenied(runtime, h.metric, first.snapshotId);
    assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
    const row = (
      await h.db.query("SELECT state,completion,operation FROM leaderboard_ingestion.outbox WHERE event_key=$1", [
        operation.event_key,
      ])
    ).rows[0];
    assert.equal(row.state, "pending");
    assert.equal(row.completion, null);
    assert.deepEqual(row.operation, operation.operation);
    const fresh = (await runtime.runOnce()).publications[0];
    await assertTriage(runtime, h.metric, 0, fresh.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("final dispatch acknowledgment rejects triage authority changed after publication despite a forged confirmation marker", async (t) => {
  const h = await triageHarness(t, "unlabeled", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 902);
  const complete = h.runtime.outbox.complete.bind(h.runtime.outbox);
  let changes = 0,
    first;
  h.runtime.outbox.complete = async (...args) => {
    first = await savedPublication(h);
    await retainLegacyTriage(h, first, "exact");
    h.controlsStore.transaction((state) => {
      for (const entry of [state.pipelinePublications[first.snapshotId], ...Object.values(state.pipelineHeads)])
        if (entry.snapshotId === first.snapshotId) entry.triageMetadataNormalizationVersion = version;
    });
    changes++;
    return complete(...args);
  };
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal(changes, 1);
  const row = (await h.db.query("SELECT state,completion,reason_code FROM leaderboard_ingestion.outbox")).rows[0];
  assert.equal(row.state, "pending");
  assert.equal(row.completion, null);
  assert.equal(row.reason_code, "publication_unavailable");
  await assertDenied(h.runtime, h.metric, first.snapshotId);
});

test("operator replay reconstructs the triage-version content and rechecks it after an awaited observer", async (t) => {
  const h = await triageHarness(t, "unlabeled", {
    includeIssueCreation: true,
    webhookDispatch: true,
    operatorDiagnostics: operatorSettings(),
  });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  const receipt = await queueOperatorReplay(h, 903);
  assert.equal(await h.runtime.inbox.complete(await h.runtime.inbox.claim()), true);
  assert.equal(await h.runtime.dispatchOnce(), "processed");
  const first = await savedPublication(h);
  const read = () => h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  const value = await read();
  assert.equal(value.status, "published", value.reason);
  assert.equal(value.reason, "verified_publication");
  assert.deepEqual(
    value.publications.map((entry) => [entry.snapshotId, entry.revision]),
    [[first.snapshotId, first.revision]],
  );
  assert.doesNotMatch(
    JSON.stringify(value),
    /triageMetadataNormalizationVersion|normalizationHashes|normalizationSources/,
  );
  assert.equal((await h.runtime.operations.readHealth(2, operatorAllow)).publication.state, "verified");
  const original = structuredClone(h.controlsStore.read().pipelinePublications[first.snapshotId]);
  let observations = 0;
  try {
    await assert.rejects(
      h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow, async (data, beforeSend) => {
        observations++;
        assert.equal(data.status, "published");
        beforeSend();
        await Promise.resolve();
        h.controlsStore.transaction((state) => {
          delete state.pipelinePublications[first.snapshotId].triageMetadataNormalizationVersion;
        });
      }),
      /operation_publication_changed/,
    );
    assert.equal(observations, 1);
  } finally {
    h.controlsStore.transaction((state) => {
      state.pipelinePublications[first.snapshotId] = original;
    });
  }
  assert.equal((await read()).status, "published");
  await retainLegacyTriage(h, first, "exact");
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[first.snapshotId].triageMetadataNormalizationVersion = version;
  });
  await restartRuntime(h, async (runtime) => {
    const denied = await runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
    assert.equal(denied.status, "unavailable");
    assert.equal(denied.reason, "publication_verification_unavailable");
    assert.deepEqual(denied.publications, []);
  });
});

test("an unrelated public metric preserves its views while private replay rejects stale triage facts anywhere in the input", async (t) => {
  const h = await triageHarness(t, "unlabeled", {
    includeIssueCreation: true,
    configure(config) {
      config.policies = config.policies.filter((entry) => entry.policy.metricId === "issues_opened");
    },
  });
  const first = (await h.runtime.runOnce()).publications[0];
  await assertTriage(h.runtime, "issues_opened", 1, first.snapshotId);
  const responses = await Promise.all(
    paths("issues_opened").map(async (path) => (await h.runtime.app.inject(path)).body),
  );
  const legacy = await retainLegacyTriage(h, first, "exact");
  assert.ok(legacy.document.facts.some((fact) => fact.metricId === h.metric));
  const explanation = new AggregateExplanationStore(h.controlsStore).read(first.snapshotId).document;
  assert.ok(explanation.references.length > 0);
  assert.ok(explanation.references.every((entry) => entry.metricId === "issues_opened"));
  equalJSONValues(h);
  await restartRuntime(h, async (runtime) => {
    assert.deepEqual(
      await Promise.all(paths("issues_opened").map(async (path) => (await runtime.app.inject(path)).body)),
      responses,
    );
    await assertTriage(runtime, "issues_opened", 1, first.snapshotId);
    await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), {
      status: 409,
      message: "Frozen triage metadata normalization obsolete",
    });
    await assert.rejects(
      runtime.aggregateExplanations.read(first.snapshotId),
      /Frozen triage metadata normalization obsolete/,
    );
    const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
    await assert.rejects(
      runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
        assert.fail("unselected obsolete triage facts reached private replay"),
      ),
      /Frozen triage metadata normalization obsolete/,
    );
    const fresh = (await runtime.runOnce()).publications[0];
    assert.notEqual(fresh.snapshotId, first.snapshotId);
    await assertTriage(runtime, "issues_opened", 1, fresh.snapshotId);
    await assertTriage(runtime, "issues_opened", 1, first.snapshotId);
    await runtime.previewPolicy(previewRequest(h, fresh.snapshotId));
    await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), {
      status: 409,
      message: "Frozen triage metadata normalization obsolete",
    });
  });
});

test("a SQL commit without SQLite confirmation cannot recover obsolete frozen triage inputs", async (t) => {
  const h = await triageHarness(t, "unlabeled", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 904);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const result = change(state);
      if (state.pipelinePublications) throw Error("synthetic triage SQLite confirmation loss");
      return result;
    }, options);
  try {
    assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  } finally {
    h.controlsStore.transaction = transaction;
  }
  const first = await savedPublication(h);
  assert.equal(first.comparisonInput, undefined);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n, 0);
  await retainLegacyTriage(h, first, "exact");
  equalJSONValues(h);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()-interval '1 second'");
  await restartRuntime(h, async (runtime, controlsStore) => {
    const beforeHydrations = h.state.hydrations;
    assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
    assert.ok(h.state.hydrations > beforeHydrations, "the preceding triage source is actually normalized on retry");
    assert.equal(controlsStore.read().pipelinePublications?.[first.snapshotId], undefined);
    assert.equal(controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    assert.equal((await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox")).rows[0].completion, null);
    await assertDenied(runtime, h.metric, first.snapshotId);
    const recovered = (await runtime.runOnce()).publications[0];
    assert.notEqual(recovered.snapshotId, first.snapshotId);
    await assertTriage(runtime, h.metric, 0, recovered.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("acknowledging a corrected empty-triage cache preserves its confirmed version identity", async (t) => {
  const h = await triageHarness(t, "unlabeled", { includeIssueCreation: true, webhookDispatch: true });
  const first = (await h.runtime.runOnce()).publications[0];
  await retainLegacyTriage(h, first, "exact");
  equalJSONValues(h);
  const corrected = (await h.runtime.runOnce()).publications[0];
  await assertTriage(h.runtime, h.metric, 0, corrected.snapshotId);
  await insertDelivery(h, 905);
  h.runtime.outbox.complete = h.runtime.outbox.fail = async () => {
    throw Error("synthetic empty-triage acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic empty-triage acknowledgment loss/);
  const pending = await savedPublication(h);
  const confirmation = h.controlsStore.read().pipelinePublications[pending.snapshotId];
  assert.equal(confirmation.triageMetadataNormalizationVersion, version);
  const beforeCount = (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n;
  assert.equal(beforeCount, 3);
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  await restartRuntime(h, async (runtime, controlsStore) => {
    assert.equal(await runtime.dispatchOnce(), "processed");
    assert.deepEqual(controlsStore.read().pipelinePublications[pending.snapshotId], confirmation);
    assert.equal(
      controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(publicScope)]
        .triageMetadataNormalizationVersion,
      version,
    );
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n,
      beforeCount,
    );
    assert.equal((await h.db.query("SELECT state FROM leaderboard_ingestion.outbox")).rows[0].state, "done");
    await assertTriage(runtime, h.metric, 0, pending.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("a captured custom provider cannot become builtin when its option is removed during normalization", async (t) => {
  let returned = 0;
  const h = await triageHarness(t, "unlabeled", {
    triageMetadataNormalizationVersion: version,
    normalizerFactory: (options) => {
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: options.githubEnrich,
      });
      return async (input) => {
        const output = await builtin(input);
        assert.equal(output.facts.length, 1);
        await Promise.resolve();
        delete options.normalizer;
        delete options.triageMetadataNormalizationVersion;
        returned++;
        return output;
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /triage_metadata_normalizer_version_unverified/);
  assert.equal(returned, 1);
  assert.deepEqual(await caches(h), []);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
});

test("triage wraps field and delivery generations while preserving genuine field and issue contributions", async (t) => {
  const h = await triageHarness(t, "unlabeled", {
    includeFieldChange: true,
    includeIssueCreation: true,
    sourceFamily: "reviews",
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
  });
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  for (const metric of [h.metric, "issue_field_updates", "issues_opened"])
    await assertTriage(h.runtime, metric, 1, first.snapshotId);
  const old = await retainLegacyTriage(h, first, "exact", true);
  const before = (await caches(h)).find((row) => row.policy_signature === old.signature);
  const base = comparisonHash([components.github.reviewSourceNormalizationVersion, currentSignature(h.config)]);
  assert.equal(
    old.signature,
    comparisonHash([
      components.github.fieldChangeNormalizationVersion,
      comparisonHash([components.github.defaultDeliveryNormalizationVersion, base]),
    ]),
  );
  equalJSONValues(h);
  const fresh = (await h.runtime.runOnce({ cutoff })).publications[0];
  const rows = await caches(h),
    current = triageRows(rows);
  assert.equal(rows.length, 2);
  assert.equal(current.length, 1);
  assert.equal(current[0].policy_signature, comparisonHash([version, old.signature]));
  assert.equal(current[0].document.fieldChangeNormalizationVersion, components.github.fieldChangeNormalizationVersion);
  assert.equal(
    current[0].document.defaultDeliveryNormalizationVersion,
    components.github.defaultDeliveryNormalizationVersion,
  );
  assert.equal(
    current[0].document.reviewSourceNormalizationVersion,
    components.github.reviewSourceNormalizationVersion,
  );
  assert.deepEqual([...new Set(current[0].document.facts.map((fact) => fact.metricId))].sort(), [
    "issue_field_updates",
    "issues_opened",
  ]);
  assert.deepEqual(
    rows.find((row) => row.policy_signature === old.signature),
    before,
  );
  await assertTriage(h.runtime, h.metric, 0, fresh.snapshotId);
  for (const metric of ["issue_field_updates", "issues_opened"])
    await assertTriage(h.runtime, metric, 1, fresh.snapshotId);
  const hydrations = h.state.hydrations;
  assert.equal((await h.runtime.runOnce({ cutoff })).publications[0].snapshotId, fresh.snapshotId);
  assert.equal(h.state.hydrations, hydrations);
  assert.deepEqual(await caches(h), rows);
});

test("separate collected families preserve unrelated field and issue caches when triage is migrated", async (t) => {
  let h,
    otherHydrations = 0;
  h = await triageHarness(t, "unlabeled", {
    reviewSourceNormalizationVersion: components.github.reviewSourceNormalizationVersion,
    githubEnrich: async (input) => {
      if (input.family === "issues") return h.enrich(input);
      otherHydrations++;
      const number = input.family === "comments" ? 2 : 3;
      const issue = {
        id: 1000 + number,
        node_id: "SYNTHETIC_MIXED_" + number,
        number,
        html_url: "https://github.com/" + slug + "/issues/" + number,
        user: actor,
        created_at: h.at,
        updated_at: h.at,
        state: "open",
      };
      return {
        repository: { id: 2, slug, visibility: "public" },
        proof: {
          verified: true,
          source: "github_rest",
          revision: input.fact.sourceRevision,
          eventId: "synthetic-mixed-" + number,
          isSynthetic: true,
        },
        family: input.family === "comments" ? "field_change" : "issue",
        action: input.family === "comments" ? "issue_field_changed" : "opened",
        occurredAt: h.at,
        observedAt: input.observedAt,
        payload: {
          issue,
          sender: actor,
          ...(input.family === "comments" ? { change: { before: 1, after: 2 } } : {}),
        },
      };
    },
    configure(config) {
      config.repositories[0].families = ["issues", "comments", "reviews"];
      for (const [metricId, role] of [
        ["issue_field_updates", "triager"],
        ["issues_opened", "reporter"],
      ]) {
        const policy = {
          ...config.policies[0].policy,
          metricId,
          groupBy: "actor_artifact",
          roles: [role],
          unit: components.metrics.getMetricDefinition(metricId).definition.unit,
        };
        delete policy.groupingSeconds;
        delete policy.groupingPolicyVersion;
        config.policies.push({
          policy,
          signature: components.metrics.stableJSON(policy),
          approvalReceipt: "synthetic-mixed-" + metricId,
        });
      }
    },
  });
  const issues = h.options.source.readPage;
  h.options.source.readPage = async (request) => {
    if (request.family === "issues") return issues(request);
    const number = request.family === "comments" ? 2 : 3;
    return {
      repositoryId: 2,
      visibility: "public",
      isSynthetic: true,
      nextCursor: null,
      expectedCount: 1,
      facts: [
        {
          subjectId: "SYNTHETIC_MIXED_" + number,
          sourceRevision: h.at,
          sourceUrl: "https://github.com/" + slug + "/issues/" + number,
          evidence: "current_state",
          actorId: null,
          occurredAt: null,
          state: "present",
        },
      ],
    };
  };
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  for (const metric of [h.metric, "issue_field_updates", "issues_opened"])
    await assertTriage(h.runtime, metric, 1, first.snapshotId);
  const old = await retainLegacyTriage(h, first, "exact");
  const before = await caches(h);
  assert.equal(before.length, 3);
  const untouched = before.filter((row) => row.fact_key !== old.factKey);
  assert.equal(untouched.length, 2);
  assert.ok(untouched.every((row) => row.document.triageMetadataNormalizationVersion === undefined));
  assert.ok(
    untouched.some(
      (row) => row.document.fieldChangeNormalizationVersion === components.github.fieldChangeNormalizationVersion,
    ),
  );
  assert.equal(otherHydrations, 2);
  equalJSONValues(h);
  const fresh = (await h.runtime.runOnce({ cutoff })).publications[0];
  await assertTriage(h.runtime, h.metric, 0, fresh.snapshotId);
  for (const metric of ["issue_field_updates", "issues_opened"])
    await assertTriage(h.runtime, metric, 1, fresh.snapshotId);
  assert.equal(otherHydrations, 2, "unrelated collected families retain their existing caches");
  const after = await caches(h);
  assert.equal(after.length, 4);
  for (const row of untouched)
    assert.deepEqual(
      after.find((entry) => entry.fact_key === row.fact_key && entry.policy_signature === row.policy_signature),
      row,
    );
});

async function selectedTriageProvider(t, after = async () => {}) {
  const selected = { calls: 0 };
  const h = await triageHarness(t, "unlabeled", {
    triageMetadataNormalizationVersion: version,
    normalizerFactory(options) {
      const builtin = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        enrich: options.githubEnrich,
      });
      return async (input) => {
        selected.calls++;
        const output = await builtin(input);
        await after(options, output);
        return output;
      };
    },
  });
  return { h, selected };
}
function removeTriageCompatibility(h) {
  delete h.options.normalizer;
  delete h.options.triageMetadataNormalizationVersion;
}
const unavailableTriage = /triage_metadata_normalizer_version_unverified/;
const snapshotRows = async (h) =>
  (
    await h.db.query(
      "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.snapshots ORDER BY snapshot_id",
    )
  ).rows;
function afterTriageTransaction(h, predicate, after) {
  const transaction = h.db.transaction;
  h.db.transaction = async (work) => {
    let matched = false;
    const value = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          matched ||= predicate(sql);
          return result;
        },
      }),
    );
    if (matched) after();
    return value;
  };
}
async function assertNoTriageVisibility(h) {
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
}

test("a fresh empty custom triage result cannot certify itself without a compatible selected provider", async (t) => {
  const { h, selected } = await selectedTriageProvider(t);
  equalJSONValues(h);
  delete h.options.triageMetadataNormalizationVersion;
  await assert.rejects(h.runtime.runOnce(), unavailableTriage);
  assert.equal(selected.calls, 1, "the generic source first exposes triage through its actual no-op reason");
  assert.deepEqual(await caches(h), []);
  assert.deepEqual(await snapshotRows(h), []);
  await assertNoTriageVisibility(h);
  h.options.triageMetadataNormalizationVersion = version;
  const current = (await h.runtime.runOnce()).publications[0];
  const rows = await caches(h);
  assert.equal(rows[0].document.triageMetadataNormalizationVersion, version);
  assert.deepEqual(rows[0].document.facts, []);
  await assertTriage(h.runtime, h.metric, 0, current.snapshotId);
});

test("adding an unused replacement option cannot reclassify the captured built-in triage provider", async (t) => {
  const h = await triageHarness(t);
  let unused = 0;
  h.options.normalizer = async () => {
    unused++;
    throw Error("unused synthetic replacement");
  };
  const current = (await h.runtime.runOnce()).publications[0];
  assert.equal(unused, 0);
  await assertTriage(h.runtime, h.metric, 1, current.snapshotId);
  assert.equal((await caches(h))[0].document.triageMetadataNormalizationVersion, version);
});

test("triage candidate lookup rechecks the selected provider while compatible immutable reads remain available", async (t) => {
  const { h, selected } = await selectedTriageProvider(t);
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const beforeCaches = await caches(h),
    beforeSnapshots = await snapshotRows(h),
    beforeControls = h.controlsStore.read();
  let changed = false;
  const query = h.db.query;
  h.db.query = async (sql, params) => {
    const value = await query(sql, params);
    if (
      !changed &&
      sql.startsWith("SELECT policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations")
    ) {
      removeTriageCompatibility(h);
      changed = true;
    }
    return value;
  };
  await assert.rejects(h.runtime.runOnce({ cutoff }), unavailableTriage);
  assert.equal(changed, true);
  assert.equal(selected.calls, 1);
  assert.deepEqual(await caches(h), beforeCaches);
  assert.deepEqual(await snapshotRows(h), beforeSnapshots);
  assert.deepEqual(h.controlsStore.read().pipelinePublications, beforeControls.pipelinePublications);
  assert.deepEqual(h.controlsStore.read().pipelineHeads, beforeControls.pipelineHeads);
  await assertTriage(h.runtime, h.metric, 1, first.snapshotId);
  await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
  await h.runtime.aggregateExplanations.read(first.snapshotId);
  h.options.triageMetadataNormalizationVersion = version;
  assert.equal((await h.runtime.runOnce({ cutoff })).publications[0].snapshotId, first.snapshotId);
  assert.equal(selected.calls, 1);
});

for (const boundary of ["source lock", "source artifact dependency"])
  test("triage compatibility loss rolls back its new normalization at " + boundary, async (t) => {
    let armed = false,
      changed = false;
    const { h, selected } = await selectedTriageProvider(t, async () => {
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
              (boundary === "source lock"
                ? sql.includes("leaderboard_ingestion.repository_access") && /FOR UPDATE/.test(sql)
                : /INSERT\s+INTO\s+leaderboard_pipeline\.source_artifacts/i.test(sql))
            ) {
              removeTriageCompatibility(h);
              armed = false;
              changed = true;
            }
            return value;
          },
        }),
      );
    await assert.rejects(h.runtime.runOnce(), unavailableTriage);
    assert.equal(changed, true, "the actual awaited boundary was reached");
    assert.equal(selected.calls, 1);
    assert.deepEqual(await caches(h), []);
    assert.deepEqual(await snapshotRows(h), []);
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.source_artifacts")).rows[0].n,
      0,
    );
    await assertNoTriageVisibility(h);
  });

test("a committed triage cache cannot proceed to publication after its provider declaration changes", async (t) => {
  const { h, selected } = await selectedTriageProvider(t);
  let changed = false;
  afterTriageTransaction(
    h,
    (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.normalizations/i.test(sql),
    () => {
      if (!changed) {
        removeTriageCompatibility(h);
        changed = true;
      }
    },
  );
  const cutoff = clock();
  await assert.rejects(h.runtime.runOnce({ cutoff }), unavailableTriage);
  assert.equal(changed, true);
  const saved = await caches(h);
  assert.equal(saved.length, 1, "the mutation occurs after this transaction has actually committed");
  assert.deepEqual(await snapshotRows(h), []);
  await assertNoTriageVisibility(h);
  h.options.triageMetadataNormalizationVersion = version;
  const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(selected.calls, 1);
  assert.deepEqual(await caches(h), saved);
  await assertTriage(h.runtime, h.metric, 1, recovered.snapshotId);
});

test("a cached triage result is withheld after its dependency transaction loses compatibility", async (t) => {
  const { h, selected } = await selectedTriageProvider(t);
  const cutoff = clock();
  await h.runtime.runOnce({ cutoff });
  const beforeCaches = await caches(h),
    beforeSnapshots = await snapshotRows(h),
    beforeControls = h.controlsStore.read();
  let changed = false;
  afterTriageTransaction(
    h,
    (sql) =>
      sql.includes("SELECT document_hash FROM leaderboard_pipeline.normalizations") && sql.includes("FOR UPDATE"),
    () => {
      if (!changed) {
        removeTriageCompatibility(h);
        changed = true;
      }
    },
  );
  await assert.rejects(h.runtime.runOnce({ cutoff }), unavailableTriage);
  assert.equal(changed, true);
  assert.equal(selected.calls, 1);
  assert.deepEqual(await caches(h), beforeCaches);
  assert.deepEqual(await snapshotRows(h), beforeSnapshots);
  assert.deepEqual(h.controlsStore.read().pipelinePublications, beforeControls.pipelinePublications);
  assert.deepEqual(h.controlsStore.read().pipelineHeads, beforeControls.pipelineHeads);
});

for (const boundary of ["after SQL commit", "inside Controls confirmation"])
  test("an unconfirmed triage publication requires restored provider compatibility " + boundary, async (t) => {
    const { h, selected } = await selectedTriageProvider(t);
    const cutoff = clock();
    let armed = false,
      changed = false;
    afterTriageTransaction(
      h,
      (sql) => /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql),
      () => {
        if (boundary === "inside Controls confirmation") armed = true;
        else if (!changed) {
          removeTriageCompatibility(h);
          changed = true;
        }
      },
    );
    if (boundary === "inside Controls confirmation") {
      const transaction = h.controlsStore.transaction.bind(h.controlsStore);
      h.controlsStore.transaction = (work, options) =>
        transaction((state) => {
          if (armed && !changed) {
            removeTriageCompatibility(h);
            changed = true;
          }
          return work(state);
        }, options);
    }
    await assert.rejects(h.runtime.runOnce({ cutoff }), unavailableTriage);
    assert.equal(changed, true);
    const saved = await snapshotRows(h),
      savedCaches = await caches(h);
    assert.equal(saved.length, 1);
    assert.equal(selected.calls, 1);
    await assertNoTriageVisibility(h);
    assert.notEqual((await h.runtime.app.inject(paths(h.metric)[0])).statusCode, 200);
    h.options.triageMetadataNormalizationVersion = version;
    const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
    assert.equal(recovered.snapshotId, saved[0].snapshot_id);
    assert.equal(selected.calls, 1);
    assert.deepEqual(await snapshotRows(h), saved);
    assert.deepEqual(await caches(h), savedCaches);
    await assertTriage(h.runtime, h.metric, 1, recovered.snapshotId);
  });

function triageWindowFixture(extra = {}) {
  const scope = structuredClone(publicScope);
  const index = createPublicationWindowIndex({
    configurationVersion: "synthetic-triage-window-v1",
    configurationHash: "a".repeat(64),
    dataMode: "synthetic",
    templates: [{ ...scope, period: "all" }],
    resolveMetricWindow: components.metrics.resolveMetricWindow,
  });
  const confirmation = {
    recognitionFingerprint: null,
    configurationVersion: "synthetic-triage-window-v1",
    configurationHash: "a".repeat(64),
    controlsConfigurationRevision: 0,
    aggregateExplanationHash: "b".repeat(64),
    dataMode: "synthetic",
    scopeKey: components.contracts.publicScopeKey(scope),
    snapshotId: "synthetic-triage-snapshot",
    revision: 1,
    ...extra,
  };
  const state = {
    pipelinePublications: { [confirmation.snapshotId]: structuredClone(confirmation) },
    pipelineHeads: { [confirmation.scopeKey]: structuredClone(confirmation) },
  };
  return { index, state, scope, confirmation };
}

test("named-window confirmation retains triage and prior generation metadata with exact ordinary absence", () => {
  const h = triageWindowFixture({
    triageMetadataNormalizationVersion: version,
    fieldChangeNormalizationVersion: components.github.fieldChangeNormalizationVersion,
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    discussionSourceNormalizationVersion: components.github.discussionSourceNormalizationVersion,
    reviewSourceNormalizationVersion: components.github.reviewSourceNormalizationVersion,
    discussionFeedbackNormalizationVersion: components.contracts.discussionFeedbackContentVersion,
    discussionFeedbackAuthorityHash: "c".repeat(64),
  });
  assert.equal(h.index.record(h.state, h.scope, ["all"], h.confirmation), true);
  assert.deepEqual(h.index.read(h.state, h.scope).windows[0].confirmation, h.confirmation);
  const saved = structuredClone(h.state.pipelineWindowIndex);
  assert.equal(h.index.record(h.state, h.scope, ["all"], h.confirmation), false);
  assert.deepEqual(h.state.pipelineWindowIndex, saved);
  h.state.pipelineHeads[h.confirmation.scopeKey].triageMetadataNormalizationVersion = "obsolete/v0";
  assert.equal(h.index.read(h.state, h.scope), null);
  const ordinary = triageWindowFixture();
  const exact = JSON.stringify(ordinary.confirmation);
  assert.equal(ordinary.index.record(ordinary.state, ordinary.scope, ["all"], ordinary.confirmation), true);
  assert.equal(JSON.stringify(ordinary.index.read(ordinary.state, ordinary.scope).windows[0].confirmation), exact);
});

for (const value of [undefined, "triage-metadata-json-values/v0"])
  test("named-window confirmation rejects an explicitly invalid triage version: " + String(value), () => {
    const h = triageWindowFixture({ triageMetadataNormalizationVersion: value });
    assert.throws(
      () => h.index.record(h.state, h.scope, ["all"], h.confirmation),
      /publication_window_index_integrity_error/,
    );
    assert.equal(h.state.pipelineWindowIndex, undefined);
  });
