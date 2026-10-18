import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash } from "../../controls/src/policy-comparison.mjs";
import { createPipeline } from "../src/index.mjs";
import {
  applyCurrentProjectContexts,
  canonicalProjectWorkstreamMappings,
  normalizedProjectContext,
} from "../src/project-context.mjs";
import { harness, components, clock, ago, getBoard } from "./harness.mjs";

const slug = "synthetic-org/synthetic-repo";
const projectIds = ["PVT_synthetic_A", "PVT_synthetic_B"];
const mapping = () => ({
  repositoryId: 2,
  version: "synthetic-project-mapping/v1",
  projects: projectIds.map((projectId) => ({
    projectId,
    fields: [{ fieldId: projectId + "_field", options: [{ optionId: "blue", workstreamId: "engineering" }] }],
  })),
});
const sourceDocument = (subject, revision, project = false) => ({
  subjectId: subject.node_id,
  ...(project ? { projectSubjectId: subject.node_id } : {}),
  sourceRevision: revision,
  sourceUrl: subject.html_url,
  evidence: "current_state",
  actorId: null,
  occurredAt: null,
  state: "open",
});

// The separate real-transport test covers provider hydration. This harness uses
// the actual collection SQL, normalization cache, frozen store, and metric engine
// with a trusted synthetic Project adapter whose captured revision is immutable.
async function projectHarness(t, { stableProjectRevisions = false, transformProjectOutput = (output) => output } = {}) {
  const payloads = [1, 2].map((number) => ({
    id: 1000 + number,
    node_id: "SYNTHETIC_ISSUE_" + number,
    number,
    html_url: "https://github.com/" + slug + "/issues/" + number,
    created_at: ago(2),
    updated_at: ago(1),
    state: "open",
    user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  }));
  let memberships = [projectIds, []];
  const captured = new Map();
  let normalizedProjects = 0;
  const projectFact = (index, projects, runId) => {
    const subject = payloads[index];
    const snapshot = {
      schemaVersion: "github-project-subject-context/v1",
      repositoryId: 2,
      subjectId: subject.node_id,
      subjectKind: "issue",
      sourceUrl: subject.html_url,
      allowedProjectIds: projectIds,
      items: projects.map((projectId) => ({
        id: projectId + "_item_" + index,
        projectId,
        updatedAt: subject.updated_at,
        archived: false,
        fields: [{ fieldId: projectId + "_field", optionId: "blue" }],
      })),
    };
    const revision = components.github.githubSnapshotRevision(
      components.github.projectSubjectSnapshotRevision(snapshot),
      stableProjectRevisions ? "synthetic-stable-run" : runId,
    );
    captured.set(revision, structuredClone(snapshot));
    return sourceDocument(subject, revision, true);
  };
  const source = {
    async readPage(request) {
      const facts =
        request.family === "project_current"
          ? memberships.flatMap((projects, index) =>
              projects === null ? [] : [projectFact(index, projects, request.runId)],
            )
          : payloads.map((payload) => sourceDocument(payload, payload.updated_at));
      return { repositoryId: 2, visibility: "public", facts, nextCursor: null, expectedCount: facts.length };
    },
  };
  const normalizerFactory = (options) => {
    const configured = structuredClone(options.config.projectWorkstreamMappings[0]);
    const ordinary = components.github.createGithubEvidenceNormalizer({
      client: options.githubClient,
      source: options.sourceId,
      allowedRepositoryIds: [2],
      isSynthetic: true,
    });
    return async (input) => {
      if (input.family !== "project_current") return ordinary(input);
      normalizedProjects++;
      const snapshot = captured.get(input.fact.sourceRevision);
      assert.ok(snapshot, "only the captured synthetic source revision is available");
      const selectedMapping = { version: configured.version, projects: configured.projects };
      const output = {
        facts: [],
        actors: [],
        evidence: [],
        reasons: [],
        isSynthetic: true,
        projectContext: {
          schemaVersion: "github-current-project-context/v1",
          repositoryId: "2",
          subjectId: snapshot.subjectId,
          subjectKind: snapshot.subjectKind,
          sourceUrl: snapshot.sourceUrl,
          sourceRevision: input.fact.sourceRevision,
          observedAt: input.observedAt,
          mappingVersion: configured.version,
          context: {
            ...components.github.projectContextFromSnapshot(snapshot, selectedMapping),
            projectScope: projectIds,
          },
        },
      };
      return transformProjectOutput(output, input);
    };
  };
  const h = await harness(t, {
    source,
    payloads,
    normalizerFactory,
    configure(config) {
      config.repositories[0].families = ["issues", "project_current"];
      config.repositories[0].allowedProjectIds = projectIds;
      config.projectWorkstreamMappings = [mapping()];
    },
  });
  const frozen = async (publication) =>
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
        publication.snapshotId,
      ])
    ).rows[0];
  const collected = async (runId) => {
    await h.db.query(
      "INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode) SELECT fact_key,'synthetic' FROM leaderboard_ingestion.source_facts WHERE first_run_id=$1 ON CONFLICT DO NOTHING",
      [runId],
    );
  };
  return {
    ...h,
    frozen,
    projectFact,
    collected,
    normalizerFactory,
    normalizedProjects: () => normalizedProjects,
    setMemberships(value) {
      memberships = value;
    },
  };
}

test("completed Project scans bind private frozen context and partial/failed scans cannot replace it", async (t) => {
  const h = await projectHarness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  assert.equal(first.state, "published");
  const initial = await h.frozen(first.publications[0]);
  assert.equal(initial.document_hash, comparisonHash(initial.document));
  assert.equal(initial.document.frozen.facts.length, 2);
  const initialFact = initial.document.frozen.facts.find((fact) => fact.artifactId === "SYNTHETIC_ISSUE_1");
  assert.deepEqual(initialFact.currentContext.projects, projectIds);
  assert.deepEqual(initialFact.currentContext.workstreams, ["engineering"]);
  assert.equal(initialFact.eventContext, null);
  assert.equal(initial.document.engineScope.context, "event");
  assert.equal((await getBoard(h.runtime)).rows[0].result.value, 2);
  const originalNormalizations = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")
  ).rows;
  assert.equal(originalNormalizations.filter((row) => row.document.projectContext).length, 2);
  assert.ok(originalNormalizations.flatMap((row) => row.document.facts).every((fact) => fact.currentContext === null));
  const normalizationsBefore = h.normalizedProjects();

  const collection = new components.ingestion.CollectionStore(h.db);
  const runId = "synthetic-partial-project-run";
  await collection.start({
    runId,
    repositoryId: 2,
    family: "project_current",
    mode: "reconcile",
    since: null,
    until: clock(),
  });
  assert.equal(
    await collection.step(runId, {
      readPage: async () => ({
        repositoryId: 2,
        visibility: "public",
        facts: [h.projectFact(0, [], runId)],
        nextCursor: "later",
        expectedCount: 2,
      }),
    }),
    "progress",
  );
  await h.collected(runId);
  const partial = await h.runtime.runOnce({ cutoff });
  assert.equal(partial.state, "published");
  assert.deepEqual((await h.frozen(partial.publications[0])).document.frozen.facts, initial.document.frozen.facts);
  assert.equal(h.normalizedProjects(), normalizationsBefore, "a newer partial snapshot never enters normalization");
  assert.equal(
    await collection.step(runId, {
      readPage: async () => {
        throw new Error("synthetic page unavailable");
      },
    }),
    "failed",
  );
  const failed = await h.runtime.runOnce({ cutoff });
  assert.deepEqual((await h.frozen(failed.publications[0])).document.frozen.facts, initial.document.frozen.facts);
  assert.equal(h.normalizedProjects(), normalizationsBefore);

  const futureRun = "synthetic-future-complete-project-run";
  await collection.start({
    runId: futureRun,
    repositoryId: 2,
    family: "project_current",
    mode: "reconcile",
    since: null,
    until: clock(),
  });
  assert.equal(
    await collection.step(futureRun, {
      readPage: async () => ({
        repositoryId: 2,
        visibility: "public",
        facts: [h.projectFact(0, [], futureRun)],
        nextCursor: null,
        expectedCount: 1,
      }),
    }),
    "complete",
  );
  await h.collected(futureRun);
  await h.db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET last_success_at=clock_timestamp()+interval '1 day' WHERE run_id=$1",
    [futureRun],
  );
  const afterFuture = await h.runtime.runOnce({ cutoff });
  assert.deepEqual((await h.frozen(afterFuture.publications[0])).document.frozen.facts, initial.document.frozen.facts);
  assert.equal(h.normalizedProjects(), normalizationsBefore, "completion after the observation cutoff is ineligible");

  // Explicit empty membership clears the last Project. An absent subject in the
  // complete next inventory cannot inherit any earlier scoped association.
  h.setMemberships([[], null]);
  const next = await h.runtime.runOnce();
  assert.equal(next.state, "published");
  const current = await h.frozen(next.publications[0]);
  assert.equal(current.document.frozen.facts.length, 2);
  assert.deepEqual(
    current.document.frozen.facts.find((fact) => fact.artifactId === "SYNTHETIC_ISSUE_1").currentContext,
    { projects: [], workstreams: [], workstreamsKnown: true, projectScope: projectIds },
  );
  assert.equal(
    current.document.frozen.facts.find((fact) => fact.artifactId === "SYNTHETIC_ISSUE_2").currentContext,
    null,
  );
  assert.equal((await getBoard(h.runtime)).rows[0].result.value, 2);
  assert.deepEqual(await h.frozen(first.publications[0]), initial, "later context never rewrites frozen history");
  const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  for (const original of originalNormalizations)
    assert.deepEqual(
      retained.find((row) => row.fact_key === original.fact_key && row.policy_signature === original.policy_signature),
      original,
    );
  h.setMemberships([]);
  const noSubjects = await h.runtime.runOnce();
  assert.ok(
    (await h.frozen(noSubjects.publications[0])).document.frozen.facts.every((fact) => fact.currentContext === null),
  );
  assert.deepEqual(await h.frozen(next.publications[0]), current);
});

test("a changed field-ID mapping gets a distinct normalization cache and preserves the previous frozen receipt", async (t) => {
  const h = await projectHarness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  const initial = await h.frozen(first.publications[0]);
  const sourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  const originalNormalizations = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")
  ).rows;
  const configuration = structuredClone(h.options.config);
  configuration.version = "synthetic-configuration-project-mapping-v2";
  configuration.projectWorkstreamMappings[0].version = "synthetic-project-mapping/v2";
  for (const project of configuration.projectWorkstreamMappings[0].projects)
    project.fields[0].options[0].workstreamId = "operations";
  await h.runtime.stop();
  const options = { ...h.options, config: configuration };
  const nextRuntime = await createPipeline({ ...options, normalizer: h.normalizerFactory(options) });
  t.after(() => nextRuntime.stop());
  const next = await nextRuntime.runOnce({ cutoff });
  assert.equal(next.state, "published");
  const current = await h.frozen(next.publications[0]);
  assert.deepEqual(
    current.document.frozen.facts.find((fact) => fact.artifactId === "SYNTHETIC_ISSUE_1").currentContext.workstreams,
    ["operations"],
  );
  assert.notEqual(current.document.frozen.datasetId, initial.document.frozen.datasetId);
  assert.deepEqual(await h.frozen(first.publications[0]), initial);
  const nextSourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  for (const original of sourceRows)
    assert.deepEqual(
      nextSourceRows.find((row) => row.fact_key === original.fact_key),
      original,
    );
  const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
  assert.equal(retained.length, originalNormalizations.length * 2);
  for (const original of originalNormalizations)
    assert.deepEqual(
      retained.find((row) => row.fact_key === original.fact_key && row.policy_signature === original.policy_signature),
      original,
    );
});

test("a hash-consistent cache cannot retarget Project context to a different native subject", async (t) => {
  const h = await projectHarness(t);
  const cutoff = clock();
  await h.runtime.runOnce({ cutoff });
  const row = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations WHERE document ? 'projectContext' LIMIT 1")
  ).rows[0];
  const changed = structuredClone(row.document);
  changed.projectContext.subjectId = "SYNTHETIC_DIFFERENT_NATIVE_ID";
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
    [row.fact_key, row.policy_signature, JSON.stringify(changed), comparisonHash(changed)],
  );
  await assert.rejects(h.runtime.runOnce({ cutoff }), /invalid_normalized_project_context/);
});

test("marked current Project normalization without context cannot emit activity", async (t) => {
  let h;
  h = await projectHarness(t, {
    async transformProjectOutput(output, input) {
      const ordinary = components.github.createGithubEvidenceNormalizer({
        client: h.options.githubClient,
        source: h.options.sourceId,
        allowedRepositoryIds: [2],
        isSynthetic: true,
      });
      const number = input.fact.sourceUrl.split("/").at(-1);
      const payload = await h.options.githubClient.rest(h.options.sourceId, `/repos/${slug}/issues/${number}`);
      const fact = sourceDocument(payload, payload.updated_at);
      const activity = await ordinary({ ...input, family: "issues", fact });
      assert.ok(activity.facts.length > 0, "the injected action is otherwise valid issue evidence");
      delete output.projectContext;
      return { ...output, facts: activity.facts, actors: activity.actors, evidence: activity.evidence };
    },
  });
  await assert.rejects(h.runtime.runOnce(), /invalid_normalized_project_context/);
  assert.equal((await h.db.query("SELECT snapshot_id FROM leaderboard_pipeline.snapshots")).rows.length, 0);
});

test("a hash-consistent marked Project cache without context cannot manufacture activity", async (t) => {
  const h = await projectHarness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  const frozen = await h.frozen(first.publications[0]);
  const caches = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations")).rows;
  const row = caches.find((entry) => entry.document.projectContext);
  const ordinary = caches.find((entry) => entry.document.facts.length > 0);
  const changed = structuredClone(row.document);
  delete changed.projectContext;
  changed.facts = structuredClone(ordinary.document.facts);
  changed.actors = structuredClone(ordinary.document.actors);
  changed.evidence = structuredClone(ordinary.document.evidence);
  for (const fact of changed.facts) {
    fact.id += "-synthetic-forged";
    fact.artifactId = "SYNTHETIC_FORGED_ACTIVITY";
    fact.canonicalKey += "-synthetic-forged";
  }
  await h.db.query(
    "UPDATE leaderboard_pipeline.normalizations SET document=$3::jsonb,document_hash=$4 WHERE fact_key=$1 AND policy_signature=$2",
    [row.fact_key, row.policy_signature, JSON.stringify(changed), comparisonHash(changed)],
  );
  const normalizedBefore = h.normalizedProjects();
  await assert.rejects(h.runtime.runOnce({ cutoff }), /invalid_normalized_project_context/);
  assert.equal(h.normalizedProjects(), normalizedBefore, "cached receipt validation rejects before fresh hydration");
  assert.deepEqual(await h.frozen(first.publications[0]), frozen);
});

test("marked Project output without context remains a valid empty unknown receipt", async (t) => {
  const h = await projectHarness(t, {
    transformProjectOutput(output) {
      delete output.projectContext;
      output.reasons = ["project_snapshot_revision_or_subject_unverified"];
      return output;
    },
  });
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  assert.equal(first.state, "published");
  const frozen = await h.frozen(first.publications[0]);
  assert.equal(frozen.document.frozen.facts.length, 2);
  assert.ok(frozen.document.frozen.facts.every((fact) => fact.currentContext === null));
  assert.equal((await getBoard(h.runtime)).rows[0].result.value, 2);
  const normalizedBefore = h.normalizedProjects();
  const replay = await h.runtime.runOnce({ cutoff });
  assert.equal(replay.state, "published");
  assert.equal(h.normalizedProjects(), normalizedBefore, "empty unknown receipts remain eligible for cache reuse");
  assert.deepEqual(await h.frozen(first.publications[0]), frozen);
});

test("two equally recent completed Project inventories fail instead of forming an inferred union", async (t) => {
  const h = await projectHarness(t);
  const cutoff = clock();
  await h.runtime.runOnce({ cutoff });
  const collection = new components.ingestion.CollectionStore(h.db);
  const runs = ["synthetic-equal-project-a", "synthetic-equal-project-b"];
  for (const runId of runs) {
    await collection.start({
      runId,
      repositoryId: 2,
      family: "project_current",
      mode: "reconcile",
      since: null,
      until: clock(),
    });
    assert.equal(
      await collection.step(runId, {
        readPage: async () => ({
          repositoryId: 2,
          visibility: "public",
          facts: [],
          nextCursor: null,
          expectedCount: 0,
        }),
      }),
      "complete",
    );
  }
  await h.db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET last_success_at=clock_timestamp() WHERE run_id=ANY($1::text[])",
    [runs],
  );
  // Bind both rows to one exact database timestamp; clock_timestamp varies per row.
  await h.db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET last_success_at=(SELECT last_success_at FROM leaderboard_ingestion.collection_runs WHERE run_id=$1) WHERE run_id=$2",
    runs,
  );
  await assert.rejects(h.runtime.runOnce({ cutoff }), /ambiguous_current_project_run/);
});

test("current Project overlays preserve facts, match exact native identity, and reject ambiguous subject contexts", () => {
  const context = {
    repositoryId: "2",
    subjectId: "I_native",
    context: { projects: projectIds, projectScope: projectIds, workstreams: ["engineering"], workstreamsKnown: true },
  };
  const facts = [
    { id: "action-a", repoId: "2", artifactId: "I_native", currentContext: null, eventContext: null },
    { id: "comment-a", repoId: "2", artifactId: "IC_native", currentContext: null, eventContext: null },
    { id: "other-repo", repoId: "3", artifactId: "I_native", currentContext: null, eventContext: null },
  ];
  const before = structuredClone(facts);
  const result = applyCurrentProjectContexts(facts, [{ projectContext: context }]);
  assert.equal(result.length, facts.length);
  assert.deepEqual(result[0].currentContext.projects, projectIds);
  assert.equal(result[1].currentContext, null);
  assert.equal(result[2].currentContext, null);
  result[0].currentContext.projects.pop();
  assert.deepEqual(facts, before);
  assert.deepEqual(context.context.projects, projectIds);
  assert.throws(
    () => applyCurrentProjectContexts(facts, [{ projectContext: context }, { projectContext: context }]),
    /ambiguous_current_project_context/,
  );
});

test("host mappings reject unapproved repositories and fields outside the explicit approved Project scope", () => {
  const config = { repositories: [{ id: 2, allowedProjectIds: projectIds }], projectWorkstreamMappings: [mapping()] };
  const canonical = canonicalProjectWorkstreamMappings(config, components.github.validateProjectWorkstreamMapping);
  config.projectWorkstreamMappings[0].projects[0].fields[0].options[0].workstreamId = "mutated";
  assert.equal(canonical[0].projects[0].fields[0].options[0].workstreamId, "engineering");
  for (const candidate of [
    { ...mapping(), repositoryId: 3 },
    { ...mapping(), extra: "untrusted" },
    { ...mapping(), projects: [{ ...mapping().projects[0], projectId: "PVT_not_approved" }] },
  ])
    assert.throws(
      () =>
        canonicalProjectWorkstreamMappings(
          { ...config, projectWorkstreamMappings: [candidate] },
          components.github.validateProjectWorkstreamMapping,
        ),
      /invalid_project_workstream_mapping/,
    );
});

test("private context cannot claim a workstream belonging only to another Project or to no Project", () => {
  const configured = mapping();
  configured.projects[1].fields[0].options[0].workstreamId = "operations";
  const observedAt = "2026-10-18T10:00:00.000Z";
  const repository = { id: 2, slug, allowedProjectIds: projectIds };
  const row = {
    repository_id: 2,
    family: "project_current",
    subject_id: "I_native",
    observed_at: observedAt,
    document: {
      subjectId: "I_native",
      projectSubjectId: "I_native",
      evidence: "current_state",
      sourceUrl: "https://github.com/" + slug + "/issues/1",
      sourceRevision: "synthetic-current-revision",
    },
  };
  const base = {
    facts: [],
    actors: [],
    evidence: [],
    projectContext: {
      schemaVersion: "github-current-project-context/v1",
      repositoryId: "2",
      subjectId: "I_native",
      subjectKind: "issue",
      sourceUrl: row.document.sourceUrl,
      sourceRevision: row.document.sourceRevision,
      observedAt,
      mappingVersion: configured.version,
      context: {
        projects: [projectIds[0]],
        workstreams: ["engineering"],
        workstreamsKnown: true,
        projectScope: projectIds,
      },
    },
  };
  assert.deepEqual(normalizedProjectContext(base, row, repository, [configured]), {
    projectContext: base.projectContext,
  });
  for (const change of [
    { projects: [projectIds[0]], workstreams: ["operations"] },
    { projects: [], workstreams: ["engineering"] },
  ]) {
    const candidate = structuredClone(base);
    Object.assign(candidate.projectContext.context, change);
    assert.throws(
      () => normalizedProjectContext(candidate, row, repository, [configured]),
      /invalid_normalized_project_context/,
    );
  }
});

test("an unchanged source fact retained in a later completed scan keeps its current context", async (t) => {
  const h = await projectHarness(t, { stableProjectRevisions: true });
  const first = await h.runtime.runOnce();
  const initial = await h.frozen(first.publications[0]);
  const sourceRows = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  const normalized = h.normalizedProjects();
  const second = await h.runtime.runOnce();
  const current = await h.frozen(second.publications[0]);
  assert.deepEqual(current.document.frozen.facts, initial.document.frozen.facts);
  assert.deepEqual(
    current.document.frozen.facts.find((fact) => fact.artifactId === "SYNTHETIC_ISSUE_1").currentContext.projects,
    projectIds,
  );
  assert.equal(h.normalizedProjects(), normalized, "stable source revisions can safely reuse the same private receipt");
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
    sourceRows,
  );
  const latest = second.progress.find((entry) => entry.family === "project_current").runId;
  const memberships = (
    await h.db.query(
      "SELECT fact.first_run_id FROM leaderboard_ingestion.collection_items AS item JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key) WHERE item.run_id=$1",
      [latest],
    )
  ).rows;
  assert.equal(memberships.length, 2);
  assert.ok(memberships.every((entry) => entry.first_run_id !== latest));
});
