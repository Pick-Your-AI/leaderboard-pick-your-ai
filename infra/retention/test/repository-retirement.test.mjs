import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { advanceRepositoryRetirement } from "../repository-retirement.mjs";
import {
  PipelineDerivedRetirementStore,
  migratePipelineDerivedRetirement,
} from "../../../apps/pipeline/src/derived-retirement.mjs";
import { harness, getBoard, components, boardUrl } from "../../../apps/pipeline/test/harness.mjs";

const approved = async () => true;
const hash = (value) => createHash("sha256").update(components.metrics.stableJSON(value)).digest("hex");
const pgPayloads = [
  "normalizations",
  "source_artifacts",
  "source_modes",
  "snapshots",
  "heads",
  "frozen_inputs",
  "policy_comparisons",
  "corrections",
];
const sqlitePayloads = ["policy_preview_inputs", "policy_previews", "pipeline_aggregate_explanations"];
const pgRows = async (h, table) => (await h.db.query("SELECT * FROM leaderboard_pipeline." + table)).rows;
const ingestionRows = async (h, table) => (await h.db.query("SELECT * FROM leaderboard_ingestion." + table)).rows;

async function files(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await files(path)
      : entry.isFile()
        ? createHash("sha256")
            .update(await readFile(path))
            .digest("hex")
        : "nonregular";
  }
  return result;
}

async function setup(t, extra = {}) {
  const h = await harness(t, extra);
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  await migratePipelineDerivedRetirement(h.db);
  assert.equal((await h.runtime.runOnce()).state, "published");
  h.board = await getBoard(h.runtime);
  h.cache = join(h.directory, "driver-checkpoints");
  h.authorityDirectory = join(h.directory, "driver-checkpoint-authority");
  h.checkpoints = new components.github.FileCheckpointStore(h.cache, {
    tombstoneDirectory: h.authorityDirectory,
  });
  h.scoped = h.checkpoints.forRepository(2);
  h.other = h.checkpoints.forRepository(3);
  await h.scoped.save("synthetic-private-body", { source: "synthetic retired payload" });
  await h.other.save("synthetic-other-body", { source: "synthetic retained payload" });
  await h.checkpoints.save("synthetic-legacy", { source: "synthetic legacy payload" });
  h.request = {
    operationId: "synthetic-driver-retirement",
    repositoryId: 2,
    expectedGeneration: String(
      (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .generation,
    ),
    policyVersion: "synthetic-source-policy",
    authorizationReceipt: "synthetic-source-approval",
    operatorId: "synthetic-operator",
  };
  h.binding = {
    operationId: h.request.operationId,
    policyId: "synthetic-checkpoint-policy",
    authorizationId: "synthetic-checkpoint-approval",
  };
  h.envelope = {
    retirement: h.request,
    checkpoint: { repositoryId: 2, binding: h.binding },
  };
  h.dependencies = {
    db: h.db,
    controlsStore: h.controlsStore,
    scopedCheckpointStore: h.scoped,
    authorizeEnvelope: async (envelope) => {
      const { options, ...identity } = envelope;
      assert.deepEqual(identity, h.envelope);
      assert.equal(Object.isFrozen(envelope.retirement), true);
      assert.equal(Object.isFrozen(envelope.checkpoint.binding), true);
      assert.equal(Object.isFrozen(options), true);
      assert.deepEqual(Object.keys(options).sort(), ["cursor", "derivedLimit", "sourceLimit"]);
      if (options.cursor !== null) assert.equal(Object.isFrozen(options.cursor), true);
      return true;
    },
  };
  h.input = { retirement: h.request, checkpointBinding: h.binding, sourceLimit: 1, derivedLimit: 1 };
  h.collection = new components.ingestion.RepositoryRetirementStore(h.db);
  h.derived = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
  return h;
}

async function state(h) {
  const ingestion = {};
  for (const table of [
    "repository_access",
    "repository_retirements",
    "collection_erasure_batches",
    "source_facts",
    "collection_items",
  ])
    ingestion[table] = await ingestionRows(h, table);
  const pipeline = {};
  for (const table of [
    ...pgPayloads,
    "derived_retirements",
    "derived_retirement_manifests",
    "derived_retirement_receipts",
    "receipts",
  ])
    pipeline[table] = await pgRows(h, table);
  const sqlite = {};
  for (const table of [
    ...sqlitePayloads,
    "pipeline_derived_retirements",
    "pipeline_derived_retirement_snapshots",
    "pipeline_derived_retirement_batches",
  ]) {
    const exists = h.controlsStore.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);
    sqlite[table] = exists ? h.controlsStore.db.prepare("SELECT * FROM " + table).all() : null;
  }
  return {
    ingestion,
    pipeline,
    sqlite,
    controls: h.controlsStore.read(),
    cache: await files(h.cache),
    checkpoints: await files(h.authorityDirectory),
  };
}

async function counts(h) {
  return {
    derived: (await pgRows(h, "derived_retirement_manifests")).length,
    source: (await ingestionRows(h, "collection_erasure_batches")).length,
  };
}

async function advance(h, cursor, overrides = {}) {
  const before = await counts(h);
  const result = await advanceRepositoryRetirement({ ...h.input, cursor, ...overrides }, h.dependencies);
  const after = await counts(h);
  assert.ok(
    after.derived - before.derived + after.source - before.source <= 1,
    "one call cannot create two component payload batches",
  );
  if (result.receipts.source)
    assert.equal(result.receipts.derived.status, "owned_scope_erased", "source work needs native derived proof");
  return result;
}

async function until(h, predicate, cursor, overrides = {}) {
  for (let n = 0; n < 120; n++) {
    const result = await advance(h, cursor, overrides);
    if (predicate(result)) return result;
    assert.notEqual(result.status, "blocked", result.reason);
    cursor = result.cursor;
  }
  assert.fail("the finite synthetic scope did not reach the requested phase");
}

function intercept(h, query) {
  const original = h.db.transaction;
  h.db.transaction = (work) => original((tx) => work({ query: (sql, params) => query(tx, sql, params) }));
  return () => {
    h.db.transaction = original;
  };
}

function cursorFor(h, overrides = {}) {
  return {
    schemaVersion: "repository-retirement-driver/v1",
    operationHash: hash(h.request),
    checkpointHash: hash([2, h.binding]),
    phase: "derived",
    mode: "batch",
    lastBatchId: null,
    scanAfter: null,
    derivedBatchId: null,
    ...overrides,
  };
}

test("invalid limits, exact bindings, cursor references and data records leave all three stores unchanged", async (t) => {
  const h = await setup(t);
  const before = await state(h);
  let getterCalls = 0;
  const getter = { ...h.input };
  Object.defineProperty(getter, "sourceLimit", {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  const proxy = new Proxy(h.input, {
    ownKeys() {
      getterCalls++;
      return Reflect.ownKeys(h.input);
    },
  });
  const cases = [
    { ...h.input, sourceLimit: 0 },
    { ...h.input, sourceLimit: 101 },
    { ...h.input, sourceLimit: 1.5 },
    { ...h.input, sourceLimit: null },
    { ...h.input, derivedLimit: 0 },
    { ...h.input, derivedLimit: 101 },
    { ...h.input, derivedLimit: undefined },
    { ...h.input, checkpointBinding: { ...h.binding, policyId: "_invalid-leading-character" } },
    { ...h.input, checkpointBinding: { ...h.binding, operationId: "synthetic-other-operation" } },
    { ...h.input, cursor: { ...cursorFor(h), extra: true } },
    { ...h.input, cursor: cursorFor(h, { operationHash: "0".repeat(64) }) },
    { ...h.input, cursor: cursorFor(h, { checkpointHash: "0".repeat(64) }) },
    { ...h.input, cursor: cursorFor(h, { phase: "complete" }) },
    { ...h.input, cursor: cursorFor(h, { phase: "source" }) },
    { ...h.input, cursor: cursorFor(h, { scanAfter: "unknown" }) },
    { ...h.input, cursor: cursorFor(h, { lastBatchId: "unknown" }) },
    getter,
    proxy,
  ];
  for (const input of cases) {
    await assert.rejects(advanceRepositoryRetirement(input, h.dependencies));
    assert.deepEqual(await state(h), before);
  }
  assert.equal(getterCalls, 0);
  await assert.rejects(
    advanceRepositoryRetirement(h.input, {
      ...h.dependencies,
      scopedCheckpointStore: { repositoryId: 2, retire: h.scoped.retire },
    }),
    /retirement_driver_capability_unavailable/,
  );
  assert.deepEqual(await state(h), before, "an older custom scoped store is rejected before any fence");

  await rm(join(h.cache, "repositories-v1", "2"), { recursive: true });
  await writeFile(join(h.cache, "repositories-v1", "2"), "synthetic unsafe payload path");
  const unsafe = await state(h);
  await assert.rejects(advanceRepositoryRetirement(h.input, h.dependencies), /Unsafe checkpoint directory/);
  assert.deepEqual(await state(h), unsafe, "checkpoint layout is preflighted before SQL retirement");
});

test("the complete separately scoped authorization is checked again before a fence and before receipt disclosure", async (t) => {
  const h = await setup(t);
  const before = await state(h);
  let calls = 0;
  await assert.rejects(
    advanceRepositoryRetirement(h.input, {
      ...h.dependencies,
      authorizeEnvelope: async (envelope) => {
        assert.deepEqual(envelope, {
          ...h.envelope,
          options: { sourceLimit: 1, derivedLimit: 1, cursor: null },
        });
        return ++calls < 3;
      },
    }),
    /retirement_not_authorized/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(await state(h), before);
  await assert.rejects(
    advanceRepositoryRetirement(
      { ...h.input, sourceLimit: 2 },
      {
        ...h.dependencies,
        authorizeEnvelope: async (envelope) => {
          assert.deepEqual(envelope.options, { sourceLimit: 2, derivedLimit: 1, cursor: null });
          return false;
        },
      },
    ),
    /retirement_not_authorized/,
  );
  assert.deepEqual(await state(h), before, "the host may deny a requested new-batch option");
  await assert.rejects(
    advanceRepositoryRetirement(h.input, {
      ...h.dependencies,
      authorizeEnvelope: async () => {
        throw new Error("synthetic_authority_unavailable");
      },
    }),
    /synthetic_authority_unavailable/,
  );
  assert.deepEqual(await state(h), before);

  const first = await advance(h);
  const saved = await state(h);
  await assert.rejects(
    advanceRepositoryRetirement(
      { ...h.input, cursor: first.cursor },
      {
        ...h.dependencies,
        authorizeEnvelope: async (envelope) => {
          assert.deepEqual(envelope.options.cursor, first.cursor);
          return false;
        },
      },
    ),
    /retirement_not_authorized/,
  );
  await assert.rejects(
    h.collection.readProgress(h.request, async () => false),
    /retirement_not_authorized/,
  );
  await assert.rejects(
    h.derived.readProgress(h.request, async () => false),
    /retirement_not_authorized/,
  );
  for (const change of [
    { policyVersion: "synthetic-other-policy" },
    { authorizationReceipt: "synthetic-other-approval" },
    { operatorId: "synthetic-other-operator" },
    { expectedGeneration: "999" },
  ]) {
    await assert.rejects(
      h.collection.readProgress({ ...h.request, ...change }, approved),
      /retirement_operation_conflict/,
    );
    await assert.rejects(
      h.derived.readProgress({ ...h.request, ...change }, approved),
      /retirement_operation_conflict/,
    );
  }
  await assert.rejects(
    advanceRepositoryRetirement(
      { ...h.input, cursor: { ...first.cursor, lastBatchId: "synthetic-unknown-batch" } },
      h.dependencies,
    ),
    /invalid_retirement_driver_cursor/,
  );
  assert.deepEqual(
    await state(h),
    saved,
    "unknown resume references and denied metadata reads do not repair or delete",
  );
});

test("native receipts complete only the owned components and replay exactly after database and checkpoint reopen", async (t) => {
  const h = await setup(t);
  const audit = await pgRows(h, "receipts");
  const controls = h.controlsStore.publicSnapshot();
  const other = await files(join(h.cache, "repositories-v1", "3"));
  const legacy = await h.checkpoints.load("synthetic-legacy");
  const first = await advance(h);
  assert.equal(first.status, "in_progress");
  assert.equal(first.phase, "derived");
  assert.equal(first.receipts.collection.status, "collection_fenced");
  assert.equal(first.receipts.admission.status, "derived_writes_fenced");
  assert.equal(first.receipts.checkpoint.checkpointPayloadsRemoved, true);
  assert.equal(first.receipts.checkpoint.legacyUnscopedPayloads, "outside_scope");
  assert.equal((await ingestionRows(h, "source_facts")).length, 2);
  assert.equal(await files(join(h.cache, "repositories-v1", "2")), null);
  const complete = await until(h, (result) => result.status === "internal_components_erased", first.cursor);
  assert.equal(complete.phase, "complete");
  assert.equal(complete.receipts.derived.stage, "complete");
  assert.equal(complete.receipts.source.sourceFactsRemaining, false);
  assert.equal((await h.collection.readProgress(h.request, approved)).pending, null);
  for (const table of pgPayloads) assert.deepEqual(await pgRows(h, table), [], table);
  for (const table of sqlitePayloads)
    assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM " + table).get().n, 0, table);
  for (const table of ["source_facts", "collection_items", "enrichment_jobs"])
    assert.deepEqual(await ingestionRows(h, table), [], table);
  assert.ok((await ingestionRows(h, "collection_runs")).length > 0, "retained run metadata is outside the receipt");
  assert.ok((await ingestionRows(h, "collection_pages")).length > 0, "retained page metadata is outside the receipt");
  assert.deepEqual(await pgRows(h, "receipts"), audit);
  assert.deepEqual(h.controlsStore.publicSnapshot(), controls);
  assert.deepEqual(await files(join(h.cache, "repositories-v1", "3")), other);
  assert.deepEqual(await h.checkpoints.load("synthetic-legacy"), legacy);
  await assert.rejects(h.scoped.save("late", { source: "synthetic stale write" }), /repository_checkpoint_retired/);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.runtime.app.inject(boardUrl + "&snapshot=" + h.board.snapshotId)).statusCode, 410);

  // Arm denial only after the post-source-replay progress transaction commits.
  // Earlier native authorization calls cannot satisfy this final-disclosure test.
  const beforeDenial = await state(h);
  const transaction = h.db.transaction;
  let sourceReplayed = false;
  let armed = false;
  let denied = 0;
  h.db.transaction = async (work) => {
    let sourceReplay = false;
    let progressRead = false;
    const value = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const result = await tx.query(sql, params);
          if (sql.includes("SELECT * FROM leaderboard_ingestion.erase_collected_source_batch")) sourceReplay = true;
          if (
            sourceReplayed &&
            sql.includes("FROM leaderboard_ingestion.collection_erasure_batches WHERE operation_id=$1 AND batch_id=$2")
          )
            progressRead = true;
          return result;
        },
      }),
    );
    if (sourceReplay) sourceReplayed = true;
    if (progressRead) armed = true;
    return value;
  };
  try {
    await assert.rejects(
      advanceRepositoryRetirement(
        { ...h.input, cursor: complete.cursor },
        {
          ...h.dependencies,
          authorizeEnvelope: async (envelope) => {
            await h.dependencies.authorizeEnvelope(envelope);
            if (!armed) return true;
            denied++;
            return false;
          },
        },
      ),
      /retirement_not_authorized/,
    );
  } finally {
    h.db.transaction = transaction;
  }
  assert.equal(sourceReplayed, true);
  assert.equal(armed, true);
  assert.equal(denied, 1);
  assert.deepEqual(await state(h), beforeDenial, "a denied terminal replay discloses no completed result");

  const stableCounts = await counts(h);
  await h.reopenDatabase();
  const reopenedControls = new components.controls.ControlStore(join(h.directory, "controls.sqlite"));
  const reopenedCheckpoint = new components.github.FileCheckpointStore(h.cache, {
    tombstoneDirectory: h.authorityDirectory,
  }).forRepository(2);
  try {
    const replay = await advanceRepositoryRetirement(
      { ...h.input, cursor: complete.cursor, sourceLimit: 7, derivedLimit: 8 },
      { ...h.dependencies, controlsStore: reopenedControls, scopedCheckpointStore: reopenedCheckpoint },
    );
    assert.equal(replay.status, "internal_components_erased");
    assert.deepEqual(replay.receipts, complete.receipts);
    assert.deepEqual(await counts(h), stableCounts);
  } finally {
    reopenedControls.close();
  }
});

test("a PostgreSQL-only derived admission and an existing checkpoint marker resume their unfinished components", async (t) => {
  const h = await setup(t);
  await h.collection.retire(h.request, approved);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = () => {
    throw new Error("synthetic_sqlite_admission_interruption");
  };
  try {
    await assert.rejects(h.derived.admit(h.request, approved), /synthetic_sqlite_admission_interruption/);
  } finally {
    h.controlsStore.transaction = transaction;
  }
  assert.equal((await pgRows(h, "derived_retirements")).length, 1);
  assert.equal(
    h.controlsStore.db.prepare("SELECT 1 FROM sqlite_master WHERE name='pipeline_derived_retirements'").get(),
    undefined,
  );
  await h.scoped.retire(h.binding);
  // Emulate a stopped cleanup after the durable marker, without bypassing any
  // product API in the invocation under test.
  const payload = join(h.cache, "repositories-v1", "2");
  await mkdir(payload, { recursive: true });
  await writeFile(join(payload, "synthetic-stopped-cleanup.json"), '{"source":"synthetic retained bytes"}');
  await h.reopenDatabase();
  const result = await advance(h);
  assert.equal(result.receipts.admission.status, "derived_writes_fenced");
  assert.equal(result.receipts.checkpoint.checkpointPayloadsRemoved, true);
  assert.equal(await files(payload), null);
  assert.equal(h.controlsStore.db.prepare("SELECT count(*) AS n FROM pipeline_derived_retirements").get().n, 1);
  assert.equal((await ingestionRows(h, "repository_retirements")).length, 1);
});

test("a persisted manifest and SQLite acknowledgement replay their original limit after a failed SQL receipt", async (t) => {
  const h = await setup(t);
  let stopped = false;
  const restore = intercept(h, async (tx, sql, params) => {
    if (!stopped && sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_receipts")) {
      stopped = true;
      throw new Error("synthetic_receipt_interruption");
    }
    return tx.query(sql, params);
  });
  try {
    await assert.rejects(advance(h), /synthetic_receipt_interruption/);
  } finally {
    restore();
  }
  assert.equal(stopped, true);
  const manifest = (await pgRows(h, "derived_retirement_manifests"))[0];
  assert.equal(manifest.batch_limit, 1);
  assert.equal(manifest.document.stage, "register_snapshot");
  assert.deepEqual(await pgRows(h, "derived_retirement_receipts"), []);
  const acknowledgement = h.controlsStore.db
    .prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE batch_id=?")
    .get(manifest.batch_id);
  assert.equal(acknowledgement.manifest_hash, manifest.document_hash);
  await h.reopenDatabase();
  const retried = await advance(h, undefined, { derivedLimit: 7 });
  assert.equal(retried.receipts.derived.batchId, manifest.batch_id);
  assert.equal(retried.receipts.derived.selected, 1);
  assert.equal((await pgRows(h, "derived_retirement_manifests")).length, 1);
  assert.equal((await pgRows(h, "derived_retirement_receipts")).length, 1);
  assert.deepEqual(
    h.controlsStore.db
      .prepare("SELECT * FROM pipeline_derived_retirement_batches WHERE batch_id=?")
      .get(manifest.batch_id),
    acknowledgement,
  );
  const progress = await h.derived.readProgress(h.request, approved, { batchId: manifest.batch_id });
  assert.equal(progress.batch.limit, 1);
  assert.equal(progress.batch.receipt.hash, hash(retried.receipts.derived));
});

test("concurrent same-operation callers share one persisted batch identity and changed limits cannot overwrite it", async (t) => {
  const h = await setup(t);
  const transaction = h.db.transaction;
  let release;
  const bothMissing = new Promise((resolve) => {
    release = resolve;
  });
  let absent = 0;
  h.db.transaction = async (work) => {
    let missing = false;
    const result = await transaction((tx) =>
      work({
        query: async (sql, params) => {
          const value = await tx.query(sql, params);
          if (sql.includes("WHERE m.operation_id=$1 AND m.batch_id=$2") && value.rows.length === 0) missing = true;
          return value;
        },
      }),
    );
    // Hold only after the native transaction releases its locks. Both callers
    // must observe the same absent ID before either attempts batch admission.
    if (missing && absent < 2) {
      absent++;
      if (absent === 2) release();
      await bothMissing;
    }
    return result;
  };
  let results;
  try {
    results = await Promise.all([
      advanceRepositoryRetirement(h.input, h.dependencies),
      advanceRepositoryRetirement({ ...h.input, derivedLimit: 2 }, h.dependencies),
    ]);
  } finally {
    release();
    h.db.transaction = transaction;
  }
  assert.equal(absent, 2);
  assert.deepEqual(results.map((result) => result.status).sort(), ["in_progress", "retry"]);
  const manifests = await pgRows(h, "derived_retirement_manifests");
  assert.equal(manifests.length, 1);
  assert.ok([1, 2].includes(manifests[0].batch_limit));
  const receipts = await pgRows(h, "derived_retirement_receipts");
  assert.equal(receipts.length, 1);
  for (const result of results) {
    assert.equal(result.cursor.lastBatchId, manifests[0].batch_id);
    if (result.receipts.derived) assert.deepEqual(result.receipts.derived, receipts[0].document);
  }
  const before = await state(h);
  await assert.rejects(
    advanceRepositoryRetirement(
      {
        ...h.input,
        retirement: { ...h.request, operationId: "synthetic-competing-operation" },
        checkpointBinding: { ...h.binding, operationId: "synthetic-competing-operation" },
      },
      { ...h.dependencies, authorizeEnvelope: approved },
    ),
    /repository_checkpoint_retirement_conflict|retirement_operation_conflict/,
  );
  assert.deepEqual(await state(h), before);
});

test("lost progress discovers at most 64 retained entries and replays a pending native batch on a later call", async (t) => {
  const h = await setup(t, {
    transformPayloads: ([sample]) =>
      Array.from({ length: 70 }, (_, index) => ({
        ...sample,
        id: 1001 + index,
        number: 1 + index,
        node_id: "SYNTHETIC_DRIVER_ISSUE_" + index,
        html_url: "https://github.com/synthetic-org/synthetic-repo/issues/" + (index + 1),
      })),
  });
  assert.equal((await ingestionRows(h, "source_facts")).length, 70);
  await h.collection.retire(h.request, approved);
  for (let n = 0; n < 65; n++) {
    const receipt = await h.derived.eraseBatch(h.request, "manual-" + String(n).padStart(3, "0"), 1, approved);
    assert.equal(receipt.status, "applied");
  }
  let stopped = false;
  const restore = intercept(h, async (tx, sql, params) => {
    if (!stopped && sql.includes("INSERT INTO leaderboard_pipeline.derived_retirement_receipts")) {
      stopped = true;
      throw new Error("synthetic_pending_batch");
    }
    return tx.query(sql, params);
  });
  try {
    await assert.rejects(h.derived.eraseBatch(h.request, "manual-065", 1, approved), /synthetic_pending_batch/);
  } finally {
    restore();
  }
  assert.equal(stopped, true);
  const page = await h.derived.readProgress(h.request, approved);
  assert.equal(page.entries.length, 64);
  assert.equal(page.nextCursor, "manual-063");
  for (const entry of page.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["batchId", "limit", "manifestHash", "receipt"]);
    assert.deepEqual(Object.keys(entry.receipt).sort(), ["hash", "stage", "status"]);
  }
  const saved = await counts(h);
  let result = await advance(h, undefined, { derivedLimit: 7 });
  assert.equal(result.status, "discovering");
  assert.equal(result.cursor.scanAfter, null);
  result = await advance(h, result.cursor, { derivedLimit: 7 });
  assert.equal(result.status, "discovering");
  assert.equal(result.cursor.scanAfter, "manual-063");
  result = await advance(h, result.cursor, { derivedLimit: 7 });
  assert.equal(result.cursor.lastBatchId, "manual-065");
  assert.deepEqual(await counts(h), saved, "discovery never creates or applies a batch");
  assert.equal(
    (await pgRows(h, "derived_retirement_receipts")).some((row) => row.batch_id === "manual-065"),
    false,
  );
  result = await advance(h, result.cursor, { derivedLimit: 7 });
  assert.equal(result.receipts.derived.batchId, "manual-065");
  assert.equal(result.receipts.derived.selected, 1);
  assert.equal((await pgRows(h, "derived_retirement_manifests")).length, 66);
  assert.equal((await pgRows(h, "derived_retirement_receipts")).length, 66);
});

test("every old blocked source batch finishes before an older terminal hint can report internal completion", async (t) => {
  const h = await setup(t);
  await h.collection.retire(h.request, approved);
  for (const id of ["manual-source-a", "manual-source-b", "manual-source-c"])
    assert.equal((await h.collection.eraseBatch(h.request, id, 1, approved)).status, "blocked");
  const source = await until(h, (result) => result.phase === "source");
  const first = await advance(h, source.cursor, { sourceLimit: 9 });
  assert.equal(first.receipts.source.batchId, "manual-source-a");
  assert.equal(first.receipts.source.attempt, 2);
  assert.equal(first.receipts.source.deletedSourceFacts, 1);
  const second = await advance(h, first.cursor, { sourceLimit: 9 });
  assert.equal(second.receipts.source.batchId, "manual-source-b");
  assert.equal(second.receipts.source.sourceFactsRemaining, false);
  assert.equal(second.status, "in_progress", "the third old blocked receipt is still pending");
  const hint = await h.collection.readProgress(h.request, approved);
  assert.equal(hint.terminal.batchId, "manual-source-b");
  assert.equal(hint.pending.batchId, "manual-source-c");
  const complete = await advance(h, second.cursor, { sourceLimit: 9 });
  assert.equal(complete.receipts.source.batchId, "manual-source-c");
  assert.equal(complete.receipts.source.deletedSourceFacts, 0);
  assert.equal(complete.receipts.source.attempt, 2);
  assert.equal(complete.status, "internal_components_erased");
  const retained = await ingestionRows(h, "collection_erasure_batches");
  assert.equal(retained.length, 3);
  assert.equal(
    retained.every((row) => row.batch_limit === 1 && row.status === "erased"),
    true,
  );
});

test("retained dispatch proof remains blocked and native integrity failures are never generic retry success", async (t) => {
  const h = await setup(t);
  const snapshot = (await pgRows(h, "snapshots"))[0];
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.dispatch_publications(operation_key,scope_key,snapshot_id,scope_hash)" +
      " VALUES($1,$2,$3,sha256(convert_to($2,'UTF8')))",
    ["synthetic-driver-dispatch-proof", snapshot.scope_key, snapshot.snapshot_id],
  );
  const before = {};
  for (const table of pgPayloads) before[table] = await pgRows(h, table);
  const first = await advance(h);
  assert.equal(first.status, "blocked");
  assert.equal(first.reason, "retained_dispatch_authority");
  assert.equal(first.receipts.derived.removed, 0);
  assert.equal(first.receipts.source, undefined);
  assert.deepEqual(await ingestionRows(h, "collection_erasure_batches"), []);
  for (const table of pgPayloads) assert.deepEqual(await pgRows(h, table), before[table], table);
  const replay = await advance(h, first.cursor);
  assert.deepEqual(replay.receipts.derived, first.receipts.derived);
  assert.equal(replay.status, "blocked");

  const restore = intercept(h, async (tx, sql, params) => {
    const result = await tx.query(sql, params);
    if (sql.includes("SELECT * FROM leaderboard_pipeline.derived_retirement_manifests"))
      return { ...result, rows: result.rows.map((row) => ({ ...row, document_hash: "0".repeat(64) })) };
    return result;
  });
  try {
    await assert.rejects(advance(h, first.cursor), /derived_retirement_integrity_error/);
  } finally {
    restore();
  }
  assert.equal((await pgRows(h, "derived_retirement_manifests")).length, 1);
  assert.equal((await pgRows(h, "derived_retirement_receipts")).length, 1);
  assert.deepEqual(await ingestionRows(h, "collection_erasure_batches"), []);
});
