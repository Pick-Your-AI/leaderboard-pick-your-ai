import test from "node:test";
import assert from "node:assert/strict";
import { selection, request, ReadFailure } from "../src/remote/client.ts";
import { achievements, cardHref, recognitionParameters, spotlights } from "../src/remote/recognition-client.ts";
const at = "2026-10-17T12:00:00.000Z";
const historyStart = "2026-10-01T00:00:00.000Z";
const completeCoverage = () => ({
  schemaVersion: "leaderboard/v1",
  state: "complete",
  source: "github_rest",
  scopeId: "synthetic-recognition-scope",
  windowStart: historyStart,
  windowEnd: at,
  knownStart: historyStart,
  lastSuccessfulSync: at,
  sourceWatermark: at,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
});
const selected = selection(
  "?organization=Pick-Your-AI&snapshot=public-1&repository=repo-1&metric=pr_opened&search=alice&category=pr_opened&cursor=old.signature",
);
const fixture = () => ({
  schemaVersion: "leaderboard/v1",
  snapshotId: "public-1",
  revision: 1,
  generatedAt: at,
  metricDefinitionVersion: "v1",
  computationVersion: "v1",
  policyVersion: "v1",
  head: { snapshotId: "public-1", revision: 1, publishedAt: at },
  coverage: [completeCoverage()],
  scope: { organization: "Pick-Your-AI", repository: "repo-1", workstream: null, start: null, end: null },
  actorId: "alice",
  ruleVersion: "accepted-evidence/v1",
  achievements: [
    {
      id: "first-accepted-in-scope",
      label: "First accepted in scope",
      ruleVersion: "accepted-evidence/v1",
      dateBasis: "proven_source_occurrence_in_selected_scope",
      scopeMeaning: "Available scope only",
      occurredAt: at,
      evidenceIds: ["e1"],
      artifactIds: ["a1"],
      sourceUrls: ["https://github.com/synthetic/example/issues/1"],
      sharedCredit: false,
    },
  ],
});

test("sharing pins exact approved scope and drops directory/cursor filters", () => {
  const params = recognitionParameters(selected, "public-1");
  assert.equal(params.get("snapshot"), "public-1");
  assert.equal(params.get("repository"), "repo-1");
  for (const key of ["cursor", "category", "search", "metric"]) assert.equal(params.get(key), null);
  const url = new URL(cardHref("https://example.test/api/v1", selected, "public-1", "alice", "pr_opened"));
  assert.equal(url.pathname, "/api/v1/cards/alice");
  assert.equal(url.searchParams.get("metric"), "pr_opened");
  assert.throws(() => recognitionParameters(selected, "public-2"));
  assert.throws(() => cardHref("https://example.test/api/v1", selected, "public-1", "../private", "pr_opened"));
});

test("achievement parser rejects scope, snapshot, identity, policy, unsafe links and missing evidence", () => {
  assert.equal(achievements(fixture(), selected, "alice").achievements.length, 1);
  for (const change of [
    (value) => (value.scope.repository = "other"),
    (value) => (value.snapshotId = "public-2"),
    (value) => (value.actorId = "bob"),
    (value) => (value.ruleVersion = "invented"),
    (value) => (value.achievements[0].sourceUrls = ["javascript:alert(1)"]),
    (value) => (value.achievements[0].sourceUrls = ["https://github.com/synthetic/example/issues/1?secret=1"]),
    (value) => (value.achievements[0].evidenceIds = []),
    (value) => (value.achievements[0].occurredAt = "yesterday"),
    (value) => value.achievements.push(value.achievements[0]),
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => achievements(value, selected, "alice"));
  }
  const value = fixture();
  value.secret = "private";
  value.achievements[0].reviewer = "private";
  assert.doesNotMatch(JSON.stringify(achievements(value, selected, "alice")), /private/);
});

test("editorial parser allowlists current public selection fields", () => {
  const value = {
    ruleVersion: "reviewed-opt-in/v1",
    ordering: "round-robin-category-oldest-selection-first",
    spotlights: [
      {
        id: "nomination-1",
        actorId: "alice",
        claimId: "claim-1",
        ruleVersion: "reviewed-opt-in/v1",
        sourceUrl: "https://github.com/synthetic/example/issues/1",
        category: "governance",
        selectionExplanation: "Public explanation",
        selectedAt: at,
        bio: null,
        reason: "Private audit",
      },
    ],
  };
  assert.doesNotMatch(JSON.stringify(spotlights(value)), /Private audit/);
  value.spotlights[0].sourceUrl = "https://private.example.test/work";
  assert.throws(() => spotlights(value));
});

test("unapproved achievements fail without retry or synthetic fallback", async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "achievement_policy_unapproved" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };
  await assert.rejects(
    request(
      "https://example.test/api/v1",
      "contributors/alice/achievements",
      recognitionParameters(selected, "public-1"),
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 1);
});

test("supplied awards require complete history for every returned source partition", () => {
  for (const coverage of [
    [],
    ...["partial", "unknown", "unavailable"].map((state) => [{ ...completeCoverage(), state }]),
    [completeCoverage(), { ...completeCoverage(), scopeId: "synthetic-second-source", state: "partial" }],
  ]) {
    const value = fixture();
    value.coverage = coverage;
    assert.throws(
      () => achievements(value, selected, "alice"),
      (error) => error instanceof ReadFailure && error.status === 502 && error.code === "invalid_recognition_response",
    );
    value.achievements = [];
    assert.deepEqual(achievements(value, selected, "alice").achievements, []);
  }
});

test("awards cannot claim an earliest event with missing coverage bounds or an unknown history start", () => {
  for (const field of ["windowStart", "windowEnd", "sourceWatermark", "knownStart"]) {
    const value = fixture();
    value.coverage[0][field] = null;
    assert.throws(
      () => achievements(value, selected, "alice"),
      {
        status: 502,
        code: "invalid_recognition_response",
      },
      field,
    );
  }
});

test("all-history awards reject even a fractional gap before the retained coverage begins", () => {
  const value = fixture();
  value.coverage[0].windowStart = "2026-10-01T00:00:00.0001Z";
  assert.throws(() => achievements(value, selected, "alice"), {
    status: 502,
    code: "invalid_recognition_response",
  });
});

test("awards require both collection bounds to cover the exact fractional snapshot cutoff", () => {
  for (const field of ["windowEnd", "sourceWatermark"]) {
    const value = fixture();
    value.generatedAt = "2026-10-17T12:00:00.0009Z";
    value.head.publishedAt = value.generatedAt;
    value.coverage[0].windowEnd = "2026-10-17T12:00:00.001Z";
    value.coverage[0].sourceWatermark = "2026-10-17T12:00:00.001Z";
    value.coverage[0][field] = "2026-10-17T08:00:00.0001-04:00";
    assert.throws(
      () => achievements(value, selected, "alice"),
      {
        status: 502,
        code: "invalid_recognition_response",
      },
      field,
    );
  }
});

function periodFixture() {
  const value = fixture();
  value.scope.start = "2026-10-17T10:00:00.000Z";
  value.scope.end = at;
  value.achievements[0].occurredAt = "2026-10-17T11:00:00.000Z";
  value.coverage[0].windowStart = value.scope.start;
  value.coverage[0].knownStart = null;
  const period = { ...selected, start: value.scope.start, end: value.scope.end };
  return { value, period };
}

test("period awards require the entire selected window, including sub-millisecond coverage gaps", () => {
  for (const [field, instant] of [
    ["windowStart", "2026-10-17T10:00:00.0001Z"],
    ["windowEnd", "2026-10-17T11:59:59.9999Z"],
    ["sourceWatermark", "2026-10-17T11:59:59.9999Z"],
  ]) {
    const { value, period } = periodFixture();
    value.coverage[0][field] = instant;
    assert.throws(
      () => achievements(value, period, "alice"),
      {
        status: 502,
        code: "invalid_recognition_response",
      },
      field,
    );
  }
});

test("equivalent source offsets and fractional encodings preserve fully covered awards", () => {
  const value = fixture();
  value.generatedAt = "2026-10-17T12:00:00.0009Z";
  value.head.publishedAt = value.generatedAt;
  value.coverage[0].knownStart = "2026-10-01T04:00:00+04:00";
  value.coverage[0].windowEnd = "2026-10-17T08:00:00.00090-04:00";
  value.coverage[0].sourceWatermark = "2026-10-17T14:00:00.000900+02:00";
  const result = achievements(value, selected, "alice");
  assert.deepEqual(result.achievements[0].evidenceIds, ["e1"]);
  assert.equal(result.achievements[0].occurredAt, at);
});

test("period awards need selected-period coverage without requiring organization history or a later cutoff", () => {
  const { value, period } = periodFixture();
  value.generatedAt = "2026-10-18T12:00:00.000Z";
  value.head.publishedAt = value.generatedAt;
  const result = achievements(value, period, "alice");
  assert.equal(result.achievements.length, 1);
  assert.equal(result.achievements[0].occurredAt, "2026-10-17T11:00:00.000Z");
});
