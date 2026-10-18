import test from "node:test";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";
import { selection } from "../../web/src/remote/client.ts";
import { achievements } from "../../web/src/remote/recognition-client.ts";

const at = "2026-10-17T12:00:00.000Z";
const start = "2026-10-17T10:00:00.000Z";
const end = "2026-10-17T11:00:00.000Z";

function fixture(times = ["2026-10-17T10:30:00.000Z"]) {
  const coverage = {
    schemaVersion: "leaderboard/v1",
    state: "complete",
    source: "github_rest",
    scopeId: "synthetic-org",
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: at,
    knownStart: "2026-10-01T00:00:00.000Z",
    lastSuccessfulSync: at,
    sourceWatermark: at,
    missingPages: 0,
    permissionsMissing: [],
    sourceErrors: [],
  };
  const portfolioEvidence = times.map((occurredAt, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `synthetic-pr-${index}`,
      repositoryId: "synthetic-repo",
      publicUrl: `https://github.com/synthetic/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `synthetic-evidence-${index}`,
      canonicalEventId: `synthetic-event-${index}`,
      artifactId: `synthetic-pr-${index}`,
      actorId: "synthetic-actor",
      roles: ["reviewer"],
      qualification: "eligible",
      metricIds: ["pr_opened"],
      reasonCodes: ["synthetic_accepted_source"],
    },
    occurredAt,
    observedAt: at,
    activityState: "accepted",
    sourceRevision: "synthetic-revision",
    sourceRevisionUrl: null,
  }));
  return {
    head: { snapshotId: "synthetic-snapshot", revision: 1, publishedAt: at },
    controls: {
      version: "synthetic-policy",
      suppressedActorIds: [],
      suppressedArtifactIds: [],
      revokedSnapshotIds: [],
    },
    selected: {
      approvedPublic: true,
      scope: { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null },
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "synthetic-snapshot",
        revision: 1,
        generatedAt: at,
        metricDefinitionVersion: metricRegistryV1.policy_version,
        computationVersion: "synthetic-test-only",
        coverage: [coverage],
        results: [],
      },
      actors: [
        {
          actorId: "synthetic-actor",
          state: "public",
          actor: {
            schemaVersion: "leaderboard/v1",
            identityState: "resolved",
            githubNodeId: "synthetic-actor",
            login: "synthetic-actor",
            kind: "user",
            executionMode: "unknown",
          },
        },
      ],
      rows: [],
      evidence: [],
      portfolioEvidence,
      ranking: [{ metricId: "pr_opened", direction: "descending", rank: false }],
    },
  };
}

async function read(t, value) {
  const app = createService({
    source: { read: async () => structuredClone(value) },
    approvedAchievementRuleVersion: "accepted-evidence/v1",
  });
  t.after(() => app.close());
  const parameters = new URLSearchParams({ snapshot: "synthetic-snapshot" });
  for (const key of ["start", "end"]) if (value.selected.scope[key]) parameters.set(key, value.selected.scope[key]);
  const response = await app.inject({ url: `/api/v1/contributors/synthetic-actor/achievements?${parameters}` });
  assert.equal(response.statusCode, 200, response.body);
  return { data: response.json(), selected: selection(`?${parameters}`) };
}

test("equivalent coverage instants preserve all-history awards across offsets and precision", async (t) => {
  const value = fixture();
  const coverage = value.selected.snapshot.coverage[0];
  coverage.windowStart = "2026-10-01T00:00:00Z";
  coverage.windowEnd = "2026-10-17T08:00:00-04:00";
  coverage.sourceWatermark = "2026-10-17T14:00:00+02:00";
  const { data } = await read(t, value);
  assert.equal(data.achievements.length, 2);
});

test("coverage that ends before the selected end withholds awards regardless of offset spelling", async (t) => {
  for (const field of ["windowEnd", "sourceWatermark"]) {
    const value = fixture();
    value.selected.scope.start = start;
    value.selected.scope.end = end;
    value.selected.snapshot.coverage[0][field] = "2026-10-17T11:30:00+02:00";
    const { data } = await read(t, value);
    assert.deepEqual(data.achievements, [], field);
  }
});

test("coverage that starts after the requested start cannot certify the selected period", async (t) => {
  const value = fixture();
  value.selected.scope.start = start;
  value.selected.scope.end = end;
  value.selected.snapshot.coverage[0].windowStart = "2026-10-17T07:00:01-03:00";
  const { data } = await read(t, value);
  assert.deepEqual(data.achievements, []);
});

test("earliest awards use source instants and stable evidence IDs when instants tie", async (t) => {
  for (const [times, expected] of [
    [["2026-10-17T10:00:00.100Z", "2026-10-17T10:00:00Z"], 1],
    [["2026-10-17T09:00:00-02:00", "2026-10-17T10:00:00Z"], 1],
    [["2026-10-17T10:00:00.000Z", "2026-10-17T06:00:00-04:00"], 0],
    [["2026-10-17T10:00:00.0009Z", "2026-10-17T10:00:00.0001Z"], 1],
    [["2026-10-17T10:00:00.1000Z", "2026-10-17T06:00:00.1-04:00"], 0],
  ]) {
    const { data, selected } = await read(t, fixture(times));
    assert.equal(data.achievements.length, 2);
    for (const award of data.achievements) assert.deepEqual(award.evidenceIds, [`synthetic-evidence-${expected}`]);
    const parsed = achievements(data, selected, "synthetic-actor");
    assert.equal(parsed.achievements[0].occurredAt, times[expected]);
  }
});

test("sub-millisecond coverage gaps cannot certify a later snapshot cutoff", async (t) => {
  for (const field of ["windowEnd", "sourceWatermark"]) {
    const value = fixture();
    value.selected.snapshot.generatedAt = "2026-10-17T12:00:00.0009Z";
    value.head.publishedAt = value.selected.snapshot.generatedAt;
    value.selected.snapshot.coverage[0].windowEnd = "2026-10-17T12:00:00.001Z";
    value.selected.snapshot.coverage[0].sourceWatermark = "2026-10-17T12:00:00.001Z";
    value.selected.snapshot.coverage[0][field] = "2026-10-17T08:00:00.0001-04:00";
    const { data } = await read(t, value);
    assert.deepEqual(data.achievements, [], field);
  }
});

test("the browser accepts contract-valid offset instants and enforces the same half-open period", async (t) => {
  const value = fixture(["2026-10-17T06:00:00-04:00"]);
  value.selected.scope.start = start;
  value.selected.scope.end = end;
  const { data, selected } = await read(t, value);
  assert.equal(achievements(data, selected, "synthetic-actor").achievements.length, 2);
  for (const occurredAt of [
    "2026-10-17T05:59:59-04:00",
    "2026-10-17T13:00:00+02:00",
    "yesterday",
    "2026-02-30T10:00:00Z",
  ]) {
    const changed = structuredClone(data);
    changed.achievements[0].occurredAt = occurredAt;
    assert.throws(() => achievements(changed, selected, "synthetic-actor"), occurredAt);
  }
});

test("profile pages preserve exact source order, true ties and unknown occurrence times", async (t) => {
  const times = [
    "2026-10-17T10:00:00.0001Z",
    "2026-10-17T06:00:00.0009-04:00",
    "2026-10-17T10:00:00.1000Z",
    "2026-10-17T06:00:00.1-04:00",
    null,
    "2026-10-17T10:00:01Z",
    null,
  ];
  const value = fixture(times);
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const parameters = new URLSearchParams({ snapshot: "synthetic-snapshot", limit: "2" });
  const timeline = [];
  do {
    const url = `/api/v1/contributors/synthetic-actor?${parameters}`;
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.evidenceCount, times.length);
    assert.deepEqual((await app.inject(url)).json(), body, "replaying a pinned page is idempotent");
    timeline.push(...body.timeline);
    if (!body.nextCursor) break;
    parameters.set("cursor", body.nextCursor);
    assert.ok(timeline.length < times.length, "pagination must finish without repeating evidence");
  } while (true);
  assert.deepEqual(
    timeline.map((entry) => entry.contribution.contributionId),
    [5, 2, 3, 1, 0, 4, 6].map((index) => `synthetic-evidence-${index}`),
  );
  for (const entry of timeline) {
    const index = Number(entry.contribution.contributionId.split("-").at(-1));
    assert.equal(entry.occurredAt, times[index], "the source timestamp remains unchanged");
  }
});

test("activity ranges retain sub-millisecond occurrence and collection bounds", async (t) => {
  const value = fixture(["2026-10-17T10:00:00.0009Z", "2026-10-17T06:00:00.0001-04:00"]);
  value.selected.portfolioEvidence[0].observedAt = "2026-10-17T12:00:00.0009Z";
  value.selected.portfolioEvidence[1].observedAt = "2026-10-17T08:00:00.0001-04:00";
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const response = await app.inject("/api/v1/activity");
  assert.equal(response.statusCode, 200, response.body);
  const [group] = response.json().groups;
  assert.equal(group.factCount, 2);
  assert.equal(group.earliestOccurredAt, value.selected.portfolioEvidence[1].occurredAt);
  assert.equal(group.latestOccurredAt, value.selected.portfolioEvidence[0].occurredAt);
  assert.equal(group.firstCollectedAt, value.selected.portfolioEvidence[1].observedAt);
  assert.equal(group.lastCollectedAt, value.selected.portfolioEvidence[0].observedAt);
});

test("canonical activity facts reject fractional time conflicts but retain equivalent encodings", async (t) => {
  const value = fixture(["2026-10-17T10:00:00.0001Z"]);
  const original = value.selected.portfolioEvidence[0];
  const duplicate = structuredClone(original);
  duplicate.contribution.contributionId = "synthetic-duplicate";
  duplicate.occurredAt = "2026-10-17T06:00:00.0009-04:00";
  value.selected.portfolioEvidence.push(duplicate);
  const app = createService({ source: { read: async () => structuredClone(value) } });
  t.after(() => app.close());
  const conflict = await app.inject("/api/v1/activity");
  assert.equal(conflict.statusCode, 503, conflict.body);
  assert.equal(conflict.json().error, "activity_fact_conflict");
  original.occurredAt = "2026-10-17T10:00:00.1000Z";
  duplicate.occurredAt = "2026-10-17T06:00:00.1-04:00";
  const equivalent = await app.inject("/api/v1/activity");
  assert.equal(equivalent.statusCode, 200, equivalent.body);
  assert.equal(equivalent.json().groups[0].factCount, 1);
  assert.equal(equivalent.json().groups[0].proofCount, 2);
});
