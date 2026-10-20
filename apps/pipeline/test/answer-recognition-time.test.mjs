// Fictional observations and disposable stores only. No actual contributor,
// answer acceptance, source permission or production publication is represented.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import { getMetricDefinition, metricRegistryV1 } from "@pick-your-ai/metrics";
import { sourceEventSchema } from "@pick-your-ai/contracts";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const createdAt = "2026-10-02T10:00:00.000Z";
const acceptedAt = "2026-10-03T10:00:00.000Z";
const cutoff = "2026-10-10T10:00:00.000Z";

function scenario({ created = createdAt, accepted = acceptedAt, markerFree = false } = {}) {
  const data = markerFree ? JSON.parse(JSON.stringify(fixture).replace(/synthetic/gi, "fixture")) : fixture;
  const slug = markerFree ? "example-org/example-repo" : "synthetic-owner/repository";
  const payload = {
    ...structuredClone(data.issue),
    user: data.author,
    html_url: `https://github.com/${slug}/issues/20`,
  };
  const input = normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: cutoff, isSynthetic: !markerFree },
    family: "comment",
    action: "created",
    occurredAt: created,
    observedAt: cutoff,
    frozenCutoff: cutoff,
    payload: {
      id: 50,
      node_id: markerFree ? "IC_fixture_50" : "IC_synthetic_50",
      user: data.author,
      created_at: created,
      html_url: `${payload.html_url}#issuecomment-50`,
    },
  });
  const candidate = input.facts.find((fact) => fact.metricId === "issue_answers");
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === candidate.id);
  const decision = {
    id: "private-answer-review",
    action: "accepted",
    actor: "202",
    at: Date.parse(accepted),
    policyVersion: "review-policy-v1",
  };
  const request = {
    id: "private-answer-claim",
    kind: "evidence",
    status: "accepted",
    owner: candidate.actorId,
    category: "answer",
    scope: "repository:2:answer",
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: {},
    history: [decision],
  };
  const state = attachSyntheticEvidenceState({
    requests: { [request.id]: request },
    profiles: {},
    audit: [structuredClone(decision)],
  });
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: request.policyVersion,
    metricId: "issue_answers",
    sourceMetricId: "issue_answers",
    repositoryId: candidate.repoId,
    reviewerIds: ["202"],
  };
  const receipt = {
    id: decision.id,
    verified: true,
    targetFactId: candidate.id,
    metricId: binding.metricId,
    actorId: candidate.actorId,
    reviewerId: decision.actor,
    acceptedAt: accepted,
    decision: "accepted",
    evidenceIds: [candidate.id],
  };
  const policies = [
    { policy: { metricId: binding.metricId, version: binding.policyVersion, dateBasis: "acceptedAt" } },
  ];
  const run = (apply = applyRecognitionReceipt) =>
    materializeRecognition(input, state, [binding], policies, apply, cutoff);
  return { input, candidate, evidence, decision, request, state, binding, receipt, policies, payload, run };
}

test("issue_answers: a known later comment cannot be accepted by the direct receipt boundary", () => {
  const s = scenario({ accepted: "2026-10-01T10:00:00.000Z" });
  const original = structuredClone(s.input);
  assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, ["202"]), /cannot predate/);
  assert.deepEqual(s.input, original);
});

test("issue_answers: the pipeline rejects a known future source before invoking host receipt authority", () => {
  const s = scenario({ accepted: "2026-10-01T10:00:00.000Z" });
  const original = structuredClone([s.input, s.state]);
  let calls = 0;
  assert.throws(
    () =>
      s.run((input) => {
        calls++;
        return input;
      }),
    /recognition_source_time_invalid/,
  );
  assert.equal(calls, 0);
  assert.deepEqual([s.input, s.state], original);
});

test("issue_answers: equal and later acceptance preserve separate source and accepted clocks", () => {
  for (const accepted of [createdAt, acceptedAt]) {
    const s = scenario({ accepted });
    const original = structuredClone(s.input);
    for (const output of [s.run(), applyRecognitionReceipt(s.input, s.receipt, ["202"])]) {
      assert.equal(output.facts.at(-1).state, "qualified");
      assert.equal(output.facts.at(-1).occurredAt, createdAt);
      assert.equal(output.facts.at(-1).acceptedAt, accepted);
      assert.equal(output.evidence.at(-1).occurredAt, accepted);
      assert.deepEqual(output.facts.slice(0, original.facts.length), original.facts);
    }
    assert.deepEqual(s.input, original);
  }
});

test("issue_answers: missing or unsupported source clocks stay unknown under an explicit receipt", () => {
  for (const created of [null, "not-a-source-date", "2026-02-30T10:00:00Z"]) {
    const s = scenario({ created });
    assert.equal(s.candidate.occurredAt, null);
    for (const output of [s.run(), applyRecognitionReceipt(s.input, s.receipt, ["202"])]) {
      assert.equal(output.facts.at(-1).occurredAt, null);
      assert.equal(output.facts.at(-1).acceptedAt, acceptedAt);
    }
    assert.equal(s.candidate.occurredAt, null);
  }
});

test("issue_answers: occurrence alone supplies the lower bound, independent of collection and other decision clocks", () => {
  const s = scenario();
  s.candidate.observedAt = cutoff;
  s.candidate.acceptedAt = cutoff;
  s.evidence.sourceRevision = cutoff;
  const output = s.run();
  assert.equal(output.facts.at(-1).acceptedAt, acceptedAt);
  assert.equal(output.facts.at(-1).occurredAt, createdAt);
});

test("issue_answers: equivalent offsets and fractional source precision keep their actual order", () => {
  for (const [source, later] of [
    ["2026-10-02T12:00:00+02:00", false],
    ["2026-10-02T12:00:00.001+02:00", true],
    ["2026-10-02T10:00:00.000000001Z", true],
    ["2026-10-02T10:00:00.000000000Z", false],
    ["2026-10-02T09:59:59.999999999Z", false],
  ]) {
    const s = scenario({ accepted: createdAt });
    // These are contract-valid normalized fact fixtures; the REST normalizer's
    // more restrictive timestamp reader is not being claimed to emit offsets.
    assert.equal(sourceEventSchema.shape.occurredAt.safeParse(source).success, true);
    s.candidate.occurredAt = s.evidence.occurredAt = source;
    if (later) {
      assert.throws(() => s.run(), /recognition_source_time_invalid/, source);
      assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, ["202"]), /cannot predate/, source);
    } else {
      assert.equal(s.run().facts.at(-1).occurredAt, source);
      assert.equal(applyRecognitionReceipt(s.input, s.receipt, ["202"]).facts.at(-1).acceptedAt, createdAt);
    }
  }
});

test("issue_answers: chronology cannot disambiguate two matching source facts", () => {
  for (const reverse of [false, true]) {
    const s = scenario({ accepted: "2026-10-01T10:00:00.000Z" });
    const other = { ...s.candidate, id: "other-source", occurredAt: "2026-09-30T10:00:00.000Z" };
    const evidence = structuredClone(s.evidence);
    evidence.contribution.contributionId = other.id;
    evidence.occurredAt = other.occurredAt;
    s.input.facts.push(other);
    s.input.evidence.push(evidence);
    if (reverse) s.input.facts.reverse();
    let calls = 0;
    assert.throws(
      () =>
        s.run((input) => {
          calls++;
          return input;
        }),
      /ambiguous_recognition_target/,
    );
    assert.equal(calls, 0);
  }
});

test("issue_answers: the guard follows the destination metric even when the source binding is an issue", () => {
  const s = scenario({ accepted: "2026-10-01T10:00:00.000Z" });
  s.candidate.metricId = s.binding.sourceMetricId = "issues_opened";
  assert.throws(() => s.run(), /recognition_source_time_invalid/);
  assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, ["202"]), /cannot predate/);
});

test("issue_answers: unrelated destination metrics retain their established source-specific rules", () => {
  const s = scenario({ accepted: "2026-10-01T10:00:00.000Z" });
  s.binding.metricId = s.receipt.metricId = s.policies[0].policy.metricId = "accepted_findings";
  assert.equal(s.run().facts.at(-1).metricId, "accepted_findings");
  assert.equal(applyRecognitionReceipt(s.input, s.receipt, ["202"]).facts.at(-1).state, "qualified");
});

test("issue_answers: a rejection remains excluded without rewriting its historical source", () => {
  const s = scenario({ accepted: "2026-10-01T10:00:00.000Z" });
  s.receipt.decision = "rejected";
  const original = structuredClone(s.input);
  const output = applyRecognitionReceipt(s.input, s.receipt, ["202"]);
  assert.equal(output.facts.at(-1).state, "excluded");
  assert.equal(output.facts.at(-1).occurredAt, createdAt);
  assert.deepEqual(s.input, original);
});

// Exact accepted-main7f3 authority format. Preserve this historical oracle;
// never rewrite an old stored fingerprint to make it current.
function previousAuthority(state, bindings) {
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  const decisionIds = new Set(
    requests.flatMap((r) => (r.history ?? []).filter((event) => event.action === "accepted").map((event) => event.id)),
  );
  const audit = (state.audit ?? [])
    .filter((event) => decisionIds.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("issue_answers: its configuration fence preserves automatic-source authority while manual intake retires old claims", () => {
  const s = scenario();
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of metricRegistryV1.metrics) {
    const bindings = [{ ...s.binding, metricId: metric.id }];
    // Legacy generic feedback selections lack the required native-thread contract.
    if (metric.id === "helpful_feedback") {
      for (const state of [s.state, empty])
        assert.throws(() => recognitionFingerprint(state, bindings), /invalid_discussion_feedback_contract/);
      continue;
    }
    assert.notEqual(
      recognitionFingerprint(s.state, bindings),
      previousAuthority(s.state, bindings),
      `${metric.id}: manual intake retires prior claim authority`,
    );
    const old = previousAuthority(empty, bindings);
    const current = recognitionFingerprint(empty, bindings);
    // Preserve the literal old fingerprint and the received independent category fences.
    if (
      [
        "issue_answers",
        "maintenance",
        "automation",
        "governance",
        "deployment_work",
        "incidents",
        "release_changes",
        "issue_ordering",
        "release_stewardship",
        "performance",
        "regressions_prevented",
      ].includes(metric.id)
    )
      assert.notEqual(current, old);
    else assert.equal(current, old, `${metric.id}: exact prior authority remains`);
  }
  const other = { ...s.binding, metricId: "accepted_findings" };
  assert.notEqual(recognitionFingerprint(empty, [other, s.binding]), previousAuthority(empty, [other, s.binding]));
  assert.equal(recognitionFingerprint(empty, [other]), previousAuthority(empty, [other]));
  assert.equal(recognitionFingerprint(empty, []), previousAuthority(empty, []));
});

test("issue_answers: obsolete authority is withheld through reopen and recovers by actual recomputation", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario({ markerFree: true });
  s.evidence.contribution.reasonCodes.push("private-proof:PRIVATE_ANSWER_REVIEW");
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [s.payload],
    normalizerFactory: () => async () => structuredClone(s.input),
    authorizePolicyPreview: async () => true,
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        rankedStates: ["qualified"],
        unit: getMetricDefinition("issue_answers").definition.unit,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const publication = await h.runtime.runOnce({ cutoff });
  assert.equal(publication.state, "published");
  const snapshotId = publication.publications[0].snapshotId;
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  assert.equal(read.selected.rows[0].result.value, 1);
  const proofId = read.selected.evidence[0].contribution.contributionId;
  const paths = [
    `/api/v1/boards?metric=issue_answers&snapshot=${snapshotId}`,
    `/api/v1/contributors/101?metric=issue_answers&snapshot=${snapshotId}`,
    `/api/v1/evidence/${proofId}?snapshot=${snapshotId}`,
    `/api/v1/exports?metric=issue_answers&format=json&snapshot=${snapshotId}`,
    `/api/v1/exports?metric=issue_answers&format=csv&snapshot=${snapshotId}`,
  ];
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(
      response.body,
      /PRIVATE_ANSWER_REVIEW|private-answer-claim|private-answer-review|private-proof/,
    );
  }
  const preview = (runtime) =>
    runtime.previewPolicy({
      snapshotId,
      policy: { ...h.options.config.policies[0].policy, version: "review-policy-v2" },
      operatorId: "201",
    });
  assert.ok(await preview(h.runtime));
  assert.ok(await h.runtime.aggregateExplanations.read(snapshotId));
  const old = previousAuthority(h.controlsStore.read(), [s.binding]);
  assert.notEqual(old, recognitionFingerprint(h.controlsStore.read(), [s.binding]));
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshotId].recognitionFingerprint = old;
  });
  const denied = async (runtime) => {
    for (const pin of [null, snapshotId])
      assert.equal(await runtime.source.read(publicScope, pin, new AbortController().signal), null);
    for (const path of paths) {
      const response = await runtime.app.inject(path);
      assert.equal(response.statusCode, 410, response.body);
      assert.match(response.headers["cache-control"], /no-store/);
    }
    await assert.rejects(preview(runtime), /policy_input_revoked/);
    await assert.rejects(runtime.aggregateExplanations.read(snapshotId), /authorization_changed/);
  };
  await denied(h.runtime);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  await denied(restarted);
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, old);
  const recomputed = await restarted.runOnce({ cutoff });
  assert.equal(recomputed.state, "published");
  const currentId = recomputed.publications[0].snapshotId;
  assert.equal(
    (await restarted.source.read(publicScope, currentId, new AbortController().signal)).selected.rows[0].result.value,
    1,
  );
  // Identical, still-valid content keeps its content-addressed snapshot ID.
  // Only the actual authorized recomputation may replace its obsolete receipt;
  // the reads and database reopen above must leave that receipt unchanged.
  assert.equal(currentId, snapshotId);
  assert.equal(
    h.controlsStore.read().pipelinePublications[currentId].recognitionFingerprint,
    recognitionFingerprint(h.controlsStore.read(), [s.binding]),
  );
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await restarted.source.read(publicScope, currentId, new AbortController().signal), null);
});
