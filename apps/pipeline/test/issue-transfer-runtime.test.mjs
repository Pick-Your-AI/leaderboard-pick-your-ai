import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPipeline } from "../src/index.mjs";
import { PipelineDerivedRetirementStore, migratePipelineDerivedRetirement } from "../src/derived-retirement.mjs";
import { readIssueTransferAuthority } from "../src/issue-transfer-authority.mjs";
import { issueTransferHarness } from "./issue-transfer-harness.mjs";
import { components, clock, fixtureId, publicScope } from "./harness.mjs";

const approved = async () => true;
const counts = (board) =>
  board.rows.map((row) => [row.actorId, row.result.value]).sort((a, b) => a[0].localeCompare(b[0]));
const scope = (repository = null) => ({
  ...publicScope,
  repository: repository === null ? null : String(repository),
  context: "current",
});
const query = (repository = null, snapshot = null) =>
  new URLSearchParams({
    metric: "issues_opened",
    context: "current",
    ...(repository === null ? {} : { repository: String(repository) }),
    ...(snapshot ? { snapshot } : {}),
  }).toString();
async function board(runtime, repository = null, snapshot = null) {
  const response = await runtime.app.inject(`/api/v1/boards?${query(repository, snapshot)}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function publish(runtime) {
  const result = await runtime.runOnce();
  assert.equal(result.state, "published", JSON.stringify(result));
  return result;
}
async function originalNormalizations(h) {
  return (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
}
async function destinationRuntime(t, h) {
  const config = structuredClone(h.config);
  config.version = "synthetic-destination-only-v1";
  config.repositories = config.repositories.filter((repo) => repo.id === 3);
  config.scopes = [scope(3)];
  const runtime = await createPipeline({ ...h.options, config });
  t.after(() => runtime.stop());
  return { runtime, config };
}
async function retireSource(t, h) {
  await h.engine.exec(
    await readFile(
      new URL("../../../packages/ingestion/sql/005_collection_retirement.up.sql", import.meta.url),
      "utf8",
    ),
  );
  await migratePipelineDerivedRetirement(h.db);
  const source = new components.ingestion.RepositoryRetirementStore(h.db);
  const eraser = new PipelineDerivedRetirementStore(h.db, h.controlsStore);
  const input = {
    operationId: "synthetic-transfer-retirement",
    repositoryId: 2,
    expectedGeneration: String(
      (await h.db.query("SELECT generation FROM leaderboard_ingestion.repository_access WHERE repository_id=2")).rows[0]
        .generation,
    ),
    policyVersion: "synthetic-retention-v1",
    authorizationReceipt: "synthetic-private-approval",
    operatorId: "synthetic-operator",
  };
  await source.retire(input, approved);
  let last;
  for (let index = 0; index < 100; index++) {
    last = await eraser.eraseBatch(input, `synthetic-transfer-derived-${index}`, 10, approved);
    assert.ok(last.selected <= 10);
    if (last.status !== "applied") break;
  }
  assert.equal(last?.status, "owned_scope_erased", JSON.stringify(last));
  const erased = await source.eraseBatch(input, "synthetic-transfer-source-erasure", 100, approved);
  assert.equal(erased.status, "erased", JSON.stringify(erased));
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE repository_id=2"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (
      await h.db.query(
        "SELECT count(*)::int AS n FROM leaderboard_pipeline.source_artifacts a JOIN leaderboard_ingestion.source_facts f USING(fact_key) WHERE f.repository_id=2",
      )
    ).rows[0].n,
    0,
  );
  return { input, last, erased };
}

test("actual enriched transfer conserves one creation across source destination and organization views", async (t) => {
  const h = await issueTransferHarness(t);
  await publish(h.runtime);
  assert.deepEqual(counts(await board(h.runtime)), [
    ["101", 1],
    ["303", 1],
  ]);
  assert.deepEqual(counts(await board(h.runtime, 2)), [["303", 1]]);
  const destination = await board(h.runtime, 3);
  assert.deepEqual(counts(destination), [["101", 1]]);
  const id = destination.rows[0].evidenceIds[0];
  const proof = await h.runtime.app.inject(`/api/v1/evidence/${id}?${query(3, destination.snapshotId)}`);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.equal(proof.json().artifact.publicUrl, h.fixture.targetUrl);
  assert.equal(proof.json().artifact.stableId, h.fixture.targetId);
  const original = await originalNormalizations(h);
  assert.ok(
    original.some((row) =>
      row.document.facts.some((fact) => fact.metricId === "issue_transfers" && fact.actorId === "202"),
    ),
  );
  assert.ok(
    original.some((row) =>
      row.document.facts.some(
        (fact) => fact.metricId === "issues_opened" && fact.artifactId === h.fixture.sourceId && fact.repoId === "2",
      ),
    ),
  );
  assert.ok(
    original.some((row) =>
      row.document.facts.some(
        (fact) => fact.metricId === "issues_opened" && fact.artifactId === h.fixture.targetId && fact.repoId === "3",
      ),
    ),
  );
  assert.equal(
    destination.rows.some((row) => row.actorId === "202"),
    false,
  );
  const inputs = (await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs")).rows;
  assert.ok(inputs.some((row) => row.document.identityAuthorization.issueTransferEvidence.bindings.length > 0));
  await board(h.runtime, 3, destination.snapshotId);
  assert.deepEqual(await originalNormalizations(h), original);
});

for (const numericFallback of [false, true])
  test(`equal native ${numericFallback ? "numeric fallback" : "node"} identity conserves creation without an enriched edge`, async (t) => {
    const h = await issueTransferHarness(t, { sameNativeId: true, numericFallback });
    await publish(h.runtime);
    assert.deepEqual(counts(await board(h.runtime)), [
      ["101", 1],
      ["303", 1],
    ]);
    assert.deepEqual(counts(await board(h.runtime, 2)), [["303", 1]]);
    assert.deepEqual(counts(await board(h.runtime, 3)), [["101", 1]]);
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.issue_transfer_index")).rows[0].n,
      0,
    );
  });

test("unproven distinct issue IDs keep separate creations and an unrelated reporter remains independent", async (t) => {
  const h = await issueTransferHarness(t, { includeTransfer: false });
  await publish(h.runtime);
  assert.deepEqual(counts(await board(h.runtime)), [
    ["101", 2],
    ["303", 1],
  ]);
  assert.deepEqual(counts(await board(h.runtime, 2)), [
    ["101", 1],
    ["303", 1],
  ]);
  assert.deepEqual(counts(await board(h.runtime, 3)), [["101", 1]]);
});

test("a protected dated destination can be projected without a destination issue view", async (t) => {
  const h = await issueTransferHarness(t, { includeTarget: false });
  await publish(h.runtime);
  const destination = await board(h.runtime, 3);
  assert.deepEqual(counts(destination), [["101", 1]]);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE repository_id=3"))
      .rows[0].n,
    0,
  );
  const proof = (
    await h.runtime.app.inject(
      `/api/v1/evidence/${destination.rows[0].evidenceIds[0]}?${query(3, destination.snapshotId)}`,
    )
  ).json();
  assert.equal(proof.artifact.publicUrl, h.fixture.targetUrl);
  const retained = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      destination.snapshotId,
    ])
  ).rows[0].document.frozen.facts.find((fact) => fact.metricId === "issues_opened" && fact.actorId === "101");
  const original = (await originalNormalizations(h))
    .flatMap((row) => row.document.facts)
    .find((fact) => fact.metricId === "issues_opened" && fact.artifactId === h.fixture.sourceId);
  assert.equal(retained.currentContext, null);
  assert.equal(retained.observedAt, original.observedAt);
  assert.equal(proof.evidenceMetadata.observedAt, original.observedAt);
});

test("a later normalization that omits enrichment keeps previously admitted transfer identity", async (t) => {
  const h = await issueTransferHarness(t);
  await publish(h.runtime);
  const originals = await originalNormalizations(h);
  const proofRows = originals.filter((row) => row.document.issueTransfers?.length);
  h.fixture.generation++;
  h.fixture.setTransferEnrichment(false);
  await publish(h.runtime);
  assert.deepEqual(counts(await board(h.runtime)), [
    ["101", 1],
    ["303", 1],
  ]);
  assert.deepEqual(counts(await board(h.runtime, 3)), [["101", 1]]);
  const saved = await originalNormalizations(h);
  for (const row of proofRows)
    assert.deepEqual(
      saved.find(
        (candidate) => candidate.fact_key === row.fact_key && candidate.policy_signature === row.policy_signature,
      ),
      row,
    );
  assert.ok(h.fixture.normalizerCalls.some((call) => call.omittedTransferPayload));
});

test("narrowing configuration to the destination withdraws its alias without exposing the unapproved source", async (t) => {
  const h = await issueTransferHarness(t);
  await publish(h.runtime);
  const { runtime, config } = await destinationRuntime(t, h);
  await publish(runtime);
  const destination = await board(runtime, 3);
  assert.deepEqual(counts(destination), []);
  const authority = await h.db.transaction((tx) =>
    readIssueTransferAuthority(tx, { repositories: config.repositories, repositoryIds: [3], dataMode: "synthetic" }),
  );
  assert.deepEqual(authority.repositoryIds, ["2", "3"]);
  assert.equal(authority.selectedPublic, true);
  assert.ok(authority.removed.includes(h.fixture.targetId));
  assert.equal(JSON.stringify(destination).includes("synthetic-reporter"), false);
});

for (const includeTarget of [true, false])
  test(`permanent retirement withdraws an ${includeTarget ? "existing" : "only subsequently observed"} equal-ID alias after source rows are erased and configuration narrows`, async (t) => {
    const h = await issueTransferHarness(t, { sameNativeId: true, includeTarget });
    await publish(h.runtime);
    const before = await board(h.runtime, 3);
    assert.deepEqual(counts(before), includeTarget ? [["101", 1]] : []);
    const originalReceipts = (await h.runtime.receipts()).filter((row) => row.kind === "snapshot_published");
    await retireSource(t, h);
    h.fixture.setTargetView(true);
    h.fixture.generation++;
    const { runtime, config } = await destinationRuntime(t, h);
    await publish(runtime);
    assert.deepEqual(counts(await board(runtime, 3)), []);
    const authority = await h.db.transaction((tx) =>
      readIssueTransferAuthority(tx, { repositories: config.repositories, repositoryIds: [3], dataMode: "synthetic" }),
    );
    assert.deepEqual(authority.repositoryIds, ["3"]);
    assert.ok(authority.removed.includes(h.fixture.targetId));
    assert.equal(authority.rows.length, 0);
    assert.ok(
      (await runtime.receipts()).filter((row) => row.kind === "snapshot_published").length >= originalReceipts.length,
    );
    assert.equal(
      (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE repository_id=3"))
        .rows[0].n > 0,
      true,
    );
  });

test("permanent retirement leaves explicit alias withdrawal after deleting its endpoint proof", async (t) => {
  const h = await issueTransferHarness(t);
  await publish(h.runtime);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.issue_transfer_index")).rows[0].n > 0,
    true,
  );
  await retireSource(t, h);
  assert.equal(
    (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.issue_transfer_index")).rows[0].n,
    0,
  );
  const { runtime, config } = await destinationRuntime(t, h);
  await publish(runtime);
  assert.deepEqual(counts(await board(runtime, 3)), []);
  const authority = await h.db.transaction((tx) =>
    readIssueTransferAuthority(tx, { repositories: config.repositories, repositoryIds: [3], dataMode: "synthetic" }),
  );
  assert.ok(authority.removed.includes(h.fixture.targetId));
  assert.deepEqual(authority.repositoryIds, ["3"]);
});
