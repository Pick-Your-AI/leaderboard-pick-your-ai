import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import * as ingestion from "../../../packages/ingestion/dist/index.js";
import { migratePipeline } from "../src/scope-storage.mjs";
import { createMetadataEnrichment } from "../src/metadata-enrichment.mjs";

let engine, db, collection;
before(async () => {
  engine = new PGlite();
  for (const name of ["001_ingestion", "002_snapshots", "003_collection"])
    await engine.exec(
      await readFile(new URL(`../../../packages/ingestion/sql/${name}.up.sql`, import.meta.url), "utf8"),
    );
  db = {
    query: (sql, params) => engine.query(sql, params),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, params) => tx.query(sql, params) })),
  };
  await migratePipeline(db);
});
after(async () => engine?.close());
beforeEach(async () => {
  await db.query(
    "TRUNCATE leaderboard_ingestion.repository_access,leaderboard_ingestion.source_facts,leaderboard_ingestion.object_suppressions,leaderboard_ingestion.lifecycle_receipts CASCADE",
  );
  collection = new ingestion.CollectionStore(db);
});
const latch = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const config = () => ({
  version: "synthetic-config-v1",
  repositories: [{ id: 2, installationId: 1, families: ["issues"] }],
});
const details = (request, overrides = {}) => ({
  sourceRevision: request.fact.sourceRevision,
  acceptedOutcome: true,
  reviewState: null,
  additions: 0,
  deletions: null,
  changedFiles: 0,
  ...overrides,
});
function host(options = {}) {
  let revision = 1,
    allowed = true;
  const seen = [],
    calls = [];
  const value = options.config ?? config();
  const setting = options.setting ?? {
    policyVersion: "synthetic-metadata-v1",
    source: {
      async readMetadata(request) {
        calls.push(request);
        return details(request);
      },
    },
    configurationCurrent(binding) {
      seen.push(binding);
      return allowed;
    },
  };
  const capture = async () => {
    if (!allowed) throw new Error("enrichment_authorization_changed");
    const original = revision;
    const current = () => {
      if (!allowed || revision !== original) throw new Error("enrichment_authorization_changed");
    };
    return { revision, current, authorize: async () => current() };
  };
  const create = () =>
    createMetadataEnrichment({ db, ingestion, setting, config: value, dataMode: "synthetic", capture });
  return {
    worker: create(),
    create,
    calls,
    seen,
    config: value,
    setting,
    revoke: () => {
      allowed = false;
    },
    restore: () => {
      allowed = true;
      revision++;
    },
    advance: () => revision++,
  };
}
async function seed({
  repositoryId = 2,
  installationId = 1,
  family = "issues",
  mode = "synthetic",
  count = 1,
  suffix = "first",
} = {}) {
  await collection.verifyPublic(repositoryId, installationId, null);
  const runId = `synthetic-${repositoryId}-${family}-${suffix}`;
  await collection.start({
    runId,
    repositoryId,
    family,
    mode: "backfill",
    since: null,
    until: "2026-01-02T00:00:00.000Z",
  });
  const facts = Array.from({ length: count }, (_, i) => ({
    subjectId: `SYNTHETIC_${repositoryId}_${family}_${suffix}_${i}`,
    sourceRevision: "synthetic-source-v1",
    sourceUrl: `https://github.com/synthetic-org/synthetic-repo/issues/${i + 1}`,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "closed",
  }));
  assert.equal(
    await collection.step(runId, {
      readPage: async () => ({ repositoryId, visibility: "public", facts, nextCursor: null, expectedCount: count }),
    }),
    "complete",
  );
  const keys = (
    await db.query("SELECT fact_key FROM leaderboard_ingestion.collection_items WHERE run_id=$1 ORDER BY fact_key", [
      runId,
    ])
  ).rows.map((row) => row.fact_key);
  if (mode !== null)
    await db.query(
      `INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode)
    SELECT unnest($1::text[]),$2 ON CONFLICT DO NOTHING`,
      [keys, mode],
    );
  return keys;
}
const jobs = async () =>
  (await db.query("SELECT * FROM leaderboard_ingestion.enrichment_jobs ORDER BY fact_key,policy_version")).rows;

async function restoreIdenticalFact(key, number) {
  const fact = (await db.query("SELECT document FROM leaderboard_ingestion.source_facts WHERE fact_key=$1", [key]))
    .rows[0].document;
  assert.equal(
    await collection.suppress(
      `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
      "5".repeat(64),
      1,
      [2],
      "private",
    ),
    "accepted",
  );
  const generation = String(
    (await db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
      .generation,
  );
  assert.equal(await collection.verifyPublic(2, 1, generation), true);
  const runId = `synthetic-restored-identical-${number}`;
  await collection.start({
    runId,
    repositoryId: 2,
    family: "issues",
    mode: "reconcile",
    since: null,
    until: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(
    await collection.step(runId, {
      readPage: async () => ({
        repositoryId: 2,
        visibility: "public",
        facts: [structuredClone(fact)],
        nextCursor: null,
        expectedCount: 1,
      }),
    }),
    "complete",
  );
  assert.deepEqual(
    (await db.query("SELECT fact_key FROM leaderboard_ingestion.collection_items WHERE run_id=$1", [runId])).rows.map(
      (row) => row.fact_key,
    ),
    [key],
  );
}

test("metadata integration is absent by default and rejects incomplete implicit adapters", () => {
  const input = { db, ingestion, config: config(), dataMode: "synthetic", capture: async () => assert.fail("capture") };
  assert.equal(createMetadataEnrichment(input), null);
  for (const setting of [
    null,
    false,
    {},
    { policyVersion: "v1", source: { readMetadata() {} } },
    { policyVersion: "v1", source: { readMetadata() {} }, configurationCurrent: () => true, prompt: "SYNTHETIC" },
  ])
    assert.throws(() => createMetadataEnrichment({ ...input, setting }), /invalid_metadata_enrichment_options/);
});

test("retained collection is swept after an enqueue gap and resumes idempotently through a new host", async () => {
  await seed();
  assert.deepEqual(await jobs(), []);
  const h = host();
  assert.equal(await h.worker.processOne(), "classified");
  const original = await jobs();
  assert.equal(original.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(await h.create().processOne(), "idle");
  assert.deepEqual(await jobs(), original);
  assert.equal(h.calls.length, 1);
  const records = await h.worker.readStates(2, "issues");
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "classified");
  assert.equal("metadata" in records[0], false);
});

test("an identical fact is reclassified after public source access is freshly restored", async () => {
  const [key] = await seed();
  const h = host();
  assert.equal(await h.worker.processOne(), "classified");
  const original = (await jobs())[0];
  const originalBinding = structuredClone(h.seen[0]);
  await restoreIdenticalFact(key, 58);
  assert.equal(await h.worker.processOne(), "classified");
  const retained = await jobs();
  assert.equal(retained.length, 2);
  assert.deepEqual(
    retained.find((row) => row.policy_version === original.policy_version),
    original,
  );
  const current = await h.worker.readStates(2, "issues");
  assert.equal(current.length, 1);
  assert.equal(current[0].state, "classified");
  assert.equal(h.calls.length, 2);
  const currentBinding = h.seen.at(-1);
  assert.equal(currentBinding.configurationHash, originalBinding.configurationHash);
  assert.equal(currentBinding.controlsConfigurationRevision, originalBinding.controlsConfigurationRevision);
  assert.equal(currentBinding.policyVersion, originalBinding.policyVersion);
  assert.notEqual(currentBinding.accessGeneration, originalBinding.accessGeneration);
});

test("late metadata from a prior source generation cannot overwrite a restored classification", async () => {
  const [key] = await seed();
  const started = latch(),
    finish = latch();
  let calls = 0;
  const h = host({
    setting: {
      policyVersion: "synthetic-metadata-v1",
      configurationCurrent: () => true,
      source: {
        async readMetadata(request) {
          if (++calls === 1) {
            started.resolve();
            await finish.promise;
          }
          return details(request);
        },
      },
    },
  });
  const oldWork = h.worker.processOne();
  const denied = assert.rejects(oldWork, /enrichment_authorization_changed/);
  await started.promise;
  const original = (await jobs())[0];
  await restoreIdenticalFact(key, 59);
  assert.equal(await h.create().processOne(), "classified");
  const current = (await jobs()).find((row) => row.policy_version !== original.policy_version);
  finish.resolve();
  await denied;
  assert.deepEqual(
    (await jobs()).find((row) => row.policy_version === original.policy_version),
    original,
  );
  assert.deepEqual(
    (await jobs()).find((row) => row.policy_version === current.policy_version),
    current,
  );
  assert.equal(current.state, "classified");
  assert.equal((await h.worker.readStates(2, "issues")).length, 1);
  assert.equal(calls, 2);
});

test("source restoration between authority capture and sweep rejects the stale operation before enqueue", async () => {
  const [key] = await seed();
  let captures = 0,
    calls = 0;
  const wrapped = {
    query: db.query,
    transaction: async (work) => {
      const result = await db.transaction(work);
      if (++captures === 1) await restoreIdenticalFact(key, 60);
      return result;
    },
  };
  const worker = createMetadataEnrichment({
    db: wrapped,
    ingestion,
    config: config(),
    dataMode: "synthetic",
    capture: async () => ({ revision: 1, current: () => true, authorize: async () => true }),
    setting: {
      policyVersion: "synthetic-metadata-v1",
      configurationCurrent: () => true,
      source: {
        async readMetadata(request) {
          calls++;
          return details(request);
        },
      },
    },
  });
  await assert.rejects(worker.processOne(), /enrichment_authorization_changed/);
  assert.equal(calls, 0);
  assert.deepEqual(await jobs(), []);
  assert.equal(await worker.processOne(), "classified");
  assert.equal(calls, 1);
});

test("only configured current source membership and exact data mode enter the metadata queue", async () => {
  const [expected] = await seed();
  await seed({ repositoryId: 3 });
  await seed({ family: "reviews" });
  await seed({ suffix: "public", mode: "public" });
  await seed({ suffix: "unknown", mode: null });
  const h = host();
  assert.equal(await h.worker.processOne(), "classified");
  assert.deepEqual(
    (await jobs()).map((row) => row.fact_key),
    [expected],
  );
  assert.equal(h.calls[0].family, "issues");
  assert.equal(h.calls[0].repositoryId, 2);
  await assert.rejects(h.worker.readStates(3, "issues"), /unconfigured_enrichment_scope/);
  await assert.rejects(h.worker.readStates(2, "reviews"), /unconfigured_enrichment_scope/);
});

test("wrong installation and unrenewed access generation never call the adapter", async () => {
  await seed({ installationId: 9 });
  const h = host();
  assert.equal(await h.worker.processOne(), "idle");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await jobs(), []);
  await db.query("UPDATE leaderboard_ingestion.repository_access SET installation_id=1,generation=generation+1");
  assert.equal(await h.worker.processOne(), "idle");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await jobs(), []);
});

test("namespace captures host config and rejects mixed duplicate family declarations", async () => {
  await seed();
  const h = host();
  h.config.repositories[0].id = 999;
  h.setting.policyVersion = "synthetic-mutated";
  h.setting.source.readMetadata = () => assert.fail("function was not captured");
  assert.equal(await h.worker.processOne(), "classified");
  assert.equal(h.calls[0].repositoryId, 2);
  assert.equal(h.seen[0].policyVersion, "synthetic-metadata-v1");
  assert.equal(h.seen[0].dataMode, "synthetic");
  assert.match(h.seen[0].configurationHash, /^[a-f0-9]{64}$/);
  assert.throws(
    () =>
      host({ config: { ...config(), repositories: [{ id: 2, installationId: 1, families: ["issues", "issues"] }] } }),
    /invalid_metadata_enrichment_scope/,
  );
});

test("authority changes withhold in-flight results and a new controls revision has a distinct job identity", async () => {
  await seed();
  const started = latch(),
    finish = latch();
  const h = host({
    setting: {
      policyVersion: "synthetic-metadata-v1",
      configurationCurrent: () => true,
      source: {
        async readMetadata(request) {
          started.resolve();
          await finish.promise;
          return details(request);
        },
      },
    },
  });
  const pending = h.worker.processOne();
  const denied = assert.rejects(pending, /enrichment_authorization_changed/);
  await started.promise;
  h.advance();
  finish.resolve();
  await denied;
  const previous = (await jobs())[0];
  assert.equal(previous.state, "leased");
  assert.equal(previous.metadata, null);
  assert.deepEqual(await h.worker.readStates(2, "issues"), []);
  assert.equal(await h.worker.processOne(), "classified");
  const all = await jobs();
  assert.equal(all.length, 2);
  assert.notEqual(all[0].policy_version, all[1].policy_version);
  assert.equal((await h.worker.readStates(2, "issues"))[0].state, "classified");
});

test("one worker operation queues at most one hundred retained facts", async () => {
  await seed({ count: 100 });
  await seed({ suffix: "second" });
  const h = host();
  assert.equal(await h.worker.processOne(), "classified");
  assert.equal((await jobs()).length, 100);
  assert.equal(await h.worker.processOne(), "classified");
  assert.equal((await jobs()).length, 101);
  assert.equal(h.calls.length, 2);
});

test("metadata completion neither creates observations nor recognition or publications", async () => {
  await seed();
  const h = host();
  assert.equal(await h.worker.processOne(), "classified");
  for (const table of [
    "leaderboard_ingestion.observations",
    "leaderboard_ingestion.outbox",
    "leaderboard_pipeline.normalizations",
    "leaderboard_pipeline.snapshots",
    "leaderboard_pipeline.receipts",
  ])
    assert.equal((await db.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 0, table);
});

test("closed source state is not treated as accepted when required metadata is unknown", async () => {
  await seed();
  const h = host({
    setting: {
      policyVersion: "synthetic-metadata-v1",
      configurationCurrent: () => true,
      source: { readMetadata: async (request) => details(request, { acceptedOutcome: null }) },
    },
  });
  assert.equal(await h.worker.processOne(), "failed");
  assert.equal((await h.worker.readStates(2, "issues"))[0].state, "failed");
  assert.equal((await jobs())[0].metadata, null);
});

test("asynchronous or false host currentness cannot authorize a metadata read", async () => {
  await seed();
  for (const current of [() => false, async () => true, () => Promise.reject(new Error("SYNTHETIC PRIVATE"))]) {
    const h = host({
      setting: {
        policyVersion: "synthetic-metadata-v1",
        configurationCurrent: current,
        source: { readMetadata: async () => assert.fail("unauthorized read") },
      },
    });
    await assert.rejects(h.worker.processOne(), /enrichment_authorization_changed/);
  }
  assert.deepEqual(await jobs(), []);
});

test("background worker runs independently and shutdown settles a stalled metadata request", async () => {
  await seed();
  const started = latch(),
    finish = latch();
  let request;
  const h = host({
    setting: {
      policyVersion: "synthetic-metadata-v1",
      configurationCurrent: () => true,
      source: {
        async readMetadata(value) {
          request = value;
          started.resolve();
          await finish.promise;
          return details(value);
        },
      },
    },
  });
  const loop = new AbortController();
  const running = h.worker.run(loop.signal);
  await started.promise;
  assert.equal((await h.worker.readStates(2, "issues"))[0].state, "leased");
  // Stop cancels the adapter wait; this does not require its promise to resolve.
  h.worker.stop();
  loop.abort();
  await running;
  await h.worker.settled();
  assert.equal(request.signal.aborted, true);
  finish.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await jobs())[0].metadata, null);
  await assert.rejects(h.worker.processOne(), /enrichment_authorization_changed/);
});
