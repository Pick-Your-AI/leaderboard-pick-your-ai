import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { CollectionStore } from "../dist/index.js";
import { parseContentEditMetadata } from "../dist/content-edit-metadata.js";
import { edit, parent, repository } from "../../../tests/fixtures/content-edit-metadata.mjs";

const migrations = await Promise.all(
  ["001_ingestion", "002_snapshots", "003_collection"].map((name) =>
    readFile(new URL("../sql/" + name + ".up.sql", import.meta.url), "utf8"),
  ),
);
function database(engine) {
  return {
    query: (sql, parameters) => engine.query(sql, parameters),
    transaction: (work) => engine.transaction((tx) => work({ query: (sql, parameters) => tx.query(sql, parameters) })),
  };
}
async function initialize(engine) {
  for (const sql of migrations) await engine.exec(sql);
}
let engine, db, collection;
before(async () => {
  engine = new PGlite();
  await initialize(engine);
  db = database(engine);
});
beforeEach(async () => {
  await db.query(
    "TRUNCATE leaderboard_ingestion.repository_access,leaderboard_ingestion.source_facts," +
      "leaderboard_ingestion.object_suppressions,leaderboard_ingestion.lifecycle_receipts CASCADE",
  );
  collection = new CollectionStore(db);
  await collection.verifyPublic(repository.id, 1, null);
});
after(async () => engine?.close());

function metadata(kind = "issue", number = 11) {
  const native = parent(kind, number);
  const item = edit();
  return parseContentEditMetadata({
    version: "github-content-edit-metadata/v1",
    parent: { kind, id: native.id, number: native.number, url: native.url },
    includesCreatedEdit: true,
    history: {
      availability: "available",
      retainedTotalCount: 1,
      records: [
        {
          id: item.id,
          createdAt: item.createdAt,
          editedAt: item.editedAt,
          updatedAt: item.updatedAt,
          editor: { kind: "User", id: item.editor.id, databaseId: item.editor.databaseId },
          deletedAt: item.deletedAt,
          deletedBy: item.deletedBy,
        },
      ],
    },
  });
}
function syntheticRevision(value, scanId) {
  const prefix = "gh-content-edit-v1:";
  const selected = parseContentEditMetadata(value);
  const hash = (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `${prefix}${hash(selected)}.${hash([prefix, scanId]).slice(0, 32)}`;
}
function fact(value = metadata(), scanId = "synthetic-metadata-scan") {
  return {
    subjectId: value.parent.id,
    sourceRevision: syntheticRevision(value, scanId),
    sourceUrl: value.parent.url,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "present",
    contentEditMetadata: value,
  };
}
const scan = (runId, extra = {}) => ({
  runId,
  repositoryId: repository.id,
  family: "content_edits",
  mode: "audit",
  since: null,
  until: "2026-01-04T00:00:00.000Z",
  ...extra,
});
const page = (facts, extra = {}) => ({
  repositoryId: repository.id,
  visibility: "public",
  facts,
  expectedCount: null,
  nextCursor: null,
  ...extra,
});
const rows = async (table, source = db) =>
  (await source.query("SELECT * FROM leaderboard_ingestion." + table + " ORDER BY 1")).rows;
async function commit(runId, facts, extra = {}, store = collection) {
  await store.start(scan(runId));
  return store.step(runId, { readPage: async () => page(facts, extra) });
}
async function noDerivedEffects(source = db) {
  for (const name of ["object_suppressions", "observations", "outbox", "enrichment_jobs"])
    assert.deepEqual(await rows(name, source), [], name + " must remain empty");
}

test("private parent metadata and the exact page cursor survive a physical database close and reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "content-edit-collection-"));
  let durable;
  t.after(async () => {
    await durable?.close();
    await rm(directory, { recursive: true, force: true });
  });
  durable = new PGlite(join(directory, "database"));
  await initialize(durable);
  let diskDb = database(durable);
  let store = new CollectionStore(diskDb);
  await store.verifyPublic(repository.id, 1, null);
  const request = scan("synthetic-durable");
  const first = fact(metadata(), request.runId);
  const secondMetadata = metadata("pull_request", 12);
  secondMetadata.includesCreatedEdit = false;
  secondMetadata.history = { availability: "unavailable", retainedTotalCount: null, records: null };
  const second = fact(secondMetadata, request.runId);
  await store.start(request);
  assert.equal(
    await store.step(
      request.runId,
      {
        readPage: async (actual) => {
          assert.deepEqual(actual, { ...request, cursor: null, limit: 1 });
          return page([first], { nextCursor: "native-parent-page-2" });
        },
      },
      1,
    ),
    "progress",
  );
  const originalFacts = await rows("source_facts", diskDb);
  const originalPage = await rows("collection_pages", diskDb);
  const originalRun = (await rows("collection_runs", diskDb))[0];
  assert.deepEqual(originalFacts[0].document, first);
  assert.equal(originalRun.cursor, "native-parent-page-2");
  assert.equal(originalRun.expected_count, null);
  await durable.close();
  durable = undefined;
  durable = new PGlite(join(directory, "database"));
  diskDb = database(durable);
  store = new CollectionStore(diskDb);
  assert.deepEqual(await rows("source_facts", diskDb), originalFacts);
  assert.deepEqual(await rows("collection_pages", diskDb), originalPage);
  assert.deepEqual(await rows("collection_runs", diskDb), [originalRun]);
  await store.start(request);
  assert.equal(
    await store.step(
      request.runId,
      {
        readPage: async (actual) => {
          assert.deepEqual(actual, { ...request, cursor: "native-parent-page-2", limit: 1 });
          return page([second]);
        },
      },
      1,
    ),
    "complete",
  );
  const complete = await rows("collection_runs", diskDb);
  assert.equal(complete[0].access_generation, originalRun.access_generation);
  assert.equal(new Date(complete[0].until_at).toISOString(), request.until);
  assert.equal(complete[0].page_count, 2);
  assert.equal(complete[0].item_count, 2);
  assert.equal(complete[0].expected_count, null);
  assert.equal(complete[0].cursor, null);
  const retained = await rows("source_facts", diskDb);
  assert.deepEqual(retained.find((x) => x.subject_id === first.subjectId).document, first);
  assert.deepEqual(retained.find((x) => x.subject_id === second.subjectId).document, second);
  assert.equal(
    await store.step(request.runId, { readPage: async () => assert.fail("completed run performed I/O") }),
    "complete",
  );
  assert.equal((await store.diagnostics(repository.id))[0].counts_reconciled, false);
  await noDerivedEffects(diskDb);
});

test("null history and independently redacted edit metadata preserve the parent without credit or suppression", async () => {
  const parentFact = {
    subjectId: metadata().parent.id,
    sourceRevision: "synthetic-parent-revision",
    sourceUrl: metadata().parent.url,
    evidence: "observed_transition",
    actorId: "SYNTHETIC_PARENT_ACTOR",
    occurredAt: "2026-01-02T00:00:00.000Z",
    state: "present",
  };
  await collection.start(scan("synthetic-parent", { family: "issues" }));
  assert.equal(
    await collection.step("synthetic-parent", { readPage: async () => page([parentFact], { expectedCount: 1 }) }),
    "complete",
  );
  const original = (await rows("source_facts"))[0];
  const unknown = metadata();
  unknown.history = { availability: "unavailable", retainedTotalCount: null, records: null };
  const redacted = metadata();
  redacted.history.records[0].editor = null;
  redacted.history.records[0].deletedAt = "2026-02-03T00:00:00.000Z";
  redacted.history.records[0].deletedBy = { kind: "unknown", typename: "Organization" };
  // Current metadata may be newer than the fixed run cutoff; it remains no event evidence.
  assert.equal(await commit("synthetic-unavailable", [fact(unknown, "synthetic-unavailable")]), "complete");
  assert.equal(await commit("synthetic-redacted", [fact(redacted, "synthetic-redacted")]), "complete");
  const retained = await rows("source_facts");
  assert.equal(retained.length, 3);
  assert.deepEqual(
    retained.find((x) => x.fact_key === original.fact_key),
    original,
  );
  for (const row of retained.filter((x) => x.family === "content_edits")) {
    assert.equal(row.document.evidence, "current_state");
    assert.equal(row.document.state, "present");
    assert.equal(row.document.actorId, null);
    assert.equal(row.document.occurredAt, null);
  }
  assert.deepEqual(
    retained.find((x) => x.source_revision === fact(redacted, "synthetic-redacted").sourceRevision).document
      .contentEditMetadata,
    redacted,
  );
  await noDerivedEffects();
});

test("the collection boundary detaches native metadata before the first write-transaction await", async () => {
  const value = fact();
  const expected = structuredClone(value);
  await collection.start(scan("synthetic-detached"));
  let entered = false;
  const store = new CollectionStore({
    query: db.query,
    transaction: async (work) => {
      entered = true;
      value.contentEditMetadata.parent.id = "SYNTHETIC_CHANGED";
      value.contentEditMetadata.history.records[0].editor.id = "SYNTHETIC_FORGED_ACTOR";
      value.contentEditMetadata.history.records.push({ body: "SYNTHETIC TEXT" });
      return db.transaction(work);
    },
  });
  assert.equal(await store.step("synthetic-detached", { readPage: async () => page([value]) }), "complete");
  assert.equal(entered, true);
  assert.deepEqual((await rows("source_facts"))[0].document, expected);
  await noDerivedEffects();
});

test("A to B to A metadata observations retain three immutable revisions and their original native clocks", async () => {
  const a = metadata();
  const b = structuredClone(a);
  b.history.records[0].editor = { kind: "Bot", id: "BOT_SYNTHETIC_LATER", databaseId: null };
  const values = [fact(a, "synthetic-A-1"), fact(b, "synthetic-B"), fact(a, "synthetic-A-2")];
  assert.notEqual(values[0].sourceRevision, values[2].sourceRevision);
  assert.equal(values[0].sourceRevision.split(".")[0], values[2].sourceRevision.split(".")[0]);
  assert.notEqual(values[0].sourceRevision.split(".")[0], values[1].sourceRevision.split(".")[0]);
  for (let i = 0; i < values.length; i++) assert.equal(await commit("synthetic-history-" + i, [values[i]]), "complete");
  const retained = await rows("source_facts");
  assert.equal(retained.length, 3);
  for (const value of values)
    assert.deepEqual(retained.find((x) => x.source_revision === value.sourceRevision).document, value);
  await assert.rejects(
    db.query("UPDATE leaderboard_ingestion.source_facts SET document = '{}'"),
    /immutable_source_fact/,
  );
  assert.deepEqual(await rows("source_facts"), retained);
  await noDerivedEffects();
});

test("malformed metadata cannot commit any item of a page or advance its previously retained cursor", async () => {
  const seed = fact(metadata("issue", 10), "synthetic-checkpoint");
  await collection.start(scan("synthetic-checkpoint"));
  assert.equal(
    await collection.step("synthetic-checkpoint", { readPage: async () => page([seed], { nextCursor: "next" }) }),
    "progress",
  );
  const originalFacts = await rows("source_facts");
  const originalItems = await rows("collection_items");
  const originalPages = await rows("collection_pages");
  const mutations = [
    ["parent subject", (x) => (x.subjectId = "SYNTHETIC_FOREIGN_PARENT")],
    [
      "native parent exceeds the retained collection ID limit",
      (x) => {
        x.subjectId = "I".repeat(129);
        x.contentEditMetadata.parent.id = x.subjectId;
        x.sourceRevision = syntheticRevision(x.contentEditMetadata, "synthetic-long-parent");
      },
    ],
    ["parent URL", (x) => (x.sourceUrl = "https://github.com/Synthetic/Other/issues/11")],
    ["wrong native parent kind", (x) => (x.contentEditMetadata.parent.kind = "issue")],
    ["snapshot actor", (x) => (x.actorId = "SYNTHETIC_INVENTED_ACTOR")],
    ["snapshot event time", (x) => (x.occurredAt = "2026-01-03T00:00:00.000Z")],
    ["transition evidence", (x) => (x.evidence = "observed_transition")],
    ["unavailable fact suppression", (x) => (x.state = "unavailable")],
    ["deleted fact suppression", (x) => (x.state = "deleted")],
    ["history alias", (x) => (x.historySubjectId = x.subjectId)],
    ["field alias", (x) => (x.issueFieldId = "SYNTHETIC_FIELD")],
    ["Project alias", (x) => (x.projectSubjectId = x.subjectId)],
    ["raw fact body", (x) => (x.body = "SYNTHETIC TEXT")],
    ["raw fact diff", (x) => (x.diff = "SYNTHETIC DIFF")],
    ["raw metadata body", (x) => (x.contentEditMetadata.body = "SYNTHETIC TEXT")],
    ["raw edit diff", (x) => (x.contentEditMetadata.history.records[0].diff = "SYNTHETIC DIFF")],
    ["missing typed metadata", (x) => delete x.contentEditMetadata],
    [
      "inherited reserved marker cannot suppress a parent",
      (x) => {
        const revision = x.sourceRevision;
        delete x.contentEditMetadata;
        delete x.sourceRevision;
        Object.setPrototypeOf(x, { sourceRevision: revision });
        x.state = "deleted";
      },
    ],
    [
      "accessor reserved marker cannot suppress a parent",
      (x) => {
        const revision = x.sourceRevision;
        delete x.contentEditMetadata;
        Object.defineProperty(x, "sourceRevision", {
          enumerable: true,
          get() {
            return revision;
          },
        });
        x.state = "unavailable";
      },
    ],
    ["explicit undefined metadata", (x) => (x.contentEditMetadata = undefined)],
    ["null typed metadata", (x) => (x.contentEditMetadata = null)],
    ["unsupported metadata version", (x) => (x.contentEditMetadata.version = "github-content-edit-metadata/v2")],
    ["unsupported revision namespace", (x) => (x.sourceRevision = x.sourceRevision.replace("-v1:", "-v2:"))],
    ["legacy revision with new metadata", (x) => (x.sourceRevision = "legacy-revision")],
    ["corrupt semantic hash", (x) => (x.sourceRevision = x.sourceRevision.replace(/:[a-f0-9]/, ":Z"))],
    ["malformed observation hash", (x) => (x.sourceRevision = x.sourceRevision.slice(0, -1))],
    ["stale revision against metadata", (x) => (x.contentEditMetadata.includesCreatedEdit = false)],
    ["confused unavailable history", (x) => (x.contentEditMetadata.history.availability = "unavailable")],
    ["confused redaction availability", (x) => (x.contentEditMetadata.history.availability = "deleted")],
    ["missing history records", (x) => delete x.contentEditMetadata.history.records],
    ["count mismatch", (x) => (x.contentEditMetadata.history.retainedTotalCount = 0)],
    ["sparse record", (x) => delete x.contentEditMetadata.history.records[0]],
    ["unsafe record identity", (x) => (x.contentEditMetadata.history.records[0].id = "unsafe id")],
    [
      "invalid retained timestamp",
      (x) => (x.contentEditMetadata.history.records[0].updatedAt = "2026-02-30T00:00:00.000Z"),
    ],
    [
      "over-budget history",
      (x) => {
        x.contentEditMetadata.history.records = Array.from({ length: 101 }, (_, i) => ({
          ...x.contentEditMetadata.history.records[0],
          id: "UCE_" + i,
        }));
        x.contentEditMetadata.history.retainedTotalCount = 101;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const invalid = fact(metadata("pull_request", 12), "synthetic-invalid");
    mutate(invalid);
    const valid = fact(metadata("issue", 13), "synthetic-valid-second-page");
    assert.equal(
      await collection.step("synthetic-checkpoint", { readPage: async () => page([valid, invalid]) }, 2),
      "failed",
      name,
    );
    assert.deepEqual(await rows("source_facts"), originalFacts, name + ": no partial fact write");
    assert.deepEqual(await rows("collection_items"), originalItems, name + ": no partial membership write");
    assert.deepEqual(await rows("collection_pages"), originalPages, name + ": no page advance");
    const current = (await rows("collection_runs"))[0];
    assert.equal(current.cursor, "next", name);
    assert.equal(current.item_count, 1, name);
    assert.equal(current.page_count, 1, name);
    assert.equal(current.reason, "source_schema_drift", name);
    await noDerivedEffects();
  }
  assert.equal(
    await collection.step("synthetic-checkpoint", {
      readPage: async () => page([fact(metadata("pull_request", 12), "synthetic-recovered")]),
    }),
    "complete",
  );
  assert.equal((await rows("source_facts")).length, 2);
  assert.equal((await rows("collection_runs"))[0].reason, null);
});

test("typed parent metadata rejects foreign source families and finite parent-count coverage", async () => {
  for (const family of ["issues", "pull_requests", "project_history", "project_current", "issue_field_history"]) {
    const runId = "synthetic-foreign-" + family;
    await collection.start(scan(runId, { family }));
    assert.equal(await collection.step(runId, { readPage: async () => page([fact()]) }), "failed", family);
  }
  assert.equal(await commit("synthetic-finite-count", [fact()], { expectedCount: 1 }), "failed");
  assert.deepEqual(await rows("source_facts"), []);
  assert.deepEqual(await rows("collection_pages"), []);
  await noDerivedEffects();
  assert.equal(await commit("synthetic-unknown-count", [fact()]), "complete");
  const row = (await collection.diagnostics(repository.id)).find((x) => x.state === "complete");
  assert.equal(row.item_count, 1);
  assert.equal(row.expected_count, null);
  assert.equal(row.counts_reconciled, false);
});

test("legacy content edits and the accepted typed history and Project contracts retain their documents", async () => {
  const legacy = {
    subjectId: "SYNTHETIC_LEGACY",
    sourceRevision: "synthetic-legacy-revision",
    sourceUrl: "https://github.com/Synthetic/ContentEdits/issues/41",
    evidence: "observed_transition",
    actorId: "SYNTHETIC_KNOWN_ACTOR",
    occurredAt: "2026-01-02T00:00:00.000Z",
    state: "present",
  };
  await collection.start(scan("synthetic-legacy"));
  assert.equal(
    await collection.step("synthetic-legacy", {
      readPage: async () => page([{ ...legacy, body: "SYNTHETIC DISCARDED EXTRA" }], { expectedCount: 1 }),
    }),
    "complete",
  );
  let legacyRevisionReads = 0;
  const accessorExpected = { ...legacy, subjectId: "SYNTHETIC_LEGACY_ACCESSOR" };
  const legacyAccessor = { ...accessorExpected };
  Object.defineProperty(legacyAccessor, "sourceRevision", {
    enumerable: true,
    get() {
      legacyRevisionReads++;
      return accessorExpected.sourceRevision;
    },
  });
  assert.equal(await commit("synthetic-legacy-accessor", [legacyAccessor], { expectedCount: 1 }), "complete");
  assert.equal(legacyRevisionReads, 2, "ordinary legacy revision is validated and then captured exactly once");
  const inheritedExpected = { ...legacy, subjectId: "SYNTHETIC_LEGACY_INHERITED" };
  const legacyInherited = { ...inheritedExpected };
  delete legacyInherited.sourceRevision;
  Object.setPrototypeOf(legacyInherited, { sourceRevision: inheritedExpected.sourceRevision });
  assert.equal(await commit("synthetic-legacy-inherited", [legacyInherited], { expectedCount: 1 }), "complete");
  const field = {
    ...legacy,
    subjectId: "SYNTHETIC_FIELD_EVENT",
    historySubjectId: "SYNTHETIC_ISSUE_41",
    issueFieldId: "SYNTHETIC_FIELD_1",
  };
  const project = {
    ...legacy,
    subjectId: "SYNTHETIC_ISSUE_41",
    projectSubjectId: "SYNTHETIC_ISSUE_41",
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
  };
  for (const [family, value] of [
    ["issue_field_history", field],
    ["project_current", project],
  ]) {
    await collection.start(scan("synthetic-" + family, { family }));
    assert.equal(
      await collection.step("synthetic-" + family, { readPage: async () => page([value], { expectedCount: 1 }) }),
      "complete",
    );
  }
  const retained = await rows("source_facts");
  assert.equal(retained.length, 5);
  for (const value of [legacy, accessorExpected, inheritedExpected, field, project]) {
    assert.deepEqual(retained.find((x) => x.subject_id === value.subjectId).document, value);
    assert.equal(Object.hasOwn(value, "contentEditMetadata"), false);
  }
  assert.equal(
    (await collection.diagnostics(repository.id)).every((x) => x.counts_reconciled === true),
    true,
  );
  await noDerivedEffects();
});

test("a source generation change during metadata access fences metadata before any page write", async () => {
  await collection.start(scan("synthetic-generation"));
  assert.equal(
    await collection.step("synthetic-generation", {
      readPage: async () => {
        assert.equal(await collection.verifyPublic(repository.id, 1, "1"), true);
        return page([fact()]);
      },
    }),
    "failed",
  );
  assert.deepEqual(await rows("source_facts"), []);
  assert.deepEqual(await rows("collection_pages"), []);
  const run = (await rows("collection_runs"))[0];
  assert.equal(run.reason, "source_commit_failed");
  assert.equal(String(run.access_generation), "1");
  assert.equal(String((await rows("repository_access"))[0].generation), "2");
  await noDerivedEffects();
});

test("late host authorization rolls back metadata and keeps repository locking before the run row", async () => {
  const queries = [];
  const store = new CollectionStore({
    query: db.query,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: async (sql, parameters) => {
            queries.push(sql);
            return tx.query(sql, parameters);
          },
        }),
      ),
  });
  await store.start(scan("synthetic-late-authorization"));
  queries.length = 0;
  let authorizedReads = 0;
  assert.equal(
    await store.step("synthetic-late-authorization", {
      readPage: async () => page([fact()]),
      assertAuthorized: () => {
        authorizedReads++;
        if (authorizedReads === 2) throw new Error("SYNTHETIC PRIVATE AUTHORIZATION DETAIL");
      },
    }),
    "failed",
  );
  assert.equal(authorizedReads, 2);
  const gate = queries.findIndex((sql) => sql.includes("SELECT state, generation") && sql.includes("FOR SHARE"));
  const runLock = queries.findIndex((sql) => sql.includes("collection_runs") && sql.includes("FOR UPDATE"));
  assert.ok(gate >= 0 && runLock > gate);
  assert.deepEqual(await rows("source_facts"), []);
  assert.deepEqual(await rows("collection_items"), []);
  assert.deepEqual(await rows("collection_pages"), []);
  const run = (await rows("collection_runs"))[0];
  assert.equal(run.page_count, 0);
  assert.equal(run.item_count, 0);
  assert.equal(run.cursor, null);
  assert.equal(run.reason, "source_commit_failed");
  assert.equal(JSON.stringify(run).includes("PRIVATE AUTHORIZATION"), false);
  await noDerivedEffects();
});
