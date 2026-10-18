import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test, { after, before, beforeEach } from "node:test";
import { CollectionStore, sourceFamilies } from "@pick-your-ai/ingestion";
import {
  prepareReconciliationPlan,
  reconciliationContextDigest,
  reconciliationRunId,
} from "../src/reconciliation-plan.mjs";
import { leastReconciliationTime, readReconciliationProgress } from "../src/reconciliation-progress.mjs";

const require = createRequire(new URL("../../../packages/ingestion/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cutoff = "2026-10-18T12:00:00.000Z";
const at = (minutes) => new Date(Date.parse(cutoff) + minutes * 60000).toISOString();
const tokenFor = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const scan = {
  key: hash("synthetic-progress-policy"),
  contextHash: hash("synthetic-progress-source-context"),
  token: tokenFor(1),
  cutoff,
  sources: [{ repositoryId: 2, generation: "1" }],
};
const contextDigest = reconciliationContextDigest(scan);
const repositories = [{ id: 2, installationId: 1, families: ["issues"] }];
const integrity = /^Error: reconciliation_progress_integrity_error$/;
let engine;
let db;
let collection;
let serial;

before(async () => {
  engine = new PGlite();
  db = { query: (sql, values) => engine.query(sql, values), transaction: (work) => engine.transaction(work) };
  for (const name of ["001_ingestion.up.sql", "002_snapshots.up.sql", "003_collection.up.sql"])
    await engine.exec(await readFile(new URL(`../../../packages/ingestion/sql/${name}`, import.meta.url), "utf8"));
  collection = new CollectionStore(db);
});
after(async () => engine?.close());

async function reset() {
  await engine.exec("TRUNCATE leaderboard_ingestion.repository_access,leaderboard_ingestion.collection_runs CASCADE");
  for (const id of [2, 10])
    await engine.query(
      "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES($1,1,'public')",
      [id],
    );
  serial = 1;
}
beforeEach(reset);

async function insertRun(overrides = {}) {
  const run = {
    runId: reconciliationRunId(contextDigest, tokenFor(serial++), 0, 1),
    repositoryId: 2,
    family: "issues",
    mode: "audit",
    since: null,
    until: at(-60),
    cursor: null,
    pageCount: 1,
    itemCount: 1,
    expectedCount: 1,
    state: "complete",
    reason: null,
    lastSuccess: at(-59),
    attemptedAt: at(-59),
    generation: "1",
    ...overrides,
  };
  await engine.query(
    `INSERT INTO leaderboard_ingestion.collection_runs
      (run_id,repository_id,family,mode,since_at,until_at,cursor,page_count,item_count,
       expected_count,state,reason,last_success_at,attempted_at,access_generation)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      run.runId,
      run.repositoryId,
      run.family,
      run.mode,
      run.since,
      run.until,
      run.cursor,
      run.pageCount,
      run.itemCount,
      run.expectedCount,
      run.state,
      run.reason,
      run.lastSuccess,
      run.attemptedAt,
      run.generation,
    ],
  );
  return run;
}
const progress = (options = {}) =>
  readReconciliationProgress(db, options.repositories ?? repositories, options.observationCutoff ?? cutoff, {
    contextDigest,
    ...options.settings,
  });
const one = async (options) => (await progress(options))[0];
const watermarks = (row) => [row.lastFullAuditAt, row.reconciledThrough, row.lastSuccessfulSync];

test("an exact completed full audit records its event cutoff separately from its observation time", async () => {
  await insertRun();
  const result = await one();
  assert.deepEqual(watermarks(result), [at(-60), at(-60), at(-59)]);
  assert.equal(result.generation, "1");
  assert.equal(result.state, "complete");
  assert.equal(result.itemCount, 1);
  assert.equal(result.expectedCount, 1);
  assert.equal(result.pageCount, 1);
});

test("overlapping, nested and boundary-touching intervals advance only the connected exact-count chain", async () => {
  await insertRun();
  // Insert out of event-time order; the nested interval must not shorten the chain.
  for (const [since, until] of [
    [-30, -20],
    [-60, -45],
    [-42, -38],
    [-50, -30],
  ])
    await insertRun({ mode: "reconcile", since: at(since), until: at(until), lastSuccess: at(-1) });
  assert.deepEqual(watermarks(await one()), [at(-60), at(-20), at(-1)]);
});

test("a successful disjoint suffix cannot bridge a gap until a real overlapping receipt arrives", async () => {
  await insertRun();
  for (const [since, until] of [
    [-40, -10],
    [-70, -50],
    [-30, -5],
  ])
    await insertRun({ mode: "reconcile", since: at(since), until: at(until), lastSuccess: at(-1) });
  assert.equal((await one()).reconciledThrough, at(-50));
  await insertRun({ mode: "reconcile", since: at(-50), until: at(-40), lastSuccess: at(-1) });
  assert.equal((await one()).reconciledThrough, at(-5));
});

test("a newer exact full audit establishes a new baseline without borrowing an earlier gap", async () => {
  await insertRun();
  await insertRun({ mode: "reconcile", since: at(-30), until: at(-10), lastSuccess: at(-1) });
  assert.equal((await one()).reconciledThrough, at(-60));
  await insertRun({ until: at(-20), lastSuccess: at(-2) });
  assert.deepEqual(watermarks(await one()), [at(-20), at(-10), at(-1)]);
});

test("recent-only successes retain unknown coverage until an exact full-audit baseline exists", async () => {
  await insertRun({ mode: "reconcile", since: at(-60), until: at(-10), lastSuccess: at(-1) });
  assert.deepEqual(watermarks(await one()), [null, null, at(-1)]);
});

test("completed unknown-count full scans rotate across audit-only pairs without inventing coverage", async () => {
  const repos = [{ id: 2, installationId: 1, families: ["commits", "releases"] }];
  const policy = { lookbackMs: 86400000, overlapMs: 60000, fullAuditsPerCycle: 1 };
  const selected = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const current = { ...scan, token: tokenFor(100 + cycle), cutoff: at(-10 + cycle) };
    const plan = await db.transaction((tx) =>
      prepareReconciliationPlan(tx, {
        scan: current,
        repositories: repos,
        policy,
        fresh: true,
        startInTransaction: (session, request) => collection.startInTransaction(session, request),
        readProgress: readReconciliationProgress,
      }),
    );
    assert.equal(plan.length, 1);
    selected.push(plan[0].family);
    // Synthetic terminal receipts use the actual plan rows and a fixed observation clock.
    await engine.query(
      `UPDATE leaderboard_ingestion.collection_runs SET state='complete',cursor=NULL,
        page_count=1,item_count=0,expected_count=NULL,last_success_at=$2,attempted_at=$2 WHERE run_id=$1`,
      [plan[0].runId, new Date(Date.parse(current.cutoff) + 1000).toISOString()],
    );
  }
  assert.deepEqual(selected, ["commits", "releases", "commits", "releases"]);
  const result = await progress({ repositories: repos });
  assert.deepEqual(
    result.map((row) => row.lastFullAuditAt),
    [at(-8), at(-7)],
  );
  assert.ok(result.every((row) => row.lastSuccessfulSync !== null));
  assert.ok(result.every((row) => row.reconciledThrough === null && row.expectedCount === null));
  assert.equal(leastReconciliationTime(result.map((row) => row.reconciledThrough)), null);
});

test("an unknown-count newer full audit rotates but cannot replace an earlier exact coverage baseline", async () => {
  await insertRun();
  await insertRun({ until: at(-10), lastSuccess: at(-1), expectedCount: null });
  assert.deepEqual(watermarks(await one()), [at(-10), at(-60), at(-1)]);
});

test("an unknown-count recent interval records a successful traversal without bridging coverage", async () => {
  await insertRun();
  const bridge = await insertRun({
    mode: "reconcile",
    since: at(-70),
    until: at(-50),
    lastSuccess: at(-1),
    expectedCount: null,
  });
  await insertRun({ mode: "reconcile", since: at(-50), until: at(-10), lastSuccess: at(-2) });
  assert.deepEqual(watermarks(await one()), [at(-60), at(-60), at(-1)]);
  // This synthetic correction supplies the previously unknown exact count; it is
  // not inferred from a later successful interval or the end of pagination.
  await engine.query("UPDATE leaderboard_ingestion.collection_runs SET expected_count=item_count WHERE run_id=$1", [
    bridge.runId,
  ]);
  assert.deepEqual(watermarks(await one()), [at(-60), at(-10), at(-1)]);
});

test("pending, failed, unread, open-cursor and mismatched-count receipts do not advance progress", async () => {
  for (const patch of [
    { state: "pending" },
    { state: "failed", reason: "source_read_failed" },
    { pageCount: 0 },
    { cursor: "synthetic-next-page" },
    { expectedCount: 2 },
    { lastSuccess: null },
    { lastSuccess: "infinity" },
  ]) {
    await reset();
    await insertRun(patch);
    assert.deepEqual(watermarks(await one()), [null, null, null], JSON.stringify(patch));
  }
});

test("completion before the saved event cutoff proves neither a full audit nor a recent interval", async () => {
  for (const mode of ["audit", "reconcile"]) {
    await reset();
    await insertRun({ mode, since: mode === "audit" ? null : at(-70), lastSuccess: "2026-10-18T10:59:59.999999Z" });
    assert.deepEqual(watermarks(await one()), [null, null, null], mode);
  }
});

test("native microsecond completion bounds are applied before millisecond projection", async () => {
  await insertRun({ lastSuccess: "2026-10-18T12:00:00.000001Z" });
  assert.deepEqual(watermarks(await one()), [null, null, null]);
  await reset();
  await insertRun({ lastSuccess: cutoff });
  assert.deepEqual(watermarks(await one()), [at(-60), at(-60), cutoff]);
  await reset();
  await insertRun({ lastSuccess: "2026-10-18T11:59:59.999999Z" });
  assert.deepEqual(watermarks(await one()), [at(-60), at(-60), "2026-10-18T11:59:59.999Z"]);
});

test("a separate saved event bound excludes later completed windows", async () => {
  await insertRun();
  await insertRun({ until: at(-10), lastSuccess: at(-1) });
  const result = await one({ settings: { untilCutoff: at(-30) } });
  assert.deepEqual(watermarks(result), [at(-60), at(-60), at(-59)]);
  assert.equal(result.lastWindowEnd, at(-60));
  await assert.rejects(progress({ settings: { untilCutoff: at(1) } }), integrity);
});

test("latest state, counters and event bound refer to one observed row while pending work remains visible", async () => {
  await insertRun();
  await insertRun({ until: at(-10), state: "failed", reason: "source_read_failed", attemptedAt: at(-1), itemCount: 2 });
  await insertRun({ until: at(1), attemptedAt: cutoff, itemCount: 3 });
  await insertRun({ until: at(-5), attemptedAt: "2026-10-18T12:00:00.000001Z", itemCount: 4 });
  let result = await one();
  assert.deepEqual(
    [result.state, result.reason, result.itemCount, result.lastAttemptAt, result.lastWindowEnd],
    ["failed", "source_read_failed", 2, at(-1), at(-10)],
  );
  await insertRun({
    until: cutoff,
    state: "pending",
    attemptedAt: null,
    lastSuccess: null,
    pageCount: 0,
    itemCount: 0,
    expectedCount: null,
  });
  result = await one();
  assert.deepEqual(
    [result.state, result.itemCount, result.lastAttemptAt, result.lastWindowEnd],
    ["pending", 0, null, cutoff],
  );
  assert.equal(result.reconciledThrough, at(-60));
});

test("latest completion cannot borrow an older same-cutoff baseline when its own traversal is invalid", async () => {
  for (const patch of [
    { cursor: "synthetic-unread-page" },
    { pageCount: 0 },
    { lastSuccess: null },
    { lastSuccess: "2026-10-18T10:59:59.999999Z" },
    { lastSuccess: "2026-10-18T12:00:00.000001Z" },
    { expectedCount: 2 },
    { state: "failed" },
  ]) {
    await reset();
    await insertRun();
    assert.equal((await one()).windowComplete, true);
    await insertRun({ attemptedAt: at(-1), ...patch });
    const result = await one();
    assert.equal(result.lastWindowEnd, at(-60));
    assert.equal(result.reconciledThrough, at(-60));
    assert.equal(result.lastAttemptAt, at(-1));
    assert.equal(result.windowComplete, false, JSON.stringify(patch));
  }
  await reset();
  await insertRun({ expectedCount: null });
  const unknown = await one();
  assert.equal(unknown.windowComplete, true);
  assert.equal(unknown.reconciledThrough, null);
  assert.equal(unknown.expectedCount, null);
});

test("reserved reconciliation metadata rejects unsupported recent families instead of proving an impossible window", async () => {
  for (const family of sourceFamilies.filter(
    (value) => !["issues", "comments", "project_history", "relationships"].includes(value),
  )) {
    await reset();
    await insertRun({ family });
    await insertRun({ family, mode: "reconcile", since: at(-60), until: at(-10), lastSuccess: at(-1) });
    await assert.rejects(
      progress({ repositories: [{ id: 2, installationId: 1, families: [family] }] }),
      integrity,
      family,
    );
  }
});

test("malformed reserved IDs and noncanonical or inconsistent window precision fail closed", async () => {
  const valid = reconciliationRunId(contextDigest, tokenFor(50), 0, 1);
  for (const patch of [
    { runId: valid.replace(":0000:0001", ":0000:0000") },
    { runId: valid.replace(":0000:0001", ":0001:0001") },
    { runId: valid.replace(":0000:0001", ":0000:1201") },
    { runId: valid.replace(":0000:0001", ":0:0001") },
    { runId: `rc1:${contextDigest}:invalid` },
    { mode: "backfill" },
    { since: at(-70) },
    { mode: "reconcile" },
    { mode: "reconcile", since: at(-60) },
    { mode: "reconcile", since: at(-59) },
    { until: "2026-10-18T11:00:00.000001Z" },
    { mode: "reconcile", since: "2026-10-18T10:00:00.000001Z" },
    { until: "infinity" },
    { mode: "reconcile", since: "-infinity" },
  ]) {
    await reset();
    await insertRun(patch);
    await assert.rejects(progress(), integrity, JSON.stringify(patch));
  }
});

test("legacy, other-context and old-generation records cannot supply or corrupt current progress", async () => {
  await insertRun();
  for (const patch of [
    { runId: "synthetic-legacy-completed", mode: "backfill" },
    { runId: `rc1:${hash("synthetic-other-context")}:malformed` },
    { runId: `rc1:${contextDigest}:malformed-old-generation`, generation: "2" },
  ])
    await insertRun({ until: "infinity", ...patch });
  assert.deepEqual(watermarks(await one()), [at(-60), at(-60), at(-59)]);
  await engine.query("UPDATE leaderboard_ingestion.repository_access SET generation=3 WHERE repository_id=2");
  assert.deepEqual(watermarks(await one()), [null, null, null]);
  assert.equal((await one()).generation, "3");
});

test("repository, family, installation and current public-access boundaries remain separate", async () => {
  await insertRun();
  await insertRun({ repositoryId: 10, until: at(-20), lastSuccess: at(-19) });
  await insertRun({ family: "comments", until: at(-40), lastSuccess: at(-39) });
  const repos = [
    { id: 10, installationId: 1, families: ["issues"] },
    { id: 2, installationId: 1, families: ["issues", "comments", "commits"] },
  ];
  const result = await progress({ repositories: repos });
  assert.deepEqual(
    result.map((row) => [row.repositoryId, row.family, row.reconciledThrough]),
    [
      [2, "comments", at(-40)],
      [2, "commits", null],
      [2, "issues", at(-60)],
      [10, "issues", at(-20)],
    ],
  );
  assert.equal(leastReconciliationTime(result.map((row) => row.reconciledThrough)), null);
  assert.deepEqual(watermarks(await one({ repositories: [{ ...repositories[0], installationId: 2 }] })), [
    null,
    null,
    null,
  ]);
  for (const state of ["unavailable", "excluded", "onboarding"]) {
    await engine.query("UPDATE leaderboard_ingestion.repository_access SET state=$1 WHERE repository_id=2", [state]);
    const row = await one();
    assert.equal(row.generation, null);
    assert.deepEqual(watermarks(row), [null, null, null]);
  }
});

test("negative retained counters fail integrity rather than reaching health output", async () => {
  for (const patch of [{ itemCount: -1 }, { expectedCount: -1 }, { pageCount: -1 }]) {
    await reset();
    await insertRun(patch);
    await assert.rejects(progress(), integrity);
  }
});

test("an actual completed empty source page is a known zero baseline, unlike an unread plan row", async () => {
  const until = new Date(Date.now() - 5000).toISOString();
  const request = {
    runId: reconciliationRunId(contextDigest, tokenFor(200), 0, 1),
    repositoryId: 2,
    family: "issues",
    mode: "audit",
    since: null,
    until,
  };
  await collection.start(request);
  let observation = new Date(Date.now() + 1000).toISOString();
  assert.deepEqual(watermarks(await one({ observationCutoff: observation })), [null, null, null]);
  let reads = 0;
  assert.equal(
    await collection.step(request.runId, {
      readPage: async (actual) => {
        reads++;
        assert.deepEqual(actual, { ...request, cursor: null, limit: 100 });
        return { repositoryId: 2, visibility: "public", facts: [], nextCursor: null, expectedCount: 0 };
      },
    }),
    "complete",
  );
  observation = new Date(Date.now() + 1000).toISOString();
  const result = await one({ observationCutoff: observation });
  assert.equal(reads, 1);
  assert.equal(result.lastFullAuditAt, until);
  assert.equal(result.reconciledThrough, until);
  assert.equal(result.itemCount, 0);
  assert.equal(result.expectedCount, 0);
  assert.equal(result.pageCount, 1);
  assert.ok(result.lastSuccessfulSync >= until && result.lastSuccessfulSync <= observation);
  const pages = (
    await engine.query(
      "SELECT page_number,item_count,changed_count FROM leaderboard_ingestion.collection_pages WHERE run_id=$1",
      [request.runId],
    )
  ).rows;
  assert.deepEqual(pages, [{ page_number: 1, item_count: 0, changed_count: 0 }]);
});

test("all-family progress uses the oldest established bound and never mutates its input", () => {
  const values = [at(-10), at(-60), at(-30)];
  assert.equal(leastReconciliationTime(values), at(-60));
  assert.deepEqual(values, [at(-10), at(-60), at(-30)]);
  assert.equal(leastReconciliationTime([at(-10), null]), null);
  assert.equal(leastReconciliationTime([]), null);
});
