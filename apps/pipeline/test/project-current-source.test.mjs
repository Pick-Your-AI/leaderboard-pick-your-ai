import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileCheckpointStore,
  GithubClientError,
  GithubReadClient,
  createGithubEvidenceNormalizer,
  githubSnapshotRevision,
  projectSubjectSnapshotRevision,
  readPublicSubjectProjectSnapshot,
} from "../../../packages/github/dist/index.js";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { aggregateMetric, getMetricDefinition, metricRegistryV1 } from "../../../packages/metrics/dist/index.js";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { applyCurrentProjectContexts, normalizedProjectContext } from "../src/project-context.mjs";

const repository = {
  id: 37,
  installationId: 1,
  slug: "synthetic-owner/project-contexts",
  families: ["project_current", "issues", "pull_requests"],
  allowedProjectIds: ["PVT_alpha", "PVT_beta", "PVT_gamma"],
};
const observedAt = "2026-10-18T10:00:00.000Z";
const sourceUpdatedAt = "2026-10-17T10:00:00Z";
const request = { repositoryId: 37, runId: "synthetic-first", family: "project_current", cursor: null, limit: 100 };
const scope = {
  timezone: "UTC",
  from: "2026-10-01T00:00:00Z",
  to: observedAt,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const mapping = () => ({
  repositoryId: repository.id,
  version: "synthetic-project-mapping/v1",
  projects: repository.allowedProjectIds.map((projectId) => ({
    projectId,
    fields: [
      {
        fieldId: projectId.replace("PVT_", "PVTSSF_"),
        options: [{ optionId: "option_blue", workstreamId: "engineering" }],
      },
    ],
  })),
});
const member = (suffix, number = 1) => ({
  id: `PVTI_${suffix}_${number}`,
  updatedAt: sourceUpdatedAt,
  isArchived: false,
  project: { id: `PVT_${suffix}`, public: true },
});
const payload = (number, pull = false) => ({
  id: 100 + number,
  node_id: pull ? "PR_synthetic" : "I_synthetic",
  number,
  html_url: `https://github.com/${repository.slug}/${pull ? "pull" : "issues"}/${number}`,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: sourceUpdatedAt,
  state: pull ? "closed" : "open",
  user: { id: 1000 + number, node_id: `U_synthetic_${number}`, login: `synthetic-user-${number}`, type: "User" },
  ...(pull ? { pull_request: {}, merged: false, closed_at: "2026-10-03T00:00:00Z" } : {}),
});

/** No stubbed collector/normalizer outputs: only the HTTP boundary supplies synthetic GitHub data. */
function harness(checkpointStore = syntheticCheckpointStore()) {
  const state = {
    subjects: [payload(1), payload(2, true)],
    memberships: { I_synthetic: [member("alpha"), member("beta")], PR_synthetic: [] },
    selectedOptions: {},
  };
  const calls = [];
  const binding = (subject) => ({
    __typename: subject.pull_request ? "PullRequest" : "Issue",
    id: subject.node_id,
    url: subject.html_url,
    repository: { databaseId: repository.id, isPrivate: false },
  });
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-token",
    maxRetries: 0,
    checkpoints: checkpointStore,
    fetch: async (value, options) => {
      const url = new URL(value);
      let body;
      const headers = { "content-type": "application/json" };
      if (url.pathname === "/graphql") {
        const { query, variables } = JSON.parse(options.body);
        calls.push({ query, variables });
        const connection = (nodes) => {
          const offset = variables.after === null ? 0 : Number(variables.after);
          return {
            nodes: structuredClone(nodes.slice(offset, offset + 1)),
            totalCount: nodes.length,
            pageInfo: {
              hasNextPage: offset + 1 < nodes.length,
              endCursor: offset + 1 < nodes.length ? String(offset + 1) : null,
            },
          };
        };
        if (query.includes("PublicProjectContextScope")) {
          body = { data: { nodes: variables.ids.map((id) => ({ id, public: true })) } };
        } else if (query.includes("PublicSubjectProjectMembership")) {
          assert.match(query, /includeArchived\s*:\s*true/);
          const subject = state.subjects.find((entry) => entry.node_id === variables.id);
          assert.ok(subject);
          body = { data: { node: { ...binding(subject), projectItems: connection(state.memberships[variables.id]) } } };
        } else if (query.includes("PublicSubjectProjectFields")) {
          const subject = state.subjects.find((entry) =>
            state.memberships[entry.node_id].some((item) => item.id === variables.id),
          );
          assert.ok(subject);
          const item = state.memberships[subject.node_id].find((entry) => entry.id === variables.id);
          body = {
            data: {
              node: {
                ...structuredClone(item),
                content: binding(subject),
                fieldValues: connection([
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    field: { id: item.project.id.replace("PVT_", "PVTSSF_") },
                    optionId: state.selectedOptions[item.id] ?? "option_blue",
                  },
                ]),
              },
            },
          };
        } else if (query.includes("... on ProjectV2 { id public }")) {
          assert.ok(repository.allowedProjectIds.includes(variables.id));
          body = { data: { node: { id: variables.id, public: true } } };
        } else assert.fail("Unexpected GraphQL source query");
      } else if (url.pathname === `/repos/${repository.slug}`) {
        body = { id: repository.id, private: false, full_name: repository.slug, default_branch: "main" };
      } else if (url.pathname === `/repos/${repository.slug}/issues`) {
        const second = url.searchParams.get("page") === "2";
        body = state.subjects.slice(second ? 1 : 0, second ? undefined : 1);
        if (!second && state.subjects.length > 1) {
          url.searchParams.set("page", "2");
          headers.link = `<${url}>; rel="next"`;
        }
      } else if (url.pathname === `/repos/${repository.slug}/pulls`) {
        body = state.subjects.filter((entry) => entry.pull_request).map(({ pull_request, ...entry }) => entry);
      } else {
        const match = url.pathname.match(/\/(?:issues|pulls)\/([1-9]\d*)$/);
        body = state.subjects.find((entry) => String(entry.number) === match?.[1]);
        assert.ok(body, `Unexpected REST source route ${url.pathname}`);
        if (url.pathname.includes("/pulls/")) {
          const { pull_request, ...pull } = body;
          body = pull;
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers });
    },
  });
  const source = createGithubCollectionSource({
    client,
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
  });
  const normalizer = (projectWorkstreamMappings = [mapping()]) =>
    createGithubEvidenceNormalizer({
      client,
      source: "synthetic",
      allowedRepositoryIds: [repository.id],
      isSynthetic: true,
      projectWorkstreamMappings,
    });
  const input = (fact, patch = {}) => ({
    repository,
    family: "project_current",
    factKey: `synthetic:${fact.subjectId}`,
    observedAt,
    policyVersion: "synthetic/v1",
    selectedCurrentState: true,
    fact,
    ...patch,
  });
  const normalize = normalizer();
  return { state, calls, client, source, normalizer, input, normalize: (fact, patch) => normalize(input(fact, patch)) };
}

async function checkpointFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "project-context-retirement-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "cache");
  return { cache, store: new FileCheckpointStore(cache) };
}

test("native Project normalization keeps actual collector and hydration payloads in its repository namespace", async (t) => {
  const { cache, store } = await checkpointFixture(t);
  const h = harness(store);
  const fact = (await h.source.readPage(request)).facts[0];
  assert.deepEqual(await readdir(cache), ["repositories-v1"]);
  const output = await h.normalize(fact);
  assert.deepEqual(output.projectContext.context.projects, ["PVT_alpha", "PVT_beta"]);
  assert.deepEqual(output.facts, []);
  assert.deepEqual(output.actors, []);
  assert.deepEqual(output.evidence, []);
  assert.ok((await readdir(join(cache, "repositories-v1", String(repository.id)))).length > 0);
  assert.deepEqual(await readdir(cache), ["repositories-v1"]);
});

for (const reopened of [false, true]) {
  test(`native Project normalization denies retired repository payloads before HTTP${reopened ? " after reopening the store" : " in the existing client"}`, async (t) => {
    const { cache, store } = await checkpointFixture(t);
    const h = harness(store);
    const fact = (await h.source.readPage(request)).facts[0];
    const before = await h.normalize(fact);
    assert.deepEqual(before.projectContext.context.projects, ["PVT_alpha", "PVT_beta"]);
    assert.deepEqual(before.facts, []);
    const receipt = await store.forRepository(repository.id).retire({
      operationId: "synthetic-project-context-retirement",
      policyId: "synthetic-retention-policy-v1",
      authorizationId: "synthetic-retention-authorization",
    });
    assert.equal(receipt.repositoryId, repository.id);
    assert.equal(receipt.checkpointPayloadsRemoved, true);
    const selected = reopened ? harness(new FileCheckpointStore(cache)) : h;
    const callsBefore = selected.calls.length;
    await assert.rejects(
      selected.normalize(fact),
      (error) => error instanceof GithubClientError && error.outcome.kind === "unsafe_request",
    );
    assert.equal(selected.calls.length, callsBefore, "retired normalization must stop before another GraphQL request");
  });
}

function policy(metricId = "issues_opened") {
  return {
    metricId,
    version: "synthetic-current-context/v1",
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition(metricId).definition.unit,
    aggregation: "count",
    dateBasis: "occurredAt",
    rankedStates: ["observed"],
    roles: metricId === "issues_opened" ? ["reporter"] : ["author"],
    groupBy: "canonical",
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
  };
}
function frozen(ordinary, projectContext) {
  return {
    datasetId: "synthetic-current-contexts",
    cutoff: observedAt,
    backfillRevision: "synthetic/v1",
    repositoryIds: [String(repository.id)],
    actors: ordinary.actors,
    facts: ordinary.facts.map((fact) => ({
      ...fact,
      // The pipeline's separate persistence tests own selection and this join.
      // Here a copy receives only a context with the exact already-proven native subject/repository ID.
      currentContext:
        projectContext?.subjectId === fact.artifactId && projectContext.repositoryId === fact.repoId
          ? structuredClone(projectContext.context)
          : null,
    })),
    coverage: [],
  };
}
async function ordinary(h, family = "issues") {
  const page = await h.source.readPage({ ...request, family });
  assert.equal(page.facts.length, 1);
  return h.normalize(page.facts[0], { family });
}

test("real current Project collection emits one marked native issue/PR row, including an explicit empty PR", async () => {
  const h = harness();
  const first = await h.source.readPage({ ...request, limit: 1 });
  assert.equal(first.expectedCount, 2);
  assert.equal(first.nextCursor, "1");
  const second = await h.source.readPage({ ...request, cursor: first.nextCursor, limit: 1 });
  assert.equal(second.nextCursor, null);
  const collected = [...first.facts, ...second.facts];
  assert.deepEqual(
    collected.map((fact) => fact.subjectId),
    ["I_synthetic", "PR_synthetic"],
  );
  for (const fact of collected) {
    assert.equal(fact.projectSubjectId, fact.subjectId);
    assert.equal(fact.actorId, null);
    assert.equal(fact.occurredAt, null);
    assert.equal(fact.evidence, "current_state");
    const snapshot = await readPublicSubjectProjectSnapshot({
      client: h.client,
      source: "synthetic",
      repository,
      subjectId: fact.subjectId,
      sourceUrl: fact.sourceUrl,
      allowedProjectIds: repository.allowedProjectIds,
      scanId: "synthetic-independent-read",
    });
    assert.equal(fact.sourceRevision, githubSnapshotRevision(projectSubjectSnapshotRevision(snapshot), request.runId));
    const output = await h.normalize(fact);
    assert.deepEqual(output.facts, []);
    assert.deepEqual(output.actors, []);
    assert.deepEqual(output.evidence, []);
    assert.equal(output.projectContext.schemaVersion, "github-current-project-context/v2");
    assert.equal(output.projectContext.subjectId, fact.subjectId);
    assert.equal(output.projectContext.sourceRevision, fact.sourceRevision);
    assert.equal(output.projectContext.observedAt, observedAt);
    assert.deepEqual(output.projectContext.context.projectScope, repository.allowedProjectIds);
  }
  const pr = await h.normalize(collected[1]);
  assert.equal(pr.projectContext.subjectKind, "pull_request");
  assert.deepEqual(pr.projectContext.context, {
    projects: [],
    workstreams: [],
    workstreamsKnown: true,
    projectScope: repository.allowedProjectIds,
    workstreamScope: ["engineering"],
  });
});

test("current Project output pagination hydrates only its selected native subjects while preserving the full count", async () => {
  const h = harness();
  const first = await h.source.readPage({ ...request, limit: 1 });
  const firstCalls = [...h.calls];
  const boundary = h.calls.length;
  assert.equal(first.expectedCount, 2);
  assert.equal(first.nextCursor, "1");
  assert.deepEqual(
    first.facts.map((fact) => fact.subjectId),
    ["I_synthetic"],
  );
  assert.deepEqual(
    [
      ...new Set(
        firstCalls
          .filter((call) => call.query.includes("PublicSubjectProjectMembership"))
          .map((call) => call.variables.id),
      ),
    ],
    ["I_synthetic"],
  );
  assert.ok(firstCalls.filter((call) => call.query.includes("PublicSubjectProjectFields")).length > 0);

  const second = await h.source.readPage({ ...request, cursor: first.nextCursor, limit: 1 });
  const secondCalls = h.calls.slice(boundary);
  assert.equal(second.expectedCount, 2);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    second.facts.map((fact) => fact.subjectId),
    ["PR_synthetic"],
  );
  assert.deepEqual(
    [
      ...new Set(
        secondCalls
          .filter((call) => call.query.includes("PublicSubjectProjectMembership"))
          .map((call) => call.variables.id),
      ),
    ],
    ["PR_synthetic"],
  );
  assert.equal(secondCalls.filter((call) => call.query.includes("PublicSubjectProjectFields")).length, 0);

  const full = await h.source.readPage(request);
  assert.equal(full.expectedCount, 2);
  assert.equal(full.nextCursor, null);
  assert.deepEqual([...first.facts, ...second.facts], full.facts);
});

test("multiple current Projects leave one organization contribution and unknown event membership", async () => {
  const h = harness();
  const page = await h.source.readPage(request);
  const context = (await h.normalize(page.facts[0])).projectContext;
  const original = await ordinary(h);
  assert.ok(original.facts.every((fact) => fact.eventContext === null && fact.currentContext === null));
  const input = frozen(original, context);
  assert.equal(aggregateMetric(input, policy(), scope).rows[0].value, 1);
  const current = { ...scope, context: "current", projects: ["PVT_alpha", "PVT_beta"] };
  assert.equal(aggregateMetric(input, policy(), current).rows[0].value, 1);
  assert.equal(aggregateMetric(input, policy(), { ...current, workstreams: ["engineering"] }).rows[0].value, 1);
  const historical = aggregateMetric(input, policy(), { ...scope, projects: ["PVT_alpha"] });
  assert.deepEqual(historical.rows, []);
  assert.ok(historical.audit.some((entry) => entry.reason === "unknown_membership_context"));
  assert.ok(original.facts.every((fact) => fact.eventContext === null && fact.currentContext === null));
});

test("closed PR context binds its native PR facts without crediting Project collection", async () => {
  const h = harness();
  h.state.memberships.PR_synthetic = [member("gamma", 2)];
  const page = await h.source.readPage(request);
  const output = await h.normalize(page.facts.find((fact) => fact.subjectId === "PR_synthetic"));
  const pr = await ordinary(h, "pull_requests");
  assert.ok(pr.facts.some((fact) => fact.metricId === "pr_opened" && fact.artifactId === "PR_synthetic"));
  const aggregate = aggregateMetric(frozen(pr, output.projectContext), policy("pr_opened"), {
    ...scope,
    projects: ["PVT_gamma"],
    context: "current",
  });
  assert.deepEqual(
    aggregate.rows.map((row) => [row.actorId, row.value]),
    [["1002", 1]],
  );
  assert.deepEqual(output.facts, []);
});

test("a removed last membership yields a replacing empty row and rejects the previously collected snapshot", async () => {
  const h = harness();
  const before = (await h.source.readPage(request)).facts[0];
  const originalContext = (await h.normalize(before)).projectContext;
  const original = await ordinary(h);
  h.state.memberships.I_synthetic = [];
  const after = (await h.source.readPage({ ...request, runId: "synthetic-after-removal" })).facts[0];
  assert.equal(after.subjectId, before.subjectId);
  assert.equal(after.projectSubjectId, before.projectSubjectId);
  assert.notEqual(after.sourceRevision, before.sourceRevision);
  const rejected = await h.normalize(before);
  assert.equal(rejected.projectContext, undefined);
  const empty = (await h.normalize(after)).projectContext;
  assert.deepEqual(empty.context.projects, []);
  assert.equal(empty.context.workstreamsKnown, true);
  const beforeRows = aggregateMetric(frozen(original, originalContext), policy(), {
    ...scope,
    projects: ["PVT_alpha"],
    context: "current",
  });
  assert.equal(beforeRows.rows[0].value, 1);
  const afterRows = aggregateMetric(frozen(original, empty), policy(), {
    ...scope,
    projects: ["PVT_alpha"],
    context: "current",
  });
  assert.deepEqual(afterRows.rows, []);
  assert.ok(afterRows.audit.some((entry) => entry.reason === "project_filter"));
  assert.equal(aggregateMetric(frozen(original, empty), policy(), scope).rows[0].value, 1);
});

test("versioned field/option mappings change only current association, retaining exact source revision", async () => {
  const h = harness();
  const collected = (await h.source.readPage(request)).facts[0];
  const first = (await h.normalize(collected)).projectContext;
  const changed = mapping();
  changed.version = "synthetic-project-mapping/v2";
  for (const project of changed.projects) project.fields[0].options[0].workstreamId = "research";
  const next = (await h.normalizer([changed])(h.input(collected))).projectContext;
  assert.equal(next.sourceRevision, first.sourceRevision);
  assert.equal(next.mappingVersion, changed.version);
  assert.notEqual(next.mappingVersion, first.mappingVersion);
  assert.deepEqual(first.context.workstreams, ["engineering"]);
  assert.deepEqual(next.context.workstreams, ["research"]);
  const versionOnly = { ...mapping(), version: "synthetic-project-mapping/v3" };
  const versioned = (await h.normalizer([versionOnly])(h.input(collected))).projectContext;
  assert.deepEqual(versioned.context, first.context);
  assert.notEqual(versioned.mappingVersion, first.mappingVersion);
});

test("an already-created normalizer owns a detached mapping and caller mutation cannot reclassify its context", async () => {
  const h = harness();
  const collected = (await h.source.readPage(request)).facts[0];
  const configured = mapping();
  const normalize = h.normalizer([configured]);
  configured.version = "synthetic-mutated";
  for (const project of configured.projects) project.fields[0].options[0].workstreamId = "mutated";
  const output = await normalize(h.input(collected));
  assert.equal(output.projectContext.mappingVersion, "synthetic-project-mapping/v1");
  assert.deepEqual(output.projectContext.context.workstreams, ["engineering"]);
});

test("missing mapping keeps Project membership usable and workstream filters explicitly unknown", async () => {
  const h = harness();
  const collected = (await h.source.readPage(request)).facts[0];
  const output = await h.normalizer([])(h.input(collected));
  assert.equal(output.projectContext.mappingVersion, null);
  assert.equal(output.projectContext.context.workstreamsKnown, false);
  const input = frozen(await ordinary(h), output.projectContext);
  assert.equal(
    aggregateMetric(input, policy(), { ...scope, projects: ["PVT_alpha"], context: "current" }).rows[0].value,
    1,
  );
  const filtered = aggregateMetric(input, policy(), { ...scope, workstreams: ["engineering"], context: "current" });
  assert.deepEqual(filtered.rows, []);
  assert.ok(filtered.audit.some((entry) => entry.reason === "unknown_membership_context"));
});

test("an unmapped selected option retains unknown workstream context after collection and normalization", async () => {
  const h = harness();
  h.state.selectedOptions.PVTI_alpha_1 = "option_not_configured";
  h.state.selectedOptions.PVTI_beta_1 = "option_not_configured";
  const collected = (await h.source.readPage(request)).facts[0];
  const output = await h.normalize(collected);
  assert.equal(output.projectContext.context.workstreamsKnown, false);
  assert.deepEqual(output.projectContext.context.workstreams, []);
  const filtered = aggregateMetric(frozen(await ordinary(h), output.projectContext), policy(), {
    ...scope,
    workstreams: ["engineering"],
    context: "current",
  });
  assert.deepEqual(filtered.rows, []);
  assert.ok(filtered.audit.some((entry) => entry.reason === "unknown_membership_context"));
});

test("a Project filter outside the collected approved scope is unknown rather than a known absence", async () => {
  const h = harness();
  const collected = (await h.source.readPage(request)).facts[0];
  const output = await h.normalize(collected);
  const input = frozen(await ordinary(h), output.projectContext);
  const unknown = aggregateMetric(input, policy(), { ...scope, projects: ["PVT_outside"], context: "current" });
  assert.deepEqual(unknown.rows, []);
  assert.ok(unknown.audit.some((entry) => entry.reason === "unknown_membership_context"));
  const absent = aggregateMetric(input, policy(), { ...scope, projects: ["PVT_gamma"], context: "current" });
  assert.deepEqual(absent.rows, []);
  assert.ok(absent.audit.some((entry) => entry.reason === "project_filter"));
});

test("unselected, wrong-subject and mismatched-revision rows cannot obtain a current context", async () => {
  const h = harness();
  const collected = (await h.source.readPage(request)).facts[0];
  for (const patch of [
    { selectedCurrentState: false },
    { fact: { ...collected, projectSubjectId: "I_other" } },
    {
      fact: {
        ...collected,
        sourceRevision: `${collected.sourceRevision[0] === "0" ? "1" : "0"}${collected.sourceRevision.slice(1)}`,
      },
    },
  ]) {
    const output = await h.normalize(collected, patch);
    assert.equal(output.projectContext, undefined);
    assert.deepEqual(output.facts, []);
    assert.ok(output.reasons.length > 0);
  }
});

test("a matching future-dated item snapshot cannot describe current membership at an earlier observation time", async () => {
  const h = harness();
  for (const item of h.state.memberships.I_synthetic) item.updatedAt = "2040-01-01T00:00:00Z";
  const collected = (await h.source.readPage(request)).facts[0];
  const output = await h.normalize(collected);
  assert.equal(output.projectContext, undefined);
  assert.deepEqual(output.facts, []);
  assert.ok(output.reasons.length > 0);
});

for (const scenario of [
  {
    name: "empty subject without a mapping",
    empty: true,
    mapped: false,
    requested: ["outside"],
    reason: "unknown_membership_context",
  },
  {
    name: "empty subject outside a bounded mapping",
    empty: true,
    requested: ["outside"],
    reason: "unknown_membership_context",
  },
  { name: "mapped nonempty subject outside its mapping", requested: ["outside"], reason: "unknown_membership_context" },
  {
    name: "empty subject within the proved mapping",
    empty: true,
    requested: ["engineering"],
    reason: "workstream_filter",
  },
  {
    name: "absent configured Project still proves workstream scope",
    requested: ["research"],
    reason: "workstream_filter",
  },
  {
    name: "unmatched mixed union remains unknown",
    requested: ["research", "outside"],
    reason: "unknown_membership_context",
  },
  { name: "proved positive survives an outside union member", requested: ["engineering", "outside"], reason: null },
  {
    name: "proved positive survives another unmapped membership",
    partial: true,
    requested: ["engineering"],
    reason: null,
  },
]) {
  test(`workstream scope: ${scenario.name}`, async () => {
    const h = harness();
    if (scenario.empty) h.state.memberships.I_synthetic = [];
    if (scenario.partial) h.state.memberships.I_synthetic.push(member("gamma"));
    const configured = mapping();
    configured.projects[2].fields[0].options[0].workstreamId = "research";
    if (scenario.partial) configured.projects.pop();
    const mappings = scenario.mapped === false ? [] : [configured];
    const collected = (await h.source.readPage(request)).facts.find((fact) => fact.subjectId === "I_synthetic");
    const output = await h.normalizer(mappings)(h.input(collected));
    const original = await ordinary(h);
    const originalBytes = JSON.stringify(original);
    const retained = normalizedProjectContext(
      output,
      {
        family: "project_current",
        document: collected,
        repository_id: repository.id,
        subject_id: collected.subjectId,
        observed_at: observedAt,
      },
      repository,
      mappings,
    );
    assert.ok(retained.projectContext);
    assert.deepEqual([output.facts, output.actors, output.evidence], [[], [], []]);
    const input = {
      ...frozen(original, null),
      facts: applyCurrentProjectContexts(original.facts, [retained]),
    };
    const result = aggregateMetric(input, policy(), { ...scope, context: "current", workstreams: scenario.requested });
    assert.equal(JSON.stringify(original), originalBytes, "context overlay must not mutate the source facts");
    if (scenario.reason === null) {
      assert.equal(result.rows[0].value, 1, "one native action contributes once to an OR scope");
    } else {
      assert.deepEqual(result.rows, []);
      assert.equal(result.audit.length, 1);
      assert.equal(result.audit[0].reason, scenario.reason);
    }
  });
}
