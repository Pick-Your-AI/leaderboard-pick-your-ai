import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createPipeline } from "../src/index.mjs";
import {
  AggregateExplanationStore,
  aggregateExplanationHash,
  aggregateExplanationLimitsV1,
  buildAggregateExplanation,
} from "../src/aggregate-explanations.mjs";
import { harness, components, clock, ago, boardUrl, fixtureId } from "./harness.mjs";
import { comparisonLimitsV1 } from "../../controls/src/policy-comparison.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const metricPolicy = (metricId, aggregation, patch = {}) => ({
  metricId,
  version: "synthetic-arithmetic-v1",
  definitionVersion: components.metrics.metricRegistryV1.policy_version,
  unit: components.metrics.getMetricDefinition(metricId).definition.unit,
  aggregation,
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "actor_artifact",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: aggregation === "count" || aggregation === "sum",
  ...patch,
});
async function arithmeticHarness(t) {
  const h = await harness(t);
  const config = structuredClone(h.config);
  config.policies = [
    metricPolicy("pr_merged", "count"),
    metricPolicy("pr_lines_changed", "sum"),
    metricPolicy("pr_accepted_rate", "ratio", { rankedStates: ["observed"] }),
    metricPolicy("review_wait", "duration", { dateBasis: "occurredAt", rankedStates: ["observed"] }),
  ].map((policy) => ({
    policy,
    signature: components.metrics.stableJSON(policy),
    approvalReceipt: "synthetic-approval",
  }));
  const at = ago(3),
    ready = ago(2);
  const facts = [];
  const add = (metricId, id, patch = {}) => {
    facts.push({
      id: `synthetic-${id}`,
      canonicalKey: `synthetic-key-${id}`,
      metricId,
      actorId: "101",
      artifactId: `SYNTHETIC_PR_${id}`,
      repoId: "2",
      role: "author",
      state: "qualified",
      occurredAt: at,
      acceptedAt: at,
      observedAt: at,
      revision: 0,
      correctionReceipt: null,
      acceptanceReceipt: "synthetic-private-acceptance",
      acceptedBy: "201",
      subjectActorId: "101",
      eventContext: null,
      currentContext: null,
      ...patch,
    });
  };
  for (let i = 0; i < 14; i++) add("pr_merged", `accepted-${i}`);
  for (let i = 0; i < 15; i++) add("pr_merged", `other-${i}`, { actorId: "102", subjectActorId: "102" });
  for (let i = 0; i < 3; i++) add("pr_merged", `pending-${i}`, { state: "pending", acceptedAt: null });
  add("pr_merged", "observed", { state: "observed" });
  add("pr_merged", "reviewed", { state: "reviewed" });
  add("pr_merged", "excluded", { state: "excluded" });
  add("pr_lines_changed", "lines-5", { quantity: 5 });
  add("pr_lines_changed", "lines-9", { quantity: 9 });
  facts.push({ ...facts.at(-1), id: "synthetic-duplicate-lines", observedAt: ago(2) });
  add("pr_lines_changed", "lines-missing", { actorId: "102", subjectActorId: "102" });
  for (const [i, outcome] of ["merged", "merged", "closed_unmerged", "pending", undefined].entries())
    add("pr_accepted_rate", `ratio-${i}`, {
      state: "observed",
      ...(outcome === undefined ? {} : { outcome }),
      ...(outcome === "pending" ? { acceptedAt: null } : {}),
    });
  for (const hours of [1, 3, 5, 9])
    add("review_wait", `duration-${hours}`, {
      state: "observed",
      readyAt: ready,
      firstReviewAt: new Date(Date.parse(ready) + hours * 3600000).toISOString(),
    });
  add("review_wait", "duration-censored", { state: "observed", readyAt: ready, firstReviewAt: null });
  add("review_wait", "duration-missing", { state: "observed", readyAt: null, firstReviewAt: null });
  add("review_wait", "duration-invalid", { state: "observed", readyAt: ready, firstReviewAt: at });
  const options = {
    ...h.options,
    config,
    // This protected synthetic provider deliberately supplies physical arithmetic facts.
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    normalizer: async ({ fact }) => {
      if (fact.subjectId !== "SYNTHETIC_ISSUE_1") return { facts: [], actors: [], evidence: [] };
      return {
        facts,
        actors: [101, 102].map((id) => ({
          id: String(id),
          githubDatabaseId: id,
          login: `synthetic-${id}`,
          kind: "user",
          publicState: "visible",
        })),
        evidence: facts.map((item, index) => ({
          artifact: {
            schemaVersion: "leaderboard/v1",
            source: "github",
            kind: "pull_request",
            stableId: item.artifactId,
            repositoryId: "2",
            publicUrl: `https://github.com/synthetic-org/synthetic-repo/pull/${index + 1}`,
            visibility: "public",
          },
          contribution: {
            schemaVersion: "leaderboard/v1",
            contributionId: item.id,
            canonicalEventId: item.canonicalKey,
            artifactId: item.artifactId,
            actorId: item.actorId,
            roles: ["author"],
            qualification: "eligible",
            metricIds: [item.metricId],
            reasonCodes: ["synthetic_arithmetic_fixture"],
          },
          occurredAt: item.occurredAt,
          sourceRevision: null,
          sourceRevisionUrl: null,
        })),
      };
    },
  };
  const runtime = await createPipeline(options);
  t.after(() => runtime.stop());
  return { ...h, runtime, options, facts };
}
const privateCount = (h) =>
  h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n;
const publicationId = (result) => result.publications[0].snapshotId;

test("required durable explanation reconciles actual pipeline counts, sums, ratios and duration samples without weighted ranks", async (t) => {
  const h = await arithmeticHarness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  const id = publicationId(first);
  const saved = await h.runtime.aggregateExplanations.read(id);
  const metric = (id) => saved.document.metrics.find((metric) => metric.metricId === id);
  const count = metric("pr_merged");
  assert.deepEqual(
    count.rows.map((row) => [row.actorId, row.value, row.pending, row.rank]),
    [
      ["102", 15, 0, 1],
      ["101", 14, 3, 2],
    ],
  );
  assert.equal(count.rows[1].eligible.length, 14);
  assert.equal(count.rows[1].pendingIds.length, 3);
  assert.deepEqual(
    count.audit
      .filter((entry) => entry.reason === "evidence_class_not_ranked")
      .flatMap((entry) => entry.factIds)
      .sort(),
    ["synthetic-observed", "synthetic-reviewed"],
  );
  const sum = metric("pr_lines_changed");
  assert.equal(sum.rows[0].value, 14);
  assert.deepEqual(
    sum.rows[0].eligible.map((entry) => entry.quantity),
    [5, 9],
  );
  assert.equal(sum.rows[1].value, null);
  assert.ok(sum.audit.some((entry) => entry.reason === "duplicate_observation"));
  const ratio = metric("pr_accepted_rate").rows[0];
  assert.deepEqual(
    [ratio.value, ratio.numerator, ratio.denominator, ratio.sampleCount, ratio.pending, ratio.rank],
    [2 / 3, 2, 3, 3, 1, null],
  );
  const duration = metric("review_wait").rows[0];
  assert.deepEqual(
    [duration.value, duration.p75, duration.sampleCount, duration.censored, duration.missingReadiness, duration.rank],
    [4, 5, 4, 1, 2, null],
  );
  assert.deepEqual(duration.samples, [1, 3, 5, 9]);
  assert.equal(duration.eligible.length, duration.sampleCount + duration.censored + duration.missingReadiness);
  for (const metric of saved.document.metrics) {
    assert.deepEqual(
      [...new Set(metric.audit.flatMap((entry) => entry.factIds))].sort(),
      h.facts
        .filter((fact) => fact.metricId === metric.metricId)
        .map((fact) => fact.id)
        .sort(),
    );
    const response = await h.runtime.app.inject(`/api/v1/boards?metric=${metric.metricId}`);
    assert.equal(response.statusCode, 200, response.body);
    for (const row of response.json().rows)
      assert.equal(row.result.value ?? null, metric.rows.find((item) => item.actorId === row.actorId).value);
    for (const secret of ["private-aggregate-explanation", "eligible", "synthetic-private-acceptance", saved.digest])
      assert.equal(response.body.includes(`"${secret}"`), false);
  }
  assert.equal(saved.document.snapshot.snapshotId, id);
  assert.equal(saved.document.snapshot.revision, first.publications[0].revision);
  assert.equal(saved.document.computationVersion, aggregateExplanationLimitsV1.computationVersion);
  assert.match(saved.document.snapshot.computationVersion, /^synthetic-pipeline-/);
  assert.equal(privateCount(h), 1);
  const serialized = JSON.stringify(saved.document);
  for (const forbidden of [
    "synthetic-private-acceptance",
    "synthetic-approval",
    "acceptedBy",
    "acceptanceReceipt",
    "correctionReceipt",
    "githubDatabaseId",
    "login",
    "publicUrl",
  ])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(JSON.stringify(h.controlsStore.publicSnapshot()).includes(saved.digest), false);
  const second = await h.runtime.runOnce({ cutoff });
  assert.equal(publicationId(second), id);
  assert.equal(second.publications[0].changed, false);
  assert.deepEqual(await h.runtime.aggregateExplanations.read(id), saved);
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const restarted = await createPipeline({ ...h.options, controlsStore: reopened });
  try {
    assert.deepEqual(await restarted.aggregateExplanations.read(id), saved);
    assert.equal((await restarted.app.inject(`/api/v1/boards?metric=pr_merged&snapshot=${id}`)).statusCode, 200);
  } finally {
    await restarted.stop();
    reopened.close();
  }
});

test("preview input exhaustion and expiry never remove required retained snapshot explanations", async (t) => {
  const h = await harness(t);
  const first = await h.runtime.runOnce();
  const id = publicationId(first);
  const before = await h.runtime.aggregateExplanations.read(id);
  const preview = h.controlsStore.db.prepare("SELECT * FROM policy_preview_inputs LIMIT 1").get();
  h.controlsStore.transaction(() => {
    for (let i = 1; i < comparisonLimitsV1.inputs; i++)
      h.controlsStore.db
        .prepare("INSERT INTO policy_preview_inputs VALUES(?,?,?,?)")
        .run(
          String(i).padStart(64, "0"),
          preview.document,
          preview.digest,
          Date.now() + comparisonLimitsV1.retentionMs,
        );
  });
  const next = await h.runtime.runOnce();
  assert.deepEqual(next.publications[0].comparisonInput, {
    state: "unavailable",
    reason: "frozen_input_capacity_reached",
  });
  assert.equal(privateCount(h), 2);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 200);
  assert.equal((await h.runtime.aggregateExplanations.read(publicationId(next))).document.metrics[0].rows[0].value, 1);
  h.controlsStore.transaction(() => {
    h.controlsStore.db.prepare("UPDATE policy_preview_inputs SET expires=0").run();
    h.runtime.policyComparisons.comparisons.prune();
  });
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
  assert.deepEqual(await h.runtime.aggregateExplanations.read(id), before);
});

for (const failure of ["write", "ignored_write", "readback", "confirmation"])
  test(`required explanation ${failure} failure rolls back all private confirmation writes`, async (t) => {
    const h = await harness(t);
    const cutoff = clock();
    if (failure !== "confirmation")
      h.controlsStore.db.exec(
        failure === "write"
          ? "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON pipeline_aggregate_explanations BEGIN SELECT RAISE(ABORT, 'synthetic_audit_write_failure'); END"
          : failure === "ignored_write"
            ? "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON pipeline_aggregate_explanations BEGIN SELECT RAISE(IGNORE); END"
            : "CREATE TRIGGER synthetic_audit_failure AFTER INSERT ON pipeline_aggregate_explanations BEGIN UPDATE pipeline_aggregate_explanations SET digest='corrupt' WHERE snapshot_id=NEW.snapshot_id; END",
      );
    const transaction = h.controlsStore.transaction.bind(h.controlsStore);
    if (failure === "confirmation")
      h.controlsStore.transaction = (change, options) =>
        transaction((state) => {
          change(state);
          throw Error("synthetic_confirmation_failure");
        }, options);
    await assert.rejects(
      h.runtime.runOnce({ cutoff }),
      /synthetic_audit_write_failure|aggregate_explanation_|synthetic_confirmation_failure/,
    );
    assert.equal(privateCount(h), 0);
    assert.deepEqual(h.controlsStore.read().pipelinePublications ?? {}, {});
    assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
    assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
    h.controlsStore.transaction = transaction;
    if (failure !== "confirmation") h.controlsStore.db.exec("DROP TRIGGER synthetic_audit_failure");
    const recovered = await h.runtime.runOnce({ cutoff });
    assert.equal(recovered.publications[0].changed, false);
    assert.equal(privateCount(h), 1);
    assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 200);
  });

test("tampered or missing required explanation fails public and private reads and immutable replay", async (t) => {
  const h = await harness(t);
  const cutoff = clock();
  const id = publicationId(await h.runtime.runOnce({ cutoff }));
  const row = h.controlsStore.db.prepare("SELECT * FROM pipeline_aggregate_explanations WHERE snapshot_id=?").get(id);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=? WHERE snapshot_id=?")
    .run(row.document.replace('"value":1', '"value":99'), id);
  await assert.rejects(h.runtime.aggregateExplanations.read(id), /aggregate_explanation_integrity_error/);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  await assert.rejects(h.runtime.runOnce({ cutoff }), /aggregate_explanation_integrity_error/);
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=? WHERE snapshot_id=?")
    .run(row.document, id);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 200);
  const forged = JSON.parse(row.document);
  forged.authorization.sources = [];
  h.controlsStore.db
    .prepare("UPDATE pipeline_aggregate_explanations SET document=?,digest=? WHERE snapshot_id=?")
    .run(JSON.stringify(forged), aggregateExplanationHash(forged), id);
  await assert.rejects(h.runtime.runOnce({ cutoff }), /aggregate_explanation_integrity_error/);
  assert.equal(h.controlsStore.read().pipelinePublications[id].aggregateExplanationHash, row.digest);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  h.controlsStore.db.prepare("DELETE FROM pipeline_aggregate_explanations WHERE snapshot_id=?").run(id);
  await assert.rejects(h.runtime.aggregateExplanations.read(id), /aggregate_explanation_required/);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
});

for (const revoked of ["actor", "artifact", "source", "approval", "correction"])
  test(`private explanations apply current ${revoked} revocation to historical snapshots`, async (t) => {
    const h = await harness(t);
    const id = publicationId(await h.runtime.runOnce());
    const original = await h.runtime.aggregateExplanations.read(id);
    const artifactId = original.document.references[0].artifactId;
    if (revoked === "actor")
      h.controlsStore.transaction((state) => {
        state.profiles["101"] = { suppressed: true };
      });
    if (revoked === "artifact")
      await h.db.query(
        "INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES(2,$1,'unavailable')",
        [artifactId],
      );
    if (revoked === "source") await h.runtime.collection.suppress(fixtureId(901), "b".repeat(64), 1, [2], "revoked");
    if (revoked === "approval") h.options.verifyConfiguration = async () => false;
    if (revoked === "correction")
      await h.db.query(
        "INSERT INTO leaderboard_pipeline.corrections(request_id,fact_id,artifact_id,repository_id,document) VALUES('synthetic-correction',$1,$2,2,$3::jsonb)",
        [original.document.references[0].factId, artifactId, JSON.stringify({ fact: { id: "synthetic-corrected" } })],
      );
    const runtime = revoked === "approval" ? await createPipeline(h.options) : h.runtime;
    if (runtime !== h.runtime) t.after(() => runtime.stop());
    await assert.rejects(
      runtime.aggregateExplanations.read(id),
      /aggregate_explanation_privacy_changed|Frozen input.*unavailable|Frozen input source authorization changed/,
    );
    assert.equal(privateCount(h), 1);
    assert.equal(JSON.stringify(h.controlsStore.publicSnapshot()).includes(original.digest), false);
  });

function pureCapture() {
  const policy = metricPolicy("pr_merged", "count");
  const at = "2026-10-01T00:00:00.000Z",
    cutoff = "2026-10-10T00:00:00.000Z";
  const input = {
    datasetId: "synthetic-dataset",
    cutoff,
    backfillRevision: "synthetic-backfill",
    repositoryIds: ["2", "10"],
    actors: [{ id: "101", login: "synthetic-alice", kind: "user", publicState: "visible" }],
    coverage: [],
    facts: [
      {
        id: "synthetic-fact",
        canonicalKey: "synthetic-key",
        metricId: "pr_merged",
        actorId: "101",
        artifactId: "synthetic-pr",
        repoId: "2",
        role: "author",
        state: "qualified",
        occurredAt: at,
        acceptedAt: at,
        observedAt: at,
        revision: 0,
        correctionReceipt: null,
        acceptanceReceipt: "synthetic-secret-receipt",
        acceptedBy: "201",
        subjectActorId: "101",
        eventContext: null,
        currentContext: null,
      },
    ],
  };
  const scope = {
    ...components.metrics.resolveMetricWindow("all", cutoff),
    repos: ["2", "10"],
    projects: [],
    workstreams: [],
    roles: [],
    actors: "all",
    context: "event",
  };
  const capture = {
    input,
    policies: [policy],
    scope,
    aggregates: [components.metrics.aggregateMetric(input, policy, scope)],
    snapshot: { snapshotId: "a".repeat(64), revision: 1 },
    authorization: {
      configurationHash: "b".repeat(64),
      dataMode: "synthetic",
      controlsConfigurationRevision: 0,
      sources: [
        { repositoryId: "2", generation: "1" },
        { repositoryId: "10", generation: "1" },
      ],
    },
  };
  return {
    capture,
    binding: {
      scopeKey: JSON.stringify(["synthetic-org", null, null, null, null]),
      computationVersion: "synthetic-pipeline-v1",
    },
  };
}

test("required explanation uses canonical multi-repository scopes and fails closed on arithmetic or conservation drift", () => {
  const { capture, binding } = pureCapture();
  const explanation = buildAggregateExplanation(capture, binding);
  assert.deepEqual(explanation.scope.repos, ["10", "2"]);
  for (const mutate of [
    (input) => {
      input.aggregates[0].rows[0].value = 99;
    },
    (input) => {
      input.aggregates[0].rows[0].rank = 2;
    },
    (input) => {
      input.aggregates[0].rows[0].tied = true;
    },
    (input) => {
      const empty = structuredClone(input.aggregates[0].rows[0]);
      Object.assign(empty, { evidenceIds: [], value: null, sampleCount: 0, rank: null, state: "unknown" });
      input.aggregates[0].rows.push(empty);
    },
    (input) => {
      input.aggregates[0].audit = [];
    },
    (input) => {
      const row = input.aggregates[0].rows[0];
      row.evidenceIds = [];
      row.value = null;
      row.sampleCount = 0;
      row.rank = null;
      row.state = "unknown";
    },
    (input) => {
      input.aggregates[0].audit.push({ factIds: ["synthetic-fact"], actorId: "101", reason: "pending_not_ranked" });
    },
    (input) => {
      input.aggregates[0].definitionVersion = "wrong-version";
    },
    (input) => {
      input.aggregates[0].rows[0].evidenceIds.push("synthetic-fact");
    },
  ]) {
    const changed = structuredClone(capture);
    mutate(changed);
    assert.throws(
      () => buildAggregateExplanation(changed, binding),
      /aggregate_explanation_(integrity_error|unaccounted_evidence)/,
    );
  }
});

test("native explanations preserve the selected revision when a correction is fractionally after cutoff", () => {
  for (const observedAt of ["2026-10-10T00:00:00.000001Z", "2026-10-10T00:00:00.000000001Z"]) {
    for (const state of ["observed", "excluded"]) {
      const { capture, binding } = pureCapture();
      const policy = metricPolicy("pr_accepted_rate", "ratio", { rankedStates: ["observed"] });
      const original = {
        ...capture.input.facts[0],
        metricId: policy.metricId,
        state: "observed",
        outcome: "merged",
        decisionAsOf: capture.input.cutoff,
      };
      capture.policies = [policy];
      capture.input.facts = [
        original,
        { ...original, revision: 1, state, observedAt, correctionReceipt: "synthetic-future-native-correction" },
      ];
      capture.aggregates = [components.metrics.aggregateMetric(capture.input, policy, capture.scope)];
      const explanation = buildAggregateExplanation(capture, binding);
      assert.deepEqual(explanation.metrics[0].rows[0].eligible, [
        { factId: original.id, revision: 0, factHash: aggregateExplanationHash(original), outcome: "merged" },
      ]);
      assert.deepEqual(explanation.authorization.corrections, []);
      assert.ok(explanation.metrics[0].audit.some((entry) => entry.reason === "observation_after_cutoff"));
      const effectiveExclusion = {
        ...original,
        revision: 1,
        state: "excluded",
        observedAt: capture.input.cutoff,
        correctionReceipt: "synthetic-effective-native-correction",
      };
      capture.input.facts = [
        original,
        effectiveExclusion,
        { ...effectiveExclusion, revision: 2, observedAt, correctionReceipt: "synthetic-future-native-correction" },
      ];
      capture.aggregates = [components.metrics.aggregateMetric(capture.input, policy, capture.scope)];
      assert.deepEqual(buildAggregateExplanation(capture, binding).authorization.corrections, [
        { artifactId: original.artifactId, hash: aggregateExplanationHash(effectiveExclusion) },
      ]);
    }
  }
});

test("required explanation has explicit fail-closed fact and byte bounds without preview TTL", () => {
  const { capture, binding } = pureCapture();
  const crowded = structuredClone(capture);
  crowded.input.facts = Array(aggregateExplanationLimitsV1.facts + 1).fill(crowded.input.facts[0]);
  assert.throws(() => buildAggregateExplanation(crowded, binding), /aggregate_explanation_budget_exceeded/);
  assert.throws(
    () =>
      buildAggregateExplanation(capture, { ...binding, scopeKey: "x".repeat(aggregateExplanationLimitsV1.bytes + 1) }),
    /aggregate_explanation_budget_exceeded/,
  );
  assert.equal("expires" in buildAggregateExplanation(capture, binding), false);
});

test("fresh post-correction explanation remains reviewable while stale and future-cutoff explanations stay withheld", async (t) => {
  const h = await harness(t);
  const oldId = publicationId(await h.runtime.runOnce());
  const old = await h.runtime.aggregateExplanations.read(oldId);
  const factId = old.document.references.find((reference) => reference.actorId === "101").factId;
  const requestId = fixtureId(902);
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "102",
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      status: "pending",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
    };
  });
  await h.runtime.applyCorrection({
    requestId,
    expectedVersion: 1,
    factId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  });
  await assert.rejects(h.runtime.aggregateExplanations.read(oldId), /aggregate_explanation_privacy_changed/);
  const fresh = await h.runtime.aggregateExplanations.read(publicationId(await h.runtime.runOnce()));
  assert.equal(fresh.document.authorization.corrections.length, 1);
  assert.deepEqual(
    fresh.document.metrics[0].rows.map((row) => row.actorId),
    ["102"],
  );
  assert.ok(
    fresh.document.metrics[0].audit.some(
      (entry) => entry.reason === "excluded_by_policy_or_correction" && entry.factIds.includes(factId),
    ),
  );
  assert.equal(JSON.stringify(fresh).includes("synthetic-correction-approval"), false);
  const { capture, binding } = pureCapture();
  const future = {
    ...capture.input.facts[0],
    state: "excluded",
    revision: 1,
    correctionReceipt: "synthetic-correction",
    observedAt: "2026-11-01T00:00:00.000Z",
  };
  capture.input.facts.push(future);
  capture.aggregates = [components.metrics.aggregateMetric(capture.input, capture.policies[0], capture.scope)];
  assert.deepEqual(buildAggregateExplanation(capture, binding).authorization.corrections, []);
});

test("required capture rejects a self-consistent wrong write before granting confirmation authority", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new AggregateExplanationStore({ db });
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith("INSERT INTO pipeline_aggregate_explanations")) return statement;
      return {
        run(id, serialized) {
          const forged = JSON.parse(serialized);
          forged.authorization.sources = [];
          return statement.run(id, JSON.stringify(forged), aggregateExplanationHash(forged));
        },
      };
    };
    const { capture, binding } = pureCapture();
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => store.capture(capture, binding), /aggregate_explanation_integrity_error/);
    db.exec("ROLLBACK");
    assert.equal(prepare("SELECT count(*) AS n FROM pipeline_aggregate_explanations").get().n, 0);
  } finally {
    db.close();
  }
});

test("required explanation uses the engine's stable semantics for undefined optional policy fields", () => {
  const { capture, binding } = pureCapture();
  capture.policies[0].groupingSeconds = undefined;
  capture.aggregates = [components.metrics.aggregateMetric(capture.input, capture.policies[0], capture.scope)];
  assert.equal(buildAggregateExplanation(capture, binding).metrics[0].rows[0].value, 1);
});

test("failed required explanation write preserves the last confirmed public head and recovers atomically", async (t) => {
  const h = await harness(t);
  const first = publicationId(await h.runtime.runOnce());
  const explanation = await h.runtime.aggregateExplanations.read(first);
  const cutoff = clock();
  h.controlsStore.db.exec(
    "CREATE TRIGGER synthetic_required_failure BEFORE INSERT ON pipeline_aggregate_explanations BEGIN SELECT RAISE(ABORT, 'synthetic_required_failure'); END",
  );
  await assert.rejects(h.runtime.runOnce({ cutoff }), /synthetic_required_failure/);
  const candidate = (await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.heads")).rows[0].snapshot_id;
  assert.notEqual(candidate, first);
  const visible = await h.runtime.app.inject(boardUrl);
  assert.equal(visible.statusCode, 200, visible.body);
  assert.equal(visible.json().snapshotId, first);
  assert.equal(visible.json().head.snapshotId, first);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${candidate}`)).statusCode, 410);
  assert.equal(privateCount(h), 1);
  assert.deepEqual(await h.runtime.aggregateExplanations.read(first), explanation);
  assert.equal(h.controlsStore.read().pipelinePublications[candidate], undefined);
  h.controlsStore.db.exec("DROP TRIGGER synthetic_required_failure");
  const recovered = await h.runtime.runOnce({ cutoff });
  assert.equal(publicationId(recovered), candidate);
  assert.equal(recovered.publications[0].changed, false);
  assert.equal(privateCount(h), 2);
  assert.equal((await h.runtime.app.inject(boardUrl)).json().snapshotId, candidate);
  assert.equal((await h.runtime.aggregateExplanations.read(candidate)).document.snapshot.revision, 2);
});

test("required explanation preserves only minimal provider identity hash binding for private source guards", () => {
  const { capture, binding } = pureCapture();
  capture.authorization.identityEvidence = {
    schemaVersion: "pipeline-identity-evidence/v1",
    normalizationHashes: ["c".repeat(64)],
  };
  assert.deepEqual(
    buildAggregateExplanation(capture, binding).authorization.identityEvidence,
    capture.authorization.identityEvidence,
  );
  capture.authorization.identityEvidence.classificationReceipt = "synthetic-private-classification";
  assert.throws(() => buildAggregateExplanation(capture, binding), /aggregate_explanation_integrity_error/);
  delete capture.authorization.identityEvidence.classificationReceipt;
  capture.authorization.identityEvidence.normalizationHashes.push("invalid-hash");
  assert.throws(() => buildAggregateExplanation(capture, binding), /aggregate_explanation_integrity_error/);
});

test("required explanations preserve bounded exact-source alias bindings without arbitrary metadata", () => {
  const { capture, binding } = pureCapture();
  const identityEvidence = {
    schemaVersion: "pipeline-identity-evidence/v1",
    normalizationHashes: ["c".repeat(64)],
    normalizationSources: [{ factKey: "a".repeat(64), documentHash: "c".repeat(64) }],
  };
  capture.authorization.identityEvidence = identityEvidence;
  assert.deepEqual(buildAggregateExplanation(capture, binding).authorization.identityEvidence, identityEvidence);
  for (const sources of [
    [{ factKey: "a".repeat(64), documentHash: "b".repeat(64) }],
    [{ factKey: "invalid", documentHash: "c".repeat(64) }],
    [...identityEvidence.normalizationSources, ...identityEvidence.normalizationSources],
    [{ ...identityEvidence.normalizationSources[0], sourceLogin: "private-unbounded-label" }],
    [],
  ]) {
    capture.authorization.identityEvidence = { ...identityEvidence, normalizationSources: sources };
    assert.throws(() => buildAggregateExplanation(capture, binding), /aggregate_explanation_integrity_error/);
  }
});

test("required private explanations revoke when reviewed recognition changes", async (t) => {
  const h = await harness(t);
  const config = structuredClone(h.options.config);
  const policy = {
    ...config.policies[0].policy,
    version: "synthetic-accepted-v1",
    dateBasis: "acceptedAt",
    rankedStates: ["qualified"],
  };
  config.policies = [
    { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-approval" },
  ];
  config.recognitionBindings = [
    {
      category: "finding",
      scope: "repository:2",
      policyVersion: policy.version,
      metricId: "issues_opened",
      sourceMetricId: "issues_opened",
      repositoryId: "2",
      reviewerIds: ["202"],
    },
  ];
  const event = {
    id: "synthetic-receipt",
    actor: "202",
    action: "accepted",
    at: Date.parse(ago(1)),
    policyVersion: policy.version,
  };
  h.controlsStore.transaction((state) => {
    state.requests.claim = {
      id: "claim",
      kind: "evidence",
      status: "accepted",
      owner: "101",
      category: "finding",
      scope: "repository:2",
      policyVersion: policy.version,
      locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
      collaborators: {},
      history: [event],
    };
    state.audit.push(event);
    attachSyntheticEvidenceState(state);
  });
  const runtime = await createPipeline({ ...h.options, config });
  t.after(() => runtime.stop());
  const publication = (await runtime.runOnce()).publications[0];
  assert.equal(
    (await runtime.aggregateExplanations.read(publication.snapshotId)).document.snapshot.snapshotId,
    publication.snapshotId,
  );
  h.controlsStore.transaction((state) => {
    state.requests.claim.status = "withdrawn";
  });
  await assert.rejects(
    runtime.aggregateExplanations.read(publication.snapshotId),
    /aggregate_explanation_authorization_changed/,
  );
});
