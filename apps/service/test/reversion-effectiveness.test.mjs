// Synthetic projection and provider fixtures, never host review or source authority.
import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { readFixture, at } from "../../../tests/fixtures/pending-metric.mjs";
import { createRankComparisonHarness } from "../../../tests/fixtures/rank-comparison.mjs";

function fixture() {
  const input = readFixture();
  const target = input.selected.evidence[0];
  const raw = {
    ...structuredClone(target),
    activityState: "observed",
    observedAt: at,
  };
  Object.assign(raw.contribution, {
    contributionId: "synthetic-observed-original-merge",
    canonicalEventId: "synthetic-observed-original-event",
  });
  const collaborator = structuredClone(raw);
  Object.assign(collaborator.contribution, {
    contributionId: "synthetic-separate-collaborator-unit",
    actorId: "102",
    roles: ["coauthor"],
  });
  input.selected.portfolioEvidence = [
    ...input.selected.evidence.map((entry) => ({
      ...structuredClone(entry),
      activityState: "accepted",
      observedAt: at,
    })),
    ...structuredClone(input.selected.pendingEvidence),
    raw,
    collaborator,
  ];
  return { input, target, raw, collaborator };
}

const project = (input) => projectRead(input, input.selected.scope, null);
const ids = (entries) => entries.map((entry) => entry.contribution.contributionId);
function unavailable(response, code = "public_projection_unavailable") {
  assert.equal(response.statusCode, 503, response.body);
  assert.deepEqual(response.json(), { error: code });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.etag, undefined);
}
function service(t, input) {
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  return app;
}
function comparison(t) {
  const h = createRankComparisonHarness();
  t.after(() => h.app.close());
  return {
    ...h,
    urls: [
      `/api/v1/boards?${h.params}`,
      `/api/v1/exports?${h.params}&format=json`,
      `/api/v1/exports?${h.params}&format=csv`,
    ],
  };
}

test("contribution suppression preserves the exact legacy projection when absent or empty", () => {
  const { input } = fixture();
  const before = structuredClone(input);
  const legacy = project(input);
  input.controls.suppressedContributionIds = [];
  assert.deepEqual(project(input), legacy);
  assert.equal(Object.hasOwn(legacy.controls, "suppressedContributionIds"), false);
  delete input.controls.suppressedContributionIds;
  assert.deepEqual(input, before);
});

test("one withdrawn qualified unit withholds its whole aggregate but retains raw merge and collaborator proof", () => {
  const { input, target, raw, collaborator } = fixture();
  const baseline = project(input);
  const before = structuredClone(input);
  input.controls.suppressedContributionIds = [target.contribution.contributionId, "synthetic-private-control-only"];
  const projected = project(input);
  assert.deepEqual(
    projected.selected.rows,
    baseline.selected.rows.filter((row) => row.actorId !== target.contribution.actorId),
  );
  assert.equal(projected.selected.rows.find((row) => row.actorId === "102").result.value, 15);
  assert.equal(
    projected.selected.diagnostics.some((entry) => entry.actorId === "101"),
    false,
  );
  for (const collection of ["evidence", "portfolioEvidence", "pendingEvidence"])
    assert.equal(ids(projected.selected[collection]).includes(target.contribution.contributionId), false);
  for (const retained of [raw, collaborator]) {
    const actual = projected.selected.portfolioEvidence.find(
      (entry) => entry.contribution.contributionId === retained.contribution.contributionId,
    );
    assert.ok(actual);
    assert.deepEqual(actual.artifact, retained.artifact);
    assert.equal(actual.contribution.actorId, retained.contribution.actorId);
    assert.equal(actual.activityState, "observed");
    assert.equal(actual.occurredAt, retained.occurredAt);
  }
  assert.equal(Object.hasOwn(projected.controls, "suppressedContributionIds"), false);
  assert.doesNotMatch(JSON.stringify(projected), /synthetic-private-control-only/);
  delete input.controls.suppressedContributionIds;
  assert.deepEqual(input, before);
});

test("withdrawing a pending proof keeps accepted values and makes the dependent pending count unknown", () => {
  const { input } = fixture();
  const pendingId = input.selected.pendingEvidence[0].contribution.contributionId;
  const baseline = project(input);
  input.controls.suppressedContributionIds = [pendingId];
  const projected = project(input);
  assert.deepEqual(
    projected.selected.rows.map((row) => [row.actorId, row.result]),
    baseline.selected.rows.map((row) => [row.actorId, row.result]),
  );
  const row = projected.selected.rows.find((entry) => entry.actorId === "101");
  assert.deepEqual(row.pending, {
    schemaVersion: "leaderboard-pending/v1",
    state: "unknown",
    valueClass: "qualified",
    count: null,
    evidenceIds: [],
  });
  assert.deepEqual(projected.selected.diagnostics.find((entry) => entry.actorId === "101").pending, row.pending);
  assert.equal(ids(projected.selected.portfolioEvidence).includes(pendingId), false);
  assert.equal(ids(projected.selected.pendingEvidence).includes(pendingId), false);
});

test("contribution withdrawal matches contract-normalized proof IDs without normalizing control identities", () => {
  const input = readFixture();
  const target = input.selected.evidence[0];
  const targetId = target.contribution.contributionId;
  target.contribution.contributionId = ` \t${targetId}\n `;
  input.controls.suppressedContributionIds = [targetId];
  const projected = project(input);
  assert.equal(ids(projected.selected.evidence).includes(targetId), false);
  assert.equal(
    projected.selected.rows.some((row) => row.actorId === target.contribution.actorId),
    false,
  );
});

const malformedSets = [
  ["explicit undefined", () => undefined],
  ["null", () => null],
  ["string", () => "synthetic-101-0"],
  ["object", () => ({ id: "synthetic-101-0" })],
  ["non-string member", () => [null]],
  ["empty identity", () => [""]],
  ["leading whitespace", () => [" synthetic-101-0"]],
  ["terminal newline", () => ["synthetic-101-0\n"]],
  ["oversized identity", () => ["x".repeat(201)]],
  ["duplicate identity", () => ["synthetic-101-0", "synthetic-101-0"]],
  ["sparse array", () => new Array(1)],
  ["oversized set", () => Array.from({ length: 20001 }, (_, index) => `synthetic-withdrawn-${index}`)],
];

test("a present contribution suppression set is exact, unique and bounded before projection", () => {
  for (const [name, value] of malformedSets) {
    const input = readFixture();
    input.controls.suppressedContributionIds = value();
    assert.throws(() => project(input), { status: 503, code: "public_projection_unavailable" }, name);
  }
  const input = readFixture();
  const baseline = project(input);
  input.controls.suppressedContributionIds = Array.from({ length: 20000 }, (_, index) => `synthetic-absent-${index}`);
  assert.deepEqual(project(input), baseline);
});

for (const collection of ["evidence", "portfolioEvidence", "pendingEvidence"])
  test(`withdrawn units cannot hide a malformed or contradictory ${collection} copy`, async (t) => {
    const { input, target } = fixture();
    input.controls.suppressedContributionIds = [target.contribution.contributionId];
    const app = service(t, input);
    assert.equal((await app.inject("/api/v1/boards?metric=pr_merged")).statusCode, 200);
    if (collection === "evidence") target.occurredAt = "not-a-source-time";
    else if (collection === "portfolioEvidence") input.selected.portfolioEvidence[0].contribution.actorId = "102";
    else
      input.selected.pendingEvidence.push({
        ...structuredClone(target),
        activityState: "pending",
        observedAt: at,
        contribution: { ...structuredClone(target.contribution), actorId: "102" },
      });
    unavailable(await app.inject("/api/v1/boards?metric=pr_merged"));
  });

test("current and pinned HTTP reads apply exact withdrawal before conditional reuse without exposing controls", async (t) => {
  const { input, target, raw } = fixture();
  const app = service(t, input);
  const paths = [
    "/api/v1/boards?metric=pr_merged",
    `/api/v1/evidence/${target.contribution.contributionId}`,
    "/api/v1/exports?metric=pr_merged&format=json",
    "/api/v1/exports?metric=pr_merged&format=csv",
  ].flatMap((path) => [path, `${path}${path.includes("?") ? "&" : "?"}snapshot=${input.head.snapshotId}`]);
  const before = new Map();
  for (const url of paths) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.ok(response.headers.etag, url);
    before.set(url, response.headers.etag);
  }
  // Do not rely on a provider version bump to erase already-visible content.
  input.controls.suppressedContributionIds = [target.contribution.contributionId];
  for (const [url, etag] of before) {
    const response = await app.inject({ url, headers: { "if-none-match": etag } });
    assert.equal(response.statusCode, url.includes("/evidence/") ? 404 : 200, `${url}: ${response.body}`);
    assert.doesNotMatch(response.body, /suppressedContributionIds/);
    if (response.statusCode === 200 && !url.includes("format=csv"))
      assert.deepEqual(
        response.json().rows.map((row) => row.actorId),
        ["102"],
      );
    if (url.includes("format=csv")) assert.doesNotMatch(response.body, /synthetic-pending-101/);
  }
  const rawResponse = await app.inject(`/api/v1/evidence/${raw.contribution.contributionId}`);
  assert.equal(rawResponse.statusCode, 200, rawResponse.body);
  assert.equal(rawResponse.json().artifact.stableId, target.artifact.stableId);
  assert.equal(rawResponse.json().occurredAt, raw.occurredAt);
});

test("an empty restored-unit control cannot override legacy whole-artifact suppression", () => {
  const { input, target, raw } = fixture();
  input.controls.suppressedContributionIds = [];
  input.controls.suppressedArtifactIds = [target.artifact.stableId];
  const projected = project(input);
  assert.equal(ids(projected.selected.portfolioEvidence).includes(raw.contribution.contributionId), false);
  assert.equal(
    projected.selected.rows.some((row) => row.actorId === "101"),
    false,
  );
  assert.equal(projected.selected.rows.find((row) => row.actorId === "102").result.value, 15);
});

test("a custom paired provider cannot hide different contribution withdrawal behind equal legacy authority", async (t) => {
  const h = comparison(t);
  for (const url of h.urls) assert.equal((await h.app.inject(url)).statusCode, 200, url);
  h.pair.current.controls.suppressedContributionIds = [];
  h.pair.previous.controls.suppressedContributionIds = [
    h.pair.previous.selected.evidence[0].contribution.contributionId,
  ];
  for (const url of h.urls) unavailable(await h.app.inject(url), "public_comparison_authority_changed");
});

test("paired contribution controls admit absent versus empty and equivalent set order without mutating inputs", async (t) => {
  const h = comparison(t);
  const baseline = await h.app.inject(h.urls[0]);
  assert.equal(baseline.statusCode, 200, baseline.body);
  h.pair.previous.controls.suppressedContributionIds = [];
  assert.deepEqual((await h.app.inject(h.urls[0])).json(), baseline.json());
  h.pair.current.controls.suppressedContributionIds = ["synthetic-absent-b", "synthetic-absent-a"];
  h.pair.previous.controls.suppressedContributionIds = ["synthetic-absent-a", "synthetic-absent-b"];
  const before = structuredClone(h.pair);
  for (const url of h.urls) assert.equal((await h.app.inject(url)).statusCode, 200, url);
  assert.deepEqual(h.pair, before);
});

test("malformed paired contribution authority cannot be downgraded to unavailable history", async (t) => {
  const h = comparison(t);
  assert.equal((await h.app.inject(h.urls[0])).statusCode, 200);
  for (const [name, value] of malformedSets) {
    h.pair.previous.controls.suppressedContributionIds = value();
    unavailable(await h.app.inject(h.urls[0]));
    delete h.pair.previous.controls.suppressedContributionIds;
    assert.equal((await h.app.inject(h.urls[0])).statusCode, 200, name);
  }
});

test("an explicitly unavailable restoration baseline preserves current values with unavailable movement", async (t) => {
  const h = comparison(t);
  h.pair.current.controls.suppressedContributionIds = [];
  const baseline = await h.app.inject(h.urls[0]);
  assert.equal(baseline.statusCode, 200, baseline.body);
  h.pair.previous = null;
  h.pair.previousHistory = null;
  for (const url of h.urls.slice(0, 2)) {
    const response = await h.app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().comparison, { snapshotId: null, scope: null, generatedAt: null });
    assert.deepEqual(
      response.json().rows.map((row) => [row.actorId, row.result.value]),
      baseline.json().rows.map((row) => [row.actorId, row.result.value]),
    );
    assert.ok(response.json().rows.every((row) => row.movement.state === "unavailable" && row.movement.delta === null));
    assert.ok(response.json().rows.every((row) => row.movement.reason === "comparison_unavailable"));
  }
});
