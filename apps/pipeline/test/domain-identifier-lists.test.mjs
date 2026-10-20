// Fictional protected-host fixtures only; no actual research, consent or source approval.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  normalizeGithubObservation,
  applyRecognitionReceipt,
  defaultDeliveryNormalizationVersion,
} from "@pick-your-ai/github";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { qualifyDomainRecognition, domainDateBasis } from "../src/domain-recognition.mjs";
import { hasRequiredParticipantConsent } from "../../controls/src/evidence-consent.mjs";
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
  negative_findings: { findingId: "finding:1", findingVersion: "v1", outcome: "unknown", sourceIds: ["source:1"] },
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
  accessibility: {
    artifactId: "journey:1",
    artifactVersion: "v1",
    phase: "audit",
    criteria: ["wcag:1.3.1"],
    reviewMethod: "automated",
  },
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
  security: {
    disclosureId: "public-advisory:1",
    disclosureVersion: "v1",
    publishedAt: occurredAt,
    publicDisclosureApproved: true,
    contributorConsent: true,
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
const error = /domain_recognition_evidence_unverified/;
const direct = (s) =>
  qualifyDomainRecognition({
    input: s.input,
    request: s.request,
    decision: s.decision,
    binding: s.binding,
    candidate: s.candidate,
    acceptedAt,
    cutoff,
  });
const materialize = (s, apply = applyRecognitionReceipt) =>
  materializeRecognition(s.input, s.state, [s.binding], s.policies, apply, cutoff);
const count = (s, output) =>
  output.facts.filter((fact) => fact.metricId === s.binding.metricId && fact.state === "qualified").length;
const gap = () => Array(1);
const profiles = [
  ["catalog sources", "catalog_proposals", "sourceIds"],
  ["pricebook sources", "pricebook_proposals", "sourceIds"],
  ["pricebook units", "pricebook_proposals", "units"],
  ["negative-finding sources", "negative_findings", "sourceIds"],
  ["assumption sources", "assumptions_resolved", "sourceIds"],
  ["market-study sources", "market_research", "sourceIds"],
  ["usability sources", "usability", "sourceIds"],
  ["manifest sources", "evidence_manifests", "sourceIds"],
  ["accessibility criteria", "accessibility", "criteria"],
  ["catalog owners", "catalog_proposals", "ownerIds", true],
  ["compatibility reviewers", "compatibility_proposals", "contractReviewerIds", true],
  ["disclosure reviewers", "security", "disclosureReviewerIds", true],
];
function listTarget(s, profile) {
  return profile[3] ? s.binding.domainEvidence : s.record.details;
}
function sparseFor(profile) {
  const value = gap();
  if (profile[3]) value.unshift("202");
  return value;
}

test("identifier lists reject missing IDs through exported and materialized qualification", async (t) => {
  for (const profile of profiles) {
    for (const route of ["direct", "materialized"])
      await t.test(`${profile[0]} via ${route}`, () => {
        const s = scenario(profile[1]);
        const target = listTarget(s, profile),
          valid = target[profile[2]];
        assert.ok(direct(s));
        assert.equal(count(s, materialize(s)), 1);
        target[profile[2]] = sparseFor(profile);
        const input = structuredClone(s.input);
        if (route === "direct") assert.throws(() => direct(s), error);
        else {
          let callbacks = 0;
          assert.throws(
            () =>
              materialize(s, (...args) => {
                callbacks++;
                return applyRecognitionReceipt(...args);
              }),
            error,
          );
          assert.equal(callbacks, 0);
        }
        assert.deepEqual(s.input, input);
        target[profile[2]] = valid;
        assert.ok(direct(s));
        assert.equal(count(s, materialize(s)), 1);
      });
  }
});

test("identifier lists require own dense slots while retaining all existing ID bounds", async (t) => {
  const inherited = [];
  inherited.length = 1;
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: "source:inherited" }));
  const values = [
    ["inherited index", inherited],
    ["middle hole", ["source:1", , "source:2"]],
    ["undefined", [undefined]],
    ["null", [null]],
    ["empty", []],
    ["duplicate", ["source:1", "source:1"]],
    ["invalid ID", ["not an ID"]],
    ["non-array", "source:1"],
    ["over budget", Array.from({ length: 33 }, (_, i) => `source:${i}`)],
  ];
  for (const [name, value] of values)
    await t.test(name, () => {
      const s = scenario("market_research");
      s.record.details.sourceIds = value;
      assert.throws(() => direct(s), error);
      assert.throws(() => materialize(s), error);
    });
  const s = scenario("market_research");
  s.record.details.sourceIds = Array.from({ length: 32 }, (_, i) => `source:${i}`);
  assert.equal(count(s, materialize(s)), 1);
  s.record.details.sourceIds.reverse();
  assert.equal(count(s, materialize(s)), 1);
});

// Literal 59f6610 authority algorithm. Its existing markers stay frozen so a
// new malformed-list fence cannot mask changes to valid or unrelated authority.
function legacyFingerprint(state, bindings = []) {
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
  // A receipt's current audit entry is part of the authority used below. Fence
  // publication and pinned reads when it disappears, changes or is duplicated.
  const audit = (state.audit ?? [])
    .filter((event) => decisionIds.has(event.id))
    .map((event) => JSON.stringify(event))
    .sort();
  // Version the target/clock authority and include exact current bindings. An old
  // unbound locale publication cannot remain authorized after this correction.
  const authority = ["localization-review-target/v1", requests, suppressed, audit, bindings];
  // Retire old authority for participant-bearing or malformed consent records.
  // An explicit empty collaborator set keeps its unchanged prior semantics.
  if (requests.some((request) => !hasRequiredParticipantConsent(request) || Object.keys(request.collaborators).length))
    authority.push("required-participant-consent/v1");
  // Earlier generic data-quality receipts did not qualify correction provenance.
  // Retire their publication authority without changing unaffected bindings.
  if (bindings.some((binding) => binding.metricId === "data_quality")) authority.push("data-quality-recognition/v1");
  // Generic reproduction receipts had no scenario/environment/result boundary.
  if (bindings.some((binding) => binding.metricId === "reproductions")) authority.push("reproduction-recognition/v1");
  // Earlier generic bug receipts admitted non-issue and explicitly synthetic sources.
  if (bindings.some((binding) => binding.metricId === "confirmed_bugs"))
    authority.push("confirmed-bug-source-admission/v1");
  // Earlier answer receipts could precede their known source occurrence. Retire
  // only configurations whose destination is affected by that missing bound.
  if (bindings.some((binding) => binding.metricId === "issue_answers")) authority.push("issue-answer-source-time/v1");
  // Prior maintenance receipts lacked merged-participant, clock and unit admission.
  if (bindings.some((binding) => binding.metricId === "maintenance"))
    authority.push("maintenance-merged-participant/v1");
  // Tooling receipts independently require verified merged participation as well.
  if (bindings.some((binding) => binding.metricId === "automation")) authority.push("automation-merged-participant/v1");
  // Missing legacy intake cannot keep manual recognition current, even without collaborators.
  // No-manual-request automatic source authority keeps its existing exact format.
  if (requests.length) authority.push(evidenceIntakeAuthority());
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

test("only selected unsafe identifier lists retire the exact prior recognition authority", async (t) => {
  for (const profile of profiles)
    await t.test(profile[0], () => {
      const s = scenario(profile[1]);
      assert.equal(recognitionFingerprint(s.state, [s.binding]), legacyFingerprint(s.state, [s.binding]));
      listTarget(s, profile)[profile[2]] = sparseFor(profile);
      assert.notEqual(recognitionFingerprint(s.state, [s.binding]), legacyFingerprint(s.state, [s.binding]));
      const explicit = structuredClone(s.binding);
      const target = profile[3] ? explicit.domainEvidence : explicit.domainEvidence.records[0].details;
      target[profile[2]] = Array.from(target[profile[2]]);
      assert.equal(legacyFingerprint(s.state, [explicit]), legacyFingerprint(s.state, [s.binding]));
      assert.notEqual(recognitionFingerprint(s.state, [explicit]), legacyFingerprint(s.state, [explicit]));
    });
  for (const [name, invalidate] of [
    ["stale request version", (record) => (record.requestVersion = 1)],
    ["different accepted decision", (record) => (record.decisionId = "old-accepted-decision")],
  ])
    await t.test(name, () => {
      const stale = scenario("market_research");
      stale.record.details.sourceIds = gap();
      invalidate(stale.record);
      assert.throws(() => direct(stale), error);
      assert.throws(() => materialize(stale), error);
      assert.equal(
        recognitionFingerprint(stale.state, [stale.binding]),
        legacyFingerprint(stale.state, [stale.binding]),
      );
    });
  const s = scenario("market_research");
  s.binding.domainEvidence.ownerIds = gap();
  s.binding.domainEvidence.contractReviewerIds = gap();
  s.binding.domainEvidence.disclosureReviewerIds = gap();
  s.binding.domainEvidence.records.push({ requestId: "unselected", details: { sourceIds: gap() } });
  assert.equal(recognitionFingerprint(s.state, [s.binding]), legacyFingerprint(s.state, [s.binding]));
  s.record.details.sourceIds = gap();
  assert.equal(
    recognitionFingerprint({ requests: {}, profiles: {}, audit: [] }, [s.binding]),
    legacyFingerprint({ requests: {}, profiles: {}, audit: [] }, [s.binding]),
  );
  s.request.status = "withdrawn";
  assert.equal(recognitionFingerprint(s.state, [s.binding]), legacyFingerprint(s.state, [s.binding]));
  const unrelated = scenario("primary_sources");
  unrelated.binding.domainEvidence.records.push({ requestId: "unselected", details: { sourceIds: gap() } });
  assert.equal(
    recognitionFingerprint(unrelated.state, [unrelated.binding]),
    legacyFingerprint(unrelated.state, [unrelated.binding]),
  );
});

// Matches the existing runtime configuration encoder, independently of the
// JSON.stringify recognition authority. A hole and explicit undefined collide
// in both encodings; null does not collide in the configuration encoder.
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const configurationHash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

test("legacy sparse-list publication retires after reopen and undefined refresh, then dense repair succeeds", async (t) => {
  const { harness, components, publicScope } = await import("./harness.mjs");
  const { createPipeline } = await import("../src/runtime.mjs");
  const s = scenario("market_research");
  s.input = JSON.parse(
    JSON.stringify(s.input)
      .replace(/synthetic/gi, "fixture")
      .replaceAll("fixture-owner/repository", "example-org/example-repo"),
  );
  s.candidate = s.input.facts.find((f) => f.metricId === "pr_merged");
  s.evidence = s.input.evidence.find((e) => e.contribution.contributionId === s.candidate.id);
  s.request.locator = s.evidence.artifact.publicUrl;
  attachSyntheticEvidenceState(s.state);
  s.record.sourceRevisionUrl = s.evidence.sourceRevisionUrl;
  // The retained legacy normalization has exactly the public accepted output
  // produced by a valid reviewed fixture. Source IDs are private and never enter
  // that output. Remove only its observed receipt candidate while seeding SQL,
  // so new qualification does not rewrite this simulated pre-upgrade artifact.
  const legacyOutput = materialize(s);
  legacyOutput.facts = legacyOutput.facts.filter((fact) => fact.id !== s.candidate.id);
  let retained = legacyOutput;
  s.record.details.sourceIds = gap();
  const payload = JSON.parse(JSON.stringify(fixture.pull_request).replace(/synthetic/gi, "fixture"));
  payload.html_url = s.request.locator;
  const h = await harness(t, {
    markerFreeConfig: true,
    dataMode: "public",
    payloads: [payload],
    defaultDeliveryNormalizationVersion,
    normalizerFactory: () => async () => {
      const output = structuredClone(retained);
      // This historical/custom adapter has no physical receipt contract. Its
      // deliberately stripped merge candidate cannot substantiate a stock one.
      delete output.physicalContext;
      return output;
    },
    configure(config) {
      config.recognitionBindings = [s.binding];
      const policy = {
        ...config.policies[0].policy,
        ...s.policies[0].policy,
        roles: ["author"],
        unit: components.metrics.getMetricDefinition("market_research").definition.unit,
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
  const assertNoPhysicalReceipt = async () => {
    const saved = (await h.db.query("SELECT document FROM leaderboard_pipeline.normalizations")).rows;
    assert.ok(saved.length > 0);
    assert.ok(saved.every(({ document }) => !Object.hasOwn(document, "physicalContext")));
  };
  const publication = await h.runtime.runOnce({ cutoff });
  assert.equal(publication.state, "published");
  await assertNoPhysicalReceipt();
  const snapshotId = publication.publications[0].snapshotId;
  const currentFingerprint = recognitionFingerprint(h.controlsStore.read(), h.options.config.recognitionBindings);
  const oldFingerprint = legacyFingerprint(h.controlsStore.read(), h.options.config.recognitionBindings);
  const read = (runtime, pin) => runtime.source.read(publicScope, pin, new AbortController().signal);
  const before = await read(h.runtime, snapshotId);
  assert.equal(before.selected.rows[0].result.value, 1);
  const configuration = configurationHash(h.options.config);
  const confirmation = h.controlsStore.read().pipelinePublications[snapshotId];
  assert.equal(confirmation.configurationHash, configuration);
  // A passing read with the current marker proves configuration, SQL content,
  // source generation and explanation guards all accept this exact artifact.
  assert.equal(confirmation.recognitionFingerprint, currentFingerprint);
  const headKey = confirmation.scopeKey;
  assert.equal(h.controlsStore.read().pipelineHeads[headKey].snapshotId, snapshotId);
  assert.equal(h.controlsStore.read().pipelineHeads[headKey].recognitionFingerprint, currentFingerprint);
  h.controlsStore.transaction((state) => {
    state.pipelinePublications[snapshotId].recognitionFingerprint = oldFingerprint;
    state.pipelineHeads[headKey].recognitionFingerprint = oldFingerprint;
  });
  assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, oldFingerprint);
  assert.equal(h.controlsStore.read().pipelineHeads[headKey].recognitionFingerprint, oldFingerprint);
  await h.runtime.stop();
  await h.reopenDatabase();
  const restarted = await createPipeline(h.options);
  t.after(() => restarted.stop());
  const denied = async (runtime) => {
    assert.equal(h.controlsStore.read().pipelinePublications[snapshotId].recognitionFingerprint, oldFingerprint);
    assert.equal(h.controlsStore.read().pipelineHeads[headKey].recognitionFingerprint, oldFingerprint);
    assert.equal(
      h.controlsStore.read().pipelinePublications[snapshotId].configurationHash,
      configurationHash(h.options.config),
    );
    for (const pin of [null, snapshotId]) assert.equal(await read(runtime, pin), null);
    const response = await runtime.app.inject(`/api/v1/boards?metric=market_research&snapshot=${snapshotId}`);
    assert.equal(response.statusCode, 410, response.body);
    assert.match(response.headers["cache-control"], /no-store/);
  };
  await denied(restarted);
  await restarted.stop();
  const explicit = structuredClone(h.options.config);
  explicit.recognitionBindings[0].domainEvidence.records[0].details.sourceIds = [undefined];
  assert.equal(configurationHash(explicit), configuration);
  assert.equal(legacyFingerprint(h.controlsStore.read(), explicit.recognitionBindings), oldFingerprint);
  h.options.config = explicit;
  const refreshed = await createPipeline(h.options);
  t.after(() => refreshed.stop());
  await denied(refreshed);
  await refreshed.stop();
  h.options.config.recognitionBindings[0].domainEvidence.records[0].details.sourceIds = ["source:repaired"];
  // A changed approved configuration owns a new publication version. A fresh
  // source revision also proves repair re-materializes the actual observed PR,
  // rather than merely reading the retained legacy accepted normalization.
  h.options.config.version = "configuration-repaired-v2";
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
  await assertNoPhysicalReceipt();
  assert.equal(receiptCalls, 1);
  const newId = result.publications[0].snapshotId;
  assert.equal((await read(repaired, newId)).selected.rows[0].result.value, 1);
  assert.equal(await read(repaired, snapshotId), null);
});
