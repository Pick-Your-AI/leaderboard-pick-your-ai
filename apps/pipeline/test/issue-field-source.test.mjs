import assert from "node:assert/strict";
import test from "node:test";
import { GithubClientError, createGithubEvidenceNormalizer } from "../../../packages/github/dist/index.js";
import {
  issueFieldFixture,
  nativeEvent,
  nativeActor,
  repository,
  issue,
} from "../../../packages/github/test/issue-field-fixture.mjs";
import {
  createGithubCollectionSource,
  githubRecentSourceFamilies,
  isIssueFieldSourceScopeFailure,
  isProjectSourceScopeFailure,
} from "../src/github-source.mjs";
import { components, harness } from "./harness.mjs";
import { reconciliationRunId } from "../src/reconciliation-plan.mjs";

const request = {
  repositoryId: repository.id,
  runId: "synthetic-native-scan",
  family: "issue_field_history",
  mode: "backfill",
  since: null,
  until: "2026-10-02T00:00:00.000Z",
  cursor: null,
  limit: 100,
};
const reservedNativeRunId = reconciliationRunId("a".repeat(64), "00000000-0000-4000-8000-000000000079", 0, 1);
const cutoffIds = ["before", "lower", "inside", "upper", "after"].map((name) => "E_SYNTHETIC_CUTOFF_" + name);
const cutoffWindow = { since: "2026-10-01T12:00:00.1Z", until: "2026-10-01T12:00:00.12Z" };
const cutoffEvents = (
  clocks = [
    "2026-10-01T12:00:00.099Z",
    "2026-10-01T12:00:00.100Z",
    "2026-10-01T12:00:00.11Z",
    "2026-10-01T12:00:00.120Z",
    "2026-10-01T12:00:00.121Z",
  ],
) => clocks.map((createdAt, index) => nativeEvent(cutoffIds[index], { createdAt }));
const collector = (h, extra = {}) => {
  const unavailable = [];
  const source = createGithubCollectionSource({
    client: h.client,
    sourceId: h.options.source,
    repositories: [repository],
    isSynthetic: true,
    onUnavailable: async (scope, reason) => unavailable.push({ repositoryId: scope.id, reason }),
    ...extra,
  });
  return { source, unavailable };
};
const calls = (h, operation) => h.calls.filter((call) => call.operation === operation);
const scans = (h) =>
  [...(h.checkpoints.repositoryValues.get(repository.id) ?? [])].filter(([key]) => key.startsWith("scan:"));
const inventoryCheckpoint = (h) => {
  const entry = scans(h).find(([, checkpoint]) => checkpoint.items[0]?.number !== undefined);
  assert.ok(entry, "the actual client retained the metadata inventory checkpoint");
  return entry;
};
const invalidResponse = (error) => error instanceof GithubClientError && error.outcome.kind === "invalid_response";
const nativeDenial = [{ repositoryId: repository.id, reason: "issue_field_scope_unavailable" }];

test("native collector acquires issue identities without REST issue content and emits bound minimal facts", async () => {
  const h = issueFieldFixture();
  h.state.inventory[0].title = "SYNTHETIC_UNREQUESTED_ISSUE_TITLE";
  h.state.inventory[0].body = "SYNTHETIC_UNREQUESTED_ISSUE_BODY";
  h.state.inventory[0].extra = { value: "SYNTHETIC_UNREQUESTED_EXTRA" };
  const { source, unavailable } = collector(h);
  const page = await source.readPage(request);
  assert.match(page.facts[0].sourceRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(page, {
    repositoryId: repository.id,
    visibility: "public",
    isSynthetic: true,
    facts: [
      {
        subjectId: "E_SYNTHETIC_FIELD_1",
        historySubjectId: issue.id,
        issueFieldId: "IF_SYNTHETIC_PUBLIC",
        sourceRevision: page.facts[0].sourceRevision,
        sourceUrl: issue.url,
        evidence: "observed_transition",
        actorId: String(nativeActor.databaseId),
        occurredAt: "2026-10-01T00:00:00.000Z",
        state: "present",
      },
    ],
    nextCursor: null,
    expectedCount: null,
  });
  const inventory = calls(h, "IssueFieldInventory");
  assert.equal(inventory.length, 1);
  assert.deepEqual(inventory[0].variables, { owner: "synthetic-owner", name: "repository", first: 100, after: null });
  assert.match(inventory[0].query, /nodes\s*\{\s*id number url\s*\}/);
  assert.match(inventory[0].query, /states:\[OPEN,CLOSED\]/);
  assert.doesNotMatch(inventory[0].query, /\b(?:title|body|actor|author|issueFieldValues|pullRequests)\b/);
  assert.ok(calls(h, "REST").every((call) => new URL(call.url).pathname === "/repos/" + repository.slug));
  assert.ok(calls(h, "IssueFieldSubject").every((call) => call.variables.number === 1));
  assert.deepEqual(inventoryCheckpoint(h)[1].items, [{ id: issue.id, number: 1, url: issue.url }]);
  assert.doesNotMatch(
    JSON.stringify([page, ...h.checkpoints.repositoryValues.get(repository.id).values()]),
    /SYNTHETIC_UNREQUESTED|SYNTHETIC_BEFORE_VALUE|SYNTHETIC_AFTER_VALUE|PR_SYNTHETIC_IGNORED|synthetic-editor/,
  );
  assert.deepEqual(unavailable, []);
});

test("empty inventories, empty histories and initially organization-only fields keep native expected counts unknown", async (t) => {
  for (const profile of ["no issues", "no events", "organization-only field"])
    await t.test(profile, async () => {
      const h = issueFieldFixture(profile === "no events" ? [] : undefined);
      if (profile === "no issues") h.state.inventory = [];
      if (profile === "organization-only field") h.state.fields.get("IF_SYNTHETIC_PUBLIC").visibility = "ORG_ONLY";
      const { source, unavailable } = collector(h);
      const page = await source.readPage(request);
      assert.deepEqual(page.facts, []);
      assert.equal(page.expectedCount, null);
      assert.equal(page.nextCursor, null);
      assert.equal(calls(h, "IssueFieldDetail").length, 0);
      assert.deepEqual(unavailable, []);
    });
});

test("an interrupted metadata inventory resumes before any field hydration and recovers without permanent denial", async () => {
  const h = issueFieldFixture([]);
  h.state.inventory = [
    { node_id: issue.id, number: 1, html_url: issue.url },
    { node_id: "I_SYNTHETIC_SECOND_ISSUE", number: 3, html_url: "https://github.com/" + repository.slug + "/issues/3" },
  ];
  h.state.inventoryPageSize = 1;
  h.state.inventoryFailCursor = "1";
  h.state.mutate = ({ operation, variables, data }) => {
    if (["IssueFieldSubject", "IssueFieldHistory"].includes(operation)) {
      const subject = h.state.inventory.find((item) => item.number === variables.number);
      data.repository.issue = { id: subject.node_id, url: subject.html_url };
      if (operation === "IssueFieldHistory")
        data.repository.issue.timelineItems = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    }
    return data;
  };
  const { source, unavailable } = collector(h);
  await assert.rejects(
    source.readPage(request),
    (error) => error instanceof GithubClientError && error.outcome.kind === "transient_failure",
  );
  assert.deepEqual(
    calls(h, "IssueFieldInventory").map((call) => call.variables.after),
    [null, "1"],
  );
  assert.equal(calls(h, "IssueFieldSubject").length, 0);
  const partial = inventoryCheckpoint(h)[1];
  assert.equal(partial.complete, false);
  assert.equal(partial.next, "1");
  assert.deepEqual(partial.items, [{ id: issue.id, number: 1, url: issue.url }]);
  h.state.inventoryFailCursor = undefined;
  const recovered = await source.readPage(request);
  assert.deepEqual(recovered.facts, []);
  assert.equal(recovered.expectedCount, null);
  assert.deepEqual(
    calls(h, "IssueFieldInventory").map((call) => call.variables.after),
    [null, "1", "1"],
  );
  assert.deepEqual(
    calls(h, "IssueFieldSubject").map((call) => call.variables.number),
    [1, 3],
  );
  assert.equal(inventoryCheckpoint(h)[1].complete, true);
  assert.deepEqual(
    inventoryCheckpoint(h)[1].items,
    h.state.inventory.map((item) => ({ id: item.node_id, number: item.number, url: item.html_url })),
  );
  assert.deepEqual(unavailable, []);
});

test("malformed inventory metadata is rejected before checkpointing or detail reads without native denial", async (t) => {
  const profiles = [
    [
      "missing repository",
      (data) => {
        delete data.repository;
      },
    ],
    [
      "string database ID",
      (data) => {
        data.repository.databaseId = "2";
      },
    ],
    [
      "unknown privacy",
      (data) => {
        data.repository.isPrivate = null;
      },
    ],
    [
      "missing connection",
      (data) => {
        delete data.repository.issues;
      },
    ],
    [
      "null issue",
      (data) => {
        data.repository.issues.nodes = [null];
      },
    ],
    [
      "missing issue ID",
      (data) => {
        delete data.repository.issues.nodes[0].id;
      },
    ],
    [
      "string issue number",
      (data) => {
        data.repository.issues.nodes[0].number = "1";
      },
    ],
    [
      "unrequested issue content",
      (data) => {
        data.repository.issues.nodes[0].body = "SYNTHETIC_INJECTED_BODY";
      },
    ],
    [
      "oversized page",
      (data) => {
        data.repository.issues.nodes = Array(101).fill(data.repository.issues.nodes[0]);
      },
    ],
    [
      "malformed page info",
      (data) => {
        data.repository.issues.pageInfo.hasNextPage = "false";
      },
    ],
  ];
  for (const [label, mutate] of profiles)
    await t.test(label, async () => {
      const h = issueFieldFixture();
      h.state.mutate = ({ operation, data }) => {
        if (operation === "IssueFieldInventory") mutate(data);
        return data;
      };
      const { source, unavailable } = collector(h);
      await assert.rejects(source.readPage(request), invalidResponse);
      assert.deepEqual(scans(h), []);
      assert.equal(calls(h, "IssueFieldSubject").length, 0);
      assert.equal(calls(h, "IssueFieldDetail").length, 0);
      assert.deepEqual(unavailable, []);
      h.state.mutate = undefined;
      assert.equal((await source.readPage(request)).facts.length, 1);
      assert.deepEqual(unavailable, []);
    });
});

test("confirmed native inventory scope loss and foreign issue bindings cannot reach field detail", async (t) => {
  for (const [label, mutate] of [
    [
      "hidden repository",
      (data) => {
        data.repository = null;
      },
    ],
    [
      "private repository",
      (data) => {
        data.repository.isPrivate = true;
      },
    ],
    [
      "rebound repository",
      (data) => {
        data.repository.databaseId = 3;
      },
    ],
    [
      "foreign repository URL",
      (data) => {
        data.repository.issues.nodes[0].url = "https://github.com/other-owner/repository/issues/1";
      },
    ],
    [
      "PR URL",
      (data) => {
        data.repository.issues.nodes[0].url = issue.url.replace("/issues/", "/pull/");
      },
    ],
    [
      "foreign issue node",
      (data) => {
        data.repository.issues.nodes[0].id = "I_SYNTHETIC_FOREIGN";
      },
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      h.state.mutate = ({ operation, data }) => {
        if (operation === "IssueFieldInventory") mutate(data);
        return data;
      };
      const { source, unavailable } = collector(h);
      await assert.rejects(source.readPage(request), { message: "issue_field_subject_identity_unverified" });
      assert.equal(calls(h, "IssueFieldDetail").length, 0);
      assert.deepEqual(unavailable, nativeDenial);
    });
});

test("completed inventory checkpoints are revalidated before hydration, including valid-shaped foreign issue IDs", async (t) => {
  for (const [label, mutate, expected, denied] of [
    [
      "missing ID",
      (items) => {
        delete items[0].id;
      },
      invalidResponse,
      false,
    ],
    [
      "unexpected retained content",
      (items) => {
        items[0].body = "SYNTHETIC_CACHED_BODY";
      },
      invalidResponse,
      false,
    ],
    [
      "duplicate issue",
      (items) => {
        items.push(structuredClone(items[0]));
      },
      { message: "issue_field_duplicate_subject" },
      false,
    ],
    [
      "foreign issue ID",
      (items) => {
        items[0].id = "I_SYNTHETIC_FOREIGN";
      },
      { message: "issue_field_subject_identity_unverified" },
      true,
    ],
    [
      "foreign issue URL",
      (items) => {
        items[0].url = "https://github.com/other-owner/repository/issues/1";
      },
      { message: "issue_field_subject_identity_unverified" },
      true,
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      await collector(h).source.readPage(request);
      const [key, checkpoint] = inventoryCheckpoint(h);
      const injected = structuredClone(checkpoint);
      mutate(injected.items);
      h.checkpoints.repositoryValues.get(repository.id).set(key, injected);
      h.calls.length = 0;
      const { source, unavailable } = collector(h, { client: h.makeClient() });
      await assert.rejects(source.readPage(request), expected);
      assert.equal(
        calls(h, "IssueFieldInventory").length,
        0,
        "the resumed client read the actual completed checkpoint",
      );
      assert.equal(calls(h, "IssueFieldDetail").length, 0);
      assert.deepEqual(unavailable, denied ? nativeDenial : []);
    });
});

test("a collected field becoming organization-only is reported even when the refreshed timeline would be empty", async () => {
  const h = issueFieldFixture();
  const { source, unavailable } = collector(h);
  assert.equal((await source.readPage(request)).facts.length, 1);
  h.state.fields.get("IF_SYNTHETIC_PUBLIC").visibility = "ORG_ONLY";
  h.state.timelineIds = [];
  h.calls.length = 0;
  await assert.rejects(source.readPage(request), { message: "issue_field_public_scope_unverified" });
  assert.equal(calls(h, "IssueFieldDetail").length, 0);
  assert.equal(
    calls(h, "IssueFieldHistory").length,
    0,
    "the collected field is directly checked before refreshed membership can omit it",
  );
  assert.deepEqual(unavailable, nativeDenial);
});

test("malformed native events and incomplete values remain retryable at the collector boundary", async (t) => {
  for (const [label, patch, code] of [
    ["other event subtype", { __typename: "ProjectV2ItemStatusChangedEvent" }, "issue_field_event_invalid_response"],
    ["omitted value", { previousValue: undefined }, "issue_field_value_unverified"],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture([nativeEvent(undefined, patch)]);
      const { source, unavailable } = collector(h);
      await assert.rejects(source.readPage(request), { message: code });
      assert.deepEqual(unavailable, []);
      h.state.events.set("E_SYNTHETIC_FIELD_1", nativeEvent());
      assert.equal((await source.readPage(request)).facts.length, 1);
      assert.deepEqual(unavailable, []);
    });
});

test("native denial classification is subtype-specific and separates confirmed scope loss from retryable failures", () => {
  const scopeErrors = [
    ...[
      "issue_field_public_scope_unverified",
      "issue_field_subject_identity_unverified",
      "issue_field_event_unavailable",
    ].map((code) => new Error(code)),
    ...[
      [401, "authentication_required"],
      [403, "permission_denied"],
      [404, "not_found_or_hidden"],
    ].map(([status, kind]) => new GithubClientError({ kind, status, visibility: "unknown" }, "synthetic")),
  ];
  for (const error of scopeErrors) {
    assert.equal(isIssueFieldSourceScopeFailure(error, "issue_field_history"), true);
    for (const family of ["issues", "project_current", "project_history", "relationships", undefined])
      assert.equal(isIssueFieldSourceScopeFailure(error, family), false);
  }
  for (const code of ["issue_field_public_scope_unverified", "issue_field_event_unavailable"])
    assert.equal(isProjectSourceScopeFailure(new Error(code), "project_history"), false);
  const retryable = [
    new GithubClientError(
      { kind: "rate_limited", visibility: "unknown", retryAt: request.until, scope: "source" },
      "synthetic",
    ),
    new GithubClientError({ kind: "transient_failure", visibility: "unknown", status: 503 }, "synthetic"),
    new GithubClientError({ kind: "invalid_response" }, "synthetic"),
    new GithubClientError({ kind: "invalid_checkpoint" }, "synthetic"),
    ...[
      "issue_field_duplicate_subject",
      "issue_field_event_invalid_response",
      "issue_field_scope_invalid_response",
      "issue_field_value_unverified",
      "project_public_scope_unverified",
      "authentication_required",
    ].map((code) => new Error(code)),
    { message: "issue_field_event_unavailable" },
    null,
  ];
  for (const error of retryable) assert.equal(isIssueFieldSourceScopeFailure(error, "issue_field_history"), false);
});

test("native history uses inclusive UTC boundaries and paginates the filtered events", async (t) => {
  for (const [label, window, events, expectedTimes] of [
    [
      "fractional precision",
      cutoffWindow,
      cutoffEvents(),
      ["2026-10-01T12:00:00.100Z", "2026-10-01T12:00:00.110Z", "2026-10-01T12:00:00.120Z"],
    ],
    [
      "whole seconds",
      { since: "2026-10-01T12:00:00Z", until: "2026-10-01T12:00:02Z" },
      cutoffEvents([
        "2026-10-01T11:59:59.999Z",
        "2026-10-01T12:00:00.000Z",
        "2026-10-01T12:00:01.1Z",
        "2026-10-01T12:00:02Z",
        "2026-10-01T12:00:02.001Z",
      ]),
      ["2026-10-01T12:00:00.000Z", "2026-10-01T12:00:01.100Z", "2026-10-01T12:00:02.000Z"],
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture(events);
      const { source, unavailable } = collector(h);
      const first = await source.readPage({ ...request, ...window, limit: 2 });
      assert.deepEqual(
        first.facts.map((fact) => fact.subjectId),
        cutoffIds.slice(1, 3),
      );
      assert.equal(first.nextCursor, "2");
      assert.equal(first.expectedCount, null);
      assert.equal(
        calls(h, "IssueFieldDetail").length,
        5,
        "out-of-window events still undergo the existing fresh privacy checks",
      );
      const last = await source.readPage({ ...request, ...window, limit: 2, cursor: first.nextCursor });
      assert.deepEqual(
        last.facts.map((fact) => fact.subjectId),
        [cutoffIds[3]],
      );
      assert.equal(last.nextCursor, null);
      assert.equal(last.expectedCount, null);
      assert.deepEqual(
        [...first.facts, ...last.facts].map((fact) => fact.occurredAt),
        expectedTimes,
      );
      const backfill = await source.readPage({
        ...request,
        ...window,
        since: null,
        runId: "synthetic-cutoff-backfill",
      });
      assert.deepEqual(
        backfill.facts.map((fact) => fact.subjectId),
        cutoffIds.slice(0, 4),
      );
      assert.equal(backfill.expectedCount, null);
      const empty = await source.readPage({
        ...request,
        since: null,
        until: "2026-10-01T00:00:00Z",
        runId: "synthetic-cutoff-empty",
      });
      assert.deepEqual(empty.facts, []);
      assert.equal(empty.nextCursor, null);
      assert.equal(empty.expectedCount, null);
      assert.deepEqual(unavailable, []);
    });
});

test("native direct windows and reserved audits keep separate timestamp contracts", async () => {
  const h = issueFieldFixture(cutoffEvents());
  const { source, unavailable } = collector(h);
  assert.deepEqual(githubRecentSourceFamilies, ["issues", "comments", "project_history", "relationships"]);
  const direct = await source.readPage({ ...request, ...cutoffWindow, mode: "reconcile" });
  assert.deepEqual(
    direct.facts.map((fact) => fact.subjectId),
    cutoffIds.slice(1, 4),
  );
  assert.equal(direct.expectedCount, null);
  const audit = await source.readPage({
    ...request,
    runId: reservedNativeRunId,
    mode: "audit",
    until: "2026-10-01T12:00:00.120Z",
  });
  assert.deepEqual(
    audit.facts.map((fact) => fact.subjectId),
    cutoffIds.slice(0, 4),
  );
  assert.deepEqual(audit.facts.slice(1), direct.facts);
  assert.equal(audit.expectedCount, null);
  assert.equal(audit.nextCursor, null);
  assert.deepEqual(unavailable, []);
});

test("native reserved plans reject noncanonical audits and recent mode before source I/O", async (t) => {
  for (const [label, changes] of [
    ["fractional upper alias", { until: "2026-10-01T12:00:00.12Z" }],
    ["whole second upper alias", { until: "2026-10-02T00:00:00Z" }],
    [
      "canonical bounded recent mode",
      { mode: "reconcile", since: "2026-10-01T12:00:00.100Z", until: "2026-10-01T12:00:00.120Z" },
    ],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture(cutoffEvents());
      const { source, unavailable } = collector(h);
      const audit = { ...request, runId: reservedNativeRunId, mode: "audit" };
      await assert.rejects(source.readPage({ ...audit, ...changes }), {
        message: "reconciliation_source_plan_invalid",
      });
      assert.deepEqual(h.calls, []);
      assert.deepEqual(scans(h), []);
      assert.deepEqual(unavailable, []);
      const recovered = await source.readPage(audit);
      assert.deepEqual(
        recovered.facts.map((fact) => fact.subjectId),
        cutoffIds,
      );
      assert.equal(recovered.expectedCount, null);
      assert.deepEqual(unavailable, []);
    });
});

test("native cutoff bounds are captured before awaiting a source response", async () => {
  const h = issueFieldFixture(cutoffEvents());
  const mutable = { ...request, ...cutoffWindow };
  let changedDuringResponse = false;
  h.state.mutate = ({ operation, data }) => {
    if (operation === "IssueFieldInventory") {
      mutable.since = "2026-10-01T12:00:00.121Z";
      mutable.until = "2026-10-02T00:00:00Z";
      changedDuringResponse = true;
    }
    return data;
  };
  const { source } = collector(h);
  const page = await source.readPage(mutable);
  assert.equal(changedDuringResponse, true);
  assert.equal(calls(h, "IssueFieldInventory").length, 1);
  assert.deepEqual(
    page.facts.map((fact) => fact.subjectId),
    cutoffIds.slice(1, 4),
  );
  assert.equal(page.nextCursor, null);
  assert.equal(page.expectedCount, null);
});

test("malformed native cutoff bounds fail before source I/O and can be corrected", async (t) => {
  for (const [label, patch] of [
    ["missing upper bound", { until: undefined }],
    ["null upper bound", { until: null }],
    ["missing lower bound", { since: undefined }],
    ["invalid calendar", { until: "2026-02-30T12:00:00Z" }],
    ["UTC offset alias", { until: "2026-10-02T00:00:00+00:00" }],
    ["submillisecond precision", { since: "2026-10-01T00:00:00.0001Z" }],
    ["date only", { since: "2026-10-01" }],
    ["numeric lower bound", { since: 0 }],
    ["equal normalized instants", { since: "2026-10-01T12:00:00.1Z", until: "2026-10-01T12:00:00.100Z" }],
    ["reversed instants", { since: "2026-10-01T12:00:00.121Z", until: "2026-10-01T12:00:00.12Z" }],
  ])
    await t.test(label, async () => {
      const h = issueFieldFixture();
      const { source, unavailable } = collector(h);
      await assert.rejects(source.readPage({ ...request, ...patch }), { message: "invalid_issue_field_window" });
      assert.deepEqual(h.calls, []);
      assert.deepEqual(scans(h), []);
      assert.deepEqual(unavailable, []);
      assert.equal((await source.readPage(request)).facts.length, 1);
      assert.deepEqual(unavailable, []);
    });
});

test("cutoff filtering cannot bypass a retained out-of-window field's fresh scope check", async () => {
  const events = cutoffEvents();
  events[4].fieldId = "IF_SYNTHETIC_OUTSIDE_CUTOFF";
  const h = issueFieldFixture(events);
  h.state.fields.set(events[4].fieldId, { id: events[4].fieldId, dataType: "TEXT", visibility: "ALL" });
  const { source, unavailable } = collector(h);
  assert.deepEqual(
    (await source.readPage({ ...request, ...cutoffWindow })).facts.map((fact) => fact.subjectId),
    cutoffIds.slice(1, 4),
  );
  h.state.fields.get(events[4].fieldId).visibility = "ORG_ONLY";
  h.state.timelineIds = cutoffIds.slice(0, 4);
  h.calls.length = 0;
  await assert.rejects(source.readPage({ ...request, ...cutoffWindow }), {
    message: "issue_field_public_scope_unverified",
  });
  assert.equal(calls(h, "IssueFieldDetail").length, 0);
  assert.equal(calls(h, "IssueFieldHistory").length, 0);
  assert.deepEqual(unavailable, nativeDenial);
});

test("real native collection retains minimized SQL facts, normalizes their binding and rejects invalid admission with recovery", async (t) => {
  // One sequential database fixture covers admission and recovery without retaining
  // multiple WASM databases across the source validation matrix above.
  const sql = await harness(t);
  const collection = new components.ingestion.CollectionStore(sql.db);
  assert.equal(await collection.verifyPublic(repository.id, repository.installationId, null), true);
  const h = issueFieldFixture();
  const { source } = collector(h);
  let actual;
  await collection.start(request);
  assert.equal(
    await collection.step(request.runId, {
      async readPage(value) {
        actual = await source.readPage(value);
        return {
          ...actual,
          facts: actual.facts.map((fact) => ({
            ...fact,
            body: "SYNTHETIC_ADAPTER_BODY",
            rawValue: "SYNTHETIC_ADAPTER_VALUE",
          })),
        };
      },
    }),
    "complete",
  );
  const [stored] = (
    await sql.db.query(
      "SELECT fact_key,family,subject_id,source_revision,document FROM leaderboard_ingestion.source_facts",
    )
  ).rows;
  assert.deepEqual(stored.document, actual.facts[0]);
  assert.equal(stored.family, "issue_field_history");
  assert.equal(stored.subject_id, "E_SYNTHETIC_FIELD_1");
  assert.equal(stored.source_revision, actual.facts[0].sourceRevision);
  assert.doesNotMatch(JSON.stringify(stored), /SYNTHETIC_ADAPTER|SYNTHETIC_BEFORE_VALUE|SYNTHETIC_AFTER_VALUE/);
  const normalize = createGithubEvidenceNormalizer({
    client: h.client,
    source: h.options.source,
    allowedRepositoryIds: [repository.id],
    isSynthetic: true,
  });
  const normalized = await normalize({
    repository,
    family: stored.family,
    factKey: stored.fact_key,
    fact: stored.document,
    observedAt: request.until,
    policyVersion: "synthetic/v1",
  });
  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.facts[0].metricId, "issue_field_updates");
  assert.equal(normalized.facts[0].artifactId, issue.id);
  assert.equal(normalized.facts[0].actorId, "7");
  assert.equal(normalized.facts[0].occurredAt, actual.facts[0].occurredAt);
  assert.equal(normalized.observations[0].sourceRevision, stored.source_revision);
  assert.equal(normalized.actors[0].kind, "user");
  assert.equal(normalized.actors[0].executionMode, "unknown");
  const [diagnostic] = await collection.diagnostics(repository.id);
  assert.equal(diagnostic.expected_count, null);
  assert.equal(diagnostic.historical_counts_reconciled, false);
  assert.equal(diagnostic.counts_reconciled, false);

  let index = 0;
  for (const [label, mutate, family] of [
    [
      "missing issue ID",
      (fact) => {
        delete fact.historySubjectId;
      },
      "issue_field_history",
    ],
    [
      "missing field ID",
      (fact) => {
        delete fact.issueFieldId;
      },
      "issue_field_history",
    ],
    [
      "malformed field ID",
      (fact) => {
        fact.issueFieldId = "field with spaces";
      },
      "issue_field_history",
    ],
    [
      "PR subject",
      (fact) => {
        fact.sourceUrl = issue.url.replace("/issues/", "/pull/");
      },
      "issue_field_history",
    ],
    [
      "current snapshot",
      (fact) => {
        fact.evidence = "current_state";
        fact.actorId = null;
        fact.occurredAt = null;
      },
      "issue_field_history",
    ],
    ["native identity on another family", () => {}, "issues"],
  ]) {
    const runId = "synthetic-native-invalid-" + ++index;
    const bad = structuredClone(actual);
    mutate(bad.facts[0]);
    await collection.start({ ...request, runId, family });
    assert.equal(await collection.step(runId, { readPage: async () => bad }), "failed", label);
    const [failed] = (
      await sql.db.query(
        "SELECT state,reason,page_count,item_count FROM leaderboard_ingestion.collection_runs WHERE run_id=$1",
        [runId],
      )
    ).rows;
    assert.deepEqual(failed, { state: "failed", reason: "source_schema_drift", page_count: 0, item_count: 0 }, label);
    assert.equal(
      (await sql.db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.source_facts")).rows[0].count,
      1,
      label,
    );
    if (family === "issue_field_history") {
      assert.equal(
        await collection.step(runId, { readPage: async () => structuredClone(actual) }),
        "complete",
        label + " recovery",
      );
      assert.equal(
        (await sql.db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.source_facts")).rows[0].count,
        1,
        "recovery must not duplicate the original native event",
      );
    }
  }

  const boundedRun = {
    ...request,
    runId: "synthetic-native-cutoff-storage",
    since: "2026-10-01T12:00:00.100Z",
    until: "2026-10-01T12:00:00.120Z",
  };
  const boundedSource = collector(issueFieldFixture(cutoffEvents())).source;
  await collection.start(boundedRun);
  assert.equal(await collection.step(boundedRun.runId, boundedSource, 2), "progress");
  assert.equal(await collection.step(boundedRun.runId, boundedSource, 2), "complete");
  const boundedFacts = (
    await sql.db.query(
      `SELECT fact.document FROM leaderboard_ingestion.source_facts AS fact
     JOIN leaderboard_ingestion.collection_items AS item USING (fact_key)
     WHERE item.run_id=$1 ORDER BY fact.document->>'occurredAt'`,
      [boundedRun.runId],
    )
  ).rows.map((row) => row.document);
  assert.deepEqual(
    boundedFacts.map((fact) => fact.subjectId),
    cutoffIds.slice(1, 4),
  );
  assert.deepEqual(
    boundedFacts.map((fact) => fact.occurredAt),
    ["2026-10-01T12:00:00.100Z", "2026-10-01T12:00:00.110Z", "2026-10-01T12:00:00.120Z"],
  );
  const [bounded] = (
    await sql.db.query(
      "SELECT state,reason,page_count,item_count,expected_count FROM leaderboard_ingestion.collection_runs WHERE run_id=$1",
      [boundedRun.runId],
    )
  ).rows;
  assert.deepEqual(bounded, { state: "complete", reason: null, page_count: 2, item_count: 3, expected_count: null });
});
