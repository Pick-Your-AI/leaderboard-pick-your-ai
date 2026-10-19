import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as protocol from "@pick-your-ai/ingestion";
import { readReconciliationProgress } from "../src/reconciliation-progress.mjs";
import { reconciliationRunId } from "../src/reconciliation-plan.mjs";
import { readCurrentSourceHealth } from "../src/source-health.mjs";
import { readOperatorHealth } from "../src/operator-health.mjs";

const require = createRequire(new URL("../../../packages/ingestion/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const contextDigest = "a".repeat(64);
const repository = { id: 2, installationId: 1, families: ["issues", "comments"] };
const instant = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const asOf = instant(60);
let engine, sequence;

before(async () => {
  engine = new PGlite();
  for (const name of [
    "001_ingestion.up.sql",
    "002_snapshots.up.sql",
    "003_collection.up.sql",
    "004_outbox_dispatch.up.sql",
  ])
    await engine.exec(await readFile(new URL(`../../../packages/ingestion/sql/${name}`, import.meta.url), "utf8"));
});
after(async () => engine?.close());
beforeEach(async () => {
  sequence = 0;
  await engine.exec("TRUNCATE leaderboard_ingestion.repository_access,leaderboard_ingestion.collection_runs CASCADE");
  await engine.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(2,1,'public')",
  );
});

async function retain({
  family = "issues",
  since = null,
  until = 10,
  success = until + 1,
  attempt = success,
  expected = 0,
  items = 0,
  pages = 1,
  cursor = null,
  state = "complete",
  reason = null,
  context = contextDigest,
  generation = "1",
} = {}) {
  const token = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const runId = reconciliationRunId(context, token, 0, 1);
  await engine.query(
    `INSERT INTO leaderboard_ingestion.collection_runs
      (run_id,repository_id,family,mode,since_at,until_at,state,cursor,page_count,item_count,expected_count,
       last_success_at,attempted_at,reason,access_generation)
      VALUES($1,2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      runId,
      family,
      since === null ? "audit" : "reconcile",
      since === null ? null : instant(since),
      instant(until),
      state,
      cursor,
      pages,
      items,
      expected,
      success === null ? null : instant(success),
      attempt === null ? null : instant(attempt),
      reason,
      generation,
    ],
  );
  return runId;
}

async function views(generation = "1") {
  return engine.transaction(async (tx) => {
    const progress = await readReconciliationProgress(tx, [repository], asOf, { contextDigest });
    const publicHealth = (await readCurrentSourceHealth(tx, [repository], asOf, progress))[0];
    const privateHealth = (
      await readOperatorHealth(tx, {
        scope: { repositoryId: 2, installationId: "1", generation },
        repository,
        asOf,
        freshnessBudgetSeconds: 120,
        protocol,
        readQuota: async () => null,
        verifyPublications: async () => null,
        reconciliationProgress: progress,
      })
    ).health;
    return { progress, publicHealth, privateHealth };
  });
}

test("both health surfaces use the least verified family watermark and actual successful observation clocks", async () => {
  await retain();
  await retain({ family: "comments", until: 20 });
  await retain({ since: 9, until: 30 });
  const { publicHealth, privateHealth } = await views();
  assert.equal(publicHealth.state, "no_activity_in_window");
  assert.equal(publicHealth.reconciledThrough, instant(20));
  assert.equal(publicHealth.lastSuccessfulSync, instant(21));
  assert.equal(privateHealth.collector.state, "quiet");
  const issues = privateHealth.collector.families.find((row) => row.family === "issues");
  assert.equal(issues.reconciledThrough, instant(30));
  assert.equal(issues.lastSuccessAt, instant(31));
  assert.equal(issues.reason, "completed_empty_window");
  assert.notEqual(publicHealth.reconciledThrough, asOf);
});

test("a completed disjoint window stays unknown with its earlier watermark until an exact bridge closes the gap", async () => {
  await retain();
  await retain({ family: "comments", until: 30 });
  await retain({ since: 20, until: 40 });
  let result = await views();
  assert.equal(result.publicHealth.state, "unknown");
  assert.equal(result.publicHealth.reconciledThrough, instant(10));
  let issues = result.privateHealth.collector.families.find((row) => row.family === "issues");
  assert.equal(issues.state, "unknown");
  assert.equal(issues.reason, "reconciliation_gap");
  assert.equal(issues.reconciledThrough, instant(10));
  assert.equal(issues.lastSuccessAt, instant(41));
  await retain({ since: 9, until: 25, success: 50 });
  result = await views();
  assert.equal(result.publicHealth.state, "no_activity_in_window");
  assert.equal(result.publicHealth.reconciledThrough, instant(30));
  issues = result.privateHealth.collector.families.find((row) => row.family === "issues");
  assert.equal(issues.reconciledThrough, instant(40));
  assert.equal(issues.reason, "completed_empty_window");
});

test("unknown totals retain successful traversal clocks without inventing a complete family baseline", async () => {
  await retain({ expected: null });
  await retain({ family: "comments", until: 20 });
  const { progress, publicHealth, privateHealth } = await views();
  assert.equal(progress.find((row) => row.family === "issues").lastFullAuditAt, instant(10));
  assert.equal(publicHealth.lastSuccessfulSync, instant(11));
  assert.equal(publicHealth.reconciledThrough, null);
  assert.equal(publicHealth.state, "unknown");
  const issues = privateHealth.collector.families.find((row) => row.family === "issues");
  assert.equal(issues.reason, "completion_time_unknown");
  assert.equal(issues.lastSuccessAt, instant(11));
  assert.equal(issues.reconciledThrough, null);
  assert.equal(issues.expectedItems, null);
});

test("a malformed newest completion cannot borrow an older same-cutoff proof to claim a quiet source", async () => {
  await retain();
  await retain({ family: "comments", until: 20 });
  await retain({ until: 10, success: 50, cursor: "synthetic-next-page" });
  const { progress, publicHealth, privateHealth } = await views();
  assert.equal(progress.find((row) => row.family === "issues").windowComplete, false);
  assert.equal(publicHealth.reconciledThrough, instant(10));
  assert.equal(publicHealth.state, "unknown");
  const issues = privateHealth.collector.families.find((row) => row.family === "issues");
  assert.equal(issues.state, "unknown");
  assert.equal(issues.reason, "no_current_attempt");
  assert.equal(issues.lastSuccessAt, instant(11));
});

test("a later failure remains visible while older completed watermarks remain literal", async () => {
  await retain();
  await retain({ family: "comments", until: 20 });
  await retain({ until: 40, state: "failed", success: null, attempt: 41, pages: 0, reason: "source_read_failed" });
  const { publicHealth, privateHealth } = await views();
  assert.equal(publicHealth.state, "degraded");
  assert.equal(publicHealth.reconciledThrough, instant(10));
  const issues = privateHealth.collector.families.find((row) => row.family === "issues");
  assert.equal(issues.state, "disconnected");
  assert.equal(issues.reason, "source_read_failed");
  assert.equal(issues.lastSuccessAt, instant(11));
});

test("other contexts and previous access generations cannot supply current health coverage", async () => {
  await retain({ context: "b".repeat(64), until: 40 });
  await retain({ family: "comments", context: "b".repeat(64), until: 40 });
  let result = await views();
  assert.equal(result.publicHealth.state, "unknown");
  assert.equal(result.publicHealth.reconciledThrough, null);
  await retain();
  await retain({ family: "comments", until: 20 });
  await engine.query("UPDATE leaderboard_ingestion.repository_access SET generation=2 WHERE repository_id=2");
  result = await views("2");
  assert.equal(result.publicHealth.state, "unknown");
  assert.equal(result.publicHealth.lastSuccessfulSync, null);
  assert.ok(result.privateHealth.collector.families.every((row) => row.reason === "no_current_attempt"));
});
