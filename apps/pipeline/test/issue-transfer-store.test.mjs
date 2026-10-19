import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { harness } from "./harness.mjs";
import {
  privateIssueTransferMetadata,
  migrateIssueTransferMetadata,
  loadRetainedIssueMetadata,
  retainIssueTransferIndex,
  issueTransferDigest,
  issueTransferCapture,
  assertIssueTransferCapture,
} from "../src/issue-transfer-store.mjs";
import { readIssueTransferAuthority } from "../src/issue-transfer-authority.mjs";

async function fixture(t) {
  const h = await harness(t, { memoryDatabase: true });
  assert.equal((await h.runtime.runOnce()).state, "published");
  // Model the prior published schema before first installation. The original
  // untyped source/normalization bytes stay exact; no runtime writer is active.
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.issue_transfer_index")).rows[0].n,
    0,
  );
  await h.engine.exec(
    "DROP TABLE leaderboard_pipeline.issue_transfer_endpoints; DROP TABLE leaderboard_pipeline.issue_transfer_unavailable; DROP TABLE leaderboard_pipeline.issue_transfer_index; DROP TABLE leaderboard_pipeline.issue_transfer_migrations;",
  );
  const row = (
    await h.db.query(
      "SELECT n.*,f.repository_id,f.subject_id,f.source_revision,f.document AS source_document,f.observed_at,f.first_run_id FROM leaderboard_pipeline.normalizations n JOIN leaderboard_ingestion.source_facts f USING(fact_key) ORDER BY n.fact_key LIMIT 1",
    )
  ).rows[0];
  const target = { id: 3, slug: "synthetic-org/synthetic-target" };
  const repositories = [...h.config.repositories, target];
  const observedAt = new Date(row.observed_at).toISOString(),
    occurredAt = new Date(new Date(row.observed_at).getTime() - 1000).toISOString();
  const eventId = "synthetic-indexed-event";
  const observationId = `gh:${createHash("sha256")
    .update(JSON.stringify(["event", eventId]))
    .digest("hex")}`;
  const transfer = {
    schemaVersion: "github-issue-transfer/v1",
    sourceArtifactId: row.subject_id,
    targetArtifactId: "SYNTHETIC_INDEXED_TARGET",
    sourceRepositoryId: "2",
    targetRepositoryId: "3",
    sourceUrl: row.source_document.sourceUrl,
    targetUrl: "https://github.com/synthetic-org/synthetic-target/issues/9",
    observationId,
    sourceRevision: row.source_revision,
    observedAt,
    occurredAt,
    eventId,
  };
  const output = {
    ...structuredClone(row.document),
    issueTransfers: [transfer],
    issueCreationScopes: [],
    observations: [
      {
        id: observationId,
        source: "github_webhook",
        action: "transferred",
        artifactId: row.subject_id,
        occurredAt,
        observedAt,
        sourceRevision: row.source_revision,
        sourceUrl: row.source_document.sourceUrl,
      },
    ],
  };
  const metadata = privateIssueTransferMetadata(
    output,
    { ...row, document: row.source_document },
    repositories[0],
    repositories,
  );
  const document = { ...structuredClone(row.document), ...metadata };
  const pin = issueTransferDigest(document);
  const persist = (doc = document, hash = pin) =>
    h.db.query(
      "UPDATE leaderboard_pipeline.normalizations SET document=$1::jsonb,document_hash=$2 WHERE fact_key=$3 AND policy_signature=$4",
      [JSON.stringify(doc), hash, row.fact_key, row.policy_signature],
    );
  const load = () =>
    h.db.transaction((tx) =>
      loadRetainedIssueMetadata(tx, { repositoryIds: [2, 3], repositories, dataMode: "synthetic" }),
    );
  return { h, row, output, document, pin, persist, load, repositories, transfer };
}

test("one-time migration backfills a legitimate typed legacy row without rewriting it", async (t) => {
  const f = await fixture(t);
  await f.persist();
  const before = (
    await f.h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature")
  ).rows;
  await migrateIssueTransferMetadata(f.h.db);
  const rows = await f.load();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].binding.documentHash, f.pin);
  assert.deepEqual(rows[0].metadata.issueTransfers, [f.transfer]);
  assert.deepEqual(
    (await f.h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature")).rows,
    before,
  );
  await migrateIssueTransferMetadata(f.h.db);
  assert.equal((await f.load()).length, 1);
  const capture = issueTransferCapture(rows);
  assert.doesNotThrow(() => assertIssueTransferCapture(capture, rows));
  assert.throws(() => assertIssueTransferCapture(capture, []), /issue_transfer_frozen_binding_unavailable/);
});

for (const mutation of ["empty arrays", "removed fields"])
  test(`historical ${mutation} cannot hide a corrupted normalization before hash admission`, async (t) => {
    const f = await fixture(t);
    await f.persist();
    await migrateIssueTransferMetadata(f.h.db);
    f.h.duplicate();
    const request = {
      runId: "synthetic-history-superseded",
      repositoryId: 2,
      family: "issues",
      mode: "audit",
      since: null,
      until: new Date().toISOString(),
    };
    await f.h.runtime.collection.start(request);
    assert.equal(await f.h.runtime.collection.step(request.runId, f.h.options.source), "complete");
    const superseded = (
      await f.h.db.query(
        `SELECT EXISTS(SELECT 1 FROM leaderboard_ingestion.source_facts newer JOIN leaderboard_ingestion.source_facts original ON original.fact_key=$1 WHERE newer.subject_id=original.subject_id AND newer.repository_id=original.repository_id AND newer.observed_at>original.observed_at) AS superseded`,
        [f.row.fact_key],
      )
    ).rows[0].superseded;
    assert.equal(superseded, true);
    const changed = structuredClone(f.document);
    if (mutation === "empty arrays") {
      changed.issueTransfers = [];
      changed.issueCreationScopes = [];
    } else {
      delete changed.issueTransfers;
      delete changed.issueCreationScopes;
    }
    await f.persist(changed, f.pin);
    const filtered = (
      await f.h.db.query(
        "SELECT 1 FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND (document->'issueTransfers'<>'[]'::jsonb OR document->'issueCreationScopes'<>'[]'::jsonb)",
        [f.row.fact_key],
      )
    ).rows.length;
    assert.equal(filtered, 0);
    t.diagnostic(
      JSON.stringify({
        mutation,
        legacyJsonPredicateRows: filtered,
        indexedRows: 1,
        unchangedPin: f.pin,
        mutatedDocumentHash: issueTransferDigest(changed),
      }),
    );
    await assert.rejects(f.load(), /issue_transfer_integrity_error/);
    assert.equal(
      (await f.h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.issue_transfer_index")).rows[0].n,
      1,
    );
  });

test("migration hashes every legacy candidate before checking metadata presence and rolls back atomically", async (t) => {
  const f = await fixture(t);
  await f.persist({ ...f.document, issueTransfers: [], issueCreationScopes: [] }, f.pin);
  await assert.rejects(migrateIssueTransferMetadata(f.h.db), /issue_transfer_integrity_error/);
  assert.equal(
    (await f.h.db.query("SELECT to_regclass('leaderboard_pipeline.issue_transfer_index') AS name")).rows[0].name,
    null,
  );
});

test("40,000 legitimate untyped historical cache rows survive the paged installation walk", async (t) => {
  const f = await fixture(t);
  const doc = { facts: [], actors: [], evidence: [], isSynthetic: true };
  await f.h.db.query(
    `INSERT INTO leaderboard_pipeline.normalizations(fact_key,policy_signature,document,document_hash)
    SELECT $1,lpad(to_hex(n),64,'0'),$2::jsonb,$3 FROM generate_series(1,40000) AS n`,
    [f.row.fact_key, JSON.stringify(doc), issueTransferDigest(doc)],
  );
  const before = (await f.h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n;
  assert.equal(before, 40002);
  await migrateIssueTransferMetadata(f.h.db);
  assert.deepEqual(await f.load(), []);
  assert.equal(
    (await f.h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.normalizations")).rows[0].n,
    before,
  );
});

test("source row, actual observation, and both approved endpoint coordinates bind private proof", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { sourceRepositoryId: "3" },
    { targetRepositoryId: "4" },
    { sourceRevision: "synthetic-foreign-revision" },
    { observedAt: "2026-01-01T00:00:00.000Z" },
    { sourceUrl: "https://github.com/synthetic-org/synthetic-other/issues/1" },
    { targetUrl: "https://github.com/synthetic-org/synthetic-other/issues/9" },
    { observationId: "gh:synthetic-unbound" },
  ])
    assert.throws(
      () =>
        privateIssueTransferMetadata(
          { ...f.output, issueTransfers: [{ ...f.transfer, ...change }] },
          { ...f.row, document: f.row.source_document },
          f.repositories[0],
          f.repositories,
        ),
      /invalid_(private_)?issue_transfer/,
    );
});

test("same-source refresh cannot drop previously admitted typed proof", async (t) => {
  const f = await fixture(t);
  const fresh = { ...f.output, issueTransfers: [], issueCreationScopes: [], observations: [] };
  const union = privateIssueTransferMetadata(
    fresh,
    { ...f.row, document: f.row.source_document },
    f.repositories[0],
    f.repositories,
    f.document,
  );
  assert.deepEqual(union.issueTransfers, [f.transfer]);
  assert.deepEqual(union.issueTransferObservations, f.document.issueTransferObservations);
});
test("a mismatched index repository cannot acknowledge a normalization update and the transaction rolls back", async (t) => {
  const f = await fixture(t);
  await f.persist();
  await migrateIssueTransferMetadata(f.h.db);
  await f.h.db.query(
    "UPDATE leaderboard_pipeline.issue_transfer_index SET repository_id=4 WHERE fact_key=$1 AND policy_signature=$2",
    [f.row.fact_key, f.row.policy_signature],
  );
  const changed = { ...f.document, reasons: ["synthetic_changed_reason"] };
  await assert.rejects(
    f.h.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE leaderboard_pipeline.normalizations SET document=$1::jsonb,document_hash=$2 WHERE fact_key=$3 AND policy_signature=$4",
        [JSON.stringify(changed), issueTransferDigest(changed), f.row.fact_key, f.row.policy_signature],
      );
      await retainIssueTransferIndex(
        tx,
        { ...f.row, document: f.row.source_document },
        f.row.policy_signature,
        changed,
      );
    }),
    /issue_transfer_index_write_conflict/,
  );
  const saved = (
    await f.h.db.query(
      "SELECT document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2",
      [f.row.fact_key, f.row.policy_signature],
    )
  ).rows[0];
  assert.deepEqual(saved, { document: f.document, document_hash: f.pin });
});

test("a destination-only configuration discovers retained source proof without approving the removed source", async (t) => {
  const f = await fixture(t);
  await f.persist();
  await migrateIssueTransferMetadata(f.h.db);
  await f.h.db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(3,1,'public')",
  );
  const repositories = [{ ...f.repositories[1], installationId: 1 }];
  const authority = await f.h.db.transaction((tx) =>
    readIssueTransferAuthority(tx, { repositories, repositoryIds: [3], dataMode: "synthetic" }),
  );
  assert.equal(authority.selectedPublic, true);
  assert.deepEqual(authority.repositoryIds, ["2", "3"]);
  assert.deepEqual(
    authority.rows.map((row) => row.binding.documentHash),
    [f.pin],
  );
  assert.deepEqual(authority.transfers, [f.transfer]);
  assert.ok(authority.removed.includes(f.transfer.sourceArtifactId));
  assert.ok(authority.removed.includes(f.transfer.targetArtifactId));
  assert.deepEqual(authority.capture.selectedRepositoryIds, ["3"]);
  assert.equal(
    (await f.h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
      .state,
    "public",
  );
  assert.deepEqual(
    (
      await f.h.db.query(
        "SELECT document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2",
        [f.row.fact_key, f.row.policy_signature],
      )
    ).rows[0],
    { document: f.document, document_hash: f.pin },
  );
});

test("destination discovery still hashes superseded source proof before reading mutated empty arrays", async (t) => {
  const f = await fixture(t);
  await f.persist();
  await migrateIssueTransferMetadata(f.h.db);
  await f.h.db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state) VALUES(3,1,'public')",
  );
  await f.persist({ ...f.document, issueTransfers: [], issueCreationScopes: [] }, f.pin);
  const repositories = [{ ...f.repositories[1], installationId: 1 }];
  await assert.rejects(
    f.h.db.transaction((tx) =>
      readIssueTransferAuthority(tx, { repositories, repositoryIds: [3], dataMode: "synthetic" }),
    ),
    /issue_transfer_integrity_error/,
  );
});

test("retained endpoint projection must exactly match the hash-verified normalization", async (t) => {
  const f = await fixture(t);
  await f.persist();
  await migrateIssueTransferMetadata(f.h.db);
  await f.h.db.query(
    "UPDATE leaderboard_pipeline.issue_transfer_endpoints SET endpoint_url='https://github.com/synthetic-org/synthetic-target/issues/10' WHERE repository_id=3",
  );
  await assert.rejects(f.load(), /issue_transfer_endpoint_integrity_error/);
});
