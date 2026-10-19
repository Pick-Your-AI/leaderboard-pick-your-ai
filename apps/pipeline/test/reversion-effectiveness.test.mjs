import assert from "node:assert/strict";
import test from "node:test";
import {
  reversionAuthorityVersion,
  reversionHash,
  prepareReversionDecision,
  recordReversionDecision,
  reversionOperationKey,
  reversionReceiptDocument,
  classifyCorrectionRows,
  materializeReversionEffectiveness,
  reversionAuthority,
  reversionProjection,
} from "../src/reversion-effectiveness.mjs";

const at = (minute) => "2026-01-01T00:" + String(minute).padStart(2, "0") + ":00.000Z";
const originalSha = "a".repeat(40),
  revertingSha = "b".repeat(40);
function fixture() {
  const raw = {
    id: "merge:original",
    canonicalKey: "unit:original",
    metricId: "pr_merged",
    actorId: "101",
    artifactId: "PR_ORIGINAL",
    repoId: "2",
    role: "author",
    state: "observed",
    occurredAt: at(1),
    acceptedAt: null,
    observedAt: at(2),
    revision: 0,
    correctionReceipt: null,
    acceptanceReceipt: null,
    acceptedBy: null,
    subjectActorId: "101",
    currentContext: { projects: [], workstreams: [] },
    eventContext: null,
    rawState: "target:main",
  };
  const reverting = {
    ...structuredClone(raw),
    id: "merge:reverting",
    canonicalKey: "unit:reverting",
    actorId: "102",
    subjectActorId: "102",
    artifactId: "PR_REVERT",
    occurredAt: at(2),
  };
  const qualified = {
    ...structuredClone(raw),
    id: "qualified:original",
    canonicalKey: "qualified-unit:original",
    metricId: "reviewed_delivery",
    state: "qualified",
    acceptedAt: at(2),
    acceptedBy: "202",
    acceptanceReceipt: "recognition:1",
    quantity: 1,
  };
  const proof = (fact, revision, number) => ({
    artifact: {
      kind: "pull_request",
      stableId: fact.artifactId,
      repositoryId: "2",
      visibility: "public",
      publicUrl: "https://github.com/synthetic-org/synthetic-repo/pull/" + number,
    },
    contribution: {
      contributionId: fact.id,
      actorId: fact.actorId,
      artifactId: fact.artifactId,
      qualification: "eligible",
      metricIds: [fact.metricId],
    },
    sourceRevision: revision,
    sourceRevisionUrl: "https://github.com/synthetic-org/synthetic-repo/commit/" + revision,
  });
  return {
    operation: {
      requestId: "request:1",
      expectedVersion: 1,
      snapshotId: "snapshot:1",
      originalFactId: raw.id,
      revertingFactId: reverting.id,
      targetFactIds: [qualified.id],
      effect: "inactive",
      supersedes: null,
      effectiveAt: at(3),
      reviewedAt: at(4),
      operatorId: "201",
      approvalReceipt: "approval:1",
      publicReceiptUrl: "https://github.com/synthetic-org/synthetic-repo/issues/74#issuecomment-1",
    },
    input: {
      snapshotId: "snapshot:1",
      cutoff: at(3),
      facts: [raw, reverting, qualified],
      evidence: [proof(raw, originalSha, 1), proof(reverting, revertingSha, 2), proof(qualified, originalSha, 1)],
      policies: [
        {
          signature: "synthetic reviewed-delivery policy",
          policy: {
            metricId: "reviewed_delivery",
            version: "synthetic-v1",
            rankedStates: ["qualified"],
            aggregation: "count",
          },
        },
      ],
    },
    binding: {
      configurationHash: "c".repeat(64),
      sourceGeneration: "1",
      dataMode: "synthetic",
      lineageEvidenceIds: [raw.id, reverting.id],
    },
  };
}
const prepare = (value = fixture()) => prepareReversionDecision(value);
const decision = (value = fixture(), recordedAt = at(5)) => recordReversionDecision(prepare(value), recordedAt);
function row(document = decision()) {
  const receiptDocument = reversionReceiptDocument(document);
  return {
    request_id: document.operation.requestId,
    fact_id: document.operation.originalFactId,
    artifact_id: document.source.original.artifactId,
    repository_id: 2,
    document,
    receipt: {
      operation_key: reversionOperationKey(document),
      kind: "correction_applied",
      document: receiptDocument,
      document_hash: reversionHash(receiptDocument),
    },
  };
}
function restoration() {
  const value = fixture();
  Object.assign(value.operation, {
    requestId: "request:2",
    expectedVersion: 2,
    effect: "active",
    supersedes: "request:1",
    effectiveAt: at(6),
    reviewedAt: at(7),
    approvalReceipt: "approval:2",
    publicReceiptUrl: "https://github.com/synthetic-org/synthetic-repo/issues/74#issuecomment-2",
  });
  return decision(value, at(8));
}

function coauthorFixture() {
  const value = fixture();
  for (const [actorId, suffix] of [
    ["103", "coauthor"],
    ["104", "unselected"],
  ]) {
    const selected = {
      ...structuredClone(value.input.facts[2]),
      id: "qualified:" + suffix,
      canonicalKey: "qualified-unit:" + suffix,
      actorId,
      subjectActorId: actorId,
      role: "coauthor",
    };
    const proof = structuredClone(value.input.evidence[2]);
    Object.assign(proof.contribution, { contributionId: selected.id, actorId });
    value.input.facts.push(selected);
    value.input.evidence.push(proof);
  }
  value.operation.targetFactIds.push("qualified:coauthor");
  return value;
}

test("independently qualified author and coauthor units share reviewed reversion and restoration without changing unselected units", () => {
  const value = coauthorFixture(),
    before = structuredClone(value.input.facts);
  const inactive = decision(value);
  const activeValue = structuredClone(value);
  Object.assign(activeValue.operation, restoration().operation, { targetFactIds: value.operation.targetFactIds });
  const active = decision(activeValue, at(8));
  const excluded = materializeReversionEffectiveness(value.input, [inactive], at(5));
  assert.deepEqual(excluded.overlays.map((fact) => [fact.id, fact.actorId, fact.state]).sort(), [
    ["qualified:coauthor", "103", "excluded"],
    ["qualified:original", "101", "excluded"],
  ]);
  const restored = materializeReversionEffectiveness(value.input, [inactive, active], at(8));
  for (const id of value.operation.targetFactIds) {
    assert.deepEqual(
      restored.overlays.filter((fact) => fact.id === id).map((fact) => [fact.state, fact.revision]),
      [
        ["excluded", 1],
        ["qualified", 2],
      ],
    );
  }
  assert.equal(
    restored.overlays.some((fact) => fact.id === "qualified:unselected"),
    false,
  );
  assert.deepEqual(restored.facts.slice(0, before.length), before);
  assert.equal(restored.facts.filter((fact) => fact.metricId === "pr_merged").length, 2);
  assert.equal(restored.facts.filter((fact) => fact.actorId === "102").length, 1);
  assert.ok(restored.overlays.every((fact) => fact.quantity >= 0));
  assert.deepEqual(value.input.facts, before);
});

test("coauthor selection retains exact proof, artifact and independent acceptance and operator boundaries", () => {
  for (const change of [
    (value) => {
      value.input.evidence[3].contribution.actorId = "999";
    },
    (value) => {
      value.input.facts[3].artifactId = "PR_OTHER";
      value.input.evidence[3].artifact.stableId = "PR_OTHER";
      value.input.evidence[3].contribution.artifactId = "PR_OTHER";
    },
    (value) => {
      value.input.facts[3].acceptedBy = "103";
    },
    (value) => {
      value.operation.operatorId = "103";
    },
    (value) => {
      value.input.evidence[3].sourceRevision = "d".repeat(40);
    },
  ]) {
    const value = coauthorFixture();
    change(value);
    assert.throws(() => prepare(value), /reversion_/);
  }
});

test("review candidate binds immutable source pins, exact qualified units and input without mutation", () => {
  const value = fixture(),
    before = structuredClone(value);
  const candidate = prepare(value);
  assert.equal(candidate.kind, reversionAuthorityVersion);
  assert.equal(candidate.source.original.sourceRevision, originalSha);
  assert.deepEqual(candidate.operation.targetFactIds, ["qualified:original"]);
  assert.equal(candidate.targets[0].semanticHash.length, 64);
  assert.equal(candidate.targets[0].policyHash.length, 64);
  assert.deepEqual(value, before);
  assert.throws(() => {
    candidate.operation.effect = "active";
  }, TypeError);
});

test("unknown, non-merged and mutable source claims cannot become reviewed lineage", () => {
  for (const change of [
    (value) => {
      value.input.facts[1].state = "unknown";
    },
    (value) => {
      value.input.facts[1].metricId = "pr_opened";
    },
    (value) => {
      value.input.facts[1].occurredAt = null;
    },
    (value) => {
      value.input.evidence[1].sourceRevision = at(2);
    },
    (value) => {
      value.input.evidence[1].sourceRevisionUrl = value.input.evidence[1].artifact.publicUrl;
    },
    (value) => {
      value.input.evidence[1].artifact.visibility = "private";
    },
    (value) => {
      value.binding.lineageEvidenceIds = ["merge:original"];
    },
    (value) => {
      value.binding.lineageEvidenceIds.push("unobserved:lineage");
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => prepare(value), /reversion_/);
  }
});

test("review authority stays independent from original and reverting contributors and exact policy", () => {
  for (const change of [
    (value) => {
      value.operation.operatorId = "101";
    },
    (value) => {
      value.operation.operatorId = "102";
    },
    (value) => {
      value.input.facts[2].acceptedBy = "101";
    },
    (value) => {
      value.input.policies[0].policy.rankedStates = ["observed"];
    },
    (value) => {
      value.input.facts[2].state = "observed";
    },
    (value) => {
      value.input.facts[2].quantity = -1;
    },
    (value) => {
      value.input.evidence[2].sourceRevision = "d".repeat(40);
    },
    (value) => {
      value.input.facts[2].artifactId = "PR_OTHER";
    },
    (value) => {
      value.operation.targetFactIds.push("merge:original");
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => prepare(value), /reversion_/);
  }
});

test("event, captured source, review and recording clocks stay distinct and exact", () => {
  for (const change of [
    (value) => {
      value.input.facts[1].occurredAt = at(4);
    },
    (value) => {
      value.input.facts[1].observedAt = at(1);
    },
    (value) => {
      value.operation.effectiveAt = at(1);
    },
    (value) => {
      value.operation.reviewedAt = at(2);
    },
    (value) => {
      value.operation.reviewedAt = "2026-01-01T00:04:00.000001Z";
    },
    (value) => {
      value.input.facts[2].acceptedAt = at(4);
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => prepare(value), /reversion_/);
  }
  assert.throws(() => recordReversionDecision(prepare(), at(3)), /recording_precedes_review/);
  const record = decision();
  assert.deepEqual(materializeReversionEffectiveness(fixture().input, [record], at(4)).overlays, []);
  assert.equal(materializeReversionEffectiveness(fixture().input, [record], at(5)).overlays.length, 1);
});

test("effective reversion removes only the named qualified unit and never changes raw merge or credits its reverter", () => {
  const value = fixture(),
    before = structuredClone(value.input.facts);
  const result = materializeReversionEffectiveness(value.input, [decision(value)], at(5));
  assert.deepEqual(result.facts.slice(0, 3), before);
  assert.deepEqual(
    result.overlays.map((fact) => [fact.id, fact.state, fact.revision, fact.actorId, fact.quantity]),
    [["qualified:original", "excluded", 1, "101", 1]],
  );
  assert.equal(result.facts.filter((fact) => fact.metricId === "pr_merged").length, 2);
  assert.equal(result.facts.filter((fact) => fact.actorId === "102").length, 1);
  assert.deepEqual(value.input.facts, before);
});

test("explicit restoration preserves history and needs the exact unbranched reviewed chain", () => {
  const inactive = decision(),
    active = restoration(),
    input = fixture().input;
  const result = materializeReversionEffectiveness(input, [active, inactive], at(8));
  assert.deepEqual(
    result.overlays.map((fact) => [fact.state, fact.revision]),
    [
      ["excluded", 1],
      ["qualified", 2],
    ],
  );
  assert.deepEqual(
    materializeReversionEffectiveness(input, [active, inactive], at(7)).overlays.map((fact) => fact.state),
    ["excluded"],
  );
  assert.throws(() => reversionAuthority([active], at(8)), /ambiguous_supersession/);
  const alternate = fixture();
  alternate.operation.requestId = "request:other";
  assert.throws(() => reversionAuthority([inactive, decision(alternate)], at(8)), /ambiguous_target_roots/);
  const branch = fixture();
  Object.assign(branch.operation, active.operation, { requestId: "request:branch" });
  assert.throws(() => reversionAuthority([inactive, active, decision(branch, at(8))], at(8)), /ambiguous_supersession/);
});

test("classification preserves opaque legacy suppression and requires an exact independent receipt seal", () => {
  const legacy = { request_id: "legacy:1", artifact_id: "PR_PRIVATE", document: { fact: { id: "legacy:fact" } } };
  const result = classifyCorrectionRows([row(), legacy, row()]);
  assert.equal(result.decisions.length, 1);
  assert.deepEqual(result.legacy, [legacy]);
  for (const change of [
    (value) => {
      delete value.receipt;
    },
    (value) => {
      value.receipt.operation_key = "correction:request:1:1";
    },
    (value) => {
      value.receipt.kind = "snapshot_published";
    },
    (value) => {
      value.receipt.document.operatorId = "999";
      value.receipt.document_hash = reversionHash(value.receipt.document);
    },
    (value) => {
      value.receipt.document_hash = "0".repeat(64);
    },
    (value) => {
      value.artifact_id = "OTHER";
    },
    (value) => {
      value.document.kind = "pipeline-reversion-effectiveness/v999";
    },
    (value) => {
      value.document.decisionHash = "0".repeat(64);
    },
    (value) => {
      value.document.extra = "not admitted";
    },
  ]) {
    const value = structuredClone(row());
    change(value);
    assert.throws(() => classifyCorrectionRows([value]), /reversion_/);
  }
});

test("different content under one request ID is rejected despite each record having its own valid seal", () => {
  const changed = fixture();
  changed.operation.approvalReceipt = "different:approval";
  assert.throws(() => classifyCorrectionRows([row(), row(decision(changed))]), /retry_mismatch/);
});

test("restoration authority binds every sealed predecessor even when the active decision is unchanged", () => {
  const inactive = decision(),
    active = restoration();
  const changed = fixture();
  changed.operation.approvalReceipt = "different:ancestor-approval";
  const alternate = decision(changed, at(6));
  const originalChain = classifyCorrectionRows([row(inactive), row(active)]).decisions;
  const alternateChain = classifyCorrectionRows([row(alternate), row(active)]).decisions;
  const originalAuthority = reversionAuthority(originalChain, at(8));
  assert.notDeepEqual(reversionAuthority(alternateChain, at(8)), originalAuthority);
  assert.deepEqual(reversionProjection(alternateChain, originalAuthority, at(8)).suppressedContributionIds, [
    "qualified:original",
  ]);
  assert.deepEqual(
    reversionProjection(alternateChain, reversionAuthority(alternateChain, at(8)), at(8)).suppressedContributionIds,
    [],
  );
});

test("changed source, qualified acceptance or configured policy cannot inherit earlier review", () => {
  const record = decision();
  for (const change of [
    (input) => {
      input.facts[2].acceptanceReceipt = "new:acceptance";
    },
    (input) => {
      input.facts[2].quantity = 2;
    },
    (input) => {
      input.facts[2].observedAt = at(9);
    },
    (input) => {
      input.facts[1].observedAt = at(9);
    },
    (input) => {
      input.facts[1].occurredAt = at(1);
    },
    (input) => {
      input.evidence[1].sourceRevision = "d".repeat(40);
    },
    (input) => {
      input.policies[0].signature = "different policy";
    },
  ]) {
    const input = fixture().input;
    change(input);
    assert.throws(() => materializeReversionEffectiveness(input, [record], at(8)), /reversion_/);
  }
});

test("recollection and current membership changes preserve the reviewed unit and use current contexts", () => {
  const input = fixture().input;
  input.facts.forEach((fact) => {
    fact.observedAt = at(7);
  });
  input.facts[2].currentContext = { projects: ["project:current"], workstreams: ["work:current"] };
  const result = materializeReversionEffectiveness(input, [decision()], at(8));
  assert.deepEqual(result.overlays[0].currentContext, input.facts[2].currentContext);
  assert.equal(result.overlays[0].observedAt, at(5));
  assert.equal(result.overlays[0].state, "excluded");
});

test("current and pinned proof controls retain raw artifacts and require rebuilt restoration authority", () => {
  const inactive = decision(),
    active = restoration();
  const before = reversionProjection([inactive], undefined, at(4));
  assert.deepEqual(before.suppressedContributionIds, []);
  const revoked = reversionProjection([inactive], undefined, at(5));
  assert.deepEqual(revoked.suppressedContributionIds, ["qualified:original"]);
  assert.deepEqual(revoked.notices, [
    {
      artifactId: "PR_ORIGINAL",
      kind: "correction",
      occurredAt: at(5),
      publicUrl: "https://github.com/synthetic-org/synthetic-repo/issues/74#issuecomment-1",
    },
  ]);
  const restoredAuthority = reversionAuthority([active, inactive], at(8));
  assert.deepEqual(reversionProjection([active, inactive], revoked.authority, at(8)).suppressedContributionIds, [
    "qualified:original",
  ]);
  assert.deepEqual(reversionProjection([active, inactive], restoredAuthority, at(8)).suppressedContributionIds, []);
  assert.equal(JSON.stringify(revoked.notices).includes("operatorId"), false);
  assert.equal(JSON.stringify(revoked.notices).includes("approval:"), false);
});

test("malformed identity, extra operation fields and unsafe receipts are rejected before authority exists", () => {
  for (const change of [
    (value) => {
      value.operation.requestId += "\n";
    },
    (value) => {
      value.operation.authorized = true;
    },
    (value) => {
      value.operation.publicReceiptUrl = "https://github.com/synthetic-org/synthetic-repo/issues/74?private=x";
    },
    (value) => {
      value.operation.publicReceiptUrl = "https://example.org/review";
    },
    (value) => {
      value.operation.expectedVersion = 1.5;
    },
    (value) => {
      value.binding.sourceGeneration = "01";
    },
    (value) => {
      value.binding.configurationHash = "c".repeat(63);
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => prepare(value), /reversion_/);
  }
});
