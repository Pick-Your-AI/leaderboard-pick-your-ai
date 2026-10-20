// Fictional observations and approvals exercise protected software boundaries only.
// They establish no live source permission, reviewer enrollment or accepted documentation.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  documentationReviewVersion,
  documentationReviewProofHash,
  validateDocumentationReviewSource,
} from "@pick-your-ai/github";
import { aggregateMetric, getMetricDefinition, metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { validateDocumentationReviewBindings } from "../src/documentation-review.mjs";
import { attachSyntheticEvidenceIntake } from "../../../tests/fixtures/evidence-intake.mjs";

const before = "b".repeat(40);
const head = "a".repeat(40);
const occurredAt = "2026-10-07T10:00:00.000Z";
const observedAt = "2026-10-08T10:00:00.000Z";
const acceptedAt = "2026-10-09T10:00:00.000Z";
const cutoff = "2026-10-10T10:00:00.000Z";
const slug = "example-org/example-repo";
const author = { id: 101, node_id: "U_FIXTURE_AUTHOR", login: "fixture-author", type: "User" };
const reviewer = { id: 202, node_id: "U_FIXTURE_REVIEWER", login: "fixture-reviewer", type: "User" };
const pr = {
  id: 1001,
  node_id: "PR_FIXTURE_DOCS",
  number: 1,
  html_url: `https://github.com/${slug}/pull/1`,
  title: "Fixture documentation revision",
  user: author,
  state: "open",
  merged: false,
  created_at: "2026-10-06T10:00:00.000Z",
  updated_at: observedAt,
};
const policy = {
  metricId: "evidence_reviews",
  version: "fixture-review-policy-v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition("evidence_reviews").definition.unit,
  aggregation: "count",
  dateBasis: "acceptedAt",
  rankedStates: ["qualified"],
  roles: ["reviewer"],
  groupBy: "canonical",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
};

function source({ revision = head, state = "COMMENTED", actor = reviewer, change = () => {} } = {}) {
  const envelope = {
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: "review:" + revision, isSynthetic: false },
    family: "review",
    action: "submitted",
    occurredAt,
    observedAt,
    payload: {
      repository: { id: 2, private: false, full_name: slug },
      pull_request: structuredClone(pr),
      review: {
        id: 5001,
        node_id: "REVIEW_FIXTURE",
        html_url: pr.html_url + "#pullrequestreview-5001",
        user: structuredClone(actor),
        commit_id: revision,
        submitted_at: occurredAt,
        created_at: occurredAt,
        state,
      },
    },
    reviewParticipation: { verified: true, firstSubmittedAt: occurredAt, roundFirstSubmittedAt: occurredAt },
  };
  change(envelope);
  return normalizeGithubObservation(envelope);
}

function consent(s, request = s.request) {
  const targetRecord = s.binding.documentationReview.records.find((record) => record.requestId === request.id);
  attachSyntheticEvidenceIntake(request, {
    intake: { roles: { submitter: "reviewer", collaborators: {} } },
    sourceUseReview: {
      references: [{ locator: `https://github.com/${slug}/commit/${targetRecord.head}`, revision: targetRecord.head }],
    },
  });
  const decision = request.history.at(-1);
  s.state.audit = s.state.audit.filter((entry) => entry.id !== decision.id);
  s.state.audit.push(structuredClone(decision));
}

function detail(s, record = s.record) {
  return {
    schemaVersion: documentationReviewVersion,
    targetFactId: record.targetFactId,
    sourceRevision: record.sourceRevision,
    head: record.head,
    proofHash: documentationReviewProofHash(s.binding.documentationReview, record),
    checklistVersion: s.binding.documentationReview.checklist.version,
    completedItems: [...s.binding.documentationReview.checklist.items],
  };
}

function scenario(options = {}) {
  const input = source(options);
  const target = input.facts.find((fact) => fact.metricId === "review_rounds");
  assert.ok(target, "The real normalizer must supply the source review-round fact");
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === target.id);
  const decision = {
    id: "private-doc-review-decision",
    action: "accepted",
    actor: "303",
    at: Date.parse(acceptedAt),
    version: 2,
    policyVersion: policy.version,
  };
  const request = {
    id: "private-doc-review-request",
    kind: "evidence",
    status: "accepted",
    owner: target.actorId,
    version: 2,
    category: "other",
    scope: "repository:2:documentation-review",
    policyVersion: policy.version,
    locator: pr.html_url,
    collaborators: {},
    history: [decision],
  };
  const record = {
    requestId: request.id,
    requestVersion: request.version,
    decisionId: decision.id,
    targetFactId: target.id,
    sourceRevision: evidence.sourceRevision,
    head: options.revision ?? head,
    diff: {
      before,
      after: options.revision ?? head,
      complete: true,
      files: [{ path: "docs/guide.md", additions: 3, deletions: 1 }],
    },
  };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: policy.version,
    metricId: "evidence_reviews",
    sourceMetricId: "review_rounds",
    repositoryId: "2",
    reviewerIds: ["303"],
    documentationReview: {
      version: documentationReviewVersion,
      pathPolicy: {
        repositoryId: 2,
        version: "fixture-doc-paths-v1",
        documentationPaths: ["docs/"],
        researchPaths: ["docs/research/"],
        generatedPaths: ["docs/generated/"],
        importedPaths: ["docs/imported/"],
      },
      checklist: { version: "fixture-substantive-review-v1", items: ["correctness", "clarity", "source-links"] },
      records: [record],
    },
  };
  const s = {
    input,
    target,
    evidence,
    request,
    decision,
    record,
    binding,
    policies: [{ policy: structuredClone(policy) }],
    state: { requests: { [request.id]: request }, profiles: {}, audit: [] },
  };
  request.detail = JSON.stringify(detail(s));
  consent(s);
  return s;
}

const run = (s, apply = applyRecognitionReceipt, reasons = () => []) =>
  materializeRecognition(s.input, s.state, [s.binding], s.policies, apply, cutoff, reasons);
const recognized = (output) => output.facts.filter((fact) => fact.metricId === "evidence_reviews");
const proof = (s) => ({
  pathPolicy: s.binding.documentationReview.pathPolicy,
  checklist: s.binding.documentationReview.checklist,
  record: s.record,
  review: JSON.parse(s.request.detail),
});
const receipt = (s) => ({
  id: s.decision.id,
  verified: true,
  metricId: "evidence_reviews",
  actorId: s.request.owner,
  reviewerId: s.decision.actor,
  acceptedAt,
  decision: "accepted",
  targetFactId: s.target.id,
  evidenceIds: [s.target.id],
  documentationReview: proof(s),
});

function aggregate(input, end = cutoff) {
  return aggregateMetric(
    {
      datasetId: "fixture-documentation-review",
      cutoff,
      backfillRevision: "1",
      repositoryIds: ["2"],
      actors: input.actors,
      facts: input.facts,
      coverage: [],
    },
    policy,
    {
      timezone: "UTC",
      from: null,
      to: end,
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
  );
}

function appendSource(s, input) {
  const factIds = new Set(s.input.facts.map((fact) => fact.id));
  const evidenceIds = new Set(s.input.evidence.map((entry) => entry.contribution.contributionId));
  s.input.facts.push(...input.facts.filter((fact) => !factIds.has(fact.id)));
  s.input.evidence.push(...input.evidence.filter((entry) => !evidenceIds.has(entry.contribution.contributionId)));
}

function alias(s, id = "later-alias", offset = 1000) {
  const request = structuredClone(s.request);
  request.id = id;
  request.history[0].id = id + "-decision";
  request.history[0].at += offset;
  request.history[0].receipt = id;
  const record = {
    ...structuredClone(s.record),
    requestId: id,
    decisionId: request.history[0].id,
  };
  s.binding.documentationReview.records.push(record);
  request.detail = JSON.stringify(detail(s, record));
  s.state.requests[id] = request;
  consent(s, request);
  return { request, record };
}

for (const state of ["COMMENTED", "APPROVED"]) {
  test(`documentation review: ${state} needs its independent checklist and counts the original reviewer once`, () => {
    const s = scenario({ state });
    const original = structuredClone(s.input);
    const output = run(s);
    const facts = recognized(output);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].actorId, "202");
    assert.equal(facts[0].subjectActorId, "101");
    assert.equal(facts[0].role, "reviewer");
    assert.equal(facts[0].quantity, undefined);
    assert.equal(facts[0].acceptedAt, acceptedAt);
    assert.deepEqual(output.facts.slice(0, original.facts.length), original.facts);
    assert.deepEqual(s.input, original);
    const accepted = output.evidence.find((entry) => entry.contribution.contributionId === facts[0].id);
    assert.equal(accepted.sourceRevision, head);
    assert.equal(accepted.sourceRevisionUrl, `https://github.com/${slug}/commit/${head}`);
    assert.deepEqual(accepted.contribution.roles, ["reviewer"]);
    assert.deepEqual(accepted.contribution.reasonCodes, ["independent_recognition_receipt"]);
    const result = aggregate(output);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].actorId, "202");
    assert.equal(result.rows[0].value, 1);
    assert.equal(result.rows[0].evidence[0].effectiveAt, acceptedAt);
    assert.deepEqual(aggregate(output, acceptedAt).rows, [], "Acceptance uses the existing half-open event window");
    assert.equal(result.publicEnabled, false);
  });
}

test("documentation review: exact head selection preserves two versions without generic PR ambiguity", () => {
  const s = scenario();
  const other = scenario({ revision: "c".repeat(40) });
  appendSource(s, other.input);
  const selected = run(s);
  assert.equal(recognized(selected).length, 1);
  const request = other.request;
  request.id = "second-version";
  request.history[0].id = "second-version-decision";
  other.record.requestId = request.id;
  other.record.decisionId = request.history[0].id;
  s.binding.documentationReview.records.push(other.record);
  request.detail = JSON.stringify(detail(s, other.record));
  s.state.requests[request.id] = request;
  consent(s, request);
  const both = run(s);
  assert.equal(recognized(both).length, 2);
  assert.equal(new Set(recognized(both).map((fact) => fact.canonicalKey)).size, 2);
  assert.equal(aggregate(both).rows[0].value, 2);
});

test("documentation review: aliases and repeated normalized deliveries conserve the earliest valid unit", () => {
  const s = scenario();
  const initial = aggregate(run(s));
  alias(s);
  for (const reverse of [false, true]) {
    if (reverse) s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
    const output = run(s);
    assert.equal(recognized(output).length, 1);
    assert.equal(recognized(output)[0].acceptanceReceipt, s.decision.id);
    assert.deepEqual(aggregate(output), initial);
    output.facts.push(...structuredClone(output.facts));
    assert.deepEqual(aggregate(output), initial);
  }
});

test("documentation review: an invalid later alias is rejected before any receipt or reason callback", () => {
  const s = scenario();
  const repeated = alias(s);
  repeated.record.sourceRevision = "unrelated-source-revision";
  repeated.request.detail = JSON.stringify(detail(s, repeated.record));
  consent(s, repeated.request);
  let receipts = 0;
  let reasons = 0;
  assert.throws(
    () =>
      run(
        s,
        () => receipts++,
        () => reasons++,
      ),
    /documentation_review_unverified/,
  );
  assert.equal(receipts, 0);
  assert.equal(reasons, 0);
});

test("documentation review: invocation snapshots keep later targets independent of host callback mutation", () => {
  const s = scenario();
  const other = scenario({ revision: "c".repeat(40) });
  appendSource(s, other.input);
  other.request.id = "later-version";
  other.decision.id = "later-version-decision";
  other.record.requestId = other.request.id;
  other.record.decisionId = other.decision.id;
  s.binding.documentationReview.records.push(other.record);
  other.request.detail = JSON.stringify(detail(s, other.record));
  s.state.requests[other.request.id] = other.request;
  consent(s, other.request);
  let calls = 0;
  const output = run(s, (input, current, reviewers) => {
    calls++;
    s.binding.documentationReview.records.length = 0;
    s.input.facts.length = 0;
    s.state.audit.length = 0;
    s.policies.length = 0;
    return applyRecognitionReceipt(input, current, reviewers);
  });
  assert.equal(calls, 2);
  assert.equal(recognized(output).length, 2);
});

for (const [name, change] of [
  [
    "self review",
    (s) => {
      s.target.subjectActorId = s.target.actorId;
    },
  ],
  [
    "unknown original author",
    (s) => {
      s.target.subjectActorId = null;
    },
  ],
  [
    "bot reviewer",
    (s) => {
      s.input.actors.find((actor) => actor.id === "202").kind = "bot";
    },
  ],
  [
    "automated reviewer",
    (s) => {
      s.input.actors.find((actor) => actor.id === "202").executionMode = "automated";
    },
  ],
  [
    "suppressed source actor",
    (s) => {
      s.input.actors.find((actor) => actor.id === "202").publicState = "suppressed";
    },
  ],
  [
    "synthetic observation",
    (s) => {
      s.input.isSynthetic = true;
    },
  ],
  [
    "synthetic source among real inputs",
    (s) => {
      s.input.syntheticFactIds = [s.target.id];
    },
  ],
  [
    "different reviewer",
    (s) => {
      s.evidence.contribution.actorId = "404";
    },
  ],
  [
    "private artifact",
    (s) => {
      s.evidence.artifact.visibility = "private";
    },
  ],
  [
    "changed source revision",
    (s) => {
      s.evidence.sourceRevision = "changed";
    },
  ],
  [
    "changed reviewed head",
    (s) => {
      s.target.rawState = "submitted_head:" + "d".repeat(40);
    },
  ],
  [
    "reused accepted source",
    (s) => {
      s.target.acceptanceReceipt = "older-receipt";
    },
  ],
  [
    "source after acceptance",
    (s) => {
      s.target.occurredAt = cutoff;
      s.target.observedAt = cutoff;
      s.evidence.occurredAt = cutoff;
      s.evidence.evidenceMetadata.sourceOccurredAt = cutoff;
      s.evidence.evidenceMetadata.observedAt = cutoff;
    },
  ],
  [
    "missing current audit",
    (s) => {
      s.state.audit = [];
    },
  ],
]) {
  test(`documentation review: rejects ${name} without converting raw review activity`, () => {
    const s = scenario();
    change(s);
    assert.throws(() => run(s), /documentation_review_unverified/);
  });
}

test("documentation review: checklist and classification require exact reviewed inputs", () => {
  const s = scenario();
  const original = structuredClone(s);
  for (const mutate of [
    (copy) => {
      copy.record.diff.complete = false;
    },
    (copy) => {
      copy.record.diff.after = "f".repeat(40);
    },
    (copy) => {
      copy.record.diff.files[0].path = "docs/generated/output.md";
    },
    (copy) => {
      copy.record.diff.files[0].formattingOnly = true;
    },
    (copy) => {
      copy.record.diff.files[0].additions = copy.record.diff.files[0].deletions = 0;
    },
  ]) {
    const copy = structuredClone(original);
    mutate(copy);
    assert.throws(() => run(copy), /documentation_review_unverified/);
  }
  const reviewed = JSON.parse(s.request.detail);
  reviewed.completedItems.pop();
  s.request.detail = JSON.stringify(reviewed);
  consent(s);
  assert.throws(() => run(s), /documentation_review_unverified/);
});

test("documentation review: generic approvals and mutated unreviewed detail cannot supply specialist authority", () => {
  const s = scenario();
  const direct = receipt(s);
  delete direct.documentationReview;
  assert.throws(() => applyRecognitionReceipt(s.input, direct, ["303"]), /Independent verified recognition receipt/);
  const unconfigured = structuredClone(s.binding);
  delete unconfigured.documentationReview;
  assert.throws(
    () => materializeRecognition(s.input, s.state, [unconfigured], s.policies, applyRecognitionReceipt, cutoff),
    /Independent verified recognition receipt/,
  );
  delete s.decision.sourceUseReview;
  s.state.audit = [structuredClone(s.decision)];
  assert.equal(recognized(run(s)).length, 0);
  const changed = scenario();
  const oldFingerprint = recognitionFingerprint(changed.state, [changed.binding]);
  changed.request.detail = JSON.stringify({ ...JSON.parse(changed.request.detail), head: "e".repeat(40) });
  assert.equal(recognized(run(changed)).length, 0);
  assert.notEqual(recognitionFingerprint(changed.state, [changed.binding]), oldFingerprint);
});

test("documentation review: absent exact source supplies no unit and cannot block another repository scope", () => {
  const s = scenario();
  s.input.facts = s.input.facts.filter((fact) => fact.id !== s.target.id);
  s.input.evidence = s.input.evidence.filter((entry) => entry.contribution.contributionId !== s.target.id);
  assert.equal(recognized(run(s)).length, 0);
  s.input.facts = [];
  s.input.evidence = [];
  s.policies = [];
  assert.equal(recognized(run(s)).length, 0);
});

test("documentation review: absent opt-in preserves existing private fingerprint bytes", () => {
  const state = { requests: {}, profiles: {}, audit: [] };
  const old = createHash("sha256")
    .update(JSON.stringify(["localization-review-target/v1", [], [], [], []]))
    .digest("hex");
  assert.equal(recognitionFingerprint(state, []), old);
  const s = scenario();
  assert.notEqual(recognitionFingerprint(s.state, [s.binding]), recognitionFingerprint(s.state, []));
});

test("documentation review: direct conversion cannot use arbitrary units or a different destination", () => {
  const s = scenario();
  const accepted = receipt(s);
  accepted.changesetId = "arbitrary-bulk-unit";
  const first = applyRecognitionReceipt(s.input, accepted, ["303"]);
  accepted.changesetId = "another-bulk-unit";
  assert.equal(recognized(first)[0].id, recognized(applyRecognitionReceipt(s.input, accepted, ["303"]))[0].id);
  accepted.metricId = "documentation";
  assert.throws(() => applyRecognitionReceipt(s.input, accepted, ["303"]), /documentation_review_unverified/);
  const raw = validateDocumentationReviewSource(s.input, s.target.id, acceptedAt, proof(s));
  assert.equal(raw.record.head, head);
  assert.notEqual(raw.record.head, "f".repeat(40), "No merge SHA is inferred from the reviewed head");
});

test("documentation review: constructor bounds the opt-in before cloning or later host callbacks", async (t) => {
  const { harness } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const h = await harness(t, { memoryDatabase: true });
  await h.runtime.stop();
  let getters = 0;
  let callbacks = 0;
  const guarded = {
    ...h.options,
    components: {
      ...h.options.components,
      github: {
        ...h.options.components.github,
        applyRecognitionReceipt() {
          callbacks++;
          throw new Error("late receipt");
        },
      },
    },
    verifyConfiguration() {
      callbacks++;
      return true;
    },
    normalizer() {
      callbacks++;
      throw new Error("late normalizer");
    },
  };
  let clones = 0;
  const guardedConfig = (binding) =>
    Object.defineProperty({ ...h.config, recognitionBindings: [binding] }, "cloneSentinel", {
      enumerable: true,
      get() {
        clones++;
        return "unexpected clone";
      },
    });
  const s = scenario();
  const invalid = structuredClone(s.binding);
  Object.defineProperty(invalid.documentationReview.records[0].diff.files[0], "path", {
    enumerable: true,
    get() {
      getters++;
      return "docs/guide.md";
    },
  });
  await assert.rejects(
    createPipeline({ ...guarded, config: guardedConfig(invalid) }),
    /documentation_review_unverified/,
  );
  assert.equal(getters, 0);
  assert.equal(callbacks, 0);
  const oversized = structuredClone(s.binding);
  oversized.documentationReview.checklist.items = ["x".repeat(200_000)];
  await assert.rejects(
    createPipeline({ ...guarded, config: guardedConfig(oversized) }),
    /documentation_review_unverified/,
  );
  assert.equal(getters, 0);
  assert.equal(callbacks, 0);
  assert.equal(clones, 0);
  assert.equal(validateDocumentationReviewBindings([s.binding]).size, 1);
  const valid = await createPipeline({
    ...h.options,
    config: { ...h.config, recognitionBindings: [s.binding] },
  });
  await valid.stop();
});

test("documentation review: current privacy and authority retire persisted proof after reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario();
  // This fixture remaps a real normalized review through the existing issue
  // collector harness. It tests persistence/authorization, not native collection.
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [structuredClone(pr)],
    normalizerFactory: () => async () => structuredClone(s.input),
    configure(config) {
      config.recognitionBindings = [s.binding];
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-metric-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = structuredClone(s.state.requests);
    state.audit = structuredClone(s.state.audit);
  });
  const published = await h.runtime.runOnce({ cutoff });
  assert.equal(published.state, "published");
  const snapshotId = published.publications[0].snapshotId;
  const read = (runtime) => runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  const original = await read(h.runtime);
  assert.equal(original.selected.rows[0].actorId, "202");
  assert.equal(original.selected.rows[0].result.value, 1);
  assert.doesNotMatch(
    JSON.stringify(original),
    /private-doc-review|proofHash|completedItems|reviewedInputDigest|fixture-substantive-review/,
  );
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  assert.equal((await read(restarted)).selected.rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    state.audit = [];
  });
  assert.equal(await read(restarted), null);
  await assert.rejects(restarted.aggregateExplanations.read(snapshotId), /authorization_changed/);
  h.controlsStore.transaction((state) => {
    state.audit = structuredClone(s.state.audit);
  });
  assert.equal((await read(restarted)).selected.rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await read(restarted), null);
  await assert.rejects(restarted.aggregateExplanations.read(snapshotId), /authorization_changed/);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id] = structuredClone(s.request);
  });
  assert.equal((await read(restarted)).selected.rows[0].result.value, 1);
  h.setPrivate(true);
  assert.equal(await read(restarted), null);
});
