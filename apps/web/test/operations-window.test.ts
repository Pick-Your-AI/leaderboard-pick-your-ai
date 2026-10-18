import test from "node:test";
import assert from "node:assert/strict";
import {
  replayWindowInput,
  checkedWindowPreview,
  checkedWindowReceipt,
  type WindowPreview,
  type WindowReceipt,
} from "../src/controls/operations-window.ts";

const input = replayWindowInput(9, "policy-1", "2026-10-01T00:00", "2026-10-02T00:00:00.123", 2);
const preview: WindowPreview = {
  window: input,
  sourceGeneration: "2",
  authorityRevision: "grant-1",
  revision: "a".repeat(64),
  deliveries: [
    { deliveryId: "11111111-1111-1111-1111-111111111111", attempts: null, reason: "unknown", revision: "b".repeat(64) },
  ],
  meaning: "Retained synthetic window",
};
const receipt: WindowReceipt = {
  id: "22222222-2222-2222-2222-222222222222",
  window: input,
  sourceGeneration: "2",
  status: "queued",
  receipts: [
    {
      id: "33333333-3333-3333-3333-333333333333",
      deliveryId: preview.deliveries[0]!.deliveryId,
      beforeRevision: "b".repeat(64),
      queuedRevision: "c".repeat(64),
    },
  ],
  beforeRevision: preview.revision,
  queuedRevision: "d".repeat(64),
  resultingPublicationRevision: null,
};
test("receive-time input retains explicit UTC and millisecond boundaries and rejects calendar rollovers", () => {
  assert.equal(input.receivedSince, "2026-10-01T00:00:00.000Z");
  assert.equal(input.receivedUntil, "2026-10-02T00:00:00.123Z");
  assert.equal(
    replayWindowInput(9, "policy-1", "2026-11-01T01:30:00.1", "2026-11-01T02:30", 50).receivedSince,
    "2026-11-01T01:30:00.100Z",
  );
  for (const [since, until, limit] of [
    ["2026-02-30T00:00", "2026-03-02T00:00", 50],
    ["2026-10-01T00:00", "2026-10-01T00:00", 50],
    ["2026-10-01T00:00", "2026-11-01T00:00:00.001", 50],
    ["2026-10-01T00:00Z", "2026-10-02T00:00", 50],
    ["2026-10-01T00:00", "2026-10-02T00:00", 51],
  ] as const)
    assert.throws(() => replayWindowInput(9, "policy-1", since, until, limit));
});
test("preview refuses changed scope, authority, duplicates and overflow without converting unknown attempts", () => {
  assert.equal(checkedWindowPreview(preview, input, "2", "grant-1").deliveries[0]!.attempts, null);
  for (const value of [
    { ...preview, window: { ...input, repositoryId: 8 } },
    { ...preview, window: { ...input, limit: 1 } },
    { ...preview, sourceGeneration: "3" },
    { ...preview, authorityRevision: "grant-2" },
    { ...preview, deliveries: [...preview.deliveries, ...preview.deliveries] },
    { ...preview, deliveries: [{ ...preview.deliveries[0]!, reason: "raw private failure details" }] },
  ])
    assert.throws(() => checkedWindowPreview(value, input, "2", "grant-1"));
});
test("queued receipt must match every reviewed delivery and preserve unavailable publication", () => {
  assert.equal(checkedWindowReceipt(receipt, preview), receipt);
  for (const value of [
    { ...receipt, window: { ...input, policyVersion: "other-policy" } },
    { ...receipt, beforeRevision: "e".repeat(64) },
    { ...receipt, sourceGeneration: "1" },
    { ...receipt, receipts: [] },
    { ...receipt, receipts: [{ ...receipt.receipts[0]!, deliveryId: receipt.id }] },
    { ...receipt, receipts: [{ ...receipt.receipts[0]!, beforeRevision: "e".repeat(64) }] },
  ])
    assert.throws(() => checkedWindowReceipt(value, preview));
});
