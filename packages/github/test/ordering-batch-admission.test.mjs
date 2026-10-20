// Fictional source and receipts exercise the exported asynchronous normalizer.
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubEvidenceNormalizer } from "../dist/index.js";
import {
  orderingSource,
  orderingEnvelope,
  orderingAt,
  orderingState,
  orderingAuthority,
} from "../../../tests/fixtures/ordering.mjs";

function scenario() {
  const source = orderingSource();
  const request = Object.values(orderingState({ source }).requests)[0];
  const review = request.history.at(-1).ordering;
  const target = source.facts.find((fact) => fact.id === review.source.factId);
  const receipt = {
    verified: true,
    id: "fixture-review-early",
    metricId: "issue_ordering",
    actorId: "101",
    reviewerId: "202",
    acceptedAt: orderingAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: [target.id],
    ordering: review,
    orderingAuthority: orderingAuthority(),
  };
  const input = {
    repository: { id: 2, slug: "example-org/example-repo" },
    family: "issues",
    factKey: "fixture",
    observedAt: orderingAt,
    policyVersion: "fixture",
    fact: {
      subjectId: "ORDERING_PLAN_1",
      sourceRevision: "plan-revision-1",
      sourceUrl: review.source.locator,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "open",
    },
  };
  const run = async (receipts) =>
    createGithubEvidenceNormalizer({
      client: {},
      source: "fixture",
      allowedRepositoryIds: [2],
      authorizedReviewerIds: ["202"],
      enrich: async () => orderingEnvelope(),
      acceptance: async () => receipts,
    })(input);
  return { source, receipt, run };
}

const plans = (result) => result.facts.filter((fact) => fact.metricId === "issue_ordering");

test("dense and empty receipt batches retain their existing source behavior", async () => {
  const { source, receipt, run } = scenario();
  assert.deepEqual((await run([])).facts, source.facts);
  const result = await run([receipt]);
  assert.equal(plans(result).length, 1);
  assert.deepEqual(result.facts.slice(0, source.facts.length), source.facts);
});

test("non-array iterables remain invalid receipt batches", async (t) => {
  const { receipt, run } = scenario();
  for (const [name, value] of [
    ["empty Set", new Set()],
    ["Set containing a valid receipt", new Set([receipt])],
    ["empty Map", new Map()],
    ["empty string", ""],
    ["empty typed array", new Uint8Array()],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(run(value), { name: "TypeError", message: "Invalid recognition receipt batch" });
    });
  }
});

test("sparse receipt slots reject like explicit undefined before any normalized result is returned", async (t) => {
  const { receipt, run } = scenario();
  for (const index of [0, 1, 2]) {
    await t.test(`sparse index ${index}`, async () => {
      const receipts = [receipt, receipt, receipt];
      delete receipts[index];
      await assert.rejects(run(receipts), TypeError);
    });
    await t.test(`undefined index ${index}`, async () => {
      const receipts = [receipt, receipt, receipt];
      receipts[index] = undefined;
      await assert.rejects(run(receipts), TypeError);
    });
  }
  await t.test("entirely sparse batch", async () => {
    await assert.rejects(run(new Array(1)), TypeError);
  });
});

test("valid duplicate plans retain earliest acceptance and proof time in either receipt order", async () => {
  const { source, receipt, run } = scenario();
  const later = structuredClone(receipt);
  later.id = "fixture-review-later";
  later.acceptedAt = "2026-10-19T04:00:00.000Z";
  later.ordering.requestId = "another-request";
  for (const receipts of [
    [receipt, later],
    [later, receipt],
  ]) {
    const before = structuredClone(receipts);
    const result = await run(receipts);
    assert.equal(plans(result).length, 1);
    const plan = plans(result)[0];
    assert.equal(plan.acceptedAt, orderingAt);
    assert.equal(plan.acceptanceReceipt, receipt.id);
    assert.equal(result.evidence.at(-1).occurredAt, orderingAt);
    assert.deepEqual(result.facts.slice(0, source.facts.length), source.facts);
    assert.deepEqual(receipts, before);
  }
});

test("equal acceptance instants use a stable receipt identity across supported timestamp spellings", async () => {
  const { receipt, run } = scenario();
  const first = structuredClone(receipt);
  first.id = "a-review";
  first.acceptedAt = "2026-10-19T03:00:00Z";
  const second = structuredClone(receipt);
  second.id = "z-review";
  for (const receipts of [
    [first, second],
    [second, first],
  ]) {
    const result = await run(receipts);
    assert.equal(plans(result).length, 1);
    assert.equal(plans(result)[0].acceptedAt, orderingAt);
    assert.equal(plans(result)[0].acceptanceReceipt, "a-review");
  }
});

test("choosing the earliest plan preserves unrelated receipt positions and validation", async () => {
  const { receipt, run } = scenario();
  const later = structuredClone(receipt);
  later.acceptedAt = "2026-10-19T04:00:00.000Z";
  const answer = { ...structuredClone(receipt), id: "answer", metricId: "issue_answers" };
  delete answer.ordering;
  delete answer.orderingAuthority;
  const result = await run([later, answer, receipt]);
  assert.deepEqual(
    result.facts.slice(-2).map((fact) => [fact.metricId, fact.acceptanceReceipt]),
    [
      ["issue_ordering", receipt.id],
      ["issue_answers", answer.id],
    ],
  );
  assert.equal(plans(result)[0].acceptedAt, orderingAt);
  answer.reviewerId = "UNAUTHORIZED";
  await assert.rejects(run([later, answer, receipt]), /Independent verified recognition/);
});
