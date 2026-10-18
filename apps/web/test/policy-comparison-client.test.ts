import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkedPolicyInputs,
  checkedPolicyPreview,
  readCandidatePolicy,
  comparePolicy,
  rereadPolicy,
} from "../src/controls/policy-comparison-client.ts";
import { control, type Session } from "../src/controls/client.ts";

async function example(auditFixture = false) {
  const { privatePolicyFixture, privatePolicyAuditFixture } = await import(
    new URL("../../../tests/fixtures/private-policy-preview.mjs", import.meta.url).href
  );
  const { ControlStore } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
  const { PolicyComparisonStore } = await import(
    new URL("../../controls/src/policy-comparison.mjs", import.meta.url).href
  );
  const metrics = await import(new URL("../../../packages/metrics/dist/index.js", import.meta.url).href);
  const directory = mkdtempSync(join(tmpdir(), "synthetic-preview-client-"));
  const store = new ControlStore(join(directory, "controls.sqlite"));
  const comparisons = new PolicyComparisonStore(store, metrics);
  const fixture = auditFixture ? privatePolicyAuditFixture() : privatePolicyFixture();
  fixture.policies[0].unit = metrics.getMetricDefinition("issues_opened").definition.unit;
  const retained = store.transaction((state: unknown) => comparisons.capture(state, fixture));
  const record = comparisons.input(retained.inputId);
  const input = checkedPolicyInputs({ status: "candidate_preview", inputs: [comparisons.metadata(record)] })[0]!;
  const candidate = { ...fixture.policies[0], version: "synthetic-preview/v2", groupBy: "canonical" };
  const saved = store.transaction(() => comparisons.compare(record, candidate));
  const result = comparisons.redact(saved, record, store.read(), []);
  return {
    store,
    comparisons,
    record,
    saved,
    input,
    candidate,
    result,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("private preview client validates actual persisted engine results and current privacy projections", async () => {
  const e = await example();
  try {
    const value = checkedPolicyPreview(e.result, e.input, e.candidate);
    assert.equal(value.changes.length, 1);
    assert.equal(value.changes[0]!.beforeValue, 1);
    assert.equal(value.changes[0]!.afterValue, 2);
    assert.equal(readCandidatePolicy(JSON.stringify(e.candidate), e.input).metricId, "issues_opened");
    e.store.transaction((s: any) => {
      s.profiles["101"] = { suppressed: true };
    });
    const redacted = checkedPolicyPreview(
      e.comparisons.redact(e.saved, e.record, e.store.read(), []),
      e.input,
      e.candidate,
    );
    assert.equal(redacted.redactionsApplied, true);
    assert.deepEqual(redacted.changes, []);
    assert.deepEqual(redacted.before.rows, []);
    assert.throws(() =>
      checkedPolicyInputs({
        status: "candidate_preview",
        inputs: [{ ...e.input, schemaVersion: "private-policy-preview/v1", expiresAt: "2020-01-01T00:00:00Z" }],
      }),
    );
    for (const patch of [
      { inputId: "f".repeat(64) },
      { publicEnabled: true },
      { activationSupported: true },
      { inputHash: "f".repeat(64) },
      { snapshot: { snapshotId: "other", revision: 1 } },
      { candidatePolicy: { ...e.candidate, rank: false } },
    ])
      assert.throws(() => checkedPolicyPreview({ ...e.result, ...patch }, e.input, e.candidate));
    assert.throws(() => checkedPolicyPreview({ ...e.result, redactionsApplied: true }, e.input));
    assert.throws(() => checkedPolicyPreview(e.result, { ...e.input, expiresAt: "2020-01-01T00:00:00Z" }));
    assert.throws(() => readCandidatePolicy(JSON.stringify({ metricId: "unknown", version: "v1" }), e.input));
    assert.throws(() => readCandidatePolicy(" ".repeat(8193), e.input));
  } finally {
    e.close();
  }
});
test("comparison routes retain same-origin CSRF and reject public, activation and mismatched saved-result paths", async () => {
  const e = await example(),
    old = globalThis.fetch;
  const seen: Array<{ path: unknown; init?: RequestInit }> = [];
  const session: Session = { actorId: "201", csrf: "b".repeat(43), roles: ["reviewer"], expires: Date.now() + 60000 };
  globalThis.fetch = async (path, init) => {
    seen.push({ path, ...(init ? { init } : {}) });
    return Response.json(e.result);
  };
  try {
    await comparePolicy(e.input, e.candidate, session);
    assert.equal(seen[0]!.path, "/controls/policy-comparisons");
    assert.equal(seen[0]!.init!.credentials, "same-origin");
    assert.equal(seen[0]!.init!.redirect, "error");
    assert.equal(new Headers(seen[0]!.init!.headers).get("x-csrf-token"), session.csrf);
    assert.deepEqual(JSON.parse(String(seen[0]!.init!.body)), {
      inputId: e.input.inputId,
      candidatePolicy: e.candidate,
    });
    await rereadPolicy(e.input, e.result.comparisonId);
    assert.equal(seen[1]!.init!.method, "GET");
    assert.equal(new Headers(seen[1]!.init!.headers).get("x-csrf-token"), null);
    for (const path of [
      "/controls/policy-comparisons/activate",
      "/controls/policy-comparisons/../public",
      "/controls/policy-comparisons?public=true",
      "/controls/policy-comparisons/" + "a".repeat(63),
    ])
      await assert.rejects(() => control(path));
    await assert.rejects(() => rereadPolicy(e.input, "f".repeat(64)));
  } finally {
    globalThis.fetch = old;
    e.close();
  }
});

test("audit inspection retains actual grouped, corrected, unreviewed and unresolved engine entries", async () => {
  const e = await example(true);
  try {
    const original = JSON.stringify(e.result);
    const value = checkedPolicyPreview(e.result, e.input, e.candidate);
    assert.equal(value.before.audit.length, 61);
    assert.equal(value.before.audit.filter((entry) => entry.reason === "included_count_observed").length, 28);
    assert.equal(value.before.audit.filter((entry) => entry.reason === "repeated_policy_unit").length, 28);
    assert.equal(value.before.audit.find((entry) => entry.factIds.length === 40)?.reason, "repeated_policy_unit");
    assert.equal(value.after.audit.length, 100);
    assert.equal(value.after.audit.filter((entry) => entry.reason === "included_count_observed").length, 95);
    assert.deepEqual(
      value.after.audit
        .filter((entry) => entry.reason !== "included_count_observed")
        .map((entry) => entry.reason)
        .sort(),
      [
        "conflicting_revision",
        "excluded_by_policy_or_correction",
        "missing_independent_acceptance",
        "unknown_actor",
        "unreviewed_revision",
      ],
    );
    assert.equal(value.before.audit.find((entry) => entry.reason === "unknown_actor")?.actorId, null);
    assert.equal(JSON.stringify(e.result), original);
    e.store.transaction((s: any) => {
      s.profiles["101"] = { suppressed: true };
    });
    const redacted = checkedPolicyPreview(
      e.comparisons.redact(e.saved, e.record, e.store.read(), []),
      e.input,
      e.candidate,
    );
    assert.deepEqual(redacted.before.audit, []);
    assert.deepEqual(redacted.after.audit, []);
    assert.equal(redacted.redactionsApplied, true);
    assert.ok(!JSON.stringify(redacted).includes("synthetic-audit-"));
  } finally {
    e.close();
  }
});

test("audit parser rejects malformed identities, ambiguous fields and payloads beyond the frozen input budget", async () => {
  const e = await example();
  try {
    const entry = e.result.before.audit[0];
    const invalid = [
      undefined,
      null,
      {},
      [null],
      [{ ...entry, actorId: true }],
      [{ ...entry, actorId: "" }],
      [{ ...entry, factIds: [] }],
      [{ ...entry, factIds: ["same", "same"] }],
      [{ ...entry, factIds: [true] }],
      [{ ...entry, reason: "" }],
      [{ ...entry, reason: "unreviewed correction" }],
      [{ ...entry, reason: "unknown\ncondition" }],
      [{ ...entry, privateSource: "unclassified extra field" }],
      Array.from({ length: 10_001 }, () => entry),
      [
        { ...entry, factIds: Array.from({ length: 5001 }, (_, n) => "first-" + n) },
        { ...entry, factIds: Array.from({ length: 5000 }, (_, n) => "second-" + n) },
      ],
    ];
    for (const side of ["before", "after"] as const)
      for (const audit of invalid)
        assert.throws(
          () => checkedPolicyPreview({ ...e.result, [side]: { ...e.result[side], audit } }, e.input, e.candidate),
          /Invalid private policy comparison response/,
        );
    const future = { actorId: null, factIds: ["synthetic-unknown-condition"], reason: "future_calculation_condition" };
    const value = checkedPolicyPreview(
      { ...e.result, before: { ...e.result.before, audit: [future] } },
      e.input,
      e.candidate,
    );
    assert.deepEqual(value.before.audit, [future]);
  } finally {
    e.close();
  }
});
