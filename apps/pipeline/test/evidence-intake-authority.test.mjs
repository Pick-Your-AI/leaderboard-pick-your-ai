// Fictional claim, consent and source-review records only. These tests do not
// assert actual participant consent or permission to enable a public source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const decision = {
  id: "synthetic-intake-review",
  actor: "202",
  action: "accepted",
  at: Date.parse("2026-10-01T00:00:00.000Z"),
  version: 2,
  policyVersion: "synthetic-intake-metric-v1",
};
// Retain the actual pre-intake shape, including an explicit empty participant
// map. No fixture helper backfills this migration-negative record.
const legacyRequest = {
  id: "synthetic-intake-claim",
  kind: "evidence",
  owner: "101",
  status: "accepted",
  version: 2,
  category: "finding",
  scope: "repository:2",
  locator: "https://github.com/synthetic-org/synthetic-repo/issues/1",
  policyVersion: decision.policyVersion,
  collaborators: {},
  history: [decision],
};
const legacyState = () => ({
  requests: { [legacyRequest.id]: structuredClone(legacyRequest) },
  profiles: {},
  audit: [structuredClone(decision)],
});
const binding = {
  category: legacyRequest.category,
  scope: legacyRequest.scope,
  policyVersion: decision.policyVersion,
  metricId: "accepted_findings",
  sourceMetricId: "issues_opened",
  repositoryId: "2",
  reviewerIds: ["202"],
};

// Exact ac7ace1 authority format, independently preserved. In particular, its
// consent fence was absent for an explicit empty collaborator set. Do not add
// the new intake marker here or delegate this oracle to the current function.
function beforeIntakeAuthority(state, bindings = []) {
  const requests = Object.values(state.requests ?? {})
    .filter((request) => request.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, profile]) => profile.suppressed)
    .map(([id]) => id)
    .sort();
  const ids = new Set(
    requests.flatMap((request) =>
      (request.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id),
    ),
  );
  const audit = (state.audit ?? [])
    .filter((event) => ids.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (
    requests.some((request) => {
      const collaborators = request.collaborators;
      return (
        collaborators === null ||
        typeof collaborators !== "object" ||
        Array.isArray(collaborators) ||
        !Object.values(collaborators).every((consent) => consent === "accepted") ||
        Object.keys(collaborators).length > 0
      );
    })
  )
    authority.push("required-participant-consent/v1");
  if (bindings.some((entry) => entry.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  if (bindings.some((entry) => entry.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  if (bindings.some((entry) => entry.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  if (bindings.some((entry) => entry.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

// Exact received 8605166 authority format after the independent maintenance and
// automation changes. Keep the earlier ac7 oracle above unchanged so receiving
// those category fences cannot be mistaken for the new intake retirement.
function beforeReceivedIntakeAuthority(state, bindings = []) {
  const requests = Object.values(state.requests ?? {})
    .filter((request) => request.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, profile]) => profile.suppressed)
    .map(([id]) => id)
    .sort();
  const ids = new Set(
    requests.flatMap((request) =>
      (request.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id),
    ),
  );
  const audit = (state.audit ?? [])
    .filter((event) => ids.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (
    requests.some((request) => {
      const collaborators = request.collaborators;
      return (
        collaborators === null ||
        typeof collaborators !== "object" ||
        Array.isArray(collaborators) ||
        !Object.values(collaborators).every((consent) => consent === "accepted") ||
        Object.keys(collaborators).length > 0
      );
    })
  )
    authority.push("required-participant-consent/v1");
  if (bindings.some((entry) => entry.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  if (bindings.some((entry) => entry.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  if (bindings.some((entry) => entry.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  if (bindings.some((entry) => entry.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  if (bindings.some((entry) => entry.metricId === "maintenance")) authority.push("maintenance-merged-participant/v1");
  if (bindings.some((entry) => entry.metricId === "automation")) authority.push("automation-merged-participant/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("manual intake retires exact pre-intake authority for every metric, including legacy owner-only and pending claims", () => {
  for (const status of ["accepted", "pending", "withdrawn"]) {
    const state = legacyState();
    state.requests[legacyRequest.id].status = status;
    const original = structuredClone(state);
    for (const previousAuthority of [beforeIntakeAuthority, beforeReceivedIntakeAuthority]) {
      for (const metric of metricRegistryV1.metrics) {
        const bindings = [{ ...binding, metricId: metric.id }];
        if (metric.id === "helpful_feedback") {
          assert.throws(() => recognitionFingerprint(state, bindings), /invalid_discussion_feedback_contract/);
          continue;
        }
        assert.notEqual(
          recognitionFingerprint(state, bindings),
          previousAuthority(state, bindings),
          `${previousAuthority.name}/${status}/${metric.id}`,
        );
      }
      assert.notEqual(recognitionFingerprint(state), previousAuthority(state), `${status}/no metric bindings`);
    }
    assert.deepEqual(state, original, "recognition authority must not manufacture intake or rewrite legacy audit");
  }
  const current = attachSyntheticEvidenceState(legacyState());
  for (const previousAuthority of [beforeIntakeAuthority, beforeReceivedIntakeAuthority])
    assert.notEqual(recognitionFingerprint(current, [binding]), previousAuthority(current, [binding]));
});

test("zero manual requests preserve unaffected prior authority and independently received category fences", () => {
  const states = [
    { requests: {}, profiles: {}, audit: [] },
    {
      requests: { correction: { id: "correction", kind: "correction", status: "pending" } },
      profiles: { 303: { suppressed: true }, 404: { suppressed: false } },
      audit: [{ id: "unrelated", actor: "202", action: "login", at: decision.at }],
    },
  ];
  for (const state of states) {
    const original = structuredClone(state);
    const all = metricRegistryV1.metrics.map((metric) => ({ ...binding, metricId: metric.id }));
    for (const bindings of [[], ...all.map((entry) => [entry]), all]) {
      // A missing feedback opt-in fails the whole selected configuration,
      // including a mixed list whose earlier entries are valid.
      if (bindings.some((entry) => entry.metricId === "helpful_feedback")) {
        assert.throws(() => recognitionFingerprint(state, bindings), /invalid_discussion_feedback_contract/);
        continue;
      }
      const current = recognitionFingerprint(state, bindings);
      const receivedCategories = [
        "governance",
        "deployment_work",
        "incidents",
        "release_changes",
        "issue_ordering",
        "release_stewardship",
        "performance",
        "regressions_prevented",
      ];
      if (bindings.some((entry) => receivedCategories.includes(entry.metricId)))
        assert.notEqual(current, beforeReceivedIntakeAuthority(state, bindings));
      else assert.equal(current, beforeReceivedIntakeAuthority(state, bindings));
      const earlier = beforeIntakeAuthority(state, bindings);
      if (bindings.some((entry) => ["maintenance", "automation", ...receivedCategories].includes(entry.metricId)))
        assert.notEqual(current, earlier, "the received category fences retain their independent retirement");
      else assert.equal(current, earlier, "unaffected ac7 automatic-source authority stays exact");
    }
    assert.deepEqual(state, original);
  }
});

test("legacy owner-only intake is withheld without changing raw facts or inventing a reviewed receipt", () => {
  const input = {
    facts: [{ id: "synthetic-fact", actorId: "101", repoId: "2", metricId: "issues_opened" }],
    actors: [],
    evidence: [
      {
        contribution: { contributionId: "synthetic-fact" },
        artifact: { publicUrl: legacyRequest.locator, visibility: "public" },
      },
    ],
  };
  let receiptCalls = 0;
  const apply = (state) =>
    materializeRecognition(
      input,
      state,
      [binding],
      [{ policy: { metricId: binding.metricId, version: decision.policyVersion, dateBasis: "acceptedAt" } }],
      (raw, receipt) => {
        receiptCalls++;
        return { ...raw, receipt };
      },
      "2026-10-18T00:00:00.000Z",
    );
  const legacy = legacyState();
  const original = structuredClone(legacy);
  assert.deepEqual(apply(legacy), input);
  assert.equal(receiptCalls, 0);
  assert.deepEqual(legacy, original);
  assert.equal(apply(attachSyntheticEvidenceState(legacyState())).receipt.targetFactId, "synthetic-fact");
  assert.equal(receiptCalls, 1);
});

test("empty ordering destinations use the explicit reviewed-plan generation without changing other bindings", () => {
  const state = { requests: {}, profiles: {}, audit: [] };
  const ordering = { ...binding, metricId: "issue_ordering" };
  for (const bindings of [[ordering], [binding, ordering], [ordering, binding]]) {
    const expected = createHash("sha256")
      .update(JSON.stringify(["localization-review-target/v1", [], [], [], bindings, "reviewed-ordering-plan/v1"]))
      .digest("hex");
    assert.equal(recognitionFingerprint(state, bindings), expected);
    assert.notEqual(expected, beforeReceivedIntakeAuthority(state, bindings));
  }
  assert.equal(recognitionFingerprint(state, [binding]), beforeReceivedIntakeAuthority(state, [binding]));
});
