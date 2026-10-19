import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test, { after, before, beforeEach } from "node:test";
import { readImportedHistory } from "../src/reconciliation-history.mjs";

const require = createRequire(new URL("../../../packages/ingestion/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const cutoff = "2026-10-02T00:00:00.000Z";
const at = (second) => `2026-10-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const rest = (content, observation) => `gh-rest-v1:${digest(content)}.${digest(observation).slice(0, 32)}`;
const snapshot = (content, observation) => `${digest(content)}.${digest(observation).slice(0, 32)}`;
const planned = (number, ordinal = 0, total = 1) =>
  `rc1:${digest("synthetic-config-context")}:00000000-0000-4000-8000-${String(number).padStart(12, "0")}:${String(ordinal).padStart(4, "0")}:${String(total).padStart(4, "0")}`;
let db;

before(async () => {
  db = new PGlite();
  for (const migration of ["001_ingestion.up.sql", "002_snapshots.up.sql", "003_collection.up.sql"])
    await db.exec(await readFile(new URL(`../../../packages/ingestion/sql/${migration}`, import.meta.url), "utf8"));
});
after(async () => db?.close());
beforeEach(async () => {
  await db.exec(
    "TRUNCATE leaderboard_ingestion.repository_access, leaderboard_ingestion.collection_runs, leaderboard_ingestion.source_facts CASCADE",
  );
});

async function seed({
  runId,
  revision,
  time = at(1),
  mode = "audit",
  family = "issues",
  repositoryId = 2,
  generation = 1,
  subject = "SYNTHETIC_SUBJECT",
  state = "complete",
}) {
  await db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES($1,1,'public') ON CONFLICT DO NOTHING",
    [repositoryId],
  );
  await db.query(
    "INSERT INTO leaderboard_ingestion.collection_runs(run_id,repository_id,family,mode,until_at,access_generation,state) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [runId, repositoryId, family, mode, cutoff, generation, state],
  );
  const key = digest(JSON.stringify([runId, repositoryId, family, subject, revision]));
  await db.query(
    "INSERT INTO leaderboard_ingestion.source_facts(fact_key,repository_id,family,subject_id,source_revision,document,first_run_id,observed_at) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7)",
    [key, repositoryId, family, subject, revision, runId, time],
  );
  return [runId, key];
}
const read = (ids = [2], frozen = cutoff) => readImportedHistory(db, ids, frozen);
const sorted = (rows) => rows.sort(([ar, af], [br, bf]) => ar.localeCompare(br) || af.localeCompare(bf));

test("legacy audit and backfill pairs remain literal, including old equal-content wrapped observations", async () => {
  const expected = [];
  for (const [index, mode] of ["reconcile", "audit", "audit", "backfill"].entries()) {
    const pair = await seed({
      runId: `synthetic-legacy-${index}`,
      mode,
      time: at(index),
      revision: snapshot("same", String(index)),
      family: "reviews",
    });
    if (mode !== "reconcile") expected.push(pair);
  }
  assert.deepEqual(await read(), sorted(expected));
  const before = (await db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  assert.deepEqual(await read(), sorted(expected));
  assert.deepEqual((await db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows, before);
});

test("all four REST families count actual audit changes and restoration, not every fresh observation", async () => {
  const expected = [];
  for (const family of ["issues", "pull_requests", "comments", "releases"]) {
    for (const [index, content] of ["A", "A", "B", "A", "A"].entries()) {
      const pair = await seed({
        runId: `synthetic-${family}-${index}`,
        family,
        time: at(index),
        mode: index === 0 ? "reconcile" : "audit",
        revision: rest(content, `${family}-${index}`),
      });
      if (index === 2 || index === 3) expected.push(pair);
    }
  }
  assert.deepEqual(await read(), sorted(expected));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts")).rows[0].n, 20);
});

test("rc1 alone opts known wrapped snapshot families into semantic accounting and preserves every older import", async () => {
  const expected = [];
  for (const [familyIndex, family] of ["reviews", "discussions", "project_current"].entries()) {
    for (const [index, content] of ["A", "A", "B", "B", "B"].entries()) {
      const runId = index === 0 || index === 3 ? `synthetic-old-${family}-${index}` : planned(familyIndex * 10 + index);
      const pair = await seed({ runId, family, time: at(index), revision: snapshot(content, `${family}-${index}`) });
      if ([0, 2, 3].includes(index)) expected.push(pair);
    }
  }
  assert.deepEqual(await read(), sorted(expected));
});

test("current reconcile observations are the baseline for a later unchanged audit", async () => {
  await seed({ runId: "synthetic-initial", revision: rest("A", "1"), time: at(1), mode: "reconcile" });
  await seed({ runId: "synthetic-edited-current", revision: rest("B", "2"), time: at(2), mode: "reconcile" });
  await seed({ runId: "synthetic-confirming-audit", revision: rest("B", "3"), time: at(3) });
  assert.deepEqual(await read(), []);
  const restored = await seed({
    runId: "synthetic-restored-audit",
    revision: rest("A", "4"),
    time: at(4),
    state: "failed",
  });
  assert.deepEqual(await read(), [restored], "a committed page survives the later failure of that run");
});

test("repository, source generation, family and frozen observation cutoff do not borrow a content baseline", async () => {
  await seed({ runId: "synthetic-source-old", revision: rest("A", "1"), time: at(1), mode: "reconcile" });
  await seed({
    runId: "synthetic-foreign-source",
    revision: rest("B", "2"),
    time: at(2),
    repositoryId: 3,
    mode: "reconcile",
  });
  const current = await seed({
    runId: "synthetic-new-generation",
    revision: rest("A", "3"),
    time: at(3),
    generation: 2,
  });
  const family = await seed({
    runId: "synthetic-other-family",
    revision: rest("A", "4"),
    time: at(4),
    family: "comments",
  });
  const future = await seed({
    runId: "synthetic-future",
    revision: rest("B", "5"),
    time: "2026-10-03T00:00:00.000Z",
    generation: 2,
  });
  assert.deepEqual(await read(), sorted([current, family]));
  assert.deepEqual(await read([2], "2026-10-04T00:00:00.000Z"), sorted([current, family, future]));
});

test("PostgreSQL observation precision orders same-millisecond changes without UUID ordering", async () => {
  await seed({
    runId: "synthetic-z-first",
    revision: rest("A", "1"),
    time: "2026-10-01T00:00:00.000001Z",
    mode: "reconcile",
  });
  const b = await seed({ runId: "synthetic-a-second", revision: rest("B", "2"), time: "2026-10-01T00:00:00.000002Z" });
  const a = await seed({ runId: "synthetic-m-third", revision: rest("A", "3"), time: "2026-10-01T00:00:00.000003Z" });
  assert.deepEqual(await read(), sorted([b, a]));
});

test("equal source clocks fail closed for versioned observations while literal legacy ties remain readable", async () => {
  const legacy = [
    await seed({ runId: "synthetic-legacy-one", revision: "synthetic-old-one" }),
    await seed({ runId: "synthetic-legacy-two", revision: "synthetic-old-two" }),
  ];
  assert.deepEqual(await read(), sorted(legacy));
  await seed({ runId: "synthetic-new-tied", revision: rest("A", "3") });
  await assert.rejects(read(), /^Error: reconciliation_history_observation_order_ambiguous$/);
});

test("malformed reserved revisions and incomplete planned identities cannot silently become legacy imports", async () => {
  const cases = [
    { revision: "gh-rest-v1:synthetic-invalid" },
    { revision: rest("A", "1").replace("v1:", "v2:") },
    { revision: rest("A", "1"), family: "commits" },
    { revision: snapshot("A", "1"), family: "reviews", runId: planned(1, 0, 0) },
    { revision: snapshot("A", "1"), family: "reviews", runId: planned(1, 1, 1) },
    { revision: snapshot("A", "1"), family: "reviews", runId: planned(1, 0, 1201) },
    { revision: "synthetic-unverified", family: "reviews", runId: planned(1) },
  ];
  for (const [index, entry] of cases.entries()) {
    await seed({ runId: `synthetic-invalid-${index}`, time: at(index), ...entry });
    await assert.rejects(read(), /^Error: reconciliation_history_revision_unverified$/);
    await db.exec(
      "TRUNCATE leaderboard_ingestion.repository_access, leaderboard_ingestion.collection_runs, leaderboard_ingestion.source_facts CASCADE",
    );
  }
  const first = await seed({ runId: planned(2, 0, 1200), revision: snapshot("A", "first"), family: "reviews" });
  const last = await seed({
    runId: planned(3, 1199, 1200),
    revision: snapshot("B", "last"),
    family: "reviews",
    time: at(2),
  });
  assert.deepEqual(await read(), sorted([first, last]));
});

test("scope validation happens before any retained-data query", async () => {
  let reads = 0;
  const unavailable = {
    query: async () => {
      reads += 1;
      throw new Error("synthetic-query-must-not-run");
    },
  };
  for (const ids of [[], [2, 2], [0], [false], Array.from({ length: 101 }, (_, index) => index + 1)])
    await assert.rejects(
      readImportedHistory(unavailable, ids, cutoff),
      /^Error: reconciliation_history_scope_invalid$/,
    );
  for (const time of [null, "2026-10-01", "2026-02-30T00:00:00.000Z", "2026-10-01T00:00:00.000001Z"])
    await assert.rejects(readImportedHistory(unavailable, [2], time), /^Error: reconciliation_history_scope_invalid$/);
  assert.equal(reads, 0);
});

test("inline comment v2 history keeps retained v1 entries and counts only new semantic versions and restorations", async () => {
  const inline = (content, observation) => `gh-rest-comment-v2:${digest(content)}.${digest(observation).slice(0, 32)}`;
  await seed({
    runId: "synthetic-inline-legacy",
    family: "comments",
    subject: "PRRC_1",
    revision: rest("A", "legacy"),
    time: at(0),
    mode: "reconcile",
  });
  const expected = [];
  for (const [index, content] of ["A", "A", "B", "A", "A"].entries()) {
    const pair = await seed({
      runId: `synthetic-inline-v2-${index}`,
      family: "comments",
      subject: "PRRC_1",
      revision: inline(content, String(index)),
      time: at(index + 1),
      mode: index === 4 ? "backfill" : "audit",
    });
    if ([0, 2, 3].includes(index)) expected.push(pair);
  }
  expected.push(
    await seed({
      runId: "synthetic-conversation-v1",
      family: "comments",
      subject: "IC_1",
      revision: rest("conversation", "1"),
      time: at(1),
    }),
  );
  const before = (await db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows;
  assert.deepEqual(await read(), sorted(expected));
  assert.deepEqual((await db.query("SELECT * FROM leaderboard_ingestion.source_facts ORDER BY fact_key")).rows, before);
});

test("inline comment markers cannot authorize another family or an unknown version in imported history", async () => {
  const valid = `gh-rest-comment-v2:${digest("A")}.${digest("1").slice(0, 32)}`;
  const entries = [
    ...["issues", "pull_requests", "releases", "commits", "reviews"].map((family) => ({ family, revision: valid })),
    { family: "comments", revision: valid.replace("comment-v2:", "comment-v3:") },
    { family: "comments", revision: valid.slice(0, -1) },
    { family: "comments", revision: valid + "x" },
  ];
  for (const [index, entry] of entries.entries()) {
    await seed({ runId: `synthetic-inline-invalid-${index}`, ...entry });
    await assert.rejects(read(), /^Error: reconciliation_history_revision_unverified$/);
    await db.exec(
      "TRUNCATE leaderboard_ingestion.repository_access, leaderboard_ingestion.collection_runs, leaderboard_ingestion.source_facts CASCADE",
    );
  }
});
