import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../dist/app.js";
import { PUBLIC_EXPORT_LIMITS } from "../dist/exports.js";

const at = "2026-10-17T12:00:00.000Z";
const scope = {
  organization: "Pick-Your-AI",
  repository: "repo-1",
  workstream: "delivery",
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
};
const params = new URLSearchParams({ ...scope, metric: "pr_opened", snapshot: "public-1" });
const exportUrl = `/api/v1/exports?${params}`;
const coverage = {
  schemaVersion: "leaderboard/v1",
  state: "complete",
  source: "github_rest",
  scopeId: "public-org",
  windowStart: scope.start,
  windowEnd: scope.end,
  knownStart: null,
  lastSuccessfulSync: at,
  sourceWatermark: at,
  missingPages: 0,
  permissionsMissing: [],
  sourceErrors: [],
};
function fixture() {
  const actors = ["alice", "bob", "carol"].map((actorId) => ({
    actorId,
    state: "public",
    actor: {
      schemaVersion: "leaderboard/v1",
      identityState: "resolved",
      githubNodeId: `node-${actorId}`,
      login: actorId,
      displayName: `OMIT_DISPLAY_NAME_${actorId}`,
      kind: "user",
      executionMode: "unknown",
    },
  }));
  const evidence = actors.map(({ actorId }, index) => ({
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "pull_request",
      stableId: `pr-${index}`,
      repositoryId: scope.repository,
      publicUrl: `https://github.com/synthetic/example/pull/${index + 1}`,
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: `e-${actorId}`,
      canonicalEventId: `OMIT_INTERNAL_EVENT_${actorId}`,
      artifactId: `pr-${index}`,
      actorId,
      roles: ["author"],
      qualification: "eligible",
      metricIds: ["pr_opened"],
      reasonCodes: ["eligible"],
    },
    occurredAt: at,
    sourceRevision: `revision-${index}`,
    sourceRevisionUrl: `https://github.com/synthetic/example/commit/${"a".repeat(40)}`,
  }));
  return {
    head: { snapshotId: "public-1", revision: 1, publishedAt: at },
    controls: { version: "controls-1", suppressedActorIds: [], suppressedArtifactIds: [], revokedSnapshotIds: [] },
    selected: {
      approvedPublic: true,
      scope: structuredClone(scope),
      snapshot: {
        schemaVersion: "leaderboard/v1",
        snapshotId: "public-1",
        revision: 1,
        generatedAt: at,
        metricDefinitionVersion: "candidate-0.1.1",
        computationVersion: "synthetic-only",
        coverage: [structuredClone(coverage)],
        results: [],
      },
      actors,
      evidence,
      rows: actors.map(({ actorId }, index) => ({
        actorId,
        result: {
          schemaVersion: "leaderboard/v1",
          metricId: "pr_opened",
          state: "measured",
          value: index < 2 ? 2 : 1,
          coverage: structuredClone(coverage),
        },
        evidenceIds: [`e-${actorId}`],
      })),
      ranking: [{ metricId: "pr_opened", direction: "descending" }],
    },
  };
}
function harness(t, data = fixture()) {
  let fail = false;
  let calls = 0;
  const app = createService({
    source: {
      async read(requestScope, pin) {
        calls++;
        assert.deepEqual(requestScope, scope);
        assert.equal(pin, "public-1");
        if (fail) throw new Error("SECRET_PROVIDER_FAILURE");
        return structuredClone(data);
      },
    },
  });
  t.after(() => app.close());
  return {
    app,
    data,
    calls: () => calls,
    fail: () => {
      fail = true;
    },
  };
}
/** Deliberately parse quoted CSV records, including CRLF/newlines/commas inside cells. */
function parseCsv(body) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      if (quoted && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && body[i + 1] === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  assert.equal(quoted, false, "unterminated CSV field");
  assert.deepEqual(row, []);
  assert.equal(cell, "");
  const [columns, ...records] = rows;
  for (const record of records) assert.equal(record.length, columns.length);
  return records.map((record) => Object.fromEntries(columns.map((column, index) => [column, record[index]])));
}

test("JSON export reproduces exact selected board totals and minimizes page provenance", async (t) => {
  const h = harness(t);
  const board = (await h.app.inject(`/api/v1/boards?${params}&limit=1`)).json();
  const response = await h.app.inject(`${exportUrl}&limit=1`);
  assert.equal(response.statusCode, 200, response.body);
  const exported = response.json();
  assert.equal(exported.exportSchemaVersion, "public-export/v1");
  assert.equal(exported.snapshotId, board.snapshotId);
  assert.equal(exported.metricDefinitionVersion, board.metricDefinitionVersion);
  assert.equal(exported.computationVersion, board.computationVersion);
  assert.equal(exported.policyVersion, board.policyVersion);
  assert.deepEqual(exported.metric, board.metric);
  assert.deepEqual(exported.scope, scope);
  assert.deepEqual(
    exported.rows.map((row) => row.result),
    board.rows.map((row) => row.result),
  );
  assert.equal(exported.totalRows, 3);
  assert.equal(exported.pageRows, 1);
  assert.equal(exported.nextCursor, board.nextCursor);
  assert.deepEqual(
    exported.evidence.map((entry) => entry.evidenceId),
    ["e-alice"],
  );
  assert.equal(exported.evidence[0].sourceUrl, "https://github.com/synthetic/example/pull/1");
  assert.equal(exported.evidence[0].sourceRevision, "revision-0");
  assert.match(exported.evidence[0].sourceRevisionUrl, /\/commit\/a{40}$/);
  assert.equal(exported.evidence[0].occurredAt, at);
  assert.doesNotMatch(response.body, /OMIT_DISPLAY_NAME|OMIT_INTERNAL_EVENT|githubNodeId|suppressedActorIds|e-bob/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="leaderboard.json"');
  assert.equal(response.headers["content-security-policy"], "sandbox; default-src 'none'");
});

test("CSV metadata and metric rows preserve versions, source mapping and half-open date scope", async (t) => {
  const { app } = harness(t);
  const response = await app.inject(`${exportUrl}&format=csv`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const [metadata, ...rows] = parseCsv(response.body);
  assert.equal(metadata.record_type, "metadata");
  assert.equal(metadata.snapshot, "public-1");
  assert.equal(metadata.metric_definition_version, "candidate-0.1.1");
  assert.equal(metadata.computation_version, "synthetic-only");
  for (const key of ["organization", "repository", "workstream", "start", "end"])
    assert.equal(metadata[key], scope[key]);
  assert.equal(JSON.parse(metadata.metric_definition).id, "pr_opened");
  assert.equal(metadata.total_rows, "3");
  assert.equal(metadata.page_rows, "3");
  assert.deepEqual(
    rows.map((row) => [row.record_type, row.actor_id, Number(row.value), Number(row.rank)]),
    [
      ["row", "alice", 2, 1],
      ["row", "bob", 2, 1],
      ["row", "carol", 1, 2],
    ],
  );
  const source = JSON.parse(rows[0].evidence)[0];
  assert.equal(source.evidenceId, "e-alice");
  assert.equal(source.sourceUrl, "https://github.com/synthetic/example/pull/1");
  assert.equal(source.sourceRevision, "revision-0");
  assert.match(source.sourceRevisionUrl, /\/commit\/a{40}$/);
});

test("empty exports retain provenance and unknown values never become fabricated zeros", async (t) => {
  const h = harness(t);
  h.data.controls.suppressedActorIds = ["alice", "bob", "carol"];
  const empty = await h.app.inject(`${exportUrl}&format=csv`);
  const records = parseCsv(empty.body);
  assert.equal(records.length, 1);
  assert.equal(records[0].record_type, "metadata");
  assert.equal(records[0].snapshot, "public-1");
  assert.equal(records[0].start, scope.start);
  assert.equal(records[0].total_rows, "0");
  assert.equal(records[0].page_rows, "0");
  assert.equal(records[0].value, "");
  assert.doesNotMatch(empty.body, /e-alice|e-bob|e-carol/);
  h.data.controls.suppressedActorIds = [];
  h.data.selected.rows[0].result.state = "unknown";
  delete h.data.selected.rows[0].result.value;
  h.data.selected.evidence[0].sourceRevision = null;
  h.data.selected.evidence[0].sourceRevisionUrl = null;
  const json = (await h.app.inject(exportUrl)).json();
  assert.equal(json.rows.find((row) => row.actorId === "alice").result.value, undefined);
  assert.equal(json.evidence.find((row) => row.evidenceId === "e-alice").sourceRevision, null);
  assert.equal(json.evidence.find((row) => row.evidenceId === "e-alice").sourceRevisionUrl, null);
  const csv = parseCsv((await h.app.inject(`${exportUrl}&format=csv`)).body);
  assert.equal(csv.find((row) => row.actor_id === "alice").value, "");
  assert.equal(csv.find((row) => row.actor_id === "alice").state, "unknown");
});

test("CSV formula, separator, multiline and HTML payloads remain quoted inert cells", async (t) => {
  const h = harness(t);
  const attacks = [
    '=HYPERLINK("https://evil.invalid")',
    "+SUM(1,1)",
    "-1+2",
    "@SUM(1,1)",
    "\t=1+1",
    "\r\n=1+1",
    "\ufeff=1+1",
    "\u200b=1+1",
    'safe",=1+1,"cell\nnext',
    '<svg onload="alert(1)">',
  ];
  for (const attack of attacks) {
    h.data.selected.actors[0].actor.login = attack;
    const response = await h.app.inject(`${exportUrl}&format=csv`);
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers["content-type"], /^text\/csv/);
    const records = parseCsv(response.body);
    assert.equal(records.length, 4, attack);
    const login = records.find((record) => record.actor_id === "alice").actor;
    const projected = attack.trim(); // Frozen Actor contract trims user-supplied labels.
    assert.equal(login, /^[\s\p{Cf}]*[=+@-]/u.test(projected) ? `'${projected}` : projected);
    assert.doesNotMatch(login, /^[\s\p{Cf}]*[=+@-]/u);
  }
});

test("unsafe URLs, private/ineligible evidence and suppressed historical rows cannot escape exports", async (t) => {
  const h = harness(t);
  const first = await h.app.inject(exportUrl);
  h.data.controls.version = "controls-2";
  h.data.controls.suppressedActorIds = ["alice"];
  h.data.selected.evidence[1].contribution.qualification = "pending";
  const publicUrl = h.data.selected.evidence[2].artifact.publicUrl;
  h.data.selected.evidence[2].artifact.visibility = "private";
  delete h.data.selected.evidence[2].artifact.publicUrl;
  assert.deepEqual((await h.app.inject(exportUrl)).json().rows, []);
  assert.doesNotMatch((await h.app.inject(`${exportUrl}&format=csv`)).body, /e-alice|e-bob|e-carol/);
  h.data.selected.evidence[2].artifact.visibility = "public";
  h.data.selected.evidence[2].artifact.publicUrl = publicUrl;
  for (const url of [
    "http://127.0.0.1/private",
    "https://169.254.169.254/latest/meta-data",
    "https://github.com@127.0.0.1/private",
    "javascript:alert(1)",
  ]) {
    h.data.selected.evidence[2].artifact.publicUrl = url;
    for (const format of ["json", "csv"]) {
      const response = await h.app.inject({
        url: `${exportUrl}&format=${format}`,
        headers: { "if-none-match": first.headers.etag },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.doesNotMatch(response.body, /e-alice|e-bob|e-carol|169\.254|127\.0|javascript:/);
    }
  }
  h.data.controls.revokedSnapshotIds = ["public-1"];
  for (const format of ["json", "csv"]) {
    const response = await h.app.inject({
      url: `${exportUrl}&format=${format}`,
      headers: { "if-none-match": first.headers.etag },
    });
    assert.equal(response.statusCode, 410);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("every conditional export checks its source; source errors never return stale bytes", async (t) => {
  const h = harness(t);
  for (const format of ["json", "csv"]) {
    const first = await h.app.inject(`${exportUrl}&format=${format}`);
    const conditional = await h.app.inject({
      url: `${exportUrl}&format=${format}`,
      headers: { "if-none-match": first.headers.etag },
    });
    assert.equal(conditional.statusCode, 304);
    assert.equal(conditional.headers["cache-control"], "no-store");
  }
  assert.equal(h.calls(), 4);
  h.fail();
  for (const format of ["json", "csv"]) {
    const response = await h.app.inject({ url: `${exportUrl}&format=${format}`, headers: { "if-none-match": "*" } });
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /SECRET|e-alice/);
  }
  assert.equal(h.calls(), 6);
});

test("exports reject oversized UTF-8 fields and unsafe controls without partial data", async (t) => {
  const h = harness(t);
  for (const login of [
    "a".repeat(PUBLIC_EXPORT_LIMITS.fieldBytes + 1),
    "雪".repeat(PUBLIC_EXPORT_LIMITS.fieldBytes / 2),
  ]) {
    h.data.selected.actors[0].actor.login = login;
    for (const format of ["csv", "json"]) {
      const response = await h.app.inject(`${exportUrl}&format=${format}`);
      assert.equal(response.statusCode, 413);
      assert.deepEqual(response.json(), { error: "export_too_large" });
      assert.equal(response.headers["content-disposition"], undefined);
    }
  }
  h.data.selected.actors[0].actor.login = "safe\u0000=1+1";
  assert.equal((await h.app.inject(exportUrl)).json().error, "export_content_unavailable");
});

function addEvidence(data, count, pathLength = 0) {
  data.selected.evidence = Array.from({ length: count }, (_, index) => {
    const entry = structuredClone(data.selected.evidence[0]);
    entry.contribution.contributionId = `e-${index}`;
    entry.contribution.artifactId = `pr-${index}`;
    entry.artifact.stableId = `pr-${index}`;
    entry.artifact.publicUrl = `https://github.com/synthetic/example/pull/${index}${"a".repeat(pathLength)}`;
    return entry;
  });
  data.selected.rows = [data.selected.rows[0]];
  data.selected.rows[0].evidenceIds = data.selected.evidence.map((entry) => entry.contribution.contributionId);
}

test("evidence count, total bytes and CSV cell limits fail closed without silently truncating totals", async (t) => {
  const h = harness(t);
  addEvidence(h.data, PUBLIC_EXPORT_LIMITS.evidenceRecords + 1);
  assert.equal((await h.app.inject(exportUrl)).statusCode, 413);
  addEvidence(h.data, 1500, 1600);
  const oversized = await h.app.inject(exportUrl);
  assert.equal(oversized.statusCode, 413, oversized.body);
  assert.ok(oversized.body.length < 100);
  addEvidence(h.data, 200, 1600);
  assert.equal((await h.app.inject(exportUrl)).statusCode, 200);
  const csv = await h.app.inject(`${exportUrl}&format=csv`);
  assert.equal(csv.statusCode, 413, csv.body);
  assert.deepEqual(csv.json(), { error: "export_too_large" });
});

test("paged export continuations retain totals and invalidate when current controls change", async (t) => {
  const h = harness(t);
  const first = (await h.app.inject(`${exportUrl}&limit=1`)).json();
  const next = await h.app.inject(`${exportUrl}&limit=1&format=csv&cursor=${first.nextCursor}`);
  const records = parseCsv(next.body);
  assert.equal(records[0].total_rows, "3");
  assert.equal(records[1].actor_id, "bob");
  assert.equal(records[1].rank, "1");
  h.data.controls.version = "controls-2";
  const expired = await h.app.inject(`${exportUrl}&limit=1&cursor=${first.nextCursor}`);
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json().error, "cursor_policy_changed_refetch");
  for (const format of ["markdown", "print", "html", "svg"]) {
    assert.equal((await h.app.inject(`${exportUrl}&format=${format}`)).statusCode, 400);
  }
});

test("unapproved publications and unsupported title/body fields never become public downloads", async (t) => {
  const h = harness(t);
  h.data.selected.approvedPublic = false;
  for (const format of ["json", "csv"])
    assert.equal((await h.app.inject(`${exportUrl}&format=${format}`)).statusCode, 503);
  h.data.selected.approvedPublic = true;
  h.data.selected.evidence[0].artifact.title = '<img src="http://127.0.0.1" onerror="alert(1)">';
  h.data.selected.evidence[0].artifact.body = '<script>fetch("http://169.254.169.254")</script>';
  for (const format of ["json", "csv"]) {
    const response = await h.app.inject(`${exportUrl}&format=${format}`);
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /<script|<img|127\.0|169\.254/);
  }
});

test("exports retain current-main diagnostic semantics only for the selected visible page", async (t) => {
  const h = harness(t);
  h.data.selected.diagnostics = ["alice", "bob", "carol"].map((actorId) => ({
    metricId: "pr_opened",
    actorId,
    numerator: 2,
    denominator: 3,
    sampleCount: 3,
    censored: 1,
    missingReadiness: 0,
    p75: null,
  }));
  const exported = (await h.app.inject(`${exportUrl}&limit=1`)).json();
  assert.deepEqual(exported.diagnostics, [h.data.selected.diagnostics[0]]);
  const csv = parseCsv((await h.app.inject(`${exportUrl}&limit=1&format=csv`)).body);
  assert.equal(csv[0].numerator, "");
  assert.equal(csv[1].numerator, "2");
  assert.equal(csv[1].denominator, "3");
  assert.equal(csv[1].sample_count, "3");
  assert.equal(csv[1].censored, "1");
  assert.equal(csv[1].missing_readiness, "0");
  assert.equal(csv[1].p75, "");
  h.data.controls.suppressedActorIds = ["alice"];
  const suppressed = (await h.app.inject(`${exportUrl}&limit=1`)).json();
  assert.deepEqual(suppressed.diagnostics, [h.data.selected.diagnostics[1]]);
  assert.equal(suppressed.rows[0].actorId, "bob");
});

test("browser download validates the minimized JSON export rather than the board actor/head contract", async (t) => {
  const { exportPage, selection, validateExport } = await import("../../web/src/remote/client.ts");
  const h = harness(t);
  const selected = selection(`?${params}&limit=1`);
  const response = await h.app.inject(`${exportUrl}&limit=1`);
  assert.equal(response.statusCode, 200);
  const document = response.json();
  assert.equal(document.head, undefined);
  assert.equal(document.rows[0].actor, undefined);
  assert.doesNotThrow(() => validateExport(document, selected));
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(response.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.equal(
    await (await exportPage("https://synthetic.invalid/api/v1", selected, "json", new AbortController().signal)).text(),
    response.body,
  );
  for (const mutate of [
    (d) => (d.snapshotId = "wrong-pin"),
    (d) => (d.scope.repository = "wrong-repository"),
    (d) => (d.metric.id = "issues_opened"),
    (d) => (d.exportSchemaVersion = "unknown/v2"),
    (d) => (d.pageRows = 99),
    (d) => (d.evidence = []),
    (d) => (d.evidence[0].sourceUrl = "javascript:alert(1)"),
    (d) => (d.rows[0].result.metricId = "issues_opened"),
    (d) => d.evidence.push({ ...d.evidence[0], evidenceId: "unrelated" }),
    (d) =>
      d.diagnostics.push({
        metricId: "issues_opened",
        actorId: "unrelated",
        numerator: null,
        denominator: null,
        sampleCount: 0,
        censored: 0,
        missingReadiness: 0,
        p75: null,
      }),
  ]) {
    const altered = structuredClone(document);
    mutate(altered);
    assert.throws(() => validateExport(altered, selected));
  }
});

test("JSON and CSV exports retain service-account kind and unknown execution without review receipts", async (t) => {
  const { selection, validateExport } = await import("../../web/src/remote/client.ts");
  const h = harness(t);
  h.data.selected.actors[0].actor.kind = "service_account";
  h.data.selected.actors[0].serviceAccountClassification = { classificationId: "PRIVATE_CLASSIFICATION_RECEIPT" };
  const json = await h.app.inject(`${exportUrl}&limit=1`);
  const document = json.json();
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(document.rows[0].actorKind, "service_account");
  assert.equal(document.rows[0].executionMode, "unknown");
  assert.doesNotThrow(() => validateExport(document, selection(`?${params}&limit=1`)));
  const csv = await h.app.inject(`${exportUrl}&limit=1&format=csv`);
  const records = parseCsv(csv.body);
  assert.equal(records[0].actor_kind, "");
  assert.equal(records[1].actor_kind, "service_account");
  assert.equal(records[1].execution_mode, "unknown");
  assert.doesNotMatch(json.body + csv.body, /PRIVATE_|serviceAccountClassification|manual/);
});

test("export downloads reject unsupported actor labels while legacy missing labels remain compatible", async (t) => {
  const { exportPage, selection, validateExport } = await import("../../web/src/remote/client.ts");
  const h = harness(t);
  h.data.selected.actors[0].actor.kind = "service_account";
  const response = await h.app.inject(`${exportUrl}&limit=1`);
  assert.equal(response.statusCode, 200, response.body);
  const document = response.json();
  const selected = selection(`?${params}&limit=1`);
  let download = document;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify(download), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  for (const [field, invalid] of [
    ["actorKind", "human"],
    ["actorKind", 17],
    ["actorKind", null],
    ["executionMode", "manual"],
    ["executionMode", "ai"],
    ["executionMode", 17],
    ["executionMode", null],
  ]) {
    download = structuredClone(document);
    download.rows[0][field] = invalid;
    assert.throws(() => validateExport(download, selected), `${field}: ${JSON.stringify(invalid)}`);
    await assert.rejects(
      () => exportPage("https://synthetic.invalid/api/v1", selected, "json", new AbortController().signal),
      (error) => error.code === "invalid_export_response",
    );
  }
  for (const absent of [["actorKind"], ["executionMode"], ["actorKind", "executionMode"]]) {
    download = structuredClone(document);
    for (const field of absent) delete download.rows[0][field];
    assert.doesNotThrow(() => validateExport(download, selected));
    const legacy = await exportPage("https://synthetic.invalid/api/v1", selected, "json", new AbortController().signal);
    assert.equal(await legacy.text(), JSON.stringify(download));
    for (const field of absent) assert.equal(Object.hasOwn(download.rows[0], field), false);
  }
});
