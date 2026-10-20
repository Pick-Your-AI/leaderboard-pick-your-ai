import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";
import { milestoneFixture } from "./fixtures/achievement-milestones.mjs";
import { selection } from "../../web/src/remote/client.ts";
import { achievements, milestoneParameters } from "../../web/src/remote/recognition-client.ts";

const version = "accepted-evidence/v2";
function service(t, value = milestoneFixture(), ruleVersion = version) {
  const app = createService({
    approvedAchievementRuleVersion: ruleVersion,
    cursorSecret: "synthetic-milestone-cursor-secret-000000",
    source: {
      read: async (scope) => ({ ...structuredClone(value), selected: { ...structuredClone(value.selected), scope } }),
    },
  });
  t.after(() => app.close());
  return { app, value };
}
async function read(app, extra = {}, actor = "alex") {
  const params = new URLSearchParams({ snapshot: "synthetic-milestones", limit: "2", ...extra });
  const response = await app.inject("/api/v1/contributors/" + actor + "/achievements?" + params);
  return { response, data: response.json(), selected: selection("?" + params) };
}
const ok = (value) => assert.equal(value.response.statusCode, 200, value.response.body);

test("v2 provides category-first milestones and exact accepted authorship/review pairs while v1 stays compatible", async (t) => {
  const { app } = service(t);
  const result = await read(app, { limit: "20" });
  ok(result);
  assert.equal(result.data.ruleVersion, version);
  assert.deepEqual(
    result.data.achievements.map((x) => x.id),
    [
      "first-accepted-in-scope",
      "first-review-in-scope",
      "first-category-in-scope:documentation",
      "first-category-in-scope:pr_merged",
      "first-category-in-scope:prs_reviewed",
    ],
  );
  assert.deepEqual(
    result.data.coContributions.map((x) => [x.peer.actorId, x.relationship]),
    [
      ["bea", "shared_authorship"],
      ["cam", "author_review_pair"],
      ["dev", "author_review_pair"],
    ],
  );
  assert.equal(result.data.totalCoContributions, 3);
  for (const pair of result.data.coContributions) {
    assert.equal(pair.subject.actorId, "alex");
    assert.equal(pair.subject.artifactId, pair.peerProof.artifactId);
    assert.equal(pair.subject.sourceUrl, pair.peerProof.sourceUrl);
    assert.equal(pair.peer.actorId, pair.peerProof.actorId);
  }
  const parsed = achievements(result.data, result.selected, "alex");
  assert.equal(parsed.coContributions.length, 3);
  const legacy = service(t, milestoneFixture(), "accepted-evidence/v1");
  const old = await read(legacy.app);
  ok(old);
  assert.equal(old.data.ruleVersion, "accepted-evidence/v1");
  assert.equal(old.data.achievements.length, 2);
  assert.equal(Object.hasOwn(old.data, "coContributions"), false);
  assert.equal((await read(legacy.app, { category: "documentation" })).response.statusCode, 400);
});

test("category selection never borrows a peer or milestone from a different category", async (t) => {
  const { app } = service(t);
  const result = await read(app, { category: "documentation" });
  ok(result);
  assert.equal(result.data.category, "documentation");
  assert.deepEqual(
    result.data.achievements.map((x) => x.id),
    ["first-accepted-in-scope", "first-category-in-scope:documentation"],
  );
  assert.deepEqual(
    result.data.coContributions.map((x) => x.peer.actorId),
    ["bea"],
  );
  assert.equal(achievements(result.data, result.selected, "alex").category, "documentation");
  assert.throws(() =>
    achievements(result.data, selection("?snapshot=synthetic-milestones&category=pr_merged&limit=2"), "alex"),
  );
});

test("canonical proof representations and repeated roles never multiply a pair or category milestone", async (t) => {
  const { app, value } = service(t);
  const original = value.selected.portfolioEvidence[0];
  const duplicate = structuredClone(original);
  duplicate.contribution.contributionId = "zzz-duplicate-representation";
  duplicate.contribution.metricIds = ["documentation"];
  duplicate.contribution.roles = ["author", "author"];
  duplicate.occurredAt = "2026-10-10T06:00:00.0009-04:00";
  value.selected.portfolioEvidence.push(duplicate);
  const result = await read(app, { limit: "20" });
  ok(result);
  assert.equal(result.data.achievements.length, 5);
  assert.equal(result.data.totalCoContributions, 3);
  assert.equal(result.data.achievements[0].proof.contributionId, "alex-authored");
  value.selected.portfolioEvidence.reverse();
  assert.deepEqual((await read(app, { limit: "20" })).data, result.data);
});

test("source precision selects the actual earliest category proof and retains the exact half-open interval", async (t) => {
  const { app, value } = service(t);
  const earlier = structuredClone(value.selected.portfolioEvidence[0]);
  earlier.contribution.contributionId = "z-earlier";
  earlier.contribution.canonicalEventId = "event-z-earlier";
  earlier.occurredAt = "2026-10-10T06:00:00.0001-04:00";
  value.selected.portfolioEvidence.push(earlier);
  const result = await read(app, { start: "2026-10-10T10:00:00.000Z", end: "2026-10-10T10:00:01.000Z" });
  ok(result);
  assert.equal(result.data.achievements[0].proof.contributionId, "z-earlier");
  assert.equal(result.data.achievements[0].occurredAt, earlier.occurredAt);
  achievements(result.data, result.selected, "alex");
  const changed = structuredClone(result.data);
  changed.achievements[0].occurredAt = "2026-10-10T06:00:01.0000-04:00";
  changed.achievements[0].proof.occurredAt = changed.achievements[0].occurredAt;
  assert.throws(() => achievements(changed, result.selected, "alex"));
});

test("complete-coverage milestones and partial recorded co-contribution evidence remain distinct", async (t) => {
  const { app, value } = service(t);
  value.selected.snapshot.coverage[0].state = "partial";
  const result = await read(app, { limit: "20" });
  ok(result);
  assert.deepEqual(result.data.achievements, []);
  assert.equal(result.data.totalCoContributions, 3);
  assert.equal(achievements(result.data, result.selected, "alex").coContributions.length, 3);
  value.selected.snapshot.coverage[0].state = "complete";
  const forged = (await read(app)).data;
  forged.coverage = [];
  assert.throws(() => achievements(forged, result.selected, "alex"));
});

test("current privacy and withdrawal recompute pinned milestones and peer proof", async (t) => {
  const { app, value } = service(t);
  const first = await read(app);
  ok(first);
  value.controls.suppressedActorIds = ["bea"];
  let result = await read(app, { limit: "20" });
  ok(result);
  assert.deepEqual(
    result.data.coContributions.map((x) => x.peer.actorId),
    ["cam", "dev"],
  );
  value.controls.suppressedArtifactIds = ["synthetic-pr-1"];
  result = await read(app, { limit: "20" });
  ok(result);
  assert.deepEqual(
    result.data.coContributions.map((x) => x.peer.actorId),
    ["dev"],
  );
  assert.equal(result.data.achievements[0].proof.contributionId, "alex-reviewed");
  value.selected.portfolioEvidence.find((x) => x.contribution.contributionId === "alex-reviewed").activityState =
    "observed";
  result = await read(app);
  ok(result);
  assert.deepEqual(result.data.achievements, []);
  assert.deepEqual(result.data.coContributions, []);
  value.controls.revokedSnapshotIds = ["synthetic-milestones"];
  assert.equal((await read(app)).response.statusCode, 410);
});

test("disabled categories and positively automated accounts never receive milestone or peer credit", async (t) => {
  const { app, value } = service(t);
  for (const actors of ["all", "user", "automation"]) {
    const result = await read(app, { actors }, "robot");
    ok(result);
    assert.deepEqual(result.data.achievements, []);
    assert.deepEqual(result.data.coContributions, []);
  }
  value.selected.disabledMetrics = [
    { id: "documentation", reason: "policy_withdrawn", policyVersion: "synthetic-policy-2", policyLink: null },
  ];
  const result = await read(app, { limit: "20" });
  ok(result);
  assert.equal(
    result.data.achievements.some((award) => award.categoryId === "documentation"),
    false,
  );
  for (const pair of result.data.coContributions) {
    assert.equal(pair.subject.metricIds.includes("documentation"), false);
    assert.equal(pair.peerProof.metricIds.includes("documentation"), false);
  }
  achievements(result.data, result.selected, "alex");
  const disabled = await read(app, { category: "documentation" });
  assert.equal(disabled.response.statusCode, 503);
  assert.equal(disabled.data.error, "metric_disabled");
});

test("a snapshot cannot establish a first event through a later selected cutoff", async (t) => {
  const { app, value } = service(t);
  const start = "2026-10-01T00:00:00.000Z";
  const end = "2026-10-18T00:00:00.000Z";
  value.selected.snapshot.coverage[0].windowEnd = end;
  value.selected.snapshot.coverage[0].sourceWatermark = end;
  const result = await read(app, { start, end, limit: "20" });
  ok(result);
  assert.deepEqual(result.data.achievements, []);
  assert.equal(result.data.coContributions.length, 3);
  achievements(result.data, result.selected, "alex");
  const forged = (await read(app, { limit: "20" })).data;
  forged.scope.start = start;
  forged.scope.end = end;
  assert.throws(() => achievements(forged, result.selected, "alex"));
  value.selected.portfolioEvidence[0].occurredAt = "2026-10-17T12:00:00.0001Z";
  const future = await read(app);
  assert.equal(future.response.statusCode, 503);
  assert.equal(future.data.error, "achievement_evidence_conflict");
});

test("co-contribution pagination is stable and binds the exact actor, category, scope and current policy", async (t) => {
  const { app, value } = service(t);
  const first = await read(app);
  ok(first);
  assert.equal(first.data.coContributions.length, 2);
  assert.ok(first.data.nextCursor);
  const second = await read(app, { cursor: first.data.nextCursor });
  ok(second);
  assert.deepEqual(
    second.data.coContributions.map((x) => x.peer.actorId),
    ["dev"],
  );
  assert.equal(second.data.nextCursor, null);
  assert.deepEqual(second.data.achievements, first.data.achievements);
  assert.equal((await read(app, { cursor: first.data.nextCursor, category: "pr_merged" })).response.statusCode, 400);
  assert.equal((await read(app, { cursor: first.data.nextCursor }, "bea")).response.statusCode, 400);
  value.controls.version = "synthetic-controls-2";
  assert.equal((await read(app, { cursor: first.data.nextCursor })).response.statusCode, 410);
});

test("a correction changes the actual page cohort even when a provider leaves its control version unchanged", async (t) => {
  for (const alter of [
    (value) => {
      value.controls.suppressedActorIds = ["bea"];
    },
    (value) => {
      value.selected.actors[1].actor.displayName = "Corrected synthetic display name";
    },
    (value) => {
      value.selected.portfolioEvidence[1].activityState = "observed";
    },
  ]) {
    const { app, value } = service(t);
    const first = await read(app);
    ok(first);
    alter(value);
    assert.equal(value.controls.version, "synthetic-controls-1");
    const stale = await read(app, { cursor: first.data.nextCursor });
    assert.equal(stale.response.statusCode, 400);
    assert.equal(stale.data.error, "cursor_scope_mismatch");
    const fresh = await read(app);
    ok(fresh);
    assert.notDeepEqual(fresh.data.coContributions, first.data.coContributions);
  }
});

test("achievement requests preserve the exact category and give shared-artifact paging its own cursor", () => {
  const selected = selection(
    "?snapshot=synthetic-milestones&repository=synthetic-repo&category=documentation&metric=pr_merged&search=alex&cursor=timeline.signature&limit=99",
  );
  const params = milestoneParameters(selected, "synthetic-milestones");
  assert.equal(params.get("snapshot"), "synthetic-milestones");
  assert.equal(params.get("repository"), "synthetic-repo");
  assert.equal(params.get("category"), "documentation");
  assert.equal(params.get("limit"), "20");
  for (const key of ["cursor", "search", "metric"]) assert.equal(params.get(key), null);
  assert.equal(
    milestoneParameters(selected, "synthetic-milestones", "shared.signature").get("cursor"),
    "shared.signature",
  );
  assert.throws(() => milestoneParameters(selected, "synthetic-milestones", "shared.signature\n"));
});

test("contradictory canonical times, artifact identities and actor aliases cannot manufacture shared credit", async (t) => {
  for (const alter of [
    (value) => {
      const copy = structuredClone(value.selected.portfolioEvidence[0]);
      copy.contribution.contributionId = "duplicate-wrong-time";
      copy.occurredAt = "2026-10-10T10:00:00.001Z";
      value.selected.portfolioEvidence.push(copy);
    },
    (value) => {
      value.selected.portfolioEvidence[1].artifact.publicUrl =
        "https://github.com/synthetic-milestones/example/pull/999";
    },
    (value) => {
      value.selected.actors[1].actor.githubNodeId = value.selected.actors[0].actor.githubNodeId;
    },
    (value) => {
      value.selected.pendingEvidence = [
        { ...structuredClone(value.selected.portfolioEvidence[0]), activityState: "pending" },
      ];
      value.selected.rows.find((row) => row.actorId === "alex" && row.result.metricId === "pr_merged").pending = {
        schemaVersion: "leaderboard-pending/v1",
        state: "partial",
        valueClass: "qualified",
        count: 1,
        evidenceIds: ["alex-authored"],
      };
    },
  ]) {
    const value = milestoneFixture();
    alter(value);
    const { app } = service(t, value);
    const result = await read(app);
    assert.equal(result.response.statusCode, 503);
    assert.equal(result.data.error, "achievement_evidence_conflict");
  }
});

test("strict v2 client binds every award and shared-artifact proof to current scope, identity and accepted roles", async (t) => {
  const { app } = service(t);
  const result = await read(app, { limit: "20" });
  ok(result);
  for (const alter of [
    (x) => {
      x.achievements[0].proof.activityState = "observed";
    },
    (x) => {
      x.achievements[0].proof.actorId = "bea";
    },
    (x) => {
      x.achievements[0].evidenceIds = ["different-proof"];
    },
    (x) => {
      x.achievements[2].categoryId = "unregistered";
    },
    (x) => {
      x.coContributions[0].peer.actorId = "alex";
    },
    (x) => {
      x.coContributions[0].peerProof.artifactId = "different-artifact";
    },
    (x) => {
      x.coContributions[0].peerProof.roles = ["reviewer"];
    },
    (x) => {
      x.coContributions[0].peerProof.sourceUrl = "https://github.com/synthetic/example/pull/1?private=1";
    },
    (x) => {
      x.coContributions[0].subject.repositoryId = "other-repo";
    },
    (x) => {
      x.coContributions[0].peer.privateReceipt = "must-not-project";
    },
    (x) => {
      x.coContributions.push(x.coContributions[0]);
    },
    (x) => {
      x.pageSize = 1;
    },
    (x) => {
      x.totalCoContributions = 1;
    },
    (x) => {
      x.nextCursor = "page.signature\n";
    },
    (x) => {
      x.achievements[0].proof.contributionId += "\n";
    },
    (x) => {
      x.achievements[0].proof.contributionId = "..";
      x.achievements[0].evidenceIds = [".."];
    },
    (x) => {
      x.coContributions[0].peer.actorId = ".";
      x.coContributions[0].peerProof.actorId = ".";
    },
    (x) => {
      x.coContributions[0].peerProof.sourceUrl += "\n";
    },
  ]) {
    const changed = structuredClone(result.data);
    alter(changed);
    assert.throws(() => achievements(changed, result.selected, "alex"));
  }
});

async function assertMergeTargetMilestoneScope(t, empty) {
  const value = milestoneFixture();
  if (empty) {
    value.selected.snapshot.coverage[0].state = "partial";
    value.selected.evidence = [];
    value.selected.portfolioEvidence = [];
    value.selected.rows = [];
  }
  const { app } = service(t, value);
  const request = {
    repository: "synthetic-repo",
    branch: "release/one",
    category: "pr_merged",
    limit: "20",
  };
  const result = await read(app, request);
  ok(result);
  assert.equal(result.data.schemaVersion, "public-read/v4");
  assert.equal(result.data.scope.schemaVersion, "public-scope/v4");
  assert.equal(result.data.scope.branch, request.branch);
  assert.equal(result.data.category, request.category);
  assert.equal(milestoneParameters(result.selected, "synthetic-milestones").get("branch"), request.branch);
  if (empty) {
    assert.deepEqual(result.data.achievements, []);
    assert.deepEqual(result.data.coContributions, []);
    assert.equal(result.data.totalCoContributions, 0);
    assert.equal(result.data.nextCursor, null);
    assert.equal(result.data.coverage[0].state, "partial");
  } else {
    assert.deepEqual(
      result.data.achievements.map((award) => award.id),
      ["first-accepted-in-scope", "first-category-in-scope:pr_merged"],
    );
    assert.deepEqual(
      result.data.coContributions.map((pair) => pair.peer.actorId),
      ["bea"],
    );
    assert.equal(result.data.achievements[0].proof.contributionId, "alex-authored");
    assert.equal(result.data.coContributions[0].peerProof.contributionId, "bea-authored");
  }
  const parsed = achievements(result.data, result.selected, "alex");
  assert.deepEqual(parsed.scope, result.data.scope);
  assert.deepEqual(parsed.achievements, result.data.achievements);
  assert.deepEqual(parsed.coContributions, result.data.coContributions);

  const wrongBranch = await read(app, { ...request, branch: "release/two" });
  ok(wrongBranch);
  assert.equal(wrongBranch.data.scope.branch, "release/two");
  assert.throws(() => achievements(wrongBranch.data, result.selected, "alex"), {
    status: 502,
    code: "api_scope_mismatch",
  });

  const { branch: _branch, ...branchlessRequest } = request;
  const missingBranch = await read(app, branchlessRequest);
  ok(missingBranch);
  assert.equal(missingBranch.data.schemaVersion, "leaderboard/v1");
  assert.equal(Object.hasOwn(missingBranch.data.scope, "branch"), false);
  assert.throws(() => achievements(missingBranch.data, result.selected, "alex"), {
    status: 502,
    code: "api_scope_mismatch",
  });

  const malformed = structuredClone(result.data);
  delete malformed.scope.branch;
  assert.throws(() => achievements(malformed, result.selected, "alex"), {
    status: 502,
    code: "api_scope_mismatch",
  });
}

test("populated v4 milestones retain the exact merge target through the service and client", async (t) => {
  await assertMergeTargetMilestoneScope(t, false);
});

test("empty v4 milestones retain the exact merge target with incomplete history", async (t) => {
  await assertMergeTargetMilestoneScope(t, true);
});
