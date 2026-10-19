import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseContentEditMetadata,
  collectionContentEditMetadata,
} from "../../../packages/ingestion/dist/content-edit-metadata.js";
import {
  parseGithubContentEditMetadata,
  githubContentEditRevision,
} from "../../../packages/github/dist/content-edit-history.js";
import { edit, parent } from "../../../tests/fixtures/content-edit-metadata.mjs";

function metadata({ kind = "issue", number = 11, records = [edit()] } = {}) {
  const native = parent(kind, number);
  const actor = (value) =>
    value === null
      ? null
      : value.__typename === "User" || value.__typename === "Bot"
        ? { kind: value.__typename, id: value.id, databaseId: value.databaseId }
        : { kind: "unknown", typename: value.__typename };
  return {
    version: "github-content-edit-metadata/v1",
    parent: { kind, id: native.id, number: native.number, url: native.url },
    includesCreatedEdit: true,
    history:
      records === null
        ? { availability: "unavailable", retainedTotalCount: null, records: null }
        : {
            availability: "available",
            retainedTotalCount: records.length,
            records: records.map((value) => ({
              id: value.id,
              createdAt: value.createdAt,
              editedAt: value.editedAt,
              updatedAt: value.updatedAt,
              editor: actor(value.editor),
              deletedAt: value.deletedAt,
              deletedBy: actor(value.deletedBy),
            })),
          },
  };
}

function fact(value, scan = "synthetic-scan") {
  return {
    subjectId: value.parent.id,
    sourceRevision: githubContentEditRevision(value, scan),
    sourceUrl: value.parent.url,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "present",
    contentEditMetadata: value,
  };
}

test("private ingestion canonical bytes match the frozen reader for native synthetic metadata", () => {
  const specimens = [
    metadata(),
    metadata({ kind: "pull_request", records: [] }),
    metadata({ records: null }),
    metadata({
      records: [
        edit("UCE_Z", { editor: null, deletedAt: "2026-01-03T00:00:00Z", deletedBy: null }),
        edit("UCE_A", {
          editor: { __typename: "Organization" },
          deletedAt: null,
          deletedBy: { __typename: "Bot", id: "BOT_SYNTHETIC", databaseId: null },
        }),
      ],
    }),
    metadata({
      records: Array.from({ length: 100 }, (_, i) =>
        edit("UCE_" + String(99 - i).padStart(3, "0"), {
          editor: { __typename: "User", id: "U_SYNTHETIC", databaseId: Number.MAX_SAFE_INTEGER },
        }),
      ),
    }),
  ];
  specimens[1].includesCreatedEdit = false;
  for (const value of specimens) {
    const expected = parseGithubContentEditMetadata(value);
    const actual = parseContentEditMetadata(value);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    const revision = githubContentEditRevision(value, "synthetic-parity");
    const expectedHash = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
    assert.equal(revision.split(":")[1].split(".")[0], expectedHash);
    assert.deepEqual(collectionContentEditMetadata(fact(value, "synthetic-parity"), "content_edits"), expected);
    assert.notEqual(actual, value);
    assert.notEqual(actual.parent, value.parent);
    assert.notEqual(actual.history, value.history);
    if (actual.history.records?.length) {
      assert.notEqual(actual.history.records, value.history.records);
      assert.notEqual(actual.history.records[0], value.history.records[0]);
    }
  }
});

test("both metadata boundaries reject raw content, malformed native identity and confused nullable history", () => {
  const mutations = [
    ["top-level body", (x) => (x.body = "SYNTHETIC TEXT")],
    ["nested parent body", (x) => (x.parent.body = "SYNTHETIC TEXT")],
    ["edit diff", (x) => (x.history.records[0].diff = "SYNTHETIC DIFF")],
    ["editor login", (x) => (x.history.records[0].editor.login = "synthetic-name")],
    ["history extra", (x) => (x.history.pageInfo = {})],
    ["missing edit field", (x) => delete x.history.records[0].deletedBy],
    ["unknown metadata version", (x) => (x.version = "github-content-edit-metadata/v2")],
    ["non-boolean creation marker", (x) => (x.includesCreatedEdit = "true")],
    ["wrong route kind", (x) => (x.parent.kind = "pull_request")],
    ["wrong parent number", (x) => (x.parent.number = 12)],
    ["noncanonical parent URL", (x) => (x.parent.url += "?body=synthetic")],
    ["unsafe native identity", (x) => (x.parent.id = "native identity with spaces")],
    ["overlong native identity", (x) => (x.history.records[0].id = "X".repeat(257))],
    [
      "duplicate native edit",
      (x) => {
        x.history.records.push(structuredClone(x.history.records[0]));
        x.history.retainedTotalCount++;
      },
    ],
    ["available null records", (x) => (x.history.records = null)],
    ["unavailable retained rows", (x) => (x.history.availability = "unavailable")],
    ["available null count", (x) => (x.history.retainedTotalCount = null)],
    ["unknown availability", (x) => (x.history.availability = "deleted")],
    ["count mismatch", (x) => (x.history.retainedTotalCount = 0)],
    ["retention overflow", (x) => (x.history.retainedTotalCount = 101)],
    ["sparse records", (x) => delete x.history.records[0]],
    ["invalid calendar day", (x) => (x.history.records[0].createdAt = "2026-02-30T00:00:00Z")],
    ["unsupported timestamp precision", (x) => (x.history.records[0].editedAt = "2026-01-02T03:04:06.1234Z")],
    ["unknown actor impersonates User", (x) => (x.history.records[0].editor = { kind: "unknown", typename: "User" })],
    [
      "unknown actor invented ID",
      (x) => (x.history.records[0].editor = { kind: "unknown", typename: "Organization", id: "X" }),
    ],
    ["zero database identity", (x) => (x.history.records[0].editor.databaseId = 0)],
  ];
  for (const [name, mutate] of mutations) {
    const value = metadata();
    mutate(value);
    assert.throws(() => parseGithubContentEditMetadata(value), undefined, name + ": reader");
    assert.throws(() => parseContentEditMetadata(value), /invalid_content_edit_metadata/, name + ": ingestion");
  }
});

test("private collection accepts data fields only and never evaluates metadata accessors", () => {
  let reads = 0;
  const getter = metadata();
  Object.defineProperty(getter.history.records[0], "editor", {
    enumerable: true,
    get() {
      reads++;
      return null;
    },
  });
  assert.throws(() => parseContentEditMetadata(getter), /invalid_content_edit_metadata/);
  const inherited = metadata();
  Object.setPrototypeOf(inherited.parent, { body: "SYNTHETIC INHERITED TEXT" });
  assert.throws(() => parseContentEditMetadata(inherited), /invalid_content_edit_metadata/);
  const symbol = metadata();
  symbol.history.records[Symbol("synthetic-body")] = "SYNTHETIC TEXT";
  assert.throws(() => parseContentEditMetadata(symbol), /invalid_content_edit_metadata/);
  const hidden = metadata();
  Object.defineProperty(hidden, "body", { value: "SYNTHETIC TEXT", enumerable: false });
  assert.throws(() => parseContentEditMetadata(hidden), /invalid_content_edit_metadata/);
  const aliased = metadata();
  const original = fact(aliased);
  Object.defineProperty(original, "contentEditMetadata", {
    enumerable: true,
    get() {
      reads++;
      return aliased;
    },
  });
  assert.throws(() => collectionContentEditMetadata(original, "content_edits"), /invalid_content_edit_metadata/);
  assert.equal(reads, 0);
});
