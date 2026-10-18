// Synthetic publication inputs only; these tests establish no live source authority.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPublicScope, publicScopeParameters } from "@pick-your-ai/contracts";
import { createService } from "../dist/app.js";
import { board, selection, validateExport } from "../../web/src/remote/client.ts";
import { parseCSVExport } from "../../web/src/remote/csv-export.ts";
import { readFixture } from "../../../tests/fixtures/pending-metric.mjs";

const start = "2026-10-16T00:00:00.000Z";
const end = "2026-10-18T00:00:00.000Z";
const publishedAt = "2026-10-18T02:00:00.000Z";
const query = `metric=pr_merged&start=${start}&end=${end}`;
const alice = (body) => body.rows.find((row) => row.actorId === "101");

function fixture(count, sourceWatermark) {
  const input = readFixture();
  Object.assign(input.selected.scope, { start, end });
  input.head.publishedAt = publishedAt;
  input.selected.snapshot.generatedAt = publishedAt;
  const row = alice(input.selected);
  Object.assign(row.result.coverage, {
    state: "complete",
    windowStart: start,
    windowEnd: end,
    knownStart: start,
    lastSuccessfulSync: publishedAt,
    sourceWatermark,
  });
  if (count === 0) input.selected.pendingEvidence = [];
  row.pending = {
    schemaVersion: "leaderboard-pending/v1",
    valueClass: "qualified",
    state: "measured",
    count,
    evidenceIds: input.selected.pendingEvidence.map((entry) => entry.contribution.contributionId),
  };
  input.selected.diagnostics.find((entry) => entry.actorId === "101").pending = row.pending;
  return input;
}

function harness(t, input) {
  const app = createService({
    now: () => Date.parse(publishedAt),
    source: {
      async read(scope, pin) {
        assert.deepEqual(scope, input.selected.scope);
        assert.ok(pin === null || pin === input.selected.snapshot.snapshotId);
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  return app;
}

function expectedPending(input, complete) {
  const pending = alice(input.selected).pending;
  return complete
    ? pending
    : pending.count === 0
      ? { ...pending, state: "unknown", count: null, evidenceIds: [] }
      : { ...pending, state: "partial" };
}

function assertRow(body, pending) {
  const row = alice(body);
  assert.equal(row.result.value, 14);
  assert.equal(row.evidenceIds.length, 14);
  assert.equal(row.rank, 2); // Fifteen accepted units stay ahead of fourteen plus pending work.
  assert.deepEqual(row.pending, pending);
}

const watermarks = [
  ["absent", null, false],
  ["twelve hours short", "2026-10-17T12:00:00.000Z", false],
  ["one nanosecond short", "2026-10-17T23:59:59.999999999Z", false],
  ["exact endpoint", end, true],
  ["equivalent offset endpoint", "2026-10-17T19:00:00.000000000-05:00", true],
  ["past the endpoint", "2026-10-17T23:00:00.000-02:00", true],
];
for (const [name, watermark, complete] of watermarks)
  for (const count of [0, 3])
    test(`${name} watermark projects pending ${count} consistently through current, pinned and export reads`, async (t) => {
      const input = fixture(count, watermark);
      const original = structuredClone(input);
      const app = harness(t, input);
      const expected = expectedPending(input, complete);
      const snapshot = input.selected.snapshot.snapshotId;
      const exportSelection = selection(`?${query}&snapshot=${snapshot}`);
      for (const pin of ["", `&snapshot=${snapshot}`]) {
        const selected = selection(`?${query}${pin}`);
        const response = await app.inject(`/api/v1/boards?${query}${pin}`);
        assert.equal(response.statusCode, 200, response.body);
        const result = response.json();
        assertRow(result, expected);
        assertRow(board(result, selected), expected);
        assert.deepEqual(result.diagnostics.find((entry) => entry.actorId === "101").pending, expected);
        const exported = await app.inject(`/api/v1/exports?${query}${pin}&format=json`);
        assert.equal(exported.statusCode, 200, exported.body);
        const json = exported.json();
        validateExport(json, exportSelection, result.metric);
        assertRow(json, expected);
        assert.deepEqual(json.diagnostics.find((entry) => entry.actorId === "101").pending, expected);
        assert.deepEqual(
          json.pendingEvidence.map((entry) => entry.evidenceId).sort(),
          [...expected.evidenceIds].sort(),
        );
        const csv = await app.inject(`/api/v1/exports?${query}${pin}&format=csv`);
        assert.equal(csv.statusCode, 200, csv.body);
        const parsed = parseCSVExport(csv.body, result.metric, 100);
        validateExport(parsed, exportSelection, result.metric);
        assertRow(parsed, expected);
        assert.deepEqual(parsed.pendingEvidence, json.pendingEvidence);
      }
      assert.deepEqual(input, original, "projection must not rewrite frozen publication input");
    });

test("a complete watermark cannot rescue incomplete source bounds or known collection gaps", async (t) => {
  const changes = [
    ["unknown origin", { knownStart: null }],
    ["late origin", { knownStart: "2026-10-15T20:00:00.0001-04:00" }],
    ["unknown start", { windowStart: null }],
    ["late start", { windowStart: "2026-10-15T20:00:00.0001-04:00" }],
    ["unknown end", { windowEnd: null }],
    ["short end", { windowEnd: "2026-10-17T23:59:59.999999999Z" }],
    ["partial state", { state: "partial" }],
    ["unknown state", { state: "unknown" }],
    ["missing page", { state: "partial", missingPages: 1 }],
    ["missing permission", { state: "partial", permissionsMissing: ["synthetic-permission"] }],
    ["source error", { state: "partial", sourceErrors: ["synthetic-source-error"] }],
  ];
  for (const [name, patch] of changes)
    for (const count of [0, 3]) {
      const input = fixture(count, end);
      Object.assign(alice(input.selected).result.coverage, patch);
      const app = harness(t, input);
      const response = await app.inject(`/api/v1/boards?${query}`);
      assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
      assertRow(response.json(), expectedPending(input, false));
    }
});

test("missing and malformed watermark fields reject publication rather than certifying pending counts", async (t) => {
  for (const watermark of [undefined, "not-a-time", "2026-10-18T00:00:00", 0])
    for (const count of [0, 3]) {
      const input = fixture(count, watermark);
      if (watermark === undefined) delete alice(input.selected).result.coverage.sourceWatermark;
      const app = harness(t, input);
      for (const route of ["boards", "exports"])
        for (const pin of ["", `&snapshot=${input.head.snapshotId}`]) {
          const response = await app.inject(`/api/v1/${route}?${query}${pin}`);
          assert.equal(response.statusCode, 503, response.body);
          assert.equal(response.json().error, "public_projection_unavailable");
        }
    }
});

test("a newer incomplete publication invalidates measured validators and preserves the older complete pin", async (t) => {
  for (const count of [0, 3]) {
    const prior = fixture(count, end);
    const next = fixture(count, null);
    Object.assign(next.head, { snapshotId: "synthetic-pending-2", revision: 2 });
    Object.assign(next.selected.snapshot, { snapshotId: "synthetic-pending-2", revision: 2 });
    let current = prior;
    const app = createService({
      now: () => Date.parse(publishedAt),
      source: {
        async read(scope, pin) {
          assert.deepEqual(scope, prior.selected.scope);
          const selected = pin === prior.head.snapshotId ? prior.selected : current.selected;
          return structuredClone({ head: current.head, controls: current.controls, selected });
        },
      },
    });
    t.after(() => app.close());
    for (const route of ["boards", "exports"]) {
      current = prior;
      const response = await app.inject(`/api/v1/${route}?${query}`);
      assert.equal(response.statusCode, 200, response.body);
      assertRow(response.json(), expectedPending(prior, true));
      const etag = response.headers.etag;
      assert.ok(etag);
      current = next;
      const changed = await app.inject({
        url: `/api/v1/${route}?${query}`,
        headers: { "if-none-match": etag },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.notEqual(changed.headers.etag, etag);
      assert.equal(changed.json().snapshotId, next.head.snapshotId);
      assertRow(changed.json(), expectedPending(next, false));
      const pinned = await app.inject(`/api/v1/${route}?${query}&snapshot=${prior.head.snapshotId}`);
      assert.equal(pinned.statusCode, 200, pinned.body);
      assert.equal(pinned.json().snapshotId, prior.head.snapshotId);
      assertRow(pinned.json(), expectedPending(prior, true));
    }
  }
});

test("versioned current and Project scopes retain corrected pending counts in both export formats", async (t) => {
  for (const membership of [
    { context: "current", projects: [] },
    { context: "current", projects: ["PVT_B=", "PVT_A"] },
    { context: "event", projects: ["PVT_A"] },
  ])
    for (const watermark of [null, "2026-10-17T23:59:59.999999999Z", end])
      for (const count of [0, 3]) {
        const input = fixture(count, watermark);
        const scope = canonicalPublicScope({ ...input.selected.scope, ...membership });
        input.selected.scope = scope;
        const original = structuredClone(input);
        const app = harness(t, input);
        const expected = expectedPending(input, watermark === end);
        for (const pin of [null, input.head.snapshotId]) {
          const params = new URLSearchParams({ ...publicScopeParameters(scope), metric: "pr_merged" });
          if (pin !== null) params.set("snapshot", pin);
          const response = await app.inject(`/api/v1/boards?${params}`);
          assert.equal(response.statusCode, 200, response.body);
          const result = response.json();
          assert.equal(result.schemaVersion, "public-read/v2");
          assert.deepEqual(result.scope, scope);
          assertRow(result, expected);
          assert.deepEqual(result.diagnostics.find((entry) => entry.actorId === "101").pending, expected);
          const exported = await app.inject(`/api/v1/exports?${params}&format=json`);
          assert.equal(exported.statusCode, 200, exported.body);
          const json = exported.json();
          assert.equal(json.exportSchemaVersion, "public-export/v2");
          assert.deepEqual(json.scope, scope);
          assertRow(json, expected);
          assert.deepEqual(json.diagnostics.find((entry) => entry.actorId === "101").pending, expected);
          const csv = await app.inject(`/api/v1/exports?${params}&format=csv`);
          assert.equal(csv.statusCode, 200, csv.body);
          // These fictional fields contain no line breaks. Read the quoted v2
          // records independently of the separately owned browser v2 integration.
          const [header, ...rows] = csv.body
            .trimEnd()
            .split("\r\n")
            .map((line) =>
              [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"')),
            );
          const field = (row, key) => row[header.indexOf(key)];
          assert.equal(rows.length, 3);
          for (const row of rows) {
            assert.equal(row.length, header.length);
            assert.equal(field(row, "export_schema_version"), "public-export/v2");
            assert.equal(field(row, "scope_schema_version"), "public-scope/v2");
            assert.equal(field(row, "context"), scope.context);
            assert.deepEqual(JSON.parse(field(row, "projects")), scope.projects);
            assert.equal(field(row, "snapshot"), input.head.snapshotId);
          }
          const row = rows.find((entry) => field(entry, "actor_id") === "101");
          assert.equal(field(row, "value"), "14");
          assert.equal(field(row, "rank"), "2");
          assert.deepEqual(JSON.parse(field(row, "pending")), expected);
          assert.deepEqual(JSON.parse(field(row, "pending_evidence")), json.pendingEvidence);
        }
        assert.deepEqual(input, original);
      }
});
