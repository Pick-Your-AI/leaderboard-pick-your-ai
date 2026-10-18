import assert from "node:assert/strict";
import test from "node:test";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";

const decision = {
  id: "receipt",
  action: "accepted",
  actor: "202",
  at: Date.parse("2026-10-01T00:00:00.000Z"),
  policyVersion: "v1",
};
const request = {
  id: "claim",
  kind: "evidence",
  status: "accepted",
  owner: "101",
  category: "finding",
  scope: "repo",
  policyVersion: "v1",
  locator: "https://github.com/org/repo/issues/1",
  collaborators: {},
  history: [decision],
};
const state = () => ({
  requests: { claim: structuredClone(request) },
  profiles: {},
  audit: [structuredClone(decision)],
});
const binding = {
  category: "finding",
  scope: "repo",
  policyVersion: "v1",
  metricId: "accepted_findings",
  sourceMetricId: "issues_opened",
  repositoryId: "2",
  reviewerIds: ["202"],
};
const input = {
  facts: [{ id: "fact", actorId: "101", repoId: "2", metricId: "issues_opened" }],
  actors: [],
  evidence: [
    { contribution: { contributionId: "fact" }, artifact: { publicUrl: request.locator, visibility: "public" } },
  ],
};
const policies = [{ policy: { metricId: binding.metricId, version: "v1", dateBasis: "acceptedAt" } }];
const apply = (s) =>
  materializeRecognition(
    input,
    s,
    [binding],
    policies,
    (raw, receipt) => ({ ...raw, receipt }),
    "2026-10-18T00:00:00.000Z",
  );
test("private audited decision binds exact owner, source metric, scope and approved policy", () => {
  assert.equal(apply(state()).receipt.targetFactId, "fact");
  assert.equal(apply(state()).receipt.acceptedAt, "2026-10-01T00:00:00.000Z");
  const invalid = state();
  invalid.audit = [];
  assert.throws(() => apply(invalid), /unverified/);
  invalid.audit = [decision];
  invalid.requests.claim.collaborators["202"] = "accepted";
  assert.throws(() => apply(invalid), /unverified/);
});
test("withdrawal, appeal, suppression and policy mismatch remove receipt without changing raw facts", () => {
  for (const status of ["withdrawn", "appealed", "pending", "rejected"]) {
    const s = state();
    s.requests.claim.status = status;
    assert.equal(apply(s).receipt, undefined);
    assert.notEqual(recognitionFingerprint(s), recognitionFingerprint(state()));
  }
  const s = state();
  s.profiles["101"] = { suppressed: true };
  assert.equal(apply(s).receipt, undefined);
  s.profiles = {};
  s.requests.claim.policyVersion = "v2";
  assert.equal(apply(s).receipt, undefined);
  assert.equal(input.facts.length, 1);
});
test("audit withdrawal, replacement and ambiguity fence recognition while unrelated audit activity does not", () => {
  const original = recognitionFingerprint(state());
  for (const mutate of [
    (s) => {
      s.audit = [];
    },
    (s) => {
      s.audit[0].actor = "303";
    },
    (s) => {
      s.audit.push(structuredClone(s.audit[0]));
    },
  ]) {
    const s = state();
    mutate(s);
    assert.notEqual(recognitionFingerprint(s), original);
    assert.throws(() => apply(s), /recognition_decision_unverified/);
  }
  const s = state();
  s.audit.push({ id: "unrelated", action: "login", actor: "303" });
  assert.equal(recognitionFingerprint(s), original);
  assert.equal(apply(s).receipt.targetFactId, "fact");
});
