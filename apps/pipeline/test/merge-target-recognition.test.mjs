// Synthetic source/receipts, actual normalizer and saved-proof binding.
// No socket, database, live source, host approval or publication is exercised.
import assert from "node:assert/strict";
import test from "node:test";
import { applyRecognitionReceipt, createGithubEvidenceNormalizer } from "@pick-your-ai/github";
import { assertMergeTargetFacts } from "../src/pull-request-merge-target.mjs";
import {
  mergeTargetFixture,
  observedAt,
  slug,
} from "../../../packages/github/test/pull-request-merge-target-fixture.mjs";

function fixture() {
  const source = mergeTargetFixture();
  source.options.authorizedReviewerIds = ["202"];
  source.options.enrich = async () => ({
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: observedAt },
    family: "pull_request",
    observedAt,
    payload: source.payload,
    verifiedCoauthors: [
      {
        actor: { id: 103, node_id: "U_fixture_coauthor", type: "User", login: "fixture-coauthor" },
        verificationReceipt: "synthetic-reviewed-coauthor-receipt",
      },
    ],
  });
  return source;
}

function receipt(metricId, target, decision = "accepted") {
  assert.ok(target, "the receipt must select an actual normalized source fact");
  return {
    id: "synthetic-merge-target-" + metricId + "-" + decision,
    verified: true,
    metricId,
    actorId: target.actorId,
    reviewerId: "202",
    acceptedAt: observedAt,
    decision,
    targetFactId: target.id,
    evidenceIds: [target.id],
  };
}

function assertRawFactsPreserved(result, original) {
  assert.deepEqual(result.facts.slice(0, original.facts.length), original.facts);
  assert.deepEqual(result.evidence.slice(0, original.evidence.length), original.evidence);
  assert.deepEqual(result.actors, original.actors);
  for (const metric of ["pr_merged", "maintainer_merges", "pr_coauthored"]) {
    const raw = result.facts.find((fact) => fact.metricId === metric && fact.state === "observed");
    assert.equal(raw.mergeTarget.branch, "stack/topic", metric);
  }
}

for (const metricId of ["maintenance", "automation"]) {
  test(
    "native merge-target acceptance preserves valid " + metricId + " recognition without borrowing branch scope",
    async () => {
      const source = fixture();
      const input = structuredClone(source.input);
      let beforeAcceptance;
      source.options.acceptance = async (_input, normalized) => {
        beforeAcceptance = structuredClone(normalized);
        return [
          receipt(
            metricId,
            normalized.facts.find((fact) => fact.metricId === "pr_merged"),
          ),
        ];
      };
      const result = await createGithubEvidenceNormalizer(source.options)(source.input);
      assert.ok(beforeAcceptance);
      // This is the actual validator called before the runtime retains custom
      // normalizer output. A valid category receipt must not poison the source.
      assert.doesNotThrow(() => assertMergeTargetFacts(result.facts, result.pullRequestMergeTargets));
      assertRawFactsPreserved(result, beforeAcceptance);
      assert.deepEqual(result.pullRequestMergeTargets, beforeAcceptance.pullRequestMergeTargets);
      assert.deepEqual(source.input, input);
      const promoted = result.facts.filter((fact) => fact.metricId === metricId);
      assert.equal(promoted.length, 1);
      assert.equal(promoted[0].state, "qualified");
      assert.equal(promoted[0].acceptedAt, observedAt);
      assert.equal(promoted[0].acceptedBy, "202");
      assert.equal(Object.hasOwn(promoted[0], "mergeTarget"), false);
      assert.equal(source.state.requests.length, 1);
    },
  );
}

test("unfiltered recognition helper drops only the unsupported derived branch projection", async () => {
  const source = fixture();
  const normalized = await createGithubEvidenceNormalizer(source.options)(source.input);
  const { pullRequestMergeTargets: captures, ...batch } = normalized;
  const original = structuredClone(batch);
  const originalCaptures = structuredClone(captures);
  // The unfiltered runtime batch calls this same helper after collecting its
  // original source facts, with captures retained separately from the batch.
  for (const [metricId, sourceMetric] of [
    ["maintenance", "pr_merged"],
    ["automation", "pr_coauthored"],
  ]) {
    for (const decision of ["accepted", "rejected"]) {
      const target = batch.facts.find((fact) => fact.metricId === sourceMetric);
      const selected = receipt(metricId, target, decision);
      const result = applyRecognitionReceipt(batch, selected, ["202"]);
      assert.doesNotThrow(() => assertMergeTargetFacts(result.facts, captures));
      assertRawFactsPreserved(result, original);
      assert.deepEqual(batch, original, "recognition must not alter its input batch");
      assert.deepEqual(captures, originalCaptures, "the native source proof remains unchanged");
      const promoted = result.facts.at(-1);
      assert.equal(result.facts.length, original.facts.length + 1);
      const {
        mergeTarget: _sourceProjection,
        id: _sourceId,
        canonicalKey: _sourceKey,
        state: _sourceState,
        acceptedAt: _sourceAcceptedAt,
        acceptedBy: _sourceAcceptedBy,
        acceptanceReceipt: _sourceReceipt,
        ...sourceFields
      } = target;
      const { id, canonicalKey, state, acceptedAt, acceptedBy, acceptanceReceipt, ...preserved } = promoted;
      assert.deepEqual(preserved, { ...sourceFields, metricId });
      assert.equal(state, decision === "accepted" ? "qualified" : "excluded");
      assert.equal(acceptedAt, observedAt);
      assert.equal(acceptedBy, "202");
      assert.equal(acceptanceReceipt, selected.id);
      assert.equal(Object.hasOwn(promoted, "mergeTarget"), false);
      assert.notEqual(id, target.id);
      assert.notEqual(canonicalKey, target.canonicalKey);
    }
  }
});

test("recognition within each supported merge metric retains its exact private projection", async () => {
  const source = fixture();
  const original = await createGithubEvidenceNormalizer(source.options)(source.input);
  const saved = structuredClone(original);
  for (const metricId of ["pr_merged", "maintainer_merges", "pr_coauthored"]) {
    const target = original.facts.find((fact) => fact.metricId === metricId);
    const result = applyRecognitionReceipt(original, receipt(metricId, target), ["202"]);
    assert.doesNotThrow(() => assertMergeTargetFacts(result.facts, result.pullRequestMergeTargets));
    assertRawFactsPreserved(result, saved);
    const promoted = result.facts.at(-1);
    assert.equal(promoted.metricId, metricId);
    assert.equal(promoted.state, "qualified");
    assert.deepEqual(promoted.mergeTarget, target.mergeTarget);
    assert.deepEqual(original, saved);
  }
});

test("legacy recognition without the merge-target profile remains free of branch fields and requests", async () => {
  const source = fixture();
  delete source.options.pullRequestMergeTargetRepositoryIds;
  const original = await createGithubEvidenceNormalizer(source.options)(source.input);
  const saved = structuredClone(original);
  const target = original.facts.find((fact) => fact.metricId === "pr_merged");
  const result = applyRecognitionReceipt(original, receipt("maintenance", target), ["202"]);
  assert.equal(result.facts.at(-1).metricId, "maintenance");
  assert.equal(result.facts.at(-1).state, "qualified");
  assert.equal(result.pullRequestMergeTargets, undefined);
  assert.ok(result.facts.every((fact) => !Object.hasOwn(fact, "mergeTarget")));
  assert.deepEqual(original, saved);
  assert.equal(source.state.requests.length, 0);
});
