// Public HTTP projection from fictional normalized, independently reviewed source fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";
import { projectWorkstreamHelp } from "../dist/workstream-help.js";
import {
  encodeWorkstreamHelpStatement,
  workstreamHelpVersion,
  publicWorkstreamHelpSchema,
} from "@pick-your-ai/contracts";
import { selection } from "../../web/src/remote/client.ts";
import { workstreamHelpPage, workstreamHelpParameters } from "../../web/src/remote/workstream-help-client.ts";
import { publicHelpFixture, helpMergedAt, sha256 } from "../../../tests/fixtures/workstream-help.mjs";

function service(
  t,
  value = publicHelpFixture(),
  approved = workstreamHelpVersion,
  achievement = "accepted-evidence/v2",
) {
  const app = createService({
    approvedWorkstreamHelpRuleVersion: approved,
    approvedAchievementRuleVersion: achievement,
    cursorSecret: "fixture-workstream-help-cursor-secret-000000",
    source: {
      read: async (scope) => ({
        ...structuredClone(value),
        selected: { ...structuredClone(value.selected), scope },
      }),
    },
  });
  t.after(() => app.close());
  return { app, value };
}
async function read(app, extra = {}, actor = "101") {
  const params = new URLSearchParams({ snapshot: "fixture-help", limit: "2", ...extra });
  const response = await app.inject("/api/v1/contributors/" + actor + "/workstream-help?" + params);
  return { response, data: response.json(), selected: selection("?" + params) };
}
const ok = (result) => assert.equal(result.response.statusCode, 200, result.response.body);
const copies = (value, id) =>
  [...value.selected.evidence, ...value.selected.portfolioEvidence].filter(
    (entry) => entry.contribution.contributionId === id,
  );
const rehash = (help) => {
  help.statementHash = sha256(encodeWorkstreamHelpStatement(help.statement));
};

test("reviewed help uses exact accepted proof and independent dates with partial historical coverage", async (t) => {
  const { app } = service(t);
  const result = await read(app, { limit: "20", category: "maintenance", repository: "2" });
  ok(result);
  assert.equal(result.data.ruleVersion, workstreamHelpVersion);
  assert.equal(result.data.recognitions.length, 3);
  assert.equal(result.data.coverage[0].state, "partial");
  for (const entry of result.data.recognitions) {
    assert.equal(entry.proof.actorId, "101");
    assert.equal(entry.proof.occurredAt, helpMergedAt);
    assert.equal(entry.proof.sourceUrl, entry.help.statement.sourceUrl);
    assert.equal(entry.proof.contributionId, entry.help.contributionId);
    assert.equal(entry.help.statementHash, sha256(encodeWorkstreamHelpStatement(entry.help.statement)));
    const evidence = await app.inject("/api/v1/evidence/" + entry.proof.contributionId + "?snapshot=fixture-help");
    assert.equal(evidence.statusCode, 200, evidence.body);
  }
  assert.doesNotMatch(
    result.response.body,
    /private-help|requestVersion|decisionId|sourceAcceptance|sourceUseReview|validUntil/,
  );
  assert.match(result.response.headers["cache-control"], /no-store/);
  assert.equal(workstreamHelpPage(result.data, result.selected, "101").recognitions.length, 3);
  const filtered = await read(app, { category: "documentation" });
  ok(filtered);
  assert.deepEqual(filtered.data.recognitions, []);
  const roles = await read(app, { role: "reviewer" });
  ok(roles);
  assert.deepEqual(roles.data.recognitions, []);
});

test("the independent rule needs both host selection and a supplied current reviewed collection", async (t) => {
  const unapproved = service(t, publicHelpFixture(), null);
  let result = await read(unapproved.app);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.data.error, "workstream_help_policy_unapproved");
  const missing = service(t);
  delete missing.value.selected.reviewedWorkstreamHelp;
  result = await read(missing.app);
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.data.error, "workstream_help_unavailable");
  const empty = service(t);
  empty.value.selected.reviewedWorkstreamHelp = [];
  result = await read(empty.app);
  ok(result);
  assert.deepEqual(result.data.recognitions, []);
  for (const version of ["accepted-evidence/v1", "accepted-evidence/v2"]) {
    const present = service(t, publicHelpFixture(), workstreamHelpVersion, version);
    const absentValue = structuredClone(present.value);
    delete absentValue.selected.reviewedWorkstreamHelp;
    const absent = service(t, absentValue, null, version);
    const path = "/api/v1/contributors/101/achievements?snapshot=fixture-help&limit=20";
    const [before, after] = await Promise.all([absent.app.inject(path), present.app.inject(path)]);
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(after.statusCode, 200, after.body);
    assert.deepEqual(after.json(), before.json());
  }
});

test("current privacy, exact contribution retirement and whole snapshot revocation apply to pinned help", async (t) => {
  const { app, value } = service(t);
  const first = await read(app, { limit: "20" });
  ok(first);
  const proof = first.data.recognitions[0].proof;
  value.controls.suppressedContributionIds = [proof.contributionId];
  let result = await read(app, { limit: "20" });
  ok(result);
  assert.equal(result.data.totalRecognitions, 2);
  assert.equal(
    result.data.recognitions.some((entry) => entry.proof.contributionId === proof.contributionId),
    false,
  );
  value.controls.suppressedContributionIds = [];
  value.controls.suppressedArtifactIds = [proof.artifactId];
  result = await read(app, { limit: "20" });
  ok(result);
  assert.equal(result.data.totalRecognitions, 2);
  assert.notEqual(
    (await app.inject("/api/v1/evidence/" + proof.contributionId + "?snapshot=fixture-help")).statusCode,
    200,
  );
  value.controls.suppressedActorIds = ["101"];
  assert.equal((await read(app)).response.statusCode, 404);
  value.controls.suppressedActorIds = [];
  value.controls.revokedSnapshotIds = ["fixture-help"];
  result = await read(app);
  assert.equal(result.response.statusCode, 410);
  assert.match(result.response.headers["cache-control"], /no-store/);
});

test("source corrections and acceptance withdrawal never transfer an earlier help statement", async (t) => {
  for (const change of [
    (entry) => {
      entry.sourceRevision = "corrected-observation";
    },
    (entry) => {
      entry.contribution.roles = ["coauthor"];
    },
    (entry) => {
      entry.artifact.publicUrl += "9";
    },
    (entry) => {
      entry.occurredAt = "2026-10-07T10:00:00.0001Z";
      entry.evidenceMetadata.sourceOccurredAt = entry.occurredAt;
    },
    (entry) => {
      if (Object.hasOwn(entry, "activityState")) entry.activityState = "observed";
      entry.evidenceMetadata.activityState = "observed";
      entry.evidenceMetadata.sourceAction = "pull_request_merged";
      entry.evidenceMetadata.acceptedAt = null;
    },
  ]) {
    const { app, value } = service(t);
    const help = value.selected.reviewedWorkstreamHelp[0];
    for (const entry of copies(value, help.contributionId)) change(entry);
    const result = await read(app, { limit: "20" });
    ok(result);
    assert.equal(result.data.totalRecognitions, 2);
    assert.equal(
      result.data.recognitions.some((entry) => entry.help.contributionId === help.contributionId),
      false,
    );
  }
});

test("disabled categories and positively automated actors cannot retain help credit", async (t) => {
  const { app, value } = service(t);
  value.selected.actors.find((actor) => actor.actorId === "101").actor.executionMode = "automated";
  const automated = await read(app, { actors: "all" });
  ok(automated);
  assert.deepEqual(automated.data.recognitions, []);
  value.selected.actors.find((actor) => actor.actorId === "101").actor.executionMode = "unknown";
  value.selected.disabledMetrics = [
    { id: "maintenance", reason: "policy_withdrawn", policyVersion: "fixture-policy-2", policyLink: null },
  ];
  const broad = await read(app);
  ok(broad);
  assert.deepEqual(broad.data.recognitions, []);
  const category = await read(app, { category: "maintenance" });
  assert.equal(category.response.statusCode, 503);
  assert.equal(category.data.error, "metric_disabled");
});

test("source occurrence keeps its half-open period independently of acceptance and review", async (t) => {
  const { app } = service(t);
  const included = await read(app, {
    start: helpMergedAt,
    end: "2026-10-07T10:00:00.0001Z",
    limit: "20",
  });
  ok(included);
  assert.equal(included.data.totalRecognitions, 3);
  workstreamHelpPage(included.data, included.selected, "101");
  const excluded = await read(app, {
    start: "2026-10-07T09:59:59.9999Z",
    end: helpMergedAt,
  });
  ok(excluded);
  assert.equal(excluded.data.totalRecognitions, 0);
});

test("paging binds current projected relationships, full selection and current control authority", async (t) => {
  const { app, value } = service(t);
  const first = await read(app);
  ok(first);
  assert.equal(first.data.recognitions.length, 2);
  assert.ok(first.data.nextCursor);
  const second = await read(app, { cursor: first.data.nextCursor });
  ok(second);
  assert.equal(second.data.recognitions.length, 1);
  assert.equal(second.data.nextCursor, null);
  assert.equal(
    new Set([...first.data.recognitions, ...second.data.recognitions].map((entry) => entry.help.contributionId)).size,
    3,
  );
  for (const changed of [
    { category: "maintenance" },
    { limit: "1" },
    { repository: "2" },
    { role: "author" },
    { actors: "user" },
  ])
    assert.equal((await read(app, { cursor: first.data.nextCursor, ...changed })).response.statusCode, 400);
  value.controls.suppressedArtifactIds = [first.data.recognitions[0].proof.artifactId];
  const stale = await read(app, { cursor: first.data.nextCursor });
  assert.equal(stale.response.statusCode, 400);
  assert.equal(stale.data.error, "cursor_scope_mismatch");
  assert.equal(value.controls.version, "fixture-help-controls-1");
  const current = await read(app, { limit: "1" });
  ok(current);
  value.controls.version = "fixture-help-controls-2";
  const retired = await read(app, { limit: "1", cursor: current.data.nextCursor });
  assert.equal(retired.response.statusCode, 410);
});

test("ambiguous identities, stale accepted clocks and changed immutable bytes fail closed before public output", async (t) => {
  for (const change of [
    (value) => {
      value.selected.reviewedWorkstreamHelp.push(structuredClone(value.selected.reviewedWorkstreamHelp[0]));
    },
    (value) => {
      value.selected.reviewedWorkstreamHelp = Array(1001).fill(value.selected.reviewedWorkstreamHelp[0]);
    },
    (value) => {
      value.selected.reviewedWorkstreamHelp[0].statementHash = "a".repeat(64);
    },
    (value) => {
      value.selected.reviewedWorkstreamHelp[0].privateDecision = "PRIVATE";
    },
    (value) => {
      const help = value.selected.reviewedWorkstreamHelp[0];
      for (const entry of copies(value, help.contributionId)) delete entry.evidenceMetadata;
    },
    (value) => {
      value.selected.reviewedWorkstreamHelp[0].acceptedAt = "2026-10-09T09:00:00.000Z";
    },
    (value) => {
      value.selected.reviewedWorkstreamHelp[0].reviewedAt = "2026-10-10T10:00:00.0001Z";
    },
    (value) => {
      value.selected.evidence[0].sourceRevision = "contradictory-route-revision";
    },
    (value) => {
      const pending = structuredClone(value.selected.portfolioEvidence[0]);
      pending.activityState = "pending";
      pending.evidenceMetadata.activityState = "pending";
      pending.evidenceMetadata.acceptedAt = null;
      pending.evidenceMetadata.sourceAction = "pull_request_merged";
      value.selected.pendingEvidence = [pending];
    },
    (value) => {
      const help = value.selected.reviewedWorkstreamHelp[1];
      help.statement.from.label = "Different Platform";
      rehash(help);
    },
    (value) => {
      const prior = value.selected.reviewedWorkstreamHelp[0],
        help = value.selected.reviewedWorkstreamHelp[1];
      help.statementUrl = prior.statementUrl;
      help.statementRevision = prior.statementRevision;
    },
    (value) => {
      const actor = structuredClone(value.selected.actors.find((entry) => entry.actorId === "101"));
      actor.actorId = "different-public-id";
      value.selected.actors.push(actor);
    },
  ]) {
    const { app, value } = service(t);
    change(value);
    const result = await read(app);
    assert.equal(result.response.statusCode, 503, result.response.body);
    assert.match(result.response.headers["cache-control"], /no-store/);
    assert.equal(Object.hasOwn(result.data, "recognitions"), false);
  }
});

test("the strict client rejects wrong identity, scope, clocks, roles, private fields and malformed pages", async (t) => {
  const { app } = service(t);
  const result = await read(app, { limit: "20", category: "maintenance", repository: "2" });
  ok(result);
  for (const change of [
    (x) => {
      x.actorId = "303";
    },
    (x) => {
      x.ruleVersion = [workstreamHelpVersion];
    },
    (x) => {
      x.recognitions[0].proof.actorId = "303";
    },
    (x) => {
      x.recognitions[0].proof.roles = ["coauthor"];
    },
    (x) => {
      x.recognitions[0].proof.activityState = "observed";
    },
    (x) => {
      x.recognitions[0].proof.metricIds = ["documentation"];
    },
    (x) => {
      x.recognitions[0].help.statement.organization = "Other";
    },
    (x) => {
      x.recognitions[0].help.statement.from.id = x.recognitions[0].help.statement.to.id;
    },
    (x) => {
      x.recognitions[0].help.statementUrl = x.recognitions[0].help.statementUrl.replace("b".repeat(40), "main");
    },
    (x) => {
      x.recognitions[0].help.statement.sourceUrl += "\n";
    },
    (x) => {
      x.recognitions[0].help.statement.sourceUrl += "?";
    },
    (x) => {
      x.recognitions[0].help.statement.sourceUrl += "#";
    },
    (x) => {
      x.recognitions[0].help.statementUrl += "?";
    },
    (x) => {
      x.recognitions[0].help.statementUrl += "#";
    },
    (x) => {
      x.recognitions[0].help.contributionId = "..";
    },
    (x) => {
      x.recognitions[0].help.reviewedAt = "2026-10-10T10:00:00.0001Z";
    },
    (x) => {
      x.recognitions[0].help.acceptedAt = "2026-10-09T10:00:01.000Z";
    },
    (x) => {
      x.recognitions[0].help.sourceAcceptance = "PRIVATE";
    },
    (x) => {
      x.recognitions.push(x.recognitions[0]);
    },
    (x) => {
      x.pageSize = 1;
    },
    (x) => {
      x.totalRecognitions = 1;
    },
    (x) => {
      x.nextCursor = "page.signature\n";
    },
    (x) => {
      x.recognitions[1].help.statement.from.label = "Contradictory name";
    },
    (x) => {
      x.recognitions[1].help.statementUrl = x.recognitions[0].help.statementUrl;
    },
  ]) {
    const changed = structuredClone(result.data);
    change(changed);
    assert.throws(() => workstreamHelpPage(changed, result.selected, "101"));
  }
  assert.throws(() =>
    workstreamHelpPage(result.data, selection("?snapshot=fixture-help&repository=other&limit=20"), "101"),
  );
  assert.throws(() => workstreamHelpPage(result.data, { ...result.selected, actors: "automation" }, "101"));
});

test("help paging never borrows timeline, card or milestone cursors", () => {
  const selected = selection(
    "?snapshot=fixture-help&repository=2&category=maintenance&metric=pr_merged&search=101&cursor=timeline.signature&limit=99",
  );
  const params = workstreamHelpParameters(selected, "fixture-help");
  assert.equal(params.get("snapshot"), "fixture-help");
  assert.equal(params.get("repository"), "2");
  assert.equal(params.get("category"), "maintenance");
  assert.equal(params.get("limit"), "20");
  for (const key of ["metric", "search", "cursor"]) assert.equal(params.get(key), null);
  assert.equal(workstreamHelpParameters(selected, "fixture-help", "help.signature").get("cursor"), "help.signature");
});

test("the optional provider collection rejects getters and over-budget data before schema projection", () => {
  const value = publicHelpFixture();
  let invoked = false;
  Object.defineProperty(value.selected, "reviewedWorkstreamHelp", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  assert.throws(() => projectWorkstreamHelp(value.selected, value.selected.portfolioEvidence, value.selected.scope));
  assert.equal(invoked, false);
  const proxy = publicHelpFixture();
  proxy.selected.reviewedWorkstreamHelp = new Proxy([], {
    get() {
      throw new Error("trap invoked");
    },
  });
  assert.throws(
    () => projectWorkstreamHelp(proxy.selected, proxy.selected.portfolioEvidence, proxy.selected.scope),
    /workstream_help_evidence_conflict/,
  );
  const excessive = publicHelpFixture();
  excessive.selected.reviewedWorkstreamHelp[0].unused = "x".repeat(8_000_001);
  assert.throws(
    () => projectWorkstreamHelp(excessive.selected, excessive.selected.portfolioEvidence, excessive.selected.scope),
    /workstream_help_evidence_conflict/,
  );
});

for (const [name, make, asKey] of [
  ["escaped control value", () => "\u0000".repeat(1_333_334), false],
  ["escaped property name", () => "\u0000".repeat(1_333_334), true],
  ["unpaired surrogate value", () => "\ud800".repeat(1_333_334), false],
]) {
  test("the public provider rejects over-budget " + name + " before serialization or schema admission", (t) => {
    const value = publicHelpFixture();
    const text = make();
    if (asKey) value.selected.reviewedWorkstreamHelp[0][text] = null;
    else value.selected.reviewedWorkstreamHelp[0].unused = text;
    let parses = 0;
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", function (...args) {
      assert.ok(args[0] !== text, "the oversized escaped representation must never be allocated");
      return Reflect.apply(stringify, this, args);
    });
    t.mock.method(publicWorkstreamHelpSchema, "safeParse", () => {
      parses++;
      throw new Error("schema admission reached");
    });
    assert.throws(
      () => projectWorkstreamHelp(value.selected, value.selected.portfolioEvidence, value.selected.scope),
      /workstream_help_evidence_conflict/,
    );
    assert.equal(parses, 0);
  });
}

test("the public provider bounds property count before descriptor copies or schema projection", (t) => {
  const value = publicHelpFixture();
  const excessive = Object.create(null);
  for (let index = 0; index <= 250_000; index++) excessive["field" + index] = null;
  value.selected.reviewedWorkstreamHelp = [excessive];
  let parses = 0;
  const descriptor = Object.getOwnPropertyDescriptor;
  const descriptors = Object.getOwnPropertyDescriptors;
  t.mock.method(Object, "getOwnPropertyDescriptor", function (item, key) {
    assert.ok(item !== excessive, "count rejection must precede per-property descriptor access");
    return Reflect.apply(descriptor, this, [item, key]);
  });
  t.mock.method(Object, "getOwnPropertyDescriptors", function (item) {
    assert.ok(item !== excessive, "bulk descriptor copies must not precede the count bound");
    return Reflect.apply(descriptors, this, [item]);
  });
  t.mock.method(publicWorkstreamHelpSchema, "safeParse", () => {
    parses++;
    throw new Error("schema admission reached");
  });
  assert.throws(
    () => projectWorkstreamHelp(value.selected, value.selected.portfolioEvidence, value.selected.scope),
    /workstream_help_evidence_conflict/,
  );
  assert.equal(parses, 0);
});
