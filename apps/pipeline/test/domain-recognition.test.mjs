// Fictional fixtures exercise the real-mode contract boundary in memory only.
// No records here are actual reviews, measurements, consent or source permission.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  defaultDeliveryNormalizationVersion,
} from "@pick-your-ai/github";
import {
  aggregateMetric,
  getMetricDefinition,
  getMetricUi,
  metricRegistryV1,
  selectMetricView,
} from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { domainMetricIds, domainDateBasis } from "../src/domain-recognition.mjs";
import { evidenceIntakeAuthority } from "../../controls/src/evidence-intake.mjs";
import {
  attachSyntheticEvidenceIntake,
  attachSyntheticEvidenceState,
} from "../../../tests/fixtures/evidence-intake.mjs";

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
  data_quality: {
    canonicalKind: "model",
    canonicalId: "model:1",
    correctionId: "correction:1",
    correctionVersion: "v1",
    correctionType: "incorrect",
    factualReview: true,
    sourceIds: ["source:1"],
    before: {
      revision: before,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/commit/${before}`,
      contentHash: "e".repeat(64),
    },
    after: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/commit/${after}`,
      contentHash: hash,
    },
    origin: { kind: "prior_contributors", complete: true, contributorIds: ["303"] },
  },
  reproductions: {
    targetKind: "issue",
    targetId: "issue:1",
    scenarioId: "scenario:1",
    scenarioVersion: "v1",
    runId: "run:1",
    completedAt: occurredAt,
    executionComplete: true,
    scenarioAccepted: true,
    outcome: "reproduced",
    scenario: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${after}/reproduction/scenario.md`,
      contentHash: hash,
    },
    environment: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${after}/reproduction/environment.json`,
      contentHash: "e".repeat(64),
    },
    result: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${after}/reproduction/result.json`,
      contentHash: "f".repeat(64),
    },
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
    findingId: "finding:1",
    findingVersion: "v1",
    findingAccepted: true,
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
  governance: {
    decisionId: "decision:1",
    decisionVersion: "v1",
    kind: "governance_decision",
    disposition: "accepted",
    publicRecord: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${after}/docs/governance.md`,
      contentHash: hash,
    },
  },
  deployment_work: {
    workArtifactId: "deployment-work:1",
    workVersion: "v1",
    workKind: "deployment_improvement",
    deploymentIds: ["deployment:1"],
    sourceUse: "approved_public",
    publicRecord: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${after}/docs/deployment.md`,
      contentHash: hash,
    },
  },
  incidents: {
    contributionId: "reliability-work:1",
    contributionVersion: "v1",
    workKind: "postmortem",
    narrativeApproved: true,
    publicRecord: {
      revision: after,
      sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${after}/docs/postmortem.md`,
      contentHash: hash,
    },
  },
};
function scenario(metric = "catalog_proposals", requestOverrides = {}) {
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
    ...requestOverrides,
  };
  attachSyntheticEvidenceIntake(request);
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

for (const outcome of ["reproduced", "not_reproduced", "inconclusive"]) {
  test(`reproductions: an independently accepted executed ${outcome} scenario contributes without confirming a bug`, () => {
    const s = scenario("reproductions"),
      original = structuredClone(s.input);
    s.record.details.outcome = outcome;
    const out = run(s),
      facts = out.facts.filter((fact) => fact.metricId === "reproductions");
    assert.equal(facts.length, 1);
    assert.equal(facts[0].acceptedAt, acceptedAt);
    assert.equal(facts[0].role, "author");
    assert.equal(
      out.facts.some((fact) => fact.metricId === "confirmed_bugs"),
      false,
    );
    assert.deepEqual(out.evidence.at(-1).contribution.reasonCodes, [
      "independent_recognition_receipt",
      "domain_metric:reproductions",
      "domain_clock:accepted_at",
      "accepted_reproduction_scenario_not_bug_confirmation",
      `domain_outcome:${outcome}`,
    ]);
    assert.deepEqual(s.input, original);
    assert.doesNotMatch(
      JSON.stringify(out.evidence.at(-1)),
      /scenario:1|run:1|scenarioVersion|contentHash|private-request/,
    );
  });
}

test("reproductions: generic receipts, unexecuted work and unbound source authority cannot qualify", async (t) => {
  const cases = [
    [
      "missing specialist evidence",
      (s) => {
        delete s.binding.domainEvidence;
      },
    ],
    [
      "missing completed execution",
      (s) => {
        s.record.details.executionComplete = false;
      },
    ],
    [
      "missing scenario acceptance",
      (s) => {
        s.record.details.scenarioAccepted = false;
      },
    ],
    [
      "no result",
      (s) => {
        s.record.details.outcome = null;
      },
    ],
    [
      "unexecuted result",
      (s) => {
        s.record.details.outcome = "not_run";
      },
    ],
    [
      "inferred bug confirmation",
      (s) => {
        s.record.details.outcome = "confirmed_bug";
      },
    ],
    [
      "reviewer lacks affected-owner authority",
      (s) => {
        s.binding.domainEvidence.ownerIds = ["303"];
      },
    ],
    [
      "current collaborator review",
      (s) => {
        s.request.collaborators["202"] = "accepted";
      },
    ],
    [
      "missing audit",
      (s) => {
        s.state.audit = [];
      },
    ],
    [
      "stale request version",
      (s) => {
        s.request.version++;
      },
    ],
    [
      "unsupported commenter attribution",
      (s) => {
        s.candidate.role = "commenter";
      },
    ],
    [
      "unsupported issue source",
      (s) => {
        s.evidence.artifact.kind = "issue";
      },
    ],
    [
      "unmerged PR",
      (s) => {
        s.candidate.rawState = "closed_unmerged";
      },
    ],
    [
      "same-metric generic source",
      (s) => {
        s.binding.sourceMetricId = s.candidate.metricId = "reproductions";
      },
    ],
    [
      "future execution",
      (s) => {
        s.record.details.completedAt = acceptedAt;
      },
    ],
    [
      "finer execution clock",
      (s) => {
        s.record.details.completedAt = "2026-10-07T10:00:00.0001Z";
      },
    ],
    [
      "unknown execution clock",
      (s) => {
        s.record.details.completedAt = "unknown";
      },
    ],
    [
      "future source merge",
      (s) => {
        s.candidate.occurredAt = cutoff;
      },
    ],
    [
      "private extra field",
      (s) => {
        s.record.details.privateResult = "PRIVATE_SENTINEL";
      },
    ],
    ...["targetKind", "targetId", "scenarioId", "scenarioVersion", "runId"].flatMap((key) => [
      [
        `${key} trailing newline`,
        (s) => {
          s.record.details[key] += "\n";
        },
      ],
      [
        `${key} overlong identity`,
        (s) => {
          s.record.details[key] = "a".repeat(201);
        },
      ],
    ]),
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const s = scenario(
        "reproductions",
        name === "current collaborator review" ? { collaborators: { 202: "accepted" } } : {},
      );
      mutate(s);
      if (name === "stale request version") assert.deepEqual(run(s), s.input);
      else
        assert.throws(
          () => run(s),
          (error) => /unverified/.test(error.message) && !error.message.includes("PRIVATE_SENTINEL"),
        );
    });
  }
});

test("reproductions: each scenario, environment and result proof needs the exact collected immutable revision", async (t) => {
  for (const key of ["scenario", "environment", "result"]) {
    const cases = [
      [
        "missing proof",
        (s) => {
          delete s.record.details[key];
        },
      ],
      [
        "missing hash",
        (s) => {
          delete s.record.details[key].contentHash;
        },
      ],
      [
        "newline hash",
        (s) => {
          s.record.details[key].contentHash += "\n";
        },
      ],
      [
        "mismatched revision",
        (s) => {
          s.record.details[key].revision = before;
        },
      ],
      [
        "mutable revision",
        (s) => {
          s.record.details[key].sourceRevisionUrl =
            `https://github.com/synthetic-owner/repository/blob/main/reproduction/${key}`;
        },
      ],
      [
        "another immutable version",
        (s) => {
          s.record.details[key].revision = before;
          s.record.details[key].sourceRevisionUrl = s.record.details[key].sourceRevisionUrl.replace(after, before);
        },
      ],
      [
        "another repository",
        (s) => {
          s.record.details[key].sourceRevisionUrl = s.record.details[key].sourceRevisionUrl.replace(
            "/repository/",
            "/other/",
          );
        },
      ],
      [
        "commit without artifact",
        (s) => {
          s.record.details[key].sourceRevisionUrl = s.record.sourceRevisionUrl;
        },
      ],
      [
        "empty path segment",
        (s) => {
          s.record.details[key].sourceRevisionUrl = s.record.details[key].sourceRevisionUrl.replace(
            "/reproduction/",
            "/reproduction//",
          );
        },
      ],
      [
        "query string",
        (s) => {
          s.record.details[key].sourceRevisionUrl += "?raw=1";
        },
      ],
      [
        "fragment",
        (s) => {
          s.record.details[key].sourceRevisionUrl += "#result";
        },
      ],
      [
        "encoded path",
        (s) => {
          s.record.details[key].sourceRevisionUrl += "%2Fprivate";
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      await t.test(`${key}: ${name}`, () => {
        const s = scenario("reproductions");
        mutate(s);
        assert.throws(() => run(s), /domain_recognition_evidence_unverified/);
      });
    }
  }
  const combined = scenario("reproductions");
  combined.record.details.environment = structuredClone(combined.record.details.scenario);
  combined.record.details.result = structuredClone(combined.record.details.scenario);
  assert.equal(
    qualified(combined).length,
    1,
    "One reviewed combined artifact may explicitly carry all three proof roles",
  );
  combined.record.details.result.contentHash = "e".repeat(64);
  assert.throws(() => run(combined), /domain_recognition_evidence_unverified/);
});

test("reproductions: scenario identity survives reruns, proof and outcome revisions", () => {
  const s = scenario("reproductions"),
    original = qualified(s)[0].canonicalKey;
  s.record.details.scenarioVersion = "v2";
  s.record.details.runId = "run:2";
  s.record.details.completedAt = "2026-10-07T09:59:59.999Z";
  s.record.details.outcome = "not_reproduced";
  s.record.details.environment.contentHash = "a".repeat(64);
  s.record.details.result.contentHash = "b".repeat(64);
  assert.equal(qualified(s)[0].canonicalKey, original);
  for (const key of ["targetKind", "targetId", "scenarioId"]) {
    const distinct = scenario("reproductions");
    distinct.record.details[key] += ":separately-reviewed";
    assert.notEqual(qualified(distinct)[0].canonicalKey, original);
  }
});

test("reproductions: full 64-character source revisions bind all three reviewed artifact roles", () => {
  const s = scenario("reproductions"),
    revision = "a".repeat(64);
  s.input = source((envelope) => {
    envelope.payload.pull_request.merge_commit_sha = revision;
    envelope.integration.before = "b".repeat(64);
    envelope.integration.after = revision;
    envelope.integration.commitShas = [revision];
    envelope.integration.diff.before = envelope.integration.before;
    envelope.integration.diff.after = revision;
  });
  s.candidate = s.input.facts.find((fact) => fact.metricId === "pr_merged");
  s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
  s.record.factId = s.candidate.id;
  s.record.sourceRevision = revision;
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  for (const key of ["scenario", "environment", "result"]) {
    s.record.details[key].revision = revision;
    s.record.details[key].sourceRevisionUrl = s.record.details[key].sourceRevisionUrl.replace(after, revision);
  }
  assert.equal(qualified(s).length, 1);
  assert.equal(run(s).evidence.at(-1).sourceRevision, revision);
  s.record.details.environment.revision = after;
  assert.throws(() => run(s), /domain_recognition_evidence_unverified/);
});

test("data_quality: an independently accepted correction becomes a qualified canonical unit", () => {
  const s = scenario("data_quality");
  s.policies[0].policy.dateBasis = "acceptedAt";
  const normalized = run(s);
  const corrected = normalized.facts.filter((fact) => fact.metricId === "data_quality");
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].state, "qualified");
  assert.equal(corrected[0].acceptedAt, acceptedAt);
  assert.equal(corrected[0].actorId, s.request.owner);
  assert.deepEqual(normalized.facts.slice(0, s.input.facts.length), s.input.facts);
});

test("data_quality: a host-normalized correction fact cannot bypass its specialist evidence review", () => {
  const s = scenario("data_quality");
  s.candidate.metricId = s.binding.sourceMetricId = "data_quality";
  s.candidate.state = "observed";
  s.evidence.contribution.metricIds = ["data_quality"];
  assert.equal(qualified(s).length, 1);
  delete s.binding.domainEvidence;
  assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
});

test("data_quality: corrected records and externally stale records retain exact immutable source pins", () => {
  for (const length of [40, 64]) {
    for (const locator of ["commit", "blob"]) {
      const s = scenario("data_quality");
      for (const [index, pin] of [s.record.details.before, s.record.details.after].entries()) {
        pin.revision = (index ? "c" : "b").repeat(length);
        pin.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/${locator}/${pin.revision}${locator === "blob" ? "/catalog/models.json" : ""}`;
      }
      s.record.sourceRevision = s.evidence.sourceRevision = s.record.details.after.revision;
      s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl = s.record.details.after.sourceRevisionUrl;
      assert.equal(qualified(s).length, 1);
      s.record.details.correctionType = "stale";
      s.record.details.origin = { kind: "external_source_change", complete: true, contributorIds: [] };
      s.candidate.role = "coauthor";
      assert.equal(qualified(s).length, 1, "Reviewed external staleness is not inferred from absent authorship");
      const proof = run(s).evidence.at(-1);
      assert.equal(proof.sourceRevisionUrl, s.record.details.after.sourceRevisionUrl);
      assert.equal(proof.sourceRevision, s.record.details.after.revision);
      assert.doesNotMatch(
        JSON.stringify(proof),
        /correction:1|source:1|prior_contributors|external_source_change|contentHash/,
      );
    }
  }
});

test("data_quality: missing origin knowledge and self-introduced errors cannot earn correction credit", async (t) => {
  for (const [name, mutate] of [
    [
      "unknown origin",
      (s) => {
        s.record.details.origin.kind = "unknown";
      },
    ],
    [
      "incomplete prior attribution",
      (s) => {
        s.record.details.origin.complete = false;
      },
    ],
    [
      "missing prior attribution",
      (s) => {
        s.record.details.origin.contributorIds = [];
      },
    ],
    [
      "claimant introduced the error",
      (s) => {
        s.record.details.origin.contributorIds.push(s.request.owner);
      },
    ],
    [
      "collaborator introduced the error",
      (s) => {
        s.request.collaborators["303"] = "accepted";
      },
    ],
    [
      "unknown cause disguised as external change",
      (s) => {
        s.record.details.origin = { kind: "external_source_change", complete: true, contributorIds: [] };
      },
    ],
    [
      "external change retains ambiguous contributors",
      (s) => {
        s.record.details.correctionType = "stale";
        s.record.details.origin.kind = "external_source_change";
      },
    ],
    [
      "duplicate origin identities",
      (s) => {
        s.record.details.origin.contributorIds.push("303");
      },
    ],
    [
      "trailing-newline origin alias",
      (s) => {
        s.record.details.origin.contributorIds = ["101\n"];
      },
    ],
    [
      "origin identity beyond the bound",
      (s) => {
        s.record.details.origin.contributorIds = ["a".repeat(201)];
      },
    ],
    [
      "reviewer lacks affected-owner authority",
      (s) => {
        s.binding.domainEvidence.ownerIds = ["303"];
      },
    ],
    [
      "review participation is not correction authorship",
      (s) => {
        s.candidate.role = "reviewer";
      },
    ],
  ])
    await t.test(name, () => {
      const s = scenario(
        "data_quality",
        name === "collaborator introduced the error" ? { collaborators: { 303: "accepted" } } : {},
      );
      mutate(s);
      assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
      assert.equal(
        s.input.facts.some((fact) => fact.metricId === "data_quality"),
        false,
      );
    });
});

test("data_quality: correction proof cannot substitute mutable, unrelated or unchanged evidence", async (t) => {
  for (const [name, mutate] of [
    [
      "unreviewed factual change",
      (s) => {
        s.record.details.factualReview = false;
      },
    ],
    [
      "missing source identity",
      (s) => {
        s.record.details.sourceIds = [];
      },
    ],
    [
      "trailing-newline source identity",
      (s) => {
        s.record.details.sourceIds = ["source:1\n"];
      },
    ],
    [
      "trailing-newline correction identity",
      (s) => {
        s.record.details.correctionId += "\n";
      },
    ],
    [
      "duplicate source identities",
      (s) => {
        s.record.details.sourceIds.push("source:1");
      },
    ],
    [
      "changed revision with identical content",
      (s) => {
        s.record.details.before.contentHash = hash;
      },
    ],
    [
      "unchanged revision with invented new content",
      (s) => {
        s.record.details.before.revision = after;
        s.record.details.before.sourceRevisionUrl = s.record.details.after.sourceRevisionUrl;
      },
    ],
    [
      "intermediate hash length",
      (s) => {
        s.record.details.before.revision = "b".repeat(41);
        s.record.details.before.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/commit/${s.record.details.before.revision}`;
      },
    ],
    [
      "trailing-newline content hash",
      (s) => {
        s.record.details.before.contentHash += "\n";
      },
    ],
    [
      "source file from another repository",
      (s) => {
        s.record.details.before.sourceRevisionUrl = s.record.details.before.sourceRevisionUrl.replace(
          "/repository/",
          "/different/",
        );
      },
    ],
    [
      "commit substituted for a file",
      (s) => {
        s.record.details.before.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${before}/catalog/models.json`;
      },
    ],
    [
      "different files inside the same commit pair",
      (s) => {
        s.record.details.before.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${before}/catalog/models.json`;
        s.record.details.after.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${after}/catalog/prices.json`;
        s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl = s.record.details.after.sourceRevisionUrl;
      },
    ],
    [
      "mutable branch URL",
      (s) => {
        s.record.details.before.sourceRevisionUrl =
          "https://github.com/synthetic-owner/repository/blob/main/catalog/models.json";
      },
    ],
    [
      "empty blob locator",
      (s) => {
        for (const pin of [s.record.details.before, s.record.details.after])
          pin.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${pin.revision}/`;
        s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl = s.record.details.after.sourceRevisionUrl;
      },
    ],
    [
      "empty interior file segment",
      (s) => {
        for (const pin of [s.record.details.before, s.record.details.after])
          pin.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${pin.revision}/catalog//models.json`;
        s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl = s.record.details.after.sourceRevisionUrl;
      },
    ],
    [
      "after pin not collected",
      (s) => {
        s.record.details.after.revision = "a".repeat(40);
        s.record.details.after.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/commit/${s.record.details.after.revision}`;
      },
    ],
    [
      "after locator not collected",
      (s) => {
        for (const pin of [s.record.details.before, s.record.details.after])
          pin.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${pin.revision}/catalog/models.json`;
      },
    ],
    [
      "extra private proof field",
      (s) => {
        s.record.details.before.privateText = "PRIVATE_SENTINEL";
      },
    ],
  ])
    await t.test(name, () => {
      const s = scenario("data_quality");
      mutate(s);
      assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
    });
});

test("data_quality: later proof versions conserve a correction while separately accepted corrections remain distinct", () => {
  const s = scenario("data_quality");
  const original = qualified(s)[0].canonicalKey;
  s.record.details.correctionVersion = "v2";
  s.record.details.sourceIds.push("source:2");
  s.record.details.before.contentHash = "f".repeat(64);
  assert.equal(qualified(s)[0].canonicalKey, original);
  for (const [suffix, correctionId] of [
    ["proof", "correction:1"],
    ["other", "correction:2"],
  ]) {
    const request = structuredClone(s.request);
    request.id += `:${suffix}`;
    request.history[0].id += `:${suffix}`;
    request.history[0].at += 1000;
    request.history[0].receipt = request.id;
    attachSyntheticEvidenceIntake(request);
    s.state.requests[request.id] = request;
    s.state.audit.push(request.history[0]);
    s.binding.domainEvidence.records.push({
      ...structuredClone(s.record),
      requestId: request.id,
      decisionId: request.history[0].id,
      details: { ...structuredClone(s.record.details), correctionId, correctionVersion: "v3" },
    });
  }
  const result = aggregateDomain(s, run(s));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].value, 2);
  assert.equal(qualified(s).find((fact) => fact.canonicalKey === original).acceptedAt, acceptedAt);
  s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
  assert.deepEqual(aggregateDomain(s, run(s)), result);
  for (const status of ["pending", "withdrawn", "appealed", "rejected"]) {
    for (const request of Object.values(s.state.requests)) request.status = status;
    assert.deepEqual(qualified(s), []);
  }
  for (const request of Object.values(s.state.requests)) request.status = "accepted";
  s.state.profiles["101"] = { suppressed: true };
  assert.deepEqual(qualified(s), []);
});

// Exact pre-correction authority format for these single-request fixtures.
// This independently pins compatibility rather than calling the current helper.
function legacyDomainFingerprint(s, bindings = [s.binding]) {
  return createHash("sha256")
    .update(JSON.stringify(["localization-review-target/v1", [s.request], [], [JSON.stringify(s.decision)], bindings]))
    .digest("hex");
}

function beforeReproductionFingerprint(s, bindings = [s.binding]) {
  const authority = ["localization-review-target/v1", [s.request], [], [JSON.stringify(s.decision)], bindings];
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

// The earlier single-request oracles above remain literal. This separately
// spells their empty-source form so manual-intake retirement cannot mask an
// accidental change to unrelated automatic-source authority.
function emptyDomainAuthority(bindings, correctionFence = false) {
  const authority = ["localization-review-target/v1", [], [], [], bindings];
  if (correctionFence && bindings.some((binding) => binding.metricId === "data_quality"))
    authority.push("data-quality-recognition/v1");
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("reproductions: its configuration fence preserves automatic-source authority while manual intake retires old claims", () => {
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of domainMetricIds) {
    const s = scenario(metric);
    assert.notEqual(
      recognitionFingerprint(s.state, [s.binding]),
      beforeReproductionFingerprint(s),
      `${metric}: manual intake retires prior claim authority`,
    );
    const current = recognitionFingerprint(empty, [s.binding]),
      previous = emptyDomainAuthority([s.binding], true);
    if (
      ["reproductions", "governance", "deployment_work", "incidents"].includes(metric) ||
      ["performance", "regressions_prevented"].includes(metric)
    )
      assert.notEqual(current, previous);
    else assert.equal(current, previous, `${metric}: exact prior authority bytes survive`);
  }
  const s = scenario("documentation"),
    mixed = [s.binding, scenario("data_quality").binding, scenario("reproductions").binding];
  assert.notEqual(recognitionFingerprint(s.state, mixed), beforeReproductionFingerprint(s, mixed));
  const unaffected = mixed.slice(0, 2);
  assert.notEqual(recognitionFingerprint(s.state, unaffected), beforeReproductionFingerprint(s, unaffected));
  assert.notEqual(recognitionFingerprint(empty, mixed), emptyDomainAuthority(mixed, true));
  assert.equal(recognitionFingerprint(empty, unaffected), emptyDomainAuthority(unaffected, true));
});

test("data_quality: qualifier authority preserves other automatic sources while manual intake retires old publications", () => {
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of domainMetricIds) {
    const s = scenario(metric);
    assert.notEqual(
      recognitionFingerprint(s.state, [s.binding]),
      legacyDomainFingerprint(s),
      `${metric}: manual intake retires prior claim authority`,
    );
    const current = recognitionFingerprint(empty, [s.binding]),
      previous = emptyDomainAuthority([s.binding]);
    if (
      ["data_quality", "reproductions", "governance", "deployment_work", "incidents"].includes(metric) ||
      ["performance", "regressions_prevented"].includes(metric)
    )
      assert.notEqual(current, previous);
    else assert.equal(current, previous, `${metric}: established automatic-source authority is retained`);
  }
  const mixed = scenario("documentation"),
    bindings = [mixed.binding, scenario("data_quality").binding];
  assert.notEqual(
    recognitionFingerprint(mixed.state, bindings),
    legacyDomainFingerprint(mixed, bindings),
    "A snapshot bound to a mixed configuration retires as a whole, even without an accepted correction request",
  );
  assert.notEqual(recognitionFingerprint(empty, bindings), emptyDomainAuthority(bindings));
});

// These expected clocks follow the canonical definitions, independently of the
// adapter's domainDateBasis lookup and the registry's advertised selections.
const candidateDateBases = {
  catalog_proposals: "acceptedAt",
  pricebook_proposals: "acceptedAt",
  compatibility_proposals: "acceptedAt",
  primary_sources: "acceptedAt",
  freshness_checks: "occurredAt",
  reproduced_measurements: "acceptedAt",
  negative_findings: "acceptedAt",
  rights_reviews: "acceptedAt",
  assumptions_resolved: "acceptedAt",
  market_research: "acceptedAt",
  evidence_manifests: "acceptedAt",
  data_quality: "acceptedAt",
  reproductions: "acceptedAt",
  documentation: "occurredAt",
  tests: "occurredAt",
  regressions_prevented: "acceptedAt",
  accessibility: "acceptedAt",
  design: "acceptedAt",
  usability: "acceptedAt",
  performance: "acceptedAt",
  security: "occurredAt",
  governance: "acceptedAt",
  deployment_work: "acceptedAt",
};

function aggregateDomain(s, normalized, scope = {}) {
  const metric = s.binding.metricId;
  return aggregateMetric(
    {
      datasetId: "synthetic-domain-candidate",
      cutoff,
      backfillRevision: "1",
      repositoryIds: ["2"],
      actors: normalized.actors,
      facts: normalized.facts,
      coverage: [],
    },
    {
      ...s.policies[0].policy,
      dateBasis: candidateDateBases[metric],
      definitionVersion: metricRegistryV1.policy_version,
      unit: getMetricDefinition(metric).definition.unit,
      aggregation: "count",
      roles: ["author"],
      sources: ["github_rest"],
      minimumSamples: 1,
      rank: false,
    },
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
      ...scope,
    },
  );
}

for (const [metric, date_basis] of Object.entries(candidateDateBases)) {
  test(`${metric}: source-to-engine candidate counts one canonical unit through review and observation replay`, () => {
    // Reliability receipts remain spotlight-only, without a selectable board.
    assert.deepEqual(Object.keys(candidateDateBases).sort(), domainMetricIds.filter((id) => id !== "incidents").sort());
    const s = scenario(metric);
    s.policies[0].policy.dateBasis = date_basis;
    const normalized = run(s),
      result = aggregateDomain(s, normalized),
      effectiveAt = date_basis === "acceptedAt" ? acceptedAt : occurredAt;
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].actorId, "101");
    assert.equal(result.rows[0].value, 1);
    assert.equal(result.rows[0].sampleCount, 1);
    assert.equal(result.rows[0].evidence.length, 1);
    assert.equal(result.rows[0].evidence[0].effectiveAt, effectiveAt);
    assert.equal(result.publicEnabled, false);
    assert.deepEqual(aggregateDomain(s, normalized, { to: effectiveAt }).rows, []);
    const containing = aggregateDomain(s, normalized, {
      from: effectiveAt,
      to: new Date(Date.parse(effectiveAt) + 1).toISOString(),
    });
    assert.equal(containing.rows[0].value, 1, "The canonical event belongs to its exact half-open clock window");

    const duplicate = structuredClone(s.request);
    duplicate.id = "replayed-request";
    duplicate.history[0].id = "replayed-decision";
    duplicate.history[0].at += 1000;
    duplicate.history[0].receipt = duplicate.id;
    attachSyntheticEvidenceIntake(duplicate);
    s.state.requests[duplicate.id] = duplicate;
    s.state.audit.push(duplicate.history[0]);
    s.binding.domainEvidence.records.push({
      ...structuredClone(s.record),
      requestId: duplicate.id,
      decisionId: duplicate.history[0].id,
    });
    for (const reverse of [false, true]) {
      if (reverse) s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
      // Re-normalize the source, re-apply both independent review receipts, and
      // feed a repeated delivery to the actual engine. None is a second unit.
      const repeated = run({ ...s, input: source() });
      assert.deepEqual(aggregateDomain(s, repeated), result);
      repeated.facts = [...repeated.facts, ...structuredClone(repeated.facts)].reverse();
      assert.deepEqual(aggregateDomain(s, repeated), result);
    }

    const selected = { state: "qualified", date_basis },
      ui = getMetricUi(metric);
    assert.deepEqual(selectMetricView(metric, selected), selected);
    assert.equal(ui.maturity, "synthetic_verified");
    assert.deepEqual(
      ui.supported_combinations,
      metric === "documentation" ? [{ state: "qualified", date_basis: "acceptedAt" }, selected] : [selected],
    );
    assert.ok(ui.verification_cases.includes("apps/pipeline/test/domain-recognition.test.mjs"));
  });
}

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
  data_quality: (s) => {
    s.record.details.origin.kind = "unknown";
  },
  reproductions: (s) => {
    s.record.details.executionComplete = false;
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
  governance: (s) => {
    s.record.details.disposition = "rejected";
  },
  deployment_work: (s) => {
    s.record.details.workKind = "execution_only";
  },
  incidents: (s) => {
    s.record.details.narrativeApproved = false;
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
  const conflict = scenario("catalog_proposals", { collaborators: { 202: "accepted" } });
  assert.throws(() => run(conflict), /recognition_decision_unverified/);
  const stale = scenario();
  stale.request.version++;
  stale.record.requestVersion = stale.request.version;
  assert.deepEqual(run(stale), stale.input, "a newer claim cannot reuse its older intake review");
});

test("pricebook currency requires an actual uppercase three-letter string", () => {
  for (const currency of [
    ["USD"],
    ["EUR"],
    ["USD", "EUR"],
    [],
    {},
    { currency: "USD" },
    null,
    true,
    840,
    "usd",
    "US",
    "USDD",
  ]) {
    const s = scenario("pricebook_proposals");
    s.record.details.currency = currency;
    assert.throws(() => run(s), /domain_recognition_evidence_unverified/, JSON.stringify(currency));
  }
});

test("immutable source pins require complete supported hash lengths even when both private bindings agree", () => {
  const pinned = (revision) => {
    const s = scenario();
    s.record.sourceRevision = s.evidence.sourceRevision = revision;
    s.record.sourceRevisionUrl =
      s.evidence.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/commit/${revision}`;
    return s;
  };
  for (const length of [40, 64]) assert.equal(qualified(pinned("a".repeat(length))).length, 1);
  for (const length of [39, ...Array.from({ length: 23 }, (_, index) => index + 41), 65])
    assert.throws(() => run(pinned("a".repeat(length))), /domain_recognition_evidence_unverified/, String(length));
});

test("usability rejects study-only evidence and requires the specific sanitized finding to be accepted", () => {
  const studyOnly = scenario("usability");
  delete studyOnly.record.details.findingId;
  delete studyOnly.record.details.findingVersion;
  delete studyOnly.record.details.findingAccepted;
  assert.throws(() => run(studyOnly), /domain_recognition_evidence_unverified/);
  for (const patch of [
    { findingId: "" },
    { findingVersion: "" },
    { findingAccepted: false },
    { findingAccepted: "true" },
    { participantData: "recordings" },
  ]) {
    const s = scenario("usability");
    Object.assign(s.record.details, patch);
    assert.throws(() => run(s), /domain_recognition_evidence_unverified/);
  }
  const s = scenario("usability");
  const initial = qualified(s)[0].canonicalKey;
  s.record.details.studyId = "study:2";
  assert.notEqual(qualified(s)[0].canonicalKey, initial, "finding identity retains its study context");
  assert.doesNotMatch(
    JSON.stringify(run(s).evidence.slice(s.input.evidence.length)),
    /findingId|findingVersion|findingAccepted|finding:1|studyId|studyVersion|sourceIds/,
  );
});

test("malformed accepted decision clocks remain closed before canonical deduplication", () => {
  for (const at of [
    undefined,
    null,
    [],
    {},
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    -1,
    Date.parse(acceptedAt) + 0.5,
    "invalid",
  ]) {
    const s = scenario();
    const invalid = structuredClone(s.request);
    invalid.id = "z-invalid-clock";
    invalid.history[0].id = "invalid-clock-decision";
    invalid.history[0].receipt = invalid.id;
    attachSyntheticEvidenceIntake(invalid);
    invalid.history[0].at = at;
    s.state.requests[invalid.id] = invalid;
    s.state.audit.push(invalid.history[0]);
    s.binding.domainEvidence.records.push({
      ...structuredClone(s.record),
      requestId: invalid.id,
      decisionId: invalid.history[0].id,
    });
    assert.throws(() => run(s), /recognition_decision_time_invalid/);
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

for (const outcome of ["available", "changed", "unavailable", "unknown", "contradicted"])
  test(`freshness outcomes: reviewed ${outcome} counts recheck effort without granting fact credit`, () => {
    const s = scenario("freshness_checks");
    s.record.details.outcome = outcome;
    const before = structuredClone(s);
    const normalized = run(s);
    const added = normalized.facts.slice(s.input.facts.length);
    assert.equal(added.length, 1);
    assert.equal(added[0].metricId, "freshness_checks");
    assert.equal(added[0].state, "qualified");
    assert.equal(added[0].occurredAt, occurredAt);
    assert.equal(added[0].acceptedAt, acceptedAt);
    const result = aggregateDomain(s, normalized);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].value, 1);
    assert.equal(result.rows[0].sampleCount, 1);
    const proof = normalized.evidence.at(-1);
    assert.deepEqual(proof.contribution.metricIds, ["freshness_checks"]);
    assert.deepEqual(proof.contribution.reasonCodes, [
      "independent_recognition_receipt",
      "domain_metric:freshness_checks",
      "domain_clock:checked_at",
      `domain_outcome:${outcome}`,
    ]);
    assert.doesNotMatch(JSON.stringify(proof), /private-request|private-review-receipt|publisher:canonical|claim:1/);
    assert.deepEqual(s, before, "Recognition must preserve the original source and protected reviewer records");
  });

for (const sourceState of ["available", "changed", "unavailable", "unknown", "contradicted"])
  test(`freshness outcomes: ${sourceState} retains the separate primary-source admission rule`, () => {
    for (const evidenceClass of ["primary_source", "publisher_statement", "independent_measurement"]) {
      const s = scenario("primary_sources");
      s.record.details.sourceState = sourceState;
      s.record.details.evidenceClass = evidenceClass;
      if (sourceState === "available") {
        const added = run(s).facts.slice(s.input.facts.length);
        assert.equal(added.length, 1);
        assert.equal(added[0].metricId, "primary_sources");
        assert.equal(added[0].state, "qualified");
      } else assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
    }
  });

test("freshness outcomes: another reviewed outcome conserves the interval and a later recheck is distinct", () => {
  const s = scenario("freshness_checks");
  s.record.details.outcome = "available";
  const append = (suffix, checkedAt) => {
    const request = structuredClone(s.request);
    request.id += suffix;
    request.version++;
    request.history[0].id += suffix;
    request.history[0].version = request.version;
    request.history[0].at += 1000;
    request.history[0].receipt = request.id;
    attachSyntheticEvidenceIntake(request);
    s.state.requests[request.id] = request;
    s.state.audit.push(request.history[0]);
    s.binding.domainEvidence.records.push({
      ...structuredClone(s.record),
      requestId: request.id,
      requestVersion: request.version,
      decisionId: request.history[0].id,
      details: { ...s.record.details, outcome: "contradicted", checkedAt },
    });
  };
  append(":same-interval", "2026-10-07T11:00:00.000Z");
  const repeated = run(s);
  assert.equal(repeated.facts.slice(s.input.facts.length).length, 1);
  assert.equal(aggregateDomain(s, repeated).rows[0].value, 1);
  s.state.requests = Object.fromEntries(Object.entries(s.state.requests).reverse());
  assert.deepEqual(run(s), repeated, "Receipt insertion order must not choose the counted unit");
  append(":next-interval", "2026-10-08T11:00:00.000Z");
  const next = run(s);
  const added = next.facts.slice(s.input.facts.length);
  assert.equal(added.length, 2);
  assert.equal(new Set(added.map((fact) => fact.canonicalKey)).size, 2);
  assert.equal(aggregateDomain(s, next).rows[0].value, 2);
  assert.equal(aggregateDomain(s, next, { from: "2026-10-08T00:00:00.000Z" }).rows[0].value, 1);
});

for (const [label, change, message, requestOverrides] of [
  ["missing independent audit", (s) => (s.state.audit = []), "recognition_decision_unverified"],
  ["self review", (s) => (s.decision.actor = s.request.owner), "recognition_decision_unverified"],
  [
    "collaborator review",
    (s) => (s.request.collaborators[s.decision.actor] = "accepted"),
    "recognition_decision_unverified",
    { collaborators: { 202: "accepted" } },
  ],
  ["unenrolled reviewer", (s) => (s.binding.reviewerIds = []), "recognition_decision_unverified"],
  ["changed request version", (s) => s.request.version++, null],
  ["missing collected pin", (s) => (s.evidence.sourceRevision = null), "domain_recognition_evidence_unverified"],
  [
    "mutable reviewer pin",
    (s) => (s.record.sourceRevisionUrl = "https://github.com/synthetic-owner/repository/blob/main/claim.md"),
    "domain_recognition_evidence_unverified",
  ],
  ["unapproved public use", (s) => (s.record.publicSafe = false), "domain_recognition_evidence_unverified"],
  ["synthetic source", (s) => (s.input.isSynthetic = true), "domain_recognition_evidence_unverified"],
  ["expired record", (s) => (s.record.validUntil = acceptedAt), "domain_recognition_evidence_unverified"],
  ["future check", (s) => (s.record.details.checkedAt = cutoff), "domain_recognition_evidence_unverified"],
  [
    "unsupported outcome",
    (s) => (s.record.details.outcome = "contradiction"),
    "domain_recognition_evidence_unverified",
  ],
])
  test(`freshness outcomes: contradicted effort still rejects ${label}`, () => {
    const s = scenario("freshness_checks", requestOverrides);
    s.record.details.outcome = "contradicted";
    change(s);
    if (message === null) assert.deepEqual(run(s), s.input);
    else assert.throws(() => run(s), { message });
  });

for (const [label, change] of [
  ["withdrawn request", (s) => (s.request.status = "withdrawn")],
  ["suppressed contributor", (s) => (s.state.profiles[s.request.owner] = { suppressed: true })],
  ["private source", (s) => (s.evidence.artifact.visibility = "private")],
])
  test(`freshness outcomes: contradicted effort stays withheld for a ${label}`, () => {
    const s = scenario("freshness_checks");
    s.record.details.outcome = "contradicted";
    change(s);
    assert.deepEqual(run(s), s.input);
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

// These domain fixtures remap their PR proofs through the issue-collection
// harness. They retain every original fact/proof and mode marker, but do not
// claim the original collected PR binding needed by an optional physical receipt.
function domainNormalization(input) {
  const output = structuredClone(input);
  delete output.physicalContext;
  return output;
}

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
  attachSyntheticEvidenceState(s.state);
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  const h = await harness(t, {
    payloads: [structuredClone(fixture.pull_request)],
    // These retained fictional inputs were produced by the current branch-checked normalizer.
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => ({ ...domainNormalization(s.input), isSynthetic: true }),
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

test("accepted documentation retains bounded domain reasons through primary and portfolio API reads", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const s = scenario("documentation");
  // Exercise the real-mode boundary with explicitly fictional marker-free
  // data; the synthetic-mode rejection remains independently tested above.
  s.input = JSON.parse(JSON.stringify(s.input).replace(/synthetic/gi, "fixture"));
  s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
  for (const entry of s.input.evidence) {
    entry.artifact.publicUrl = entry.artifact.publicUrl.replace("fixture-owner/repository", "example-org/example-repo");
    if (entry.sourceRevisionUrl)
      entry.sourceRevisionUrl = entry.sourceRevisionUrl.replace("fixture-owner/repository", "example-org/example-repo");
    entry.contribution.reasonCodes.push("domain_secret:PRIVATE_SENTINEL");
  }
  s.request.locator = s.evidence.artifact.publicUrl;
  attachSyntheticEvidenceState(s.state);
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  const payload = JSON.parse(JSON.stringify(fixture.pull_request).replace(/synthetic/gi, "fixture"));
  payload.html_url = s.request.locator;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [payload],
    // These retained fictional inputs were produced by the current branch-checked normalizer.
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => domainNormalization(s.input),
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition("documentation").definition.unit,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-test-approval" },
      ];
    },
  });
  h.controlsStore.transaction((state) => {
    state.requests = s.state.requests;
    state.audit = s.state.audit;
  });
  const published = await h.runtime.runOnce({ cutoff });
  assert.equal(published.state, "published");
  const snapshotId = published.publications[0].snapshotId;
  assert.equal(typeof snapshotId, "string");
  const read = await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal);
  const accepted = read.selected.portfolioEvidence.filter((entry) => entry.activityState === "accepted");
  assert.equal(accepted.length, 1);
  const expected = ["domain_metric:documentation", "domain_clock:merged_at", "domain_authorship:authored"];
  assert.deepEqual(accepted[0].contribution.reasonCodes, ["public_accepted_work", ...expected]);
  const proofId = accepted[0].contribution.contributionId;
  const primary = read.selected.evidence.find((entry) => entry.contribution.contributionId === proofId);
  assert.ok(primary);
  assert.deepEqual(primary.contribution.reasonCodes, ["independent_recognition_receipt", ...expected]);
  const proof = await h.runtime.app.inject(`/api/v1/evidence/${proofId}?snapshot=${snapshotId}`);
  assert.equal(proof.statusCode, 200, proof.body);
  // The evidence route prefers the accepted portfolio copy when both exist.
  assert.deepEqual(proof.json().contribution.reasonCodes, ["public_accepted_work", ...expected]);
  const profile = await h.runtime.app.inject(`/api/v1/contributors/101?metric=documentation&snapshot=${snapshotId}`);
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().timeline.length, 1);
  assert.deepEqual(profile.json().timeline[0].contribution.reasonCodes, ["public_accepted_work", ...expected]);
  for (const body of [JSON.stringify(accepted), proof.body, profile.body])
    assert.doesNotMatch(
      body,
      /PRIVATE_SENTINEL|domain_secret|private-request|private-review-receipt|substantiveReview/,
    );
});

test("data_quality: correction provenance stays private and obsolete generic authority is withheld after database reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario("data_quality");
  // Marker-free fictional data exercises the real-mode permission boundary;
  // it supplies no actual source installation, factual review or owner receipt.
  s.input = JSON.parse(JSON.stringify(s.input).replace(/synthetic/gi, "fixture"));
  // A trusted custom normalizer could previously emit this metric directly and
  // use the generic same-metric receipt path. Keep that original observation;
  // only independently qualified correction evidence may add accepted credit.
  s.candidate = s.input.facts.find((fact) => fact.id === s.candidate.id);
  s.candidate.metricId = s.binding.sourceMetricId = "data_quality";
  s.candidate.state = "observed";
  s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
  s.evidence.contribution.metricIds = ["data_quality"];
  for (const entry of s.input.evidence) {
    entry.artifact.publicUrl = entry.artifact.publicUrl.replace("fixture-owner/repository", "example-org/example-repo");
    if (entry.sourceRevisionUrl)
      entry.sourceRevisionUrl = entry.sourceRevisionUrl.replace("fixture-owner/repository", "example-org/example-repo");
    entry.contribution.reasonCodes.push("domain_secret:PRIVATE_CORRECTION");
  }
  s.request.locator = s.evidence.artifact.publicUrl;
  attachSyntheticEvidenceState(s.state);
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  for (const pin of [s.record.details.before, s.record.details.after])
    pin.sourceRevisionUrl = pin.sourceRevisionUrl.replace("synthetic-owner/repository", "example-org/example-repo");
  const payload = JSON.parse(JSON.stringify(fixture.pull_request).replace(/synthetic/gi, "fixture"));
  payload.html_url = s.request.locator;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [payload],
    // These retained fictional inputs were produced by the current branch-checked normalizer.
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => domainNormalization(s.input),
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition("data_quality").definition.unit,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-test-approval" },
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
  const accepted = read.selected.portfolioEvidence.filter((entry) => entry.activityState === "accepted");
  assert.equal(accepted.length, 1);
  const proofId = accepted[0].contribution.contributionId;
  const primary = read.selected.evidence.find((entry) => entry.contribution.contributionId === proofId);
  assert.deepEqual(primary.contribution.reasonCodes, [
    "independent_recognition_receipt",
    "domain_metric:data_quality",
    "domain_clock:accepted_at",
  ]);
  assert.equal(primary.sourceRevisionUrl, s.record.details.after.sourceRevisionUrl);
  const proofPath = `/api/v1/evidence/${proofId}?snapshot=${snapshotId}`;
  const proof = await h.runtime.app.inject(proofPath);
  assert.equal(proof.statusCode, 200, proof.body);
  const profile = await h.runtime.app.inject(`/api/v1/contributors/101?metric=data_quality&snapshot=${snapshotId}`);
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().timeline.filter((entry) => entry.activityState === "accepted").length, 1);
  for (const publicValue of [JSON.stringify(read.selected), proof.body, profile.body])
    assert.doesNotMatch(
      publicValue,
      /PRIVATE_CORRECTION|domain_secret|private-request|private-review-receipt|correction:1|source:1|correctionVersion|contributorIds|factualReview|contentHash|prior_contributors/,
    );
  assert.ok(await h.runtime.aggregateExplanations.read(snapshotId));
  const confirmed = h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint;
  assert.equal(confirmed, recognitionFingerprint(h.controlsStore.read(), [s.binding]));
  assert.notEqual(confirmed, legacyDomainFingerprint(s));
  h.controlsStore.transaction((state) => {
    // Preserve the stored document and all proof hashes, but restore the actual
    // earlier generic qualifier's authorization receipt for this same binding.
    state.pipelinePublications[snapshotId].recognitionFingerprint = legacyDomainFingerprint(s);
  });
  assert.equal(await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal), null);
  const retired = await h.runtime.app.inject(proofPath);
  assert.equal(retired.statusCode, 410);
  assert.equal(retired.json().error, "snapshot_expired_refetch");
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  for (const pin of [null, snapshotId])
    assert.equal(await restarted.source.read(publicScope, pin, new AbortController().signal), null);
  assert.equal((await restarted.app.inject(proofPath)).statusCode, 410);
  await assert.rejects(restarted.aggregateExplanations.read(snapshotId), /authorization_changed/);
  const recomputed = await restarted.runOnce({ cutoff });
  assert.equal(recomputed.state, "published");
  const currentId = recomputed.publications[0].snapshotId;
  const restored = await restarted.source.read(publicScope, currentId, new AbortController().signal);
  assert.equal(restored.selected.rows[0].result.value, 1);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  assert.equal(await restarted.source.read(publicScope, currentId, new AbortController().signal), null);
  assert.equal((await restarted.app.inject(`/api/v1/evidence/${proofId}?snapshot=${currentId}`)).statusCode, 410);
  await assert.rejects(restarted.aggregateExplanations.read(currentId), /authorization_changed/);
});

test("reproductions: persisted accepted outcomes keep private proof bounded and retire obsolete authority across reopen", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario("reproductions");
  // These marker-free fictional artifacts exercise the actual public-mode
  // boundaries without asserting any live source, executed scenario or review.
  s.record.details.outcome = "inconclusive";
  s.input = JSON.parse(JSON.stringify(s.input).replace(/synthetic/gi, "fixture"));
  s.candidate = s.input.facts.find((fact) => fact.id === s.candidate.id);
  s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
  for (const entry of s.input.evidence) {
    entry.artifact.publicUrl = entry.artifact.publicUrl.replace("fixture-owner/repository", "example-org/example-repo");
    if (entry.sourceRevisionUrl)
      entry.sourceRevisionUrl = entry.sourceRevisionUrl.replace("fixture-owner/repository", "example-org/example-repo");
    entry.contribution.reasonCodes.push("domain_secret:PRIVATE_REPRODUCTION");
  }
  s.request.locator = s.evidence.artifact.publicUrl;
  attachSyntheticEvidenceState(s.state);
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  for (const key of ["scenario", "environment", "result"])
    s.record.details[key].sourceRevisionUrl = s.record.details[key].sourceRevisionUrl.replace(
      "synthetic-owner/repository",
      "example-org/example-repo",
    );
  const originalSource = structuredClone(s.input);
  const payload = JSON.parse(JSON.stringify(fixture.pull_request).replace(/synthetic/gi, "fixture"));
  payload.html_url = s.request.locator;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [payload],
    // These retained fictional inputs were produced by the current branch-checked normalizer.
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => domainNormalization(s.input),
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition("reproductions").definition.unit,
      };
      config.policies = [
        { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-test-approval" },
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
  const accepted = read.selected.portfolioEvidence.filter((entry) => entry.activityState === "accepted");
  assert.equal(accepted.length, 1);
  const proofId = accepted[0].contribution.contributionId;
  const expected = [
    "domain_metric:reproductions",
    "domain_clock:accepted_at",
    "accepted_reproduction_scenario_not_bug_confirmation",
    "domain_outcome:inconclusive",
  ];
  const primary = read.selected.evidence.find((entry) => entry.contribution.contributionId === proofId);
  assert.deepEqual(primary.contribution.reasonCodes, ["independent_recognition_receipt", ...expected]);
  assert.deepEqual(accepted[0].contribution.reasonCodes, ["public_accepted_work", ...expected]);
  const proofPath = `/api/v1/evidence/${proofId}?snapshot=${snapshotId}`;
  const proof = await h.runtime.app.inject(proofPath);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.deepEqual(proof.json().contribution.reasonCodes, ["public_accepted_work", ...expected]);
  const profile = await h.runtime.app.inject(`/api/v1/contributors/101?metric=reproductions&snapshot=${snapshotId}`);
  assert.equal(profile.statusCode, 200, profile.body);
  assert.deepEqual(profile.json().timeline[0].contribution.reasonCodes, ["public_accepted_work", ...expected]);
  for (const value of [JSON.stringify(read.selected), proof.body, profile.body])
    assert.doesNotMatch(
      value,
      /PRIVATE_REPRODUCTION|domain_secret|private-request|private-review-receipt|scenario:1|run:1|scenarioVersion|executionComplete|scenarioAccepted|contentHash|reproduction\/scenario/,
    );
  assert.deepEqual(s.input, originalSource);
  assert.equal(
    read.selected.methodology.some((entry) => entry.metricId === "confirmed_bugs"),
    false,
  );
  assert.ok(await h.runtime.aggregateExplanations.read(snapshotId));
  const currentAuthority = recognitionFingerprint(h.controlsStore.read(), [s.binding]);
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, currentAuthority);
  assert.notEqual(currentAuthority, beforeReproductionFingerprint(s));
  h.controlsStore.transaction((state) => {
    // Preserve all stored documents/proof hashes while substituting the actual
    // pre-specialist authority format for the same accepted request and binding.
    state.pipelinePublications[snapshotId].recognitionFingerprint = beforeReproductionFingerprint(s);
  });
  assert.equal(await h.runtime.source.read(publicScope, snapshotId, new AbortController().signal), null);
  assert.equal((await h.runtime.app.inject(proofPath)).statusCode, 410);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  for (const pin of [null, snapshotId])
    assert.equal(await restarted.source.read(publicScope, pin, new AbortController().signal), null);
  assert.equal((await restarted.app.inject(proofPath)).statusCode, 410);
  await assert.rejects(restarted.aggregateExplanations.read(snapshotId), /authorization_changed/);
  const recomputed = await restarted.runOnce({ cutoff });
  assert.equal(recomputed.state, "published");
  const currentId = recomputed.publications[0].snapshotId;
  const restored = await restarted.source.read(publicScope, currentId, new AbortController().signal);
  assert.equal(restored.selected.rows[0].result.value, 1);
  assert.deepEqual(restored.selected.portfolioEvidence[0].contribution.reasonCodes, [
    "public_accepted_work",
    ...expected,
  ]);
  h.controlsStore.transaction((state) => {
    state.requests[s.request.id].status = "withdrawn";
  });
  for (const pin of [null, snapshotId, currentId])
    assert.equal(await restarted.source.read(publicScope, pin, new AbortController().signal), null);
  assert.equal((await restarted.app.inject(`/api/v1/evidence/${proofId}?snapshot=${currentId}`)).statusCode, 410);
  await assert.rejects(restarted.aggregateExplanations.read(currentId), /authorization_changed/);
});

test("canonical units deduplicate aliases independently of request insertion order", () => {
  const s = scenario("primary_sources"),
    duplicate = structuredClone(s.request);
  duplicate.id = "duplicate-request";
  duplicate.history[0].id = "duplicate-decision";
  duplicate.history[0].at += 1000;
  duplicate.history[0].receipt = duplicate.id;
  attachSyntheticEvidenceIntake(duplicate);
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

test("unrelated requests cannot change the earliest audited canonical receipt in any insertion order", () => {
  const s = scenario();
  const bindings = [],
    requests = [];
  const earlierAt = "2026-10-08T10:00:00.000Z";
  for (const [id, at] of [
    ["a-later", acceptedAt],
    ["z-earlier", earlierAt],
  ]) {
    const request = structuredClone(s.request),
      binding = structuredClone(s.binding);
    request.id = id;
    request.scope += `:${id}`;
    request.history[0].id = `decision:${id}`;
    request.history[0].at = Date.parse(at);
    binding.scope = request.scope;
    binding.domainEvidence.records[0].requestId = id;
    binding.domainEvidence.records[0].decisionId = request.history[0].id;
    request.history[0].receipt = request.id;
    attachSyntheticEvidenceIntake(request);
    requests.push(request);
    bindings.push(binding);
  }
  const state = {
    profiles: { 303: { suppressed: true } },
    audit: requests.map((request) => request.history[0]),
    requests: Object.fromEntries(requests.map((request) => [request.id, request])),
  };
  const materialize = () =>
    materializeRecognition(s.input, state, bindings, s.policies, applyRecognitionReceipt, cutoff);
  const expected = materialize();
  const facts = expected.facts.filter((fact) => fact.metricId === "catalog_proposals" && fact.state === "qualified");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].acceptedAt, earlierAt);
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const unrelated of [
    { id: "m-pending", kind: "evidence", status: "pending", owner: "101", history: [] },
    { id: "m-consent", kind: "consent", status: "accepted", owner: "101", history: [] },
    { id: "m-suppressed", kind: "evidence", status: "accepted", owner: "303", history: [] },
  ]) {
    const entries = [requests[0], unrelated, requests[1]];
    for (const order of permutations) {
      state.requests = Object.fromEntries(order.map((index) => [entries[index].id, entries[index]]));
      assert.deepEqual(materialize(), expected, `${unrelated.id}: ${order.join(",")}`);
    }
  }
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

for (const metric of ["documentation", "usability"])
  test(`the metric engine counts separately accepted ${metric === "usability" ? "findings in one study" : "documentation categories"} while conserving duplicate proof`, () => {
    const s = scenario(metric);
    for (const [suffix, detail] of [
      [
        "duplicate",
        metric === "usability" ? { findingVersion: "v2", sourceIds: ["source:1", "source:2"] } : { category: "guide" },
      ],
      ["distinct", metric === "usability" ? { findingId: "finding:2" } : { category: "example" }],
    ]) {
      const request = structuredClone(s.request);
      request.id += ":" + suffix;
      request.history[0].id += ":" + suffix;
      request.history[0].at += 1000;
      request.history[0].receipt = request.id;
      attachSyntheticEvidenceIntake(request);
      s.state.requests[request.id] = request;
      s.state.audit.push(request.history[0]);
      s.binding.domainEvidence.records.push({
        ...structuredClone(s.record),
        requestId: request.id,
        decisionId: request.history[0].id,
        details: { ...s.record.details, ...detail },
      });
    }
    const normalized = run(s);
    const policy = {
      ...s.policies[0].policy,
      definitionVersion: metricRegistryV1.policy_version,
      unit: getMetricDefinition(metric).definition.unit,
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

// These are fixtures of the trusted normalized-input boundary, not additional
// capabilities of the stock GitHub collector. Its coauthor/review facts do not
// receive the immutable domain pin required by this specialist adapter.
function trustedDesignRoleScenario(role) {
  const s = scenario("design");
  s.input.facts = [s.candidate];
  s.input.evidence = [s.evidence];
  s.input.participation = s.input.participation
    .filter((entry) => entry.actorId === s.request.owner)
    .map((entry) => ({ ...entry, role }));
  s.candidate.role = role;
  s.evidence.contribution.roles = [role];
  s.record.details.role = role;
  return s;
}

test("domain role boundary: trusted design roles retain their exact attribution and canonical unit", async (t) => {
  let canonicalKey;
  for (const role of ["author", "coauthor", "reviewer"]) {
    await t.test(role, () => {
      const s = trustedDesignRoleScenario(role),
        original = structuredClone(s),
        out = run(s),
        facts = out.facts.filter((fact) => fact.metricId === "design" && fact.state === "qualified");
      assert.equal(facts.length, 1);
      assert.equal(facts[0].role, role);
      assert.equal(facts[0].actorId, s.request.owner);
      assert.equal(facts[0].acceptedBy, s.decision.actor);
      assert.notEqual(facts[0].acceptedBy, facts[0].actorId);
      const proof = out.evidence.find((entry) => entry.contribution.contributionId === facts[0].id);
      assert.deepEqual(proof.contribution.roles, [role]);
      assert.equal(proof.sourceRevision, s.record.sourceRevision);
      assert.equal(proof.sourceRevisionUrl, s.record.sourceRevisionUrl);
      canonicalKey ??= facts[0].canonicalKey;
      assert.equal(facts[0].canonicalKey, canonicalKey, "A different role label cannot mint another design unit");
      assert.deepEqual(s, original, "Recognition must not rewrite the source role or its protected review");
    });
  }
});

test("domain role boundary: a design declaration cannot substitute for the source role", async (t) => {
  for (const sourceRole of ["author", "coauthor", "reviewer"]) {
    for (const declaredRole of ["author", "coauthor", "reviewer"].filter((role) => role !== sourceRole)) {
      await t.test(`${sourceRole} is not ${declaredRole}`, () => {
        const s = trustedDesignRoleScenario(sourceRole);
        s.record.details.role = declaredRole;
        const original = structuredClone(s);
        assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
        assert.deepEqual(s, original);
      });
    }
  }
  for (const role of ["co-designer", "remediator", "resolver", "merger", "reporter", "unknown", "automation"]) {
    await t.test(`unsupported design role ${role}`, () => {
      const s = trustedDesignRoleScenario(role);
      assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
    });
  }
});

function securityRoleDeclarationScenario() {
  const s = scenario("security");
  attachSyntheticEvidenceIntake(s.request, {
    intake: { roles: { submitter: "PRIVATE_REMEDIATION_ROLE_SENTINEL", collaborators: {} } },
  });
  return s;
}

test("domain role boundary: a private remediation declaration cannot grant a role or waive security consent", async (t) => {
  await t.test("the accepted source author stays the author", () => {
    const s = securityRoleDeclarationScenario(),
      original = structuredClone(s),
      out = run(s),
      facts = out.facts.filter((fact) => fact.metricId === "security" && fact.state === "qualified");
    assert.equal(facts.length, 1);
    assert.equal(facts[0].role, "author");
    const proof = out.evidence.find((entry) => entry.contribution.contributionId === facts[0].id);
    assert.deepEqual(proof.contribution.roles, ["author"]);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE_REMEDIATION_ROLE_SENTINEL/);
    assert.deepEqual(s, original);
  });
  for (const field of ["publicDisclosureApproved", "contributorConsent"]) {
    await t.test(`${field} is still required`, () => {
      const s = securityRoleDeclarationScenario();
      s.record.details[field] = false;
      let receiptCalls = 0;
      assert.throws(
        () =>
          materializeRecognition(
            s.input,
            s.state,
            [s.binding],
            s.policies,
            (...args) => {
              receiptCalls++;
              return applyRecognitionReceipt(...args);
            },
            cutoff,
          ),
        { message: "domain_recognition_evidence_unverified" },
      );
      assert.equal(receiptCalls, 0, "The specialist gate must fail before invoking even a host receipt adapter");
    });
  }
});

function comparisonRevisionScenario(metric, width = 40) {
  const s = scenario(metric);
  const prior = "b".repeat(width),
    current = "c".repeat(width);
  s.input = source((envelope) => {
    envelope.payload.pull_request.merge_commit_sha = current;
    envelope.integration.before = envelope.integration.diff.before = prior;
    envelope.integration.after = envelope.integration.diff.after = current;
    envelope.integration.commitShas = [current];
  });
  s.candidate = s.input.facts.find((fact) => fact.metricId === "pr_merged");
  s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
  assert.equal(s.evidence.sourceRevision, current);
  s.record.factId = s.candidate.id;
  s.record.sourceRevision = s.evidence.sourceRevision;
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  s.request.locator = s.evidence.artifact.publicUrl;
  comparisonRevisions(s, prior, current);
  return s;
}

function comparisonRevisions(s, prior, current) {
  if (s.binding.metricId === "performance") {
    s.record.details.before.revision = prior;
    s.record.details.after.revision = current;
  } else {
    assert.equal(s.binding.metricId, "regressions_prevented");
    s.record.details.beforeRevision = prior;
    s.record.details.afterRevision = current;
  }
}

// Exact immediately preceding authority for these fixtures, including current
// manual intake. Unrelated markers are deliberately excluded by the fixture guard.
function beforeComparisonRevisionFingerprint(state, bindings) {
  assert.ok(
    bindings.every((binding) =>
      ["documentation", "tests", "performance", "regressions_prevented"].includes(binding.metricId),
    ),
  );
  const requests = Object.values(state.requests ?? {})
    .filter((request) => request.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(requests.every((request) => Object.keys(request.collaborators).length === 0));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, profile]) => profile.suppressed)
    .map(([actorId]) => actorId)
    .sort();
  const decisions = new Set(
    requests.flatMap((request) =>
      (request.history ?? []).filter((entry) => entry.action === "accepted").map((entry) => entry.id),
    ),
  );
  const audit = (state.audit ?? [])
    .filter((entry) => decisions.has(entry.id))
    .map((entry) => JSON.stringify(entry))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (requests.length) authority.push(evidenceIntakeAuthority());
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

for (const metric of ["performance", "regressions_prevented"]) {
  for (const width of [40, 64]) {
    test(`${metric}: distinct complete ${width}-digit Git revisions qualify`, () => {
      const s = comparisonRevisionScenario(metric, width);
      const original = structuredClone({ input: s.input, state: s.state, binding: s.binding });
      const result = qualified(s);
      assert.equal(result.length, 1);
      assert.equal(result[0].actorId, "101");
      assert.equal(result[0].acceptedAt, acceptedAt);
      assert.deepEqual({ input: s.input, state: s.state, binding: s.binding }, original);
    });

    test(`${metric}: identical ${width}-digit objects cannot differ only by case`, () => {
      for (const prior of ["c".repeat(width), "C".repeat(width)]) {
        const s = comparisonRevisionScenario(metric, width);
        comparisonRevisions(s, prior, s.record.sourceRevision);
        assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
      }
    });
  }

  test(`${metric}: mutable refs, malformed widths and whitespace are not immutable revisions`, () => {
    for (const prior of [
      undefined,
      null,
      123,
      "",
      " ",
      "main",
      "refs/heads/main",
      "v1.0.0",
      "b".repeat(39),
      "b".repeat(41),
      "b".repeat(63),
      "b".repeat(65),
      "g".repeat(40),
      "g".repeat(64),
      "B".repeat(40),
      "B".repeat(64),
      "b".repeat(40) + "\n",
      "b".repeat(64) + "\r",
      " " + "b".repeat(40),
      "b".repeat(40) + " ",
    ]) {
      const s = comparisonRevisionScenario(metric);
      comparisonRevisions(s, prior, s.record.sourceRevision);
      assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
    }
  });

  test(`${metric}: before and after use the same repository object format`, () => {
    for (const [priorWidth, currentWidth] of [
      [40, 64],
      [64, 40],
    ]) {
      const s = comparisonRevisionScenario(metric, currentWidth);
      comparisonRevisions(s, "b".repeat(priorWidth), s.record.sourceRevision);
      assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
    }
  });

  test(`${metric}: a complete after revision must still equal the collected record`, () => {
    for (const width of [40, 64]) {
      const s = comparisonRevisionScenario(metric, width);
      comparisonRevisions(s, "b".repeat(width), "d".repeat(width));
      assert.throws(() => run(s), { message: "domain_recognition_evidence_unverified" });
    }
  });
}

test("comparison revision authority retires only affected destination configurations", () => {
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const metric of ["documentation", "tests", "performance", "regressions_prevented"]) {
    const s = scenario(metric);
    for (const state of [empty, s.state]) {
      const current = recognitionFingerprint(state, [s.binding]);
      const previous = beforeComparisonRevisionFingerprint(state, [s.binding]);
      if (["performance", "regressions_prevented"].includes(metric)) assert.notEqual(current, previous);
      else assert.equal(current, previous, "unrelated authority retains its exact preceding fingerprint");
    }
  }
  const s = scenario("documentation");
  for (const metric of ["performance", "regressions_prevented"]) {
    const bindings = [s.binding, scenario(metric).binding];
    for (const state of [empty, s.state])
      assert.notEqual(recognitionFingerprint(state, bindings), beforeComparisonRevisionFingerprint(state, bindings));
  }
});

for (const metric of ["performance", "regressions_prevented"]) {
  test(`${metric}: preceding authority stays retired through reopen and authorized recomputation`, async (t) => {
    const { harness, components, publicScope } = await import("./harness.mjs");
    const { createPipeline } = await import("../src/runtime.mjs");
    const s = comparisonRevisionScenario(metric);
    // Marker-free fictional records exercise retained public-mode authority.
    // They are not actual measurements, executed regression scenarios or reviews.
    s.input = JSON.parse(JSON.stringify(s.input).replace(/synthetic/gi, "fixture"));
    s.candidate = s.input.facts.find((fact) => fact.id === s.candidate.id);
    s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
    for (const entry of s.input.evidence) {
      entry.artifact.publicUrl = entry.artifact.publicUrl.replace(
        "fixture-owner/repository",
        "example-org/example-repo",
      );
      if (entry.sourceRevisionUrl)
        entry.sourceRevisionUrl = entry.sourceRevisionUrl.replace(
          "fixture-owner/repository",
          "example-org/example-repo",
        );
    }
    s.request.locator = s.evidence.artifact.publicUrl;
    attachSyntheticEvidenceState(s.state);
    s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
    const payload = JSON.parse(JSON.stringify(fixture.pull_request).replace(/synthetic/gi, "fixture"));
    payload.html_url = s.request.locator;
    const h = await harness(t, {
      markerFreeConfig: true,
      dataMode: "public",
      payloads: [payload],
      defaultDeliveryNormalizationVersion,
      normalizerFactory: () => async () => domainNormalization(s.input),
      configure(config) {
        config.recognitionBindings = [s.binding];
        const policy = {
          ...config.policies[0].policy,
          ...s.policies[0].policy,
          roles: ["author"],
          unit: components.metrics.getMetricDefinition(metric).definition.unit,
        };
        config.policies = [
          { policy, signature: components.metrics.stableJSON(policy), approvalReceipt: "fixture-test-approval" },
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
    assert.ok(read);
    assert.equal(read.selected.rows[0].result.value, 1);
    const accepted = read.selected.portfolioEvidence.filter((entry) => entry.activityState === "accepted");
    assert.equal(accepted.length, 1);
    const proofId = accepted[0].contribution.contributionId;
    const proofPath = (pin) => `/api/v1/evidence/${proofId}?snapshot=${pin}`;
    assert.equal((await h.runtime.app.inject(proofPath(snapshotId))).statusCode, 200);
    assert.ok(await h.runtime.aggregateExplanations.read(snapshotId));
    const state = h.controlsStore.read();
    const previous = beforeComparisonRevisionFingerprint(state, [s.binding]);
    const current = recognitionFingerprint(state, [s.binding]);
    assert.equal(state.pipelinePublications[snapshotId].recognitionFingerprint, current);
    assert.notEqual(current, previous);
    const retained = async () => ({
      frozen: (
        await h.db.query(
          "SELECT snapshot_id,document,document_hash FROM leaderboard_pipeline.frozen_inputs ORDER BY snapshot_id",
        )
      ).rows,
      normalizations: (
        await h.db.query(
          "SELECT fact_key,policy_signature,document,document_hash " +
            "FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
        )
      ).rows,
    });
    const original = await retained();
    assert.ok(original.frozen.some((row) => row.snapshot_id === snapshotId));
    assert.ok(original.normalizations.length > 0);
    h.controlsStore.transaction((stored) => {
      // Restore exactly the preceding valid authority receipt. Source, frozen
      // documents and their hashes remain unchanged; no old runtime is executed.
      stored.pipelinePublications[snapshotId].recognitionFingerprint = previous;
    });
    const assertRetired = async (runtime) => {
      for (const pin of [null, snapshotId])
        assert.equal(await runtime.source.read(publicScope, pin, new AbortController().signal), null);
      const proof = await runtime.app.inject(proofPath(snapshotId));
      assert.equal(proof.statusCode, 410);
      assert.equal(proof.json().error, "snapshot_expired_refetch");
      await assert.rejects(runtime.aggregateExplanations.read(snapshotId), /authorization_changed/);
      assert.deepEqual(await retained(), original);
    };
    await assertRetired(h.runtime);
    await h.runtime.stop();
    await h.reopenDatabase();
    const restarted = await createPipeline(h.options);
    t.after(() => restarted.stop());
    await assertRetired(restarted);
    const recomputed = await restarted.runOnce({ cutoff });
    assert.equal(recomputed.state, "published");
    const currentId = recomputed.publications[0].snapshotId;
    const restored = await restarted.source.read(publicScope, currentId, new AbortController().signal);
    assert.ok(restored);
    assert.equal(restored.selected.rows[0].result.value, 1);
    assert.equal((await restarted.app.inject(proofPath(currentId))).statusCode, 200);
    assert.ok(await restarted.aggregateExplanations.read(currentId));
    assert.equal(
      h.controlsStore.read().pipelinePublications[currentId].recognitionFingerprint,
      recognitionFingerprint(h.controlsStore.read(), [s.binding]),
    );
    const after = await retained();
    for (const row of original.frozen)
      assert.deepEqual(
        after.frozen.find((entry) => entry.snapshot_id === row.snapshot_id),
        row,
      );
    for (const row of original.normalizations)
      assert.deepEqual(
        after.normalizations.find(
          (entry) => entry.fact_key === row.fact_key && entry.policy_signature === row.policy_signature,
        ),
        row,
      );
    h.controlsStore.transaction((stored) => {
      stored.requests[s.request.id].status = "withdrawn";
    });
    assert.equal(await restarted.source.read(publicScope, currentId, new AbortController().signal), null);
    assert.equal((await restarted.app.inject(proofPath(currentId))).statusCode, 410);
    await assert.rejects(restarted.aggregateExplanations.read(currentId), /authorization_changed/);
  });
}
