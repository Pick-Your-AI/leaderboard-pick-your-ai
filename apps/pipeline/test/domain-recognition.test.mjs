// Fictional fixtures exercise the real-mode contract boundary in memory only.
// No records here are actual reviews, measurements, consent or source permission.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGithubObservation, applyRecognitionReceipt } from "@pick-your-ai/github";
import { aggregateMetric, getMetricDefinition, metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition } from "../src/recognition-adapter.mjs";
import { domainMetricIds, domainDateBasis } from "../src/domain-recognition.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const before = "b".repeat(40),
  after = "c".repeat(40),
  hash = "d".repeat(64);
const occurredAt = "2026-10-07T10:00:00.000Z";
const acceptedAt = "2026-10-09T10:00:00.000Z",
  cutoff = "2026-10-10T10:00:00.000Z";

function source(change = () => {}) {
  const envelope = {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: occurredAt, isSynthetic: false },
    family: "pull_request",
    action: "closed",
    occurredAt,
    observedAt: acceptedAt,
    payload: {
      repository: fixture.repository,
      pull_request: { ...structuredClone(fixture.pull_request), user: fixture.author, merge_commit_sha: after },
    },
    integration: {
      before,
      after,
      targetBranch: "main",
      defaultBranch: "main",
      canonicalChangeId: "synthetic-change",
      commitShas: [after],
      diff: { before, after, complete: true, files: [{ path: "docs/decision.md", additions: 2, deletions: 1 }] },
    },
  };
  change(envelope);
  return normalizeGithubObservation(envelope);
}
const details = {
  catalog_proposals: {
    canonicalKind: "model",
    canonicalId: "model:1",
    recordVersion: "v1",
    contractVersion: "v1",
    factualReview: true,
    sourceIds: ["source:1"],
  },
  pricebook_proposals: {
    pricebookId: "pricebook:1",
    pricebookVersion: "v1",
    asOf: occurredAt,
    currency: "USD",
    units: ["input_token"],
    conditionsHash: hash,
    sourceIds: ["source:1"],
    factualReview: true,
  },
  compatibility_proposals: {
    proposalId: "rule:1",
    proposalVersion: "v1",
    contractVersion: "v1",
    reviewIssue: "https://github.com/Pick-Your-AI/pick-your-ai-research/issues/40",
    centralDisposition: "accepted",
  },
  primary_sources: {
    canonicalSourceId: "publisher:canonical",
    claimId: "claim:1",
    sourceState: "available",
    evidenceClass: "publisher_statement",
  },
  freshness_checks: {
    canonicalSourceId: "publisher:canonical",
    claimId: "claim:1",
    checkedAt: occurredAt,
    outcome: "unavailable",
  },
  reproduced_measurements: {
    experimentId: "experiment:1",
    runId: "run:1",
    conditionsHash: hash,
    resultHash: hash,
    evidenceClass: "independent_measurement",
  },
  negative_findings: { findingId: "finding:1", findingVersion: "v1", outcome: "unknown", sourceIds: ["source:1"] },
  rights_reviews: {
    artifactId: "artifact:1",
    questionId: "display",
    termsRevision: "terms:v1",
    disposition: "unknown",
  },
  assumptions_resolved: { decisionId: "assumption:1", outcome: "unknown", sourceIds: ["source:1"] },
  market_research: {
    studyId: "study:1",
    studyVersion: "v1",
    method: "publisher_statement",
    participantData: "none",
    sourceIds: ["source:1"],
  },
  evidence_manifests: {
    artifactIdentity: "artifact:1",
    artifactHash: hash,
    sourceUse: "approved",
    sourceIds: ["source:1"],
  },
  documentation: { authorship: "authored", category: "guide", substantiveReview: true },
  tests: { authorship: "authored", category: "test_artifact", substantiveReview: true },
  regressions_prevented: {
    scenarioId: "race:1",
    fixtureHash: hash,
    beforeRevision: before,
    afterRevision: after,
    failsBefore: true,
    passesAfter: true,
  },
  accessibility: {
    artifactId: "journey:1",
    artifactVersion: "v1",
    phase: "audit",
    criteria: ["wcag:1.3.1"],
    reviewMethod: "automated",
  },
  design: { componentOrFlowId: "flow:1", designVersion: "v1", role: "author", publicAttribution: true },
  usability: {
    studyId: "study:1",
    studyVersion: "v1",
    method: "user_study",
    participantData: "approved_sanitized_aggregate",
    sourceIds: ["source:1"],
  },
  performance: {
    resultId: "result:1",
    scopeId: "workload:1",
    runId: "run:1",
    evidenceClass: "independent_measurement",
    before: {
      revision: before,
      conditionsHash: hash,
      metric: "latency",
      unit: "ms",
      value: "9007199254740993.0000001",
    },
    after: { revision: after, conditionsHash: hash, metric: "latency", unit: "ms", value: "9007199254740993.0000000" },
    direction: "lower_is_better",
  },
  security: {
    disclosureId: "public-advisory:1",
    disclosureVersion: "v1",
    publishedAt: occurredAt,
    publicDisclosureApproved: true,
    contributorConsent: true,
  },
};
function scenario(metric = "catalog_proposals") {
  const input = source(),
    candidate = input.facts.find((f) => f.metricId === "pr_merged");
  const evidence = input.evidence.find((e) => e.contribution.contributionId === candidate.id);
  const decision = {
    id: "private-review-receipt",
    actor: "202",
    action: "accepted",
    at: Date.parse(acceptedAt),
    version: 2,
    policyVersion: "domain-policy:v1",
  };
  const request = {
    id: "private-request",
    kind: "evidence",
    status: "accepted",
    owner: "101",
    version: 2,
    category: "other",
    scope: `repository:2:${metric}`,
    policyVersion: decision.policyVersion,
    locator: evidence.artifact.publicUrl,
    collaborators: {},
    history: [decision],
  };
  const record = {
    requestId: request.id,
    requestVersion: request.version,
    decisionId: decision.id,
    factId: candidate.id,
    sourceRevision: after,
    sourceRevisionUrl: `https://github.com/synthetic-owner/repository/commit/${after}`,
    validUntil: "2026-11-01T00:00:00.000Z",
    synthetic: false,
    publicSafe: true,
    details: structuredClone(details[metric]),
  };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: decision.policyVersion,
    metricId: metric,
    sourceMetricId: "pr_merged",
    repositoryId: "2",
    reviewerIds: ["202"],
    domainEvidence: {
      version: "domain-evidence/v1",
      ownerIds: ["202"],
      contractReviewerIds: ["202"],
      disclosureReviewerIds: ["202"],
      freshnessIntervalSeconds: 86400,
      records: [record],
    },
  };
  return {
    input,
    candidate,
    evidence,
    decision,
    request,
    record,
    binding,
    state: { requests: { [request.id]: request }, profiles: {}, audit: [decision] },
    policies: [
      {
        policy: {
          metricId: metric,
          version: decision.policyVersion,
          dateBasis: domainDateBasis(metric),
          groupBy: "canonical",
          rankedStates: ["qualified"],
        },
      },
    ],
  };
}
const run = (s) => materializeRecognition(s.input, s.state, [s.binding], s.policies, applyRecognitionReceipt, cutoff);
const qualified = (s) =>
  run(s).facts.filter((fact) => fact.metricId === s.binding.metricId && fact.state === "qualified");

const exclusions = {
  catalog_proposals: (s) => {
    s.record.details.factualReview = false;
  },
  pricebook_proposals: (s) => {
    s.record.details.currency = null;
  },
  compatibility_proposals: (s) => {
    s.binding.domainEvidence.contractReviewerIds = ["303"];
  },
  primary_sources: (s) => {
    s.record.details.sourceState = "unavailable";
  },
  freshness_checks: (s) => {
    s.record.details.checkedAt = "unknown";
  },
  reproduced_measurements: (s) => {
    s.record.details.evidenceClass = "publisher_statement";
  },
  negative_findings: (s) => {
    s.record.details.outcome = "failure_count";
  },
  rights_reviews: (s) => {
    s.record.details.disposition = "missing_terms_prove_prohibition";
  },
  assumptions_resolved: (s) => {
    s.record.details.outcome = null;
  },
  market_research: (s) => {
    s.record.details.method = "user_study";
  },
  evidence_manifests: (s) => {
    s.record.details.sourceUse = "excluded";
  },
  documentation: (s) => {
    s.record.details.authorship = "generated";
  },
  tests: (s) => {
    s.record.details.substantiveReview = false;
  },
  regressions_prevented: (s) => {
    s.record.details.failsBefore = false;
  },
  accessibility: (s) => {
    s.record.details.phase = "certified_accessible";
  },
  design: (s) => {
    s.record.details.role = "reviewer";
  },
  usability: (s) => {
    s.record.details.participantData = "recordings";
  },
  performance: (s) => {
    s.record.details.after.conditionsHash = "e".repeat(64);
  },
  security: (s) => {
    s.record.details.publicDisclosureApproved = false;
  },
};
for (const metric of domainMetricIds) {
  test(`${metric}: reviewed revision and metric-specific evidence qualify; its exclusion does not`, () => {
    const s = scenario(metric),
      original = structuredClone(s.input);
    const out = run(s),
      facts = out.facts.filter((fact) => fact.metricId === metric && fact.state === "qualified");
    assert.equal(facts.length, 1);
    assert.equal(facts[0].acceptedAt, acceptedAt);
    assert.deepEqual(s.input, original, "raw facts must not be edited by recognition");
    const added = out.evidence.slice(s.input.evidence.length);
    assert.equal(added.length, 1);
    assert.equal(added[0].sourceRevision, after);
    assert.equal(added[0].sourceRevisionUrl, s.record.sourceRevisionUrl);
    assert.equal(added[0].evidenceMetadata.sourceOccurredAt, s.evidence.evidenceMetadata.sourceOccurredAt);
    assert.doesNotMatch(
      JSON.stringify(added),
      /private-review-receipt|private-request|conditionsHash|participantData|sourceIds/,
    );
    assert.ok(added[0].contribution.reasonCodes.includes(`domain_metric:${metric}`));
    exclusions[metric](s);
    assert.throws(() => run(s), /domain_recognition_evidence_unverified/);
  });
}

test("a reviewer, matching URL or forged manifest cannot replace current exact source and audit bindings", () => {
  const mutations = [
    (s) => {
      s.record.sourceRevision = before;
    },
    (s) => {
      s.record.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/commit/${before}`;
    },
    (s) => {
      s.record.requestVersion--;
    },
    (s) => {
      s.request.version++;
      s.record.requestVersion = s.request.version;
    },
    (s) => {
      s.record.decisionId = "different-decision";
    },
    (s) => {
      s.record.factId = "unrelated-fact";
    },
    (s) => {
      s.record.synthetic = true;
    },
    (s) => {
      s.input.isSynthetic = true;
    },
    (s) => {
      s.input.syntheticFactIds = [s.candidate.id];
    },
    (s) => {
      s.record.publicSafe = false;
    },
    (s) => {
      s.record.validUntil = acceptedAt;
    },
    (s) => {
      s.binding.domainEvidence.ownerIds = ["303"];
    },
    (s) => {
      s.binding.domainEvidence.records.push(structuredClone(s.record));
    },
    (s) => {
      s.binding.domainEvidence.records = [];
    },
    (s) => {
      s.state.audit = [];
    },
    (s) => {
      s.state.audit.push(structuredClone(s.decision));
    },
    (s) => {
      s.request.collaborators["202"] = "accepted";
    },
    (s) => {
      s.evidence.sourceRevisionUrl = null;
    },
    (s) => {
      s.input.evidence.push(structuredClone(s.evidence));
    },
    (s) => {
      s.candidate.state = "unknown";
    },
    (s) => {
      s.candidate.role = "committer";
    },
    (s) => {
      s.candidate.role = "reviewer";
    },
    (s) => {
      s.record.details.rawParticipantData = "PRIVATE_SENTINEL";
    },
  ];
  for (const mutate of mutations) {
    const s = scenario();
    mutate(s);
    assert.throws(
      () => run(s),
      (error) => /unverified/.test(error.message) && !error.message.includes("PRIVATE_SENTINEL"),
    );
  }
});

test("mutable, intermediate or incomplete PR observations never acquire immutable recognition pins", () => {
  const changes = [
    (e) => {
      delete e.integration;
    },
    (e) => {
      e.integration.targetBranch = "feature";
      e.payload.pull_request.base.ref = "feature";
    },
    (e) => {
      e.integration.diff.complete = false;
    },
    (e) => {
      e.payload.pull_request.merge_commit_sha = before;
    },
    (e) => {
      e.repository.defaultBranch = "other";
    },
    (e) => {
      e.payload.pull_request.merged_at = cutoff;
    },
  ];
  for (const change of changes) {
    const out = source(change),
      merged = out.facts.find((f) => f.metricId === "pr_merged");
    const proof = out.evidence.find((entry) => entry.contribution.contributionId === merged.id);
    assert.equal(proof.sourceRevisionUrl, null);
    const s = scenario("documentation");
    s.input = out;
    assert.throws(() => run(s), /unverified/);
  }
});

test("event clocks preserve merge, acceptance, negative freshness and public-disclosure time", () => {
  for (const metric of ["documentation", "tests", "freshness_checks", "security"]) {
    const s = scenario(metric),
      out = run(s);
    const fact = out.facts.find((f) => f.metricId === metric && f.state === "qualified");
    assert.equal(fact.occurredAt, occurredAt);
    assert.equal(out.evidence.at(-1).occurredAt, occurredAt);
    s.policies[0].policy.dateBasis = "acceptedAt";
    assert.throws(() => run(s), /recognition_policy_not_configured/);
  }
  const s = scenario("catalog_proposals"),
    out = run(s);
  assert.equal(qualified(s)[0].occurredAt, occurredAt);
  assert.equal(out.evidence.at(-1).occurredAt, acceptedAt);
  const negative = scenario("freshness_checks");
  assert.ok(run(negative).evidence.at(-1).contribution.reasonCodes.includes("domain_outcome:unavailable"));
});

test("domain clocks normalize supported offsets and reject precision the metric engine cannot preserve", () => {
  for (const [metric, field] of [
    ["freshness_checks", "checkedAt"],
    ["security", "publishedAt"],
  ]) {
    const s = scenario(metric),
      original = qualified(s)[0];
    s.record.details[field] = "2026-10-07T12:00:00.000+02:00";
    const equivalent = qualified(s)[0];
    assert.equal(equivalent.occurredAt, occurredAt);
    assert.equal(equivalent.canonicalKey, original.canonicalKey);
    s.record.details[field] = "2026-10-09T10:00:00.0001Z";
    assert.throws(() => run(s), /domain_recognition_evidence_unverified/);
  }
  const asOf = scenario("pricebook_proposals");
  asOf.record.details.asOf = "2026-10-09T10:00:00.0001Z";
  assert.throws(() => run(asOf), /domain_recognition_evidence_unverified/);
  const validity = scenario();
  validity.record.validUntil = "2026-10-10T10:00:00.0001Z";
  assert.throws(() => run(validity), /domain_recognition_evidence_unverified/);
});

test("specialist policy preserves canonical units and separates reviewed credit from raw activity", () => {
  for (const mutate of [
    (s) => {
      s.policies[0].policy.groupBy = "actor_artifact";
    },
    (s) => {
      s.policies[0].policy.rankedStates = ["observed"];
    },
    (s) => {
      s.policies[0].policy.rankedStates = ["observed", "qualified"];
    },
  ]) {
    const s = scenario("documentation");
    mutate(s);
    assert.throws(() => run(s), /recognition_policy_not_configured/);
  }
});

test("the pipeline retains per-source synthetic provenance when flattening recognition inputs", async (t) => {
  const { harness, components } = await import("./harness.mjs");
  const s = scenario();
  for (const entry of s.input.evidence) {
    entry.artifact.publicUrl = entry.artifact.publicUrl.replace(
      "synthetic-owner/repository",
      "synthetic-org/synthetic-repo",
    );
    if (entry.sourceRevisionUrl)
      entry.sourceRevisionUrl = entry.sourceRevisionUrl.replace(
        "synthetic-owner/repository",
        "synthetic-org/synthetic-repo",
      );
  }
  s.request.locator = s.evidence.artifact.publicUrl;
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  const h = await harness(t, {
    payloads: [structuredClone(fixture.pull_request)],
    normalizerFactory: () => async () => ({ ...structuredClone(s.input), isSynthetic: true }),
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition(s.binding.metricId).definition.unit,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "synthetic-test-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  await assert.rejects(h.runtime.runOnce({ cutoff }), /domain_recognition_evidence_unverified/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots")).rows[0].n, 0);
});

test("canonical units deduplicate aliases independently of request insertion order", () => {
  const s = scenario("primary_sources"),
    duplicate = structuredClone(s.request);
  duplicate.id = "duplicate-request";
  duplicate.history[0].id = "duplicate-decision";
  duplicate.history[0].at += 1000;
  s.state.requests[duplicate.id] = duplicate;
  s.state.audit.push(duplicate.history[0]);
  s.binding.domainEvidence.records.push({
    ...structuredClone(s.record),
    requestId: duplicate.id,
    decisionId: duplicate.history[0].id,
  });
  const result = qualified(s);
  assert.equal(result.length, 1);
  assert.equal(result[0].acceptedAt, acceptedAt);
  s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
  assert.deepEqual(qualified(s), result);
  const other = scenario("catalog_proposals"),
    initial = qualified(other)[0].canonicalKey;
  other.record.details.recordVersion = "v2";
  assert.notEqual(
    qualified(other)[0].canonicalKey,
    initial,
    "a separately reviewed canonical record version is a separate unit",
  );
});

test("new proof for an existing canonical unit cannot create extra credit", () => {
  const variations = {
    pricebook_proposals: (s) => {
      s.record.details.currency = "EUR";
      s.record.details.conditionsHash = "e".repeat(64);
    },
    rights_reviews: (s) => {
      s.record.details.termsRevision = "terms:v2";
    },
    negative_findings: (s) => {
      s.record.details.findingVersion = "v2";
    },
    market_research: (s) => {
      s.record.details.studyVersion = "v2";
    },
    usability: (s) => {
      s.record.details.studyVersion = "v2";
    },
    security: (s) => {
      s.record.details.disclosureVersion = "v2";
    },
    regressions_prevented: (s) => {
      const revised = "e".repeat(40);
      s.record.details.afterRevision = revised;
      s.record.sourceRevision = revised;
      s.record.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/commit/${revised}`;
      s.evidence.sourceRevision = revised;
      s.evidence.sourceRevisionUrl = s.record.sourceRevisionUrl;
    },
    accessibility: (s) => {
      s.record.details.criteria.push("wcag:2.4.1");
      s.record.details.reviewMethod = "manual";
    },
    performance: (s) => {
      s.record.details.runId = "run:2";
      s.record.details.after.value = "800.1";
    },
    primary_sources: (s) => {
      s.record.details.evidenceClass = "primary_source";
    },
  };
  for (const [metric, mutate] of Object.entries(variations)) {
    const s = scenario(metric),
      original = qualified(s)[0].canonicalKey;
    mutate(s);
    assert.equal(qualified(s)[0].canonicalKey, original, `${metric}: proof details are not new work units`);
  }
  const docs = scenario("documentation"),
    original = qualified(docs)[0].canonicalKey;
  docs.record.details.category = "example";
  assert.notEqual(
    qualified(docs)[0].canonicalKey,
    original,
    "separately reviewed PR documentation categories are distinct",
  );
  const freshness = scenario("freshness_checks"),
    recheck = qualified(freshness)[0].canonicalKey;
  freshness.record.details.checkedAt = "2026-10-07T11:00:00.000Z";
  assert.equal(qualified(freshness)[0].canonicalKey, recheck);
  freshness.record.details.checkedAt = "2026-10-08T11:00:00.000Z";
  assert.notEqual(
    qualified(freshness)[0].canonicalKey,
    recheck,
    "a reviewed recheck in a new policy interval is distinct",
  );
});

test("the metric engine counts separately reviewed documentation categories while conserving duplicate requests", () => {
  const s = scenario("documentation");
  for (const [suffix, category] of [
    ["duplicate", "guide"],
    ["distinct", "example"],
  ]) {
    const request = structuredClone(s.request);
    request.id += ":" + suffix;
    request.history[0].id += ":" + suffix;
    request.history[0].at += 1000;
    s.state.requests[request.id] = request;
    s.state.audit.push(request.history[0]);
    s.binding.domainEvidence.records.push({
      ...structuredClone(s.record),
      requestId: request.id,
      decisionId: request.history[0].id,
      details: { ...s.record.details, category },
    });
  }
  const normalized = run(s);
  const policy = {
    ...s.policies[0].policy,
    definitionVersion: metricRegistryV1.policy_version,
    unit: getMetricDefinition("documentation").definition.unit,
    aggregation: "count",
    roles: ["author"],
    sources: ["github_rest"],
    minimumSamples: 1,
    rank: false,
  };
  const result = aggregateMetric(
    {
      datasetId: "synthetic-domain",
      cutoff,
      backfillRevision: "1",
      repositoryIds: ["2"],
      actors: normalized.actors,
      facts: normalized.facts,
      coverage: [],
    },
    policy,
    {
      timezone: "UTC",
      from: null,
      to: cutoff,
      repos: [],
      projects: [],
      workstreams: [],
      roles: [],
      actors: "all",
      context: "event",
    },
  );
  assert.equal(result.rows.find((row) => row.actorId === "101").value, 2);
  assert.equal(normalized.facts.filter((fact) => fact.metricId === "pr_merged").length, 1);
});

test("withdrawal, suppression, renewed review and future event times cannot retain obsolete recognition", () => {
  for (const status of ["withdrawn", "pending", "appealed", "rejected"]) {
    const s = scenario();
    s.request.status = status;
    assert.deepEqual(qualified(s), []);
  }
  const s = scenario();
  s.state.profiles["101"] = { suppressed: true };
  assert.deepEqual(qualified(s), []);
  for (const metric of ["freshness_checks", "security"]) {
    const future = scenario(metric);
    future.record.details[metric === "security" ? "publishedAt" : "checkedAt"] = cutoff;
    assert.throws(() => run(future), /unverified/);
  }
});

test("performance qualification requires exact comparable real conditions and an actual improvement", () => {
  for (const mutate of [
    (s) => {
      s.record.details.after.value = s.record.details.before.value;
    },
    (s) => {
      s.record.details.after.unit = "seconds";
    },
    (s) => {
      s.record.details.after.metric = "throughput";
    },
    (s) => {
      s.record.details.after.revision = before;
    },
    (s) => {
      s.record.details.evidenceClass = "publisher_statement";
    },
    (s) => {
      s.record.details.before.value = "NaN";
    },
    (s) => {
      s.record.details.before.value = "1e1000000";
    },
    (s) => {
      s.record.details.after.value = "-1";
    },
  ]) {
    const s = scenario("performance");
    mutate(s);
    assert.throws(() => run(s), /unverified/);
  }
});
