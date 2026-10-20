import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test, { before, beforeEach, after } from "node:test";
import { CollectionStore } from "@pick-your-ai/ingestion";
import { githubCommentsContext } from "../src/comments-inventory.mjs";
import {
  createGithubContentEditAdmission,
  githubContentEditsContext,
  startGithubContentEditRun,
} from "../src/content-edit-inventory.mjs";
import { ScanContinuationStore, ScanSupersededError, scanContinuationSchema } from "../src/scan-continuation.mjs";
import {
  prepareReconciliationPlan,
  reconciliationContextDigest,
  reconciliationRunId,
} from "../src/reconciliation-plan.mjs";
import { readReconciliationProgress } from "../src/reconciliation-progress.mjs";
import { repository } from "../../../tests/fixtures/content-edit-metadata.mjs";

const require = createRequire(new URL("../../../packages/ingestion/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cutoff = "2026-10-01T12:00:00.000Z";
const request = (label = "synthetic-content-edit-operation") => ({
  runId: hash(label),
  repositoryId: repository.id,
  family: "content_edits",
  mode: "audit",
  since: null,
  until: cutoff,
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
const select = (input = request(), guard = () => {}) => startGithubContentEditRun(db, collection, input, guard);
const saved = async (runId) =>
  (await db.query("SELECT * FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [runId])).rows[0];
const count = async () =>
  (await db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.collection_runs")).rows[0].n;
const empty = {
  readPage: async () => ({ repositoryId: 2, visibility: "public", facts: [], nextCursor: null, expectedCount: null }),
};

test("a completed legacy content run remains literal and does not gain metadata admission or new I/O", async () => {
  const old = request();
  await collection.start(old);
  assert.equal(await collection.step(old.runId, empty), "complete");
  const before = await saved(old.runId);
  const chosen = await startGithubContentEditRun(db, new CollectionStore(db), old, () => {});
  assert.deepEqual(chosen, old);
  const admission = createGithubContentEditAdmission();
  assert.equal(admission.recordSelected(chosen), false);
  assert.equal(admission.allows(chosen), false);
  assert.equal(
    await new CollectionStore(db).step(chosen.runId, {
      readPage() {
        throw new Error("must not recollect legacy completion");
      },
    }),
    "complete",
  );
  assert.deepEqual(await saved(old.runId), before);
  assert.equal(await count(), 1);
});

test("a retained pending cursor and failed legacy row are preserved without allocating a bypass run", async () => {
  const old = request();
  await collection.start(old);
  const source = {
    readPage: async () => ({
      repositoryId: 2,
      visibility: "public",
      nextCursor: "1",
      expectedCount: null,
      facts: [
        {
          subjectId: "I_SYNTHETIC_11",
          sourceRevision: "legacy-metadata-v0",
          sourceUrl: `https://github.com/${repository.slug}/issues/11`,
          evidence: "current_state",
          actorId: null,
          occurredAt: null,
          state: "present",
        },
      ],
    }),
  };
  assert.equal(await collection.step(old.runId, source, 1), "progress");
  const before = await saved(old.runId);
  assert.equal(before.cursor, "1");
  assert.deepEqual(await select(old), old);
  assert.deepEqual(await saved(old.runId), before);
  await db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET state='failed',reason='source_unavailable' WHERE run_id=$1",
    [old.runId],
  );
  const failed = await saved(old.runId);
  assert.deepEqual(await select(old), old);
  assert.deepEqual(await saved(old.runId), failed);
  assert.equal(await saved("gce1:" + old.runId), undefined);
});

test("new selections converge on one immutable namespace and retain it when an old-format row later appears", async () => {
  const original = request();
  const selections = await Promise.all([select(original), select(original)]);
  assert.deepEqual(selections[0], selections[1]);
  assert.equal(selections[0].runId, "gce1:" + original.runId);
  assert.equal(await count(), 1);
  assert.equal(Object.isFrozen(selections[0]), true);
  await collection.start(original);
  assert.deepEqual(await select(original), selections[0]);
  const admission = createGithubContentEditAdmission();
  assert.equal(admission.recordSelected(selections[0]), true);
  assert.equal(admission.allows(selections[0]), true);
  assert.equal(admission.allows({ ...selections[0], until: "2026-10-02T12:00:00.000Z" }), false);
  assert.equal(admission.allows({ ...selections[0], repositoryId: 3 }), false);
  admission.clear();
  assert.equal(admission.allows(selections[0]), false);
});

test("tuple conflicts and late authorization failure roll back rather than creating a new inventory", async () => {
  const old = request();
  await collection.start(old);
  await assert.rejects(select({ ...old, until: "2026-10-02T12:00:00.000Z" }), /scan_id_conflict/);
  assert.equal(await count(), 1);
  let calls = 0;
  await assert.rejects(
    select(request("late-grant"), () => {
      if (++calls === 3) throw new Error("synthetic grant withdrawn");
    }),
    /grant withdrawn/,
  );
  assert.equal(await count(), 1);
  await db.query(
    "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1 WHERE repository_id=2",
  );
  await assert.rejects(select(request("revoked")), /repository_unverified/);
  assert.equal(await count(), 1);
});

test("selection captures its tuple before awaits and preserves repository-before-run lock order", async () => {
  const input = request();
  let observedSourceLock = false;
  let changed = false;
  const orderingDb = {
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          async query(sql, values) {
            if (!changed) {
              changed = true;
              input.until = "2026-11-01T00:00:00.000Z";
              input.family = "comments";
            }
            if (sql.includes("repository_access") && /FOR SHARE|FOR UPDATE/.test(sql)) observedSourceLock = true;
            if (sql.includes("collection_runs") && /FOR UPDATE/.test(sql) && !observedSourceLock)
              throw new Error("synthetic inverted collection lock order");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  const chosen = await startGithubContentEditRun(orderingDb, collection, input, () => {});
  assert.equal(chosen.until, cutoff);
  assert.equal(chosen.family, "content_edits");
  assert.equal(observedSourceLock, true);
  const before = await saved(chosen.runId);
  await db.query("UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=2");
  assert.equal(await collection.step(chosen.runId, empty), "failed");
  assert.equal((await saved(chosen.runId)).access_generation, before.access_generation);
  assert.equal((await saved(chosen.runId)).page_count, 0);
});

test("content context composes after gc2 while disabled contexts and old exact-count coverage remain distinct", async () => {
  const parts = [3, null, [{ repositoryId: 2, generation: "1" }]];
  const comments = githubCommentsContext(parts, true);
  assert.equal(githubContentEditsContext(comments, false), comments);
  assert.deepEqual(githubContentEditsContext(comments, true), [...comments, "github-content-edits/metadata-v1"]);
  assert.deepEqual(comments, [...parts, "github-comments-inventory/v2"]);
  const old = { key: hash("synthetic-config"), contextHash: hash(comments), cutoff, sources: parts[2] };
  const current = { ...old, contextHash: hash(githubContentEditsContext(comments, true)) };
  const store = new ScanContinuationStore(db);
  const previous = await store.claim(
    old,
    () => {},
    () => cutoff,
    () => [],
  );
  const next = await store.claim(
    current,
    () => {},
    () => "2026-10-02T12:00:00.000Z",
    () => [],
  );
  assert.equal(next.key, previous.key);
  assert.notEqual(next.token, previous.token);
  await assert.rejects(
    store.freeze(previous, "2026-10-03T12:00:00.000Z", () => {}),
    ScanSupersededError,
  );
  const oldContext = reconciliationContextDigest(previous);
  const runId = reconciliationRunId(oldContext, previous.token, 0, 1);
  await collection.start({ ...request(), runId });
  await db.query(
    "UPDATE leaderboard_ingestion.collection_runs SET state='complete',page_count=1,item_count=2,expected_count=2,last_success_at=$2,attempted_at=$2 WHERE run_id=$1",
    [runId, "2026-10-02T12:00:00.000Z"],
  );
  const repositories = [{ ...repository, installationId: 1, families: ["content_edits"] }];
  const through = "2026-10-03T12:00:00.000Z";
  const before = await readReconciliationProgress(db, repositories, through, {
    contextDigest: oldContext,
    untilCutoff: through,
  });
  const after = await readReconciliationProgress(db, repositories, through, {
    contextDigest: reconciliationContextDigest(next),
    untilCutoff: through,
  });
  assert.equal(before[0].reconciledThrough, cutoff);
  assert.equal(after[0].reconciledThrough, null);
  assert.equal(after[0].lastFullAuditAt, null);
});

test("only exact materialized content audit tuples are admitted and the saved plan reseeds admission on resume", async () => {
  const parts = githubContentEditsContext(githubCommentsContext([3], true), true);
  const requested = {
    key: hash("synthetic-plan"),
    contextHash: hash(parts),
    cutoff,
    sources: [{ repositoryId: 2, generation: "1" }],
  };
  const repositories = [{ ...repository, installationId: 1, families: ["comments", "content_edits"] }];
  const policy = { lookbackMs: 86400000, overlapMs: 1000, fullAuditsPerCycle: 2 };
  const prepare = (tx, scan, { fresh }) =>
    prepareReconciliationPlan(tx, {
      scan,
      repositories,
      policy,
      fresh,
      startInTransaction: (session, selected) => collection.startInTransaction(session, selected),
      readProgress: readReconciliationProgress,
    });
  const scan = await new ScanContinuationStore(db).claim(
    requested,
    () => {},
    () => cutoff,
    () => [],
    prepare,
  );
  assert.equal(scan.plan.length, 2);
  const selected = scan.plan.find((entry) => entry.family === "content_edits");
  const admission = createGithubContentEditAdmission();
  assert.equal(admission.allows(selected), false, "a parseable rc1 prefix alone grants nothing");
  admission.setPlanned(scan, scan.plan);
  assert.equal(admission.allows(selected), true);
  assert.equal(admission.allows(scan.plan.find((entry) => entry.family === "comments")), false);
  assert.equal(admission.allows({ ...selected, until: "2026-10-02T12:00:00.000Z" }), false);
  assert.equal(
    admission.allows({ ...selected, runId: reconciliationRunId(hash("different context"), scan.token, 0, 2) }),
    false,
  );
  const savedPlan = structuredClone(scan.plan);
  scan.plan.find((entry) => entry.family === "content_edits").until = "2026-10-03T00:00:00.000Z";
  assert.equal(admission.allows(selected), false, "mutating the caller tuple does not widen the captured tuple");
  assert.equal(admission.allows(savedPlan.find((entry) => entry.family === "content_edits")), true);
  admission.clear();
  const resumed = await new ScanContinuationStore(db).claim(
    requested,
    () => {},
    () => {
      throw new Error("must retain saved cutoff");
    },
    () => [],
    prepare,
  );
  assert.deepEqual(resumed.plan, savedPlan);
  assert.equal(resumed.token, scan.token);
  const reopenedAdmission = createGithubContentEditAdmission();
  reopenedAdmission.setPlanned(resumed, resumed.plan);
  assert.equal(reopenedAdmission.allows(resumed.plan.find((entry) => entry.family === "content_edits")), true);
  assert.throws(
    () => reopenedAdmission.setPlanned({ ...resumed, contextHash: hash("old context") }, resumed.plan),
    /invalid_content_edit/,
  );
  assert.equal(reopenedAdmission.allows(resumed.plan.find((entry) => entry.family === "content_edits")), false);
});

test("recent windows, malformed new identities and old gc2 choices never select content metadata", async () => {
  for (const input of [
    { ...request(), mode: "reconcile" },
    { ...request(), since: "2026-09-01T00:00:00.000Z" },
    { ...request(), family: "comments" },
    { ...request(), runId: "gce1:bad" },
    { ...request(), until: "2026-02-30T00:00:00.000Z" },
  ])
    await assert.rejects(select(input), /invalid_content_edit/);
  assert.equal(await count(), 0);
  const admission = createGithubContentEditAdmission();
  assert.throws(
    () => admission.recordSelected({ ...request(), runId: "gc2:" + request().runId }),
    /invalid_content_edit/,
  );
  assert.equal(admission.allows({ ...request(), runId: "gc2:" + request().runId }), false);
  assert.equal(admission.allows({ ...request(), runId: "gce1:" + request().runId }), false);
});

const selectComments = (input = request(), guard = () => {}) =>
  startGithubContentEditRun(db, collection, input, guard, true);
const allSaved = async () =>
  (await db.query("SELECT * FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
const retainedContent = async () => ({
  facts: (await db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows,
  items: (await db.query("SELECT * FROM leaderboard_ingestion.collection_items ORDER BY run_id,fact_key")).rows,
  pages: (await db.query("SELECT * FROM leaderboard_ingestion.collection_pages ORDER BY run_id,page_number")).rows,
});
const legacyPage = (subjectId, nextCursor) => ({
  repositoryId: 2,
  visibility: "public",
  nextCursor,
  expectedCount: 2,
  facts: [
    {
      subjectId,
      sourceRevision: "synthetic-retained-inventory-v1",
      sourceUrl: `https://github.com/${repository.slug}/issues/11`,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  ],
});

test("comment metadata v2 changes only the enabled content context and preserves the supplied gc2 context", () => {
  const comments = githubCommentsContext([3, null, [{ repositoryId: 2, generation: "1" }]], true);
  const before = structuredClone(comments);
  assert.deepEqual(githubContentEditsContext(comments, true, true), [...comments, "github-content-edits/metadata-v2"]);
  assert.deepEqual(githubContentEditsContext(comments, true, false), [...comments, "github-content-edits/metadata-v1"]);
  assert.equal(githubContentEditsContext(comments, false, true), comments);
  assert.deepEqual(comments, before);
  for (const invalid of [null, "true", 1])
    assert.throws(() => githubContentEditsContext(comments, true, invalid), /invalid_content_edit_inventory_context/);
});

test("fresh comment inventories converge on gce2 and admit only the captured complete tuple", async () => {
  const input = request("fresh-comment-inventory");
  const [chosen, concurrent] = await Promise.all([selectComments(input), selectComments(input)]);
  assert.deepEqual(concurrent, chosen);
  assert.deepEqual(chosen, { ...input, runId: "gce2:" + input.runId });
  assert.equal(Object.isFrozen(chosen), true);
  assert.equal(await count(), 1);
  assert.equal(await saved(input.runId), undefined);
  assert.equal(await saved("gce1:" + input.runId), undefined);

  const admission = createGithubContentEditAdmission();
  assert.equal(admission.allows(chosen), false);
  assert.equal(admission.allowsComments(chosen), false, "a parseable gce2 prefix alone is not admission");
  const supplied = { ...chosen };
  assert.equal(admission.recordSelected(supplied), true);
  supplied.until = "2026-10-02T12:00:00.000Z";
  assert.equal(admission.allows(chosen), true);
  assert.equal(admission.allowsComments(chosen), true);
  for (const changed of [
    supplied,
    { ...chosen, repositoryId: 3 },
    { ...chosen, family: "comments" },
    { ...chosen, mode: "backfill" },
    { ...chosen, runId: "gce2:" + hash("different-operation") },
    { ...chosen, runId: "gce1:" + input.runId },
  ]) {
    assert.equal(admission.allows(changed), false);
    assert.equal(admission.allowsComments(changed), false);
  }
  assert.throws(() => admission.recordSelected(supplied), /invalid_content_edit_inventory_request/);
  assert.equal(admission.allowsComments(chosen), true, "a conflicting tuple does not overwrite its prior admission");
  admission.clear();
  assert.equal(admission.allows(chosen), false);
  assert.equal(admission.allowsComments(chosen), false);
});

for (const prefix of ["", "gce1:"])
  for (const state of ["pending", "failed", "complete"])
    test(`v2 selection preserves the exact ${prefix || "legacy"} ${state} row, cursor and observations`, async () => {
      const input = request(`retained-${prefix}-${state}`);
      const retained = { ...input, runId: prefix + input.runId };
      await collection.start(retained);
      assert.equal(
        await collection.step(
          retained.runId,
          { readPage: async () => legacyPage("I_RETAINED_11", "retained:page-2") },
          1,
        ),
        "progress",
      );
      if (state === "failed")
        assert.equal(
          await collection.step(retained.runId, {
            readPage: async () => {
              throw new Error("synthetic retained source unavailable");
            },
          }),
          "failed",
        );
      if (state === "complete")
        assert.equal(
          await collection.step(
            retained.runId,
            {
              readPage: async (selected) => {
                assert.equal(selected.cursor, "retained:page-2");
                return legacyPage("I_RETAINED_12", null);
              },
            },
            1,
          ),
          "complete",
        );
      const before = await saved(retained.runId);
      const content = await retainedContent();
      assert.equal(before.state, state);
      assert.equal(before.cursor, state === "complete" ? null : "retained:page-2");
      assert.equal(before.page_count, state === "complete" ? 2 : 1);
      assert.equal(before.item_count, state === "complete" ? 2 : 1);
      assert.equal(before.expected_count, 2);
      if (state === "failed") assert.equal(before.reason, "source_read_failed");

      const chosen = await startGithubContentEditRun(db, new CollectionStore(db), input, () => {}, true);
      assert.deepEqual(chosen, retained);
      const admission = createGithubContentEditAdmission();
      assert.equal(admission.recordSelected(chosen), prefix === "gce1:");
      assert.equal(admission.allows(chosen), prefix === "gce1:");
      assert.equal(admission.allowsComments(chosen), false);
      if (state === "complete")
        assert.equal(
          await collection.step(chosen.runId, {
            readPage() {
              throw new Error("completed retained inventory must not be recollected");
            },
          }),
          "complete",
        );
      assert.deepEqual(await saved(retained.runId), before);
      assert.deepEqual(await retainedContent(), content);
      assert.equal(await saved("gce2:" + input.runId), undefined);
      assert.equal(await count(), 1);
    });

test("an existing gce2 selection wins over later legacy and gce1 rows without rewriting any row", async () => {
  const input = request("retained-gce2-precedence");
  const chosen = await selectComments(input);
  assert.equal(await collection.step(chosen.runId, empty), "complete");
  await collection.start(input);
  await collection.start({ ...input, runId: "gce1:" + input.runId });
  const rows = await allSaved();
  const content = await retainedContent();
  assert.deepEqual(await selectComments(input), chosen);
  assert.deepEqual(await allSaved(), rows);
  assert.deepEqual(await retainedContent(), content);
  assert.equal(await count(), 3);
  const admission = createGithubContentEditAdmission();
  admission.recordSelected(chosen);
  assert.equal(admission.allowsComments(chosen), true);
});

test("a parent-only helper rejects an existing gce2 format without allocating a parallel parent run", async () => {
  const input = request("parent-helper-cannot-downgrade");
  const chosen = await selectComments(input);
  const before = await saved(chosen.runId);
  await assert.rejects(select(input), /content_edit_inventory_format_unavailable/);
  assert.deepEqual(await saved(chosen.runId), before);
  assert.equal(await saved(input.runId), undefined);
  assert.equal(await saved("gce1:" + input.runId), undefined);
  assert.equal(await count(), 1);
});

for (const commentsFirst of [false, true])
  test(`concurrent ${commentsFirst ? "gce2-first" : "gce1-first"} requests share the gce1 advisory key and keep one winner`, async () => {
    const input = request(`shared-lock-${commentsFirst}`);
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    const locks = [];
    const orderedDb = (label) => ({
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            async query(sql, values) {
              const result = await tx.query(sql, values);
              if (sql.includes("pg_advisory_xact_lock(hashtextextended")) {
                locks.push({ label, key: values[0] });
                if (label === "first") {
                  locked.resolve();
                  await release.promise;
                }
              }
              return result;
            },
          }),
        ),
    });
    const first = startGithubContentEditRun(orderedDb("first"), collection, input, () => {}, commentsFirst);
    await locked.promise;
    const second = startGithubContentEditRun(orderedDb("second"), collection, input, () => {}, !commentsFirst);
    const completion = Promise.allSettled([first, second]);
    release.resolve();
    const [firstResult, secondResult] = await completion;
    assert.equal(firstResult.status, "fulfilled");
    const expectedId = `${commentsFirst ? "gce2" : "gce1"}:${input.runId}`;
    assert.equal(firstResult.value.runId, expectedId);
    if (commentsFirst) {
      assert.equal(secondResult.status, "rejected");
      assert.match(secondResult.reason.message, /content_edit_inventory_format_unavailable/);
    } else {
      assert.equal(secondResult.status, "fulfilled");
      assert.deepEqual(secondResult.value, firstResult.value);
    }
    assert.deepEqual(locks, [
      { label: "first", key: "gce1:" + input.runId },
      { label: "second", key: "gce1:" + input.runId },
    ]);
    assert.equal(await count(), 1);
    assert.equal((await saved(expectedId)).state, "pending");
    assert.equal((await saved(expectedId)).page_count, 0);
    assert.equal(await saved(input.runId), undefined);
    assert.equal(await saved(`${commentsFirst ? "gce1" : "gce2"}:${input.runId}`), undefined);
  });

test("v2 tuple conflicts and every authorization fence preserve retained rows and roll back new allocation", async () => {
  const input = request("v2-conflicts");
  await selectComments(input);
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(3,1,'public')",
  );
  const rows = await allSaved();
  for (const changed of [
    { ...input, repositoryId: 3 },
    { ...input, mode: "backfill" },
    { ...input, until: "2026-10-02T12:00:00.000Z" },
  ]) {
    await assert.rejects(selectComments(changed), /scan_id_conflict/);
    assert.deepEqual(await allSaved(), rows);
  }
  for (const changed of [
    { ...input, family: "comments" },
    { ...input, since: "2026-09-01T00:00:00.000Z" },
    { ...input, runId: input.runId + "\n" },
  ]) {
    await assert.rejects(selectComments(changed), /invalid_content_edit_inventory_request/);
    assert.deepEqual(await allSaved(), rows);
  }
  for (const failedFence of [1, 2, 3]) {
    let calls = 0;
    await assert.rejects(
      selectComments(request(`v2-revoked-at-${failedFence}`), () => {
        if (++calls === failedFence) throw new Error("synthetic comment inventory authorization withdrawn");
      }),
      /authorization withdrawn/,
    );
    assert.equal(calls, failedFence);
    assert.deepEqual(await allSaved(), rows);
  }
  await db.query(
    "UPDATE leaderboard_ingestion.repository_access SET state='unavailable',generation=generation+1 WHERE repository_id=2",
  );
  await assert.rejects(selectComments(request("v2-source-revoked")), /repository_unverified/);
  assert.deepEqual(await allSaved(), rows);
});

test("an actual v1 to v2 continuation change supersedes the old plan while preserving all retained collection bytes", async () => {
  const comments = githubCommentsContext([3, null, [{ repositoryId: 2, generation: "1" }]], true);
  const previousRequest = {
    key: hash("same approved content configuration"),
    contextHash: hash(githubContentEditsContext(comments, true, false)),
    cutoff,
    sources: [{ repositoryId: 2, generation: "1" }],
  };
  const currentRequest = {
    ...previousRequest,
    contextHash: hash(githubContentEditsContext(comments, true, true)),
  };
  const repositories = [{ ...repository, installationId: 1, families: ["comments", "content_edits"] }];
  const policy = { lookbackMs: 86400000, overlapMs: 1000, fullAuditsPerCycle: 2 };
  const prepare = (tx, scan, { fresh }) =>
    prepareReconciliationPlan(tx, {
      scan,
      repositories,
      policy,
      fresh,
      startInTransaction: (session, selected) => collection.startInTransaction(session, selected),
      readProgress: readReconciliationProgress,
    });
  const store = new ScanContinuationStore(db);
  const previous = await store.claim(
    previousRequest,
    () => {},
    () => cutoff,
    () => [],
    prepare,
  );
  assert.equal(previous.plan.length, 2);
  const previousContent = previous.plan.find((entry) => entry.family === "content_edits");
  assert.equal(
    await collection.step(
      previousContent.runId,
      { readPage: async () => legacyPage("I_OLD_PLAN_11", "old-plan:page-2") },
      1,
    ),
    "progress",
  );
  const previousRows = await allSaved();
  const previousObservations = await retainedContent();
  const admission = createGithubContentEditAdmission();
  admission.setPlanned(previous, previous.plan, false);
  assert.equal(admission.allows(previousContent), true);
  assert.equal(admission.allowsComments(previousContent), false);

  const nextCutoff = "2026-10-02T12:00:00.000Z";
  const current = await store.claim(
    currentRequest,
    () => {},
    () => nextCutoff,
    () => [],
    prepare,
  );
  assert.equal(current.key, previous.key);
  assert.notEqual(current.token, previous.token);
  assert.equal(current.cutoff, nextCutoff);
  assert.notEqual(reconciliationContextDigest(current), reconciliationContextDigest(previous));
  assert.equal(current.plan.length, 2);
  assert.equal(await count(), 4);
  for (const row of previousRows) assert.deepEqual(await saved(row.run_id), row);
  assert.deepEqual(await retainedContent(), previousObservations);
  const currentContent = current.plan.find((entry) => entry.family === "content_edits");
  assert.notEqual(currentContent.runId, previousContent.runId);
  for (const entry of current.plan) {
    assert.equal(entry.until, nextCutoff);
    assert.equal((await saved(entry.runId)).state, "pending");
    assert.equal((await saved(entry.runId)).page_count, 0);
  }
  admission.setPlanned(current, current.plan, true);
  assert.equal(admission.allows(currentContent), true);
  assert.equal(admission.allowsComments(currentContent), true);
  assert.equal(admission.allows(previousContent), false);
  assert.equal(admission.allowsComments(previousContent), false);
  assert.equal(admission.allowsComments(current.plan.find((entry) => entry.family === "comments")), false);
  await assert.rejects(
    store.freeze(previous, "2026-10-03T12:00:00.000Z", () => {}),
    ScanSupersededError,
  );
  const beforeResume = await allSaved();
  const resumed = await store.claim(
    currentRequest,
    () => {},
    () => {
      throw new Error("resume must use its saved v2 cutoff");
    },
    () => [],
    prepare,
  );
  assert.deepEqual(resumed, current);
  assert.deepEqual(await allSaved(), beforeResume);
  assert.deepEqual(await retainedContent(), previousObservations);
  const restartedAdmission = createGithubContentEditAdmission();
  restartedAdmission.setPlanned(resumed, resumed.plan, true);
  assert.equal(restartedAdmission.allowsComments(currentContent), true);
  assert.throws(
    () => restartedAdmission.setPlanned({ ...resumed, contextHash: previous.contextHash }, resumed.plan, true),
    /invalid_content_edit/,
  );
  assert.equal(restartedAdmission.allows(currentContent), false);
  assert.equal(restartedAdmission.allowsComments(currentContent), false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.scan_continuations")).rows[0].n, 1);
});
