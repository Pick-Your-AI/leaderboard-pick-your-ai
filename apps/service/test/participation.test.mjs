import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { publicParticipationSchema, participationWeekDenominator } from "@pick-your-ai/contracts";
import { profile, selection } from "../../web/src/remote/client.ts";
import { participationFixture, participationStart, participationEnd } from "../../../tests/fixtures/participation.mjs";

const bounded = `start=${participationStart}&end=${participationEnd}`;
const path = `/api/v1/contributors/101?${bounded}`;
function harness(t) {
  const input = participationFixture();
  const app = createService({ source: { read: async () => structuredClone(input) } });
  t.after(() => app.close());
  return { input, app };
}

test("actual profile summarizes the full projected evidence across timeline pages without ranking newcomers", async (t) => {
  const { app } = harness(t);
  const response = await app.inject(path + "&limit=1");
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json(),
    value = body.activitySummary,
    metric = value.metrics[0];
  assert.equal(body.timeline.length, 1);
  assert.ok(body.nextCursor);
  assert.equal(body.results[0].value, 14);
  assert.equal(value.denominatorWeeks, 3); // Sunday, then two complete Monday-based weeks; final Monday excluded.
  assert.equal(metric.activeWeeks, 3);
  assert.equal(metric.datedEvidenceCount, 14); // Pending evidence never enters this summary.
  assert.equal(metric.unknownDateEvidenceCount, 0);
  assert.equal(metric.state, "measured");
  assert.equal(metric.earliestDatedEvidence.effectiveAt, "2026-10-04T23:59:59.999999999Z");
  assert.equal(metric.earliestDatedEvidence.observedAt, "2026-10-17T11:59:59.123456789Z");
  assert.equal(value.history.newcomer, null); // Complete selected coverage is not reviewed organization history.
  assert.equal(value.history.reason, "reviewed_organization_history_unavailable");
  assert.equal(value.ranked, false);
  const next = await app.inject(path + `&limit=1&cursor=${encodeURIComponent(body.nextCursor)}`);
  assert.equal(next.statusCode, 200, next.body);
  assert.deepEqual(next.json().activitySummary, value);
  const proof = await app.inject(
    `/api/v1/evidence/${metric.earliestDatedEvidence.contributionId}?${bounded}&snapshot=${body.snapshotId}`,
  );
  assert.equal(proof.statusCode, 200, proof.body);
  assert.deepEqual(profile(body, selection(`?${bounded}&limit=1`)).activitySummary, value);
});

test("current artifact, actor, metric and snapshot authority overrides pinned participation and conditional caches", async (t) => {
  const { input, app } = harness(t);
  const initial = await app.inject(path),
    hidden = initial.json().activitySummary.metrics[0].earliestDatedEvidence.contributionId;
  const pin = `&snapshot=${input.head.snapshotId}`;
  input.controls.suppressedArtifactIds = [
    input.selected.evidence.find((e) => e.contribution.contributionId === hidden).artifact.stableId,
  ];
  input.controls.version = "synthetic-controls-2";
  const changed = await app.inject({ url: path + pin, headers: { "if-none-match": initial.headers.etag } });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json().activitySummary.metrics, []); // Do not subtract a hidden policy unit from an aggregate.
  assert.equal(changed.body.includes(hidden), false);
  input.controls.suppressedActorIds = ["101"];
  assert.equal((await app.inject(path + pin)).statusCode, 404);
  input.controls.suppressedActorIds = [];
  input.controls.suppressedArtifactIds = [];
  input.selected.disabledMetrics = [
    { id: "pr_merged", reason: "policy_unapproved", policyVersion: "synthetic-v2", policyLink: null },
  ];
  assert.deepEqual((await app.inject(path + pin)).json().activitySummary.metrics, []);
  input.controls.revokedSnapshotIds = [input.head.snapshotId];
  assert.equal((await app.inject(path + pin)).statusCode, 410);
});

test("all-time and incomplete or unknown dates keep missing denominators and activity explicit", async (t) => {
  const { input, app } = harness(t);
  input.selected.scope.start = input.selected.scope.end = null;
  const url = "/api/v1/contributors/101";
  let value = (await app.inject(url)).json().activitySummary;
  assert.equal(value.denominatorWeeks, null);
  assert.equal(value.metrics[0].state, "partial");
  assert.equal(value.metrics[0].activeWeeks, 3);
  for (const entry of input.selected.evidence.filter((e) => e.contribution.actorId === "101")) entry.occurredAt = null;
  value = (await app.inject(url)).json().activitySummary;
  assert.equal(value.metrics[0].activeWeeks, null);
  assert.equal(value.metrics[0].state, "unknown");
  assert.equal(value.metrics[0].datedEvidenceCount, 0);
  assert.equal(value.metrics[0].unknownDateEvidenceCount, 14);
  assert.equal(value.metrics[0].earliestDatedEvidence, null);
});

test("zero activity requires bounded complete coverage, including exact known-start precision", async (t) => {
  const { input, app } = harness(t);
  const row = input.selected.rows.find((entry) => entry.actorId === "101");
  row.result.value = 0;
  row.evidenceIds = [];
  let metric = (await app.inject(path)).json().activitySummary.metrics[0];
  assert.equal(metric.activeWeeks, 0);
  assert.equal(metric.state, "measured");
  row.result.coverage.knownStart = "2026-10-03T20:00:00.000000001-04:00";
  metric = (await app.inject(path)).json().activitySummary.metrics[0];
  assert.equal(metric.activeWeeks, null);
  assert.equal(metric.state, "unknown");
});

test("earliest dated evidence preserves offset and fractional chronology with deterministic identity ties", async (t) => {
  const { input, app } = harness(t);
  const entries = input.selected.evidence.filter((entry) => entry.contribution.actorId === "101");
  entries[0].occurredAt = "2026-10-05T00:00:00.000000002Z";
  entries[1].occurredAt = "2026-10-04T20:00:00.000000001-04:00";
  const first = (await app.inject(path)).json().activitySummary.metrics[0].earliestDatedEvidence;
  assert.equal(first.contributionId, entries[1].contribution.contributionId);
  assert.equal(first.effectiveAt, entries[1].occurredAt);
  assert.equal(first.observedAt, null); // Legacy evidence never substitutes publication time.
  input.selected.evidence.reverse();
  assert.deepEqual((await app.inject(path)).json().activitySummary.metrics[0].earliestDatedEvidence, first);
  entries[0].occurredAt = "2026-10-05T00:00:00.000000001Z";
  assert.equal(
    (await app.inject(path)).json().activitySummary.metrics[0].earliestDatedEvidence.contributionId,
    [entries[0], entries[1]].map((e) => e.contribution.contributionId).sort()[0],
  );
});

test("category and account filters retain exact scope; diagnostic-only policies never become participation ranks", async (t) => {
  const { input, app } = harness(t);
  const original = (await app.inject(path)).json();
  assert.deepEqual((await app.inject(path + "&category=pr_merged")).json().activitySummary, original.activitySummary);
  assert.deepEqual((await app.inject(path + "&category=pr_opened")).json().activitySummary.metrics, []);
  assert.equal((await app.inject(path + "&actors=automation")).statusCode, 404);
  for (const metricId of ["pr_accepted_rate", "review_wait"]) {
    const row = structuredClone(input.selected.rows.find((entry) => entry.actorId === "101"));
    row.result.metricId = metricId;
    input.selected.rows.push(row);
    input.selected.ranking.push({ metricId, direction: "descending", rank: false });
    for (const entry of input.selected.evidence) entry.contribution.metricIds.push(metricId);
  }
  const body = (await app.inject(path)).json();
  assert.deepEqual(
    body.activitySummary.metrics.map((m) => m.metricId),
    ["pr_merged"],
  );
  assert.equal(body.results.length, 3);
  assert.deepEqual(body.diagnostics, original.diagnostics);
});

test("client rejects claimed newcomer status, mismatched denominators and summaries without projected metric authority", async (t) => {
  const { app } = harness(t),
    selected = selection(`?${bounded}`);
  const original = (await app.inject(path)).json();
  for (const change of [
    (v) => {
      v.activitySummary.history.newcomer = true;
    },
    (v) => {
      v.activitySummary.denominatorWeeks = 4;
    },
    (v) => {
      v.activitySummary.metrics[0].metricId = "documentation";
    },
    (v) => {
      v.activitySummary.ranked = true;
    },
    (v) => {
      v.activitySummary.metrics[0].activeWeeks = 15;
    },
  ]) {
    const value = structuredClone(original);
    change(value);
    assert.throws(() => profile(value, selected));
  }
  const legacy = structuredClone(original);
  delete legacy.activitySummary;
  assert.equal(profile(legacy, selected).activitySummary, null);
  assert.equal(publicParticipationSchema.safeParse(original.activitySummary).success, true);
});

test("half-open UTC week denominators retain early years, offsets, midnight and sub-millisecond boundaries", () => {
  assert.equal(participationWeekDenominator("2026-10-04T00:00:00Z", "2026-10-05T00:00:00Z"), 1);
  assert.equal(participationWeekDenominator("2026-10-04T00:00:00Z", "2026-10-05T00:00:00.000000001Z"), 2);
  assert.equal(participationWeekDenominator("2026-10-04T20:00:00-04:00", "2026-10-05T00:00:00.000000001Z"), 1);
  assert.equal(participationWeekDenominator("0000-01-01T00:00:00Z", "0000-01-02T00:00:00Z"), 1);
  assert.equal(participationWeekDenominator(null, null), null);
  assert.throws(() => participationWeekDenominator(participationEnd, participationStart));
});
