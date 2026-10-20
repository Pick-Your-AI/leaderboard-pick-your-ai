import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { helpfulFeedbackHarness } from "./helpful-feedback-harness.mjs";
import { components } from "./harness.mjs";
import { PipelineDerivedRetirementStore, migratePipelineDerivedRetirement } from "../src/derived-retirement.mjs";
import { discussionFeedbackDigest } from "../src/discussion-feedback-store.mjs";

test("authorized bounded repository retirement erases actual feedback descriptors and generations while preserving unrelated rows", async (t) => {
  const h = await helpfulFeedbackHarness(t);
  assert.equal((await h.collect()).state, "published");
  await h.accept();
  assert.equal((await h.collect()).state, "published");
  const scans = (await h.db.query("SELECT * FROM leaderboard_pipeline.discussion_feedback_scans WHERE repository_id=2"))
    .rows;
  assert.equal(scans.length, 2);
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  await migratePipelineDerivedRetirement(h.db);
  const retirement = new components.ingestion.RepositoryRetirementStore(h.db);
  const eraser = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
  // An independent synthetic namespace is deliberately not enrolled in this
  // runtime. Retirement must preserve it without interpreting its payload.
  await h.db.query(
    "INSERT INTO leaderboard_ingestion.repository_access(repository_id,installation_id,state,generation) VALUES(3,1,'unavailable',1)",
  );
  const foreign = { repositoryId: 3, fixture: "synthetic-unrelated-feedback-retention" };
  for (const table of ["discussion_feedback_heads", "discussion_feedback_scans"])
    await h.db.query(
      `INSERT INTO leaderboard_pipeline.${table}(repository_id,${table.endsWith("scans") ? "scan_id," : ""}document,document_hash)
      VALUES(3,${table.endsWith("scans") ? "'synthetic-foreign-scan'," : ""}$1::jsonb,$2)`,
      [JSON.stringify(foreign), discussionFeedbackDigest(foreign)],
    );
  const expectedGeneration = String(
    (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
      .generation,
  );
  const input = {
    operationId: "synthetic-feedback-retirement",
    repositoryId: 2,
    expectedGeneration,
    policyVersion: "synthetic-feedback-retention-v1",
    authorizationReceipt: "synthetic-retirement-approval",
    operatorId: "synthetic-operator",
  };
  const authorize = async () => true;
  await retirement.retire(input, authorize);
  const receipts = [];
  for (let index = 0; index < 80; index++) {
    const receipt = await eraser.eraseBatch(input, `synthetic-feedback-erase-${index}`, 1, authorize);
    assert.ok(receipt.selected <= 1);
    receipts.push(receipt);
    if (receipt.status !== "applied") break;
  }
  assert.equal(receipts.at(-1).status, "owned_scope_erased");
  assert.equal(
    receipts
      .filter((entry) => entry.stage === "discussion_feedback_scans")
      .reduce((sum, entry) => sum + entry.removed, 0),
    2,
  );
  assert.equal(
    receipts
      .filter((entry) => entry.stage === "discussion_feedback_heads")
      .reduce((sum, entry) => sum + entry.removed, 0),
    1,
  );
  for (const table of ["discussion_feedback_heads", "discussion_feedback_scans"]) {
    const retained = (await h.db.query(`SELECT * FROM leaderboard_pipeline.${table}`)).rows;
    assert.equal(retained.length, 1);
    assert.equal(Number(retained[0].repository_id), 3);
    assert.deepEqual(retained[0].document, foreign);
  }
  const manifests = (await h.db.query("SELECT document FROM leaderboard_pipeline.derived_retirement_manifests")).rows;
  assert.doesNotMatch(JSON.stringify(manifests), /bodyDigest|titleDigest|coverageEpoch|descriptorFingerprint/);
  await h.reopenDatabase();
  const last = receipts.at(-1);
  assert.deepEqual(await eraser.eraseBatch(input, last.batchId, 1, authorize), last);
  const source = await retirement.eraseBatch(input, "synthetic-feedback-source-erasure", 100, authorize);
  assert.equal(source.status, "erased");
  assert.equal(source.deletedSourceFacts, 2);
  await assert.rejects(h.collect(), /repository_revoked_or_changed|repository_retired|pipeline_repository_retired/);
});
