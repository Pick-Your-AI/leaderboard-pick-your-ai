import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore, buildAggregateExplanation } from "../src/aggregate-explanations.mjs";
import { createPipeline } from "../src/index.mjs";
import { components, harness, ago, clock, publicScope, fixtureId } from "./harness.mjs";
import {
  currentSignature,
  paths,
  previewRequest,
  assertMetric,
  assertDenied,
  restart,
} from "./default-delivery-fixtures.mjs";
import { operatorAllow, operatorSettings, queueOperatorReplay } from "./operator-harness.mjs";

const version = "field-change-json-values/v1";
const actions = {
  issue_field_changed: "issue_field_updates",
  project_item_field_changed: "project_field_updates",
  project_status_changed: "project_status_updates",
  project_progress_published: "project_updates",
};
const slug = "synthetic-org/synthetic-repo";
const actor = { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" };

async function fieldHarness(t, action = "issue_field_changed", extra = {}) {
  const { configure: configureExtra, sourceFamily = "issues", includeIssueCreation = false, ...options } = extra;
  const at = ago(2);
  const subjectId = "SYNTHETIC_ISSUE_1";
  const sourceUrl = "https://github.com/" + slug + "/issues/1";
  const state = { before: { alpha: 1, beta: 2 }, after: { alpha: 1, beta: 3 }, revision: at, hydrations: 0 };
  const issue = {
    id: 1001,
    node_id: subjectId,
    number: 1,
    html_url: sourceUrl,
    user: actor,
    created_at: at,
    updated_at: at,
    state: "open",
  };
  const envelope = (input, fields = true) => ({
    repository: { id: 2, slug, visibility: "public" },
    proof: {
      verified: true,
      source: "github_rest",
      revision: input.fact.sourceRevision,
      eventId: fields ? "synthetic-field-event" : "synthetic-issue-opened",
      isSynthetic: true,
    },
    family: fields ? "field_change" : "issue",
    action: fields ? action : "opened",
    occurredAt: at,
    observedAt: input.observedAt,
    payload: fields
      ? {
          issue,
          id: subjectId,
          url: sourceUrl,
          sender: actor,
          change: structuredClone({ before: state.before, after: state.after }),
        }
      : { issue, sender: actor },
  });
  const enrich = async (input) => {
    state.hydrations++;
    assert.equal(input.family, sourceFamily);
    return envelope(input);
  };
  const h = await harness(t, {
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
    ...(includeIssueCreation
      ? {
          fieldChangeNormalizationVersion: version,
          normalizerFactory: (provider) => {
            const builtin = components.github.createGithubEvidenceNormalizer({
              client: provider.githubClient,
              source: provider.sourceId,
              allowedRepositoryIds: [2],
              isSynthetic: true,
              enrich,
            });
            return async (input) => {
              const field = await builtin(input);
              const creation = components.github.normalizeGithubObservation(envelope(input, false));
              return {
                ...field,
                facts: [...field.facts, ...creation.facts],
                actors: [...new Map([...field.actors, ...creation.actors].map((entry) => [entry.id, entry])).values()],
                evidence: [...field.evidence, ...creation.evidence],
              };
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
        ...(grouping
          ? {
              groupBy: grouping.group_by,
              groupingSeconds: grouping.grouping_seconds,
              groupingPolicyVersion: grouping.version,
            }
          : {}),
        rank: false,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-field-policy" },
      ];
      if (includeIssueCreation) config.policies.push(issuePolicy);
      configureExtra?.(config);
    },
  });
  return { ...h, state, sourceFamily, subjectId, sourceUrl, at, metric: actions[action], enrich };
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
const fieldRows = (rows) => rows.filter((row) => row.document.fieldChangeNormalizationVersion === version);
async function assertField(runtime, metric, value, snapshot = null) {
  await assertMetric(runtime, metric, value, snapshot);
  for (const path of paths(metric))
    assert.doesNotMatch(
      (await runtime.app.inject(path + (snapshot ? "&snapshot=" + snapshot : ""))).body,
      /fieldChangeNormalizationVersion|normalizationSources|normalizationHashes/,
    );
}

// Reconstruct an integrity-valid pre-upgrade fixture, including its SQL and
// SQLite authorities. These explicit fixture writes never run in production.
async function retainLegacyField(h, publication, bindingMode, legacyDelivery = false) {
  const row = (
    await h.db.query(
      `SELECT n.* FROM leaderboard_pipeline.normalizations n
       JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.family=$1 AND f.document->>'subjectId'=$2`,
      [h.sourceFamily, h.subjectId],
    )
  ).rows[0];
  const document = structuredClone(row.document);
  delete document.fieldChangeNormalizationVersion;
  if (legacyDelivery)
    document.defaultDeliveryNormalizationVersion = components.github.defaultDeliveryNormalizationVersion;
  const oldHash = comparisonHash(document);
  const ordinarySignature =
    h.sourceFamily === "reviews"
      ? comparisonHash([components.github.reviewSourceNormalizationVersion, currentSignature(h.config)])
      : currentSignature(h.config);
  const signature = legacyDelivery
    ? comparisonHash([components.github.defaultDeliveryNormalizationVersion, ordinarySignature])
    : ordinarySignature;
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
        delete confirmation.fieldChangeNormalizationVersion;
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

// The first publication supplies a real, valid changed-field document. The
// explicit fixture below models its preceding unversioned authority. Equal
// values are then supplied for the SAME immutable collected observation. The
// separate source-semantic regression proves the historical comparator defect;
// this suite proves migration and retained-view behavior without forging logs.
for (const bindingMode of ["exact", "hash-only", "unbound"])
  for (const legacyDelivery of [false, true])
    test(
      "field history survives actual database reopen; binding=" + bindingMode + "; old-delivery=" + legacyDelivery,
      async (t) => {
        const h = await fieldHarness(t);
        const cutoff = clock();
        const first = (await h.runtime.runOnce({ cutoff })).publications[0];
        await assertField(h.runtime, h.metric, 1);
        const legacy = await retainLegacyField(h, first, bindingMode, legacyDelivery);
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
        await restart(h, async (runtime, controlsStore) => {
          await assertDenied(runtime, h.metric, first.snapshotId);
          await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), /policy_input_revoked/);
          await assert.rejects(
            runtime.aggregateExplanations.read(first.snapshotId),
            /Frozen (field.change|normalization).* (obsolete|unavailable)/,
          );
          const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
          await assert.rejects(
            runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
              assert.fail("obsolete private field facts reached the manager"),
            ),
            /Frozen (field.change|normalization).* (obsolete|unavailable)/,
          );
          // A current-looking confirmation never upgrades its retained old input.
          controlsStore.transaction((state) => {
            for (const value of [state.pipelinePublications[first.snapshotId], ...Object.values(state.pipelineHeads)])
              if (value.snapshotId === first.snapshotId) value.fieldChangeNormalizationVersion = version;
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
          await assertField(runtime, h.metric, 0);
          await assertField(runtime, h.metric, 0, fresh.snapshotId);
          await assertDenied(runtime, h.metric, first.snapshotId, false);
          const all = await caches(h),
            current = fieldRows(all);
          assert.equal(all.length, 2);
          assert.deepEqual(
            all.find((row) => row.policy_signature === legacy.signature),
            originalCache,
          );
          assert.equal(current.length, 1);
          assert.equal(current[0].policy_signature, comparisonHash([version, legacy.signature]));
          assert.deepEqual(current[0].document.facts, []);
          assert.equal(current[0].document_hash, comparisonHash(current[0].document));
          assert.ok(current[0].document.reasons.includes("no_op_field_change"));
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
          await assertField(runtime, h.metric, 1, recovered.snapshotId);
          await assertDenied(runtime, h.metric, first.snapshotId, false);
        });
      },
    );

for (const action of Object.keys(actions).filter((name) => name !== "issue_field_changed"))
  test(action + ": every field metric checks its actual cross-family retained claims", async (t) => {
    const h = await fieldHarness(t, action);
    const first = (await h.runtime.runOnce()).publications[0];
    await assertField(h.runtime, h.metric, 1);
    await retainLegacyField(h, first, "exact");
    equalJSONValues(h);
    await restart(h, async (runtime) => {
      await assertDenied(runtime, h.metric, first.snapshotId);
      const fresh = (await runtime.runOnce()).publications[0];
      await assertField(runtime, h.metric, 0, fresh.snapshotId);
      await assertDenied(runtime, h.metric, first.snapshotId, false);
    });
  });

test("unrelated issue cache, snapshots, exports and private comparisons keep their exact generation", async (t) => {
  const h = await harness(t, { authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const first = (await h.runtime.runOnce({ cutoff })).publications[0];
  const rows = await caches(h);
  assert.ok(rows.every((row) => row.policy_signature === currentSignature(h.config)));
  assert.ok(rows.every((row) => row.document.fieldChangeNormalizationVersion === undefined));
  const responses = await Promise.all(
    paths("issues_opened").map(async (path) => (await h.runtime.app.inject(path)).body),
  );
  const preview = await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
  await restart(h, async (runtime) => {
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
  const h = await fieldHarness(t, "issue_field_changed", {
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
        return { ...(await builtin(input)), fieldChangeNormalizationVersion: version };
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /field_change_normalizer_version_unverified/);
  assert.equal(calls, 1, "a generic enriched source must actually produce the affected claim");
  assert.deepEqual(await caches(h), []);
  const qualified = await createPipeline({ ...h.options, fieldChangeNormalizationVersion: version });
  try {
    assert.equal((await qualified.runOnce()).state, "published");
    await assertField(qualified, h.metric, 1);
  } finally {
    await qualified.stop();
  }
  await assert.rejects(h.runtime.runOnce(), /field_change_normalizer_version_unverified/);
});

test("an older builtin cannot be blessed by a host option, including through enrichment", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", {
    components: { ...components, github: { ...components.github, fieldChangeNormalizationVersion: undefined } },
    fieldChangeNormalizationVersion: version,
  });
  await assert.rejects(h.runtime.runOnce(), /field_change_normalizer_version_unverified/);
  assert.equal(h.state.hydrations, 1);
  assert.deepEqual(await caches(h), []);
});

test("a provider declaration lost while normalization awaits cannot label or persist the result", async (t) => {
  let returned = 0;
  const h = await fieldHarness(t, "issue_field_changed", {
    fieldChangeNormalizationVersion: version,
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
        delete options.fieldChangeNormalizationVersion;
        returned++;
        return output;
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /field_change_normalizer_version_unverified/);
  assert.equal(returned, 1);
  assert.deepEqual(await caches(h), []);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
});

test("cached field dependency capture rechecks a declaration changed after awaited SQL", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true });
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
            delete h.options.fieldChangeNormalizationVersion;
            changes++;
          }
          return value;
        },
      }),
    );
  try {
    await assert.rejects(h.runtime.runOnce(), /field_change_normalizer_version_unverified/);
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(changes, 1);
  assert.deepEqual(await caches(h), rows);
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows, snapshots);
});

for (const mutation of ["hash", "mode"])
  test(
    "valid current field output cannot hide a corrupted plain predecessor beside delivery; " + mutation,
    async (t) => {
      const h = await fieldHarness(t);
      const first = (await h.runtime.runOnce()).publications[0];
      const old = await retainLegacyField(h, first, "exact");
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
      assert.equal(fieldRows(await caches(h)).length, 1);
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

test("field, review and default-delivery generations compose without overwriting their predecessor", async (t) => {
  const h = await fieldHarness(t, "project_status_changed", { sourceFamily: "reviews" });
  const first = (await h.runtime.runOnce()).publications[0];
  const old = await retainLegacyField(h, first, "exact", true);
  equalJSONValues(h);
  await h.runtime.runOnce();
  const all = await caches(h),
    fresh = fieldRows(all);
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
  const h = await fieldHarness(t);
  const first = (await h.runtime.runOnce()).publications[0];
  await retainLegacyField(h, first, "exact");
  const key = components.contracts.publicScopeKey(publicScope);
  const oldHead = structuredClone(h.controlsStore.read().pipelineHeads[key]);
  equalJSONValues(h);
  const fresh = (await h.runtime.runOnce()).publications[0];
  const newHead = structuredClone(h.controlsStore.read().pipelineHeads[key]);
  await assertField(h.runtime, h.metric, 0, fresh.snapshotId);
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
  await assertField(h.runtime, h.metric, 0);
  await assertDenied(h.runtime, h.metric, first.snapshotId, false);
});

test("named-period publication accepts and retains the optional field normalization version", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", {
    discoveryAuthority: true,
    configure(config) {
      config.scopes = [{ ...publicScope, period: "30d" }];
    },
  });
  const publication = (await h.runtime.runOnce()).publications[0];
  assert.ok(publication);
  const confirmation = h.controlsStore.read().pipelinePublications[publication.snapshotId];
  assert.equal(confirmation.fieldChangeNormalizationVersion, version);
  const head = Object.values(h.controlsStore.read().pipelineHeads).find(
    (value) => value.snapshotId === publication.snapshotId,
  );
  assert.deepEqual(head, confirmation);
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

test("an interrupted dispatch cannot acknowledge retained obsolete field claims after both stores reopen", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 901);
  h.runtime.outbox.complete = h.runtime.outbox.fail = async () => {
    throw Error("synthetic field acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic field acknowledgment loss/);
  const first = await savedPublication(h);
  await retainLegacyField(h, first, "exact");
  const operation = (await h.db.query("SELECT event_key,operation FROM leaderboard_ingestion.outbox")).rows[0];
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  equalJSONValues(h);
  await restart(h, async (runtime) => {
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
    await assertField(runtime, h.metric, 0, fresh.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("final dispatch acknowledgment rejects field authority changed after publication despite a forged confirmation marker", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 902);
  const complete = h.runtime.outbox.complete.bind(h.runtime.outbox);
  let changes = 0,
    first;
  h.runtime.outbox.complete = async (...args) => {
    first = await savedPublication(h);
    await retainLegacyField(h, first, "exact");
    h.controlsStore.transaction((state) => {
      for (const entry of [state.pipelinePublications[first.snapshotId], ...Object.values(state.pipelineHeads)])
        if (entry.snapshotId === first.snapshotId) entry.fieldChangeNormalizationVersion = version;
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

test("operator replay reconstructs the field-version content and rechecks it after an awaited observer", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", {
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
    /fieldChangeNormalizationVersion|normalizationHashes|normalizationSources/,
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
          delete state.pipelinePublications[first.snapshotId].fieldChangeNormalizationVersion;
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
  await retainLegacyField(h, first, "exact");
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[first.snapshotId].fieldChangeNormalizationVersion = version;
  });
  await restart(h, async (runtime) => {
    const denied = await runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
    assert.equal(denied.status, "unavailable");
    assert.equal(denied.reason, "publication_verification_unavailable");
    assert.deepEqual(denied.publications, []);
  });
});

test("an unrelated public metric preserves its views while private replay rejects stale field facts anywhere in the input", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", {
    includeIssueCreation: true,
    configure(config) {
      config.policies = config.policies.filter((entry) => entry.policy.metricId === "issues_opened");
    },
  });
  const first = (await h.runtime.runOnce()).publications[0];
  await assertField(h.runtime, "issues_opened", 1, first.snapshotId);
  const responses = await Promise.all(
    paths("issues_opened").map(async (path) => (await h.runtime.app.inject(path)).body),
  );
  const legacy = await retainLegacyField(h, first, "exact");
  assert.ok(legacy.document.facts.some((fact) => fact.metricId === h.metric));
  const explanation = new AggregateExplanationStore(h.controlsStore).read(first.snapshotId).document;
  assert.ok(explanation.references.length > 0);
  assert.ok(explanation.references.every((entry) => entry.metricId === "issues_opened"));
  equalJSONValues(h);
  await restart(h, async (runtime) => {
    assert.deepEqual(
      await Promise.all(paths("issues_opened").map(async (path) => (await runtime.app.inject(path)).body)),
      responses,
    );
    await assertField(runtime, "issues_opened", 1, first.snapshotId);
    await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), {
      status: 409,
      message: "Frozen field change normalization obsolete",
    });
    await assert.rejects(
      runtime.aggregateExplanations.read(first.snapshotId),
      /Frozen field change normalization obsolete/,
    );
    const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
    await assert.rejects(
      runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
        assert.fail("unselected obsolete field facts reached private replay"),
      ),
      /Frozen field change normalization obsolete/,
    );
    const fresh = (await runtime.runOnce()).publications[0];
    assert.notEqual(fresh.snapshotId, first.snapshotId);
    await assertField(runtime, "issues_opened", 1, fresh.snapshotId);
    await assertField(runtime, "issues_opened", 1, first.snapshotId);
    await runtime.previewPolicy(previewRequest(h, fresh.snapshotId));
    await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), {
      status: 409,
      message: "Frozen field change normalization obsolete",
    });
  });
});

test("a SQL commit without SQLite confirmation cannot recover obsolete frozen field inputs", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 904);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const result = change(state);
      if (state.pipelinePublications) throw Error("synthetic field SQLite confirmation loss");
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
  await retainLegacyField(h, first, "exact");
  equalJSONValues(h);
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()-interval '1 second'");
  await restart(h, async (runtime, controlsStore) => {
    const beforeHydrations = h.state.hydrations;
    assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
    assert.ok(h.state.hydrations > beforeHydrations, "the preceding field source is actually normalized on retry");
    assert.equal(controlsStore.read().pipelinePublications?.[first.snapshotId], undefined);
    assert.equal(controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    assert.equal((await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox")).rows[0].completion, null);
    await assertDenied(runtime, h.metric, first.snapshotId);
    const recovered = (await runtime.runOnce()).publications[0];
    assert.notEqual(recovered.snapshotId, first.snapshotId);
    await assertField(runtime, h.metric, 0, recovered.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("acknowledging a corrected empty-field cache preserves its confirmed version identity", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true, webhookDispatch: true });
  const first = (await h.runtime.runOnce()).publications[0];
  await retainLegacyField(h, first, "exact");
  equalJSONValues(h);
  const corrected = (await h.runtime.runOnce()).publications[0];
  await assertField(h.runtime, h.metric, 0, corrected.snapshotId);
  await insertDelivery(h, 905);
  h.runtime.outbox.complete = h.runtime.outbox.fail = async () => {
    throw Error("synthetic empty-field acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic empty-field acknowledgment loss/);
  const pending = await savedPublication(h);
  const confirmation = h.controlsStore.read().pipelinePublications[pending.snapshotId];
  assert.equal(confirmation.fieldChangeNormalizationVersion, version);
  const beforeCount = (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n;
  assert.equal(beforeCount, 3);
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  await restart(h, async (runtime, controlsStore) => {
    assert.equal(await runtime.dispatchOnce(), "processed");
    assert.deepEqual(controlsStore.read().pipelinePublications[pending.snapshotId], confirmation);
    assert.equal(
      controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(publicScope)]
        .fieldChangeNormalizationVersion,
      version,
    );
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n,
      beforeCount,
    );
    assert.equal((await h.db.query("SELECT state FROM leaderboard_ingestion.outbox")).rows[0].state, "done");
    await assertField(runtime, h.metric, 0, pending.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("a captured custom provider cannot become builtin when its option is removed during normalization", async (t) => {
  let returned = 0;
  const h = await fieldHarness(t, "issue_field_changed", {
    fieldChangeNormalizationVersion: version,
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
        delete options.fieldChangeNormalizationVersion;
        returned++;
        return output;
      };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /field_change_normalizer_version_unverified/);
  assert.equal(returned, 1);
  assert.deepEqual(await caches(h), []);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
});

test("field provider compatibility is checked inside final visibility before exact same-cutoff recovery", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true, memoryDatabase: true });
  const cutoff = clock();
  let armed = false,
    changed = false;
  const databaseTransaction = h.db.transaction;
  h.db.transaction = async (work) => {
    let insertedSnapshot = false;
    const result = await databaseTransaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          insertedSnapshot ||= /INSERT\s+INTO\s+leaderboard_pipeline\.snapshots/i.test(sql);
          return value;
        },
      }),
    );
    if (insertedSnapshot) armed = true;
    return result;
  };
  const controlsTransaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (work, options) =>
    controlsTransaction((state) => {
      if (armed && !changed) {
        delete h.options.fieldChangeNormalizationVersion;
        changed = true;
      }
      return work(state);
    }, options);

  await assert.rejects(h.runtime.runOnce({ cutoff }), /field_change_normalizer_version_unverified/);
  assert.equal(changed, true, "the declaration is lost inside final SQLite visibility, after SQL commits");
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows;
  const frozen = (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs")).rows;
  const savedCaches = await caches(h);
  const savedSource = await sourceRow(h);
  const hydrations = h.state.hydrations;
  assert.equal(saved.length, 1);
  assert.equal(frozen.length, 1);
  assert.equal(savedCaches.length, 1);
  assert.equal(fieldRows(savedCaches).length, 1);
  assert.equal(hydrations, 1, "the real selected normalizer produced the field claim");
  assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
  assert.deepEqual(h.controlsStore.read().pipelineHeads ?? {}, {});
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n, 0);
  assert.notEqual((await h.runtime.app.inject(paths(h.metric)[0])).statusCode, 200);

  h.options.fieldChangeNormalizationVersion = version;
  const recovered = (await h.runtime.runOnce({ cutoff })).publications[0];
  assert.equal(recovered.snapshotId, saved[0].snapshot_id);
  assert.equal(h.state.hydrations, hydrations, "same-cutoff recovery reuses only the still-current exact cache");
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows, saved);
  assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs")).rows, frozen);
  assert.deepEqual(await caches(h), savedCaches);
  assert.deepEqual(await sourceRow(h), savedSource);
  assert.equal(
    h.controlsStore.read().pipelinePublications[recovered.snapshotId].fieldChangeNormalizationVersion,
    version,
  );
  await assertField(h.runtime, h.metric, 1, recovered.snapshotId);
});

test("confirmed field dispatch retains immutable authority after its producer declaration disappears", async (t) => {
  const h = await fieldHarness(t, "issue_field_changed", { includeIssueCreation: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 906);
  h.runtime.outbox.complete = h.runtime.outbox.fail = async () => {
    throw Error("synthetic field declaration acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic field declaration acknowledgment loss/);
  const first = await savedPublication(h);
  const confirmation = structuredClone(h.controlsStore.read().pipelinePublications[first.snapshotId]);
  assert.equal(confirmation.fieldChangeNormalizationVersion, version);
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows;
  const frozen = (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs")).rows;
  const savedCaches = await caches(h);
  const hydrations = h.state.hydrations;
  const request = previewRequest(h, first.snapshotId);
  const preview = await h.runtime.previewPolicy(request);
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  delete h.options.fieldChangeNormalizationVersion;

  await restart(h, async (runtime, controlsStore) => {
    assert.equal(await runtime.dispatchOnce(), "processed");
    assert.deepEqual(controlsStore.read().pipelinePublications[first.snapshotId], confirmation);
    assert.deepEqual(
      controlsStore.read().pipelineHeads[components.contracts.publicScopeKey(publicScope)],
      confirmation,
    );
    assert.equal(
      h.state.hydrations,
      hydrations,
      "acknowledging confirmed history does not invoke the withdrawn producer",
    );
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots")).rows, saved);
    assert.deepEqual((await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs")).rows, frozen);
    assert.deepEqual(await caches(h), savedCaches);
    assert.equal((await h.db.query("SELECT state FROM leaderboard_ingestion.outbox")).rows[0].state, "done");
    await assertField(runtime, h.metric, 1, first.snapshotId);
    assert.deepEqual(await runtime.previewPolicy(request), preview);
    await assert.rejects(runtime.runOnce(), /field_change_normalizer_version_unverified/);
    await assertField(runtime, h.metric, 1, first.snapshotId);
  });
});
