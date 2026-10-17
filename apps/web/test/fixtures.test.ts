import assert from "node:assert/strict";
import test from "node:test";
import {
  actorSchema,
  contributionSchema,
  coverageSchema,
  metricResultSchema,
  sourceEventSchema,
} from "@pick-your-ai/contracts";
import { defaultScope, type Scope } from "../src/lib/scope.ts";
import { contributions, coverage, fixtureMetrics, people } from "../src/data/synthetic.ts";
import { getMetric } from "../src/data/registry.ts";
import {
  buildBoard,
  buildProfile,
  getContribution,
  listContributors,
  toContribution,
  toSourceEvent,
} from "../src/data/source.ts";

const latest = "syn-r42";
const scope = (overrides: Partial<Scope> = {}): Scope => ({ ...defaultScope, ...overrides });

test("fixture data is unmistakably synthetic", () => {
  for (const person of people) assert.match(person.login, /^synthetic-/);
  for (const record of contributions) {
    assert.match(record.id, /^syn-c-/);
    if (record.sourceUrl) assert.match(record.sourceUrl, /^https:\/\/synthetic\.example\//);
  }
});

test("fixture records map onto the v1 contracts", () => {
  for (const person of people) actorSchema.parse(person.actor);
  for (const entry of coverage) for (const item of entry.coverage) coverageSchema.parse(item);
  for (const record of contributions) {
    sourceEventSchema.parse(toSourceEvent(record));
    contributionSchema.parse(toContribution(record));
    for (const metricId of record.metricIds)
      assert.ok(getMetric(metricId), `${record.id} uses unknown metric ${metricId}`);
  }
  for (const metricId of Object.keys(fixtureMetrics)) assert.ok(getMetric(metricId), metricId);
});

test("board results satisfy the metric result contract", () => {
  for (const metricId of Object.keys(fixtureMetrics)) {
    const board = buildBoard(metricId, scope({ period: "all", actor: "all" }), latest)!;
    for (const row of board.rows) metricResultSchema.parse(row.result);
  }
});

test("accepted and pending values never share a rank numerator", () => {
  const board = buildBoard("pr_merged", scope(), latest)!;
  assert.ok(board.rows.every((row) => row.ranked.every((record) => record.evidence === "qualified")));
  const gale = board.pendingOnly.find((entry) => entry.person.login === "synthetic-gale");
  assert.ok(gale, "a newcomer with only pending work is listed but not ranked");
  assert.ok(!board.rows.some((row) => row.person.login === "synthetic-gale"));
});

test("ties use dense ranks and a newer snapshot can break them", () => {
  const r42 = buildBoard("prs_reviewed", scope(), "syn-r42")!;
  const top = r42.rows.filter((row) => row.rank === 1).map((row) => row.person.login);
  assert.deepEqual(top, ["synthetic-aster", "synthetic-dahlia"]);
  assert.ok(r42.rows.every((row, index) => index === 0 || row.rank - r42.rows[index - 1]!.rank <= 1));
  const r43 = buildBoard("prs_reviewed", scope(), "syn-r43")!;
  assert.equal(r43.rows[0]!.person.login, "synthetic-aster");
  assert.equal(r43.rows[0]!.tied, false);
});

test("a pinned snapshot ignores the latest snapshot", () => {
  const pinned = buildBoard("prs_reviewed", scope({ snapshot: "syn-r42" }), "syn-r43")!;
  assert.equal(pinned.snapshot.served.id, "syn-r42");
  assert.equal(pinned.rows[0]!.tied, true);
});

test("suppressed people are absent from every public surface", () => {
  const all = scope({ period: "all", actor: "all" });
  for (const metricId of Object.keys(fixtureMetrics)) {
    const board = buildBoard(metricId, all, latest)!;
    assert.ok(!board.rows.some((row) => row.person.login === "synthetic-hazel"));
  }
  assert.ok(!listContributors(all, latest).entries.some((entry) => entry.person.login === "synthetic-hazel"));
  assert.equal(buildProfile("synthetic-hazel", all, latest), null);
  assert.equal(getContribution("syn-c-052"), null);
});

test("automation is separate from user-account boards", () => {
  const users = buildBoard("labels_applied", scope(), latest)!;
  assert.ok(!users.rows.some((row) => row.person.actor.kind !== "user"));
  const automation = buildBoard("labels_applied", scope({ actor: "automation" }), latest)!;
  assert.deepEqual(
    automation.rows.map((row) => row.person.login),
    ["synthetic-ci-bot"],
  );
});

test("LOC excludes generated, vendor and lockfile lines", () => {
  const board = buildBoard("pr_lines_changed", scope(), latest)!;
  const elm = board.rows.find((row) => row.person.login === "synthetic-elm")!;
  assert.equal(elm.value, 84);
  assert.equal(elm.lines!.lockfile, 2900);
  assert.equal(elm.lines!.vendor, 1800);
});

test("a corrected exclusion is kept out of the value but stays inspectable", () => {
  const board = buildBoard("labels_applied", scope(), latest)!;
  const birch = board.rows.find((row) => row.person.login === "synthetic-birch")!;
  assert.equal(birch.value, 5);
  assert.equal(board.excluded.length, 1);
  assert.equal(board.excluded[0]!.corrections.length, 1);
});

test("true zero needs complete coverage; otherwise the board says why it is empty", () => {
  const complete = buildBoard("issues_opened", scope({ repos: ["syn-repo-research"] }), latest)!;
  assert.equal(complete.status, "empty_complete");
  const notMeasured = buildBoard("mentorship", scope(), latest)!;
  assert.equal(notMeasured.status, "not_measured");
  const partial = buildBoard("pr_merged", scope(), latest)!;
  assert.equal(partial.coverageState, "partial");
});

test("rebuilding serves the last good snapshot and failed snapshots raise", () => {
  const rebuilding = buildBoard("pr_merged", scope({ snapshot: "syn-r44-rebuilding" }), latest)!;
  assert.equal(rebuilding.snapshot.served.id, "syn-r42");
  assert.throws(() => buildBoard("pr_merged", scope({ snapshot: "syn-r45-failed" }), latest), /could not be read/);
});

test("the directory includes observed-only newcomers alphabetically", () => {
  const { entries } = listContributors(scope(), latest);
  const logins = entries.map((entry) => entry.person.login);
  assert.ok(logins.includes("synthetic-gale"));
  assert.deepEqual(logins, [...logins].sort());
});

test("a pinned contribution page cannot expose records first observed in a later snapshot", () => {
  assert.equal(getContribution("syn-c-009", "syn-r42"), null);
  assert.equal(getContribution("syn-c-016", "syn-r42"), null);
  assert.equal(getContribution("syn-c-009", "syn-r43")?.record.id, "syn-c-009");
  assert.equal(getContribution("syn-c-001", "syn-r41")?.record.id, "syn-c-001");
});
