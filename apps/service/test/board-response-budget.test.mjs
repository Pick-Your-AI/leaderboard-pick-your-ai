import assert from "node:assert/strict";
import test from "node:test";
import { publicScopeParameters } from "../../../packages/contracts/dist/index.js";
import { createService } from "../dist/app.js";
import { board, exportPage, request, selection } from "../../web/src/remote/client.ts";
import { parseCSVExport } from "../../web/src/remote/csv-export.ts";
import { physicalAt, physicalFixture, physicalSnapshotId } from "../../../tests/fixtures/physical-context.mjs";

const responseByteLimit = 2_000_000;
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

function cohort(actorCount, sampleCount, legacy = false) {
  const parts = Array.from({ length: actorCount }, (_, index) =>
    physicalFixture({ actorId: 101 + index, integrationOffset: index * sampleCount, sampleCount, legacy }),
  );
  const input = structuredClone(parts[0]);
  for (const key of ["actors", "rows", "evidence", "physicalContexts", "physicalEvidence"])
    if (Object.hasOwn(input.selected, key)) input.selected[key] = parts.flatMap((part) => part.selected[key]);
  return input;
}

function service(t, input) {
  const responses = [];
  const app = createService({
    now: () => Date.parse(physicalAt),
    cursorSecret: "synthetic-board-budget-secret-for-local-tests",
    source: {
      async read(_scope, pin, signal) {
        signal.throwIfAborted();
        if (pin !== null && pin !== input.selected.snapshot.snapshotId) return null;
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  t.mock.method(globalThis, "fetch", async (raw) => {
    const url = new URL(String(raw), "https://synthetic.invalid");
    const response = await app.inject(url.pathname + url.search);
    responses.push({ path: url.pathname, status: response.statusCode, bytes: Buffer.byteLength(response.body) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });
  return { app, responses };
}

function paramsFor(input, limit, cursor = null) {
  const params = new URLSearchParams({
    ...publicScopeParameters(input.selected.scope),
    metric: "pr_lines_added",
    snapshot: physicalSnapshotId,
    limit: String(limit),
  });
  if (cursor !== null) params.set("cursor", cursor);
  return params;
}

test("large physical boards traverse the actual client without losing rows or samples, with independent supported exports", async (t) => {
  const input = cohort(50, 90);
  const original = structuredClone(input);
  const h = service(t, input);
  const initial = await h.app.inject(`/api/v1/boards?${paramsFor(input, 50)}`);
  t.diagnostic(`initial HTTP ${initial.statusCode}, UTF-8 bytes ${Buffer.byteLength(initial.body)}`);
  // The requested board limit can exceed a complete response. Downloads retain
  // their independent evidence/cell limits; the supported 20-row pages exercise
  // both real readers without redefining an export limit as board eligibility.
  for (const limit of [50, 20]) {
    const seen = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const params = paramsFor(input, limit, cursor);
      const selected = selection(params.toString());
      const document = await request("/api/v1", "boards", params, new AbortController().signal);
      const page = board(document, selected);
      assert.equal(document.totalRows, 50);
      assert.equal(document.rankingPresentation.totalContributors, 50);
      assert.equal(document.rankingPresentation.comparableContributors, 50);
      assert.ok(page.rows.length > 0);
      for (const row of page.rows) {
        assert.equal(row.result.value, 17 * 90);
        assert.equal(row.rank, 1);
        assert.equal(row.physicalContext.state, "available");
        assert.equal(row.physicalContext.sampleCount, 90);
        assert.equal(row.physicalContext.samples.length, 90);
        assert.equal(row.physicalContext.unitCount, 90);
        assert.equal(row.evidenceIds.length, 90);
        seen.push(row.actorId);
      }
      for (const format of limit === 20 ? ["json", "csv"] : []) {
        const download = await exportPage("/api/v1", selected, format, new AbortController().signal, page.metric);
        assert.ok(download.size <= responseByteLimit);
        const raw = await download.text();
        const exported = format === "json" ? JSON.parse(raw) : parseCSVExport(raw, page.metric, 50);
        assert.deepEqual(
          exported.rows.map((row) => row.actorId),
          page.rows.map((row) => row.actorId),
        );
        assert.deepEqual(
          exported.rows.map((row) => row.physicalContext),
          page.rows.map((row) => row.physicalContext),
        );
        assert.deepEqual(
          exported.rows.map((row) => row.evidenceIds),
          page.rows.map((row) => row.evidenceIds),
        );
        assert.equal(exported.nextCursor, page.nextCursor);
        assert.equal(exported.totalRows, 50);
        assert.deepEqual(exported.rankingPresentation, document.rankingPresentation);
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        assert.equal(cursors.has(cursor), false);
        cursors.add(cursor);
      }
    } while (cursor !== null);
    assert.equal(seen.length, 50);
    assert.equal(new Set(seen).size, 50);
    assert.deepEqual(
      seen,
      input.selected.rows.map((row) => row.actorId),
    );
  }
  assert.ok(h.responses.every((response) => response.status === 200 && response.bytes <= responseByteLimit));
  assert.deepEqual(input, original, "public pagination does not mutate any retained input or receipt");
  t.diagnostic(JSON.stringify(h.responses));
});

test("the exact UTF-8 board ceiling includes complete metadata, escaped Unicode rows, diagnostics and its signed cursor", async (t) => {
  const input = cohort(3, 1, true);
  input.selected.snapshot.computationVersion = "synthetic-" + "v".repeat(190);
  input.selected.actors[0].actor.displayName = 'synthetic "界é\\\nZ';
  input.selected.diagnostics = input.selected.rows.map(({ actorId }) => ({
    metricId: "pr_lines_added",
    actorId,
    numerator: 1,
    denominator: 1,
    sampleCount: 1,
    censored: 0,
    missingReadiness: 0,
    p75: null,
  }));
  const h = service(t, input);
  const params = paramsFor(input, 2);
  const base = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(base.statusCode, 200, base.body);
  assert.equal(base.json().rows.length, 2);
  assert.notEqual(base.json().nextCursor, null);
  const padding = responseByteLimit - bytes(base.body);
  input.selected.actors[0].actor.displayName += "界".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3);
  const exact = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(exact.statusCode, 200, exact.body.slice(0, 100));
  assert.equal(bytes(exact.body), responseByteLimit);
  assert.ok(exact.body.length < responseByteLimit, "UTF-16 length is not the response budget");
  const document = await request("/api/v1", "boards", params, new AbortController().signal);
  assert.equal(board(document, selection(params.toString())).rows.length, 2);
  assert.equal(document.computationVersion, input.selected.snapshot.computationVersion);
  assert.deepEqual(document.diagnostics, input.selected.diagnostics.slice(0, 2));
  assert.equal(document.rankingPresentation, undefined);
  assert.ok(document.rows.every((row) => row.physicalContext === undefined));

  input.selected.actors[0].actor.displayName += "x";
  const above = await h.app.inject(`/api/v1/boards?${params}`);
  assert.equal(above.statusCode, 200, above.body.slice(0, 100));
  assert.ok(bytes(above.body) < responseByteLimit);
  const first = above.json();
  assert.deepEqual(
    first.rows.map((row) => row.actorId),
    ["101"],
  );
  assert.equal(first.totalRows, 3);
  assert.deepEqual(first.diagnostics, input.selected.diagnostics.slice(0, 1));
  const cursor = JSON.parse(Buffer.from(first.nextCursor.split(".")[0], "base64url"));
  assert.equal(cursor.offset, 1, "continuations advance by returned rows, not requested limit");
  const last = await h.app.inject(`/api/v1/boards?${paramsFor(input, 2, first.nextCursor)}`);
  assert.equal(last.statusCode, 200, last.body);
  assert.deepEqual(
    last.json().rows.map((row) => row.actorId),
    ["102", "103"],
  );
  assert.equal(last.json().totalRows, 3);
  assert.equal(last.json().nextCursor, null);
  assert.deepEqual(last.json().diagnostics, input.selected.diagnostics.slice(1));
});

test("a terminal page fits even when its shorter continuation would exceed the board budget", async (t) => {
  const input = cohort(2, 1, true);
  input.selected.scope.organization = "synthetic-" + "o".repeat(190);
  input.selected.scope.repository = "2";
  input.selected.scope.workstream = "synthetic-" + "w".repeat(190);
  input.selected.actors[0].actor.displayName = "synthetic terminal budget";
  const h = service(t, input);
  const base = await h.app.inject(`/api/v1/boards?${paramsFor(input, 2)}`);
  const prefix = await h.app.inject(`/api/v1/boards?${paramsFor(input, 1)}`);
  assert.equal(base.statusCode, 200, base.body);
  assert.equal(prefix.statusCode, 200, prefix.body);
  assert.equal(base.json().rows.length, 2);
  assert.equal(base.json().nextCursor, null);
  assert.notEqual(prefix.json().nextCursor, null);
  assert.ok(bytes(prefix.body) > bytes(base.body), "the actual signed legacy-scope cursor exceeds the final row");
  input.selected.actors[0].actor.displayName += "x".repeat(responseByteLimit - bytes(base.body));
  const exact = await h.app.inject(`/api/v1/boards?${paramsFor(input, 2)}`);
  assert.equal(exact.statusCode, 200, exact.body.slice(0, 100));
  assert.equal(bytes(exact.body), responseByteLimit);
  assert.deepEqual(
    exact.json().rows.map((row) => row.actorId),
    ["101", "102"],
  );
  assert.equal(exact.json().nextCursor, null);
  const impossible = await h.app.inject(`/api/v1/boards?${paramsFor(input, 1)}`);
  assert.equal(impossible.statusCode, 503);
  assert.deepEqual(impossible.json(), { error: "board_response_too_large" });
});

test("an indivisible row or fixed envelope fails closed, while an ordinary empty legacy board remains complete", async (t) => {
  const input = cohort(1, 1, true);
  const h = service(t, input);
  input.selected.actors[0].actor.displayName = "x".repeat(responseByteLimit);
  const row = await h.app.inject(`/api/v1/boards?${paramsFor(input, 50)}`);
  assert.equal(row.statusCode, 503);
  assert.deepEqual(row.json(), { error: "board_response_too_large" });
  assert.equal(row.headers["cache-control"], "no-store");
  input.selected.rows = [];
  input.selected.actors = [];
  input.selected.evidence = [];
  input.selected.snapshot.computationVersion = "x".repeat(responseByteLimit);
  const fixed = await h.app.inject(`/api/v1/boards?${paramsFor(input, 50)}`);
  assert.equal(fixed.statusCode, 503);
  assert.deepEqual(fixed.json(), { error: "board_response_too_large" });
  input.selected.snapshot.computationVersion = "synthetic-empty-retained";
  const empty = await h.app.inject(`/api/v1/boards?${paramsFor(input, 50)}`);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json().rows, []);
  assert.deepEqual(empty.json().diagnostics, []);
  assert.equal(empty.json().totalRows, 0);
  assert.equal(empty.json().nextCursor, null);
  assert.equal(empty.json().rankingPresentation, undefined);
  assert.equal(empty.json().computationVersion, "synthetic-empty-retained");
});

test("current privacy removes an oversized hidden actor before board admission and cohort presentation", async (t) => {
  const input = cohort(2, 1);
  input.selected.actors[0].actor.displayName = "OVERSIZE_PRIVATE_ACTOR" + "x".repeat(responseByteLimit);
  input.controls.suppressedActorIds = ["101"];
  const h = service(t, input);
  const response = await h.app.inject(`/api/v1/boards?${paramsFor(input, 50)}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(bytes(response.body) < responseByteLimit);
  assert.deepEqual(
    response.json().rows.map((row) => row.actorId),
    ["102"],
  );
  assert.equal(response.json().totalRows, 1);
  assert.equal(response.json().rankingPresentation.totalContributors, 1);
  assert.equal(response.json().rows[0].physicalContext.sampleCount, 1);
  assert.doesNotMatch(response.body, /OVERSIZE_PRIVATE_ACTOR/);
});
