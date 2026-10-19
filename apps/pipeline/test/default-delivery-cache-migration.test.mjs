import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import { ago, clock, components, harness, publicScope, fixtureId } from "./harness.mjs";
import {
  deliveryHarness,
  assertDenied,
  assertMetric,
  retainLegacyDelivery,
  restart,
  previewRequest,
  paths,
  version,
  legacySignature,
  currentSignature,
  deliveryMetrics,
  after,
} from "./default-delivery-fixtures.mjs";

for (const family of ["commit", "pull_request", "issue"])
  test(
    family + ": obsolete default-delivery authority is denied after actual reopen and retained sources recover",
    async (t) => {
      for (const bindingMode of ["exact", "hash-only", "unbound"])
        await t.test(bindingMode, async (t) => {
          const h = await deliveryHarness(t, family);
          const cutoff = clock();
          const first = (await h.runtime.runOnce({ cutoff })).publications[0];
          assert.ok(first, "the valid synthetic source must publish");
          await assertMetric(h.runtime, h.metric, h.expected);
          await h.runtime.previewPolicy(previewRequest(h, first.snapshotId));
          const legacy = await retainLegacyDelivery(h, first, bindingMode);
          const oldSnapshot = (
            await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
              first.snapshotId,
            ])
          ).rows[0];
          h.state.defaultBranch = undefined;
          const hydrations = h.state.hydrations;
          await restart(h, async (runtime, controlsStore) => {
            await assertDenied(runtime, h.metric, first.snapshotId);
            await assert.rejects(runtime.previewPolicy(previewRequest(h, first.snapshotId)), /policy_input_revoked/);
            await assert.rejects(
              runtime.aggregateExplanations.read(first.snapshotId),
              /Frozen (default.delivery|normalization).* (obsolete|unavailable)/,
            );
            const input = runtime.policyComparisons.comparisons.input(legacy.inputId);
            await assert.rejects(
              runtime.policyComparisons.withAuthorizedInputs([input.authorization], () =>
                assert.fail("legacy private input gained authority"),
              ),
              /Frozen (default.delivery|normalization).* (obsolete|unavailable)/,
            );
            controlsStore.transaction((state) => {
              state.pipelinePublications[first.snapshotId].defaultDeliveryNormalizationVersion = version;
              Object.values(state.pipelineHeads).forEach((head) => {
                head.defaultDeliveryNormalizationVersion = version;
              });
            });
            await assertDenied(runtime, h.metric, first.snapshotId);
            const rebuilt = (await runtime.runOnce({ cutoff })).publications[0];
            assert.notEqual(rebuilt.snapshotId, first.snapshotId);
            assert.ok(
              h.state.hydrations > hydrations,
              "the unchanged source must be rehydrated after the source-only fix",
            );
            assert.equal(
              (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n,
              1,
            );
            await assertMetric(runtime, h.metric, 0);
            await assertMetric(runtime, h.metric, 0, rebuilt.snapshotId);
            await assertDenied(runtime, h.metric, first.snapshotId, false);
            await runtime.previewPolicy(previewRequest(h, rebuilt.snapshotId));
            await runtime.aggregateExplanations.read(rebuilt.snapshotId);
            const rows = (
              await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature")
            ).rows;
            assert.equal(rows.length, 2);
            const retained = rows.find((row) => row.policy_signature === legacy.signature);
            assert.deepEqual(retained.document, legacy.document);
            assert.equal(retained.document_hash, legacy.documentHash);
            const current = rows.find((row) => row.policy_signature !== legacy.signature);
            assert.equal(current.policy_signature, comparisonHash([version, currentSignature(h.config)]));
            assert.equal(current.document.defaultDeliveryNormalizationVersion, version);
            assert.equal(
              current.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
              false,
            );
            assert.deepEqual(
              (
                await h.db.query(
                  "SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1",
                  [first.snapshotId],
                )
              ).rows[0],
              oldSnapshot,
            );
            h.state.defaultBranch = "main";
            h.state.revision = after + "-recovered";
            const recovered = (await runtime.runOnce()).publications[0];
            await assertMetric(runtime, h.metric, h.expected);
            await runtime.previewPolicy(previewRequest(h, recovered.snapshotId));
            await assertDenied(runtime, h.metric, first.snapshotId, false);
          });
        });
    },
  );

test("unrelated issue caches and bound private views keep their generation and historical public behavior", async (t) => {
  const h = await harness(t, { authorizePolicyPreview: async () => true });
  const cutoff = clock();
  const publication = (await h.runtime.runOnce({ cutoff })).publications[0];
  const beforeRows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.ok(beforeRows.every((row) => row.policy_signature === currentSignature(h.config)));
  assert.ok(beforeRows.every((row) => row.document.defaultDeliveryNormalizationVersion === undefined));
  const before = await Promise.all(paths("issues_opened").map(async (path) => (await h.runtime.app.inject(path)).body));
  const preview = await h.runtime.previewPolicy(previewRequest(h, publication.snapshotId));
  await restart(h, async (runtime) => {
    assert.deepEqual(
      await Promise.all(paths("issues_opened").map(async (path) => (await runtime.app.inject(path)).body)),
      before,
    );
    assert.deepEqual(await runtime.previewPolicy(previewRequest(h, publication.snapshotId)), preview);
    assert.equal((await runtime.runOnce({ cutoff })).publications[0].snapshotId, publication.snapshotId);
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
      beforeRows,
    );
    await h.db.query("DELETE FROM leaderboard_pipeline.normalizations");
    for (const path of paths("issues_opened"))
      assert.equal((await runtime.app.inject(path + "&snapshot=" + publication.snapshotId)).statusCode, 200);
  });
});

test("custom normalizers cannot assert default-delivery semantics through an output marker alone", async (t) => {
  for (const family of ["commit", "issue"])
    await t.test(family, async (t) => {
      let calls = 0;
      const h = await deliveryHarness(t, family, {
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
            return { ...(await builtin(input)), defaultDeliveryNormalizationVersion: version };
          };
        },
      });
      await assert.rejects(h.runtime.runOnce(), /default_delivery_normalizer_version_unverified/);
      if (family === "issue") assert.equal(calls, 1, "a generic source's forged output marker is actually examined");
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n,
        0,
      );
      const qualified = await createPipeline({ ...h.options, defaultDeliveryNormalizationVersion: version });
      try {
        assert.equal((await qualified.runOnce()).state, "published");
        await assertMetric(qualified, h.metric, h.expected);
        assert.ok(calls > 0);
      } finally {
        await qualified.stop();
      }
      await assert.rejects(h.runtime.runOnce(), /default_delivery_normalizer_version_unverified/);
    });
});

test("an older builtin component cannot acquire delivery authority from the host option", async (t) => {
  const h = await deliveryHarness(t, "issue", {
    components: { ...components, github: { ...components.github, defaultDeliveryNormalizationVersion: undefined } },
    defaultDeliveryNormalizationVersion: version,
  });
  await assert.rejects(h.runtime.runOnce(), /default_delivery_normalizer_version_unverified/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n, 0);
});

for (const [family, metric] of [
  ["commit", "direct_changes"],
  ["pull_request", "pr_lines_added"],
  ["pull_request", "pr_lines_removed"],
  ["issue", "files_changed"],
])
  test(metric + ": retained public delivery claims require the current bound normalization", async (t) => {
    const h = await deliveryHarness(t, family, { deliveryMetric: metric });
    const first = (await h.runtime.runOnce()).publications[0];
    await assertMetric(h.runtime, metric, h.expected);
    await retainLegacyDelivery(h, first, "exact");
    h.state.defaultBranch = undefined;
    await restart(h, async (runtime) => {
      await assertDenied(runtime, metric, first.snapshotId);
      const fresh = (await runtime.runOnce()).publications[0];
      await assertMetric(runtime, metric, 0, fresh.snapshotId);
      await assertDenied(runtime, metric, first.snapshotId, false);
    });
  });

test("selected delivery history and the current head each bind their own exact frozen input", async (t) => {
  const h = await deliveryHarness(t, "issue");
  const first = (await h.runtime.runOnce()).publications[0];
  h.state.revision = after + "-second";
  const head = (await h.runtime.runOnce()).publications[0];
  assert.notEqual(first.snapshotId, head.snapshotId);
  const saved = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [first.snapshotId])
  ).rows[0];
  const replace = (snapshotId, document, hash = comparisonHash(document)) =>
    h.db.query(
      "UPDATE leaderboard_pipeline.frozen_inputs SET document=$2::jsonb,document_hash=$3 WHERE snapshot_id=$1",
      [snapshotId, JSON.stringify(document), hash],
    );
  for (const change of [
    (document) => {
      document.scope = { ...publicScope, repository: "2" };
    },
    (document) => {
      document.frozen.datasetId = "synthetic-other-dataset";
    },
    (document) => {
      document.frozen.cutoff = ago(1);
    },
    (document) => {
      document.frozen.backfillRevision = "f".repeat(64);
    },
    (document) => {
      document.identityAuthorization.identityEvidence.normalizationSources[0].factKey = "e".repeat(64);
    },
    (document) => {
      document.identityAuthorization.sources[0].generation = "999";
    },
  ]) {
    const changed = structuredClone(saved.document);
    change(changed);
    await replace(first.snapshotId, changed);
    await assert.rejects(
      h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal),
      /public_default_delivery_frozen_input_integrity_error/,
    );
    await assertMetric(h.runtime, h.metric, h.expected);
    for (const path of paths(h.metric)) {
      const reply = await h.runtime.app.inject(path + "&snapshot=" + first.snapshotId);
      assert.notEqual(reply.statusCode, 200);
      assert.doesNotMatch(reply.body, /normalizationSources|synthetic-/);
    }
    await replace(first.snapshotId, saved.document, saved.document_hash);
  }
  const headSaved = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [head.snapshotId])
  ).rows[0];
  await replace(head.snapshotId, saved.document, headSaved.document_hash);
  await assert.rejects(
    h.runtime.source.read(publicScope, first.snapshotId, new AbortController().signal),
    /public_default_delivery_frozen_input_integrity_error/,
  );
  await replace(head.snapshotId, headSaved.document, headSaved.document_hash);
  await assertMetric(h.runtime, h.metric, h.expected, first.snapshotId);
});

test("another valid delivery row cannot conceal an old row whose affected facts were corrupted away", async (t) => {
  const h = await deliveryHarness(t, "commit");
  await h.runtime.stop();
  const original = h.options.source;
  const second = "d".repeat(40);
  const options = {
    ...h.options,
    source: {
      async readPage(request) {
        const page = await original.readPage(request);
        return {
          ...page,
          expectedCount: 2,
          facts: [
            page.facts[0],
            {
              ...page.facts[0],
              subjectId: second,
              sourceRevision: second,
              sourceUrl: page.facts[0].sourceUrl.replace(after, second),
            },
          ],
        };
      },
    },
    githubEnrich: async (input) => {
      const envelope = await h.enrich(input);
      if (input.fact.subjectId === second) {
        envelope.payload.sha = second;
        envelope.payload.html_url = input.fact.sourceUrl;
        envelope.integration.after = second;
        envelope.integration.commitShas = [second];
        envelope.integration.canonicalChangeId += "-second";
      }
      return envelope;
    },
  };
  h.runtime = await createPipeline(options);
  t.after(() => h.runtime.stop());
  const first = (await h.runtime.runOnce()).publications[0];
  await assertMetric(h.runtime, h.metric, 2);
  const legacy = await retainLegacyDelivery(h, first, "exact");
  await assertDenied(h.runtime, h.metric, first.snapshotId);
  const corrupted = { ...legacy.document, facts: [] };
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb WHERE fact_key=$1 AND policy_signature=$2",
    [legacy.factKey, legacy.signature, JSON.stringify(corrupted)],
  );
  const retained = (await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.normalizations")).rows;
  assert.equal(retained.length, 2);
  assert.equal(
    retained.filter((row) => row.document.facts.some((fact) => fact.metricId === "commits_integrated")).length,
    1,
  );
  assert.ok(retained.some((row) => comparisonHash(row.document) !== row.document_hash));
  await assert.rejects(
    h.runtime.source.read(publicScope, null, new AbortController().signal),
    /Frozen identity evidence integrity failure/,
  );
  for (const path of paths(h.metric))
    for (const suffix of ["", "&snapshot=" + first.snapshotId]) {
      const reply = await h.runtime.app.inject(path + suffix);
      assert.equal(reply.statusCode, 503, "corrupt evidence reports projection unavailability");
      assert.doesNotMatch(reply.body, /normalizationSources|document_hash|synthetic-/);
    }
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
  const saved = (
    await h.db.query("SELECT snapshot_id,revision FROM leaderboard_pipeline.snapshots ORDER BY revision DESC LIMIT 1")
  ).rows[0];
  assert.ok(saved, "the dispatch must have actually committed its SQL snapshot");
  const input = h.controlsStore.db
    .prepare("SELECT id,document FROM policy_preview_inputs")
    .all()
    .find((row) => JSON.parse(row.document).snapshot.snapshotId === saved.snapshot_id);
  return {
    snapshotId: saved.snapshot_id,
    revision: Number(saved.revision),
    ...(input ? { comparisonInput: { inputId: input.id } } : {}),
  };
}

test("an interrupted dispatch cannot acknowledge obsolete enriched-issue delivery after both databases reopen", async (t) => {
  const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 751);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic loss before acknowledgment");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic loss before acknowledgment");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic loss before acknowledgment/);
  const first = await savedPublication(h);
  await assertMetric(h.runtime, h.metric, h.expected);
  await retainLegacyDelivery(h, first, "exact");
  const operation = (await h.db.query("SELECT event_key,operation FROM leaderboard_ingestion.outbox")).rows[0];
  await h.db.query(
    "UPDATE leaderboard_ingestion.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'",
  );
  await restart(h, async (runtime, controlsStore) => {
    await assertDenied(runtime, h.metric, first.snapshotId);
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
    await assertMetric(runtime, h.metric, h.expected);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
    await h.db.query(
      "UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()+interval '1 hour' WHERE event_key=$1",
      [operation.event_key],
    );
    await insertDelivery({ ...h, runtime, controlsStore }, 752);
    assert.equal(await runtime.dispatchOnce(), "processed");
    const done = (await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox WHERE state='done'")).rows[0];
    assert.ok(done.completion.publications.every((publication) => publication.snapshotId !== first.snapshotId));
    await assertMetric(runtime, h.metric, h.expected);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("the final dispatch acknowledgment rechecks actual delivery normalization after publication", async (t) => {
  const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 761);
  const complete = h.runtime.outbox.complete.bind(h.runtime.outbox);
  let first,
    checks = 0;
  h.runtime.outbox.complete = async (...args) => {
    checks++;
    first = await savedPublication(h);
    await assertMetric(h.runtime, h.metric, h.expected);
    await retainLegacyDelivery(h, first, "exact");
    h.controlsStore.transaction((state) => {
      state.pipelinePublications[first.snapshotId].defaultDeliveryNormalizationVersion = version;
      Object.values(state.pipelineHeads).forEach((head) => {
        head.defaultDeliveryNormalizationVersion = version;
      });
    });
    return complete(...args);
  };
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  assert.equal(checks, 1);
  const row = (await h.db.query("SELECT state,completion,reason_code FROM leaderboard_ingestion.outbox")).rows[0];
  assert.equal(row.state, "pending");
  assert.equal(row.completion, null);
  assert.equal(row.reason_code, "publication_unavailable");
  await assertDenied(h.runtime, h.metric, first.snapshotId);
});

test("a SQL commit without SQLite confirmation cannot recover obsolete frozen delivery inputs", async (t) => {
  const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true, webhookDispatch: true });
  assert.equal(await h.runtime.collection.verifyPublic(2, 1, null), true);
  await insertDelivery(h, 771);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      const result = change(state);
      if (state.pipelinePublications) throw Error("synthetic SQLite confirmation loss");
      return result;
    }, options);
  assert.equal(await h.runtime.dispatchOnce(), "retry_scheduled");
  h.controlsStore.transaction = transaction;
  const first = await savedPublication(h);
  assert.equal(first.comparisonInput, undefined);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n, 0);
  await retainLegacyDelivery(h, first, "exact");
  await h.db.query("UPDATE leaderboard_ingestion.outbox SET available_at=clock_timestamp()-interval '1 second'");
  await restart(h, async (runtime, controlsStore) => {
    const beforeHydrations = h.state.hydrations;
    assert.equal(await runtime.dispatchOnce(), "retry_scheduled");
    assert.ok(h.state.hydrations > beforeHydrations, "the obsolete source is actually normalized on retry");
    assert.equal(controlsStore.read().pipelinePublications?.[first.snapshotId], undefined);
    assert.equal(controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    assert.equal((await h.db.query("SELECT completion FROM leaderboard_ingestion.outbox")).rows[0].completion, null);
    await assertDenied(runtime, h.metric, first.snapshotId);
    const recovery = (await runtime.runOnce()).publications[0];
    assert.notEqual(recovery.snapshotId, first.snapshotId);
    await assertMetric(runtime, h.metric, h.expected);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("delivery and review generations compose on the same enriched review source", async (t) => {
  const h = await deliveryHarness(t, "pull_request");
  await h.runtime.stop();
  const original = h.options.source;
  const config = structuredClone(h.config);
  config.repositories[0].families = ["reviews"];
  const subjectId = "PRR_SYNTHETIC_DELIVERY_51";
  const options = {
    ...h.options,
    config,
    reviewSourceNormalizationVersion: components.github.reviewSourceNormalizationVersion,
    source: {
      async readPage(request) {
        assert.equal(request.family, "reviews");
        const page = await original.readPage({ ...request, family: "pull_requests" });
        return {
          ...page,
          facts: page.facts.map((fact) => ({
            ...fact,
            subjectId,
            sourceUrl: fact.sourceUrl + "#pullrequestreview-51",
          })),
        };
      },
    },
    githubEnrich: async (input) => {
      const envelope = await h.enrich(input);
      envelope.family = "review";
      envelope.action = "submitted";
      envelope.payload.review = {
        id: 51,
        node_id: subjectId,
        user: { id: 303, node_id: "U_SYNTHETIC_REVIEWER", login: "synthetic-reviewer", type: "User" },
        state: "COMMENTED",
        commit_id: after,
        submitted_at: h.at,
        created_at: h.at,
        html_url: input.fact.sourceUrl,
        pull_request_url: "https://api.github.com/repos/synthetic-org/synthetic-repo/pulls/10",
      };
      envelope.reviewParticipation = { verified: true, firstSubmittedAt: h.at, roundFirstSubmittedAt: h.at };
      return envelope;
    },
  };
  h.options = options;
  h.config = config;
  h.sourceFamily = "reviews";
  h.runtime = await createPipeline(options);
  t.after(() => h.runtime.stop());
  const first = (await h.runtime.runOnce()).publications[0];
  await assertMetric(h.runtime, h.metric, h.expected);
  const base = comparisonHash([components.github.reviewSourceNormalizationVersion, currentSignature(config)]);
  const previousBase = comparisonHash([components.github.reviewSourceNormalizationVersion, legacySignature(config)]);
  const originalRow = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
  assert.equal(originalRow.policy_signature, comparisonHash([version, base]));
  assert.equal(
    originalRow.document.reviewSourceNormalizationVersion,
    components.github.reviewSourceNormalizationVersion,
  );
  assert.ok(originalRow.document.facts.some((fact) => fact.metricId === "review_feedback"));
  const legacy = await retainLegacyDelivery(h, first, "exact");
  assert.equal(legacy.signature, previousBase);
  h.state.defaultBranch = undefined;
  await restart(h, async (runtime) => {
    await assertDenied(runtime, h.metric, first.snapshotId);
    await runtime.runOnce();
    await assertMetric(runtime, h.metric, 0);
    const rows = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(rows.length, 2);
    const fresh = rows.find((row) => row.policy_signature === comparisonHash([version, base]));
    assert.ok(fresh.document.facts.some((fact) => fact.metricId === "review_feedback"));
    assert.equal(
      fresh.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
      false,
    );
    assert.equal(fresh.document.reviewSourceNormalizationVersion, components.github.reviewSourceNormalizationVersion);
    assert.deepEqual(rows.find((row) => row.policy_signature === previousBase).document, legacy.document);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});

test("an empty v1 Project delivery wrapper remains wrapped after fresh scope normalization", async (t) => {
  const h = await deliveryHarness(t, "issue");
  const first = (await h.runtime.runOnce()).publications[0];
  await retainLegacyDelivery(h, first, "exact");
  h.state.defaultBranch = undefined;
  const empty = (await h.runtime.runOnce()).publications[0];
  await assertMetric(h.runtime, h.metric, 0);
  const current = comparisonHash([version, currentSignature(h.config)]);
  const previous = comparisonHash([version, legacySignature(h.config)]);
  const corrected = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE policy_signature=$1", [current])
  ).rows[0];
  assert.equal(corrected.document.defaultDeliveryNormalizationVersion, version);
  assert.equal(
    corrected.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
    false,
  );
  // This disposable fixture changes only the generation of an actual corrected
  // empty document. The earlier positive base row remains separately retained.
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2 WHERE fact_key=$1 AND policy_signature=$3",
    [corrected.fact_key, previous, current],
  );
  const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY policy_signature"))
    .rows;
  const frozen = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [empty.snapshotId])
  ).rows[0];
  const privateBefore = await h.runtime.previewPolicy(previewRequest(h, empty.snapshotId));
  const hydrations = h.state.hydrations;
  await restart(h, async (runtime) => {
    await assertMetric(runtime, h.metric, 0, empty.snapshotId);
    assert.deepEqual(await runtime.previewPolicy(previewRequest(h, empty.snapshotId)), privateBefore);
    await runtime.runOnce();
    assert.ok(h.state.hydrations > hydrations, "the old scope generation must be rehydrated");
    const fresh = (
      await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE policy_signature=$1", [current])
    ).rows[0];
    assert.equal(fresh.document.defaultDeliveryNormalizationVersion, version);
    assert.equal(
      fresh.document.facts.some((fact) => deliveryMetrics.includes(fact.metricId)),
      false,
    );
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT * FROM leaderboard_pipeline.normalizations WHERE policy_signature<>$1 ORDER BY policy_signature",
          [current],
        )
      ).rows,
      retained,
    );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [empty.snapshotId]))
        .rows[0],
      frozen,
    );
  });
});

for (const mutation of ["hash", "mode"])
  test(`a v1 Project delivery migration hint rejects ${mutation} corruption before hydration`, async (t) => {
    const h = await deliveryHarness(t, "issue");
    await h.runtime.runOnce();
    const row = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows[0];
    const document = { ...row.document, isSynthetic: false };
    const hash = mutation === "hash" ? row.document_hash : comparisonHash(document);
    const previous = comparisonHash([version, legacySignature(h.config)]);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$2,document=$3::jsonb,document_hash=$4 WHERE fact_key=$1",
      [row.fact_key, previous, JSON.stringify(document), hash],
    );
    const hydrations = h.state.hydrations;
    await assert.rejects(
      h.runtime.runOnce(),
      mutation === "hash" ? /normalization_integrity_error/ : /normalization_data_mode_mismatch/,
    );
    assert.equal(h.state.hydrations, hydrations);
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS count FROM leaderboard_pipeline.normalizations")).rows[0].count,
      1,
    );
  });

test("acknowledging a corrected empty-delivery cache preserves its confirmed version identity", async (t) => {
  const h = await deliveryHarness(t, "issue", { includeIssuePolicy: true, webhookDispatch: true });
  const first = (await h.runtime.runOnce()).publications[0];
  await retainLegacyDelivery(h, first, "exact");
  h.state.defaultBranch = undefined;
  const corrected = (await h.runtime.runOnce()).publications[0];
  await assertMetric(h.runtime, h.metric, 0, corrected.snapshotId);
  await insertDelivery(h, 781);
  h.runtime.outbox.complete = async () => {
    throw Error("synthetic empty-delivery acknowledgment loss");
  };
  h.runtime.outbox.fail = async () => {
    throw Error("synthetic empty-delivery acknowledgment loss");
  };
  await assert.rejects(h.runtime.dispatchOnce(), /synthetic empty-delivery acknowledgment loss/);
  const pending = await savedPublication(h);
  const confirmation = h.controlsStore.read().pipelinePublications[pending.snapshotId];
  assert.equal(confirmation.defaultDeliveryNormalizationVersion, version);
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
        .defaultDeliveryNormalizationVersion,
      version,
    );
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n,
      beforeCount,
    );
    await assertMetric(runtime, h.metric, 0, pending.snapshotId);
    await assertDenied(runtime, h.metric, first.snapshotId, false);
  });
});
