import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";

const boardPath = "/api/v1/boards?metric=pr_merged";
const exportPath = "/api/v1/exports?metric=pr_merged&format=json";
const alice = (body) => body.rows.find((row) => row.actorId === "101");
const withSnapshot = (path, snapshot) =>
  snapshot === null ? path : `${path}${path.includes("?") ? "&" : "?"}snapshot=${snapshot}`;

function harness(t) {
  const input = readFixture();
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return input;
      },
    },
  });
  t.after(() => app.close());
  return { input, app };
}

for (const padded of [false, true]) {
  test(`${padded ? "padded" : "canonical"} pending IDs retain exact observation times on current and pinned API reads`, async (t) => {
    const { input, app } = harness(t);
    const times = ["2026-10-17T08:00:00.123456789-04:00", "2026-10-17T12:01:00.000Z", at];
    const expected = input.selected.pendingEvidence.map((entry, index) => {
      const contributionId = entry.contribution.contributionId;
      entry.observedAt = times[index];
      if (padded) entry.contribution.contributionId = ` \t${contributionId}\n `;
      return { contributionId, observedAt: times[index] };
    });
    const before = structuredClone(input);
    for (const snapshot of [null, input.head.snapshotId]) {
      const board = await app.inject(withSnapshot(boardPath, snapshot));
      assert.equal(board.statusCode, 200, board.body);
      const row = alice(board.json());
      assert.equal(row.result.value, 14);
      assert.equal(row.rank, 2);
      assert.equal(row.pending.count, 3);
      assert.deepEqual(
        row.pending.evidenceIds,
        expected.map((entry) => entry.contributionId),
      );
      for (const entry of expected) {
        const response = await app.inject(withSnapshot(`/api/v1/evidence/${entry.contributionId}`, snapshot));
        assert.equal(response.statusCode, 200, response.body);
        const detail = response.json();
        assert.equal(detail.contribution.contributionId, entry.contributionId);
        assert.equal(detail.activityState, "pending");
        assert.equal(detail.observedAt, entry.observedAt);
        assert.equal(detail.occurredAt, at);
      }
      const exported = await app.inject(withSnapshot(exportPath, snapshot));
      assert.equal(exported.statusCode, 200, exported.body);
      assert.deepEqual(alice(exported.json()).pending, row.pending);
      assert.deepEqual(
        exported.json().pendingEvidence.map((entry) => entry.evidenceId),
        expected.map((entry) => entry.contributionId).sort(),
      );
    }
    assert.deepEqual(input, before, "public reads must not rewrite the supplied contribution IDs or clocks");
  });
}

async function rejectsDuplicate(t, { first = false, padded = true, suppression = "none" } = {}) {
  const { input, app } = harness(t);
  const entry = input.selected.pendingEvidence[0];
  const paths = [
    boardPath,
    "/api/v1/contributors",
    "/api/v1/contributors/101",
    `/api/v1/evidence/${entry.contribution.contributionId}`,
    exportPath,
    "/api/v1/exports?metric=pr_merged&format=csv",
  ];
  const requests = [];
  for (const snapshot of [null, input.head.snapshotId]) {
    for (const path of paths) {
      const url = withSnapshot(path, snapshot);
      const previous = await app.inject(url);
      assert.equal(previous.statusCode, 200, url);
      assert.ok(previous.headers.etag, url);
      requests.push({ url, etag: previous.headers.etag });
    }
  }
  const duplicate = structuredClone(entry);
  if (padded) duplicate.contribution.contributionId = ` \t${entry.contribution.contributionId}\n `;
  duplicate.observedAt = "2026-10-17T12:01:00.000Z";
  if (first) input.selected.pendingEvidence.unshift(duplicate);
  else input.selected.pendingEvidence.push(duplicate);
  if (suppression === "actor") input.controls.suppressedActorIds.push(entry.contribution.actorId);
  if (suppression === "artifact") input.controls.suppressedArtifactIds.push(entry.artifact.stableId);
  if (suppression !== "none") input.controls.version = "synthetic-controls-2";
  const before = structuredClone(input);
  const responses = [];
  for (const { url, etag } of requests) {
    const response = await app.inject({ url, headers: { "if-none-match": etag } });
    responses.push({
      url,
      statusCode: response.statusCode,
      body: response.body,
      cacheControl: response.headers["cache-control"],
    });
  }
  assert.deepEqual(input, before, "rejecting ambiguous input must not mutate it");
  assert.deepEqual(
    responses.map(({ url, statusCode }) => ({ url, statusCode })),
    requests.map(({ url }) => ({ url, statusCode: 503 })),
  );
  for (const response of responses) {
    assert.deepEqual(JSON.parse(response.body), { error: "public_projection_unavailable" }, response.url);
    assert.equal(response.cacheControl, "no-store", response.url);
  }
}

test("exact duplicate pending IDs still reject current and pinned conditional reads", async (t) => {
  await rejectsDuplicate(t, { padded: false });
});

for (const suppression of ["none", "actor", "artifact"]) {
  for (const first of [false, true]) {
    test(`canonical duplicate pending IDs reject before ${suppression} suppression with the padded copy ${first ? "first" : "last"}`, async (t) => {
      await rejectsDuplicate(t, { first, suppression });
    });
  }
}

test("a unique padded pending ID remains suppressible without rejecting unrelated accepted work", async (t) => {
  const { input, app } = harness(t);
  const removed = input.selected.pendingEvidence[0];
  const contributionId = removed.contribution.contributionId;
  removed.contribution.contributionId = ` ${contributionId} `;
  input.controls.suppressedArtifactIds.push(removed.artifact.stableId);
  for (const snapshot of [null, input.head.snapshotId]) {
    const response = await app.inject(withSnapshot(boardPath, snapshot));
    assert.equal(response.statusCode, 200, response.body);
    const row = alice(response.json());
    assert.equal(row.result.value, 14);
    assert.equal(row.rank, 2);
    assert.equal(row.pending.state, "unknown");
    assert.equal(row.pending.count, null);
    assert.deepEqual(row.pending.evidenceIds, []);
    const detail = await app.inject(withSnapshot(`/api/v1/evidence/${contributionId}`, snapshot));
    assert.equal(detail.statusCode, 404);
    const exported = await app.inject(withSnapshot(exportPath, snapshot));
    assert.equal(exported.statusCode, 200, exported.body);
    assert.deepEqual(exported.json().pendingEvidence, []);
    assert.equal(exported.body.includes(contributionId), false);
  }
});
