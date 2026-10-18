import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyPhysicalDiff, createGithubEvidenceNormalizer, normalizeGithubObservation } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const before = "b".repeat(40),
  after = "c".repeat(40);
const at = "2026-10-07T10:00:00Z",
  observedAt = "2026-10-08T10:00:00Z";
const invalidProof = /Boolean diff completeness proof is required/;
const malformedProofs = () => ["false", "true", undefined, null, "", 0, 1, NaN, {}, [], new Boolean(false)];
const diff = (complete) => ({
  before,
  after,
  complete,
  files: [
    { path: "src/synthetic-completeness.ts", additions: 7, deletions: 2 },
    { path: "vendor/synthetic-exclusion.ts", additions: 1000, deletions: 500 },
  ],
});
const envelope = (complete) => ({
  repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
  proof: { verified: true, source: "github_webhook", revision: at, eventId: "synthetic-loc-proof", isSynthetic: true },
  family: "pull_request",
  action: "closed",
  occurredAt: at,
  observedAt,
  decisionCohort: { verified: true, asOf: observedAt, outcome: "merged", decisionAt: at },
  frozenCutoff: observedAt,
  payload: {
    repository: fixture.repository,
    pull_request: { ...structuredClone(fixture.pull_request), user: fixture.author, merged_by: fixture.merger },
    sender: fixture.merger,
  },
  integration: {
    before,
    after,
    canonicalChangeId: "synthetic-completeness-integration",
    defaultBranch: "main",
    targetBranch: "main",
    commitShas: [after],
    diff: diff(complete),
  },
});
const input = () => ({
  repository: { id: 2, slug: "synthetic-owner/repository" },
  family: "pull_requests",
  factKey: "a".repeat(64),
  observedAt,
  policyVersion: "synthetic-completeness/v1",
  fact: {
    subjectId: "10",
    sourceRevision: at,
    sourceUrl: fixture.pull_request.html_url,
    evidence: "observed_transition",
    actorId: String(fixture.author.id),
    occurredAt: at,
    state: "closed",
  },
});
const lineFacts = (value) => value.facts.filter((fact) => /^pr_lines_/.test(fact.metricId));
function enrichedNormalizer(value) {
  let enrichments = 0;
  const normalize = createGithubEvidenceNormalizer({
    client: {
      forRepository() {
        assert.fail("An admitted exact enrichment must not start a source read");
      },
    },
    source: "synthetic-completeness",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    enrich: async () => {
      enrichments++;
      return value;
    },
  });
  return { normalize, enrichments: () => enrichments };
}

test("physical completeness requires an explicit primitive boolean proof", () => {
  for (const complete of malformedProofs()) assert.throws(() => classifyPhysicalDiff(diff(complete)), invalidProof);
  const missing = diff(true);
  delete missing.complete;
  assert.throws(() => classifyPhysicalDiff(missing), invalidProof);
});

test("an incomplete physical diff retains raw evidence and withholds every delivered total", () => {
  const value = classifyPhysicalDiff(diff(false));
  assert.equal(value.complete, false);
  for (const field of ["additions", "deletions", "changed", "net", "filesChanged"]) assert.equal(value[field], null);
  assert.equal(value.rawAdditions, 1007);
  assert.equal(value.rawDeletions, 502);
  assert.deepEqual(value.reasons, ["incomplete_or_truncated_diff"]);
  assert.deepEqual(
    value.files.map(({ classification, eligible }) => [classification, eligible]),
    [
      ["source", true],
      ["vendor", false],
    ],
  );
});

test("complete physical evidence preserves separate units, exclusions and an evidenced zero", () => {
  const value = classifyPhysicalDiff(diff(true));
  assert.equal(value.complete, true);
  assert.deepEqual([value.additions, value.deletions, value.changed, value.net, value.filesChanged], [7, 2, 9, 5, 1]);
  assert.deepEqual([value.rawAdditions, value.rawDeletions], [1007, 502]);
  assert.deepEqual(value.reasons, []);
  const empty = classifyPhysicalDiff({ ...diff(true), files: [] });
  assert.deepEqual([empty.additions, empty.deletions, empty.changed, empty.net, empty.filesChanged], [0, 0, 0, 0, 0]);
});

test("classification binds the admitted completeness proof once before reading file evidence", () => {
  const value = diff(false);
  let reads = 0;
  Object.defineProperty(value, "complete", {
    get() {
      reads++;
      return reads === 1 ? false : true;
    },
  });
  const classified = classifyPhysicalDiff(value);
  assert.equal(reads, 1);
  assert.equal(classified.complete, false);
  assert.equal(classified.additions, null);
  assert.equal(classified.changed, null);
  assert.deepEqual(classified.reasons, ["incomplete_or_truncated_diff"]);
});

test("the real observation normalizer cannot award delivered LOC from malformed completeness", () => {
  for (const complete of malformedProofs())
    assert.throws(() => normalizeGithubObservation(envelope(complete)), invalidProof);
});

test("the authorized enrichment adapter rejects malformed completeness before returning credited facts", async () => {
  for (const complete of malformedProofs()) {
    const adapter = enrichedNormalizer(envelope(complete));
    await assert.rejects(adapter.normalize(input()), invalidProof);
    assert.equal(adapter.enrichments(), 1);
  }
});

test("authorized enrichment preserves incomplete unknowns and complete observed physical units", async () => {
  const incomplete = await enrichedNormalizer(envelope(false)).normalize(input());
  assert.equal(incomplete.isSynthetic, true);
  assert.deepEqual(lineFacts(incomplete), []);
  assert.equal(incomplete.facts.filter((fact) => fact.metricId === "files_changed").length, 0);
  assert.ok(incomplete.reasons.includes("incomplete_or_truncated_diff"));
  assert.equal(incomplete.physicalDiff.rawAdditions, 1007);
  const complete = await enrichedNormalizer(envelope(true)).normalize(input());
  assert.equal(complete.isSynthetic, true);
  assert.deepEqual(
    lineFacts(complete).map(({ metricId, state, quantity }) => ({ metricId, state, quantity })),
    [
      { metricId: "pr_lines_added", state: "observed", quantity: 7 },
      { metricId: "pr_lines_removed", state: "observed", quantity: 2 },
      { metricId: "pr_lines_changed", state: "observed", quantity: 9 },
    ],
  );
  assert.ok(lineFacts(complete).every((fact) => fact.actorId === "101" && fact.role === "author"));
  const files = complete.facts.filter((fact) => fact.metricId === "files_changed");
  assert.equal(files.length, 1);
  assert.equal(files[0].quantity, undefined);
  assert.deepEqual(complete.reasons, []);
});

test("completeness admission preserves the enrichment repository and exact revision fences", async () => {
  const unauthorized = enrichedNormalizer(envelope(true));
  const rejected = await unauthorized.normalize({ ...input(), repository: { ...input().repository, id: 999 } });
  assert.deepEqual(rejected.facts, []);
  assert.deepEqual(rejected.reasons, ["repository_not_authorized_for_normalization"]);
  assert.equal(unauthorized.enrichments(), 0);
  for (const changed of [
    { ...input(), repository: { ...input().repository, slug: "different-synthetic/repository" } },
    { ...input(), fact: { ...input().fact, sourceRevision: "different-synthetic-revision" } },
  ]) {
    const adapter = enrichedNormalizer(envelope(true));
    const value = await adapter.normalize(changed);
    assert.deepEqual(value.facts, []);
    assert.deepEqual(value.reasons, ["enrichment_scope_or_revision_mismatch"]);
    assert.equal(adapter.enrichments(), 1);
  }
});
