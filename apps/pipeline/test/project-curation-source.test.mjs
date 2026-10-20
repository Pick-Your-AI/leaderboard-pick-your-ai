import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGithubCollectionSource,
  githubRecentSourceFamilies,
  isProjectSourceScopeFailure,
} from "../src/github-source.mjs";
import { createPipeline } from "../src/index.mjs";
import { selectReconciliationPlan, parseReconciliationRunId } from "../src/reconciliation-plan.mjs";
import { createPublicProjectContextProjector } from "../src/public-project-context.mjs";
import { harness, components, ago, clock, fixtureId } from "./harness.mjs";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import {
  curationActor,
  curationEvent,
  curationProjectId,
  projectCurationFixture,
} from "../../../tests/fixtures/project-curation.mjs";

const request = {
  repositoryId: 2,
  runId: "synthetic-curation-full-audit",
  family: "project_curation_history",
  mode: "audit",
  since: null,
  until: "2026-10-03T00:00:00.000Z",
  cursor: null,
  limit: 100,
};
function source(fixture, extra = {}) {
  return createGithubCollectionSource({
    client: fixture.client,
    sourceId: "installation:synthetic-curation",
    repositories: [fixture.repository],
    isSynthetic: true,
    ...extra,
  });
}
function configure(config) {
  config.repositories[0].families = ["project_curation_history"];
  config.repositories[0].allowedProjectIds = [curationProjectId];
  const policy = {
    ...config.policies[0].policy,
    metricId: "project_items_curated",
    unit: components.metrics.getMetricDefinition("project_items_curated").definition.unit,
    groupBy: "canonical",
    roles: ["triager"],
    sources: ["github_graphql"],
    rank: false,
  };
  config.policies = [
    { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-curation-policy" },
  ];
}
const boardUrl = "/api/v1/boards?metric=project_items_curated";
async function board(runtime, suffix = "") {
  const response = await runtime.app.inject(boardUrl + suffix);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("native Project curation requires its own family and Project grant before transport", async () => {
  const fixture = projectCurationFixture();
  await assert.rejects(
    source(fixture, { repositories: [{ ...fixture.repository, families: ["project_history"] }] }).readPage(request),
    /source_family_adapter_unavailable/,
  );
  await assert.rejects(
    source(fixture).readPage({ ...request, family: "project_history" }),
    /source_family_adapter_unavailable/,
  );
  assert.deepEqual(fixture.state.reads, []);
  await assert.rejects(
    source(fixture, { repositories: [{ ...fixture.repository, allowedProjectIds: [] }] }).readPage(request),
    /approved_project_scope_required/,
  );
  assert.deepEqual(githubRecentSourceFamilies, ["issues", "comments", "project_history", "relationships"]);
  for (const change of [
    { since: "2026-10-01T00:00:00.000Z", mode: "reconcile" },
    { until: "2026-10-03T00:00:00Z" },
    { mode: "recent" },
  ]) {
    const before = fixture.state.reads.length;
    await assert.rejects(
      source(fixture).readPage({ ...request, ...change }),
      /source_project_curation_window_unsupported/,
    );
    assert.equal(fixture.state.reads.length, before);
  }
});

test("the existing planner admits full curation audits without adding a recent source capability", async () => {
  const fixture = projectCurationFixture();
  const scan = {
    key: "a".repeat(64),
    contextHash: "b".repeat(64),
    token: fixtureId(471),
    cutoff: request.until,
    sources: [{ repositoryId: 2, generation: "1" }],
  };
  const policy = { lookbackMs: 86400000, overlapMs: 3600000, fullAuditsPerCycle: 1 };
  const progress = {
    repositoryId: 2,
    family: "project_curation_history",
    generation: "1",
    lastFullAuditAt: null,
    reconciledThrough: null,
    lastSuccessfulSync: null,
  };
  const plan = selectReconciliationPlan({ scan, repositories: [fixture.repository], policy, progress: [progress] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].family, "project_curation_history");
  assert.equal(plan[0].mode, "audit");
  assert.equal(plan[0].since, null);
  assert.equal(parseReconciliationRunId(plan[0].runId).total, 1);
  const page = await source(fixture).readPage({ ...plan[0], cursor: null, limit: 100 });
  assert.equal(page.facts.length, 2);
  assert.equal(page.expectedCount, null);
  const reads = fixture.state.reads.length;
  await assert.rejects(
    source(fixture).readPage({ ...plan[0], mode: "reconcile", cursor: null, limit: 100 }),
    /reconciliation_source_plan_invalid/,
  );
  assert.equal(fixture.state.reads.length, reads);

  const next = selectReconciliationPlan({
    scan,
    repositories: [{ ...fixture.repository, families: ["issues", "project_curation_history"] }],
    policy,
    progress: [
      { ...progress, family: "issues" },
      { ...progress, lastFullAuditAt: "2026-10-02T00:00:00.000Z" },
    ],
  });
  assert.deepEqual(
    next.map((entry) => [entry.family, entry.mode, entry.since]),
    [["issues", "audit", null]],
  );
});

test("curation collector retains minimized native bindings and unknown total history across output pages", async () => {
  const fixture = projectCurationFixture();
  fixture.state.subjects[0].title = "SYNTHETIC PRIVATE SOURCE TEXT MUST NOT BE RETAINED";
  fixture.state.events.get(1)[0].body = "SYNTHETIC EVENT BODY MUST NOT BE RETAINED";
  const reader = source(fixture);
  const first = await reader.readPage({ ...request, limit: 1 });
  const next = await reader.readPage({ ...request, limit: 1, cursor: first.nextCursor });
  assert.match(first.nextCursor, /^[a-f0-9]{64}:1$/);
  assert.equal(next.nextCursor, null);
  assert.equal(first.expectedCount, null);
  assert.equal(next.expectedCount, null);
  assert.deepEqual(
    [first.facts[0].historySubjectId, next.facts[0].historySubjectId],
    ["I_SYNTHETIC_CURATION", "PR_SYNTHETIC_CURATION"],
  );
  for (const fact of [...first.facts, ...next.facts]) {
    assert.equal(fact.evidence, "observed_transition");
    assert.equal(fact.projectCurationProjectId, curationProjectId);
    assert.equal(fact.actorId, "202");
    assert.match(fact.sourceRevision, /^[a-f0-9]{64}$/);
    assert.equal(fact.occurredAt, "2026-10-01T12:00:00.000Z");
    assert.equal(fact.projectSubjectId, undefined);
    assert.equal(fact.issueFieldId, undefined);
    assert.doesNotMatch(JSON.stringify(fact), /SOURCE TEXT|EVENT BODY|PVTI/);
  }
  assert.ok(
    fixture.state.reads
      .filter((read) => read.kind === "inventory")
      .every((read) => /:project-curation:(?:issue|pull_request)-subjects-metadata-v1$/.test(read.key)),
  );
});

test("curation full reads honor the exact upper source cutoff without certifying complete history", async () => {
  const fixture = projectCurationFixture();
  fixture.state.events.set(1, [
    curationEvent("PVE_AT", { createdAt: request.until }),
    curationEvent("PVE_AFTER", { createdAt: "2026-10-03T00:00:00.001Z" }),
  ]);
  fixture.state.events.set(2, []);
  const page = await source(fixture).readPage({ ...request, mode: "reconcile" });
  assert.deepEqual(
    page.facts.map((fact) => fact.subjectId),
    ["PVE_AT"],
  );
  assert.equal(page.expectedCount, null);
});

test("invalid curation inventory bindings reach the Project denial callback before retention", async () => {
  for (const change of [
    (state) => {
      delete state.subjects[0].node_id;
    },
    (state) => {
      state.subjects[1].node_id = state.subjects[0].node_id;
    },
    (state) => {
      state.subjects[0].html_url = "https://github.com/foreign/repository/issues/1";
    },
    (state) => {
      state.subjects[0].pull_request = "unproved";
    },
  ]) {
    const fixture = projectCurationFixture();
    change(fixture.state);
    const denied = [];
    await assert.rejects(
      source(fixture, { onUnavailable: async (_repository, reason) => denied.push(reason) }).readPage(request),
      /project_curation_subject_identity_unverified/,
    );
    assert.deepEqual(denied, ["project_scope_unavailable"]);
    if (fixture.state.subjects[0].node_id === undefined || fixture.state.subjects[0].pull_request === "unproved")
      assert.equal(
        fixture.state.reads.some((read) => read.kind === "timeline"),
        false,
      );
  }
  assert.equal(
    isProjectSourceScopeFailure(new Error("project_curation_event_unavailable"), "project_curation_history"),
    true,
  );
  assert.equal(
    isProjectSourceScopeFailure(new Error("project_curation_event_unverified"), "project_curation_history"),
    false,
  );
});

test("real curation publication revalidates cached native sources and survives database reopen", async (t) => {
  const fixture = projectCurationFixture({ createdAt: ago(1) });
  const h = await harness(t, { source: undefined, githubClient: fixture.client, configure });
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff, mode: "audit" });
  assert.equal(first.state, "published");
  assert.deepEqual(
    (await board(h.runtime)).rows.map((row) => [row.actorId, row.result.value]),
    [["202", 2]],
  );
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.equal(saved.length, 2);
  assert.ok(saved.every((row) => row.document.projectCurationNormalizationVersion === "project-curation-history/v1"));
  for (const row of saved)
    for (const basis of ["event", "current"]) {
      const proof = row.document.evidence[0];
      const fact = row.document.facts[0];
      const projected = createPublicProjectContextProjector(
        [{ family: "project_curation_history", source: { observedAt: fact.observedAt }, document: row.document }],
        basis,
        fact.observedAt,
      )(proof, fact);
      assert.equal(projected.projectContext.state, "unknown", "an operation does not certify membership");
    }
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS total FROM leaderboard_ingestion.source_facts")).rows[0].total,
    2,
  );
  const inventoryReads = fixture.state.reads.filter((read) => read.kind === "inventory").length;
  const timelineReads = fixture.state.reads.filter((read) => read.kind === "timeline").length;
  assert.equal((await h.runtime.runOnce({ cutoff, mode: "audit" })).state, "published");
  assert.equal(fixture.state.reads.filter((read) => read.kind === "inventory").length, inventoryReads);
  assert.equal(fixture.state.reads.filter((read) => read.kind === "timeline").length, timelineReads + 2);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
    saved,
  );
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  assert.deepEqual(
    (await board(reopened, "&snapshot=" + first.publications[0].snapshotId)).rows.map((row) => row.result.value),
    [2],
  );
  assert.equal((await reopened.runOnce({ cutoff, mode: "audit" })).state, "published");
  assert.deepEqual(
    (await board(reopened)).rows.map((row) => row.result.value),
    [2],
  );
});

for (const loss of ["private_project", "missing_event", "changed_subject"]) {
  test("cached curation " + loss + " durably denies current and pinned reads until separate reapproval", async (t) => {
    const fixture = projectCurationFixture({ createdAt: ago(1) });
    const h = await harness(t, { source: undefined, githubClient: fixture.client, configure });
    const cutoff = clock();
    const first = await h.runtime.runOnce({ cutoff, mode: "audit" });
    assert.equal(first.state, "published");
    assert.equal((await board(h.runtime)).rows[0].result.value, 2);
    const cached = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
    assert.equal(cached.length, 2);
    const firstEvents = structuredClone(fixture.state.events.get(1));
    if (loss === "private_project") fixture.state.projectPublic = false;
    if (loss === "missing_event") fixture.state.events.set(1, []);
    if (loss === "changed_subject") fixture.state.changedSubject = true;
    await assert.rejects(
      h.runtime.runOnce({ cutoff, mode: "audit" }),
      /project_(?:not_authorized|curation_|source_scope_requires_reapproval)/,
    );
    for (const suffix of ["", "&snapshot=" + first.publications[0].snapshotId])
      assert.notEqual((await h.runtime.app.inject(boardUrl + suffix)).statusCode, 200);
    assert.equal(h.controlsStore.read().pipelineSourceDenials[2].configurationVersion, h.config.version);
    assert.equal(
      (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .state,
      "unavailable",
    );
    assert.equal(
      (
        await h.db.query(
          "SELECT count(*)::int AS total FROM leaderboard_pipeline.receipts WHERE kind='project_scope_denial'",
        )
      ).rows[0].total,
      1,
    );
    fixture.state.projectPublic = true;
    fixture.state.changedSubject = false;
    fixture.state.events.set(1, firstEvents);
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    await assert.rejects(restarted.runOnce({ mode: "audit" }), /project_source_scope_requires_reapproval/);
    assert.notEqual(
      (await restarted.app.inject(boardUrl + "&snapshot=" + first.publications[0].snapshotId)).statusCode,
      200,
    );
    const config = structuredClone(h.config);
    config.version += "-synthetic-reapproved";
    config.approvalReceipt = "synthetic-curation-reapproval";
    const recovered = await createPipeline({
      ...h.options,
      config,
      verifyConfiguration: async (value) =>
        value.version === config.version && value.approvalReceipt === config.approvalReceipt,
    });
    t.after(() => recovered.stop());
    assert.equal((await recovered.runOnce({ mode: "audit" })).state, "published");
    assert.deepEqual(
      (await board(recovered)).rows.map((row) => row.result.value),
      [2],
    );
    assert.notEqual(
      (await recovered.app.inject(boardUrl + "&snapshot=" + first.publications[0].snapshotId)).statusCode,
      200,
    );
  });
}

test("curation output cursors bind exact sorted native semantics and reject shifted output pages", async () => {
  const fixture = projectCurationFixture();
  const reader = source(fixture);
  const first = await reader.readPage({ ...request, limit: 1 });
  const cursor = first.nextCursor;
  assert.match(cursor, /^[a-f0-9]{64}:1$/);
  fixture.state.subjects.reverse();
  const stable = await reader.readPage({ ...request, limit: 1, cursor });
  assert.equal(stable.nextCursor, null);
  assert.equal(stable.facts[0].subjectId, "PVE_SYNTHETIC_PR_REMOVE");
  assert.deepEqual(await reader.readPage({ ...request, limit: 1, cursor }), stable);
  for (const change of [
    (state) => state.events.get(1).push(curationEvent("PVE_INSERTED")),
    (state) => state.events.set(1, []),
    (state) => {
      state.events.get(1)[0].actor.databaseId = 303;
    },
    (state) => {
      state.events.get(1)[0].__typename = "RemovedFromProjectV2Event";
    },
    (state) => {
      state.events.get(1)[0].createdAt = "2026-10-01T12:00:00.001Z";
    },
    (state) => {
      state.events.get(1)[0].wasAutomated = true;
    },
  ]) {
    const original = structuredClone(fixture.state.events);
    change(fixture.state);
    await assert.rejects(reader.readPage({ ...request, limit: 1, cursor }), /source_project_curation_cursor_changed/);
    fixture.state.events = original;
  }
  for (const change of [{ runId: request.runId + "-other" }, { until: "2026-10-03T00:00:00.001Z" }])
    await assert.rejects(
      reader.readPage({ ...request, ...change, limit: 1, cursor }),
      /source_project_curation_cursor_changed/,
    );
  for (const invalid of ["0", "1", "0".repeat(64), "G".repeat(64) + ":1"])
    await assert.rejects(reader.readPage({ ...request, limit: 1, cursor: invalid }), /invalid_source_cursor/);
  assert.deepEqual(await reader.readPage({ ...request, limit: 1, cursor }), stable);
});

test("protected curation account classification survives fresh hydration and database reopen", async (t) => {
  const fixture = projectCurationFixture({ createdAt: ago(1) });
  const classification = {
    schemaVersion: "leaderboard-service-account/v1",
    classificationId: "synthetic-curation-protected-account",
    githubDatabaseId: curationActor.databaseId,
    githubNodeId: curationActor.id,
    source: "reviewed_configuration",
    evidenceIds: ["synthetic-curation-account-evidence"],
    reviewerActorId: "303",
    reviewedAt: "2026-01-01T00:00:00Z",
  };
  let hydrations = 0;
  const h = await harness(t, {
    source: undefined,
    githubClient: fixture.client,
    configure,
    authorizePolicyPreview: async ({ operatorId }) => operatorId === "201",
    // This is the existing protected normalizer port. It does not create an
    // installed reviewer roster or classify accounts from provider labels.
    normalizerFactory(options) {
      const actual = components.github.createGithubEvidenceNormalizer({
        client: options.githubClient,
        source: options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
        reviewedServiceAccounts: [classification],
        authorizedClassifierIds: ["303"],
      });
      return async (value) => {
        hydrations++;
        return actual(value);
      };
    },
  });
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff, mode: "audit" });
  assert.equal(first.state, "published");
  assert.equal(hydrations, 2);
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.equal(saved.length, 2);
  for (const row of saved) {
    assert.equal(row.document.actors[0].kind, "service_account");
    assert.equal(row.document.actors[0].executionMode, "unknown");
    assert.deepEqual(row.document.actors[0].serviceAccountClassification, classification);
    assert.equal(row.document.facts[0].role, "triager");
    assert.equal(row.document.facts[0].acceptedAt, null);
  }
  const frozen = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      first.publications[0].snapshotId,
    ])
  ).rows;
  const previewRequest = {
    snapshotId: first.publications[0].snapshotId,
    policy: { ...h.config.policies[0].policy, version: "synthetic-curation-classified-preview" },
    operatorId: "201",
  };
  const preview = await h.runtime.previewPolicy(previewRequest);
  assert.deepEqual(
    preview.comparison.before.rows.map((row) => row.actorId),
    ["202"],
  );
  assert.deepEqual(preview.comparison.changes, []);
  async function checkExports(runtime) {
    for (const filter of ["all", "user", "automation"]) {
      const response = await runtime.app.inject("/api/v1/exports?metric=project_items_curated&actors=" + filter);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        response.json().rows.map((row) => [row.actorId, row.actorKind, row.executionMode]),
        filter === "user" ? [] : [["202", "service_account", "unknown"]],
      );
      assert.doesNotMatch(response.body, /serviceAccountClassification|reviewerActorId|synthetic-curation-protected/);
    }
  }
  await checkExports(h.runtime);
  assert.equal((await h.runtime.runOnce({ cutoff, mode: "audit" })).state, "published");
  assert.equal(hydrations, 4, "a completed collection cannot bypass native rehydration or classification");
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
    saved,
  );
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  assert.equal((await reopened.runOnce({ cutoff, mode: "audit" })).state, "published");
  assert.equal(hydrations, 6);
  await checkExports(reopened);
  assert.deepEqual(await reopened.previewPolicy(previewRequest), preview);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
    saved,
  );
  assert.deepEqual(
    (
      await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        first.publications[0].snapshotId,
      ])
    ).rows,
    frozen,
  );
});

test("real scan checkpoints refresh the curation subject inventory before every digest-bound output page", async () => {
  const fixture = projectCurationFixture();
  let inventoryReads = 0;
  const client = new components.github.GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-curation-page-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (url, init) => {
      const respond = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      assert.equal(init.method, "POST", "curation acquires only selected GraphQL metadata");
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("ProjectCurationRepository"))
        return respond({
          data: { repository: { databaseId: 2, isPrivate: false, nameWithOwner: fixture.repository.slug } },
        });
      if (query.includes("ProjectCurationInventory")) {
        inventoryReads++;
        return respond({ data: fixture.inventory(query) });
      }
      return respond({
        data: variables.id ? { node: { id: variables.id, public: true } } : fixture.data(variables.number, query),
      });
    },
  });
  const reader = source({ ...fixture, client });
  const first = await reader.readPage({ ...request, limit: 1 });
  assert.equal(inventoryReads, 2);
  const cursor = first.nextCursor;
  fixture.state.subjects.reverse();
  const stable = await reader.readPage({ ...request, limit: 1, cursor });
  assert.equal(inventoryReads, 4, "the actual scan client must refresh both complete subject checkpoints");
  assert.equal(stable.facts[0].subjectId, "PVE_SYNTHETIC_PR_REMOVE");

  const retainedSubjects = structuredClone(fixture.state.subjects);
  fixture.state.subjects.push({
    node_id: "I_SYNTHETIC_NEW_SUBJECT",
    number: 3,
    html_url: "https://github.com/" + fixture.repository.slug + "/issues/3",
  });
  fixture.state.events.set(3, [curationEvent("PVE_NEW_SUBJECT")]);
  await assert.rejects(reader.readPage({ ...request, limit: 1, cursor }), /source_project_curation_cursor_changed/);
  assert.equal(inventoryReads, 6);
  fixture.state.subjects = retainedSubjects.filter((subject) => subject.number !== 1);
  await assert.rejects(reader.readPage({ ...request, limit: 1, cursor }), /source_project_curation_cursor_changed/);
  assert.equal(inventoryReads, 8);
  fixture.state.subjects = retainedSubjects;
  fixture.state.events.delete(3);
  assert.deepEqual(await reader.readPage({ ...request, limit: 1, cursor }), stable);
  assert.equal(inventoryReads, 10);
});

test("curation frozen previews and authorized corrections survive database reopen", async (t) => {
  const fixture = projectCurationFixture({ createdAt: ago(1) });
  const h = await harness(t, {
    source: undefined,
    githubClient: fixture.client,
    configure,
    authorizePolicyPreview: async ({ operatorId }) => operatorId === "201",
  });
  const first = await h.runtime.runOnce({ mode: "audit" });
  assert.equal(first.state, "published");
  const snapshotId = first.publications[0].snapshotId;
  const saved = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  const selected = saved.find((row) => row.document.evidence[0].artifact.publicUrl.endsWith("/issues/1"));
  assert.ok(selected);
  const fact = selected.document.facts[0];
  const frozen = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [snapshotId])
  ).rows;
  const previewRequest = {
    snapshotId,
    policy: { ...h.config.policies[0].policy, version: "synthetic-curation-preview" },
    operatorId: "201",
  };
  const preview = await h.runtime.previewPolicy(previewRequest);
  assert.deepEqual(
    preview.comparison.before.rows.map((row) => [row.actorId, row.value, row.rank]),
    [["202", 2, null]],
  );
  assert.deepEqual(preview.comparison.changes, []);
  await assert.rejects(
    h.runtime.previewPolicy({ ...previewRequest, operatorId: "202" }),
    /policy_preview_not_authorized/,
  );

  // An admitted family does not make an arbitrary generation or a missing
  // relationship-pair marker authoritative for the frozen actor evidence.
  for (const [signature, reason] of [
    ["0".repeat(64), /Frozen identity evidence unavailable/],
    [
      comparisonHash([components.github.relationshipPairNormalizationVersion, selected.policy_signature]),
      /Frozen relationship pair normalization obsolete/,
    ],
  ]) {
    assert.equal(selected.document.relationshipPairNormalizationVersion, undefined);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE fact_key=$2 AND policy_signature=$3",
      [signature, selected.fact_key, selected.policy_signature],
    );
    await assert.rejects(h.runtime.previewPolicy(previewRequest), reason);
    await h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET policy_signature=$1 WHERE fact_key=$2 AND policy_signature=$3",
      [selected.policy_signature, selected.fact_key, signature],
    );
  }
  assert.deepEqual(await h.runtime.previewPolicy(previewRequest), preview);
  const requestId = fixtureId(470);
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "202",
      locator: selected.document.evidence[0].artifact.publicUrl,
      status: "pending",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId: fact.id,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  await assert.rejects(h.runtime.applyCorrection({ ...decision, operatorId: "202" }), /correction_not_authorized/);
  await assert.rejects(
    h.runtime.applyCorrection({ ...decision, factId: fact.id + "-unknown" }),
    /correction_evidence_mismatch/,
  );
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.corrections")).rows[0].n, 0);
  const applied = await h.runtime.applyCorrection(decision);
  assert.equal(applied.status, "applied");
  const correction = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])
  ).rows[0].document;
  assert.equal(correction.fact.id, fact.id);
  assert.equal(correction.fact.metricId, "project_items_curated");
  assert.equal(correction.fact.revision, fact.revision + 1);
  assert.equal(correction.fact.state, "excluded");
  assert.equal(correction.fact.correctionReceipt, decision.approvalReceipt);
  const receipts = await h.runtime.receipts();
  assert.deepEqual(await h.runtime.applyCorrection(decision), applied);
  assert.deepEqual(await h.runtime.receipts(), receipts);
  // Current privacy withholds an immutable aggregate whose proof was suppressed.
  // A rebuilt publication below recomputes the remaining native operation.
  assert.deepEqual((await board(h.runtime, "&snapshot=" + snapshotId)).rows, []);

  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  assert.deepEqual(await reopened.applyCorrection(decision), applied);
  assert.equal((await reopened.runOnce({ mode: "audit" })).state, "published");
  assert.deepEqual(
    (await board(reopened)).rows.map((row) => row.result.value),
    [1],
  );
  assert.deepEqual((await board(reopened, "&snapshot=" + snapshotId)).rows, []);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [snapshotId])).rows,
    frozen,
  );
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows,
    saved,
  );
});

test("curation metadata excludes content from every durable checkpoint even when responses carry ETags", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-curation-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = "SYNTHETIC_UNSELECTED_CURATION_CONTENT";
  const fixture = projectCurationFixture();
  fixture.state.subjects.push({
    node_id: "I_SYNTHETIC_SECOND_CURATION",
    number: 3,
    html_url: "https://github.com/" + fixture.repository.slug + "/issues/3",
  });
  fixture.state.events.set(3, [curationEvent("PVE_SYNTHETIC_SECOND_ADD")]);
  const writes = [];
  function checkedStore(actual, repositoryId = null) {
    return {
      load: (key) => actual.load(key),
      async save(key, value) {
        const serialized = JSON.stringify(value);
        assert.equal(serialized.includes(sentinel), false, "unselected content must not reach any checkpoint write");
        writes.push({ repositoryId, key, value: JSON.parse(serialized) });
        await actual.save(key, value);
      },
      ...(repositoryId === null
        ? { forRepository: (id) => checkedStore(actual.forRepository(id), id) }
        : {
            repositoryId,
            assertActive: () => actual.assertActive(),
            retire: (binding) => actual.retire(binding),
          }),
    };
  }
  let restRequests = 0;
  let inventoryPages = 0;
  const makeClient = (checkpoints) =>
    new components.github.GithubReadClient({
      apiOrigin: "https://api.synthetic.invalid",
      token: async () => "synthetic-curation-metadata-token",
      checkpoints,
      maxRetries: 0,
      fetch: async (url, init) => {
        const respond = (body) =>
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json", etag: '"synthetic-curation-metadata"' },
          });
        // This branch deliberately models the old ETag-bearing REST path.
        // A regression reaches the durable-write assertion before scan selection.
        if (init.method !== "POST") {
          restRequests++;
          const path = new URL(url).pathname;
          if (path === "/repos/" + fixture.repository.slug)
            return respond({ id: 2, private: false, full_name: fixture.repository.slug, description: sentinel });
          assert.equal(path, "/repos/" + fixture.repository.slug + "/issues");
          return respond(fixture.state.subjects.map((subject) => ({ ...subject, title: sentinel, body: sentinel })));
        }
        const { query, variables } = JSON.parse(init.body);
        assert.doesNotMatch(query, /\b(?:body|title|description|fieldValues)\b/);
        if (query.includes("ProjectCurationRepository"))
          return respond({
            data: {
              repository: {
                databaseId: 2,
                isPrivate: false,
                nameWithOwner: fixture.repository.slug,
                description: sentinel,
              },
            },
          });
        if (query.includes("ProjectCurationInventory")) {
          inventoryPages++;
          const data = fixture.inventory(query);
          const field = query.includes("pullRequests(") ? "pullRequests" : "issues";
          const connection = data.repository[field];
          if (field === "issues") {
            connection.nodes = connection.nodes.slice(variables.after ? 1 : 0, variables.after ? 2 : 1);
            connection.pageInfo = {
              hasNextPage: !variables.after,
              endCursor: variables.after ? null : "synthetic-next-issue",
            };
          }
          for (const subject of connection.nodes) Object.assign(subject, { title: sentinel, body: sentinel });
          return respond({ data });
        }
        if (variables.id) return respond({ data: { node: { id: variables.id, public: true, unselected: sentinel } } });
        const data = fixture.data(variables.number, query);
        const subject = data.repository[query.includes("pullRequest(number:") ? "pullRequest" : "issue"];
        subject.body = sentinel;
        for (const event of subject.timelineItems.nodes) event.unselected = sentinel;
        return respond({ data });
      },
    });
  const checkpoints = new components.github.FileCheckpointStore(directory);
  const first = await source({ ...fixture, client: makeClient(checkedStore(checkpoints)) }).readPage({
    ...request,
    limit: 2,
  });
  assert.equal(first.facts.length, 2);
  assert.match(first.nextCursor, /^[a-f0-9]{64}:2$/);
  assert.equal(inventoryPages, 3, "issue and PR inventories retain independent native pagination");
  const reopened = new components.github.FileCheckpointStore(directory);
  const next = await source({ ...fixture, client: makeClient(checkedStore(reopened)) }).readPage({
    ...request,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(next.facts.length, 1);
  assert.equal(next.nextCursor, null);
  assert.equal(inventoryPages, 6, "both metadata inventories refresh after durable reopen");
  assert.equal(restRequests, 0);
  assert.ok(writes.some((write) => write.key.startsWith("scan:")));
  assert.equal(
    writes.some((write) => write.key.startsWith("http:")),
    false,
  );
  const latest = new Map(writes.map((write) => [JSON.stringify([write.repositoryId, write.key]), write]));
  for (const write of latest.values()) {
    const actual = write.repositoryId === null ? reopened : reopened.forRepository(write.repositoryId);
    const saved = await actual.load(write.key);
    assert.deepEqual(saved, write.value, "the real file-backed store retains the projected checkpoint");
    assert.equal(JSON.stringify(saved).includes(sentinel), false);
  }
});

for (const field of ["id", "number", "url"]) {
  test(`curation rejects malformed ${field} before durable storage without an ETag`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "leaderboard-curation-identity-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sentinel = "SYNTHETIC_UNUSED_IDENTITY_TEXT";
    const fixture = projectCurationFixture();
    const writes = [];
    let malformed = false;
    function checkedStore(actual, repositoryId = null) {
      return {
        load: (key) => actual.load(key),
        async save(key, value) {
          const saved = structuredClone(value);
          await actual.save(key, value);
          writes.push({ repositoryId, key, value: saved });
        },
        ...(repositoryId === null
          ? { forRepository: (id) => checkedStore(actual.forRepository(id), id) }
          : {
              repositoryId,
              assertActive: () => actual.assertActive(),
              retire: (binding) => actual.retire(binding),
            }),
      };
    }
    const makeClient = (checkpoints) =>
      new components.github.GithubReadClient({
        apiOrigin: "https://api.synthetic.invalid",
        token: async () => "synthetic-curation-identity-token",
        checkpoints,
        maxRetries: 0,
        fetch: async (url, init) => {
          // No ETag: this isolates selection-before-scan-persistence from HTTP caching.
          const respond = (body) =>
            new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
          if (init.method !== "POST") {
            const path = new URL(url).pathname;
            if (path === "/repos/" + fixture.repository.slug)
              return respond({ id: 2, private: false, full_name: fixture.repository.slug });
            assert.equal(path, "/repos/" + fixture.repository.slug + "/issues");
            const subjects = structuredClone(fixture.state.subjects);
            if (malformed)
              subjects[0][{ id: "node_id", number: "number", url: "html_url" }[field]] = { note: sentinel };
            return respond(subjects);
          }
          const { query, variables } = JSON.parse(init.body);
          if (query.includes("ProjectCurationRepository"))
            return respond({
              data: { repository: { databaseId: 2, isPrivate: false, nameWithOwner: fixture.repository.slug } },
            });
          if (query.includes("ProjectCurationInventory")) {
            const data = fixture.inventory(query);
            if (malformed && data.repository.issues) data.repository.issues.nodes[0][field] = { note: sentinel };
            return respond({ data });
          }
          return respond({
            data: variables.id ? { node: { id: variables.id, public: true } } : fixture.data(variables.number, query),
          });
        },
      });
    const checkpoints = new components.github.FileCheckpointStore(directory);
    const reader = source({ ...fixture, client: makeClient(checkedStore(checkpoints)) });
    const healthy = await reader.readPage(request);
    assert.equal(healthy.facts.length, 2, "the actual reader and durable store first accept valid identities");
    assert.ok(writes.length > 0);
    const savedWrites = writes.length;
    const latest = new Map(writes.map((write) => [JSON.stringify([write.repositoryId, write.key]), write]));
    malformed = true;
    await assert.rejects(reader.readPage(request), /project_curation_subject_identity_unverified/);
    assert.equal(writes.length, savedWrites, "an invalid first inventory page must not write its selected values");

    const reopened = new components.github.FileCheckpointStore(directory);
    for (const write of latest.values()) {
      const actual = write.repositoryId === null ? reopened : reopened.forRepository(write.repositoryId);
      assert.deepEqual(await actual.load(write.key), write.value, "the prior valid durable checkpoint stays exact");
    }
    const inspect = async (path) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await inspect(child);
        else {
          assert.equal(entry.isFile(), true);
          assert.equal((await readFile(child, "utf8")).includes(sentinel), false);
        }
      }
    };
    await inspect(directory);
    malformed = false;
    const recovered = await source({ ...fixture, client: makeClient(checkedStore(reopened)) }).readPage(request);
    assert.deepEqual(recovered, healthy, "valid metadata remains usable after the rejected page and durable reopen");
  });
}
