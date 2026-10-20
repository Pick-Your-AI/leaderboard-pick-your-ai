// Fictional in-memory and disposable-database fixtures only. These are not
// actual bug reports, confirmation decisions, source permission or rollout.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import { getMetricDefinition, getMetricUi, metricRegistryV1, selectMetricView } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const acceptedAt = "2026-10-09T10:00:00.000Z";
const cutoff = "2026-10-10T10:00:00.000Z";

function scenario({ family = "issue", synthetic = false, markerFree = false, collaborators = {} } = {}) {
  const data = markerFree ? JSON.parse(JSON.stringify(fixture).replace(/synthetic/gi, "fixture")) : fixture;
  const slug = markerFree ? "example-org/example-repo" : "synthetic-owner/repository";
  const sourceMetricId = family === "issue" ? "issues_opened" : "pr_merged";
  const payload = {
    ...structuredClone(data[family]),
    user: data.author,
    html_url: `https://github.com/${slug}/${family === "issue" ? "issues/20" : "pull/10"}`,
    ...(family === "issue" ? { state: "open" } : { merge_commit_sha: "c".repeat(40) }),
  };
  const input = normalizeGithubObservation({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: acceptedAt, isSynthetic: synthetic },
    family,
    action: family === "issue" ? "opened" : "closed",
    occurredAt: family === "issue" ? payload.created_at : payload.merged_at,
    observedAt: acceptedAt,
    payload: { repository: { ...data.repository, full_name: slug }, [family]: payload },
    ...(family === "pull_request"
      ? {
          integration: {
            before: "b".repeat(40),
            after: "c".repeat(40),
            targetBranch: "main",
            defaultBranch: "main",
            canonicalChangeId: "fixture-change",
            commitShas: ["c".repeat(40)],
            diff: {
              before: "b".repeat(40),
              after: "c".repeat(40),
              complete: true,
              files: [{ path: "docs/guide.md", additions: 2, deletions: 1 }],
            },
          },
        }
      : {}),
  });
  const candidate = input.facts.find((fact) => fact.metricId === sourceMetricId);
  assert.ok(candidate);
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === candidate.id);
  assert.ok(evidence);
  const decision = {
    id: "private-review-receipt",
    version: 2,
    action: "accepted",
    actor: "202",
    at: Date.parse(acceptedAt),
    policyVersion: "review-policy-v1",
  };
  const request = {
    id: "private-claim",
    version: 2,
    kind: "evidence",
    status: "accepted",
    owner: candidate.actorId,
    category: "finding",
    scope: "repository:2:confirmed-report",
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: structuredClone(collaborators),
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
    metricId: "confirmed_bugs",
    sourceMetricId,
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
    acceptedAt,
    decision: "accepted",
    evidenceIds: [candidate.id],
  };
  const policies = [
    {
      policy: {
        metricId: binding.metricId,
        version: binding.policyVersion,
        dateBasis: "acceptedAt",
        groupBy: "canonical",
        rankedStates: ["qualified"],
      },
    },
  ];
  const run = (apply = applyRecognitionReceipt) =>
    materializeRecognition(input, state, [binding], policies, apply, cutoff);
  return { input, candidate, evidence, decision, request, state, binding, receipt, policies, payload, run };
}

const invalidSources = {
  "merged PR with no issue artifact": () => scenario({ family: "pull_request" }),
  "non-report issue source metric": () => {
    const s = scenario();
    s.candidate.metricId = s.binding.sourceMetricId = "issue_closure_stewardship";
    s.evidence.contribution.metricIds = [s.candidate.metricId];
    return s;
  },
  "explicit whole-input synthetic provenance": () => scenario({ synthetic: true }),
  "explicit target provenance in a combined input": () => {
    const s = scenario();
    delete s.input.isSynthetic;
    s.input.syntheticFactIds = [s.candidate.id];
    return s;
  },
  "issue metric with a pull-request artifact": () => {
    const s = scenario();
    s.evidence.artifact.kind = "pull_request";
    return s;
  },
  "unrelated issue artifact identity": () => {
    const s = scenario();
    s.evidence.artifact.stableId = "different-issue";
    return s;
  },
  "unrelated contribution artifact identity": () => {
    const s = scenario();
    s.evidence.contribution.artifactId = "different-issue";
    return s;
  },
  "unrelated issue repository": () => {
    const s = scenario();
    s.evidence.artifact.repositoryId = "3";
    return s;
  },
  "different reported contributor": () => {
    const s = scenario();
    s.evidence.contribution.actorId = "303";
    return s;
  },
  "ambiguous issue proof": () => {
    const s = scenario();
    s.input.evidence.push(structuredClone(s.evidence));
    return s;
  },
};

for (const [name, create] of Object.entries(invalidSources)) {
  test(`confirmed_bugs: direct receipt rejects ${name}`, () => {
    const s = create(),
      original = structuredClone(s.input);
    assert.throws(
      () => applyRecognitionReceipt(s.input, s.receipt, s.binding.reviewerIds),
      /Confirmed bug recognition requires a nonsynthetic issue source/,
    );
    assert.deepEqual(s.input, original);
  });
  test(`confirmed_bugs: pipeline rejects ${name} before invoking receipt authority`, () => {
    const s = create(),
      original = structuredClone(s.input);
    let calls = 0;
    assert.throws(
      () =>
        s.run((input) => {
          calls++;
          return input;
        }),
      /recognition_source_unverified/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(s.input, original);
  });
}

test("confirmed_bugs: missing issue proof cannot reach a receipt callback or qualify directly", () => {
  const s = scenario();
  s.input.evidence = [];
  let calls = 0;
  assert.deepEqual(
    s.run((input) => {
      calls++;
      return input;
    }),
    s.input,
  );
  assert.equal(calls, 0);
  assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, ["202"]), /nonsynthetic issue source/);
});

test("confirmed_bugs: an independently reviewed issue retains its reporter, source fact and existing receipt unit", () => {
  const s = scenario(),
    original = structuredClone(s.input);
  const direct = applyRecognitionReceipt(s.input, s.receipt, ["202"]);
  const materialized = s.run();
  const accepted = materialized.facts.filter((fact) => fact.metricId === "confirmed_bugs");
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0], direct.facts.at(-1));
  assert.equal(accepted[0].state, "qualified");
  assert.equal(accepted[0].actorId, "101");
  assert.equal(accepted[0].role, "reporter");
  assert.equal(accepted[0].artifactId, s.candidate.artifactId);
  assert.equal(accepted[0].acceptedAt, acceptedAt);
  assert.equal(accepted[0].acceptedBy, "202");
  assert.deepEqual(materialized.facts.slice(0, original.facts.length), original.facts);
  assert.deepEqual(s.input, original);
  const rejected = applyRecognitionReceipt(s.input, { ...s.receipt, decision: "rejected" }, ["202"]);
  assert.equal(rejected.facts.at(-1).state, "excluded");
  assert.equal(rejected.facts.at(-1).canonicalKey, accepted[0].canonicalKey);
  assert.deepEqual(materialized.evidence.at(-1).contribution.reasonCodes, ["independent_recognition_receipt"]);
});

test("confirmed_bugs: unrelated synthetic facts do not block a separately evidenced nonsynthetic issue", () => {
  const s = scenario();
  const unrelated = scenario({ family: "pull_request", synthetic: true });
  delete s.input.isSynthetic;
  s.input.syntheticFactIds = unrelated.input.facts.map((fact) => fact.id);
  s.input.facts.push(...unrelated.input.facts);
  s.input.evidence.push(...unrelated.input.evidence);
  assert.equal(s.run().facts.filter((fact) => fact.metricId === "confirmed_bugs").length, 1);
  assert.equal(applyRecognitionReceipt(s.input, s.receipt, ["202"]).facts.at(-1).state, "qualified");
});

test("confirmed_bugs: independent review, audit and withdrawal controls remain required", () => {
  const s = scenario();
  assert.throws(() => applyRecognitionReceipt(s.input, { ...s.receipt, reviewerId: "101" }, ["101"]), /Independent/);
  assert.throws(() => applyRecognitionReceipt(s.input, s.receipt, []), /Independent/);
  const conflict = scenario({ collaborators: { 202: "accepted" } });
  assert.throws(() => conflict.run(), /recognition_decision_unverified/);
  s.state.audit = [];
  assert.throws(() => s.run(), /recognition_decision_unverified/);
  s.state.audit = [s.decision];
  s.request.status = "withdrawn";
  assert.deepEqual(s.run(), s.input);
});

test("confirmed_bugs: the source guard does not alter other generic receipt metrics or activate rollout", () => {
  const s = scenario({ family: "pull_request", synthetic: true });
  s.binding.metricId = s.receipt.metricId = s.policies[0].policy.metricId = "accepted_findings";
  assert.equal(s.run().facts.at(-1).metricId, "accepted_findings");
  assert.equal(applyRecognitionReceipt(s.input, s.receipt, ["202"]).facts.at(-1).state, "qualified");
  assert.equal(getMetricUi("confirmed_bugs").maturity, "definition_only");
  assert.throws(() => selectMetricView("confirmed_bugs"), /No supported selectable view/);
});

// Isolate missing confirmed-bug authority while retaining the independent
// data-quality, reproduction, maintenance and automation fences.
function previousAuthority(state, bindings) {
  const requests = Object.values(state.requests ?? {})
    .filter((request) => request.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const decisionIds = new Set(
    requests.flatMap((request) =>
      request.history.filter((entry) => entry.action === "accepted").map((entry) => entry.id),
    ),
  );
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, profile]) => profile.suppressed)
    .map(([id]) => id)
    .sort();
  const audit = state.audit
    .filter((entry) => decisionIds.has(entry.id))
    .map((entry) => JSON.stringify(entry))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // Isolate the bug-source correction from the independent maintenance fence.
  // maintenance-recognition.test.mjs tests that category's exact old authority.
  if (bindings.some((binding) => binding.metricId === "maintenance"))
    authority.push("maintenance-merged-participant/v1");
  // Keep the independent tooling fence while isolating this category.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("confirmed_bugs: configuration fences preserve automatic sources while manual intake retires old claim authority", () => {
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
    const prior = previousAuthority(empty, bindings);
    const current = recognitionFingerprint(empty, bindings);
    // Keep the literal historical oracle above: the later answer-clock fence
    // independently retires that destination without changing the old format.
    if (
      [
        "confirmed_bugs",
        "issue_answers",
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
      assert.notEqual(current, prior);
    else assert.equal(current, prior, `${metric.id}: exact established authority bytes remain`);
  }
  const other = { ...s.binding, metricId: "accepted_findings" };
  const mixed = [other, s.binding];
  // No accepted confirmed-bug request is needed for the configuration fence.
  assert.notEqual(recognitionFingerprint(empty, mixed), previousAuthority(empty, mixed));
  assert.equal(recognitionFingerprint(empty, [other]), previousAuthority(empty, [other]));
});

test("confirmed_bugs: obsolete authority cannot serve current/pinned proofs, previews or explanations after reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario({ markerFree: true });
  s.evidence.contribution.reasonCodes.push("private-proof:PRIVATE_CONFIRMED_REPORT");
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
        unit: getMetricDefinition("confirmed_bugs").definition.unit,
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
    `/api/v1/boards?metric=confirmed_bugs&snapshot=${snapshotId}`,
    `/api/v1/contributors/101?metric=confirmed_bugs&snapshot=${snapshotId}`,
    `/api/v1/evidence/${proofId}?snapshot=${snapshotId}`,
    `/api/v1/exports?metric=confirmed_bugs&format=json&snapshot=${snapshotId}`,
    `/api/v1/exports?metric=confirmed_bugs&format=csv&snapshot=${snapshotId}`,
  ];
  for (const path of paths) {
    const response = await h.runtime.app.inject(path);
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(response.body, /private-proof|PRIVATE_CONFIRMED_REPORT|private-claim|private-review-receipt/);
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
    // Keep the stored document and hashes; substitute the exact authority format
    // that previously permitted synthetic and non-issue targets for this binding.
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
  const recomputed = await restarted.runOnce({ cutoff });
  assert.equal(recomputed.state, "published");
  const currentId = recomputed.publications[0].snapshotId;
  const restored = await restarted.source.read(publicScope, currentId, new AbortController().signal);
  assert.equal(restored.selected.rows[0].result.value, 1);
  assert.equal((await restarted.app.inject(`/api/v1/evidence/${proofId}?snapshot=${currentId}`)).statusCode, 200);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await restarted.source.read(publicScope, currentId, new AbortController().signal), null);
});
