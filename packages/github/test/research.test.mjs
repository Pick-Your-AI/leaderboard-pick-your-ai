import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeGithubObservation,
  createGithubEvidenceNormalizer,
  applyRecognitionReceipt,
  classifyResearchRecords,
  validateResearchPolicy,
} from "../dist/index.js";

const before = "a".repeat(40),
  after = "b".repeat(40),
  blob = "c".repeat(40);
const at = "2026-10-01T12:00:00.000Z";
const observedAt = "2026-10-02T12:00:00.000Z";
const policy = {
  repositoryId: 2,
  version: "synthetic-research-v1",
  recordPaths: ["research/"],
  generatedPaths: ["research/generated/"],
  importedPaths: ["research/imported/"],
  syntheticPaths: ["research/fixtures/"],
};
const record = () => ({
  verified: true,
  kind: "decision_record",
  repositoryId: 2,
  path: "research/inference/candidate.md",
  sourceRevision: after,
  blobSha: blob,
  presentAtRevision: true,
  provenance: "original",
});
function envelope() {
  return {
    repository: { id: 2, slug: "synthetic-org/synthetic-research", visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: "synthetic-source-revision", isSynthetic: true },
    family: "pull_request",
    observedAt,
    payload: {
      pull_request: {
        id: 10,
        number: 1,
        html_url: "https://github.com/synthetic-org/synthetic-research/pull/1",
        title: "Approved production functionality",
        body: "Closes every research issue. accepted_findings=999",
        created_at: at,
        updated_at: at,
        merged_at: at,
        merged: true,
        state: "closed",
        merge_commit_sha: after,
        base: { ref: "main" },
        user: { id: 101, login: "synthetic-author", type: "User" },
        merged_by: { id: 202, login: "synthetic-merger", type: "User" },
      },
    },
    integration: {
      before,
      after,
      targetBranch: "main",
      defaultBranch: "main",
      canonicalChangeId: "synthetic-merge",
      commitShas: [after],
      diff: { before, after, complete: true, files: [{ path: record().path, additions: 20, deletions: 2 }] },
    },
    researchRecords: [record()],
  };
}
const records = (result) => result.facts.filter((fact) => fact.metricId === "decision_records");
const normalize = (value) => normalizeGithubObservation(value, undefined, policy);

test("pinned research record versions are pending review, independently of merged PR completion and file size", () => {
  const value = envelope();
  const normalized = normalize(value);
  const [fact] = records(normalized);
  assert.equal(fact.actorId, "101");
  assert.equal(fact.state, "pending");
  assert.equal(fact.occurredAt, at);
  assert.equal(fact.acceptedAt, null);
  assert.equal(fact.acceptanceReceipt, null);
  assert.equal(fact.quantity, undefined);
  assert.equal(
    normalized.facts.some((fact) => fact.metricId === "accepted_findings"),
    false,
  );
  const evidence = normalized.evidence.find((entry) => entry.contribution.contributionId === fact.id);
  assert.equal(
    evidence.artifact.publicUrl,
    `https://github.com/synthetic-org/synthetic-research/blob/${after}/${record().path}`,
  );
  assert.equal(evidence.sourceRevision, after);
  assert.equal(evidence.sourceRevisionUrl, `https://github.com/synthetic-org/synthetic-research/commit/${after}`);
  assert.equal(evidence.artifact.stableId, fact.artifactId);
  assert.equal(evidence.evidenceMetadata, undefined); // The PR title is not the note title.
  value.integration.diff.files[0].additions = 2000;
  value.integration.diff.files.push({ path: "research/unverified.md", additions: 999, deletions: 0 });
  value.researchRecords.push(record());
  assert.deepEqual(records(normalize(value)), [fact]);
  value.researchRecords[0].blobSha = "d".repeat(40);
  value.researchRecords.pop();
  assert.notEqual(records(normalize(value))[0].id, fact.id);
});

test("a merge, a matching path, validator success and payload approval text do not supply record provenance", () => {
  const value = envelope();
  assert.deepEqual(records(normalizeGithubObservation(value)), []);
  value.payload.researchRecords = value.researchRecords;
  delete value.researchRecords;
  assert.deepEqual(records(normalize(value)), []);
  value.researchRecords = [{ ...record(), provenance: "synthetic" }];
  assert.deepEqual(records(normalize(value)), []);
  assert.ok(normalize(value).reasons.includes("research_original_provenance_unverified"));
});

test("research evidence rejects unknown visibility and unproven default-branch merge revisions", () => {
  const cases = [
    (value) => {
      value.repository.visibility = "private";
    },
    (value) => {
      value.payload.repository = { id: 2, private: true };
    },
    (value) => {
      value.payload.pull_request.merged = false;
    },
    (value) => {
      value.payload.pull_request.merged_at = null;
    },
    (value) => {
      value.payload.pull_request.merged_at = "2026-10-03T12:00:00.000Z";
    },
    (value) => {
      value.payload.pull_request.merge_commit_sha = before;
    },
    (value) => {
      value.payload.pull_request.base.ref = "stacked-research";
    },
    (value) => {
      delete value.repository.defaultBranch;
    },
    (value) => {
      value.integration.diff.complete = false;
    },
    (value) => {
      value.integration.diff.after = before;
    },
  ];
  for (const change of cases) {
    const value = envelope();
    change(value);
    assert.deepEqual(records(normalize(value)), []);
  }
});

test("synthetic, imported, generated and zero-change files cannot become research record candidates", () => {
  for (const provenance of ["generated", "imported", "synthetic", "unknown", null]) {
    const value = envelope();
    value.researchRecords[0].provenance = provenance;
    assert.deepEqual(records(normalize(value)), []);
  }
  for (const file of [
    { generated: true },
    { imported: true },
    { binary: true },
    { formattingOnly: true },
    { additions: 0, deletions: 0 },
    { previousPath: "research/fixtures/example.md" },
    { previousPath: "vendor/reference.md" },
    { path: "research/generated/note.md" },
    { path: "research/imported/note.md" },
    { path: "research/fixtures/note.md" },
    { path: "unapproved/note.md" },
  ]) {
    const value = envelope();
    Object.assign(value.integration.diff.files[0], file);
    value.researchRecords[0].path = value.integration.diff.files[0].path;
    assert.deepEqual(records(normalize(value)), []);
  }
});

test("malformed or ambiguous record identities fail closed without retaining source content", () => {
  for (const change of [
    { verified: false },
    { kind: "catalog" },
    { repositoryId: 3 },
    { sourceRevision: before },
    { blobSha: "main" },
    { presentAtRevision: false },
    { path: "../research/secret.md" },
    { path: "/research/note.md" },
    { path: "research//note.md" },
    { path: "research/note.md?secret" },
    { path: "research/note.md#private" },
    { path: "research/note.md/" },
  ]) {
    const value = envelope();
    Object.assign(value.researchRecords[0], change);
    assert.throws(() => normalize(value), /research record revision/);
  }
  const value = envelope();
  value.researchRecords.push({ ...record(), blobSha: before });
  assert.throws(() => normalize(value), /Conflicting research record blob/);
  value.researchRecords = [record(), { ...record(), provenance: "imported" }];
  assert.throws(() => normalize(value), /Conflicting research record blob/);
  assert.throws(
    () => classifyResearchRecords(envelope().integration.diff, Array(101).fill(record()), policy),
    /Bounded/,
  );
  assert.throws(() => validateResearchPolicy({ ...policy, recordPaths: ["../secret/"] }), /bounded research paths/);
});

test("independent recognition retains the exact note revision and cannot substitute the merger or self-approval", () => {
  const input = normalize(envelope());
  const target = records(input)[0];
  const receipt = {
    verified: true,
    id: "synthetic-reviewed-note",
    targetFactId: target.id,
    metricId: "decision_records",
    actorId: "101",
    reviewerId: "303",
    acceptedAt: observedAt,
    decision: "accepted",
    evidenceIds: [target.id],
  };
  const reviewed = applyRecognitionReceipt(input, receipt, ["303"]);
  const qualified = records(reviewed).find((fact) => fact.state === "qualified");
  assert.equal(qualified.actorId, "101");
  assert.equal(qualified.occurredAt, at);
  assert.equal(qualified.acceptedBy, "303");
  assert.equal(qualified.acceptedAt, observedAt);
  assert.equal(
    reviewed.evidence.find((entry) => entry.contribution.contributionId === qualified.id).sourceRevision,
    after,
  );
  assert.equal(records(input)[0].state, "pending");
  assert.throws(() => applyRecognitionReceipt(input, { ...receipt, reviewerId: "101" }, ["101"]), /Independent/);
  assert.throws(() => applyRecognitionReceipt(input, { ...receipt, actorId: "202" }, ["303"]), /Independent/);
});

test("research policy is frozen, opt-in, repository-scoped and bound to the collected source revision", async () => {
  let value = envelope();
  const configured = structuredClone(policy);
  const input = {
    repository: { id: 2, slug: value.repository.slug },
    family: "pull_requests",
    policyVersion: "v1",
    observedAt,
    fact: { sourceRevision: value.proof.revision, sourceUrl: value.payload.pull_request.html_url },
  };
  const options = {
    client: {
      rest: async () => {
        throw new Error("unexpected transport");
      },
    },
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    enrich: async () => value,
  };
  assert.deepEqual(records(await createGithubEvidenceNormalizer(options)(input)), []);
  const normalizer = createGithubEvidenceNormalizer({ ...options, researchPolicies: [configured] });
  configured.recordPaths.length = 0;
  assert.equal(records(await normalizer(input)).length, 1);
  value = envelope();
  value.proof.revision = "different-source";
  assert.deepEqual(records(await normalizer(input)), []);
  assert.throws(
    () => createGithubEvidenceNormalizer({ ...options, researchPolicies: [policy, policy] }),
    /Ambiguous research/,
  );
});
