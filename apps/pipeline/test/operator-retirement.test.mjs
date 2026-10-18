import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createPipeline } from "../src/index.mjs";
import { components } from "./harness.mjs";
import { operatorAllow, publishedOperatorReplay } from "./operator-harness.mjs";
import { operatorPublicationProofBytes } from "../src/operator-publication.mjs";

test("permanent source retirement denies health and replay results across actual database and runtime restart", async (t) => {
  const { h, receipt } = await publishedOperatorReplay(t);
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal((await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow)).status, "published");
  const before = { ...h.githubReads };
  const generation = String(
    (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
      .generation,
  );
  await new components.ingestion.RepositoryRetirementStore(h.db).retire(
    {
      operationId: "synthetic-operator-retirement",
      repositoryId: 2,
      expectedGeneration: generation,
      policyVersion: "synthetic-retention-v1",
      authorizationReceipt: "synthetic-explicit-retention",
      operatorId: "201",
    },
    async () => true,
  );
  await assert.rejects(h.runtime.operations.readHealth(2, operatorAllow), /operation_source_unavailable/);
  await assert.rejects(
    h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow),
    /operation_source_unavailable/,
  );
  await h.runtime.stop();
  await h.reopenDatabase();
  const recovered = await createPipeline(h.options);
  t.after(() => recovered.stop());
  await assert.rejects(recovered.operations.readHealth(2, operatorAllow), /operation_source_unavailable/);
  await assert.rejects(
    recovered.operations.readReplayResult(2, receipt.id, operatorAllow),
    /operation_source_unavailable/,
  );
  assert.deepEqual(h.githubReads, before, "denied diagnostics acquire no token and make no source request");
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS count FROM leaderboard_ingestion.replay_processing_results")).rows[0]
      .count,
    1,
  );
  assert.equal(
    (await h.db.query("SELECT count(*)::integer AS count FROM leaderboard_pipeline.snapshots")).rows[0].count,
    2,
  );
});

test("retired repository checkpoint authority also denies health without deleting shared pool observations", async (t) => {
  const { h } = await publishedOperatorReplay(t, {
    quotaHeaders: {
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "4000",
    },
  });
  const sibling = h.options.githubClient.forRepository(3);
  const before = await sibling.readQuota("installation:1");
  const calls = { ...h.githubReads };
  await h.options.githubClient.retireRepositoryCheckpoints(2, {
    operationId: "synthetic-operator-checkpoint-retirement",
    policyId: "synthetic-retention-v1",
    authorizationId: "synthetic-explicit-retention",
  });
  await assert.rejects(
    h.runtime.operations.readHealth(2, operatorAllow),
    (error) =>
      error.outcome?.kind === "unsafe_request" && error.message === "GitHub source request failed: unsafe_request",
  );
  assert.deepEqual(await sibling.readQuota("installation:1"), before);
  assert.deepEqual(h.githubReads, calls);
});

test("an oversized native publication manifest is withheld before loading snapshot or private proof payloads", async (t) => {
  const { h, receipt } = await publishedOperatorReplay(t);
  const transact = h.db.transaction.bind(h.db);
  let manifests = 0,
    payloadReads = 0;
  h.db.transaction = (work) =>
    transact((tx) =>
      work({
        query: async (sql, params) => {
          if (sql.includes("SELECT document,document_hash FROM leaderboard_pipeline.snapshots")) payloadReads++;
          const value = await tx.query(sql, params);
          if (sql.includes("octet_length(snapshot.document::text) AS document_bytes")) {
            manifests++;
            return {
              ...value,
              rows: value.rows.map((row) => ({ ...row, document_bytes: operatorPublicationProofBytes + 1 })),
            };
          }
          return value;
        },
      }),
    );
  const result = await h.runtime.operations.readReplayResult(2, receipt.id, operatorAllow);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.publications, []);
  assert.equal(result.publicationDelaySeconds, null);
  const health = await h.runtime.operations.readHealth(2, operatorAllow);
  assert.equal(health.publication.state, "unavailable");
  assert.deepEqual(health.publication.publications, []);
  assert.equal(manifests, 2);
  assert.equal(payloadReads, 0);
});
