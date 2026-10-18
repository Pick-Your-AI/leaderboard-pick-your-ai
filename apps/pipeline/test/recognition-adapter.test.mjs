import assert from "node:assert/strict";
import test from "node:test";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { publicDocumentationReasons } from "../../../packages/contracts/dist/index.js";
import { record } from "../../controls/src/store.mjs";
import { localizationReviewRequest } from "../../controls/src/localization-review.mjs";

const decision = {
  id: "receipt",
  action: "accepted",
  actor: "202",
  at: Date.parse("2026-10-01T00:00:00.000Z"),
  policyVersion: "v1",
};
const request = {
  id: "claim",
  kind: "evidence",
  status: "accepted",
  owner: "101",
  category: "finding",
  scope: "repo",
  policyVersion: "v1",
  locator: "https://github.com/org/repo/issues/1",
  collaborators: {},
  history: [decision],
};
const state = () => ({
  requests: { claim: structuredClone(request) },
  profiles: {},
  audit: [structuredClone(decision)],
});
const binding = {
  category: "finding",
  scope: "repo",
  policyVersion: "v1",
  metricId: "accepted_findings",
  sourceMetricId: "issues_opened",
  repositoryId: "2",
  reviewerIds: ["202"],
};
const input = {
  facts: [{ id: "fact", actorId: "101", repoId: "2", metricId: "issues_opened" }],
  actors: [],
  evidence: [
    { contribution: { contributionId: "fact" }, artifact: { publicUrl: request.locator, visibility: "public" } },
  ],
};
const policies = [{ policy: { metricId: binding.metricId, version: "v1", dateBasis: "acceptedAt" } }];
const apply = (s) =>
  materializeRecognition(
    input,
    s,
    [binding],
    policies,
    (raw, receipt) => ({ ...raw, receipt }),
    "2026-10-18T00:00:00.000Z",
  );
test("private audited decision binds exact owner, source metric, scope and approved policy", () => {
  assert.equal(apply(state()).receipt.targetFactId, "fact");
  assert.equal(apply(state()).receipt.acceptedAt, "2026-10-01T00:00:00.000Z");
  const invalid = state();
  invalid.audit = [];
  assert.throws(() => apply(invalid), /unverified/);
  invalid.audit = [decision];
  invalid.requests.claim.collaborators["202"] = "accepted";
  assert.throws(() => apply(invalid), /unverified/);
});
test("withdrawal, appeal, suppression and policy mismatch remove receipt without changing raw facts", () => {
  for (const status of ["withdrawn", "appealed", "pending", "rejected"]) {
    const s = state();
    s.requests.claim.status = status;
    assert.equal(apply(s).receipt, undefined);
    assert.notEqual(recognitionFingerprint(s), recognitionFingerprint(state()));
  }
  const s = state();
  s.profiles["101"] = { suppressed: true };
  assert.equal(apply(s).receipt, undefined);
  s.profiles = {};
  s.requests.claim.policyVersion = "v2";
  assert.equal(apply(s).receipt, undefined);
  assert.equal(input.facts.length, 1);
});

function reviewedLocaleFixture(sourceRevision = "c".repeat(40)) {
  const raw = structuredClone(input);
  raw.facts = ["fr", "de"].map((locale) => ({
    ...input.facts[0],
    id: locale,
    metricId: "localization",
    state: "observed",
    occurredAt: "2026-09-30T00:00:00.000Z",
  }));
  raw.evidence = raw.facts.map((fact) => ({
    artifact: input.evidence[0].artifact,
    sourceRevision,
    occurredAt: fact.occurredAt,
    contribution: {
      contributionId: fact.id,
      metricIds: ["localization"],
      reasonCodes: [
        "documentation_path_policy:synthetic-locales-v1",
        `locale:${fact.id}`,
        "localization_category:documentation",
        "private SECRET",
      ],
    },
  }));
  const configured = {
    ...binding,
    metricId: "localization",
    sourceMetricId: "localization",
    localization: { locale: "fr", category: "documentation", policyVersion: "synthetic-locales-v1" },
  };
  const reviewed = state();
  const claim = reviewed.requests.claim;
  claim.version = 0;
  claim.history = [];
  reviewed.audit = [];
  record(reviewed, claim, "202", "accepted", decision.at, {
    policyVersion: configured.policyVersion,
    localization: { ...configured.localization, targetFactId: "fr", sourceRevision },
    evidenceRequest: localizationReviewRequest(claim),
  });
  const run = (patch = {}) =>
    materializeRecognition(
      raw,
      reviewed,
      [{ ...configured, ...patch }],
      [{ policy: { metricId: "localization", version: "v1", dateBasis: "occurredAt" } }],
      (value, receipt) => ({
        ...value,
        receipt,
        evidence: [
          ...value.evidence,
          structuredClone(value.evidence.find((entry) => entry.contribution.contributionId === receipt.targetFactId)),
        ],
      }),
      "2026-10-18T00:00:00.000Z",
      publicDocumentationReasons,
    );
  return { raw, reviewed, configured, run };
}

test("locale audit targets preserve every accepted full Git SHA format without reinterpreting the reviewed string", () => {
  for (const revision of ["c".repeat(40), "C".repeat(40), "d".repeat(64), "D".repeat(64)]) {
    const fixture = reviewedLocaleFixture(revision);
    assert.equal(fixture.run().receipt.sourceRevision, revision);
    fixture.raw.evidence[0].sourceRevision =
      revision === revision.toLowerCase() ? revision.toUpperCase() : revision.toLowerCase();
    assert.equal(fixture.run().receipt, undefined);
  }
});

test("locale approval requires exact audited language/category/policy binding and preserves only public labels", () => {
  const { raw, configured, run } = reviewedLocaleFixture();
  const result = run();
  assert.equal(result.receipt.targetFactId, "fr");
  assert.deepEqual(result.evidence.at(-1).contribution.reasonCodes, [
    "independent_recognition_receipt",
    "documentation_path_policy:synthetic-locales-v1",
    "locale:fr",
    "localization_category:documentation",
  ]);
  assert.equal(run({ localization: { ...configured.localization, locale: "es" } }).receipt, undefined);
  assert.equal(
    run({ localization: { ...configured.localization, policyVersion: "synthetic-other" } }).receipt,
    undefined,
  );
  for (const patch of [
    { localization: undefined },
    { sourceMetricId: "documentation" },
    { localization: { ...configured.localization, locale: "und" } },
    { localization: { ...configured.localization, policyVersion: undefined } },
    { localization: { ...configured.localization, extra: "ignored" } },
  ])
    assert.throws(() => run(patch));
  assert.deepEqual(raw.evidence[0].contribution.reasonCodes.at(-1), "private SECRET");
});

test("a bound locale decision cannot follow a replaced merge pin, earlier review clock or changed selector", () => {
  for (const change of [
    ({ raw }) => {
      raw.evidence[0].sourceRevision = "d".repeat(40);
    },
    ({ raw }) => {
      raw.facts[0].occurredAt = "2026-10-02T00:00:00.000Z";
      raw.evidence[0].occurredAt = raw.facts[0].occurredAt;
    },
    ({ raw }) => {
      raw.facts[0].state = "qualified";
    },
  ]) {
    const fixture = reviewedLocaleFixture();
    change(fixture);
    assert.equal(fixture.run().receipt, undefined);
  }
  const { configured, run } = reviewedLocaleFixture();
  assert.equal(run({ localization: { ...configured.localization, locale: "de" } }).receipt, undefined);
  const equal = reviewedLocaleFixture();
  equal.raw.facts[0].occurredAt = new Date(decision.at).toISOString();
  equal.raw.evidence[0].occurredAt = equal.raw.facts[0].occurredAt;
  assert.equal(equal.run().receipt.targetFactId, "fr");
  assert.equal(equal.run().receipt.sourceRevision, "c".repeat(40));
});

test("locale audit authority requires current request identity/version and one unchanged audit snapshot", () => {
  for (const change of [
    ({ reviewed }) => {
      reviewed.requests.claim.version++;
    },
    ({ reviewed }) => {
      reviewed.requests.claim.scope = "different reviewed scope";
    },
    ({ reviewed }) => {
      reviewed.requests.claim.locator = "https://github.com/org/repo/pull/2";
    },
    ({ reviewed }) => {
      reviewed.audit = [];
    },
    ({ reviewed }) => {
      reviewed.audit.push(structuredClone(reviewed.audit[0]));
    },
    ({ reviewed }) => {
      reviewed.audit[0] = { ...reviewed.audit[0], localization: { ...reviewed.audit[0].localization, locale: "de" } };
    },
    ({ reviewed }) => {
      reviewed.requests.claim.history[0].receipt = "another-request";
      reviewed.audit = structuredClone(reviewed.requests.claim.history);
    },
  ]) {
    const fixture = reviewedLocaleFixture();
    change(fixture);
    if (fixture.reviewed.requests.claim.scope !== fixture.configured.scope)
      assert.equal(fixture.run().receipt, undefined);
    else assert.throws(() => fixture.run(), /recognition_decision_unverified/);
  }
  const fixture = reviewedLocaleFixture();
  const before = recognitionFingerprint(fixture.reviewed, [fixture.configured]);
  fixture.reviewed.audit = [];
  assert.notEqual(recognitionFingerprint(fixture.reviewed, [fixture.configured]), before);
  const original = reviewedLocaleFixture();
  const originalKey = recognitionFingerprint(original.reviewed, [original.configured]);
  assert.notEqual(
    recognitionFingerprint(original.reviewed, [{ ...original.configured, scope: "retargeted" }]),
    originalKey,
  );
});

function unboundLocaleReview({ mergedAt = "2026-09-30T00:00:00.000Z", locale = "fr" } = {}) {
  const raw = structuredClone(input);
  raw.facts = ["fr", "de"].map((language) => ({
    ...input.facts[0],
    id: language,
    metricId: "localization",
    occurredAt: mergedAt,
  }));
  raw.evidence = raw.facts.map((fact) => ({
    artifact: input.evidence[0].artifact,
    sourceRevision: "c".repeat(40),
    contribution: {
      contributionId: fact.id,
      metricIds: ["localization"],
      reasonCodes: [
        "documentation_path_policy:synthetic-locales-v1",
        `locale:${fact.id}`,
        "localization_category:documentation",
      ],
    },
  }));
  const submitted = state();
  submitted.requests.claim.scope = "repository:2:locale:fr:documentation";
  const configured = {
    ...binding,
    scope: submitted.requests.claim.scope,
    metricId: "localization",
    sourceMetricId: "localization",
    localization: { locale, category: "documentation", policyVersion: "synthetic-locales-v1" },
  };
  return materializeRecognition(
    raw,
    submitted,
    [configured],
    [{ policy: { metricId: "localization", version: "v1", dateBasis: "occurredAt" } }],
    (value, receipt) => ({ ...value, receipt }),
    "2026-10-18T00:00:00.000Z",
    publicDocumentationReasons,
  );
}

test("an earlier locale approval cannot qualify a later merged source revision", () => {
  assert.equal(unboundLocaleReview({ mergedAt: "2026-10-02T00:00:00.000Z" }).receipt, undefined);
});

test("a submitted French approval cannot be retargeted by changing only the current binding", () => {
  assert.equal(unboundLocaleReview({ locale: "de" }).receipt, undefined);
});
