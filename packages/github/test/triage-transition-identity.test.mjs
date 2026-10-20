import assert from "node:assert/strict";
import test from "node:test";
import { groupTriageTransitions } from "../dist/index.js";
const policy = { version: "synthetic/identity-v1", intervalSeconds: 300, cooldownSeconds: 3600 };
const event = {
  id: "synthetic-triage-event",
  artifactId: "issue:1",
  actorId: "404",
  facet: "label",
  targetId: "label:bug",
  occurredAt: "2026-10-07T10:00:00Z",
  before: "absent",
  after: "present",
};
const reordered = Object.fromEntries(Object.entries(event).reverse());
test("equal triage receipts deduplicate after JSON object-member reordering", () => {
  const grouped = groupTriageTransitions([event, reordered], policy);
  assert.equal(grouped.rawActions, 1);
  assert.equal(grouped.sessions.length, 1);
  assert.deepEqual(grouped.sessions[0].eventIds, [event.id]);
  assert.equal(grouped.qualifiedOutcomes, 0);
  assert.deepEqual(grouped, groupTriageTransitions([event], policy));
});
test("equal reordered triage receipts are independent of receipt order", () => {
  assert.deepEqual(groupTriageTransitions([reordered, event], policy), groupTriageTransitions([event], policy));
});
test("exact duplicate triage receipts keep their existing single raw action", () => {
  assert.deepEqual(groupTriageTransitions([event, { ...event }], policy), groupTriageTransitions([event], policy));
});
test("real triage source conflicts remain rejected", async (t) => {
  for (const [field, value] of Object.entries({
    artifactId: "issue:2",
    actorId: "405",
    facet: "milestone",
    targetId: "label:other",
    occurredAt: "2026-10-07T10:00:01Z",
    before: "present",
    after: "absent",
  })) {
    await t.test(field, () =>
      assert.throws(
        () => groupTriageTransitions([event, { ...reordered, [field]: value }], policy),
        /Conflicting triage source identity/,
      ),
    );
  }
});

test("triage duplicate identity retains all projected record values", () => {
  const detailed = { ...event, detail: { kind: "synthetic", values: ["a", "b"] } };
  const same = { ...reordered, detail: { values: ["a", "b"], kind: "synthetic" } };
  assert.deepEqual(groupTriageTransitions([detailed, same], policy), groupTriageTransitions([detailed], policy));
  for (const detail of [
    { values: ["b", "a"], kind: "synthetic" },
    { values: ["a", "b"], kind: "changed" },
    { values: ["a", "b"], kind: "synthetic", present: null },
  ]) {
    assert.throws(
      () => groupTriageTransitions([detailed, { ...same, detail }], policy),
      /Conflicting triage source identity/,
    );
  }
});
test("triage duplicates preserve JSON omission while keeping null members significant", () => {
  assert.deepEqual(
    groupTriageTransitions([event, { ...reordered, omitted: undefined }], policy),
    groupTriageTransitions([event], policy),
  );
  assert.throws(
    () => groupTriageTransitions([event, { ...reordered, omitted: null }], policy),
    /Conflicting triage source identity/,
  );
});
test("unserializable duplicate triage records retain their serialization errors", () => {
  const circular = { ...event };
  circular.circular = circular;
  assert.throws(() => groupTriageTransitions([event, circular], policy), TypeError);
  assert.throws(() => groupTriageTransitions([event, { ...reordered, unsupported: 1n }], policy), TypeError);
});
