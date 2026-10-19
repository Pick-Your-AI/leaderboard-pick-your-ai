import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../../service/dist/app.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";
import { profile, ReadFailure, selection } from "../src/remote/client.ts";

const selected = selection("?category=pr_merged&snapshot=synthetic-pending-1");
const allSelected = selection("?snapshot=synthetic-pending-1");

async function response(t, input = readFixture(), query = "category=pr_merged&snapshot=synthetic-pending-1") {
  const original = JSON.stringify(input);
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  const result = await app.inject({ method: "GET", url: `/api/v1/contributors/101?${query}` });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.stringify(input), original);
  return result.json();
}

function parseUnchanged(value, selected) {
  const original = JSON.stringify(value);
  try {
    return profile(value, selected);
  } finally {
    assert.equal(JSON.stringify(value), original);
  }
}

function rejects(value, selected, code) {
  assert.throws(
    () => parseUnchanged(value, selected),
    (error) => error instanceof ReadFailure && error.status === 502 && error.code === code,
  );
}

test("profile binds actual service timeline and results to its actor, category and snapshot", async (t) => {
  const parsed = parseUnchanged(await response(t), selected);
  assert.equal(parsed.actorId, "101");
  assert.equal(parsed.snapshotId, "synthetic-pending-1");
  assert.deepEqual(
    parsed.results.map((row) => row.metricId),
    ["pr_merged"],
  );
  assert.equal(parsed.timeline.length, 14);
  assert.ok(
    parsed.timeline.every(
      (row) => row.contribution.actorId === "101" && row.contribution.metricIds.includes("pr_merged"),
    ),
  );
  assert.ok(parsed.timeline.every((row) => row.activityState === "unknown" && row.observedAt === null));
  assert.deepEqual(parsed.categories, [{ metricId: "pr_merged", observed: 0, pending: 0, accepted: 0, unknown: 14 }]);
});

test("profile rejects foreign and missing actors at both timeline ends", async (t) => {
  const original = await response(t);
  for (const index of [0, original.timeline.length - 1]) {
    for (const actorId of ["102", null]) {
      const value = structuredClone(original);
      value.timeline[index].contribution.actorId = actorId;
      rejects(value, selected, "api_actor_mismatch");
    }
  }
});

test("profile rejects entries missing the selected category at both timeline ends", async (t) => {
  const original = await response(t);
  for (const index of [0, original.timeline.length - 1]) {
    for (const metricIds of [["pr_opened"], []]) {
      const value = structuredClone(original);
      value.timeline[index].contribution.metricIds = metricIds;
      rejects(value, selected, "api_filter_mismatch");
    }
  }
});

test("profile retains existing participation linkage before category binding", async (t) => {
  const value = await response(t);
  value.results[0].metricId = "pr_opened";
  rejects(value, selected, "invalid_participation_response");
});

test("profile preserves actual service overlapping categories without treating their sum as a score", async (t) => {
  const input = readFixture();
  input.selected.ranking.push({ metricId: "pr_opened", direction: "descending", rank: false });
  input.selected.evidence
    .find((entry) => entry.contribution.actorId === "101")
    .contribution.metricIds.push("pr_opened");
  const parsed = parseUnchanged(await response(t, input), selected);
  assert.ok(parsed.timeline.every((entry) => entry.contribution.metricIds.includes("pr_merged")));
  assert.ok(parsed.timeline.some((entry) => entry.contribution.metricIds.includes("pr_opened")));
  assert.deepEqual(parsed.categories, [
    { metricId: "pr_merged", observed: 0, pending: 0, accepted: 0, unknown: 14 },
    { metricId: "pr_opened", observed: 0, pending: 0, accepted: 0, unknown: 1 },
  ]);
});

test("profile preserves the actual service all-category path while enforcing the actor", async (t) => {
  const value = await response(t, readFixture(), "snapshot=synthetic-pending-1");
  assert.equal(value.category, null);
  assert.equal(parseUnchanged(value, allSelected).timeline.length, 14);
  value.timeline[0].contribution.actorId = "102";
  rejects(value, allSelected, "api_actor_mismatch");
});

test("profile preserves legacy unknown acceptance when the optional participation summary is absent", async (t) => {
  const value = await response(t);
  // Explicit compatibility projection: the current service does include this optional member.
  delete value.activitySummary;
  const parsed = parseUnchanged(value, selected);
  assert.equal(parsed.activitySummary, null);
  assert.ok(parsed.timeline.every((row) => row.activityState === "unknown"));
});

test("profile binds every legacy result metric without depending on the optional summary", async (t) => {
  const original = await response(t);
  delete original.activitySummary;
  for (const append of [false, true]) {
    const value = structuredClone(original);
    const foreign = { ...value.results[0], metricId: "pr_opened" };
    if (append) value.results.push(foreign);
    else value.results[0] = foreign;
    rejects(value, selected, "api_filter_mismatch");
  }
});
