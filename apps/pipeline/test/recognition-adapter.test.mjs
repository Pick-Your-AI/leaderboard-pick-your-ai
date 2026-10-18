import assert from "node:assert/strict";
import test from "node:test";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { publicDocumentationReasons } from "../../../packages/contracts/dist/index.js";

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

test("locale approval requires exact trusted language/category/policy binding and preserves only public labels", () => {
  const raw = structuredClone(input);
  raw.facts = ["fr", "de"].map((locale) => ({ ...input.facts[0], id: locale, metricId: "localization" }));
  raw.evidence = raw.facts.map((fact) => ({
    artifact: input.evidence[0].artifact,
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
  const run = (patch = {}) =>
    materializeRecognition(
      raw,
      state(),
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
