import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GithubReadClient,
  FileCheckpointStore,
  readProjectCurationHistory,
  projectCurationHistoryRevision,
  createGithubEvidenceNormalizer,
} from "../dist/index.js";
import {
  curationActor,
  curationEvent,
  curationProjectId,
  projectCurationFixture,
  curationReaderOptions,
} from "../../../tests/fixtures/project-curation.mjs";

const observedAt = "2026-10-03T00:00:00.000Z";
function normalizer(fixture, extra = {}) {
  return createGithubEvidenceNormalizer({
    client: fixture.client,
    source: "installation:synthetic-curation",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    ...extra,
  });
}
function input(fixture, record) {
  return {
    repository: fixture.repository,
    family: "project_curation_history",
    factKey: "synthetic-" + record.event.id,
    policyVersion: "synthetic-curation/v1",
    observedAt,
    fact: {
      subjectId: record.event.id,
      historySubjectId: record.subject.id,
      projectCurationProjectId: record.event.project.id,
      sourceRevision: projectCurationHistoryRevision(record),
      sourceUrl: record.subject.url,
      evidence: "observed_transition",
      actorId: record.event.actor?.databaseId ? String(record.event.actor.databaseId) : null,
      occurredAt: record.event.createdAt,
      state: "present",
    },
  };
}

test("native issue add and PR remove bind subject, Project, event, actor and source clock without a PVTI", async () => {
  const fixture = projectCurationFixture();
  for (const [number, kind, action] of [
    [1, "issue", "added"],
    [2, "pull_request", "removed"],
  ]) {
    const [record] = await readProjectCurationHistory(curationReaderOptions(fixture, number));
    const collected = input(fixture, record);
    const before = structuredClone(collected);
    const output = await normalizer(fixture)(collected);
    assert.deepEqual(collected, before);
    assert.equal(output.facts.length, 1);
    assert.equal(output.facts[0].metricId, "project_items_curated");
    assert.equal(output.facts[0].artifactId, record.subject.id);
    assert.equal(output.facts[0].actorId, "202");
    assert.equal(output.facts[0].occurredAt, record.event.createdAt);
    assert.equal(output.facts[0].rawState, action + ":" + curationProjectId);
    assert.equal(output.evidence[0].artifact.kind, kind);
    assert.equal(output.evidence[0].artifact.publicUrl, record.subject.url);
    assert.equal(output.evidence[0].contribution.contributionId, output.facts[0].id);
    assert.equal(output.evidence[0].contribution.canonicalEventId, output.facts[0].canonicalKey);
    assert.equal(output.evidence[0].evidenceMetadata.sourceAction, "relationship_changed");
    assert.deepEqual(output.facts[0].eventContext.projects, [curationProjectId]);
    assert.equal(output.facts[0].currentContext, null);
    assert.equal(output.observations[0].action, action);
    assert.equal(output.actors[0].executionMode, "unknown");
    assert.equal(JSON.stringify(output).includes("PVTI"), false);
  }
  for (const scan of fixture.state.reads.filter((value) => value.kind === "timeline")) {
    assert.match(scan.key, /^project-curation:subject-v1:/);
    assert.doesNotMatch(scan.query, /STATUS_CHANGED|fieldValues|creator|projectItems|\bbody\b|\btitle\b/);
  }
});

test("native Project curation keeps automated, unknown and reviewed service-account identities separate", async () => {
  for (const [nativeActor, automated, expectedKind, expectedRole] of [
    [curationActor, true, "user", "automation"],
    [null, false, null, "triager"],
    [{ ...curationActor, __typename: "Bot" }, false, "bot", "triager"],
  ]) {
    const fixture = projectCurationFixture();
    fixture.state.events.set(1, [curationEvent("PVE_CLASSIFICATION", { actor: nativeActor, wasAutomated: automated })]);
    const [record] = await readProjectCurationHistory(curationReaderOptions(fixture));
    const output = await normalizer(fixture)(input(fixture, record));
    assert.equal(output.facts[0].role, expectedRole);
    assert.equal(output.facts[0].state, nativeActor ? "observed" : "unknown");
    assert.equal(output.actors[0]?.kind ?? null, expectedKind);
    assert.equal(output.actors[0]?.executionMode ?? null, nativeActor ? (automated ? "automated" : "unknown") : null);
    assert.equal(output.facts[0].acceptedAt, null);
    assert.equal(output.facts[0].acceptanceReceipt, null);
  }
  const fixture = projectCurationFixture();
  const [record] = await readProjectCurationHistory(curationReaderOptions(fixture));
  const classification = {
    schemaVersion: "leaderboard-service-account/v1",
    classificationId: "synthetic-reviewed-curation-account",
    githubDatabaseId: 202,
    githubNodeId: curationActor.id,
    source: "reviewed_configuration",
    evidenceIds: ["synthetic-account-record"],
    reviewerActorId: "303",
    reviewedAt: "2026-09-01T00:00:00Z",
  };
  const output = await normalizer(fixture, {
    reviewedServiceAccounts: [classification],
    authorizedClassifierIds: ["303"],
  })(input(fixture, record));
  assert.equal(output.actors[0].kind, "service_account");
  assert.deepEqual(output.actors[0].serviceAccountClassification, classification);
  assert.equal(output.actors[0].executionMode, "unknown");
  for (const invalid of [
    { reviewedServiceAccounts: [classification], authorizedClassifierIds: [] },
    {
      reviewedServiceAccounts: [{ ...classification, githubNodeId: "U_OTHER_SYNTHETIC_ACCOUNT" }],
      authorizedClassifierIds: ["303"],
    },
    {
      reviewedServiceAccounts: [{ ...classification, reviewedAt: "2027-01-01T00:00:00Z" }],
      authorizedClassifierIds: ["303"],
    },
  ])
    await assert.rejects(
      normalizer(fixture, invalid)(input(fixture, record)),
      /service-account classification|Service-account classification/,
    );
});

test("malformed native curation events fail while unapproved identified Projects are omitted", async () => {
  for (const patch of [
    { id: "" },
    { __typename: "ProjectV2ItemStatusChangedEvent" },
    { createdAt: "2026-02-30T12:00:00Z" },
    { createdAt: "2026-10-01T12:00:00.0001Z" },
    { wasAutomated: undefined },
    { wasAutomated: "false" },
    { project: null },
    { project: { id: curationProjectId, public: false } },
  ]) {
    const fixture = projectCurationFixture();
    fixture.state.events.set(1, [curationEvent("PVE_INVALID", patch)]);
    await assert.rejects(readProjectCurationHistory(curationReaderOptions(fixture)), /project_curation_/);
  }
  const fixture = projectCurationFixture();
  fixture.state.events.set(1, [curationEvent("PVE_OTHER", { project: { id: "PVT_NOT_APPROVED", public: false } })]);
  assert.deepEqual(await readProjectCurationHistory(curationReaderOptions(fixture)), []);
});

test("native curation subject, repository and Project scope are rechecked after the awaited scan", async () => {
  for (const change of [
    (state) => {
      state.repositoryPublic = false;
    },
    (state) => {
      state.repositoryId = 3;
    },
    (state) => {
      state.hiddenSubject = true;
    },
    (state) => {
      state.changedSubject = true;
    },
    (state) => {
      state.projectPublic = false;
    },
  ]) {
    const fixture = projectCurationFixture();
    fixture.state.afterScan = () => change(fixture.state);
    await assert.rejects(
      readProjectCurationHistory(curationReaderOptions(fixture)),
      /project_(?:curation_|not_authorized)/,
    );
  }
});

test("duplicate or forged returned native records cannot use a completed scan as authority", async () => {
  const fixture = projectCurationFixture();
  const [record] = await readProjectCurationHistory(curationReaderOptions(fixture));
  for (const records of [
    [record, structuredClone(record)],
    [{ ...record, subject: { ...record.subject, id: "I_OTHER" } }],
    [{ ...record, subject: { ...record.subject, kind: "pull_request" } }],
    [{ ...record, event: { ...record.event, project: { id: curationProjectId, public: false } } }],
  ]) {
    fixture.client.scanGraphql = async () => structuredClone(records);
    await assert.rejects(readProjectCurationHistory(curationReaderOptions(fixture)), /project_curation_/);
  }
});

test("collected curation identity and exact revision are prerequisites for normalization", async () => {
  const fixture = projectCurationFixture();
  const [record] = await readProjectCurationHistory(curationReaderOptions(fixture));
  for (const patch of [
    { historySubjectId: undefined },
    { projectCurationProjectId: undefined },
    { evidence: "current_state" },
    { sourceRevision: "wrong-revision" },
    { occurredAt: observedAt },
    { actorId: "999" },
    { sourceUrl: "https://github.com/other/repository/issues/1" },
  ]) {
    const collected = input(fixture, record);
    Object.assign(collected.fact, patch);
    const output = await normalizer(fixture)(collected);
    assert.deepEqual(output.facts, []);
  }
  const collected = input(fixture, record);
  fixture.state.events.set(1, []);
  await assert.rejects(normalizer(fixture)(collected), /project_curation_event_unavailable/);
  // A separately approved narrower scope excludes the old Project before a
  // source read; it does not reinterpret missing currently approved history.
  collected.repository = { ...fixture.repository, allowedProjectIds: ["PVT_ANOTHER_APPROVED"] };
  assert.deepEqual((await normalizer(fixture)(collected)).facts, []);
});

test("real repository-scoped checkpoints paginate, refresh and refuse native curation after retirement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-curation-checkpoints-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkpoints = new FileCheckpointStore(directory);
  const fixture = projectCurationFixture();
  let timelineReads = 0;
  let totalReads = 0;
  const client = new GithubReadClient({
    token: async () => "synthetic-read-only-token",
    checkpoints,
    maxRetries: 0,
    fetch: async (_url, init) => {
      totalReads++;
      const { query, variables } = JSON.parse(init.body);
      let data;
      if (variables.id) data = { node: { id: variables.id, public: true } };
      else if (query.includes("timelineItems")) {
        timelineReads++;
        const second = variables.after !== null;
        data = fixture.data(1, query, [
          curationEvent(second ? "PVE_PAGE_2" : "PVE_PAGE_1", {
            __typename: second ? "RemovedFromProjectV2Event" : "AddedToProjectV2Event",
          }),
        ]);
        data.repository.issue.timelineItems.pageInfo = {
          hasNextPage: !second,
          endCursor: second ? null : "synthetic-next",
        };
      } else data = fixture.data(1, query);
      return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    },
  });
  const options = { ...curationReaderOptions(fixture), client };
  const first = await readProjectCurationHistory(options);
  const second = await readProjectCurationHistory(options);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map((record) => record.event.id),
    ["PVE_PAGE_1", "PVE_PAGE_2"],
  );
  assert.equal(timelineReads, 4, "the completed native scan is refreshed on the same key");
  await assert.rejects(
    readProjectCurationHistory({ ...options, scanId: "synthetic-bounded-scan", maxPages: 1 }),
    /Source pagination exceeded maxPages/,
  );
  assert.equal(timelineReads, 5);
  assert.deepEqual(
    await readProjectCurationHistory({ ...options, scanId: "synthetic-bounded-scan", maxPages: 2 }),
    first,
    "retry refreshes the partial bounded scan instead of treating it as complete",
  );
  assert.equal(timelineReads, 7);
  const beforeRetirement = totalReads;
  await checkpoints.forRepository(2).retire({
    operationId: "synthetic-curation-retirement",
    policyId: "synthetic-retention-policy",
    authorizationId: "synthetic-owner-approval",
  });
  await assert.rejects(readProjectCurationHistory(options), /retired|unsafe_request/);
  assert.equal(totalReads, beforeRetirement);
});

test("native curation captures caller scope before awaits and retains the final host-authorization check", async () => {
  const fixture = projectCurationFixture();
  const options = curationReaderOptions(fixture);
  fixture.state.afterProject = () => {
    options.repository.id = 3;
    options.repository.slug = "other/repository";
    options.repository.allowedProjectIds[0] = "PVT_NOT_APPROVED";
    options.number = 2;
    options.subjectId = "PR_REPLACED";
    options.subjectType = "pull_request";
    options.scanId = "changed-run";
  };
  const [record] = await readProjectCurationHistory(options);
  assert.equal(record.subject.id, "I_SYNTHETIC_CURATION");
  assert.equal(record.event.project.id, curationProjectId);
  const scan = fixture.state.reads.find((read) => read.kind === "timeline");
  assert.match(scan.key, /\[2,"issue",1,"I_SYNTHETIC_CURATION","synthetic-curation-audit"\]/);
  assert.ok(
    fixture.state.reads
      .filter((read) => read.kind === "project")
      .every((read) => read.variables.id === curationProjectId),
  );

  const denied = projectCurationFixture();
  let authorized = true;
  let projectReads = 0;
  denied.state.afterProject = () => {
    if (++projectReads === 2) authorized = false;
  };
  await assert.rejects(
    readProjectCurationHistory({
      ...curationReaderOptions(denied),
      assertAuthorized: () => {
        if (!authorized) throw new Error("synthetic_host_authority_revoked");
      },
    }),
    /synthetic_host_authority_revoked/,
  );
});

test("curation normalization detaches collected identity and clocks before native I/O", async () => {
  const fixture = projectCurationFixture();
  const [record] = await readProjectCurationHistory(curationReaderOptions(fixture));
  const collected = input(fixture, record);
  const expected = await normalizer(fixture)(structuredClone(collected));
  let mutations = 0;
  fixture.state.afterScan = () => {
    mutations++;
    Object.assign(collected.fact, {
      subjectId: "PVE_REPLACED",
      historySubjectId: "I_REPLACED",
      projectCurationProjectId: "PVT_REPLACED",
      sourceRevision: "replaced-revision",
      sourceUrl: "https://github.com/other/repository/issues/9",
      actorId: "999",
      occurredAt: "2026-10-09T00:00:00.000Z",
    });
    collected.fact = { ...collected.fact, subjectId: "PVE_REPLACED_AGAIN" };
    collected.repository.id = 9;
    collected.repository.slug = "other/repository";
    collected.repository.allowedProjectIds[0] = "PVT_REPLACED";
    collected.family = "project_history";
    collected.factKey = "replaced-request";
    collected.policyVersion = "replaced-policy";
    collected.observedAt = "2026-09-01T00:00:00.000Z";
  };
  const actual = await normalizer(fixture)(collected);
  assert.equal(mutations, 1);
  assert.deepEqual(actual, expected);
  assert.equal(collected.fact.subjectId, "PVE_REPLACED_AGAIN");
  assert.equal(collected.repository.id, 9);

  const repair = projectCurationFixture();
  const [repairRecord] = await readProjectCurationHistory(curationReaderOptions(repair));
  const invalid = input(repair, repairRecord);
  invalid.fact.sourceRevision = "unverified-original-revision";
  repair.state.afterScan = () => {
    invalid.fact.sourceRevision = projectCurationHistoryRevision(repairRecord);
    invalid.observedAt = "2026-10-10T00:00:00.000Z";
  };
  const denied = await normalizer(repair)(invalid);
  assert.deepEqual(denied.facts, []);
  assert.deepEqual(denied.reasons, ["project_curation_revision_or_clock_unverified"]);
  assert.equal(invalid.fact.sourceRevision, projectCurationHistoryRevision(repairRecord));
});
