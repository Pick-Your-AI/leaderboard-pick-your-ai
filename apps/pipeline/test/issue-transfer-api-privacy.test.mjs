import test from "node:test";
import assert from "node:assert/strict";
import { issueTransferHarness } from "./issue-transfer-harness.mjs";
import { clock, components, fixtureId } from "./harness.mjs";

const query = (repository = null, snapshot = null) =>
  new URLSearchParams({
    metric: "issues_opened",
    context: "current",
    ...(repository === null ? {} : { repository: String(repository) }),
    ...(snapshot ? { snapshot } : {}),
  }).toString();
const counts = (board) => board.rows.map((row) => [row.actorId, row.result.value]).sort();
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
async function pins(runtime) {
  return Promise.all([null, 2, 3].map(async (repository) => ({ repository, board: await board(runtime, repository) })));
}
async function normalizations(h) {
  return (
    await h.db.query(
      "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
    )
  ).rows;
}
async function assertPreservedNormalizations(h, originals) {
  const current = await normalizations(h);
  for (const original of originals)
    assert.deepEqual(
      current.find((row) => row.fact_key === original.fact_key && row.policy_signature === original.policy_signature),
      original,
    );
}
async function assertWithdrawn(runtime, entries, denied = new Set()) {
  for (const { repository, board: original } of entries) {
    for (const snapshot of [null, original.snapshotId]) {
      const result = await runtime.app.inject(`/api/v1/boards?${query(repository, snapshot)}`);
      if (denied.has(repository)) {
        assert.equal(result.statusCode, snapshot ? 410 : 503, result.body);
        continue;
      }
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(counts(result.json()), repository === 3 ? [] : [["303", 1]]);
      for (const format of ["json", "csv"]) {
        const exported = await runtime.app.inject(`/api/v1/exports?${query(repository, snapshot)}&format=${format}`);
        assert.equal(exported.statusCode, 200, exported.body);
        assert.equal(exported.body.includes("synthetic-reporter"), false);
        for (const id of original.rows.find((row) => row.actorId === "101")?.evidenceIds ?? [])
          assert.equal(exported.body.includes(id), false);
      }
    }
    for (const id of original.rows.find((row) => row.actorId === "101")?.evidenceIds ?? []) {
      const evidence = await runtime.app.inject(`/api/v1/evidence/${id}?${query(repository, original.snapshotId)}`);
      assert.equal(evidence.statusCode, denied.has(repository) ? 410 : 404, evidence.body);
    }
  }
}
async function deleteTarget(h, id) {
  const runId = fixtureId(id);
  await h.runtime.collection.start({
    runId,
    repositoryId: 3,
    family: "issues",
    mode: "audit",
    since: null,
    until: clock(),
  });
  const result = await h.runtime.collection.step(runId, {
    async readPage(request) {
      assert.equal(request.repositoryId, 3);
      assert.equal(request.family, "issues");
      return {
        repositoryId: 3,
        visibility: "public",
        isSynthetic: true,
        expectedCount: 1,
        nextCursor: null,
        facts: [
          {
            subjectId: h.fixture.targetSubjectId,
            sourceRevision: "synthetic-target-deleted:v1",
            sourceUrl: h.fixture.targetUrl,
            evidence: "current_state",
            actorId: null,
            occurredAt: null,
            state: "deleted",
          },
        ],
      };
    },
  });
  assert.equal(result, "complete");
}

for (const includeTarget of [true, false])
  test(`actual target object deletion withdraws current and pre-transfer pinned aliases ${includeTarget ? "with" : "without"} a target issue view`, async (t) => {
    const h = await issueTransferHarness(t, { includeTransfer: false, includeTarget: false });
    await publish(h.runtime);
    const earlier = await pins(h.runtime);
    assert.deepEqual(counts(earlier[0].board), [
      ["101", 1],
      ["303", 1],
    ]);
    const earlierSource = earlier.find((entry) => entry.repository === 2).board;
    await h.runtime.previewPolicy({
      snapshotId: earlierSource.snapshotId,
      policy: { ...h.config.policies[0].policy, version: "synthetic-transfer-preview-v2" },
      operatorId: "201",
    });
    h.fixture.setTransferObservation(true);
    h.fixture.setTargetView(includeTarget);
    h.fixture.generation++;
    await publish(h.runtime);
    const later = await pins(h.runtime);
    assert.deepEqual(counts(later.find((entry) => entry.repository === 3).board), [["101", 1]]);
    if (!includeTarget)
      assert.equal(
        (await h.db.query("SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts WHERE repository_id=3"))
          .rows[0].n,
        0,
      );
    const originals = await normalizations(h);
    await deleteTarget(h, includeTarget ? 610 : 611);
    assert.deepEqual(
      (
        await h.db.query(
          "SELECT subject_id,reason FROM leaderboard_ingestion.object_suppressions WHERE repository_id=3",
        )
      ).rows,
      [{ subject_id: h.fixture.targetSubjectId, reason: "deleted" }],
    );
    await assertWithdrawn(h.runtime, [...earlier, ...later]);
    await assert.rejects(
      h.runtime.previewPolicy({
        snapshotId: earlierSource.snapshotId,
        policy: { ...h.config.policies[0].policy, version: "synthetic-transfer-preview-v3" },
        operatorId: "201",
      }),
      /policy_input_revoked|Frozen input|private.*changed/,
    );
    await assertPreservedNormalizations(h, originals);
  });

test("actual private lifecycle at the nonselected target withdraws pre-transfer source pins and current aliases", async (t) => {
  const h = await issueTransferHarness(t, { includeTransfer: false, includeTarget: false });
  await publish(h.runtime);
  const earlier = await pins(h.runtime);
  h.fixture.setTransferObservation(true);
  h.fixture.setTargetView(true);
  h.fixture.generation++;
  await publish(h.runtime);
  const later = await pins(h.runtime);
  const originals = await normalizations(h);
  assert.equal(await h.runtime.collection.suppress(fixtureId(612), "a".repeat(64), 1, [3], "private"), "accepted");
  await assertWithdrawn(h.runtime, [...earlier, ...later], new Set([null, 3]));
  await assertPreservedNormalizations(h, originals);
});

test("canonical alias growth preserves an original correction receipt and exact retry while excluding the new canonical creation", async (t) => {
  const h = await issueTransferHarness(t, {
    sourceId: "SYNTHETIC_ISSUE_A",
    targetId: "SYNTHETIC_GROWTH_TARGET_11",
    includeTransfer: false,
    includeTarget: false,
  });
  await publish(h.runtime);
  const before = await pins(h.runtime);
  const originalFactId = before[0].board.rows.find((row) => row.actorId === "101").evidenceIds[0];
  const requestId = fixtureId(613);
  h.controlsStore.transaction((state) => {
    state.requests[requestId] = {
      id: requestId,
      kind: "correction",
      owner: "303",
      locator: h.fixture.sourceUrl,
      status: "pending",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
    };
  });
  const decision = {
    requestId,
    expectedVersion: 1,
    factId: originalFactId,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  };
  const receipt = await h.runtime.applyCorrection(decision);
  assert.equal(receipt.status, "applied");
  const originalCorrection = (
    await h.db.query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])
  ).rows[0];
  const originals = await normalizations(h);
  await publish(h.runtime);
  const correctedSource = await board(h.runtime, 2);
  assert.deepEqual(counts(correctedSource), [["303", 1]]);
  await h.runtime.aggregateExplanations.read(correctedSource.snapshotId);
  h.fixture.setTransferObservation(true);
  h.fixture.setTargetView(true);
  h.fixture.generation++;
  await publish(h.runtime);
  const all = await normalizations(h);
  const targetFact = all
    .flatMap((row) => row.document.facts)
    .find((fact) => fact.metricId === "issues_opened" && fact.artifactId === h.fixture.targetId);
  assert.ok(targetFact.id < originalFactId, "This fixture must actually change the canonical raw fact ID");
  const after = await pins(h.runtime);
  assert.deepEqual(counts(after[0].board), [["303", 1]]);
  assert.deepEqual(counts(after[1].board), [["303", 1]]);
  assert.deepEqual(counts(after[2].board), []);
  await assertWithdrawn(h.runtime, [...before, ...after]);
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      after[0].board.snapshotId,
    ])
  ).rows[0].document;
  const revisions = frozen.frozen.facts
    .filter((fact) => fact.id === targetFact.id && fact.metricId === "issues_opened")
    .sort((a, b) => a.revision - b.revision);
  assert.equal(revisions[0].state, "observed", "The immutable original observation remains retained");
  const projection = revisions.at(-1);
  assert.equal(projection.state, "excluded");
  assert.ok(projection.revision > revisions[0].revision);
  assert.ok(
    frozen.identityAuthorization.issueTransferCorrections.some(
      (mapping) => mapping.artifactId === h.fixture.sourceId && mapping.projectionArtifactId === h.fixture.targetId,
    ),
  );
  const freshExplanation = await h.runtime.aggregateExplanations.read(after[0].board.snapshotId);
  assert.deepEqual(
    freshExplanation.document.metrics
      .find((metric) => metric.metricId === "issues_opened")
      .rows.map((row) => row.actorId),
    ["303"],
  );
  const previousPolicy = frozen.policies.find((entry) => entry.policy.metricId === "issues_opened").policy;
  const privateAuthorization = freshExplanation.document.authorization;
  const preview = await h.runtime.policyComparisons.withAuthorizedInputs(
    [privateAuthorization],
    async (removed, authority) => {
      assert.equal(
        removed.includes(h.fixture.targetId),
        false,
        "The exact effective exclusion authorizes this fresh private capture",
      );
      const input = authority.restoreInput(frozen.frozen, privateAuthorization);
      return components.metrics.comparePolicies(
        input,
        previousPolicy,
        { ...previousPolicy, version: "synthetic-correction-growth-preview-v2" },
        frozen.engineScope,
      );
    },
  );
  assert.deepEqual(
    preview.before.rows.map((row) => [row.actorId, row.value]),
    [["303", 1]],
  );
  // The existing SQL preview API intentionally withholds any input containing
  // a public suppression. This correction does not relax that separate guard.
  await assert.rejects(
    h.runtime.previewPolicy({
      snapshotId: after[0].board.snapshotId,
      policy: { ...previousPolicy, version: "synthetic-correction-growth-preview-v3" },
      operatorId: "201",
    }),
    /policy_input_revoked/,
  );
  assert.deepEqual(await h.runtime.applyCorrection(decision), receipt);
  assert.deepEqual(
    (await h.db.query("SELECT * FROM leaderboard_pipeline.corrections WHERE request_id=$1", [requestId])).rows[0],
    originalCorrection,
  );
  await assertPreservedNormalizations(h, originals);
});
