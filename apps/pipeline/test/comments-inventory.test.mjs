import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test, { before, beforeEach, after } from "node:test";
import { CollectionStore } from "@pick-your-ai/ingestion";
import {
  githubCommentsContext,
  expandedGithubCommentsRun,
  startGithubCommentsRun,
} from "../src/comments-inventory.mjs";
import { ScanContinuationStore, ScanSupersededError, scanContinuationSchema } from "../src/scan-continuation.mjs";
import { reconciliationContextDigest, reconciliationRunId } from "../src/reconciliation-plan.mjs";
import { readReconciliationProgress } from "../src/reconciliation-progress.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
const require = createRequire(new URL("../../../packages/ingestion/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cutoff = "2026-10-01T12:00:00.000Z";
const slug = "synthetic-owner/repository";
const repository = { id: 2, installationId: 1, slug, families: ["comments"] };
const request = (value = "synthetic-operation") => ({
  runId: hash(value),
  repositoryId: 2,
  family: "comments",
  mode: "audit",
  since: null,
  until: cutoff,
});
const comment = (id, inline = false) => ({
  id,
  node_id: (inline ? "PRRC_" : "IC_") + id,
  url: `https://api.github.com/repos/${slug}/${inline ? "pulls" : "issues"}/comments/${id}`,
  html_url: `https://github.com/${slug}/pull/7#${inline ? "discussion_r" : "issuecomment-"}${id}`,
  ...(inline
    ? { pull_request_url: `https://api.github.com/repos/${slug}/pulls/7` }
    : { issue_url: `https://api.github.com/repos/${slug}/issues/7` }),
  created_at: cutoff,
  updated_at: cutoff,
});
let engine, db, collection;
before(async () => {
  engine = new PGlite();
  db = { query: (sql, values) => engine.query(sql, values), transaction: (work) => engine.transaction(work) };
  for (const name of ["001_ingestion.up.sql", "002_snapshots.up.sql", "003_collection.up.sql"])
    await engine.exec(await readFile(new URL(`../../../packages/ingestion/sql/${name}`, import.meta.url), "utf8"));
  await engine.exec(
    "CREATE SCHEMA leaderboard_pipeline; CREATE TABLE leaderboard_pipeline.heads(scope_key text PRIMARY KEY,snapshot_id text NOT NULL)",
  );
  await engine.exec(scanContinuationSchema);
  collection = new CollectionStore(db);
});
after(async () => engine?.close());
beforeEach(async () => {
  await engine.exec(
    "TRUNCATE leaderboard_pipeline.scan_continuations,leaderboard_ingestion.repository_access,leaderboard_ingestion.collection_runs CASCADE",
  );
  await engine.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(2,1,'public')",
  );
});
const select = (input = request(), guard = () => {}) => startGithubCommentsRun(db, collection, input, guard);
const saved = async (runId) =>
  (await db.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [runId])).rows[0];
const source = (calls) =>
  createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    includePullRequestReviewComments: ({ runId }) => expandedGithubCommentsRun(runId),
    client: syntheticRepositoryClient(2, {
      async rest(_source, path) {
        assert.equal(path, `/repos/${slug}`);
        return { id: 2, private: false, full_name: slug };
      },
      async scanRest(options) {
        calls.push(options.url);
        return options.url.includes("/pulls/comments") ? [comment(10, true)] : [comment(10), comment(11)];
      },
    }),
  });

test("an already completed old operation stays literal and causes no new source I/O", async () => {
  const old = request();
  await collection.start(old);
  const calls = [];
  assert.equal(await collection.step(old.runId, source(calls), 100), "complete");
  const before = await saved(old.runId);
  const reopened = new CollectionStore(db);
  const chosen = await startGithubCommentsRun(db, reopened, old, () => {});
  assert.deepEqual(chosen, old);
  assert.equal(
    await reopened.step(chosen.runId, {
      readPage() {
        throw new Error("completed old operation must not recollect");
      },
    }),
    "complete",
  );
  assert.deepEqual(await saved(old.runId), before);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.collection_runs")).rows[0].n, 1);
  assert.ok(calls.every((path) => path.includes("/issues/comments")));
});

test("a pending old nonzero cursor and known count resumes only the old inventory", async () => {
  const old = request();
  await collection.start(old);
  const calls = [];
  assert.equal(await collection.step(old.runId, source(calls), 1), "progress");
  const before = await saved(old.runId);
  assert.equal(before.cursor, "1");
  assert.equal(before.expected_count, 2);
  const chosen = await select(old);
  assert.deepEqual(await saved(old.runId), before);
  assert.equal(await new CollectionStore(db).step(chosen.runId, source(calls), 1), "complete");
  const final = await saved(old.runId);
  assert.equal(final.item_count, 2);
  assert.equal(final.expected_count, 2);
  assert.ok(calls.every((path) => path.includes("/issues/comments")));
});

test("a fresh run pins both inventories and keeps its v2 choice if a legacy row later appears", async () => {
  const old = request();
  const chosen = await select(old);
  assert.equal(chosen.runId, "gc2:" + old.runId);
  const calls = [];
  assert.equal(await collection.step(chosen.runId, source(calls), 100), "complete");
  await collection.start(old);
  assert.deepEqual(await select(old), chosen);
  const row = await saved(chosen.runId);
  assert.equal(row.expected_count, 3);
  assert.equal(row.item_count, 3);
  const facts = (
    await db.query("SELECT subject_id,source_revision FROM leaderboard_ingestion.source_facts ORDER BY subject_id")
  ).rows;
  assert.deepEqual(
    facts.map((fact) => fact.subject_id),
    ["IC_10", "IC_11", "PRRC_10"],
  );
  assert.deepEqual(
    facts.map((fact) => [fact.subject_id, fact.source_revision.split(":")[0]]),
    [
      ["IC_10", "gh-rest-v1"],
      ["IC_11", "gh-rest-v1"],
      ["PRRC_10", "gh-rest-comment-v2"],
    ],
  );
  assert.ok(calls.some((path) => path.includes("/pulls/comments")));
});

test("a conflicting or failed legacy operation cannot be bypassed by allocating v2", async () => {
  const old = request();
  await collection.start(old);
  await assert.rejects(select({ ...old, until: "2026-10-02T12:00:00.000Z" }), /scan_id_conflict/);
  assert.equal(await saved("gc2:" + old.runId), undefined);
  await db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET state='failed',reason='source_unavailable' WHERE run_id=$1",
    [old.runId],
  );
  const before = await saved(old.runId);
  assert.deepEqual(await select(old), old);
  assert.deepEqual(await saved(old.runId), before);
});

test("authorization loss rolls back new inventory selection and revoked source remains unavailable", async () => {
  let calls = 0;
  await assert.rejects(
    select(request(), () => {
      if (++calls === 3) throw new Error("synthetic grant withdrawn");
    }),
    /grant withdrawn/,
  );
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.collection_runs")).rows[0].n, 0);
  await db.query(
    "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1 WHERE repository_id=2",
  );
  await assert.rejects(select(), /repository_unverified/);
});

test("default comments changes only the scheduled context and replaces a pending token under the existing key", async () => {
  const parts = [3, null, [{ repositoryId: 2, generation: "1" }]];
  assert.equal(githubCommentsContext(parts, false), parts);
  assert.deepEqual(githubCommentsContext(parts, false), parts);
  const old = { key: hash("same approved configuration"), contextHash: hash(parts), cutoff, sources: parts[2] };
  const current = { ...old, contextHash: hash(githubCommentsContext(parts, true)) };
  const store = new ScanContinuationStore(db);
  const before = await store.claim(
    old,
    () => {},
    () => cutoff,
    () => [],
  );
  const after = await store.claim(
    current,
    () => {},
    () => "2026-10-02T12:00:00.000Z",
    () => [],
  );
  assert.equal(after.key, before.key);
  assert.notEqual(after.token, before.token);
  assert.notEqual(reconciliationContextDigest(after), reconciliationContextDigest(before));
  await assert.rejects(
    store.freeze(before, "2026-10-03T12:00:00.000Z", () => {}),
    ScanSupersededError,
  );
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.scan_continuations")).rows[0].n, 1);
});

test("an exact completed old comments audit cannot establish expanded inventory coverage", async () => {
  const parts = [3, null, [{ repositoryId: 2, generation: "1" }]];
  const old = { key: hash("same approved configuration"), contextHash: hash(parts) };
  const current = { ...old, contextHash: hash(githubCommentsContext(parts, true)) };
  const oldContext = reconciliationContextDigest(old),
    currentContext = reconciliationContextDigest(current);
  const id = reconciliationRunId(oldContext, "00000000-0000-4000-8000-000000000001", 0, 1);
  await collection.start({ ...request(), runId: id });
  await db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET state='complete',page_count=1,item_count=2,expected_count=2,last_success_at=$2,attempted_at=$2 WHERE run_id=$1",
    [id, "2026-10-02T12:00:00.000Z"],
  );
  const prior = await readReconciliationProgress(db, [repository], "2026-10-03T12:00:00.000Z", {
    contextDigest: oldContext,
    untilCutoff: "2026-10-03T12:00:00.000Z",
  });
  assert.equal(prior[0].reconciledThrough, cutoff);
  const next = await readReconciliationProgress(db, [repository], "2026-10-03T12:00:00.000Z", {
    contextDigest: currentContext,
    untilCutoff: "2026-10-03T12:00:00.000Z",
  });
  assert.equal(next[0].reconciledThrough, null);
  assert.equal(next[0].lastFullAuditAt, null);
});

test("reserved malformed run identities never select another inventory", () => {
  const old = request().runId;
  assert.equal(expandedGithubCommentsRun(old), false);
  assert.equal(expandedGithubCommentsRun("gc2:" + old), true);
  for (const invalid of ["gc2:", "gc2:" + old + "x", "gc2:" + old.toUpperCase(), "rc1:bad", null])
    assert.throws(() => expandedGithubCommentsRun(invalid));
});

test("retained inventory selection does not invert the collection repository-before-run lock order", async () => {
  const old = request();
  await collection.start(old);
  let observedSourceLock = false;
  const orderingDb = {
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          async query(sql, values) {
            if (sql.includes("repository_access") && /FOR SHARE|FOR UPDATE/.test(sql)) observedSourceLock = true;
            if (sql.includes("collection_runs") && /FOR UPDATE/.test(sql) && !observedSourceLock)
              throw new Error("synthetic opposing collection lock order");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  const chosen = await startGithubCommentsRun(orderingDb, collection, old, () => {});
  assert.deepEqual(chosen, old);
  assert.equal(observedSourceLock, true);
});
