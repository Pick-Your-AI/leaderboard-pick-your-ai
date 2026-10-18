import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { createConnection } from "node:net";
import { createService } from "../dist/app.js";
import {
  canonicalPublicScope,
  publicContributionRoles,
  publicScopeKey,
  publicScopeParameters,
} from "../../../packages/contracts/dist/index.js";
import { legacyScope, scopeFixture } from "../../../tests/fixtures/public-scope.mjs";

// These synthetic IDs use only legal characters that all require three URL
// bytes. Seven punctuation bits give 100 distinct, exactly 128-character IDs.
function maximalScope(roles = []) {
  return canonicalPublicScope({
    organization: ":".repeat(200),
    repository: ":".repeat(200),
    workstream: ":".repeat(200),
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
    context: "current",
    projects: Array.from(
      { length: 100 },
      (_, index) => "=".repeat(121) + index.toString(2).padStart(7, "0").replaceAll("0", "=").replaceAll("1", ":"),
    ),
    ...(roles.length ? { roles } : {}),
  });
}
const query = (scope, extra = {}) => new URLSearchParams({ ...publicScopeParameters(scope), ...extra });
const board = (scope, extra = {}) => `/api/v1/boards?${query(scope, { metric: "pr_merged", ...extra })}`;
async function harness(t, scope = legacyScope) {
  const calls = [];
  const read = scopeFixture(scope);
  if (scope.repository !== null) {
    // Keep the synthetic evidence in the selected repository and retain the
    // fixture's actual October event times, so cursor cases have two real rows.
    for (const entry of [...read.selected.evidence, ...read.selected.pendingEvidence])
      entry.artifact.repositoryId = scope.repository;
    for (const coverage of [
      ...read.selected.snapshot.coverage,
      ...read.selected.rows.map((row) => row.result.coverage),
    ])
      coverage.scopeId = scope.repository;
  }
  const app = createService({
    now: () => Date.parse("2026-10-18T00:00:00.000Z"),
    source: {
      async read(selected, pin) {
        calls.push({ scope: structuredClone(selected), pin });
        return structuredClone(read);
      },
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const get = (path, headers = { Connection: "close" }) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: app.server.address().port,
          path,
          headers,
          method: "GET",
          agent: false,
          timeout: 5_000,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("synthetic_http_timeout")));
      req.end();
    });
  const getRaw = (path, lines) =>
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: app.server.address().port });
      const chunks = [];
      socket.setTimeout(5_000, () => socket.destroy(new Error("synthetic_raw_http_timeout")));
      socket.on("connect", () =>
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${lines.join("\r\n")}\r\n\r\n`,
          "latin1",
        ),
      );
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        const response = Buffer.concat(chunks).toString("latin1");
        resolve({ status: Number(response.split(" ")[1]), response });
      });
    });
  return { app, calls, read, get, getRaw };
}

test("the fixed HTTP target budget covers every canonical scope width plus bounded query and route fields", () => {
  const scope = maximalScope(publicContributionRoles);
  assert.equal(new Set(scope.projects).size, 100);
  assert.ok(scope.projects.every((id) => id.length === 128 && /^[=:]+$/.test(id)));
  assert.equal(publicScopeKey(scope).length, 13_895);
  // Include every bounded optional field, even mutually exclusive route filters,
  // and the longest parameterized public route. This is an upper-bound witness,
  // not a claim that unknown metric IDs or a made-up cursor are authorized.
  const upper = query(scope, {
    actors: "automation",
    snapshot: ":".repeat(200),
    metric: ":".repeat(200),
    category: ":".repeat(200),
    compare: ":".repeat(200),
    compareStart: scope.start,
    compareEnd: scope.end,
    cursor: "c".repeat(2048),
    search: "s".repeat(39),
    limit: "100",
    format: "json",
  });
  const target = `/api/v1/contributors/${encodeURIComponent(":".repeat(200))}/achievements?${upper}`;
  assert.ok(target.length > 40_000);
  assert.ok(target.length < 49_152, `the complete maximum-width target is ${target.length} bytes`);
  assert.equal(Buffer.byteLength(target), target.length);
});

for (const roles of [[], publicContributionRoles])
  test(`actual HTTP preserves maximal ${roles.length ? "v3 role" : "v2 membership"} scope, pins and cursors`, async (t) => {
    const scope = maximalScope(roles),
      h = await harness(t, scope);
    const firstTarget = board(scope, { limit: "1" });
    assert.ok(firstTarget.length > 40_000, "exercise the real native parser, beyond its former 16 KiB bound");
    const first = await h.get(firstTarget);
    assert.equal(first.status, 200, first.body);
    const page = JSON.parse(first.body);
    assert.equal(page.schemaVersion, roles.length ? "public-read/v3" : "public-read/v2");
    assert.deepEqual(page.scope, scope);
    assert.ok(page.nextCursor.length < 2048);
    const nextTarget = board(scope, { limit: "1", snapshot: page.snapshotId, cursor: page.nextCursor });
    const next = await h.get(nextTarget);
    assert.equal(next.status, 200, next.body);
    assert.equal(JSON.parse(next.body).snapshotId, page.snapshotId);
    assert.deepEqual(JSON.parse(next.body).scope, scope);
    assert.notDeepEqual(JSON.parse(next.body).rows, page.rows);
    for (const call of h.calls) assert.deepEqual(call.scope, scope);
    assert.equal(h.calls.at(-1).pin, page.snapshotId);
    const count = h.calls.length;
    const changed = new URLSearchParams(nextTarget.split("?")[1]);
    changed.set("context", "event");
    const mismatch = await h.get(`/api/v1/boards?${changed}`);
    assert.equal(mismatch.status, 400, mismatch.body);
    assert.equal(JSON.parse(mismatch.body).error, "cursor_scope_mismatch");
    assert.equal(h.calls.length, count);
    const exported = await h.get(`/api/v1/exports?${query(scope, { metric: "pr_merged", snapshot: page.snapshotId })}`);
    assert.equal(exported.status, 200, exported.body);
    assert.deepEqual(JSON.parse(exported.body).scope, scope);
    assert.equal(JSON.parse(exported.body).exportSchemaVersion, roles.length ? "public-export/v3" : "public-export/v2");
    const csv = await h.get(
      `/api/v1/exports?${query(scope, { metric: "pr_merged", snapshot: page.snapshotId, format: "csv" })}`,
    );
    assert.equal(csv.status, 200, csv.body);
    const [columns, ...records] = csv.body
      .trimEnd()
      .split("\r\n")
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"')));
    assert.deepEqual(
      records.map((record) => record[0]),
      ["metadata", "row", "row"],
    );
    for (const record of records) {
      assert.deepEqual(JSON.parse(record[columns.indexOf("projects")]), scope.projects);
      assert.equal(record[columns.indexOf("snapshot")], page.snapshotId);
      if (roles.length) assert.deepEqual(JSON.parse(record[columns.indexOf("roles")]), scope.roles);
    }
    h.read.controls.revokedSnapshotIds = [page.snapshotId];
    const withheld = await h.get(nextTarget, { "If-None-Match": next.headers.etag, Connection: "close" });
    assert.equal(withheld.status, 410, withheld.body);
    assert.doesNotMatch(withheld.body, /"rows"|"evidence"/);
  });

test("actual HTTP target overflow and malformed maximum scopes are rejected before provider I/O", async (t) => {
  const h = await harness(t),
    scope = maximalScope(publicContributionRoles);
  const prefix = "/api/v1/boards?unknown=";
  const atLimit = prefix + "s".repeat(49_152 - prefix.length);
  const admitted = await h.get(atLimit);
  assert.equal(admitted.status, 400, admitted.body);
  assert.equal(JSON.parse(admitted.body).error, "invalid_query");
  const overflow = await h.get(atLimit + "s");
  assert.equal(overflow.status, 414, overflow.body);
  assert.equal(JSON.parse(overflow.body).error, "query_too_large");
  for (const patch of [
    { project: [...scope.projects, "SYNTHETIC_101ST_PROJECT"].join(",") },
    { project: ["=".repeat(129), ...scope.projects.slice(1)].join(",") },
    { role: "author,unknown" },
  ]) {
    const invalid = await h.get(board(scope, patch));
    assert.equal(invalid.status, 400, invalid.body);
    assert.equal(JSON.parse(invalid.body).error, "invalid_public_scope");
  }
  const duplicated = await h.get(board(scope) + "&context=current");
  assert.equal(duplicated.status, 400, duplicated.body);
  assert.equal(JSON.parse(duplicated.body).error, "invalid_query");
  assert.equal(h.calls.length, 0);
});

test("actual HTTP preserves a separate inclusive retained-header budget alongside a maximal scope", async (t) => {
  const scope = maximalScope(publicContributionRoles),
    h = await harness(t, scope);
  const headers = ["Host", "127.0.0.1", "Connection", "close", "X-Synthetic-Padding", ""];
  // Three name/value lines, each with ': ' and CRLF, plus the closing CRLF.
  const overhead = headers.reduce((total, field) => total + field.length, 2 + 3 * 4);
  headers[5] = "s".repeat(16_384 - overhead);
  const accepted = await h.get(board(scope), headers);
  assert.equal(accepted.status, 200, accepted.body);
  const count = h.calls.length;
  headers[5] += "s";
  const rejected = await h.get(board(scope), headers);
  assert.equal(rejected.status, 431, rejected.body);
  assert.equal(JSON.parse(rejected.body).error, "headers_too_large");
  assert.equal(h.calls.length, count);
});

test("actual HTTP rejects header-count overflow before Node truncation can conceal retained fields", async (t) => {
  const h = await harness(t);
  const base = ["Host", "127.0.0.1", "Connection", "close"];
  const atLimit = [...base, ...Array.from({ length: 998 }, () => ["X", ""]).flat()];
  const accepted = await h.get(board(legacyScope), atLimit);
  assert.equal(accepted.status, 200, accepted.body);
  const count = h.calls.length;
  for (const extra of [1, 20]) {
    const rejected = await h.get(board(legacyScope), [
      ...atLimit,
      ...Array.from({ length: extra }, () => ["X", ""]).flat(),
    ]);
    assert.equal(rejected.status, 431, rejected.body);
    if (extra === 1) assert.equal(JSON.parse(rejected.body).error, "headers_too_large");
    else assert.ok(["headers_too_large", "Request Header Fields Too Large"].includes(JSON.parse(rejected.body).error));
  }
  assert.equal(h.calls.length, count);
});

test("actual wire whitespace and repeated fields preserve Node accounting and retained-header rejection", async (t) => {
  const scope = maximalScope(publicContributionRoles),
    h = await harness(t, scope),
    target = board(scope),
    whitespace = " \t".repeat(9_000);
  // Write exact wire bytes without the HTTP client's header processing. Node
  // discards leading/trailing OWS, so these exceed 16 KiB on the wire while their
  // retained values remain small. Leading OWS is also excluded from native size
  // accounting, including when its actual wire bytes exceed the parser setting.
  for (const [lines, exceedsParserSetting] of [
    [[`X-Synthetic-Padding:${whitespace}s`], false],
    [[`X-Synthetic-Padding:s${whitespace}`], false],
    [
      [`X-Synthetic-Padding:${whitespace.slice(0, 9_000)}s`, `X-Synthetic-Padding:s${whitespace.slice(0, 9_000)}`],
      false,
    ],
    [[`X-Synthetic-Padding:${whitespace}${whitespace}s`], true],
    [[`X-Synthetic-Padding:${whitespace}s`, `X-Synthetic-Padding:${whitespace}s`], true],
  ]) {
    assert.ok(lines.join("\r\n").length > 16_384);
    assert.equal(target.length + lines.join("\r\n").length + 100 > 66_560, exceedsParserSetting);
    const accepted = await h.getRaw(target, lines);
    assert.equal(accepted.status, 200, accepted.response);
  }
  assert.equal(h.calls.length, 5);
  for (const call of h.calls) assert.deepEqual(call.scope, scope);
  // Repeated ordinary values count in aggregate, even when every individual
  // field is below 16 KiB. Trailing OWS still counts against the native cap.
  for (const lines of [
    [`X-Synthetic-Padding:${"s".repeat(8_192)}`, `X-Synthetic-Padding:${"s".repeat(8_192)}`],
    [`X-Synthetic-Padding:s${whitespace}${whitespace}`],
    [`X-Synthetic-Padding:s${whitespace}`, `X-Synthetic-Padding:s${whitespace}`],
  ]) {
    const rejected = await h.getRaw(target, lines);
    const detail = {
      fieldLengths: lines.map((line) => line.length),
      leadingOWS: /^X-Synthetic-Padding:[ \t]/.test(lines[0]),
      targetBytes: target.length,
      status: rejected.status,
    };
    assert.equal(rejected.status, 431, JSON.stringify(detail));
  }
  assert.equal(h.calls.length, 5);
});

test("the native HTTP parser still rejects the bounded combined envelope before provider I/O", async (t) => {
  const h = await harness(t);
  const response = await h.get(board(legacyScope), { "X-Synthetic-Padding": "s".repeat(66_561), Connection: "close" });
  assert.equal(response.status, 431, response.body);
  assert.equal(h.calls.length, 0);
});
