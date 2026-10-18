import test from "node:test";
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
        metricDefinitionVersion: "candidate-0.1.0",
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
      ranking: [{ metricId: "pr_opened", direction: "descending" }],
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
  for (const times of [
    ["2026-10-17T10:00:00.100Z", "2026-10-17T10:00:00Z"],
    ["2026-10-17T09:00:00-02:00", "2026-10-17T10:00:00Z"],
    ["2026-10-17T10:00:00.000Z", "2026-10-17T06:00:00-04:00"],
  ]) {
    const { data, selected } = await read(t, fixture(times));
    const expected = Date.parse(times[0]) === Date.parse(times[1]) ? 0 : 1;
    for (const award of data.achievements) assert.deepEqual(award.evidenceIds, [`synthetic-evidence-${expected}`]);
    const parsed = achievements(data, selected, "synthetic-actor");
    assert.equal(parsed.achievements[0].occurredAt, times[expected]);
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
