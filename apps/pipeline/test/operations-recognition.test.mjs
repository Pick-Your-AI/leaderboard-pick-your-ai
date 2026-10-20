// Fictional source records exercise private recognition in memory. These are
// not real reviews, deployment operations, incident evidence or source grants.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  defaultDeliveryNormalizationVersion,
} from "@pick-your-ai/github";
import { aggregateMetric, getMetricDefinition, getMetricUi, metricRegistryV1 } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import {
  attachSyntheticEvidenceIntake,
  attachSyntheticEvidenceState,
} from "../../../tests/fixtures/evidence-intake.mjs";
import { evidenceIntakeAuthority } from "../../controls/src/evidence-intake.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const metrics = ["governance", "deployment_work", "incidents"];
const before = "b".repeat(40),
  after = "c".repeat(40),
  digest = "d".repeat(64);
const mergedAt = "2026-10-07T10:00:00.000Z",
  acceptedAt = "2026-10-09T10:00:00.000Z",
  cutoff = "2026-10-10T10:00:00.000Z";

function source(kind = "merged", revision = after, author = fixture.author) {
  const predecessor = revision.length === 64 ? "b".repeat(64) : before;
  const envelope = {
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: mergedAt, isSynthetic: false },
    family: "pull_request",
    action: "closed",
    occurredAt: mergedAt,
    observedAt: acceptedAt,
    payload: {
      repository: fixture.repository,
      pull_request: {
        ...structuredClone(fixture.pull_request),
        user: author,
        merged_by: fixture.merger,
        merge_commit_sha: revision,
      },
    },
    integration: {
      before: predecessor,
      after: revision,
      targetBranch: "main",
      defaultBranch: "main",
      canonicalChangeId: "fictional-operations-change",
      commitShas: [revision],
      diff: {
        before: predecessor,
        after: revision,
        complete: true,
        files: [{ path: "operations/public.json", additions: 2, deletions: 1 }],
      },
    },
  };
  let sourceMetric = "pr_merged";
  if (kind === "open" || kind === "closed-unmerged") {
    Object.assign(envelope.payload.pull_request, {
      state: kind === "open" ? "open" : "closed",
      merged: false,
      merged_at: null,
      closed_at: kind === "open" ? null : mergedAt,
      merge_commit_sha: null,
    });
    envelope.action = kind === "open" ? "opened" : "closed";
    delete envelope.integration;
    sourceMetric = "pr_opened";
  } else if (kind === "issue") {
    envelope.family = "issue";
    envelope.action = "opened";
    envelope.payload = { repository: fixture.repository, issue: { ...fixture.issue, user: author } };
    delete envelope.integration;
    sourceMetric = "issues_opened";
  } else if (kind === "release-automation") {
    envelope.family = "release";
    envelope.action = "published";
    envelope.payload = {
      repository: fixture.repository,
      sender: fixture.bot,
      release: {
        id: 60,
        node_id: "RE_fictional_operations",
        html_url: "https://github.com/synthetic-owner/repository/releases/tag/v1",
        author,
        draft: false,
        published_at: mergedAt,
      },
    };
    delete envelope.integration;
    sourceMetric = "release_stewardship";
  } else if (kind === "merger") {
    sourceMetric = "maintainer_merges";
  } else if (kind === "coauthor") {
    envelope.verifiedCoauthors = [{ actor: fixture.reviewer, verificationReceipt: "fictional-account-binding" }];
    sourceMetric = "pr_coauthored";
  }
  const input = normalizeGithubObservation(envelope);
  const candidate = input.facts.find((entry) => entry.metricId === sourceMetric);
  assert.ok(candidate, `fixture must normalize an actual ${sourceMetric} fact`);
  const evidence = input.evidence.find((entry) => entry.contribution.contributionId === candidate.id);
  assert.ok(evidence, "fixture must retain the actual source proof");
  return { input, candidate, evidence, revision };
}

function scenario(metric, { kind = "merged", revision = after, author = fixture.author } = {}) {
  const s = source(kind, revision, author);
  const publicRecord = {
    revision,
    sourceRevisionUrl: `https://github.com/synthetic-owner/repository/blob/${revision}/operations/public.json`,
    contentHash: digest,
  };
  const details = {
    governance: {
      decisionId: "private-decision-unit",
      decisionVersion: "v1",
      kind: "governance_decision",
      disposition: "accepted",
      publicRecord,
    },
    deployment_work: {
      workArtifactId: "private-deployment-work",
      workVersion: "v1",
      workKind: "deployment_improvement",
      deploymentIds: ["private-deployment-one"],
      sourceUse: "approved_public",
      publicRecord,
    },
    incidents: {
      contributionId: "private-reliability-work",
      contributionVersion: "v1",
      workKind: "postmortem",
      narrativeApproved: true,
      publicRecord,
    },
  }[metric];
  const reviewer = s.candidate.actorId === "303" ? "202" : "303";
  const decision = {
    id: `private-audit-${metric}`,
    actor: reviewer,
    action: "accepted",
    at: Date.parse(acceptedAt),
    version: 2,
    policyVersion: "operations-review:v1",
  };
  const request = {
    id: `private-request-${metric}`,
    kind: "evidence",
    status: "accepted",
    owner: s.candidate.actorId,
    version: 2,
    category: "other",
    scope: `repository:2:${metric}`,
    policyVersion: decision.policyVersion,
    locator: s.evidence.artifact.publicUrl,
    collaborators: {},
    history: [decision],
    detail: "private-request-detail-must-stay-private",
  };
  attachSyntheticEvidenceIntake(request);
  const record = {
    requestId: request.id,
    requestVersion: request.version,
    decisionId: decision.id,
    factId: s.candidate.id,
    sourceRevision: revision,
    sourceRevisionUrl: `https://github.com/synthetic-owner/repository/commit/${revision}`,
    validUntil: "2026-11-01T00:00:00.000Z",
    synthetic: false,
    publicSafe: true,
    details,
  };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: decision.policyVersion,
    metricId: metric,
    sourceMetricId: s.candidate.metricId,
    repositoryId: "2",
    reviewerIds: [reviewer],
    domainEvidence: {
      version: "domain-evidence/v1",
      ownerIds: [reviewer],
      contractReviewerIds: [],
      disclosureReviewerIds: [],
      freshnessIntervalSeconds: 86400,
      records: [record],
    },
  };
  return {
    ...s,
    request,
    decision,
    record,
    binding,
    state: { requests: { [request.id]: request }, profiles: {}, audit: [decision] },
    policies: [
      {
        policy: {
          metricId: metric,
          version: decision.policyVersion,
          // This literal comes from the registry, not the adapter being changed.
          dateBasis: "acceptedAt",
          groupBy: "canonical",
          rankedStates: ["qualified"],
        },
      },
    ],
  };
}

function run(
  s,
  { state = s.state, bindings = [s.binding], policies = s.policies, applyReceipt = applyRecognitionReceipt } = {},
) {
  return materializeRecognition(s.input, state, bindings, policies, applyReceipt, cutoff);
}
const recognized = (s, output = run(s)) =>
  output.facts.filter((entry) => entry.metricId === s.binding.metricId && entry.state === "qualified");

function rejectBeforeReceipt(s, overrides = {}) {
  let called = 0;
  let failure;
  try {
    run(s, {
      ...overrides,
      applyReceipt: (...args) => {
        called++;
        return applyRecognitionReceipt(...args);
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(called, 0, "unqualified input must be refused before the host receipt callback");
  assert.ok(failure instanceof Error, "invalid input must fail explicitly");
  assert.match(
    failure.message,
    /^(domain_recognition_evidence_unverified|recognition_(source_unverified|decision_unverified|policy_not_configured|decision_time_invalid)|ambiguous_recognition_target)$/,
  );
  assert.doesNotMatch(failure.message, /private-|deployment-one|contentHash/);
}

function aggregate(s, normalized, scope = {}, rank = false) {
  return aggregateMetric(
    {
      datasetId: "fictional-operations",
      cutoff,
      backfillRevision: "1",
      repositoryIds: ["2"],
      actors: normalized.actors,
      facts: normalized.facts,
      coverage: [],
    },
    {
      ...s.policies[0].policy,
      definitionVersion: metricRegistryV1.policy_version,
      unit: getMetricDefinition(s.binding.metricId).definition.unit,
      aggregation: "count",
      roles: ["author"],
      sources: ["github_rest"],
      minimumSamples: 1,
      rank,
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

function alias(s, suffix = "later") {
  const copy = structuredClone(s);
  copy.request.id += `-${suffix}`;
  copy.request.scope += `:${suffix}`;
  copy.decision.id += `-${suffix}`;
  copy.decision.at += 3600000;
  copy.decision.receipt = copy.request.id;
  attachSyntheticEvidenceIntake(copy.request);
  copy.record.requestId = copy.request.id;
  copy.record.decisionId = copy.decision.id;
  copy.binding.scope = copy.request.scope;
  copy.state.requests = { [copy.request.id]: copy.request };
  return copy;
}
function joined(scenarios, reverse = false) {
  const ordered = reverse ? [...scenarios].reverse() : scenarios;
  return {
    state: {
      requests: Object.fromEntries(ordered.map((s) => [s.request.id, s.request])),
      profiles: {},
      audit: ordered.map((s) => s.decision),
    },
    bindings: ordered.map((s) => s.binding),
    policies: ordered.flatMap((s) => s.policies),
  };
}

for (const metric of metrics) {
  test(`operations ${metric}: exact reviewed authored work qualifies and preserves original source and private boundaries`, () => {
    const s = scenario(metric),
      original = structuredClone(s.input),
      output = run(s);
    const facts = recognized(s, output);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].actorId, "101");
    assert.equal(facts[0].role, "author");
    assert.equal(facts[0].occurredAt, s.candidate.occurredAt);
    assert.equal(facts[0].acceptedAt, acceptedAt);
    assert.deepEqual(s.input, original);
    assert.deepEqual(output.actors, original.actors);
    const added = output.evidence.slice(original.evidence.length);
    assert.equal(added.length, 1);
    assert.equal(added[0].occurredAt, acceptedAt);
    assert.equal(added[0].sourceRevision, after);
    assert.equal(added[0].sourceRevisionUrl, s.record.sourceRevisionUrl);
    assert.equal(added[0].evidenceMetadata.sourceOccurredAt, s.evidence.evidenceMetadata.sourceOccurredAt);
    assert.ok(added[0].contribution.reasonCodes.includes(`domain_metric:${metric}`));
    assert.ok(added[0].contribution.reasonCodes.includes("domain_clock:accepted_at"));
    assert.doesNotMatch(JSON.stringify(added), /private-|contentHash|publicRecord|deploymentIds|narrativeApproved/);
    assert.equal(JSON.stringify(added).includes(digest), false);
  });

  test(`operations ${metric}: current rejected or withdrawn controls cannot mint a contribution`, () => {
    for (const status of ["rejected", "withdrawn", "pending"]) {
      const s = scenario(metric),
        original = structuredClone(s.input);
      s.request.status = status;
      let called = 0;
      const output = run(s, {
        applyReceipt: (...args) => {
          called++;
          return applyRecognitionReceipt(...args);
        },
      });
      assert.equal(called, 0);
      assert.deepEqual(output, original);
    }
  });

  test(`operations ${metric}: a real normalized bot-authored change remains bot participation`, () => {
    const s = scenario(metric, { author: fixture.bot }),
      output = run(s);
    assert.equal(recognized(s, output).length, 1);
    assert.equal(recognized(s, output)[0].actorId, "404");
    assert.equal(output.actors.find((actor) => actor.id === "404").kind, "bot");
    assert.deepEqual(output.actors, s.input.actors);
    assert.equal(recognized(s, output)[0].role, "author");
  });

  test(`operations ${metric}: a complete 64-character Git pin is supported without shortening`, () => {
    const revision = "e".repeat(64),
      s = scenario(metric, { revision }),
      output = run(s);
    assert.equal(recognized(s, output).length, 1);
    assert.equal(output.evidence.at(-1).sourceRevision, revision);
  });

  test(`operations ${metric}: acceptance is the half-open event clock and does not erase source occurrence`, () => {
    const s = scenario(metric),
      output = run(s);
    assert.equal(aggregate(s, output, { from: mergedAt, to: acceptedAt }).rows.length, 0);
    const result = aggregate(s, output, { from: acceptedAt, to: "2026-10-09T10:00:00.001Z" });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].value, 1);
    assert.equal(result.rows[0].evidence[0].effectiveAt, acceptedAt);
    assert.equal(result.publicEnabled, false);
    assert.equal(aggregate(s, output, { from: "2026-10-09T10:00:00.001Z", to: cutoff }).rows.length, 0);
    assert.equal(recognized(s, output)[0].occurredAt, s.candidate.occurredAt);
  });

  test(`operations ${metric}: aliases and revised proof retain one earliest canonical contribution in either order`, () => {
    const s = scenario(metric),
      later = alias(s);
    later.record.details.publicRecord.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${after}/operations/reviewed-copy.json`;
    later.record.details.publicRecord.contentHash = "f".repeat(64);
    if (metric === "deployment_work") {
      later.record.details.workVersion = "v2";
      later.record.details.deploymentIds = ["private-deployment-two", "private-deployment-three"];
    } else if (metric === "incidents") {
      later.record.details.contributionVersion = "v2";
      later.record.details.workKind = "remediation";
    }
    for (const reverse of [false, true]) {
      const output = run(s, joined([s, later], reverse)),
        facts = recognized(s, output);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].acceptedAt, acceptedAt);
      assert.equal(facts[0].acceptanceReceipt, s.decision.id);
    }
  });

  test(`operations ${metric}: a malformed later alias cannot hide behind an earlier accepted unit`, () => {
    const s = scenario(metric),
      later = alias(s);
    later.record.details.publicRecord.contentHash = "invalid";
    for (const reverse of [false, true]) {
      let called = 0;
      assert.throws(
        () =>
          run(s, {
            ...joined([s, later], reverse),
            applyReceipt: (...args) => {
              called++;
              return applyRecognitionReceipt(...args);
            },
          }),
        /domain_recognition_evidence_unverified/,
      );
      assert.equal(called, 1, "the earlier valid unit may materialize; the later malformed unit must still be checked");
    }
  });

  test(`operations ${metric}: contradictory hashes for one immutable public file reject the later receipt`, () => {
    const s = scenario(metric),
      later = alias(s);
    later.record.details.publicRecord.contentHash = "f".repeat(64);
    for (const reverse of [false, true]) {
      let called = 0;
      assert.throws(
        () =>
          run(s, {
            ...joined([s, later], reverse),
            applyReceipt: (...args) => {
              called++;
              return applyRecognitionReceipt(...args);
            },
          }),
        /domain_recognition_evidence_unverified/,
      );
      assert.equal(called, 1, "the conflicting later pin must fail before its receipt callback");
    }
  });

  for (const kind of ["open", "closed-unmerged", "issue", "release-automation", "merger", "coauthor"]) {
    test(`operations ${metric}: actual normalized ${kind} source cannot substitute for the supported merged author`, () => {
      rejectBeforeReceipt(scenario(metric, { kind }));
      assert.equal(recognized(scenario(metric)).length, 1, "a new valid authored source recovers");
    });
  }
}

const invalidCommon = [
  [
    "missing domain evidence",
    (s) => {
      delete s.binding.domainEvidence;
    },
  ],
  [
    "reviewer outside the affected-owner roster",
    (s) => {
      s.binding.domainEvidence.ownerIds = ["202"];
    },
  ],
  [
    "ambiguous exact evidence records",
    (s) => {
      s.binding.domainEvidence.records.push(structuredClone(s.record));
    },
  ],
  [
    "request changed after the accepted decision",
    (s) => {
      s.request.version++;
      s.record.requestVersion = s.request.version;
    },
    "withheld_by_current_intake",
  ],
  [
    "missing independent audit entry",
    (s) => {
      s.state.audit = [];
    },
  ],
  [
    "synthetic normalized input",
    (s) => {
      s.input.isSynthetic = true;
    },
  ],
  [
    "flattened synthetic fact identity",
    (s) => {
      s.input.syntheticFactIds = [s.candidate.id];
    },
  ],
  [
    "unknown source state",
    (s) => {
      s.candidate.state = "unknown";
    },
  ],
  [
    "already qualified source authority",
    (s) => {
      s.candidate.state = "qualified";
      s.candidate.acceptedAt = acceptedAt;
      s.candidate.acceptedBy = "303";
      s.candidate.acceptanceReceipt = "private-old-acceptance";
    },
  ],
  [
    "acceptance hidden on an observed source",
    (s) => {
      s.candidate.acceptedAt = acceptedAt;
    },
  ],
  [
    "unrelated contribution artifact",
    (s) => {
      s.evidence.contribution.artifactId = "unrelated-artifact";
    },
  ],
  [
    "ineligible source proof",
    (s) => {
      s.evidence.contribution.qualification = "ineligible";
    },
  ],
  [
    "missing source actor",
    (s) => {
      s.input.actors = s.input.actors.filter((actor) => actor.id !== s.candidate.actorId);
    },
  ],
  [
    "source role contradicted by proof",
    (s) => {
      s.evidence.contribution.roles = ["merger"];
    },
  ],
  [
    "automation role relabelled as PR work",
    (s) => {
      s.candidate.role = "automation";
      s.evidence.contribution.roles = ["automation"];
    },
  ],
  [
    "different public artifact revision",
    (s) => {
      s.record.details.publicRecord.revision = before;
      s.record.details.publicRecord.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/blob/${before}/operations/public.json`;
    },
  ],
  [
    "public artifact from an unrelated repository",
    (s) => {
      s.record.details.publicRecord.sourceRevisionUrl = `https://github.com/synthetic-owner/another/blob/${after}/operations/public.json`;
    },
  ],
  [
    "commit URL instead of an actual public artifact path",
    (s) => {
      s.record.details.publicRecord.sourceRevisionUrl = `https://github.com/synthetic-owner/repository/commit/${after}`;
    },
  ],
  [
    "missing public artifact hash",
    (s) => {
      delete s.record.details.publicRecord.contentHash;
    },
  ],
  [
    "undeclared private environment field",
    (s) => {
      s.record.details.environment = "private-production-environment";
    },
  ],
  [
    "known source occurrence after acceptance",
    (s) => {
      s.decision.at = Date.parse("2026-10-06T10:00:00.000Z");
      // Keep the fictional independent intake valid at this earlier review so
      // the unchanged negative assertion reaches the source occurrence bound.
      attachSyntheticEvidenceIntake(s.request);
    },
  ],
  [
    "expired reviewed source at publication cutoff",
    (s) => {
      s.record.validUntil = acceptedAt;
    },
  ],
  [
    "raw-activity policy instead of qualified canonical units",
    (s) => {
      s.policies[0].policy.rankedStates = ["observed", "qualified"];
    },
  ],
];
for (const metric of metrics) {
  for (const [name, mutate, earlierIntakeBoundary] of invalidCommon) {
    test(`operations ${metric}: ${name} fails before any receipt callback and permits a repaired retry`, () => {
      const s = scenario(metric);
      mutate(s);
      if (earlierIntakeBoundary) {
        // A changed request version now loses current intake authority before
        // the destination-specific qualifier; it must retain no new credit.
        let calls = 0;
        const original = structuredClone(s.input);
        const output = run(s, {
          applyReceipt: (input) => {
            calls += 1;
            return input;
          },
        });
        assert.equal(calls, 0);
        assert.deepEqual(output, original);
        assert.deepEqual(s.input, original);
      } else rejectBeforeReceipt(s);
      assert.equal(recognized(scenario(metric)).length, 1);
    });
  }
}

for (const kind of ["governance_decision", "repository_rules", "public_repository_settings", "repository_process"]) {
  test(`operations governance: reviewed ${kind} has its own accepted decision version`, () => {
    const s = scenario("governance");
    s.record.details.kind = kind;
    const next = alias(s);
    next.record.details.decisionVersion = "v2";
    assert.equal(recognized(s, run(s, joined([next, s]))).length, 2);
  });
}
for (const [name, mutate] of [
  [
    "permission administration alone",
    (s) => {
      s.record.details.kind = "permission_administration";
    },
  ],
  [
    "an unaccepted governance proposal",
    (s) => {
      s.record.details.disposition = "proposed";
    },
  ],
  [
    "an undeclared access roster",
    (s) => {
      s.record.details.memberIds = ["private-member"];
    },
  ],
]) {
  test(`operations governance: ${name} is not accepted governance work`, () => {
    const s = scenario("governance");
    mutate(s);
    rejectBeforeReceipt(s);
  });
}
for (const [name, mutate] of [
  [
    "execution-only run",
    (s) => {
      s.record.details.workKind = "deployment_execution";
    },
  ],
  [
    "unknown deployment source use",
    (s) => {
      s.record.details.sourceUse = "unknown";
    },
  ],
  [
    "no linked deployment object",
    (s) => {
      s.record.details.deploymentIds = [];
    },
  ],
  [
    "repeated deployment identifiers",
    (s) => {
      s.record.details.deploymentIds.push(s.record.details.deploymentIds[0]);
    },
  ],
  [
    "private free-text environment as an identifier",
    (s) => {
      s.record.details.deploymentIds = ["private customer production environment"];
    },
  ],
]) {
  test(`operations deployment_work: ${name} fails qualification`, () => {
    const s = scenario("deployment_work");
    mutate(s);
    rejectBeforeReceipt(s);
  });
}
for (const [name, mutate] of [
  [
    "incident count",
    (s) => {
      s.record.details.workKind = "incident_count";
    },
  ],
  [
    "personally owned uptime",
    (s) => {
      s.record.details.workKind = "uptime";
    },
  ],
  [
    "unapproved narrative",
    (s) => {
      s.record.details.narrativeApproved = false;
    },
  ],
  [
    "string approval instead of explicit true",
    (s) => {
      s.record.details.narrativeApproved = "true";
    },
  ],
]) {
  test(`operations incidents: ${name} cannot become reliability merit`, () => {
    const s = scenario("incidents");
    mutate(s);
    rejectBeforeReceipt(s);
  });
}
test("operations incidents: remediation stays approved narrative spotlight and refuses ranked output", () => {
  const s = scenario("incidents");
  s.record.details.workKind = "remediation";
  const output = run(s);
  assert.equal(recognized(s, output).length, 1);
  assert.equal(getMetricDefinition("incidents").display, "spotlight");
  assert.deepEqual(getMetricUi("incidents").supported_combinations, []);
  assert.throws(() => aggregate(s, output, {}, true));
});
test("operations: one PR can contain separately accepted governance, deployment and reliability work without crossing category units", () => {
  const cases = metrics.map((metric) => scenario(metric));
  const output = run(cases[0], joined(cases, true));
  for (const s of cases) assert.equal(recognized(s, output).length, 1);
  assert.equal(new Set(output.facts.filter((f) => metrics.includes(f.metricId)).map((f) => f.canonicalKey)).size, 3);
});

// This is the literal authority contract before the operations correction. It
// must not call the current fingerprint implementation to construct its oracle.
function priorAuthority(state, bindings) {
  const requests = Object.values(state.requests ?? {})
    .filter((r) => r.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.suppressed)
    .map(([id]) => id)
    .sort();
  const decisions = new Set(
    requests.flatMap((r) => (r.history ?? []).filter((h) => h.action === "accepted").map((h) => h.id)),
  );
  const audit = (state.audit ?? [])
    .filter((entry) => decisions.has(entry.id))
    .map((entry) => JSON.stringify(entry))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  for (const [metric, marker] of [
    ["data_quality", "data-quality-recognition/v1"],
    ["reproductions", "reproduction-recognition/v1"],
    ["confirmed_bugs", "confirmed-bug-source-admission/v1"],
    ["issue_answers", "issue-answer-source-time/v1"],
    ["maintenance", "maintenance-merged-participant/v1"],
    ["automation", "automation-merged-participant/v1"],
  ])
    if (bindings.some((binding) => binding.metricId === metric)) authority.push(marker);
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}
for (const metric of metrics) {
  test(`operations ${metric}: old generic publication authority retires even before a matching request exists`, () => {
    const s = scenario(metric),
      empty = { requests: {}, profiles: {}, audit: [] };
    assert.notEqual(recognitionFingerprint(s.state, [s.binding]), priorAuthority(s.state, [s.binding]));
    assert.notEqual(recognitionFingerprint(empty, [s.binding]), priorAuthority(empty, [s.binding]));
    const other = { ...s.binding, metricId: "maintenance" };
    assert.notEqual(recognitionFingerprint(s.state, [other, s.binding]), priorAuthority(s.state, [other, s.binding]));
  });
}
test("operations: unaffected automatic metrics retain prior fingerprints while manual intake retires old authority", () => {
  const s = scenario("governance");
  const empty = { requests: {}, profiles: {}, audit: [] };
  for (const definition of metricRegistryV1.metrics) {
    if (metrics.includes(definition.id)) continue;
    const bindings = [{ ...s.binding, metricId: definition.id }];
    if (definition.id === "helpful_feedback") {
      for (const state of [s.state, empty])
        assert.throws(() => recognitionFingerprint(state, bindings), /invalid_discussion_feedback_contract/);
      continue;
    }
    assert.notEqual(recognitionFingerprint(s.state, bindings), priorAuthority(s.state, bindings));
    if (
      ["release_changes", "issue_ordering", "release_stewardship", "performance", "regressions_prevented"].includes(
        definition.id,
      )
    )
      assert.notEqual(recognitionFingerprint(empty, bindings), priorAuthority(empty, bindings));
    else assert.equal(recognitionFingerprint(empty, bindings), priorAuthority(empty, bindings), definition.id);
  }
  const bindings = [
    "data_quality",
    "reproductions",
    "confirmed_bugs",
    "issue_answers",
    "maintenance",
    "automation",
  ].map((metricId) => ({ ...s.binding, metricId }));
  assert.notEqual(recognitionFingerprint(s.state, bindings), priorAuthority(s.state, bindings));
  assert.notEqual(recognitionFingerprint(s.state, []), priorAuthority(s.state, []));
  assert.equal(recognitionFingerprint(empty, bindings), priorAuthority(empty, bindings));
  assert.equal(recognitionFingerprint(empty, []), priorAuthority(empty, []));
});

// These fictional operations-only fixtures use explicit empty collaborators and
// current reviewed intake. Preserve their exact authority encoding before the
// identifier-list admission marker; do not obtain the oracle from the adapter.
function priorOperationsIdentifierAuthority(state, bindings) {
  assert.ok(bindings.every((binding) => metrics.includes(binding.metricId)));
  const requests = Object.values(state.requests ?? {})
    .filter((request) => request.kind === "evidence")
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(requests.every((request) => Object.keys(request.collaborators).length === 0));
  const suppressed = Object.entries(state.profiles ?? {})
    .filter(([, profile]) => profile.suppressed)
    .map(([id]) => id)
    .sort();
  const decisions = new Set(
    requests.flatMap((request) =>
      request.history.filter((event) => event.action === "accepted").map((event) => event.id),
    ),
  );
  const audit = (state.audit ?? [])
    .filter((event) => decisions.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  if (bindings.length) authority.push("operations-contribution-evidence/v1");
  if (requests.length) authority.push(evidenceIntakeAuthority());
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

for (const metric of metrics) {
  for (const shape of ["sparse", "undefined"]) {
    test(`operations ${metric}: selected ${shape} owner roster retires its pre-identifier authority`, () => {
      const s = scenario(metric);
      assert.equal(
        recognitionFingerprint(s.state, [s.binding]),
        priorOperationsIdentifierAuthority(s.state, [s.binding]),
      );
      const sparse = [s.decision.actor];
      sparse.length = 2;
      const explicit = [s.decision.actor, undefined];
      s.binding.domainEvidence.ownerIds = sparse;
      const sparseAuthority = priorOperationsIdentifierAuthority(s.state, [s.binding]);
      s.binding.domainEvidence.ownerIds = explicit;
      assert.equal(priorOperationsIdentifierAuthority(s.state, [s.binding]), sparseAuthority);
      s.binding.domainEvidence.ownerIds = shape === "sparse" ? sparse : explicit;
      rejectBeforeReceipt(s);
      assert.notEqual(recognitionFingerprint(s.state, [s.binding]), sparseAuthority);
    });
  }

  test(`operations ${metric}: valid dense owner roster preserves its pre-identifier authority and unit`, () => {
    const s = scenario(metric);
    s.binding.domainEvidence.ownerIds = [s.decision.actor, "909"];
    const expected = priorOperationsIdentifierAuthority(s.state, [s.binding]);
    let calls = 0;
    const output = run(s, {
      applyReceipt: (...args) => {
        calls++;
        return applyRecognitionReceipt(...args);
      },
    });
    assert.equal(calls, 1);
    assert.equal(recognized(s, output).length, 1);
    assert.equal(recognitionFingerprint(s.state, [s.binding]), expected);
  });

  test(`operations ${metric}: unused sparse specialist rosters preserve current authority and unit`, () => {
    const s = scenario(metric);
    s.binding.domainEvidence.contractReviewerIds = new Array(1);
    s.binding.domainEvidence.disclosureReviewerIds = [undefined];
    assert.equal(
      recognitionFingerprint(s.state, [s.binding]),
      priorOperationsIdentifierAuthority(s.state, [s.binding]),
    );
    assert.equal(recognized(s).length, 1);
  });

  test(`operations ${metric}: sparse owner fencing selects only the current request and decision record`, () => {
    for (const mutate of [
      (s) => {
        s.record.requestId = "other-request";
      },
      (s) => {
        s.record.requestVersion--;
      },
      (s) => {
        s.record.decisionId = "older-decision";
      },
    ]) {
      const s = scenario(metric);
      s.binding.domainEvidence.ownerIds = [s.decision.actor, undefined];
      mutate(s);
      rejectBeforeReceipt(s);
      assert.equal(
        recognitionFingerprint(s.state, [s.binding]),
        priorOperationsIdentifierAuthority(s.state, [s.binding]),
      );
    }
  });

  test(`operations ${metric}: inactive or unmatched sparse owners preserve unselected authority without callbacks`, () => {
    for (const mutate of [
      (s) => {
        s.request.status = "withdrawn";
      },
      (s) => {
        s.state.profiles[s.request.owner] = { suppressed: true };
      },
      (s) => {
        s.binding.scope = "repository:2:unselected";
      },
      (s) => {
        s.state.requests = {};
      },
    ]) {
      const s = scenario(metric);
      s.binding.domainEvidence.ownerIds = [s.decision.actor, undefined];
      mutate(s);
      const output = run(s, {
        applyReceipt: () => {
          assert.fail("unselected source must not reach the receipt callback");
        },
      });
      assert.deepEqual(output, s.input);
      assert.equal(
        recognitionFingerprint(s.state, [s.binding]),
        priorOperationsIdentifierAuthority(s.state, [s.binding]),
      );
    }
  });
}

// Deployment IDs are private selected authority, not additional contribution units.
// Preserve the same prior hash oracle used by the owner-roster controls above.
for (const shape of ["sparse", "undefined"]) {
  test(`operations deployment ID authority: selected ${shape} IDs retire their prior fingerprint`, () => {
    const s = scenario("deployment_work");
    const sparse = ["private-deployment-one"];
    sparse.length = 2;
    const explicit = ["private-deployment-one", undefined];
    s.record.details.deploymentIds = sparse;
    const old = priorOperationsIdentifierAuthority(s.state, [s.binding]);
    s.record.details.deploymentIds = explicit;
    assert.equal(priorOperationsIdentifierAuthority(s.state, [s.binding]), old);
    s.record.details.deploymentIds = shape === "sparse" ? sparse : explicit;
    rejectBeforeReceipt(s);
    assert.notEqual(recognitionFingerprint(s.state, [s.binding]), old);
  });
}

test("operations deployment ID authority: dense IDs preserve prior authority and the one-work unit", () => {
  const s = scenario("deployment_work");
  s.record.details.deploymentIds = ["private-deployment-one", "private-deployment-two"];
  const expected = priorOperationsIdentifierAuthority(s.state, [s.binding]);
  let calls = 0;
  const output = run(s, {
    applyReceipt: (...args) => {
      calls++;
      return applyRecognitionReceipt(...args);
    },
  });
  assert.equal(calls, 1);
  assert.equal(recognized(s, output).length, 1);
  assert.equal(aggregate(s, output).rows[0].value, 1);
  assert.equal(recognitionFingerprint(s.state, [s.binding]), expected);
});

test("operations deployment ID authority: stale or other request records keep the prior fingerprint", () => {
  for (const mutate of [
    (s) => {
      s.record.requestId = "other-request";
    },
    (s) => {
      s.record.requestVersion--;
    },
    (s) => {
      s.record.decisionId = "older-decision";
    },
  ]) {
    const s = scenario("deployment_work");
    s.record.details.deploymentIds = [undefined];
    mutate(s);
    rejectBeforeReceipt(s);
    assert.equal(
      recognitionFingerprint(s.state, [s.binding]),
      priorOperationsIdentifierAuthority(s.state, [s.binding]),
    );
  }
  const s = scenario("deployment_work");
  s.binding.domainEvidence.records.push({
    ...structuredClone(s.record),
    requestId: "unselected-deployment-request",
    details: { ...structuredClone(s.record.details), deploymentIds: new Array(1) },
  });
  assert.equal(recognized(s).length, 1);
  assert.equal(recognitionFingerprint(s.state, [s.binding]), priorOperationsIdentifierAuthority(s.state, [s.binding]));
});

test("operations deployment ID authority: inactive and unmatched bindings do not add a new marker", () => {
  for (const mutate of [
    (s) => {
      s.request.status = "withdrawn";
    },
    (s) => {
      s.state.profiles[s.request.owner] = { suppressed: true };
    },
    (s) => {
      s.binding.scope = "repository:2:unselected";
    },
    (s) => {
      s.state.requests = {};
    },
  ]) {
    const s = scenario("deployment_work");
    s.record.details.deploymentIds = [undefined];
    mutate(s);
    const output = run(s, { applyReceipt: () => assert.fail("unselected deployment IDs must not call the receipt") });
    assert.deepEqual(output, s.input);
    assert.equal(
      recognitionFingerprint(s.state, [s.binding]),
      priorOperationsIdentifierAuthority(s.state, [s.binding]),
    );
  }
});

// Literal runtime configuration encoding, independent of the recognition hash.
// A hole and explicit undefined collide in both old encodings; null does not.
const operationsCanonicalConfiguration = (value) =>
  Array.isArray(value)
    ? `[${value.map(operationsCanonicalConfiguration).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${operationsCanonicalConfiguration(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const operationsConfigurationHash = (value) =>
  createHash("sha256").update(operationsCanonicalConfiguration(value)).digest("hex");

test("operations deployment ID authority: retained SQL publication is withheld after reopen and undefined refresh", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario("deployment_work");
  s.input = JSON.parse(
    JSON.stringify(s.input)
      .replace(/synthetic/gi, "fixture")
      .replaceAll("fixture-owner/repository", "example-org/example-repo"),
  );
  s.candidate = s.input.facts.find((fact) => fact.metricId === "pr_merged");
  s.evidence = s.input.evidence.find((entry) => entry.contribution.contributionId === s.candidate.id);
  s.request.locator = s.evidence.artifact.publicUrl;
  attachSyntheticEvidenceState(s.state);
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  s.record.details.publicRecord.sourceRevisionUrl = `https://github.com/example-org/example-repo/blob/${after}/operations/public.json`;
  // Produce valid accepted work first. Then retain that exact old output without
  // its observed candidate, so seeding SQL cannot silently requalify the record.
  const legacyOutput = run(s);
  assert.equal(recognized(s, legacyOutput).length, 1);
  legacyOutput.facts = legacyOutput.facts.filter((fact) => fact.id !== s.candidate.id);
  let retained = legacyOutput;
  let normalizationCalls = 0;
  s.record.details.deploymentIds = new Array(1);
  const payload = JSON.parse(JSON.stringify(fixture.pull_request).replace(/synthetic/gi, "fixture"));
  payload.html_url = s.request.locator;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [payload],
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => {
      normalizationCalls++;
      // The legacy output deliberately omits its merged candidate, and both
      // outputs retain fixed observation clocks for saved-authority checks.
      // Neither supplies the original source/fact binding of a physical receipt.
      const output = structuredClone(retained);
      delete output.physicalContext;
      return output;
    },
    configure(config) {
      config.repositories[0].families = ["pull_requests"];
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition("deployment_work").definition.unit,
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
  const read = (runtime, pin) => runtime.source.read(publicScope, pin, new AbortController().signal);
  for (const pin of [null, snapshotId]) assert.equal((await read(h.runtime, pin)).selected.rows[0].result.value, 1);
  const currentFingerprint = recognitionFingerprint(h.controlsStore.read(), h.options.config.recognitionBindings);
  const oldFingerprint = priorOperationsIdentifierAuthority(
    h.controlsStore.read(),
    h.options.config.recognitionBindings,
  );
  const configuration = operationsConfigurationHash(h.options.config);
  const confirmation = h.controlsStore.read().pipelinePublications[snapshotId];
  assert.equal(confirmation.configurationHash, configuration);
  assert.equal(confirmation.recognitionFingerprint, currentFingerprint);
  const headKey = confirmation.scopeKey;
  assert.equal(h.controlsStore.read().pipelineHeads[headKey].snapshotId, snapshotId);
  assert.equal(h.controlsStore.read().pipelineHeads[headKey].recognitionFingerprint, currentFingerprint);
  const savedRows = async () =>
    (
      await h.db.query(
        "SELECT fact_key,policy_signature,document,document_hash FROM leaderboard_pipeline.normalizations ORDER BY fact_key,policy_signature",
      )
    ).rows;
  const originalSavedRows = await savedRows();
  assert.equal(originalSavedRows.length, 1);
  assert.equal(Object.hasOwn(originalSavedRows[0].document, "physicalContext"), false);
  assert.equal(
    originalSavedRows[0].document.facts.filter(
      (fact) => fact.metricId === "deployment_work" && fact.state === "qualified",
    ).length,
    1,
  );
  assert.equal(
    originalSavedRows[0].document.facts.some((fact) => fact.id === s.candidate.id),
    false,
  );
  const savedNormalizationCalls = normalizationCalls;
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshotId].recognitionFingerprint = oldFingerprint;
    state.pipelineHeads[headKey].recognitionFingerprint = oldFingerprint;
  });
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const denied = async (runtime, phase) => {
    assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, oldFingerprint);
    assert.equal(h.controlsStore.read().pipelineHeads[headKey].recognitionFingerprint, oldFingerprint);
    assert.equal(
      h.controlsStore.read().pipelinePublications[snapshotId].configurationHash,
      operationsConfigurationHash(h.options.config),
    );
    const current = await read(runtime, null);
    const pinned = await read(runtime, snapshotId);
    const response = await runtime.app.inject(`/api/v1/boards?metric=deployment_work&snapshot=${snapshotId}`);
    t.diagnostic(
      JSON.stringify({
        phase,
        currentWithheld: current === null,
        pinnedWithheld: pinned === null,
        currentValue: current?.selected.rows[0]?.result.value ?? null,
        pinnedValue: pinned?.selected.rows[0]?.result.value ?? null,
        httpStatus: response.statusCode,
      }),
    );
    assert.deepEqual(await savedRows(), originalSavedRows);
    assert.equal(normalizationCalls, savedNormalizationCalls);
    assert.deepEqual(
      [current === null, pinned === null],
      [true, true],
      "old sparse deployment authority must withhold both current and pinned saved SQL publications",
    );
    assert.equal(response.statusCode, 410, response.body);
    assert.match(response.headers["cache-control"], /no-store/);
  };
  await denied(restarted, "reopened-sparse");
  await restarted.stop();
  const explicit = structuredClone(h.options.config);
  explicit.recognitionBindings[0].domainEvidence.records[0].details.deploymentIds = [undefined];
  assert.equal(operationsConfigurationHash(explicit), configuration);
  assert.equal(
    priorOperationsIdentifierAuthority(h.controlsStore.read(), explicit.recognitionBindings),
    oldFingerprint,
  );
  h.options.config = explicit;
  const refreshed = await createPipeline(h.options);
  t.after(() => refreshed.stop());
  await denied(refreshed, "explicit-undefined-refresh");
  await refreshed.stop();
  h.options.config.recognitionBindings[0].domainEvidence.records[0].details.deploymentIds = [
    "private-deployment-repaired",
  ];
  h.options.config.version = "configuration-deployment-repaired-v2";
  h.duplicate();
  retained = s.input;
  let receiptCalls = 0;
  h.options.components = {
    ...components,
    github: {
      ...components.github,
      applyRecognitionReceipt(...args) {
        receiptCalls++;
        return components.github.applyRecognitionReceipt(...args);
      },
    },
  };
  const repaired = await createPipeline(h.options);
  t.after(() => repaired.stop());
  const result = await repaired.runOnce({ cutoff });
  assert.equal(result.state, "published");
  assert.equal(receiptCalls, 1);
  assert.ok((await savedRows()).every(({ document }) => !Object.hasOwn(document, "physicalContext")));
  assert.ok(normalizationCalls > savedNormalizationCalls);
  const newId = result.publications[0].snapshotId;
  assert.notEqual(newId, snapshotId);
  assert.equal((await read(repaired, newId)).selected.rows[0].result.value, 1);
  assert.equal(await read(repaired, snapshotId), null);
});
