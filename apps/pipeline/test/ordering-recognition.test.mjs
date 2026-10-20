// Controlled fictional source/authority; this suite enables no real metric/source.
import test from "node:test";
import assert from "node:assert/strict";
import { applyRecognitionReceipt } from "@pick-your-ai/github";
import { getMetricDefinition, getMetricUi } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { hasReviewedEvidenceIntake } from "../../controls/src/evidence-intake.mjs";
import { projectPublic } from "../../controls/src/store.mjs";
import {
  orderingSource,
  orderingState,
  orderingBinding,
  orderingAt,
  orderingPolicyVersion,
  orderingEnvelope,
} from "../../../tests/fixtures/ordering.mjs";

const policy = {
  metricId: "issue_ordering",
  version: orderingPolicyVersion,
  dateBasis: "acceptedAt",
  groupBy: "canonical",
  rankedStates: ["qualified"],
};
function scenario() {
  const input = orderingSource(),
    state = orderingState({ source: input });
  return { input, state, bindings: [orderingBinding()], policies: [{ policy: structuredClone(policy) }] };
}
function run(s, apply = applyRecognitionReceipt) {
  return materializeRecognition(s.input, s.state, s.bindings, s.policies, apply, orderingAt);
}
const recognized = (out) => out.facts.filter((fact) => fact.metricId === "issue_ordering");

test("private audited current ordering receipt yields one canonical accepted-at unit", () => {
  const s = scenario(),
    before = structuredClone(s),
    request = Object.values(s.state.requests)[0];
  assert.equal(hasReviewedEvidenceIntake(request), true);
  const out = run(s);
  assert.equal(recognized(out).length, 1);
  assert.equal(recognized(out)[0].acceptedAt, orderingAt);
  assert.deepEqual(s, before);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_ORDERING_DETAIL|CHILD_1|ordering-review\/v1/);
  assert.equal(getMetricDefinition("issue_ordering").event_clock, "accepted_at");
  assert.equal(getMetricUi("issue_ordering").maturity, "definition_only");
});

test("legacy generic and mismatched role/source-use records stay withheld in both public claims and metric authority", () => {
  for (const change of [
    (r) => {
      delete r.history.at(-1).ordering;
    },
    (r) => {
      r.intake.roles.submitter = "observer";
    },
    (r) => {
      r.detail += "changed";
    },
    (r) => {
      r.history.at(-1).sourceUseReview.references[0].revision = "f".repeat(40);
    },
    (r) => {
      r.history.at(-1).ordering.claimDigest = "f".repeat(64);
    },
  ]) {
    const s = scenario(),
      request = Object.values(s.state.requests)[0];
    change(request);
    // Keep the private audit twin exact to isolate intake/typed binding admission.
    s.state.audit = s.state.audit.map((event) =>
      event.id === request.history.at(-1).id ? structuredClone(request.history.at(-1)) : event,
    );
    s.state.profiles["101"] = { public: true, suppressed: false };
    assert.equal(hasReviewedEvidenceIntake(request), false);
    assert.equal(projectPublic(s.state).claims.length, 0);
    assert.equal(recognized(run(s)).length, 0);
  }
});

test("no ordering grant or invalid current source reaches even a custom receipt adapter", () => {
  for (const change of [
    (s) => {
      delete s.bindings[0].orderingAuthority;
    },
    (s) => {
      s.bindings[0].orderingAuthority.scopes[0].id = "OTHER_SCOPE";
    },
    (s) => {
      s.input.evidence.push(structuredClone(s.input.evidence[0]));
    },
    (s) => {
      s.input.actors.push(structuredClone(s.input.actors[0]));
    },
    (s) => {
      s.input.actors[0].executionMode = "automated";
    },
    (s) => {
      s.policies[0].policy.groupBy = "actor_artifact";
    },
    (s) => {
      s.state.audit.pop();
    },
    (s) => {
      s.state.audit.push(structuredClone(s.state.audit.at(-1)));
    },
  ]) {
    const s = scenario();
    change(s);
    let calls = 0;
    assert.throws(() =>
      run(s, () => {
        calls++;
        throw Error("must not reach callback");
      }),
    );
    assert.equal(calls, 0);
  }
});

test("every conflicting same-plan receipt is checked before the first callback in either request order", () => {
  for (const reversed of [false, true]) {
    const s = scenario(),
      second = orderingState({ id: "second-claim", source: s.input });
    const request = Object.values(second.requests)[0];
    [request.history.at(-1).ordering.before.items, request.history.at(-1).ordering.after.items] = [
      request.history.at(-1).ordering.after.items,
      request.history.at(-1).ordering.before.items,
    ];
    second.audit[second.audit.length - 1] = structuredClone(request.history.at(-1));
    s.state.requests = Object.fromEntries(
      reversed
        ? [...Object.entries(second.requests), ...Object.entries(s.state.requests)]
        : [...Object.entries(s.state.requests), ...Object.entries(second.requests)],
    );
    s.state.audit.push(...second.audit);
    let calls = 0;
    assert.throws(
      () =>
        run(s, () => {
          calls++;
          throw Error("must not run");
        }),
      /ordering_evidence_unverified/,
    );
    assert.equal(calls, 0);
  }
});

test("independently valid duplicate plan reviews collapse after validation and retain raw activity", () => {
  const s = scenario(),
    second = orderingState({ id: "second-claim", source: s.input });
  Object.assign(s.state.requests, second.requests);
  s.state.audit.push(...second.audit);
  let calls = 0;
  const out = run(s, (...args) => {
    calls++;
    return applyRecognitionReceipt(...args);
  });
  assert.equal(calls, 1);
  assert.equal(recognized(out).length, 1);
  assert.deepEqual(out.facts.slice(0, s.input.facts.length), s.input.facts);
});

test("withdrawal suppression cutoff and scope removal revoke current ordering authority", () => {
  const s = scenario(),
    fingerprint = recognitionFingerprint(s.state, s.bindings);
  assert.equal(recognized(run(s)).length, 1);
  for (const change of [
    (v) => {
      Object.values(v.state.requests)[0].status = "withdrawn";
    },
    (v) => {
      v.state.profiles["101"] = { suppressed: true };
    },
    (v) => {
      v.bindings[0].orderingAuthority.scopes[0].id = "WITHDRAWN_SCOPE";
    },
  ]) {
    const next = structuredClone(s);
    change(next);
    assert.notEqual(recognitionFingerprint(next.state, next.bindings), fingerprint);
    if (next.bindings[0].orderingAuthority.scopes[0].id === "WITHDRAWN_SCOPE") assert.throws(() => run(next));
    else assert.equal(recognized(run(next)).length, 0);
  }
  assert.equal(
    recognized(
      materializeRecognition(
        s.input,
        s.state,
        s.bindings,
        s.policies,
        applyRecognitionReceipt,
        "2026-10-19T02:59:59.999Z",
      ),
    ).length,
    0,
  );
  const empty = { requests: {}, profiles: {}, audit: [] };
  assert.notEqual(recognitionFingerprint(empty, s.bindings), recognitionFingerprint(empty, []));
});

test("host callback mutations cannot change later frozen ordering input or the caller's state", () => {
  const s = scenario(),
    before = structuredClone(s);
  const out = run(s, (...args) => {
    s.input.facts[0].actorId = "404";
    s.bindings[0].orderingAuthority.scopes[0].id = "MUTATED";
    Object.values(s.state.requests)[0].history.at(-1).ordering.after.items.reverse();
    return applyRecognitionReceipt(...args);
  });
  assert.equal(recognized(out).length, 1);
  assert.equal(recognized(out)[0].actorId, "101");
  // The deliberate caller mutation is real, but does not alter this invocation.
  assert.notDeepEqual(s, before);
});

test("ordering publication preserves current proof/export authority across reopen recomputation and withdrawal", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario();
  const publicationCutoff = "2026-10-19T04:00:00.000Z";
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [orderingEnvelope().payload],
    normalizerFactory: () => async () => structuredClone(s.input),
    defaultDeliveryNormalizationVersion: components.github.defaultDeliveryNormalizationVersion,
    configure(config) {
      config.recognitionBindings = s.bindings;
      const selected = {
        ...config.policies[0].policy,
        ...policy,
        unit: getMetricDefinition("issue_ordering").definition.unit,
        roles: ["reporter"],
        minimumSamples: 1,
        rank: false,
      };
      config.policies = [
        { policy: selected, signature: components.metrics.stableJSON(selected), approvalReceipt: "fixture-approval" },
      ];
    },
  });
  // This lower-level test installs an explicit synthetic private audit; the
  // separate ordering-http-publication case exercises its real protected writer.
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const publication = await h.runtime.runOnce({ cutoff: publicationCutoff });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  assert.equal(read.selected.rows[0].result.value, 1);
  const proof = read.selected.evidence.find((entry) => entry.contribution.metricIds.includes("issue_ordering"));
  assert.ok(proof);
  assert.equal(proof.occurredAt, orderingAt);
  const paths = [
    `/api/v1/boards?metric=issue_ordering&snapshot=${snapshotId}`,
    `/api/v1/contributors/101?metric=issue_ordering&snapshot=${snapshotId}`,
    `/api/v1/evidence/${proof.contribution.contributionId}?snapshot=${snapshotId}`,
    `/api/v1/exports?metric=issue_ordering&format=json&snapshot=${snapshotId}`,
    `/api/v1/exports?metric=issue_ordering&format=csv&snapshot=${snapshotId}`,
  ];
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /PRIVATE_ORDERING_DETAIL|CHILD_1|ordering-review\/v1/);
  }
  const current = recognitionFingerprint(h.controlsStore.read(), s.bindings);
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, current);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshotId].recognitionFingerprint = "obsolete-generic-ordering-generation";
  });
  const denied = async (runtime) => {
    for (const pin of [null, snapshotId])
      assert.equal(await runtime.source.read(publicScope, pin, new AbortController().signal), null);
    for (const path of paths) {
      const response = await runtime.app.inject(path);
      assert.equal(response.statusCode, 410, response.body);
      assert.match(response.headers["cache-control"], /no-store/);
    }
  };
  await denied(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const reopened = await createPipeline(h.options);
  t.after(() => reopened.stop());
  await denied(reopened);
  const repaired = await reopened.runOnce({ cutoff: publicationCutoff });
  assert.equal(repaired.state, "published");
  const repairedId = repaired.publications[0].snapshotId;
  assert.ok(await reopened.source.read(publicScope, repairedId, new AbortController().signal));
  h.controlsStore.transaction((state) => {
    Object.values(state.requests)[0].status = "withdrawn";
  });
  assert.equal(await reopened.source.read(publicScope, repairedId, new AbortController().signal), null);
});
