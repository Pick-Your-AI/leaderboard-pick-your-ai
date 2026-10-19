import assert from "node:assert/strict";
import test from "node:test";
import { comparisonHash, createPolicyComparisonManager } from "../../controls/src/policy-comparison.mjs";
import { clock } from "./harness.mjs";
import { after, deliveryHarness, previewRequest, restart, retainLegacyDelivery } from "./default-delivery-fixtures.mjs";

const prefix = "/controls/policy-comparisons";

// Exercise the real manager's GET/list/respond boundary and runtime source
// authority. The reviewer session, source, databases and values are synthetic;
// this test does not start an HTTP socket or impersonate an actual reviewer.
function reviewer(store) {
  const session = {
    sid: "d".repeat(43),
    actorId: "201",
    roles: ["reviewer"],
    roleVersion: "1",
    expires: Date.now() + 900_000,
  };
  store.transaction((state) => {
    state.sessions[session.sid] = { ...session, csrf: "synthetic-comparison-csrf" };
  });
  return session;
}

function request(manager, session, path, respond, extra = {}) {
  return manager({
    path,
    method: "GET",
    session,
    refreshSession: async () => ({ ...session }),
    respond,
    ...extra,
  });
}

async function allowed(manager, session, path, extra = {}) {
  let responses = 0;
  const result = await request(
    manager,
    session,
    path,
    (response, beforeSend) => {
      beforeSend();
      assert.equal(response.status, 200);
      responses++;
    },
    extra,
  );
  assert.equal(result.status, 200);
  assert.equal(responses, 1);
  return result.data;
}

async function denied(manager, session, path) {
  let responses = 0;
  await assert.rejects(
    request(manager, session, path, () => {
      responses++;
    }),
    (error) =>
      error.status === 409 && /Frozen (default.delivery|normalization).* (obsolete|unavailable)/.test(error.message),
  );
  assert.equal(responses, 0, "obsolete private evidence must fail before responding");
}

// The shared legacy helper changes the input's identity. Rebind every saved
// result identity/hash as well: an orphan, expiry or corrupt-result 404/409
// would not exercise the intended retained incomplete-result authorization gap.
function rebindIncompleteResult(comparisons, store, oldId, inputId) {
  const { document: original } = comparisons.result(oldId);
  assert.equal(original.before.coverage, "incomplete");
  assert.equal(original.after.coverage, "incomplete");
  const document = structuredClone(original);
  document.inputId = inputId;
  document.comparisonId = comparisonHash([inputId, document.beforePolicyHash, document.afterPolicyHash]);
  store.db
    .prepare("UPDATE policy_previews SET id=?,input_id=?,document=?,digest=? WHERE id=?")
    .run(document.comparisonId, inputId, JSON.stringify(document), comparisonHash(document), oldId);
  const input = comparisons.input(inputId);
  assert.equal(document.inputHash, comparisonHash(input.input));
  assert.equal(
    document.baselineHash,
    comparisonHash(input.baseline.find((entry) => entry.metricId === document.beforePolicy.metricId)),
  );
  assert.deepEqual(comparisons.result(document.comparisonId).document, document);
  return document;
}

function retainedIncomplete(comparisons, document) {
  const input = comparisons.input(document.inputId);
  // The storage reader legitimately returns a cached incomplete result without
  // recomputation. It is not an authority grant; the manager must guard it.
  assert.deepEqual(
    comparisons.verifiedResult(document.comparisonId, input, () =>
      assert.fail("an incomplete cached result should not require engine replay"),
    ).document,
    document,
  );
}

for (const bindingMode of ["exact", "unbound"])
  test(
    bindingMode + ": retained incomplete comparison GET and input listing reject old delivery authority after reopen",
    async (t) => {
      const h = await deliveryHarness(t, "issue");
      const first = (await h.runtime.runOnce({ cutoff: clock() })).publications[0];
      assert.ok(first?.comparisonInput.inputId);
      const session = reviewer(h.controlsStore);
      const initial = createPolicyComparisonManager(h.runtime.policyComparisons);
      const candidatePolicy = previewRequest(h, first.snapshotId).policy;
      const created = await allowed(initial, session, prefix, {
        method: "POST",
        input: { inputId: first.comparisonInput.inputId, candidatePolicy },
      });
      assert.equal(created.before.coverage, "incomplete");
      assert.equal(created.after.coverage, "incomplete");
      assert.equal(
        (await allowed(initial, session, prefix + "/" + created.comparisonId)).comparisonId,
        created.comparisonId,
      );
      assert.deepEqual(
        (await allowed(initial, session, prefix + "/inputs")).inputs.map((input) => input.inputId),
        [first.comparisonInput.inputId],
      );

      const legacy = await retainLegacyDelivery(h, first, bindingMode);
      const saved = rebindIncompleteResult(
        h.runtime.policyComparisons.comparisons,
        h.controlsStore,
        created.comparisonId,
        legacy.inputId,
      );
      retainedIncomplete(h.runtime.policyComparisons.comparisons, saved);
      h.state.defaultBranch = undefined;

      await restart(h, async (runtime, controlsStore) => {
        retainedIncomplete(runtime.policyComparisons.comparisons, saved);
        const manager = createPolicyComparisonManager(runtime.policyComparisons);
        await denied(manager, session, prefix + "/" + saved.comparisonId);
        await denied(manager, session, prefix + "/inputs");
        assert.deepEqual(runtime.policyComparisons.comparisons.result(saved.comparisonId).document, saved);

        h.state.defaultBranch = "main";
        h.state.revision = after + "-private-recovery";
        const recovered = (await runtime.runOnce({ cutoff: clock() })).publications[0];
        assert.notEqual(recovered.snapshotId, first.snapshotId);
        assert.notEqual(recovered.comparisonInput.inputId, legacy.inputId);
        const fresh = await allowed(manager, session, prefix, {
          method: "POST",
          input: { inputId: recovered.comparisonInput.inputId, candidatePolicy },
        });
        assert.equal(fresh.inputId, recovered.comparisonInput.inputId);
        assert.equal(
          (await allowed(manager, session, prefix + "/" + fresh.comparisonId)).comparisonId,
          fresh.comparisonId,
        );
        // The valid new result does not repair the old capture. Listing is
        // atomic and continues to withhold a set containing that obsolete input.
        await denied(manager, session, prefix + "/" + saved.comparisonId);
        await denied(manager, session, prefix + "/inputs");
        retainedIncomplete(runtime.policyComparisons.comparisons, saved);
        assert.ok(controlsStore.db.prepare("SELECT id FROM policy_previews WHERE id=?").get(saved.comparisonId));
      });
    },
  );
