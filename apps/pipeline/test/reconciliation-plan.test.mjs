import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test, { after, before, beforeEach } from "node:test";
import { CollectionStore, sourceFamilies } from "@pick-your-ai/ingestion";
import { ScanContinuationStore, scanContinuationSchema } from "../src/scan-continuation.mjs";
import {
  validateReconciliationPolicy,
  reconciliationContextDigest,
  reconciliationRunId,
  parseReconciliationRunId,
  selectReconciliationPlan,
  prepareReconciliationPlan,
} from "../src/reconciliation-plan.mjs";

const require = createRequire(new URL("../../../packages/ingestion/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cutoff = "2026-10-18T12:00:00.000Z";
const time = (millisecondsBefore) => new Date(Date.parse(cutoff) - millisecondsBefore).toISOString();
const token = "00000000-0000-4000-8000-000000000001";
const secondToken = "00000000-0000-4000-8000-000000000002";
const policy = { lookbackMs: 86400000, overlapMs: 60000, fullAuditsPerCycle: 1 };
const repositories = [
  { id: 10, installationId: 1, families: ["relationships", "releases", "project_history"] },
  { id: 2, installationId: 1, families: ["reviews", "issues", "comments"] },
];
const scan = {
  key: hash("synthetic-approved-configuration"),
  contextHash: hash("synthetic-approved-source-context"),
  token,
  cutoff,
  sources: [
    { repositoryId: 2, generation: "1" },
    { repositoryId: 10, generation: "1" },
  ],
};
function progressFor(repos = repositories, currentScan = scan) {
  return repos.flatMap((repo) =>
    repo.families.map((family) => ({
      repositoryId: repo.id,
      family,
      generation: currentScan.sources.find((source) => source.repositoryId === repo.id).generation,
      lastFullAuditAt: null,
      reconciledThrough: null,
      lastSuccessfulSync: null,
    })),
  );
}
const select = (extra = {}) =>
  selectReconciliationPlan({ scan, repositories, policy, progress: progressFor(), ...extra });
const withoutIds = (requests) => requests.map(({ runId, ...request }) => request);
const integrity = /^Error: reconciliation_plan_integrity_error$/;
let engine;
let db;
let collection;

before(async () => {
  engine = new PGlite();
  db = { query: (sql, params) => engine.query(sql, params), transaction: (work) => engine.transaction(work) };
  for (const migration of ["001_ingestion.up.sql", "002_snapshots.up.sql", "003_collection.up.sql"])
    await engine.exec(await readFile(new URL(`../../../packages/ingestion/sql/${migration}`, import.meta.url), "utf8"));
  // Only the head columns the real continuation claim reads are needed here.
  // Full pipeline migration/confirmation tests remain separate integration gates.
  await engine.exec(
    "CREATE SCHEMA leaderboard_pipeline; CREATE TABLE leaderboard_pipeline.heads(scope_key text PRIMARY KEY,snapshot_id text NOT NULL)",
  );
  await engine.exec(scanContinuationSchema);
  collection = new CollectionStore(db);
  assert.equal(
    typeof collection.startInTransaction,
    "function",
    "build the current ingestion source before this suite",
  );
});
after(async () => engine?.close());

async function reset() {
  await engine.exec(
    "TRUNCATE leaderboard_pipeline.scan_continuations,leaderboard_ingestion.repository_access,leaderboard_ingestion.collection_runs CASCADE",
  );
  for (const id of [2, 10, 99])
    await engine.query(
      "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES($1,1,'public')",
      [id],
    );
}
beforeEach(reset);

async function prepare(extra = {}, tx = null) {
  const args = {
    scan,
    repositories,
    policy,
    fresh: true,
    startInTransaction: (session, request) => collection.startInTransaction(session, request),
    readProgress: async () => progressFor(),
    ...extra,
  };
  return tx
    ? prepareReconciliationPlan(tx, args)
    : db.transaction((session) => prepareReconciliationPlan(session, args));
}
const rows = async () =>
  (await engine.query("SELECT * FROM leaderboard_ingestion.collection_runs ORDER BY run_id")).rows;
const failIfCalled = () => {
  throw new Error("synthetic-resume-must-not-select-or-start");
};
const resume = (extra = {}) =>
  prepare({ fresh: false, startInTransaction: failIfCalled, readProgress: failIfCalled, ...extra });

test("policy is an explicit exact bounded opt-in and never silently repairs malformed values", () => {
  assert.equal(validateReconciliationPolicy(undefined), null);
  const copied = validateReconciliationPolicy(policy);
  assert.deepEqual(copied, policy);
  assert.notEqual(copied, policy);
  assert.deepEqual(validateReconciliationPolicy({ lookbackMs: 1000, overlapMs: 1000, fullAuditsPerCycle: 1 }), {
    lookbackMs: 1000,
    overlapMs: 1000,
    fullAuditsPerCycle: 1,
  });
  assert.deepEqual(
    validateReconciliationPolicy({ lookbackMs: 31 * 86400000, overlapMs: 31 * 86400000, fullAuditsPerCycle: 1200 }),
    { lookbackMs: 31 * 86400000, overlapMs: 31 * 86400000, fullAuditsPerCycle: 1200 },
  );
  for (const invalid of [
    null,
    false,
    [],
    "synthetic-policy",
    {},
    { ...policy, extra: true },
    { ...policy, lookbackMs: 999 },
    { ...policy, lookbackMs: 31 * 86400000 + 1 },
    { ...policy, lookbackMs: 1000.5 },
    { ...policy, lookbackMs: "86400000" },
    { ...policy, overlapMs: true },
    { ...policy, overlapMs: 999 },
    { ...policy, overlapMs: policy.lookbackMs + 1 },
    { ...policy, fullAuditsPerCycle: 0 },
    { ...policy, fullAuditsPerCycle: 1201 },
    { ...policy, fullAuditsPerCycle: 1.5 },
    { ...policy, fullAuditsPerCycle: Infinity },
  ])
    assert.throws(() => validateReconciliationPolicy(invalid), /^Error: reconciliation_policy_invalid$/);
  assert.throws(() => select({ policy: undefined }), /^Error: reconciliation_policy_required$/);
});

test("plan IDs bind the exact approved context and complete zero-based member count in 115 characters", () => {
  const contextDigest = reconciliationContextDigest(scan);
  assert.equal(contextDigest, hash(JSON.stringify(["reconciliation-plan/v1", scan.key, scan.contextHash])));
  assert.equal(
    reconciliationContextDigest({
      ...scan,
      irrelevantAuditState: "synthetic-new-audit",
      cutoff: time(-1000),
      token: secondToken,
    }),
    contextDigest,
  );
  assert.notEqual(reconciliationContextDigest({ ...scan, key: hash("synthetic-other-config") }), contextDigest);
  assert.notEqual(
    reconciliationContextDigest({ ...scan, contextHash: hash("synthetic-other-authority") }),
    contextDigest,
  );
  for (const invalid of [
    { ...scan, key: { toString: () => scan.key } },
    { ...scan, contextHash: null },
  ])
    assert.throws(() => reconciliationContextDigest(invalid), /^Error: reconciliation_plan_identity_invalid$/);
  for (const [ordinal, total] of [
    [0, 1],
    [0, 1200],
    [1199, 1200],
  ]) {
    const runId = reconciliationRunId(contextDigest, token, ordinal, total);
    assert.equal(runId.length, 115);
    assert.deepEqual(parseReconciliationRunId(runId), { contextDigest, token, ordinal, total });
  }
  for (const legacy of ["synthetic-legacy-audit", "backfill:repo:2", "rc0:legacy"])
    assert.equal(parseReconciliationRunId(legacy), null);
  for (const [ordinal, total] of [
    [0, 0],
    [0, 1201],
    [1, 1],
    [-1, 1],
    [0.5, 1],
    [0, true],
  ])
    assert.throws(
      () => reconciliationRunId(contextDigest, token, ordinal, total),
      /^Error: reconciliation_plan_identity_invalid$/,
    );
  for (const bad of [
    `rc1:${contextDigest}:${token}:0000:0000`,
    `rc1:${contextDigest}:${token}:0001:0001`,
    `rc1:${contextDigest}:${token}:0000:1201`,
    `rc1:${contextDigest}:${token}:0:0001`,
    `rc1:${contextDigest.toUpperCase()}:${token}:0000:0001`,
    `rc1:${contextDigest}:invalid:0000:0001`,
    `rc1:${contextDigest}:${token}:0000:0001:extra`,
    "rc1:",
    null,
  ])
    assert.throws(() => parseReconciliationRunId(bad), /^Error: reconciliation_plan_identity_invalid$/);
});

test("oldest or never-audited pairs rotate deterministically while unsupported families remain audit-only", () => {
  const progress = progressFor().map((row) => ({
    ...row,
    lastFullAuditAt: time(row.repositoryId === 2 ? 10000 : 20000),
    reconciledThrough: time(10000),
    lastSuccessfulSync: time(5000),
  }));
  progress.find((row) => row.family === "reviews").lastFullAuditAt = null;
  const first = select({ progress });
  assert.deepEqual(
    first.map(({ repositoryId, family, mode }) => [repositoryId, family, mode]),
    [
      [2, "reviews", "audit"],
      [2, "comments", "reconcile"],
      [2, "issues", "reconcile"],
      [10, "project_history", "reconcile"],
      [10, "relationships", "reconcile"],
    ],
  );
  assert.equal(
    first.some((request) => request.family === "releases"),
    false,
  );
  progress.find((row) => row.family === "reviews").lastFullAuditAt = time(1000);
  const second = select({ progress, scan: { ...scan, token: secondToken } });
  assert.deepEqual(second[0], {
    runId: second[0].runId,
    repositoryId: 10,
    family: "project_history",
    mode: "audit",
    since: null,
    until: cutoff,
  });
  assert.deepEqual(
    withoutIds(
      select({
        progress,
        repositories: [...repositories].reverse().map((repo) => ({ ...repo, families: [...repo.families].reverse() })),
        scan: { ...scan, sources: [...scan.sources].reverse() },
      }),
    ),
    withoutIds(second),
  );
  const all = select({ progress, policy: { ...policy, fullAuditsPerCycle: 1200 } });
  assert.equal(all.length, 6);
  assert.equal(
    all.every((request) => request.mode === "audit" && request.since === null),
    true,
  );
  assert.equal(new Set(all.map((request) => `${request.repositoryId}:${request.family}`)).size, 6);
});

test("recent windows use only contiguous progress with overlap and retain unknown or older gaps", () => {
  const progress = progressFor();
  for (const row of progress) {
    row.lastFullAuditAt = time(4 * 86400000);
    row.reconciledThrough = time(3 * 86400000);
    row.lastSuccessfulSync = time(3 * 86400000);
  }
  for (const row of progress.filter((entry) => ["reviews", "project_history"].includes(entry.family))) {
    row.lastFullAuditAt = null;
    row.reconciledThrough = null;
    row.lastSuccessfulSync = null;
  }
  progress.find((row) => row.family === "comments").reconciledThrough = time(120000);
  progress.find((row) => row.family === "comments").lastSuccessfulSync = time(100000);
  progress.find((row) => row.family === "relationships").reconciledThrough = cutoff;
  progress.find((row) => row.family === "relationships").lastSuccessfulSync = cutoff;
  const before = structuredClone(progress);
  const plan = select({ progress });
  assert.equal(plan.find((request) => request.family === "comments").since, time(180000));
  assert.equal(plan.find((request) => request.family === "issues").since, time(policy.lookbackMs));
  assert.equal(plan.find((request) => request.family === "project_history").since, time(policy.lookbackMs));
  assert.equal(plan.find((request) => request.family === "relationships").since, time(policy.overlapMs));
  assert.deepEqual(progress, before, "selection must not advance or repair a watermark");
  assert.equal(
    plan.every((request) => request.until === cutoff),
    true,
  );
});

test("approved unique pairs, source generations and progress identities are validated before selection", () => {
  for (const extra of [
    { repositories: [] },
    { repositories: [repositories[0], repositories[0]] },
    { repositories: [{ ...repositories[0], id: "10" }, repositories[1]] },
    { repositories: [{ ...repositories[0], families: ["issues", "issues"] }, repositories[1]] },
    { repositories: [{ ...repositories[0], families: [] }, repositories[1]] },
    { repositories: [{ ...repositories[0], families: ["synthetic-unsupported"] }, repositories[1]] },
    { scan: { ...scan, sources: [scan.sources[0], scan.sources[0]] } },
    { scan: { ...scan, sources: [scan.sources[0], { repositoryId: 10, generation: "0" }] } },
    { scan: { ...scan, sources: [scan.sources[0], { repositoryId: 10, generation: "9223372036854775808" }] } },
    { scan: { ...scan, sources: [scan.sources[0], { repositoryId: 99, generation: "1" }] } },
  ])
    assert.throws(() => select(extra), /^Error: reconciliation_plan_scope_invalid$/);
  for (const change of [
    (value) => value.pop(),
    (value) => {
      value[1] = value[0];
    },
    (value) => {
      value[0].repositoryId = "10";
    },
    (value) => {
      value[0].repositoryId = 99;
    },
    (value) => {
      value[0].family = "synthetic-unsupported";
    },
    (value) => {
      value[0].generation = "2";
    },
    (value) => {
      value[0].family = { toString: () => "relationships" };
    },
    (value) => {
      value[0].lastFullAuditAt = time(-1);
    },
    (value) => {
      delete value[0].lastSuccessfulSync;
    },
    (value) => {
      value[0].reconciledThrough = "2026-02-30T00:00:00.000Z";
    },
    (value) => {
      value[0].reconciledThrough = "2026-10-18T00:00:00.000001Z";
    },
  ]) {
    const progress = progressFor();
    change(progress);
    assert.throws(() => select({ progress }), /^Error: reconciliation_plan_progress_invalid$/);
  }
  for (const invalid of ["2026-02-30T00:00:00.000Z", "2026-13-18T00:00:00.000Z", "2026-10-18T12:00:00.000001Z", null])
    assert.throws(() => select({ scan: { ...scan, cutoff: invalid } }), /^Error: reconciliation_plan_time_invalid$/);
});

test("all 1200 approved pairs remain bounded without shortening their complete plan identity", () => {
  // The pair limit remains fixed when an independently supported source family is added.
  const repos = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    families: Array.from({ length: 12 }, (_, offset) => sourceFamilies[(index * 12 + offset) % sourceFamilies.length]),
  }));
  assert.equal(repos.length, 100);
  assert.equal(
    repos.every((repo) => new Set(repo.families).size === 12),
    true,
  );
  assert.deepEqual([...new Set(repos.flatMap((repo) => repo.families))].sort(), [...sourceFamilies].sort());
  assert.equal(
    repos.reduce((count, repo) => count + repo.families.length, 0),
    1200,
  );
  const currentScan = { ...scan, sources: repos.map(({ id }) => ({ repositoryId: id, generation: "1" })) };
  const requests = selectReconciliationPlan({
    scan: currentScan,
    repositories: repos,
    policy: { ...policy, fullAuditsPerCycle: 1200 },
    progress: progressFor(repos, currentScan),
  });
  assert.equal(requests.length, 1200);
  assert.equal(new Set(requests.map((request) => request.runId)).size, 1200);
  assert.equal(
    requests.every(
      (request, index) =>
        request.runId.length === 115 &&
        parseReconciliationRunId(request.runId).ordinal === index &&
        parseReconciliationRunId(request.runId).total === 1200,
    ),
    true,
  );
  // Keep the repository count valid so this rejection exercises only the pair limit.
  const additionalFamily = sourceFamilies.find((family) => !repos[0].families.includes(family));
  assert.notEqual(additionalFamily, undefined);
  const overfullRepos = repos.map((repo, index) =>
    index === 0 ? { ...repo, families: [...repo.families, additionalFamily] } : repo,
  );
  assert.equal(overfullRepos.length, 100);
  assert.equal(
    overfullRepos.reduce((count, repo) => count + repo.families.length, 0),
    1201,
  );
  assert.throws(
    () =>
      selectReconciliationPlan({
        scan: currentScan,
        repositories: overfullRepos,
        policy,
        progress: progressFor(overfullRepos, currentScan),
      }),
    /^Error: reconciliation_plan_scope_invalid$/,
  );
  assert.throws(
    () =>
      selectReconciliationPlan({
        scan: { ...currentScan, sources: [...currentScan.sources, { repositoryId: 101, generation: "1" }] },
        repositories: [...repos, { id: 101, families: ["issues"] }],
        policy,
        progress: [],
      }),
    /^Error: reconciliation_plan_scope_invalid$/,
  );
});

test("fresh materialization uses the supplied transaction and performs a complete saved-row readback", async () => {
  let reads = 0;
  const calls = [];
  const plan = await db.transaction(async (tx) =>
    prepare(
      {
        readProgress: async (session, approved, observationCutoff, options) => {
          assert.equal(session, tx);
          assert.equal(approved, repositories);
          assert.equal(observationCutoff, cutoff);
          assert.deepEqual(options, { contextDigest: reconciliationContextDigest(scan), untilCutoff: cutoff });
          reads += 1;
          return progressFor();
        },
        startInTransaction: async (session, request) => {
          assert.equal(session, tx);
          calls.push(structuredClone(request));
          await collection.startInTransaction(session, request);
        },
      },
      tx,
    ),
  );
  assert.deepEqual(plan, select());
  assert.deepEqual(calls, plan);
  assert.equal(reads, 1);
  const saved = await rows();
  assert.equal(saved.length, plan.length);
  assert.equal(
    saved.every((row) => row.state === "pending" && row.page_count === 0 && row.cursor === null),
    true,
  );
  assert.deepEqual(await resume(), plan);
});

test("a real continuation claim commits every plan row with the cycle and resumes after a new store is opened", async () => {
  const store = new ScanContinuationStore(db);
  const prepared = (tx, current, { fresh }) => prepare({ scan: current, fresh }, tx);
  const first = await store.claim(
    scan,
    () => {},
    () => cutoff,
    () => [],
    prepared,
  );
  assert.equal(first.plan.length, 4);
  await engine.query(
    "UPDATE leaderboard_ingestion.collection_runs SET state='complete',page_count=1,item_count=0,expected_count=0,last_success_at=$1 WHERE run_id=$2",
    [time(-30000), first.plan[0].runId],
  );
  await engine.query(
    "UPDATE leaderboard_ingestion.collection_runs SET state='failed',reason='synthetic-delayed-page' WHERE run_id=$1",
    [first.plan[1].runId],
  );
  const savedRows = await rows();
  const reopened = new ScanContinuationStore(db);
  const resumed = await reopened.claim(
    { ...scan, cutoff: time(-86400000) },
    () => {},
    failIfCalled,
    failIfCalled,
    (tx, current, { fresh }) =>
      prepare({ scan: current, fresh, startInTransaction: failIfCalled, readProgress: failIfCalled }, tx),
  );
  assert.equal(resumed.cutoff, cutoff);
  assert.equal(resumed.token, first.token);
  assert.deepEqual(resumed.plan, first.plan);
  assert.deepEqual(await rows(), savedRows, "resuming a pinned plan must not reset completed or failed pages");
});

test("a failure while materializing any member rolls back both plan rows and the new cycle", async () => {
  const store = new ScanContinuationStore(db);
  let inserted = 0;
  await assert.rejects(
    store.claim(
      scan,
      () => {},
      () => cutoff,
      () => [],
      (tx, current, { fresh }) =>
        prepare(
          {
            scan: current,
            fresh,
            startInTransaction: async (session, request) => {
              await collection.startInTransaction(session, request);
              inserted += 1;
              if (inserted === 2) throw new Error("synthetic-materialization-interrupted");
            },
          },
          tx,
        ),
    ),
    /^Error: synthetic-materialization-interrupted$/,
  );
  assert.equal(inserted, 2);
  assert.deepEqual(await rows(), []);
  assert.equal((await engine.query("SELECT * FROM leaderboard_pipeline.scan_continuations")).rows.length, 0);
  const retried = await store.claim(
    scan,
    () => {},
    () => cutoff,
    () => [],
    (tx, current, { fresh }) => prepare({ scan: current, fresh }, tx),
  );
  assert.equal(retried.plan.length, 4);
  assert.equal((await rows()).length, 4);
});

test("an existing token with zero or a missing interior, first, or last member fails without recomputing", async () => {
  for (const deleted of ["all", 0, 1, 3]) {
    await reset();
    const plan = await prepare();
    if (deleted === "all") await engine.query("DELETE FROM leaderboard_ingestion.collection_runs");
    else await engine.query("DELETE FROM leaderboard_ingestion.collection_runs WHERE run_id=$1", [plan[deleted].runId]);
    const before = await rows();
    await assert.rejects(resume(), integrity);
    assert.deepEqual(await rows(), before);
  }
});

test("resumed identity rejects malformed, contradictory, duplicate and surplus member identities", async () => {
  const changes = [
    async (plan) =>
      engine.query("UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id=$2", [
        plan[0].runId.replace(/:0000:0004$/, ":0000:0000"),
        plan[0].runId,
      ]),
    async (plan) =>
      engine.query("UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id=$2", [
        plan[0].runId.replace(/:0000:0004$/, ":0004:0004"),
        plan[0].runId,
      ]),
    async (plan) =>
      engine.query("UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id=$2", [
        plan[0].runId.replace(/:0000:0004$/, ":0000:0005"),
        plan[0].runId,
      ]),
    async (plan) =>
      engine.query("UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id=$2", [
        plan[1].runId.replace(/:0001:0004$/, ":0000:0005"),
        plan[1].runId,
      ]),
    async (plan) =>
      engine.query("UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id=$2", [
        `rc1:${reconciliationContextDigest(scan)}:${token}:invalid`,
        plan[0].runId,
      ]),
    async () =>
      engine.query(
        "INSERT INTO leaderboard_ingestion.collection_runs(run_id,repository_id,family,mode,until_at,access_generation) VALUES($1,2,'reviews','audit',$2,1)",
        [reconciliationRunId(reconciliationContextDigest(scan), token, 4, 5), cutoff],
      ),
  ];
  for (const change of changes) {
    await reset();
    const plan = await prepare();
    await change(plan);
    await assert.rejects(resume(), integrity);
  }
});

test("resumed rows cannot change approved pairs, generations, modes or required recent coverage", async () => {
  const changes = [
    ["repository_id=99", 0],
    ["access_generation=2", 0],
    ["family='synthetic-foreign'", 0],
    ["family='issues'", 0],
    ["family='reviews'", 1],
    ["mode='backfill'", 0],
    ["mode='audit',since_at=NULL", 1],
    ["mode='reconcile',since_at='2026-10-18T11:00:00.000Z'", 0],
    ["since_at='2026-10-18T11:00:00.000Z'", 0],
    ["since_at=NULL", 1],
  ];
  for (const [assignment, index] of changes) {
    await reset();
    const plan = await prepare();
    await engine.query(`UPDATE leaderboard_ingestion.collection_runs SET ${assignment} WHERE run_id=$1`, [
      plan[index].runId,
    ]);
    await assert.rejects(resume(), integrity);
  }
});

test("saved ordinals cannot swap the audit prefix with an otherwise valid recent member", async () => {
  const plan = await prepare();
  await engine.query(
    "UPDATE leaderboard_ingestion.collection_runs SET run_id='synthetic-swap-temporary' WHERE run_id=$1",
    [plan[0].runId],
  );
  await engine.query("UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id=$2", [
    plan[0].runId,
    plan[1].runId,
  ]);
  await engine.query(
    "UPDATE leaderboard_ingestion.collection_runs SET run_id=$1 WHERE run_id='synthetic-swap-temporary'",
    [plan[1].runId],
  );
  await assert.rejects(resume(), integrity);
});

test("exact clocks reject policy-window drift and hidden PostgreSQL microseconds before a page can resume", async () => {
  for (const [column, value, index] of [
    ["until_at", time(-1), 0],
    ["until_at", "2026-10-18T12:00:00.000001Z", 0],
    ["since_at", time(policy.lookbackMs + 1), 1],
    ["since_at", time(policy.overlapMs - 1), 1],
    ["since_at", "2026-10-17T12:00:00.000001Z", 1],
    ["since_at", cutoff, 1],
  ]) {
    await reset();
    const plan = await prepare();
    await engine.query(`UPDATE leaderboard_ingestion.collection_runs SET ${column}=$1 WHERE run_id=$2`, [
      value,
      plan[index].runId,
    ]);
    await assert.rejects(resume(), integrity);
  }
});

test("a saved token cannot acquire rows from another context or token and legacy rows stay unchanged", async () => {
  const old = {
    runId: "synthetic-legacy-audit",
    repositoryId: 2,
    family: "issues",
    mode: "audit",
    since: null,
    until: cutoff,
  };
  await collection.start(old);
  const otherScan = { ...scan, token: secondToken };
  await prepare({ scan: otherScan });
  const unrelated = await rows();
  await assert.rejects(resume(), integrity);
  const plan = await prepare();
  assert.deepEqual(await resume(), plan);
  const saved = await rows();
  assert.deepEqual(
    saved.filter((row) => unrelated.some((prior) => prior.run_id === row.run_id)),
    unrelated,
  );
  await assert.rejects(resume({ scan: { ...scan, contextHash: hash("synthetic-new-context") } }), integrity);
  await assert.rejects(
    resume({ scan: { ...scan, sources: scan.sources.map((source) => ({ ...source, generation: "2" })) } }),
    integrity,
  );
});

test("fresh token collisions and incomplete or altered writes fail atomically instead of accepting a partial plan", async () => {
  await prepare();
  const before = await rows();
  await assert.rejects(prepare({ readProgress: failIfCalled, startInTransaction: failIfCalled }), integrity);
  assert.deepEqual(await rows(), before);
  await reset();
  let index = 0;
  await assert.rejects(
    prepare({
      startInTransaction: async (tx, request) => {
        if (index++ !== 1) await collection.startInTransaction(tx, request);
      },
    }),
    integrity,
  );
  assert.deepEqual(await rows(), []);
  await assert.rejects(
    prepare({
      startInTransaction: async (tx, request) => {
        await collection.startInTransaction(
          tx,
          request.since === null ? request : { ...request, since: time(3600000) },
        );
      },
    }),
    integrity,
  );
  assert.deepEqual(await rows(), []);
});

test("invalid opt-in, scope or fresh flag is rejected before any retained-data query", async () => {
  let queries = 0;
  const unavailable = {
    query: async () => {
      queries += 1;
      throw new Error("synthetic-query-must-not-run");
    },
  };
  for (const extra of [
    { policy: null },
    { repositories: [] },
    { scan: { ...scan, token: "invalid" } },
    { fresh: "true" },
  ])
    await assert.rejects(prepareReconciliationPlan(unavailable, { scan, repositories, policy, fresh: true, ...extra }));
  assert.equal(queries, 0);
});
