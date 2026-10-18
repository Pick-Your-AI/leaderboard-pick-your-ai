import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { loadPipelineComponents, migratePipeline } from "../src/index.mjs";
import { PolicyComparisonStore } from "../../controls/src/policy-comparison.mjs";
import { AggregateExplanationStore } from "../src/aggregate-explanations.mjs";
import { PipelineDerivedRetirementStore, migratePipelineDerivedRetirement } from "../src/derived-retirement.mjs";

const external = process.env.PIPELINE_RETIREMENT_TEST_DATABASE_URL;
const options = { skip: external ? false : "Independent PostgreSQL service is not configured", timeout: 30000 };
const approved = async () => true;
const components = await loadPipelineComponents();
const stable = components.metrics.stableJSON;
const hash = (value) => createHash("sha256").update(stable(value)).digest("hex");
const request = {
  operationId: "synthetic-pg-derived-retirement",
  repositoryId: 2,
  expectedGeneration: "1",
  policyVersion: "synthetic-policy-v1",
  authorizationReceipt: "synthetic-private-approval",
  operatorId: "synthetic-operator",
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function checkedServiceUrl(value) {
  const url = new URL(value);
  // pg-connection-string permits query keys to override the URL host/port.
  // Reject all overrides and fragments before constructing any Pool.
  assert.equal(url.search, "", "connection-string query options are not permitted");
  assert.equal(url.hash, "", "connection-string fragments are not permitted");
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "only the configured disposable local CI service is allowed",
  );
  assert.equal(url.pathname, "/leaderboard_test", "never use a production or arbitrary database");
  return url;
}

async function fixture(t) {
  const url = checkedServiceUrl(external);
  const administration = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  const name = `leaderboard_pipeline_derived_${randomBytes(8).toString("hex")}_test`;
  const directory = await mkdtemp(join(tmpdir(), "leaderboard-pipeline-derived-pg-"));
  let created = false,
    pool,
    store,
    backend;
  t.after(async () => {
    store?.close();
    await pool?.end();
    try {
      // Only the exact database created by this fixture is removed. No FORCE,
      // connection termination, shared-schema reset or existing data overwrite.
      if (created) await administration.query(`DROP DATABASE "${name}"`);
    } finally {
      await administration.end();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.match(basename(directory), /^leaderboard-pipeline-derived-pg-/);
      await rm(directory, { recursive: true, force: true });
    }
  });
  assert.equal((await administration.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rows.length, 0);
  await administration.query(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = "/" + name;
  const open = () => {
    pool = new Pool({
      connectionString: url.href,
      max: 6,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      lock_timeout: 10000,
    });
    backend = components.ingestion.postgresDatabase(pool);
    store = new components.controls.ControlStore(join(directory, "controls.sqlite"));
  };
  open();
  const db = { query: (sql, params) => backend.query(sql, params), transaction: (work) => backend.transaction(work) };
  for (const name of [
    "001_ingestion",
    "002_snapshots",
    "003_collection",
    "004_outbox_dispatch",
    "005_collection_retirement",
    "006_delivery_payload_expiry",
    "007_operator_replay_results",
  ])
    await pool.query(
      await readFile(new URL(`../../../packages/ingestion/sql/${name}.up.sql`, import.meta.url), "utf8"),
    );
  await migratePipeline(db);
  new PolicyComparisonStore(store, components.metrics);
  new AggregateExplanationStore(store);
  await migratePipelineDerivedRetirement(db);
  const collection = new components.ingestion.CollectionStore(db);
  for (const repositoryId of [2, 3]) {
    await collection.verifyPublic(repositoryId, 1, null);
    const run = {
      runId: `synthetic-pg-run-${repositoryId}`,
      repositoryId,
      family: "issues",
      mode: "backfill",
      since: null,
      until: "2026-01-02T00:00:00.000Z",
    };
    await collection.start(run);
    assert.equal(
      await collection.step(run.runId, {
        readPage: async () => ({
          repositoryId,
          visibility: "public",
          nextCursor: null,
          expectedCount: 1,
          facts: [
            {
              subjectId: `SYNTHETIC_${repositoryId}`,
              sourceRevision: "r1",
              sourceUrl: `https://github.com/synthetic-org/synthetic-repo-${repositoryId}/issues/1`,
              evidence: "current_state",
              actorId: null,
              occurredAt: null,
              state: "open",
            },
          ],
        }),
      }),
      "complete",
    );
  }
  return {
    db,
    get pool() {
      return pool;
    },
    get controlsStore() {
      return store;
    },
    retirement: new components.ingestion.RepositoryRetirementStore(db),
    async reopen() {
      store.close();
      store = undefined;
      await pool.end();
      pool = undefined;
      open();
    },
  };
}
async function fact(h, repositoryId) {
  return (
    await h.db.query("SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE repository_id=$1", [repositoryId])
  ).rows[0].fact_key;
}

// Real independent PG transactions, not PGlite's serialized connection. The
// normalizer payload is deliberately minimal: this case tests storage fencing.
test(
  "PostgreSQL: a derived writer waits on the permanent retirement lock and cannot commit after its fence",
  options,
  async (t) => {
    const h = await fixture(t);
    const target = await fact(h, 2),
      foreign = await fact(h, 3);
    const entered = deferred(),
      release = deferred();
    let calls = 0;
    const retirement = h.retirement
      .retire(request, async () => {
        calls++;
        if (calls === 3) {
          entered.resolve();
          await release.promise;
        }
        return true;
      })
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    const writer = await h.pool.connect();
    const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let writing;
    try {
      await Promise.race([
        entered.promise,
        retirement.then((outcome) => {
          throw outcome.error ?? new Error("Synthetic retirement ended before the held boundary");
        }),
      ]);
      const payload = { label: "synthetic-normalized-payload" };
      writing = writer
        .query("INSERT INTO leaderboard_pipeline.normalizations VALUES($1,$2,$3::jsonb,$4)", [
          target,
          "synthetic-policy",
          JSON.stringify(payload),
          hash(payload),
        ])
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
      let waiting = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const row = (
          await h.pool.query(
            "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1",
            [writerPid],
          )
        ).rows[0];
        if (row?.wait_event_type === "Lock" && row.blockers.length > 0) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      assert.equal(waiting, true, "the actual separate writer is observed waiting on the repository lock");
      await h.pool.query("INSERT INTO leaderboard_pipeline.normalizations VALUES($1,$2,$3::jsonb,$4)", [
        foreign,
        "synthetic-policy",
        JSON.stringify(payload),
        hash(payload),
      ]);
      release.resolve();
      const retired = await retirement;
      assert.ifError(retired.error);
      assert.equal(retired.result.status, "collection_fenced");
      assert.match((await writing).error?.message ?? "", /pipeline_repository_retired/);
      const rows = (await h.db.query("SELECT fact_key FROM leaderboard_pipeline.normalizations")).rows;
      assert.deepEqual(rows, [{ fact_key: foreign }]);
    } finally {
      release.resolve();
      await retirement;
      await writing;
      writer.release();
    }
  },
);

async function seedBinding(h) {
  // Explicit protocol fixture for the multi-store transaction test. Complete
  // collector/normalizer/metric journeys are exercised by derived-retirement.test.
  const snapshot = { snapshotId: "synthetic-pg-snapshot", revision: 1 };
  const scope = { organization: "Pick-Your-AI", repository: null, workstream: null, start: null, end: null };
  const scopeKey = hash(scope);
  const doc = { snapshot, scope };
  const authorization = { sources: [{ repositoryId: "2", generation: "1" }] };
  const frozen = {
    frozen: { repositoryIds: ["2"] },
    identityAuthorization: authorization,
    engineScope: { repos: ["2"] },
    scope,
  };
  const receipt = { snapshotId: snapshot.snapshotId, revision: 1, comparisonInputHash: hash("synthetic-capture") };
  await h.db.query(
    `INSERT INTO leaderboard_pipeline.snapshots
    (snapshot_id,scope_key,revision,config_version,repository_ids,document,document_hash)
    VALUES($1,$2,1,'synthetic-configuration','[2]'::jsonb,$3::jsonb,$4)`,
    [snapshot.snapshotId, scopeKey, JSON.stringify(doc), hash(doc)],
  );
  await h.db.query("INSERT INTO leaderboard_pipeline.frozen_inputs VALUES($1,$2::jsonb,$3)", [
    snapshot.snapshotId,
    JSON.stringify(frozen),
    hash(frozen),
  ]);
  await h.db.query(
    `INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash)
    VALUES($1,$2,'snapshot_published',$3::jsonb,$4)`,
    ["synthetic-receipt", `publish:${scopeKey}:${snapshot.snapshotId}`, JSON.stringify(receipt), hash(receipt)],
  );
  const input = { snapshot, scope: frozen.engineScope, input: frozen.frozen, authorization };
  h.controlsStore.db
    .prepare("INSERT INTO policy_preview_inputs VALUES(?,?,?,?)")
    .run(hash(input), stable(input), hash(input), Date.now() + 60000);
}

test(
  "PostgreSQL: a committed SQLite deletion and uncertain SQL acknowledgement resume from the exact durable manifest after reopening",
  options,
  async (t) => {
    const h = await fixture(t);
    await seedBinding(h);
    await h.retirement.retire(request, approved);
    const eraser = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
    await eraser.eraseBatch(request, "synthetic-register", 1, approved);
    const batch = "synthetic-uncertain-ack";
    const original = h.db.transaction;
    let interrupted = false;
    h.db.transaction = (work) =>
      original((tx) =>
        work({
          query: (sql, params) => {
            if (
              !interrupted &&
              sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_receipts") &&
              JSON.parse(params[2]).stage === "preview_inputs"
            ) {
              interrupted = true;
              throw new Error("synthetic_sql_acknowledgement_failure");
            }
            return tx.query(sql, params);
          },
        }),
      );
    try {
      await assert.rejects(eraser.eraseBatch(request, batch, 1, approved), /synthetic_sql_acknowledgement_failure/);
    } finally {
      h.db.transaction = original;
    }
    assert.equal(interrupted, true);
    const manifest = (
      await h.db.query("SELECT * FROM leaderboard_pipeline.derived_retirement_manifests WHERE batch_id=$1", [batch])
    ).rows[0];
    const ack = h.controlsStore.db
      .prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE batch_id=?")
      .get(batch);
    assert.equal(manifest.document_hash, ack.manifest_hash);
    assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM policy_preview_inputs").get().n, 0);
    assert.equal(
      (await h.db.query("SELECT 1 FROM leaderboard_pipeline.derived_retirement_receipts WHERE batch_id=$1", [batch]))
        .rows.length,
      0,
    );
    await h.reopen();
    const reopened = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
    const result = await reopened.eraseBatch(request, batch, 1, approved);
    assert.equal(result.removed, 1);
    assert.equal(result.alreadyAbsent, 0);
    assert.deepEqual(await reopened.eraseBatch(request, batch, 1, approved), result);
    assert.deepEqual(
      h.controlsStore.db.prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE batch_id=?").get(batch),
      ack,
    );
    const preserved = (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE repository_id=3")).rows;
    let terminal;
    for (let n = 0; n < 20; n++) {
      terminal = await reopened.eraseBatch(request, `synthetic-tail-${n}`, 1, approved);
      if (terminal.status !== "applied") break;
    }
    assert.equal(terminal.status, "owned_scope_erased");
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_ingestion.source_facts WHERE repository_id=3")).rows,
      preserved,
    );
  },
);

test("PostgreSQL fixture rejects connection-string overrides before constructing a database pool", () => {
  const base = "postgres://synthetic:synthetic@127.0.0.1:5432/leaderboard_test";
  assert.equal(checkedServiceUrl(base).hostname, "127.0.0.1");
  for (const tail of ["?host=example.invalid", "?port=443", "?user=unverified", "#fragment"])
    assert.throws(() => checkedServiceUrl(base + tail), undefined, tail);
});
