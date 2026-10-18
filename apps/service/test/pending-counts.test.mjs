import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { pendingCountSchema } from "@pick-your-ai/contracts";
import { board, selection, validateExport } from "../../web/src/remote/client.ts";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";
const url = "/api/v1/boards?metric=pr_merged";
function harness(t, publishedAt = at) {
  const input = readFixture();
  input.head.publishedAt = publishedAt;
  input.selected.snapshot.generatedAt = publishedAt;
  const app = createService({
    now: () => Date.parse(publishedAt),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  return { input, app };
}
const alice = (body) => body.rows.find((row) => row.actorId === "101");
test("real API and minimized exports preserve 14 accepted and 3 pending without changing rank", async (t) => {
  const { input, app } = harness(t);
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json(),
    row = alice(result);
  assert.equal(row.result.value, 14);
  assert.equal(row.evidenceIds.length, 14);
  assert.equal(row.pending.count, 3);
  assert.equal(row.pending.evidenceIds.length, 3);
  assert.equal(row.pending.valueClass, "qualified");
  assert.equal(row.rank, 2); // 15 accepted stays above 14 accepted + 3 pending.
  assert.deepEqual(result.diagnostics.find((entry) => entry.actorId === "101").pending, row.pending);
  assert.deepEqual(alice(board(result, selection("?metric=pr_merged"))).pending, row.pending);
  const exported = (await app.inject("/api/v1/exports?metric=pr_merged&format=json")).json();
  assert.equal(alice(exported).pending.count, 3);
  assert.equal(exported.evidence.length, 29);
  assert.equal(exported.pendingEvidence.length, 3);
  validateExport(exported, selection(`?metric=pr_merged&snapshot=${result.snapshotId}`), result.metric);
  const csv = await app.inject("/api/v1/exports?metric=pr_merged&format=csv");
  assert.equal(csv.statusCode, 200);
  assert.match(csv.body, /"pending","pending_evidence"/);
  for (const entry of input.selected.pendingEvidence) {
    const detail = await app.inject(
      `/api/v1/evidence/${entry.contribution.contributionId}?snapshot=${result.snapshotId}`,
    );
    assert.equal(detail.json().activityState, "pending");
  }
});
test("current pending artifact suppression removes count and every dependency from pinned routes", async (t) => {
  const { input, app } = harness(t);
  const prior = await app.inject(url);
  input.controls.version = "synthetic-controls-2";
  const removed = input.selected.pendingEvidence[0];
  input.controls.suppressedArtifactIds.push(removed.artifact.stableId);
  const pin = `&snapshot=${input.head.snapshotId}`;
  const response = await app.inject({ url: url + pin, headers: { "if-none-match": prior.headers.etag } });
  assert.equal(response.statusCode, 200);
  const row = alice(response.json());
  assert.equal(row.result.value, 14);
  assert.equal(row.rank, 2);
  assert.deepEqual(row.pending, {
    schemaVersion: "leaderboard-pending/v1",
    valueClass: "qualified",
    state: "unknown",
    count: null,
    evidenceIds: [],
  });
  assert.equal(response.json().diagnostics.find((entry) => entry.actorId === "101").pending.count, null);
  const exported = (await app.inject(`/api/v1/exports?metric=pr_merged&format=json${pin}`)).json();
  assert.deepEqual(exported.pendingEvidence, []);
  assert.equal(JSON.stringify(exported).includes(removed.contribution.contributionId), false);
  assert.equal(
    (await app.inject(`/api/v1/evidence/${removed.contribution.contributionId}?snapshot=${input.head.snapshotId}`))
      .statusCode,
    404,
  );
});
test("current actor suppression, policy disablement and snapshot revocation override pending history", async (t) => {
  const { input, app } = harness(t);
  const pin = `&snapshot=${input.head.snapshotId}`;
  input.controls.suppressedActorIds = ["101"];
  assert.equal(alice((await app.inject(url + pin)).json()), undefined);
  const exported = (await app.inject(`/api/v1/exports?metric=pr_merged&format=json${pin}`)).json();
  assert.deepEqual(exported.pendingEvidence, []);
  input.controls.suppressedActorIds = [];
  input.selected.disabledMetrics = [
    { id: "pr_merged", reason: "policy_unapproved", policyVersion: "synthetic-v2", policyLink: null },
  ];
  assert.equal((await app.inject(url + pin)).statusCode, 503);
  assert.equal(
    (await app.inject(`/api/v1/evidence/synthetic-101-14?snapshot=${input.head.snapshotId}`)).statusCode,
    404,
  );
  input.controls.revokedSnapshotIds = [input.head.snapshotId];
  assert.equal((await app.inject(url + pin)).statusCode, 410);
});
test("missing, unsafe and wrong actor/metric pending receipts never disclose counts", async (t) => {
  const mutations = [
    (data) => data.selected.pendingEvidence.pop(),
    (data) => {
      data.selected.pendingEvidence[0].artifact.visibility = "private";
    },
    (data) => {
      data.selected.pendingEvidence[0].artifact.publicUrl = "https://evil.invalid/private";
    },
    (data) => {
      data.selected.pendingEvidence[0].contribution.actorId = "102";
    },
    (data) => {
      data.selected.pendingEvidence[0].contribution.metricIds = ["pr_opened"];
    },
  ];
  for (const mutate of mutations) {
    const { input, app } = harness(t);
    mutate(input);
    const result = await app.inject(url);
    assert.ok([200, 503].includes(result.statusCode), result.body);
    if (result.statusCode === 200) assert.equal(alice(result.json()).pending.count, null);
    else assert.equal(result.json().error, "public_projection_unavailable");
  }
});
test("legacy, absent coverage and malformed pending counts cannot become measured zero", async (t) => {
  const { input, app } = harness(t);
  const row = input.selected.rows.find((row) => row.actorId === "101");
  delete row.pending;
  assert.equal(alice((await app.inject(url)).json()).pending, undefined);
  row.pending = {
    schemaVersion: "leaderboard-pending/v1",
    state: "measured",
    valueClass: "qualified",
    count: 0,
    evidenceIds: [],
  };
  assert.equal(alice((await app.inject(url)).json()).pending.count, null);
  for (const patch of [
    { schemaVersion: "leaderboard-pending/v999" },
    { count: -1 },
    { count: 10001 },
    { count: 3, evidenceIds: ["same", "same", "same"] },
    { state: "unknown", count: 0 },
  ])
    assert.equal(pendingCountSchema.safeParse({ ...row.pending, ...patch }).success, false);
  row.pending.count = 1;
  assert.equal((await app.inject(url)).statusCode, 503);
});

test("zero is measured only with complete bounded coverage, and pending dates obey exact scope", async (t) => {
  const start = "2026-10-16T00:00:00.000Z",
    end = "2026-10-18T00:00:00.000Z";
  const { input, app } = harness(t, end);
  input.selected.scope.start = start;
  input.selected.scope.end = end;
  const row = input.selected.rows.find((row) => row.actorId === "101");
  Object.assign(row.result.coverage, {
    state: "complete",
    windowStart: start,
    windowEnd: end,
    knownStart: start,
    sourceWatermark: end,
  });
  row.pending = {
    schemaVersion: "leaderboard-pending/v1",
    state: "measured",
    valueClass: "qualified",
    count: 0,
    evidenceIds: [],
  };
  const bounded = `${url}&start=${start}&end=${end}`;
  assert.equal(alice((await app.inject(bounded)).json()).pending.count, 0);
  row.pending = {
    ...row.pending,
    state: "partial",
    count: 3,
    evidenceIds: input.selected.pendingEvidence.map((entry) => entry.contribution.contributionId),
  };
  input.selected.pendingEvidence[0].occurredAt = end;
  assert.equal(alice((await app.inject(bounded)).json()).pending.count, null);
});

test("a sub-millisecond coverage start gap cannot certify measured pending zero", async (t) => {
  for (const field of ["knownStart", "windowStart"]) {
    const start = "2026-10-16T00:00:00.000Z",
      end = "2026-10-18T00:00:00.000Z";
    const { input, app } = harness(t, end);
    input.selected.scope.start = start;
    input.selected.scope.end = end;
    const row = input.selected.rows.find((row) => row.actorId === "101");
    Object.assign(row.result.coverage, {
      state: "complete",
      windowStart: start,
      windowEnd: end,
      knownStart: start,
      sourceWatermark: end,
    });
    row.pending = {
      schemaVersion: "leaderboard-pending/v1",
      state: "measured",
      valueClass: "qualified",
      count: 0,
      evidenceIds: [],
    };
    const bounded = `${url}&start=${start}&end=${end}`;
    assert.equal(alice((await app.inject(bounded)).json()).pending.count, 0);
    row.result.coverage[field] = "2026-10-15T20:00:00.0001-04:00";
    const response = await app.inject(bounded);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(alice(response.json()).pending.state, "unknown", field);
    assert.equal(alice(response.json()).pending.count, null, field);
  }
});
