import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { harness, getBoard, components, boardUrl } from "./harness.mjs";

test("permanent collection retirement fences actual current/pinned public handlers and survives a database reopen", async (t) => {
  const h = await harness(t);
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal((await h.runtime.runOnce()).state, "published");
  const board = await getBoard(h.runtime);
  const key = board.rows[0].evidenceIds[0];
  const generation = String(
    (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
      .generation,
  );
  const request = {
    operationId: "synthetic-pipeline-retirement",
    repositoryId: 2,
    expectedGeneration: generation,
    policyVersion: "synthetic-retention-v1",
    authorizationReceipt: "synthetic-private-approval",
    operatorId: "synthetic-operator",
  };
  const retention = new components.ingestion.RepositoryRetirementStore(h.db);
  await retention.retire(request, async () => true);
  const retainedBefore = await h.db.query(
    "SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key",
  );
  const blocked = await retention.eraseBatch(request, "synthetic-projection-blocked", 100, async () => true);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.deletedSourceFacts, 0);
  assert.deepEqual(
    await h.db.query("SELECT fact_key,document FROM leaderboard_ingestion.source_facts ORDER BY fact_key"),
    retainedBefore,
  );
  for (const suffix of ["", `&snapshot=${board.snapshotId}`]) {
    const expected = suffix ? 410 : 503;
    assert.equal((await h.runtime.app.inject(boardUrl + suffix)).statusCode, expected);
    assert.equal(
      (await h.runtime.app.inject(`/api/v1/exports?metric=issues_opened&format=json${suffix}`)).statusCode,
      expected,
    );
  }
  const proof = await h.runtime.app.inject(`/api/v1/evidence/${key}?snapshot=${board.snapshotId}`);
  assert.equal(proof.statusCode, 410);
  assert.doesNotMatch(proof.body, /synthetic-alice|Synthetic collected issue title/);
  await h.reopenDatabase();
  assert.equal((await h.runtime.app.inject(boardUrl + `&snapshot=${board.snapshotId}`)).statusCode, 410);
  await assert.rejects(h.runtime.runOnce(), /repository_retired/);
  assert.equal(
    (await h.db.query("SELECT state FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0].state,
    "unavailable",
  );
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.lifecycle_receipts")).rows[0].n,
    0,
  );
});
