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

for (const boundary of ["fact", "actor"] as const)
  for (const state of ["observed", "excluded"] as const)
    for (const length of [200, 201])
      test(`retained ${state} audit preserves exact ${length}-character ${boundary} identity after SQLite reopen`, async () => {
        const { privatePolicyFixture } = await import(
          new URL("../../../tests/fixtures/private-policy-preview.mjs", import.meta.url).href
        );
        const { ControlStore } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
        const { PolicyComparisonStore, comparisonHash } = await import(
          new URL("../../controls/src/policy-comparison.mjs", import.meta.url).href
        );
        const metrics = await import(new URL("../../../packages/metrics/dist/index.js", import.meta.url).href);
        const fixture = privatePolicyFixture();
        const identity = ("synthetic-" + boundary + "-").padEnd(length, "x");
        const actorId = boundary === "actor" ? identity : "101";
        const factId = boundary === "fact" ? identity : "short-fact";
        assert.equal(identity.length, length);
        fixture.input.actors[0].id = actorId;
        fixture.input.facts = [{ ...fixture.input.facts[0], id: factId, actorId, state }];
        fixture.policies[0].unit = metrics.getMetricDefinition("issues_opened").definition.unit;
        const candidate = structuredClone(fixture.policies[0]);
        const directory = mkdtempSync(join(tmpdir(), "synthetic-audit-identity-"));
        const database = join(directory, "controls.sqlite");
        let store = new ControlStore(database);
        try {
          let comparisons = new PolicyComparisonStore(store, metrics);
          const retained = store.transaction((current: unknown) => comparisons.capture(current, fixture));
          assert.equal(retained.state, "retained");
          let record = comparisons.input(retained.inputId);
          const saved = store.transaction(() => comparisons.compare(record, candidate));
          const comparisonId = saved.document.comparisonId;
          assert.deepEqual(saved.document.changes, []);
          for (const table of ["policy_preview_inputs", "policy_previews"]) {
            const row = store.db.prepare(`SELECT document, digest FROM ${table}`).get();
            assert.equal(comparisonHash(JSON.parse(row.document)), row.digest);
          }
          store.close();
          store = new ControlStore(database);
          comparisons = new PolicyComparisonStore(store, metrics);
          record = comparisons.input(retained.inputId);
          assert.equal(record.input.actors[0].id, actorId);
          assert.equal(record.input.facts[0].id, factId);
          assert.equal(record.input.facts[0].actorId, actorId);
          const restored = comparisons.verifiedResult(comparisonId, record);
          assert.equal(restored.resultHash, saved.resultHash);
          assert.deepEqual(restored.document, saved.document);
          const input = checkedPolicyInputs({
            status: "candidate_preview",
            inputs: [comparisons.metadata(record)],
          })[0]!;
          const result = comparisons.redact(restored, record, store.read(), []);
          const original = JSON.stringify(result);
          assert.ok(Buffer.byteLength(original) < 10_000);
          assert.deepEqual(result.changes, []);
          const expectedAudit = [
            {
              actorId,
              factIds: [factId],
              reason: state === "observed" ? "included_count_observed" : "excluded_by_policy_or_correction",
            },
          ];
          assert.deepEqual(result.before.audit, expectedAudit);
          assert.deepEqual(result.after.audit, expectedAudit);
          const value = checkedPolicyPreview(result, input, candidate);
          assert.deepEqual(value.before.audit, expectedAudit);
          assert.deepEqual(value.after.audit, expectedAudit);
          assert.equal(JSON.stringify(result), original);
          store.transaction((current: any) => {
            current.profiles[actorId] = { suppressed: true };
          });
          const hidden = checkedPolicyPreview(comparisons.redact(restored, record, store.read(), []), input, candidate);
          assert.equal(hidden.redactionsApplied, true);
          assert.deepEqual(hidden.before.audit, []);
          assert.deepEqual(hidden.after.audit, []);
          assert.deepEqual(hidden.before.rows, []);
          assert.deepEqual(hidden.after.rows, []);
          assert.ok(!JSON.stringify(hidden).includes(factId));
          assert.ok(!JSON.stringify(hidden).includes(identity));
        } finally {
          store.close();
          rmSync(directory, { recursive: true, force: true });
        }
      });

async function changedIdentityRoundTrip(
  boundary: "actor" | "fact",
  direction: "included" | "excluded",
  length: number,
) {
  const { privatePolicyFixture } = await import(
    new URL("../../../tests/fixtures/private-policy-preview.mjs", import.meta.url).href
  );
  const { ControlStore } = await import(new URL("../../controls/src/store.mjs", import.meta.url).href);
  const { PolicyComparisonStore, comparisonHash, comparisonLimitsV1 } = await import(
    new URL("../../controls/src/policy-comparison.mjs", import.meta.url).href
  );
  const metrics = await import(new URL("../../../packages/metrics/dist/index.js", import.meta.url).href);
  const fixture = privatePolicyFixture();
  // A trailing space is part of the retained opaque ID, not normalization input.
  const identity = ("z-synthetic-" + boundary + "-").padEnd(length - 1, "x") + " ";
  const actorId = boundary === "actor" ? identity : "101";
  const factId = boundary === "fact" ? identity : "z-short-fact";
  assert.equal(identity.length, length);
  fixture.input.actors[0].id = actorId;
  fixture.input.facts = fixture.input.facts.map((fact: any, index: number) => ({
    ...fact,
    id: index === 0 ? "a-short-fact" : factId,
    actorId,
  }));
  fixture.policies[0].unit = metrics.getMetricDefinition("issues_opened").definition.unit;
  fixture.policies[0].groupBy = direction === "included" ? "actor_artifact" : "canonical";
  const candidate = {
    ...fixture.policies[0],
    version: "synthetic-preview/v2",
    groupBy: direction === "included" ? "canonical" : "actor_artifact",
  };
  const directory = mkdtempSync(join(tmpdir(), "synthetic-changed-identity-"));
  const database = join(directory, "controls.sqlite");
  let store = new ControlStore(database);
  try {
    let comparisons = new PolicyComparisonStore(store, metrics);
    const retained = store.transaction((current: unknown) => comparisons.capture(current, fixture));
    assert.equal(retained.state, "retained");
    let record = comparisons.input(retained.inputId);
    const unchanged = store.transaction(() => comparisons.compare(record, structuredClone(fixture.policies[0])));
    assert.deepEqual(unchanged.document.changes, []);
    const saved = store.transaction(() => comparisons.compare(record, candidate));
    const expectedChange = {
      actorId,
      beforeValue: direction === "included" ? 1 : 2,
      afterValue: direction === "included" ? 2 : 1,
      beforeRank: 1,
      afterRank: 1,
      included: direction === "included" ? [factId] : [],
      excluded: direction === "excluded" ? [factId] : [],
      causes: {
        changedPolicyFields: ["groupBy"],
        included: direction === "included" ? [{ factId, reasons: ["repeated_policy_unit"], revision: 0 }] : [],
        excluded: direction === "excluded" ? [{ factId, reasons: ["repeated_policy_unit"], revision: 0 }] : [],
        value: "recalculated_on_identical_frozen_input",
        rank: null,
      },
    };
    assert.deepEqual(saved.document.changes, [expectedChange]);
    const rows = () => ({
      inputs: store.db.prepare("SELECT * FROM policy_preview_inputs ORDER BY id").all(),
      results: store.db.prepare("SELECT * FROM policy_previews ORDER BY id").all(),
    });
    const stored = rows();
    assert.equal(stored.inputs.length, 1);
    assert.equal(stored.results.length, 2);
    for (const row of [...stored.inputs, ...stored.results]) {
      assert.equal(comparisonHash(JSON.parse(row.document)), row.digest);
      const maximum = stored.inputs.includes(row) ? comparisonLimitsV1.inputBytes : comparisonLimitsV1.resultBytes;
      assert.ok(Buffer.byteLength(row.document) <= maximum);
    }
    store.close();
    store = new ControlStore(database);
    comparisons = new PolicyComparisonStore(store, metrics);
    record = comparisons.input(retained.inputId);
    assert.deepEqual(record.input, fixture.input);
    assert.deepEqual(rows(), stored);
    const restored = comparisons.verifiedResult(saved.document.comparisonId, record);
    assert.deepEqual(restored, saved);
    const restoredUnchanged = comparisons.verifiedResult(unchanged.document.comparisonId, record);
    assert.deepEqual(restoredUnchanged, unchanged);
    const input = checkedPolicyInputs({
      status: "candidate_preview",
      inputs: [comparisons.metadata(record)],
    })[0]!;
    const same = checkedPolicyPreview(
      comparisons.redact(restoredUnchanged, record, store.read(), []),
      input,
      fixture.policies[0],
    );
    assert.deepEqual(same.changes, []);
    const result = comparisons.redact(restored, record, store.read(), []);
    const original = JSON.stringify(result);
    assert.ok(Buffer.byteLength(original) < 2_000_000);
    const value = checkedPolicyPreview(result, input, candidate);
    assert.deepEqual(value, result);
    assert.deepEqual(value.changes, [expectedChange]);
    assert.equal(JSON.stringify(result), original);
    assert.deepEqual(rows(), stored);
    store.transaction((current: any) => {
      current.profiles[actorId] = { suppressed: true };
    });
    const hidden = checkedPolicyPreview(comparisons.redact(restored, record, store.read(), []), input, candidate);
    assert.equal(hidden.redactionsApplied, true);
    assert.deepEqual(hidden.changes, []);
    assert.deepEqual(hidden.before.rows, []);
    assert.deepEqual(hidden.after.rows, []);
    assert.deepEqual(hidden.before.audit, []);
    assert.deepEqual(hidden.after.audit, []);
    assert.ok(!JSON.stringify(hidden).includes(factId));
    assert.ok(!JSON.stringify(hidden).includes(identity));
    assert.deepEqual(rows(), stored);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const boundary of ["actor", "fact"] as const) {
  for (const direction of ["included", "excluded"] as const) {
    for (const length of [200, 201]) {
      test(`${length}-character ${boundary} survives ${direction} policy changes and SQLite reopen`, async () => {
        await changedIdentityRoundTrip(boundary, direction, length);
      });
    }
  }
}

test("changed policy identities reject malformed values without relaxing labels or result cardinality", async () => {
  const e = await example();
  try {
    const original = JSON.stringify(e.result);
    const change = e.result.changes[0];
    const reject = (value: unknown) =>
      assert.throws(
        () => checkedPolicyPreview({ ...e.result, changes: [value] }, e.input, e.candidate),
        /Invalid private policy comparison response/,
      );
    for (const invalid of ["", " \t\n", null, false, 0, [], {}]) {
      reject({ ...change, actorId: invalid });
      for (const direction of ["included", "excluded"] as const) {
        reject({ ...change, [direction]: [invalid] });
        reject({
          ...change,
          causes: {
            ...change.causes,
            [direction]: [{ factId: invalid, reasons: ["repeated_policy_unit"], revision: 0 }],
          },
        });
      }
    }
    const entry = e.result.before.audit[0];
    for (const patch of [{ actorId: " \t\n" }, { factIds: [" \t\n"] }])
      assert.throws(
        () =>
          checkedPolicyPreview(
            { ...e.result, before: { ...e.result.before, audit: [{ ...entry, ...patch }] } },
            e.input,
            e.candidate,
          ),
        /Invalid private policy comparison response/,
      );
    for (const direction of ["included", "excluded"] as const) {
      reject({ ...change, [direction]: Array.from({ length: 10_001 }, () => "valid-fact") });
      reject({
        ...change,
        causes: {
          ...change.causes,
          [direction]: Array.from({ length: 10_001 }, () => ({
            factId: "valid-fact",
            reasons: ["repeated_policy_unit"],
            revision: 0,
          })),
        },
      });
      reject({
        ...change,
        causes: {
          ...change.causes,
          [direction]: [{ factId: "valid-fact", reasons: ["x".repeat(201)], revision: 0 }],
        },
      });
    }
    for (const field of ["value", "rank"] as const)
      reject({ ...change, causes: { ...change.causes, [field]: "x".repeat(201) } });
    reject({ ...change, causes: { ...change.causes, changedPolicyFields: ["x".repeat(201)] } });
    assert.throws(() => readCandidatePolicy(JSON.stringify({ ...e.candidate, version: "x".repeat(201) }), e.input));
    assert.throws(
      () =>
        checkedPolicyPreview(
          { ...e.result, changes: Array.from({ length: 2001 }, () => change) },
          e.input,
          e.candidate,
        ),
      /Invalid private policy comparison response/,
    );
    assert.equal(JSON.stringify(e.result), original);
  } finally {
    e.close();
  }
});
