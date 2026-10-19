import assert from "node:assert/strict";
import test from "node:test";
import { createPipeline } from "../src/index.mjs";
import { reversionHash } from "../src/reversion-effectiveness.mjs";
import { readCorrectionState } from "../src/reversion-store.mjs";
import { harness, components, publicScope, fixtureId } from "./harness.mjs";

async function scenario(t, extra = {}) {
  const epoch = Date.now() + 10_000;
  const at = (second) => new Date(epoch + second * 1000).toISOString();
  let current = at(4);
  const original = {
    id: "synthetic-merge-original",
    canonicalKey: "synthetic-original-unit",
    metricId: "pr_merged",
    actorId: "101",
    artifactId: "SYNTHETIC_ORIGINAL_PR",
    repoId: "2",
    role: "author",
    state: "observed",
    occurredAt: at(-120),
    observedAt: at(-100),
    acceptedAt: null,
    acceptedBy: null,
    acceptanceReceipt: null,
    revision: 0,
    correctionReceipt: null,
    subjectActorId: "101",
    eventContext: null,
    currentContext: null,
    rawState: "target:main",
  };
  const reverting = {
    ...original,
    id: "synthetic-merge-revert",
    canonicalKey: "synthetic-revert-unit",
    actorId: "102",
    subjectActorId: "102",
    artifactId: "SYNTHETIC_REVERT_PR",
    occurredAt: at(-110),
  };
  const qualified = {
    ...original,
    id: "synthetic-qualified-delivery",
    canonicalKey: "synthetic-qualified-unit",
    metricId: "pr_lines_changed",
    state: "qualified",
    acceptedAt: at(-105),
    acceptedBy: "202",
    acceptanceReceipt: "synthetic-independent-acceptance",
    quantity: 5,
  };
  const facts = [original, reverting, qualified];
  const source = {
    facts,
    actors: [101, 102].map((id) => ({
      id: String(id),
      githubDatabaseId: id,
      githubNodeId: "U_SYNTHETIC_" + id,
      login: "synthetic-user-" + id,
      kind: "user",
      publicState: "visible",
    })),
    evidence: facts.map((fact) => {
      const isRevert = fact.id === reverting.id,
        sha = (isRevert ? "b" : "a").repeat(40);
      return {
        artifact: {
          schemaVersion: "leaderboard/v1",
          source: "github",
          kind: "pull_request",
          stableId: fact.artifactId,
          repositoryId: "2",
          visibility: "public",
          publicUrl: "https://github.com/synthetic-org/synthetic-repo/pull/" + (isRevert ? 2 : 1),
        },
        contribution: {
          schemaVersion: "leaderboard/v1",
          contributionId: fact.id,
          canonicalEventId: fact.canonicalKey,
          artifactId: fact.artifactId,
          actorId: fact.actorId,
          roles: ["author"],
          qualification: "eligible",
          metricIds: [fact.metricId],
          reasonCodes: ["synthetic-reviewed-reversion-fixture"],
        },
        occurredAt: fact.occurredAt,
        sourceRevision: sha,
        sourceRevisionUrl: "https://github.com/synthetic-org/synthetic-repo/commit/" + sha,
        evidenceMetadata: {
          schemaVersion: "leaderboard-evidence/v1",
          artifactTitle: null,
          sourceAction: fact.state === "qualified" ? "recognition_accepted" : "pull_request_merged",
          sourceOccurredAt: fact.occurredAt,
          observedAt: fact.observedAt,
          activityState: fact.state === "qualified" ? "accepted" : "observed",
          acceptedAt: fact.acceptedAt,
          history: { coverage: "not_supplied", records: [] },
        },
      };
    }),
  };
  const reviewed = [];
  const h = await harness(t, {
    now: () => current,
    normalizerFactory:
      () =>
      async ({ fact }) =>
        fact.subjectId === "SYNTHETIC_ISSUE_1" ? structuredClone(source) : { facts: [], actors: [], evidence: [] },
    authorizeReversionDecision: async (candidate) => {
      reviewed.push(structuredClone(candidate));
      return (
        candidate.operation.operatorId === "201" && candidate.operation.approvalReceipt.startsWith("synthetic-review-")
      );
    },
    configure(config) {
      config.policies = [
        { metricId: "pr_merged", aggregation: "count", rankedStates: ["observed"], dateBasis: "occurredAt" },
        { metricId: "pr_lines_changed", aggregation: "sum", rankedStates: ["qualified"], dateBasis: "acceptedAt" },
      ].map((selected) => {
        const policy = {
          ...config.policies[0].policy,
          ...selected,
          roles: ["author"],
          groupBy: "actor_artifact",
          rank: false,
          unit: components.metrics.getMetricDefinition(selected.metricId).definition.unit,
        };
        return {
          policy,
          signature: components.metrics.stableJSON(policy),
          approvalReceipt: "synthetic-metric-approval",
        };
      });
    },
    ...extra,
  });
  const originalPublication = (await h.runtime.runOnce({ cutoff: current })).publications[0];
  const operation = (number, effect = "inactive", supersedes = null) => ({
    requestId: fixtureId(7400 + number),
    expectedVersion: 1,
    snapshotId: originalPublication.snapshotId,
    originalFactId: original.id,
    revertingFactId: reverting.id,
    targetFactIds: [qualified.id],
    effect,
    supersedes,
    effectiveAt: at(number + 4),
    reviewedAt: at(number + 4),
    operatorId: "201",
    approvalReceipt: "synthetic-review-" + number,
    publicReceiptUrl: "https://github.com/synthetic-org/synthetic-repo/issues/74#issuecomment-" + number,
  });
  const request = (op) =>
    h.controlsStore.transaction((state) => {
      state.requests[op.requestId] = {
        id: op.requestId,
        kind: "correction",
        owner: "101",
        locator: "https://github.com/synthetic-org/synthetic-repo/pull/1",
        status: "pending",
        version: 1,
        createdAt: Date.parse(current),
        updatedAt: Date.parse(current),
        history: [],
      };
    });
  const invoke = (runtime, op) =>
    runtime.applyReversionDecision({
      operation: op,
      lineageEvidenceIds: [original.id, reverting.id],
    });
  const board = async (runtime, metric, pin) => {
    const result = await runtime.app.inject("/api/v1/boards?metric=" + metric + (pin ? "&snapshot=" + pin : ""));
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  return {
    ...h,
    at,
    original,
    reverting,
    qualified,
    reviewed,
    operation,
    request,
    invoke,
    board,
    originalPublication,
    setTime(second) {
      current = at(second);
    },
    publish(runtime = h.runtime) {
      return runtime.runOnce({ cutoff: current });
    },
  };
}

test("reviewed reversion survives replay and reopen, preserves raw merges, and restores only a rebuilt qualified view", async (t) => {
  const h = await scenario(t),
    originalId = h.originalPublication.snapshotId;
  const originalSql = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
      originalId,
    ])
  ).rows[0];
  assert.equal((await h.board(h.runtime, "pr_lines_changed")).rows[0].result.value, 5);
  const inactive = h.operation(1);
  h.request(inactive);
  h.setTime(6);
  const recorded = await h.invoke(h.runtime, inactive);
  assert.equal(recorded.status, "applied");
  assert.equal(h.reviewed[0].source.original.sourceRevision, "a".repeat(40));
  assert.equal((await h.board(h.runtime, "pr_lines_changed")).rows.length, 0);
  assert.equal((await h.board(h.runtime, "pr_lines_changed", originalId)).rows.length, 0);
  const raw = await h.board(h.runtime, "pr_merged", originalId);
  assert.deepEqual(raw.rows.map((row) => [row.actorId, row.result.value]).sort(), [
    ["101", 1],
    ["102", 1],
  ]);
  const rawProof = await h.runtime.app.inject("/api/v1/evidence/" + h.original.id + "?snapshot=" + originalId);
  assert.equal(rawProof.statusCode, 200, rawProof.body);
  assert.match(rawProof.body, /issuecomment-1/);
  assert.doesNotMatch(rawProof.body, /synthetic-review-|decisionHash|approvalReceipt|reversionRecordsHash/);
  await assert.rejects(h.runtime.aggregateExplanations.read(originalId), /reversion_authority_changed/);
  h.setTime(7);
  const excluded = (await h.publish()).publications[0];
  assert.notEqual(excluded.snapshotId, originalId);
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      excluded.snapshotId,
    ])
  ).rows[0].document;
  assert.equal(frozen.frozen.facts.filter((fact) => fact.metricId === "pr_merged").length, 2);
  assert.deepEqual(
    frozen.frozen.facts.filter((fact) => fact.id === h.qualified.id).map((fact) => fact.state),
    ["qualified", "excluded"],
  );
  assert.equal(
    (await h.runtime.aggregateExplanations.read(excluded.snapshotId)).document.metrics.find(
      (metric) => metric.metricId === "pr_lines_changed",
    ).rows.length,
    0,
  );
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await h.reopenDatabase();
  assert.deepEqual(await h.invoke(reopened, inactive), recorded);
  assert.equal(h.controlsStore.read().requests[inactive.requestId].history.length, 1);
  const active = h.operation(2, "active", inactive.requestId);
  h.request(active);
  h.setTime(8);
  await h.invoke(reopened, active);
  assert.equal((await h.board(reopened, "pr_lines_changed", originalId)).rows.length, 0);
  assert.equal((await h.board(reopened, "pr_lines_changed", excluded.snapshotId)).rows.length, 0);
  h.setTime(9);
  const restored = (await h.publish(reopened)).publications[0];
  const restoredRead = await reopened.source.read(publicScope, restored.snapshotId, new AbortController().signal);
  assert.deepEqual(
    restoredRead.selected.evidence.find((entry) => entry.contribution.contributionId === h.qualified.id)
      .evidenceMetadata,
    restoredRead.selected.portfolioEvidence.find((entry) => entry.contribution.contributionId === h.qualified.id)
      .evidenceMetadata,
    "all public copies use the same selected restoration observation",
  );
  assert.equal((await h.board(reopened, "pr_lines_changed")).rows[0].result.value, 5);
  assert.equal(
    (await h.board(reopened, "pr_merged")).rows.reduce((sum, row) => sum + row.result.value, 0),
    2,
  );
  const pair = await reopened.source.readComparison(
    publicScope,
    restored.snapshotId,
    { scope: publicScope, snapshotId: originalId },
    new AbortController().signal,
  );
  assert.equal(pair.current.selected.rows.find((row) => row.result.metricId === "pr_lines_changed").result.value, 5);
  assert.equal(pair.previous, null);
  assert.equal(pair.previousHistory, null);
  assert.equal(
    (await reopened.aggregateExplanations.read(restored.snapshotId)).document.authorization.reversionAuthority.hashes
      .length,
    1,
  );
  assert.deepEqual(
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
        originalId,
      ])
    ).rows[0],
    originalSql,
  );
  const decisions = await readCorrectionState(h.db, [2]);
  assert.equal(decisions.decisions.length, 2);
  assert.equal((await reopened.receipts()).filter((receipt) => receipt.kind === "correction_applied").length, 2);
});

test("reversion admission defaults to denial and rechecks the pending request after protected authorization", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  const denied = await createPipeline({ ...h.options, authorizeReversionDecision: undefined });
  t.after(() => denied.stop());
  await assert.rejects(h.invoke(denied, op), /reversion_not_authorized/);
  const changed = await createPipeline({
    ...h.options,
    authorizeReversionDecision: async () => {
      h.controlsStore.transaction((state) => {
        state.requests[op.requestId].status = "withdrawn";
      });
      return true;
    },
  });
  t.after(() => changed.stop());
  await assert.rejects(h.invoke(changed, op), /reversion_request_conflict/);
  assert.equal((await readCorrectionState(h.db, [2])).decisions.length, 0);
  assert.equal((await h.board(h.runtime, "pr_lines_changed")).rows[0].result.value, 5);
});

test("reviewed reversion admits an intact host configuration grant across protected authorization", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  const runtime = await createPipeline({ ...h.options, verifyConfiguration: async () => true });
  t.after(() => runtime.stop());
  assert.equal((await h.invoke(runtime, op)).status, "applied");
  assert.equal((await readCorrectionState(h.db, [2])).decisions.length, 1);
  assert.equal(h.controlsStore.read().requests[op.requestId].status, "applied");
});

test("reviewed reversion rejects a host configuration grant withdrawn inside protected authorization", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  let granted = true;
  const runtime = await createPipeline({
    ...h.options,
    verifyConfiguration: async () => granted,
    authorizeReversionDecision: async () => {
      granted = false;
      return true;
    },
  });
  t.after(() => runtime.stop());
  await assert.rejects(h.invoke(runtime, op), /reversion_not_authorized/);
  assert.equal((await readCorrectionState(h.db, [2])).decisions.length, 0);
  assert.equal((await runtime.receipts()).filter((receipt) => receipt.kind === "correction_applied").length, 0);
  assert.equal(h.controlsStore.read().requests[op.requestId].status, "pending");
});

test("reviewed reversion rolls back when the host grant is withdrawn during final joined receipt readback", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  let granted = true,
    armed = false,
    revoked = false;
  const runtime = await createPipeline({
    ...h.options,
    verifyConfiguration: async () => granted,
    db: {
      query: h.db.query.bind(h.db),
      transaction: (work) =>
        h.db.transaction((tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property === "query")
                  return async (sql, params) => {
                    const result = await target.query(sql, params);
                    if (
                      armed &&
                      sql.includes("LEFT JOIN leaderboard_pipeline.receipts AS r") &&
                      result.rows.some((entry) => entry.request_id === op.requestId)
                    ) {
                      granted = false;
                      revoked = true;
                    }
                    return result;
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
    },
  });
  t.after(() => runtime.stop());
  armed = true;
  await assert.rejects(h.invoke(runtime, op), /reversion_not_authorized/);
  assert.equal(revoked, true);
  assert.equal((await readCorrectionState(h.db, [2])).decisions.length, 0);
  assert.equal((await runtime.receipts()).filter((receipt) => receipt.kind === "correction_applied").length, 0);
  assert.equal(h.controlsStore.read().requests[op.requestId].status, "pending");
});

test("unknown or unsealed correction tags fail public, private, publication and legacy retry consumers closed", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  await h.invoke(h.runtime, op);
  const row = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.corrections WHERE request_id=$1", [op.requestId])
  ).rows[0];
  const invalid = structuredClone(row.document);
  invalid.kind = "pipeline-reversion-effectiveness/v999";
  await h.db.query("UPDATE leaderboard_pipeline.corrections SET document=$2::jsonb WHERE request_id=$1", [
    op.requestId,
    JSON.stringify(invalid),
  ]);
  await assert.rejects(h.runtime.source.read(publicScope, null, new AbortController().signal), /reversion_/);
  await assert.rejects(h.runtime.aggregateExplanations.read(h.originalPublication.snapshotId), /reversion_/);
  h.setTime(7);
  await assert.rejects(h.publish(), /reversion_/);
  await assert.rejects(
    h.runtime.applyCorrection({
      requestId: op.requestId,
      expectedVersion: 1,
      factId: h.original.id,
      operatorId: "201",
      approvalReceipt: "synthetic-correction-approval",
    }),
    /reversion_/,
  );
  await h.db.query("UPDATE leaderboard_pipeline.corrections SET document=$2::jsonb WHERE request_id=$1", [
    op.requestId,
    JSON.stringify(row.document),
  ]);
  await h.db.query(
    "UPDATE leaderboard_pipeline.receipts SET document_hash=$1 WHERE receipt_id=(SELECT receipt_id FROM leaderboard_pipeline.receipts WHERE kind='correction_applied' LIMIT 1)",
    [reversionHash("not-the-seal")],
  );
  await assert.rejects(
    h.runtime.source.read(publicScope, null, new AbortController().signal),
    /reversion_unsealed_correction/,
  );
});

test("an existing self-consistent but different receipt cannot seal a new reviewed decision", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  const key = "reversion:" + op.requestId + ":1",
    kind = "correction_applied",
    document = { wrong: "synthetic-receipt" };
  await h.db.query(
    "INSERT INTO leaderboard_pipeline.receipts(receipt_id,operation_key,kind,document,document_hash,operation_hash) VALUES($1,$2,$3,$4::jsonb,$5,sha256(convert_to($2,'UTF8')))",
    [reversionHash([key, kind]), key, kind, JSON.stringify(document), reversionHash(document)],
  );
  await assert.rejects(h.invoke(h.runtime, op), /reversion_unsealed_correction/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.corrections")).rows[0].n, 0);
  assert.equal(h.controlsStore.read().requests[op.requestId].status, "pending");
});

test("a reviewed decision committed after normalization is caught by the final locked publication fence", async (t) => {
  const h = await scenario(t),
    op = h.operation(1);
  h.request(op);
  h.setTime(6);
  let armed = false,
    inserted = false;
  const changing = await createPipeline({
    ...h.options,
    db: {
      query: async (sql, params) => {
        const result = await h.db.query(sql, params);
        if (sql.includes("LEFT JOIN leaderboard_pipeline.receipts AS r")) armed = true;
        return result;
      },
      transaction: async (work) => {
        if (armed && !inserted) {
          armed = false;
          inserted = true;
          await h.invoke(h.runtime, op);
        }
        return h.db.transaction(work);
      },
    },
  });
  t.after(() => changing.stop());
  await assert.rejects(h.publish(changing), /reversion_changed_before_publication/);
  assert.equal(inserted, true);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 1);
  assert.equal((await h.board(h.runtime, "pr_lines_changed")).rows.length, 0);
  assert.equal(
    (await h.board(h.runtime, "pr_merged")).rows.reduce((sum, row) => sum + row.result.value, 0),
    2,
  );
});

test("two separately approved restorations cannot branch one predecessor or override a legacy correction", async (t) => {
  const h = await scenario(t),
    inactive = h.operation(1);
  h.request(inactive);
  h.setTime(6);
  await h.invoke(h.runtime, inactive);
  const first = h.operation(2, "active", inactive.requestId),
    other = h.operation(3, "active", inactive.requestId);
  h.request(first);
  h.request(other);
  h.setTime(8);
  const secondRuntime = await createPipeline(h.options);
  t.after(() => secondRuntime.stop());
  const settled = await Promise.allSettled([h.invoke(h.runtime, first), h.invoke(secondRuntime, other)]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.match(String(settled.find((entry) => entry.status === "rejected").reason), /reversion_ambiguous_supersession/);
  assert.equal((await readCorrectionState(h.db, [2])).decisions.length, 2);
  const legacy = fixtureId(7490);
  h.controlsStore.transaction((state) => {
    state.requests[legacy] = {
      id: legacy,
      kind: "correction",
      owner: "101",
      locator: "https://github.com/synthetic-org/synthetic-repo/pull/1",
      status: "pending",
      version: 1,
      history: [],
    };
  });
  await h.runtime.applyCorrection({
    requestId: legacy,
    expectedVersion: 1,
    factId: h.original.id,
    operatorId: "201",
    approvalReceipt: "synthetic-correction-approval",
  });
  const pending = settled[0].status === "rejected" ? first : other;
  await assert.rejects(h.invoke(secondRuntime, pending), /reversion_source_suppressed/);
  const raw = await h.board(h.runtime, "pr_merged", h.originalPublication.snapshotId);
  assert.deepEqual(
    raw.rows.map((row) => row.actorId),
    ["102"],
  );
});

test("a failed private acknowledgment retains the sealed restriction and an exact reopened retry records it once", async (t) => {
  const h = await scenario(t),
    inactive = h.operation(1);
  h.request(inactive);
  h.setTime(6);
  const transaction = h.controlsStore.transaction.bind(h.controlsStore);
  h.controlsStore.transaction = (change, options) =>
    transaction((state) => {
      change(state);
      if (state.requests[inactive.requestId].status === "applied") throw new Error("synthetic_private_ack_failure");
    }, options);
  try {
    await assert.rejects(h.invoke(h.runtime, inactive), /synthetic_private_ack_failure/);
  } finally {
    h.controlsStore.transaction = transaction;
  }
  const before = await readCorrectionState(h.db, [2]);
  assert.equal(before.decisions.length, 1);
  assert.equal(h.controlsStore.read().requests[inactive.requestId].status, "pending");
  assert.equal((await h.board(h.runtime, "pr_lines_changed")).rows.length, 0);
  assert.equal(
    (await h.board(h.runtime, "pr_merged")).rows.reduce((sum, row) => sum + row.result.value, 0),
    2,
  );
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  const first = await h.invoke(reopened, inactive);
  assert.deepEqual(await h.invoke(reopened, inactive), first);
  assert.deepEqual((await readCorrectionState(h.db, [2])).decisions, before.decisions);
  const state = h.controlsStore.read();
  assert.equal(state.requests[inactive.requestId].history.length, 1);
  assert.equal(state.audit.filter((event) => event.receiptId === first.receiptId).length, 1);
  assert.equal((await reopened.receipts()).filter((receipt) => receipt.kind === "correction_applied").length, 1);
  h.controlsStore.transaction((current) => {
    current.requests[inactive.requestId].history[0].decisionHash = "0".repeat(64);
  });
  await assert.rejects(h.invoke(reopened, inactive), /reversion_applied_audit_changed/);
});

test("a restoration cannot override current actor suppression or a changed source generation", async (t) => {
  const h = await scenario(t),
    inactive = h.operation(1);
  h.request(inactive);
  h.setTime(6);
  await h.invoke(h.runtime, inactive);
  const active = h.operation(2, "active", inactive.requestId);
  h.request(active);
  h.setTime(8);
  h.controlsStore.transaction((state) => {
    state.profiles["101"] = { ...(state.profiles["101"] ?? {}), suppressed: true };
  });
  await assert.rejects(h.invoke(h.runtime, active), /reversion_frozen_authority_changed/);
  assert.equal((await h.board(h.runtime, "pr_lines_changed", h.originalPublication.snapshotId)).rows.length, 0);
  h.controlsStore.transaction((state) => {
    state.profiles["101"].suppressed = false;
  });
  await h.db.query("UPDATE leaderboard_ingestion.repository_access SET generation=generation+1 WHERE repository_id=2");
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await assert.rejects(h.invoke(reopened, active), /reversion_frozen_authority_changed/);
  assert.equal((await readCorrectionState(h.db, [2])).decisions.length, 1);
  assert.equal(h.controlsStore.read().requests[active.requestId].status, "pending");
  assert.equal((await h.board(reopened, "pr_lines_changed", h.originalPublication.snapshotId)).rows.length, 0);
});
