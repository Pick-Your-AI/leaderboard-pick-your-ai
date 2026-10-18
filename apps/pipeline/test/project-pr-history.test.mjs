import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubReadClient,
  createGithubEvidenceNormalizer,
  readTypedIssueHistory,
} from "../../../packages/github/dist/index.js";
import { createGithubCollectionSource } from "../src/github-source.mjs";

const origin = "https://api.synthetic.invalid";
const repository = {
  id: 2,
  installationId: 1,
  slug: "synthetic-owner/repository",
  families: ["project_history", "relationships"],
  allowedProjectIds: ["PVT_allowed"],
};
const request = { repositoryId: 2, runId: "synthetic", family: "project_history", cursor: null, limit: 100 };
const observedAt = "2026-10-02T00:00:00Z";
const projectEvent = (id, number) => ({
  id,
  __typename: "ProjectV2ItemStatusChangedEvent",
  createdAt: "2026-10-01T00:00:00Z",
  wasAutomated: false,
  actor: { id: `U_synthetic_${number}`, databaseId: 30 + number, __typename: "User", login: "synthetic-editor" },
  project: { id: "PVT_allowed", public: true },
});

function harness({ paginated = false } = {}) {
  const state = {
    publicProject: true,
    privateRepository: false,
    subjectUrl: undefined,
    subjectId: undefined,
    subjectIdAfter: undefined,
    events: [projectEvent("E_issue", 1), projectEvent("E_pull", 2)],
    previousStatus: "Todo",
    status: "Done",
    inventory: [
      { number: 1, node_id: "I_synthetic", state: "open", user: { id: 901 } },
      { number: 2, node_id: "PR_synthetic", state: "closed", user: { id: 902 }, pull_request: {} },
    ],
  };
  const calls = [];
  const values = new Map();
  const client = new GithubReadClient({
    apiOrigin: origin,
    token: async () => "synthetic-token",
    maxRetries: 0,
    checkpoints: syntheticCheckpointStore(values),
    fetch: async (value, options) => {
      const url = new URL(value);
      let body,
        headers = {};
      if (url.pathname === `/repos/${repository.slug}`) body = { id: 2, private: false };
      else if (url.pathname === `/repos/${repository.slug}/issues`) {
        body = state.inventory;
        if (paginated) {
          const second = url.searchParams.get("page") === "2";
          body = state.inventory.slice(second ? 1 : 0, second ? undefined : 1);
          if (!second) {
            url.searchParams.set("page", "2");
            headers.link = `<${url}>; rel="next"`;
          }
        }
      } else if (url.pathname === "/graphql") {
        const { query, variables } = JSON.parse(options.body);
        calls.push({ query, variables });
        if (query.includes("... on ProjectV2 {"))
          body = { data: { node: { id: "PVT_allowed", public: state.publicProject } } };
        else if (query.includes("previousStatus")) {
          const event = state.events.find((entry) => entry.id === variables.id);
          body = {
            data: {
              node: event ? { ...event, previousStatus: state.previousStatus, status: state.status } : null,
            },
          };
        } else {
          const isPull = query.includes("pullRequest(number:$number)");
          const field = isPull ? "pullRequest" : "issue";
          const isExpectedSubject = (variables.number === 2) === isPull;
          const events = state.events.filter((event) => event.id.startsWith(isPull ? "E_pull" : "E_issue"));
          const offset = variables.after === "synthetic-next" ? 1 : 0;
          const hasNextPage = paginated && !offset && events.length > 1;
          body = {
            data: {
              repository: {
                databaseId: 2,
                isPrivate: state.privateRepository,
                [field]: isExpectedSubject
                  ? {
                      id:
                        (offset ? state.subjectIdAfter : undefined) ??
                        state.subjectId ??
                        (isPull ? "PR_synthetic" : "I_synthetic"),
                      url:
                        state.subjectUrl ??
                        `https://github.com/${repository.slug}/${isPull ? "pull" : "issues"}/${variables.number}`,
                      timelineItems: {
                        nodes: paginated ? events.slice(offset, offset + 1) : events,
                        pageInfo: { hasNextPage, endCursor: hasNextPage ? "synthetic-next" : null },
                      },
                    }
                  : null,
              },
            },
          };
        }
      } else throw Error(`Unexpected synthetic route ${url.pathname}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
    },
  });
  const source = createGithubCollectionSource({
    client,
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
  });
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  return {
    state,
    calls,
    client,
    source,
    normalize: (fact) =>
      normalize({
        repository,
        family: "project_history",
        factKey: `synthetic:${fact.subjectId}`,
        observedAt,
        policyVersion: "synthetic/v1",
        fact,
      }),
  };
}

test("Project status collection traverses issue and closed-PR inventories and paginated native events", async () => {
  const h = harness({ paginated: true });
  h.state.events.push(projectEvent("E_pull_second", 2));
  const page = await h.source.readPage(request);
  assert.equal(page.expectedCount, 3);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    page.facts.map((fact) => fact.subjectId),
    ["E_issue", "E_pull", "E_pull_second"],
  );
  const prFacts = page.facts.filter((fact) => fact.sourceUrl.endsWith("/pull/2"));
  assert.equal(prFacts.length, 2);
  assert.notEqual(prFacts[0].sourceRevision, prFacts[1].sourceRevision);
  for (const fact of prFacts) {
    assert.equal(fact.historySubjectId, "PR_synthetic");
    assert.equal(fact.actorId, "32", "the native editor receives credit, not the PR author");
    assert.equal(fact.occurredAt, "2026-10-01T00:00:00.000Z");
    assert.equal(fact.evidence, "observed_transition");
    const out = await h.normalize(fact);
    assert.equal(out.facts.length, 1);
    assert.equal(out.facts[0].metricId, "project_status_updates");
    assert.equal(out.facts[0].actorId, "32");
    assert.equal(out.facts[0].state, "observed");
    assert.deepEqual(out.facts[0].eventContext.projects, ["PVT_allowed"]);
    assert.equal(out.observations[0].source, "github_graphql");
  }
  assert.deepEqual((await h.source.readPage(request)).facts, page.facts, "same-scan replay preserves event identity");
});

test("Project history does not reuse a legacy issue-only subject checkpoint as complete PR inventory", async () => {
  const h = harness();
  const cached = await h.client.scanRest({
    source: "synthetic",
    key: "pipeline:2:synthetic:project_history:subjects",
    url: `/repos/${repository.slug}/issues?state=all&sort=created&direction=asc&per_page=100`,
    maxPages: 100,
    select: (items) => items.filter((item) => !item.pull_request),
  });
  assert.equal(cached.length, 1);
  assert.equal((await h.source.readPage(request)).expectedCount, 2);
});

test("PR status history retains automation and unknown actors without inferring author credit", async () => {
  for (const change of [{ wasAutomated: true }, { actor: null }]) {
    const h = harness();
    Object.assign(h.state.events[1], change);
    const fact = (await h.source.readPage(request)).facts.find((entry) => entry.subjectId === "E_pull");
    assert.ok(fact);
    if (change.actor === null) assert.equal(fact.actorId, null);
    const out = await h.normalize(fact);
    if (change.actor === null) {
      assert.equal(out.facts.length, 1, "the uncredited source event remains available as unknown evidence");
      assert.equal(out.facts[0].actorId, null);
      assert.equal(out.facts[0].state, "unknown");
      assert.ok(out.reasons.includes("unknown_actor"));
    } else assert.equal(out.facts.length, 0);
    assert.equal(
      out.actors.some((actor) => actor.id === "902"),
      false,
    );
  }
});

test("PR status hydration withholds unapproved Project details and rejects changed source revisions", async () => {
  const h = harness();
  h.state.events[1].project.id = "PVT_unapproved";
  assert.deepEqual(
    (await h.source.readPage(request)).facts.map((fact) => fact.subjectId),
    ["E_issue"],
  );
  assert.equal(
    h.calls.some((call) => call.query.includes("previousStatus") && call.variables.id === "E_pull"),
    false,
  );

  const changed = harness();
  const fact = (await changed.source.readPage(request)).facts.find((entry) => entry.subjectId === "E_pull");
  assert.ok(fact);
  changed.state.status = "Blocked";
  const out = await changed.normalize(fact);
  assert.deepEqual(out.reasons, ["typed_history_revision_unverified"]);
  assert.equal(out.facts.length, 0);
  const refreshed = (await changed.source.readPage({ ...request, runId: "synthetic-refreshed" })).facts.find(
    (entry) => entry.subjectId === "E_pull",
  );
  assert.equal(refreshed.historySubjectId, fact.historySubjectId);
  assert.notEqual(refreshed.sourceRevision, fact.sourceRevision);
  assert.equal((await changed.normalize(refreshed)).facts.length, 1);
});

test("PR status no-ops and private Projects cannot produce contribution credit", async () => {
  const h = harness();
  h.state.status = h.state.previousStatus;
  const fact = (await h.source.readPage(request)).facts.find((entry) => entry.subjectId === "E_pull");
  assert.ok(fact);
  const out = await h.normalize(fact);
  assert.equal(out.facts.length, 0);
  assert.ok(out.reasons.includes("no_op_field_change"));
  h.state.publicProject = false;
  await assert.rejects(h.normalize(fact), /project_not_authorized/);
});

test("PR history verifies its exact subject and bounds every native timeline page", async () => {
  for (const change of [
    { subjectUrl: `https://github.com/${repository.slug}/issues/2` },
    { privateRepository: true },
  ]) {
    const h = harness();
    Object.assign(h.state, change);
    await assert.rejects(
      readTypedIssueHistory({
        client: h.client,
        source: "synthetic",
        repository,
        number: 2,
        subjectType: "pull_request",
        family: "project_history",
        scanId: "synthetic",
      }),
      /project_subject_identity_unverified/,
    );
  }
  const h = harness({ paginated: true });
  h.state.events.push(projectEvent("E_pull_second", 2));
  await assert.rejects(
    readTypedIssueHistory({
      client: h.client,
      source: "synthetic",
      repository,
      number: 2,
      subjectType: "pull_request",
      family: "project_history",
      scanId: "synthetic-bounded",
      maxPages: 1,
    }),
    /maxPages/,
  );
});

test("relationship collection and normalization remain issue-only", async () => {
  const h = harness();
  h.state.inventory = [h.state.inventory[1]];
  assert.equal((await h.source.readPage({ ...request, family: "relationships" })).expectedCount, 0);
  assert.equal(
    h.calls.some((call) => call.query.includes("timelineItems")),
    false,
  );
  const normalize = createGithubEvidenceNormalizer({
    client: h.client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  const out = await normalize({
    repository,
    family: "relationships",
    factKey: "synthetic",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: "E_pull",
      sourceRevision: "synthetic",
      sourceUrl: `https://github.com/${repository.slug}/pull/2`,
      evidence: "observed_transition",
      actorId: "32",
      occurredAt: "2026-10-01T00:00:00Z",
      state: "present",
    },
  });
  assert.deepEqual(out.reasons, ["typed_history_subject_url_unverified"]);
  await assert.rejects(
    readTypedIssueHistory({
      client: h.client,
      source: "synthetic",
      repository,
      number: 2,
      subjectType: "pull_request",
      family: "relationships",
      scanId: "synthetic",
    }),
    /typed_history_subject_kind_unsupported/,
  );
  assert.equal(h.calls.length, 0);
});

test("duplicate subject inventory cannot establish a complete Project status count", async () => {
  const h = harness();
  h.state.inventory.push(h.state.inventory[1]);
  await assert.rejects(h.source.readPage(request), /project_subject_identity_unverified/);
});

test("Project history binds the REST node ID and rejects missing or reused stable inventory identities", async () => {
  for (const change of [
    (h) => {
      h.state.subjectId = "PR_different_from_inventory";
    },
    (h) => {
      h.state.inventory[1].node_id = h.state.inventory[0].node_id;
    },
    (h) => {
      delete h.state.inventory[1].node_id;
    },
    (h) => {
      h.state.inventory[1] = null;
    },
  ]) {
    const h = harness();
    change(h);
    await assert.rejects(h.source.readPage(request), /project_subject_identity_unverified/);
  }
});

test("a later Project timeline page cannot change the stable subject at the same canonical URL", async () => {
  const h = harness({ paginated: true });
  h.state.events.push(projectEvent("E_pull_second", 2));
  h.state.subjectIdAfter = "PR_replaced_on_second_page";
  await assert.rejects(h.source.readPage(request), /project_subject_identity_unverified/);
});

test("normalization independently binds stable Project subject identity across pages", async () => {
  const h = harness({ paginated: true });
  h.state.events.push(projectEvent("E_pull_second", 2));
  const fact = (await h.source.readPage(request)).facts.find((entry) => entry.subjectId === "E_pull_second");
  h.state.subjectIdAfter = "PR_replaced_during_hydration";
  await assert.rejects(h.normalize(fact), /project_subject_identity_unverified/);
});

test("Project normalization binds the collected subject when every hydration page changes identity", async () => {
  const h = harness({ paginated: true });
  h.state.events.push(projectEvent("E_pull_second", 2));
  const fact = (await h.source.readPage(request)).facts.find((entry) => entry.subjectId === "E_pull_second");
  h.state.subjectId = "PR_replaced_before_hydration";
  await assert.rejects(h.normalize(fact), /project_subject_identity_unverified/);
});

test("legacy Project facts without a collected subject remain uncredited until recollected", async () => {
  const h = harness();
  const fact = (await h.source.readPage(request)).facts.find((entry) => entry.subjectId === "E_pull");
  delete fact.historySubjectId;
  const out = await h.normalize(fact);
  assert.equal(out.facts.length, 0);
  assert.deepEqual(out.reasons, ["project_history_subject_identity_not_collected"]);
  const recollected = (await h.source.readPage({ ...request, runId: "synthetic-recollected" })).facts.find(
    (entry) => entry.subjectId === "E_pull",
  );
  assert.equal(recollected.historySubjectId, "PR_synthetic");
  assert.equal((await h.normalize(recollected)).facts.length, 1);
});

test("resumed Project timelines revalidate saved subject identities against subsequent pages", async () => {
  const h = harness({ paginated: true });
  h.state.events.push(projectEvent("E_pull_second", 2));
  const options = {
    client: h.client,
    source: "synthetic",
    repository,
    number: 2,
    subjectType: "pull_request",
    family: "project_history",
    scanId: "synthetic-resumed-normalization",
  };
  await assert.rejects(readTypedIssueHistory({ ...options, maxPages: 1 }), /exceeded maxPages/);
  h.state.subjectIdAfter = "PR_changed_after_checkpoint";
  await assert.rejects(readTypedIssueHistory({ ...options, maxPages: 2 }), /project_subject_identity_unverified/);
});

test("legacy typed-history checkpoints cannot bypass stable inventory identity verification", async () => {
  const h = harness();
  const scanGraphql = h.client.scanGraphql.bind(h.client);
  // Reproduce the prior checkpoint namespace using the actual durable scan transport.
  h.client.scanGraphql = (options) =>
    scanGraphql({ ...options, key: options.key.replace("typed-history:subject-v2:", "typed-history:") });
  h.state.subjectId = "PR_legacy_identity";
  await readTypedIssueHistory({
    client: h.client,
    source: "synthetic",
    repository,
    number: 2,
    subjectType: "pull_request",
    family: "project_history",
    scanId: "synthetic",
  });
  h.client.scanGraphql = scanGraphql;
  h.state.subjectId = undefined;
  assert.equal((await h.source.readPage(request)).expectedCount, 2);
});
