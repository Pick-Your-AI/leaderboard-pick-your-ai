import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CollectionStore } from "../dist/index.js";
import * as metadataBoundary from "../dist/content-edit-metadata.js";
import {
  commentEntry,
  commentKinds,
  commentTarget,
  repository,
} from "../../../tests/fixtures/comment-edit-metadata.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = "gh-content-edit-comment-v1:";
const migrations = await Promise.all(
  ["001_ingestion", "002_snapshots", "003_collection"].map((name) =>
    readFile(new URL("../sql/" + name + ".up.sql", import.meta.url), "utf8"),
  ),
);
const database = (engine) => ({
  query: (sql, parameters) => engine.query(sql, parameters),
  transaction: (work) => engine.transaction((tx) => work({ query: (sql, parameters) => tx.query(sql, parameters) })),
});
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

function metadata(kind = "issue_comment", fragment = "101") {
  const entry = commentEntry(commentTarget(kind, fragment));
  const actor = (value) =>
    value === null ? null : { kind: value.__typename, id: value.id, databaseId: value.databaseId };
  return {
    version: "github-comment-edit-metadata/v1",
    repository: { ...repository },
    target: structuredClone(entry.target),
    publication: {
      publishedAt: new Date(entry.native.publishedAt).toISOString(),
      reviewState: entry.native.state ?? null,
      submittedAt: entry.native.submittedAt === undefined ? null : new Date(entry.native.submittedAt).toISOString(),
    },
    includesCreatedEdit: entry.native.includesCreatedEdit,
    history: {
      availability: "available",
      retainedTotalCount: entry.records.length,
      records: entry.records.map((value) => ({
        id: value.id,
        createdAt: new Date(value.createdAt).toISOString(),
        editedAt: new Date(value.editedAt).toISOString(),
        updatedAt: new Date(value.updatedAt).toISOString(),
        editor: actor(value.editor),
        deletedAt: value.deletedAt,
        deletedBy: actor(value.deletedBy),
      })),
    },
  };
}
const revision = (value, scanId = "synthetic-comment-edit-scan") =>
  `${prefix}${hash(value)}.${hash([prefix, scanId]).slice(0, 32)}`;
const fact = (value = metadata(), scanId) => ({
  subjectId: value.target.id,
  sourceRevision: revision(value, scanId),
  sourceUrl: value.target.url,
  evidence: "current_state",
  actorId: null,
  occurredAt: null,
  state: "present",
  contentEditMetadata: value,
});
const scan = (runId, overrides = {}) => ({
  runId,
  repositoryId: repository.id,
  family: "content_edits",
  mode: "audit",
  since: null,
  until: "2026-01-04T00:00:00.000Z",
  ...overrides,
});
const page = (facts, overrides = {}) => ({
  repositoryId: repository.id,
  visibility: "public",
  facts,
  nextCursor: null,
  expectedCount: null,
  ...overrides,
});
const rows = async (table, source = db) =>
  (await source.query("SELECT * FROM leaderboard_ingestion." + table + " ORDER BY 1")).rows;
async function commit(runId, facts, overrides = {}, store = collection) {
  await store.start(scan(runId));
  return store.step(runId, { readPage: async () => page(facts, overrides) });
}
async function neutral(source = db) {
  for (const table of ["object_suppressions", "observations", "outbox", "enrichment_jobs"])
    assert.deepEqual(await rows(table, source), [], table + " must stay empty");
}

test("all four published comment target kinds persist as neutral target-bound observations", async () => {
  const input = commentKinds.map((kind) => fact(metadata(kind)));
  assert.equal(await commit("synthetic-four-comment-targets", input), "complete");
  const stored = await rows("source_facts");
  assert.equal(stored.length, 4);
  for (const original of input) {
    const retained = stored.find((row) => row.subject_id === original.subjectId);
    assert.deepEqual(retained.document, original);
    assert.equal(Number(retained.repository_id), repository.id);
    assert.equal(retained.family, "content_edits");
    assert.equal(retained.source_revision, original.sourceRevision);
    assert.notEqual(retained.subject_id, original.contentEditMetadata.target.parent.id);
    assert.match(retained.document.sourceUrl, /#(?:issuecomment-|pullrequestreview-|discussion_r)/);
  }
  const saved = (await rows("collection_runs"))[0];
  assert.equal(saved.item_count, 4);
  assert.equal(saved.expected_count, null);
  assert.equal((await collection.diagnostics(repository.id))[0].counts_reconciled, false);
  await neutral();
});

test("empty, unavailable and independently redacted histories remain distinct present comments", async () => {
  const empty = metadata("issue_comment", "102");
  empty.history = { availability: "available", retainedTotalCount: 0, records: [] };
  const unavailable = metadata("pull_request_conversation_comment", "103");
  unavailable.history = { availability: "unavailable", retainedTotalCount: null, records: null };
  const redacted = metadata("pull_request_review_comment", "104");
  redacted.history.records[0].editor = null;
  redacted.history.records[0].deletedAt = "2026-01-03T00:00:00.000Z";
  redacted.history.records[0].deletedBy = null;
  const values = [empty, unavailable, redacted].map((value) => fact(value));
  assert.equal(await commit("synthetic-distinct-comment-histories", values), "complete");
  const stored = await rows("source_facts");
  for (const original of values)
    assert.deepEqual(stored.find((row) => row.subject_id === original.subjectId).document, original);
  await neutral();
});

test("comment DTO canonicalizes native dates and IDs without coercing opaque URL fragments", () => {
  const original = metadata("pull_request_review", "99999999999999999999");
  original.publication.publishedAt = "2026-01-02T03:04:05Z";
  original.publication.submittedAt = "2026-01-02T03:04:05.1Z";
  original.history.records[0].id = "UCE_Z";
  const added = structuredClone(original.history.records[0]);
  added.id = "UCE_A";
  added.editor = { kind: "unknown", typename: "Organization" };
  added.deletedBy = { kind: "Bot", id: "BOT_SYNTHETIC", databaseId: null };
  original.history.records.push(added);
  original.history.retainedTotalCount = 2;
  const actual = metadataBoundary.parseCommentEditMetadata(original);
  const expected = structuredClone(original);
  expected.publication.publishedAt = "2026-01-02T03:04:05.000Z";
  expected.publication.submittedAt = "2026-01-02T03:04:05.100Z";
  expected.history.records.reverse();
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(actual.target.url, original.target.url);
  assert.notEqual(actual.target, original.target);
  assert.notEqual(actual.target.parent, original.target.parent);
  assert.notEqual(actual.repository, original.repository);
  assert.notEqual(actual.publication, original.publication);
  assert.notEqual(actual.history.records[0], original.history.records[1]);
  original.target.parent.id = "I_MUTATED";
  original.history.records[1].editor.typename = "Mutated";
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test("only the four submitted review states and the independent inline SUBMITTED state are admitted", () => {
  for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]) {
    const value = metadata("pull_request_review");
    value.publication.reviewState = state;
    assert.equal(metadataBoundary.parseCommentEditMetadata(value).publication.reviewState, state);
  }
  const inline = metadata("pull_request_review_comment");
  inline.target.url = inline.target.url.replace("#discussion_r", "#r");
  assert.deepEqual(metadataBoundary.parseCommentEditMetadata(inline), inline);
  for (const [kind, state, submittedAt] of [
    ["pull_request_review", "PENDING", null],
    ["pull_request_review", "SUBMITTED", "2026-01-02T03:04:05.000Z"],
    ["pull_request_review", "COMMENTED", null],
    ["pull_request_review_comment", "PENDING", null],
    ["pull_request_review_comment", "COMMENTED", null],
    ["pull_request_review_comment", "SUBMITTED", "2026-01-02T03:04:05.000Z"],
    ["issue_comment", "COMMENTED", null],
    ["pull_request_conversation_comment", null, "2026-01-02T03:04:05.000Z"],
  ]) {
    const value = metadata(kind);
    Object.assign(value.publication, { reviewState: state, submittedAt });
    assert.throws(() => metadataBoundary.parseCommentEditMetadata(value), /invalid_content_edit_metadata/);
  }
});

test("closed comment metadata rejects malformed identities, raw payloads and inconsistent publication/history", async (t) => {
  const vectors = [
    ["unknown format", (x) => (x.version = "github-comment-edit-metadata/v2")],
    ["raw body", (x) => (x.body = "SYNTHETIC PRIVATE TEXT")],
    ["repository login", (x) => (x.repository.login = "SYNTHETIC")],
    ["zero repository", (x) => (x.repository.id = 0)],
    ["unsafe repository", (x) => (x.repository.id = Number.MAX_SAFE_INTEGER + 1)],
    ["fraction repository", (x) => (x.repository.id = 2.5)],
    ["repository dot segment", (x) => (x.repository.slug = "Synthetic/..")],
    ["repository final LF", (x) => (x.repository.slug += "\n")],
    ["repository final CR", (x) => (x.repository.slug += "\r")],
    ["foreign repository URL", (x) => (x.repository.slug = "Synthetic/Foreign")],
    ["target body", (x) => (x.target.body = "SYNTHETIC")],
    ["unknown target", (x) => (x.target.kind = "discussion_comment")],
    ["wrong target parent kind", (x) => (x.target.kind = "pull_request_conversation_comment")],
    ["target identity whitespace", (x) => (x.target.id += " ")],
    ["target identity oversized", (x) => (x.target.id = "I".repeat(257))],
    ["parent identity whitespace", (x) => (x.target.parent.id += " ")],
    ["parent URL number", (x) => (x.target.parent.number += 1)],
    ["parent title", (x) => (x.target.parent.title = "SYNTHETIC")],
    ["foreign target URL", (x) => (x.target.url = x.target.url.replace("/issues/11", "/issues/12"))],
    ["wrong target fragment", (x) => (x.target.url = x.target.url.replace("#issuecomment-", "#discussion_r"))],
    ["zero fragment", (x) => (x.target.url = x.target.parent.url + "#issuecomment-0")],
    ["leading zero fragment", (x) => (x.target.url = x.target.parent.url + "#issuecomment-01")],
    ["oversized fragment", (x) => (x.target.url = x.target.parent.url + "#issuecomment-" + "1".repeat(21))],
    ["target query", (x) => (x.target.url += "?body=synthetic")],
    ["target trailing LF", (x) => (x.target.url += "\n")],
    ["unpublished", (x) => (x.publication.publishedAt = null)],
    ["publication future shape", (x) => (x.publication.state = "PUBLISHED")],
    ["invalid publication day", (x) => (x.publication.publishedAt = "2026-02-30T00:00:00Z")],
    ["fine publication precision", (x) => (x.publication.publishedAt = "2026-01-02T03:04:05.1234Z")],
    ["nonboolean created flag", (x) => (x.includesCreatedEdit = "true")],
    ["history extra", (x) => (x.history.pageInfo = {})],
    ["native diff", (x) => (x.history.records[0].diff = "SYNTHETIC DIFF")],
    ["editor author alias", (x) => (x.history.records[0].editor.login = "SYNTHETIC")],
    ["unknown editor impersonates", (x) => (x.history.records[0].editor = { kind: "unknown", typename: "User" })],
    ["nonfinite editor identity", (x) => (x.history.records[0].editor.databaseId = Infinity)],
    ["missing deleter", (x) => delete x.history.records[0].deletedBy],
    ["wrong retained total", (x) => (x.history.retainedTotalCount = 0)],
    ["null available rows", (x) => (x.history.records = null)],
    ["unavailable existing rows", (x) => (x.history.availability = "unavailable")],
    ["sparse rows", (x) => delete x.history.records[0]],
    [
      "duplicate row",
      (x) => {
        x.history.records.push(structuredClone(x.history.records[0]));
        x.history.retainedTotalCount++;
      },
    ],
    [
      "unbounded rows",
      (x) => {
        x.history.records = Array.from({ length: 101 }, (_, i) => ({ ...x.history.records[0], id: `UCE_${i}` }));
        x.history.retainedTotalCount = 101;
      },
    ],
  ];
  for (const [name, change] of vectors)
    await t.test(name, () => {
      const value = metadata();
      change(value);
      assert.throws(() => metadataBoundary.parseCommentEditMetadata(value), /invalid_content_edit_metadata/);
    });
});

test("metadata and outer fact accessors, hidden keys, symbols and inherited shapes are rejected without evaluation", () => {
  let reads = 0;
  const getter = () => {
    reads++;
    throw new Error("must not evaluate synthetic getter");
  };
  for (const select of [
    (x) => [x, "repository"],
    (x) => [x.repository, "slug"],
    (x) => [x.target, "parent"],
    (x) => [x.target.parent, "url"],
    (x) => [x.publication, "publishedAt"],
    (x) => [x.history.records[0], "editor"],
    (x) => [x.history.records, "0"],
  ]) {
    const value = metadata();
    const [object, key] = select(value);
    Object.defineProperty(object, key, { enumerable: true, get: getter });
    assert.throws(() => metadataBoundary.parseCommentEditMetadata(value), /invalid_content_edit_metadata/);
  }
  for (const mutate of [
    (x) => Object.defineProperty(x, "body", { value: "SYNTHETIC", enumerable: false }),
    (x) => (x.target[Symbol("synthetic")] = "SYNTHETIC"),
    (x) => Object.setPrototypeOf(x.target.parent, { body: "SYNTHETIC" }),
  ]) {
    const value = metadata();
    mutate(value);
    assert.throws(() => metadataBoundary.parseCommentEditMetadata(value), /invalid_content_edit_metadata/);
  }
  for (const key of ["contentEditMetadata", "sourceRevision"]) {
    const value = fact();
    Object.defineProperty(value, key, { enumerable: true, get: getter });
    assert.throws(
      () => metadataBoundary.collectionContentEditMetadata(value, "content_edits", repository.id),
      /invalid_content_edit_metadata/,
    );
  }
  assert.equal(reads, 0);
});

test("collection requires saved repository authority and exact neutral target/revision bindings", async (t) => {
  const vectors = [
    [
      "foreign repository ID",
      (x) => {
        x.contentEditMetadata.repository.id++;
        x.sourceRevision = revision(x.contentEditMetadata);
      },
    ],
    ["parent instead of comment subject", (x) => (x.subjectId = x.contentEditMetadata.target.parent.id)],
    ["parent instead of comment URL", (x) => (x.sourceUrl = x.contentEditMetadata.target.parent.url)],
    ["foreign comment ID", (x) => (x.subjectId = "COMMENT_FOREIGN")],
    ["observed transition", (x) => (x.evidence = "observed_transition")],
    ["author attribution", (x) => (x.actorId = "101")],
    ["publication used as event", (x) => (x.occurredAt = x.contentEditMetadata.publication.publishedAt)],
    ["suppression from edit deletion", (x) => (x.state = "deleted")],
    ["history alias", (x) => (x.historySubjectId = x.contentEditMetadata.target.parent.id)],
    ["raw outer field", (x) => (x.body = "SYNTHETIC")],
    ["missing DTO", (x) => delete x.contentEditMetadata],
    ["parent revision namespace", (x) => (x.sourceRevision = x.sourceRevision.replace("-comment-v1:", "-v1:"))],
    ["legacy revision", (x) => (x.sourceRevision = "synthetic-legacy-revision")],
    ["future revision", (x) => (x.sourceRevision = x.sourceRevision.replace("-v1:", "-v2:"))],
    ["changed semantic digest", (x) => (x.sourceRevision = prefix + "0".repeat(64) + "." + "1".repeat(32))],
    ["changed DTO after digest", (x) => (x.contentEditMetadata.publication.publishedAt = "2026-01-03T00:00:00.000Z")],
    ["truncated scan digest", (x) => (x.sourceRevision = x.sourceRevision.slice(0, -1))],
  ];
  for (const [name, mutate] of vectors)
    await t.test(name, async () => {
      const value = fact();
      mutate(value);
      const id = "synthetic-invalid-comment-" + hash(name).slice(0, 16);
      assert.equal(await commit(id, [value]), "failed");
      const run = (await rows("collection_runs")).find((row) => row.run_id === id);
      assert.equal(run.reason, "source_schema_drift");
      assert.equal(run.page_count, 0);
      assert.equal(run.item_count, 0);
      assert.deepEqual(await rows("source_facts"), []);
      await neutral();
    });
  for (const authority of [undefined, null, "2", 0, 2.5, Number.NaN, repository.id + 1])
    assert.throws(
      () => metadataBoundary.collectionContentEditMetadata(fact(), "content_edits", authority),
      /invalid_content_edit_metadata/,
    );
  assert.deepEqual(metadataBoundary.collectionContentEditMetadata(fact(), "content_edits", repository.id), metadata());
  assert.throws(
    () => metadataBoundary.collectionContentEditMetadata(fact(), "comments", repository.id),
    /invalid_content_edit_metadata/,
  );
});

test("a malformed later item rolls back the whole page and preserves the literal prior cursor", async () => {
  const id = "synthetic-comment-atomic-page";
  const first = fact(metadata("issue_comment", "201"), id);
  assert.equal(await commit(id, [first], { nextCursor: "next-comment-page" }), "progress");
  const originalFacts = await rows("source_facts");
  const originalPages = await rows("collection_pages");
  const before = (await rows("collection_runs"))[0];
  const second = fact(metadata("pull_request_review", "202"), id);
  const malformed = fact(metadata("issue_comment", "203"), id);
  malformed.contentEditMetadata.publication.publishedAt = null;
  assert.equal(
    await collection.step(id, {
      readPage: async (request) => {
        assert.equal(request.cursor, "next-comment-page");
        return page([second, malformed]);
      },
    }),
    "failed",
  );
  assert.deepEqual(await rows("source_facts"), originalFacts);
  assert.deepEqual(await rows("collection_pages"), originalPages);
  const after = (await rows("collection_runs"))[0];
  for (const key of ["cursor", "page_count", "item_count", "expected_count", "access_generation"])
    assert.equal(after[key], before[key]);
  await neutral();
});

test("canonical metadata is detached before the first collection write transaction awaits", async () => {
  const id = "synthetic-comment-detached";
  await collection.start(scan(id));
  const value = fact(metadata("pull_request_review"), id);
  const original = structuredClone(value);
  let transactions = 0;
  const store = new CollectionStore({
    query: db.query,
    transaction: async (work) => {
      transactions++;
      value.contentEditMetadata.repository.id++;
      value.contentEditMetadata.target.id = "COMMENT_MUTATED";
      value.contentEditMetadata.target.parent.id = "PR_MUTATED";
      value.contentEditMetadata.history.records.length = 0;
      value.sourceRevision = "mutated";
      return db.transaction(work);
    },
  });
  assert.equal(await store.step(id, { readPage: async () => page([value]) }), "complete");
  assert.equal(transactions, 1);
  assert.deepEqual((await rows("source_facts"))[0].document, original);
  await neutral();
});

test("late authorization and generation changes cannot commit a comment page or its cursor", async (t) => {
  for (const mode of ["authorization", "generation"])
    await t.test(mode, async () => {
      const id = "synthetic-comment-fence-" + mode;
      await collection.start(scan(id));
      const status = await collection.step(id, {
        async readPage() {
          if (mode === "generation")
            await db.query(
              "UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=$1",
              [repository.id],
            );
          return page([fact(metadata(), id)], { nextCursor: "must-not-commit" });
        },
        assertAuthorized() {
          if (mode === "authorization") throw new Error("synthetic current authority lost");
        },
      });
      assert.equal(status, "failed");
      const saved = (await rows("collection_runs")).find((row) => row.run_id === id);
      assert.equal(saved.cursor, null);
      assert.equal(saved.page_count, 0);
      assert.equal(saved.item_count, 0);
      assert.deepEqual(await rows("source_facts"), []);
      assert.deepEqual(await rows("collection_pages"), []);
      await neutral();
    });
});

test("comment observations preserve A-to-B-to-A revisions without inventing new native clocks", async () => {
  const a = metadata("pull_request_review");
  const b = structuredClone(a);
  b.history.records[0].editor = null;
  const originalClock = a.history.records[0].updatedAt;
  const values = [a, b, a].map((value, index) => fact(structuredClone(value), "synthetic-cycle-" + index));
  for (const [index, value] of values.entries())
    assert.equal(await commit("synthetic-cycle-" + index, [value]), "complete");
  assert.equal(values[0].sourceRevision.split(".")[0], values[2].sourceRevision.split(".")[0]);
  assert.notEqual(values[0].sourceRevision, values[2].sourceRevision);
  assert.notEqual(values[0].sourceRevision.split(".")[0], values[1].sourceRevision.split(".")[0]);
  const stored = await rows("source_facts");
  assert.equal(stored.length, 3);
  for (const value of values) {
    const row = stored.find((item) => item.source_revision === value.sourceRevision);
    assert.deepEqual(row.document, value);
    assert.equal(row.document.contentEditMetadata.history.records[0].updatedAt, originalClock);
  }
  await neutral();
});

test("comment metadata cannot establish finite lifetime-history coverage or enter another family", async () => {
  assert.equal(await commit("synthetic-comment-count", [fact()], { expectedCount: 1 }), "failed");
  for (const family of ["comments", "reviews", "issue_field_history", "project_current"]) {
    const id = "synthetic-wrong-family-" + family;
    await collection.start(scan(id, { family }));
    assert.equal(await collection.step(id, { readPage: async () => page([fact()]) }), "failed");
  }
  assert.deepEqual(await rows("source_facts"), []);
  await neutral();
});

test("literal parent-v1 and legacy documents remain compatible beside comment metadata", async () => {
  const comment = metadata();
  const parent = {
    version: "github-content-edit-metadata/v1",
    parent: structuredClone(comment.target.parent),
    includesCreatedEdit: comment.includesCreatedEdit,
    history: structuredClone(comment.history),
  };
  const oldPrefix = "gh-content-edit-v1:";
  const oldFact = {
    subjectId: parent.parent.id,
    sourceRevision: `${oldPrefix}${hash(parent)}.${hash([oldPrefix, "synthetic-old"]).slice(0, 32)}`,
    sourceUrl: parent.parent.url,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "present",
    contentEditMetadata: parent,
  };
  const legacy = { ...oldFact, sourceRevision: "synthetic-opaque-legacy" };
  delete legacy.contentEditMetadata;
  assert.equal(JSON.stringify(metadataBoundary.parseContentEditMetadata(parent)), JSON.stringify(parent));
  assert.deepEqual(metadataBoundary.collectionContentEditMetadata(oldFact, "content_edits"), parent);
  assert.equal(metadataBoundary.collectionContentEditMetadata(legacy, "content_edits"), undefined);
  assert.throws(() => metadataBoundary.parseContentEditMetadata(comment), /invalid_content_edit_metadata/);
  assert.equal(await commit("synthetic-old-and-new", [oldFact, legacy, fact(comment)]), "complete");
  const stored = await rows("source_facts");
  for (const value of [oldFact, legacy, fact(comment)])
    assert.deepEqual(stored.find((row) => row.source_revision === value.sourceRevision).document, value);
  await neutral();
});

test("comment facts, cursor and neutral coverage survive physical database close and reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "comment-edit-collection-"));
  let disk;
  t.after(async () => {
    await disk?.close();
    await rm(directory, { recursive: true, force: true });
  });
  disk = new PGlite(join(directory, "database"));
  await initialize(disk);
  let diskDb = database(disk);
  let store = new CollectionStore(diskDb);
  await store.verifyPublic(repository.id, 1, null);
  const id = "synthetic-durable-comment";
  const first = fact(metadata("issue_comment", "301"), id);
  const second = fact(metadata("pull_request_review_comment", "302"), id);
  await store.start(scan(id));
  assert.equal(
    await store.step(id, { readPage: async () => page([first], { nextCursor: "saved-comment-cursor" }) }, 1),
    "progress",
  );
  const priorFacts = await rows("source_facts", diskDb);
  const priorPages = await rows("collection_pages", diskDb);
  const priorRun = (await rows("collection_runs", diskDb))[0];
  await disk.close();
  disk = new PGlite(join(directory, "database"));
  diskDb = database(disk);
  store = new CollectionStore(diskDb);
  assert.deepEqual(await rows("source_facts", diskDb), priorFacts);
  assert.deepEqual(await rows("collection_pages", diskDb), priorPages);
  assert.deepEqual((await rows("collection_runs", diskDb))[0], priorRun);
  assert.equal(
    await store.step(
      id,
      {
        readPage: async (request) => {
          assert.deepEqual(request, { ...scan(id), cursor: "saved-comment-cursor", limit: 1 });
          return page([second]);
        },
      },
      1,
    ),
    "complete",
  );
  const completed = (await rows("collection_runs", diskDb))[0];
  assert.equal(completed.item_count, 2);
  assert.equal(completed.expected_count, null);
  const retained = await rows("source_facts", diskDb);
  assert.deepEqual(retained.find((row) => row.subject_id === first.subjectId).document, first);
  assert.deepEqual(retained.find((row) => row.subject_id === second.subjectId).document, second);
  assert.equal(
    await store.step(id, {
      readPage() {
        throw new Error("completed saved run must not recollect");
      },
    }),
    "complete",
  );
  assert.deepEqual((await rows("collection_runs", diskDb))[0], completed);
  await neutral(diskDb);
});
