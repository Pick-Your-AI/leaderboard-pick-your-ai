import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRecognitionReceipt,
  classifyDocumentation,
  createGithubEvidenceNormalizer,
  normalizeGithubObservation,
  validateDocumentationPolicy,
} from "../dist/index.js";

const before = "b".repeat(40),
  after = "c".repeat(40);
const mergedAt = "2026-10-07T10:00:00.000Z",
  observedAt = "2026-10-08T10:00:00.000Z";
const policy = {
  repositoryId: 2,
  version: "synthetic-locales-v1",
  documentationPaths: ["docs/"],
  researchPaths: ["docs/research/"],
  generatedPaths: ["locale-generated/"],
  importedPaths: ["locale-imported/"],
  localizationPaths: [
    { locale: "fr", category: "documentation", paths: ["docs/fr/", "guides/fr/"] },
    { locale: "fr", category: "interface", paths: ["locales/fr/"] },
    { locale: "de-DE", category: "documentation", paths: ["docs/de-DE/"] },
  ],
};
const diff = (files) => ({ before, after, complete: true, files });
const file = (path, extra = {}) => ({ path, additions: 1, deletions: 0, ...extra });
const envelope = (files) => ({
  repository: { id: 2, slug: "synthetic-owner/locales", visibility: "public", defaultBranch: "main" },
  proof: { verified: true, source: "github_rest", revision: after, isSynthetic: true },
  family: "pull_request",
  observedAt,
  payload: {
    pull_request: {
      number: 10,
      node_id: "PR_SYNTHETIC_LOCALES",
      html_url: "https://github.com/synthetic-owner/locales/pull/10",
      title: "Synthetic locale update",
      user: { id: 101, node_id: "U_SYNTHETIC_AUTHOR", type: "User" },
      merged_by: { id: 202, node_id: "U_SYNTHETIC_MERGER", type: "User" },
      merged: true,
      merged_at: mergedAt,
      merge_commit_sha: after,
      base: { ref: "main" },
    },
  },
  integration: {
    before,
    after,
    targetBranch: "main",
    defaultBranch: "main",
    canonicalChangeId: "synthetic-locale-merge",
    commitShas: [after],
    diff: diff(files),
  },
});
const localizationFacts = (result) => result.facts.filter((fact) => fact.metricId === "localization");

test("locale/category participation conserves one unit independent of path, string and line counts", () => {
  const input = envelope([
    file("docs/fr/one.md"),
    file("docs/fr/two.md", { additions: 10000 }),
    file("guides/fr/three.md"),
    file("locales/fr/app.json"),
    file("docs/de-DE/one.md", { additions: 0, deletions: 4 }),
    file("docs/es/unconfigured.md"),
  ]);
  const result = normalizeGithubObservation(input, policy);
  const facts = localizationFacts(result);
  assert.equal(facts.length, 3);
  assert.equal(new Set(facts.map((fact) => fact.canonicalKey)).size, 3);
  assert.ok(
    facts.every(
      (fact) =>
        fact.actorId === "101" &&
        fact.role === "author" &&
        fact.state === "observed" &&
        fact.acceptedAt === null &&
        fact.quantity === undefined,
    ),
  );
  assert.equal(result.facts.filter((fact) => fact.metricId === "documentation").length, 1);
  const proofs = result.evidence.filter((entry) => entry.contribution.metricIds.includes("localization"));
  assert.ok(proofs.every((proof) => proof.sourceRevision === after && proof.sourceRevisionUrl.endsWith(after)));
  assert.ok(
    proofs.every(
      (proof) =>
        proof.evidenceMetadata.sourceAction === "pull_request_merged" && proof.evidenceMetadata.acceptedAt === null,
    ),
  );
  assert.deepEqual(
    proofs
      .map((proof) =>
        proof.contribution.reasonCodes.filter(
          (reason) => reason.startsWith("locale:") || reason.startsWith("localization_category:"),
        ),
      )
      .sort(),
    [
      ["locale:de-DE", "localization_category:documentation"],
      ["locale:fr", "localization_category:documentation"],
      ["locale:fr", "localization_category:interface"],
    ],
  );
  input.integration.diff.files.reverse();
  input.integration.diff.files[1].additions = 80000;
  assert.deepEqual(
    localizationFacts(normalizeGithubObservation(input, policy)).map((fact) => fact.id),
    facts.map((fact) => fact.id),
  );
});

test("locale classification requires explicit policy and refuses excluded, imported, generated or no-op changes", () => {
  const fixtures = [
    file("docs/fr/generated.md", { generated: true }),
    file("docs/fr/imported.md", { imported: true }),
    file("docs/fr/binary.md", { binary: true }),
    file("docs/fr/format.md", { formattingOnly: true }),
    file("docs/fr/renamed.md", { additions: 0, deletions: 0 }),
    file("docs/fr/generated/file.md"),
    file("docs/fr/copied.md", { previousPath: "locale-generated/original.md" }),
    file("docs/fr/copied.md", { previousPath: "locale-imported/original.md" }),
    file("docs/fr/copied.md", { previousPath: "docs/research/original.md" }),
    file("docs/fr/copied.md", { previousPath: "vendor/original.md" }),
    file("docs/fr/copied.md", { previousPath: "package-lock.json" }),
    file("docs/spanish/filename.fr.md"),
  ];
  for (const changed of fixtures)
    assert.deepEqual(localizationFacts(normalizeGithubObservation(envelope([changed]), policy)), [], changed.path);
  const input = envelope([file("docs/fr/one.md")]);
  assert.deepEqual(localizationFacts(normalizeGithubObservation(input)), []);
  assert.deepEqual(
    localizationFacts(normalizeGithubObservation(input, { ...policy, localizationPaths: undefined })),
    [],
  );
  assert.deepEqual(classifyDocumentation({ ...input.integration.diff, complete: false }, policy).localizations, []);
});

test("locale units require the exact public default-branch merge and matching complete diff", () => {
  for (const mutate of [
    (input) => {
      input.repository.visibility = "private";
    },
    (input) => {
      input.payload.pull_request.merged = false;
    },
    (input) => {
      input.payload.pull_request.merged_at = null;
    },
    (input) => {
      input.payload.pull_request.merge_commit_sha = before;
    },
    (input) => {
      input.integration.diff.complete = false;
    },
    (input) => {
      input.integration.diff.after = before;
    },
    (input) => {
      input.integration.targetBranch = "feature";
    },
    (input) => {
      delete input.repository.defaultBranch;
    },
    (input) => {
      delete input.payload.pull_request.base;
    },
  ]) {
    const input = envelope([file("docs/fr/one.md")]);
    mutate(input);
    assert.deepEqual(localizationFacts(normalizeGithubObservation(input, policy)), []);
  }
});

test("documentation and locale units require a merge observed at or after its source instant", () => {
  const input = envelope([file("docs/fr/one.md")]);
  input.observedAt = "2026-10-07T10:00:00.000Z";
  input.payload.pull_request.merged_at = "2026-10-07T10:00:00.001Z";
  const future = normalizeGithubObservation(input, policy);
  assert.deepEqual(
    future.facts.filter((fact) => ["documentation", "localization"].includes(fact.metricId)),
    [],
  );
  assert.deepEqual(
    future.evidence.filter((entry) =>
      entry.contribution.metricIds.some((metric) => ["documentation", "localization"].includes(metric)),
    ),
    [],
  );
  assert.ok(future.reasons.includes("documentation_merged_revision_unverified"));
  for (const sourceTime of ["2026-10-07T10:00:00.000Z", "2026-10-07T10:00:00Z", "2026-10-07T09:59:59.999Z"]) {
    input.payload.pull_request.merged_at = sourceTime;
    const current = normalizeGithubObservation(input, policy);
    assert.equal(current.facts.filter((fact) => fact.metricId === "documentation").length, 1, sourceTime);
    assert.equal(localizationFacts(current).length, 1, sourceTime);
    assert.ok(localizationFacts(current).every((fact) => fact.occurredAt === new Date(sourceTime).toISOString()));
  }
});

test("ambiguous locale/category mappings and malformed or noncanonical language tags fail closed", () => {
  for (const localizationPaths of [
    [{ locale: "FR", category: "documentation", paths: ["docs/fr/"] }],
    [{ locale: "en_US", category: "documentation", paths: ["docs/en/"] }],
    [{ locale: "en-u-nu-latn", category: "documentation", paths: ["docs/en/"] }],
    [{ locale: "und", category: "documentation", paths: ["docs/unknown/"] }],
    [{ locale: "en", category: "../category", paths: ["docs/en/"] }],
    [{ locale: "en", category: "documentation", paths: ["../docs/"] }],
    [{ locale: "en", category: "documentation", paths: [] }],
    [policy.localizationPaths[0], { ...policy.localizationPaths[0], paths: ["other/"] }],
    [policy.localizationPaths[0], { locale: "de", category: "documentation", paths: ["docs/fr/a.md"] }],
    [policy.localizationPaths[0], { locale: "de", category: "documentation", paths: ["docs/"] }],
    Array.from({ length: 33 }, (_, i) => ({ locale: "en", category: `category_${i}`, paths: [`docs/${i}/`] })),
    Array.from({ length: 3 }, (_, i) => ({
      locale: "en",
      category: `category_${i}`,
      paths: Array.from({ length: 100 }, (_, j) => `docs/${i}/${j}/`),
    })),
  ])
    assert.throws(
      () => validateDocumentationPolicy({ ...policy, localizationPaths }),
      JSON.stringify(localizationPaths),
    );
  assert.doesNotThrow(() => validateDocumentationPolicy(policy));
  assert.doesNotThrow(() =>
    validateDocumentationPolicy({
      ...policy,
      localizationPaths: [{ locale: "zh-Hant-TW", category: "documentation", paths: ["docs/zh/"] }],
    }),
  );
});

test("independent acceptance retains locale proof and never accepts the other locale or the merger", () => {
  const raw = normalizeGithubObservation(envelope([file("docs/fr/a.md"), file("docs/de-DE/a.md")]), policy);
  const target = localizationFacts(raw).find((fact) => fact.rawState.includes(":fr:"));
  const receipt = {
    id: "synthetic-locale-review",
    verified: true,
    metricId: "localization",
    actorId: "101",
    reviewerId: "303",
    acceptedAt: observedAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: [target.id],
  };
  assert.throws(() => applyRecognitionReceipt(raw, { ...receipt, reviewerId: "101" }, ["101"]));
  assert.throws(() => applyRecognitionReceipt(raw, { ...receipt, actorId: "202" }, ["303"]));
  const accepted = applyRecognitionReceipt(raw, receipt, ["303"]);
  const qualified = localizationFacts(accepted).filter((fact) => fact.state === "qualified");
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].actorId, "101");
  const proof = accepted.evidence.find((entry) => entry.contribution.contributionId === qualified[0].id);
  assert.deepEqual(proof.contribution.reasonCodes, [
    "independent_recognition_receipt",
    "documentation_path_policy:synthetic-locales-v1",
    "locale:fr",
    "localization_category:documentation",
  ]);
  assert.equal(proof.sourceRevision, after);
  assert.equal(proof.evidenceMetadata.acceptedAt, observedAt);
  assert.equal(localizationFacts(raw).filter((fact) => fact.state === "qualified").length, 0);
});

test("trusted pipeline enrichment freezes locale policy and cannot apply it to another collected revision", async () => {
  const input = {
    repository: { id: 2, slug: "synthetic-owner/locales" },
    family: "pull_requests",
    factKey: "synthetic-locale-fact",
    fact: {
      subjectId: "PR_SYNTHETIC_LOCALES",
      sourceUrl: "https://github.com/synthetic-owner/locales/pull/10",
      sourceRevision: after,
    },
    observedAt,
    policyVersion: "synthetic-source-v1",
  };
  const value = envelope([file("docs/fr/a.md")]);
  const config = structuredClone(policy);
  const normalizer = createGithubEvidenceNormalizer({
    client: {},
    source: "synthetic-source",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    enrich: async () => value,
    documentationPolicies: [config],
  });
  config.localizationPaths[0].locale = "de";
  assert.match(localizationFacts(await normalizer(input))[0].rawState, /:fr:/);
  value.proof.revision = before;
  assert.deepEqual(localizationFacts(await normalizer(input)), []);
});

test("a bulk recognition changeset preserves locale units and cannot change the same locale identity", () => {
  const raw = normalizeGithubObservation(envelope([file("docs/fr/a.md"), file("docs/de-DE/a.md")]), policy);
  const targets = localizationFacts(raw);
  const receipt = (target) => ({
    id: `synthetic-review-${target.id}`,
    verified: true,
    metricId: "localization",
    actorId: "101",
    reviewerId: "303",
    acceptedAt: observedAt,
    decision: "accepted",
    targetFactId: target.id,
    evidenceIds: [target.id],
    changesetId: "synthetic-same-bulk-review",
  });
  let accepted = raw;
  for (const target of targets) accepted = applyRecognitionReceipt(accepted, receipt(target), ["303"]);
  const qualified = localizationFacts(accepted).filter((fact) => fact.state === "qualified");
  assert.equal(new Set(qualified.map((fact) => fact.id)).size, 2);
  assert.equal(new Set(qualified.map((fact) => fact.canonicalKey)).size, 2);
  const differentChangeset = applyRecognitionReceipt(
    raw,
    { ...receipt(targets[0]), changesetId: "synthetic-other-bulk-review" },
    ["303"],
  );
  assert.equal(localizationFacts(differentChangeset).find((fact) => fact.state === "qualified").id, qualified[0].id);
  assert.throws(
    () => applyRecognitionReceipt(accepted, { ...receipt(targets[0]), targetFactId: qualified[0].id }, ["303"]),
    /original observed source fact/,
  );
});
