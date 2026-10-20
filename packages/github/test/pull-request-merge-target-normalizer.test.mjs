import assert from "node:assert/strict";
import test from "node:test";
import { createGithubEvidenceNormalizer, verifyGithubPullRequestMergeTargetCapture } from "../dist/index.js";
import { mergeTargetFixture, mergedAt, observedAt, slug } from "./pull-request-merge-target-fixture.mjs";

function envelope(s) {
  return {
    repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
    proof: { verified: true, source: "github_rest", revision: observedAt },
    family: "pull_request",
    observedAt,
    payload: s.payload,
  };
}

function withoutMergeTarget(output) {
  const { pullRequestMergeTargets: _captures, ...rest } = output;
  return {
    ...rest,
    facts: rest.facts.map(({ mergeTarget: _projection, ...fact }) => fact),
  };
}

test("merge-target normalizer binds author and merger to the native event without changing legacy facts", async () => {
  const legacy = mergeTargetFixture();
  delete legacy.options.pullRequestMergeTargetRepositoryIds;
  const baseline = await createGithubEvidenceNormalizer(legacy.options)(legacy.input);
  assert.equal(baseline.pullRequestMergeTargets, undefined);
  assert.equal(legacy.state.requests.length, 0);

  const s = mergeTargetFixture();
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.deepEqual(withoutMergeTarget(output), baseline);
  assert.equal(output.isSynthetic, true);
  assert.equal(output.pullRequestMergeTargets.length, 1);
  const capture = output.pullRequestMergeTargets[0];
  assert.deepEqual(await verifyGithubPullRequestMergeTargetCapture(capture), capture);
  const selected = output.facts.filter((fact) => fact.mergeTarget);
  assert.deepEqual(
    selected.map((fact) => [fact.metricId, fact.role]),
    [
      ["pr_merged", "author"],
      ["maintainer_merges", "merger"],
    ],
  );
  for (const fact of selected) {
    assert.equal(fact.mergeTarget.branch, "stack/topic");
    assert.equal(fact.mergeTarget.pullRequestId, fact.artifactId);
    assert.equal(fact.mergeTarget.repositoryId, fact.repoId);
    assert.equal(fact.mergeTarget.mergedAt, fact.occurredAt);
    assert.equal(fact.mergeTarget.proofHash, capture.proofHash);
  }
  assert.equal(selected[0].rawState, "target:main", "legacy snapshot context is preserved but is not the branch proof");
  assert.equal(output.facts.find((fact) => fact.metricId === "pr_opened").mergeTarget, undefined);
});

test("merge-target normalizer records actual completion time without rewriting source observation", async () => {
  const s = mergeTargetFixture();
  const times = ["2026-10-11T10:00:00.000Z", "2026-10-11T10:00:03.000Z"];
  s.options.now = () => times.shift();
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  const capture = output.pullRequestMergeTargets[0];
  assert.equal(capture.observedAt, "2026-10-11T10:00:03.000Z");
  assert.equal(capture.sourceRevision, observedAt);
  assert.ok(output.facts.every((fact) => fact.observedAt === observedAt));
  assert.deepEqual(await verifyGithubPullRequestMergeTargetCapture(capture), capture);
  assert.equal(times.length, 0);
});

test("merge-target normalizer retains unknown proof while preserving unfiltered merge activity", async () => {
  const s = mergeTargetFixture();
  s.state.pages.get(null).nodes = [];
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.equal(output.pullRequestMergeTargets[0].status, "unknown");
  assert.equal(output.pullRequestMergeTargets[0].reason, "merge_event_missing");
  assert.ok(output.facts.some((fact) => fact.metricId === "pr_merged" && fact.state === "observed"));
  assert.ok(output.facts.every((fact) => fact.mergeTarget === undefined));
});

test("merge-target normalizer verifies coauthor participation separately and never projects ratio or readiness", async () => {
  const s = mergeTargetFixture();
  s.options.enrich = async () => ({
    ...envelope(s),
    verifiedCoauthors: [
      {
        actor: { id: 103, node_id: "U_fixture_coauthor", type: "User", login: "fixture-coauthor" },
        verificationReceipt: "synthetic-reviewed-coauthor-receipt",
      },
    ],
    reviewCohort: { verified: true, firstReadyAt: s.payload.created_at, firstSubmittedReviewAt: null },
    decisionCohort: { verified: true, asOf: observedAt, outcome: "merged", decisionAt: mergedAt },
    frozenCutoff: observedAt,
  });
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  const coauthor = output.facts.find((fact) => fact.metricId === "pr_coauthored");
  assert.equal(coauthor.role, "coauthor");
  assert.equal(coauthor.actorId, "103");
  assert.equal(coauthor.mergeTarget.branch, "stack/topic");
  for (const metricId of ["pr_opened", "pr_ready", "pr_accepted_rate"]) {
    const fact = output.facts.find((candidate) => candidate.metricId === metricId);
    assert.ok(fact, metricId);
    assert.equal(fact.mergeTarget, undefined, metricId);
  }
  assert.deepEqual(s.state.calls, ["/graphql"]);
});

test("merge-target normalizer does not create a branch proof for pending coauthors", async () => {
  const s = mergeTargetFixture();
  s.payload.merged = false;
  s.payload.merged_at = null;
  s.payload.state = "open";
  s.options.enrich = async () => ({
    ...envelope(s),
    verifiedCoauthors: [
      {
        actor: { id: 103, node_id: "U_fixture_coauthor", type: "User", login: "fixture-coauthor" },
        verificationReceipt: "synthetic-reviewed-coauthor-receipt",
      },
    ],
  });
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  const coauthor = output.facts.find((fact) => fact.metricId === "pr_coauthored");
  assert.equal(coauthor.state, "pending");
  assert.equal(coauthor.mergeTarget, undefined);
  assert.deepEqual(output.pullRequestMergeTargets, []);
  assert.equal(s.state.requests.length, 0);
});

test("merge-target normalizer snapshots source input and repository selection before yielding", async () => {
  const s = mergeTargetFixture();
  const normalize = createGithubEvidenceNormalizer(s.options);
  s.options.pullRequestMergeTargetRepositoryIds[0] = 3;
  s.state.onRead = async () => {
    s.input.repository.id = 3;
    s.input.repository.slug = "other/repository";
    s.input.fact.sourceRevision = "unselected-revision";
    s.input.fact.subjectId = "PR_other";
  };
  const output = await normalize(s.input);
  assert.deepEqual(output.pullRequestMergeTargets[0].repository, { id: 2, slug });
  assert.equal(output.pullRequestMergeTargets[0].sourceRevision, observedAt);
  assert.equal(output.pullRequestMergeTargets[0].pullRequest.id, "PR_fixture_10");
});

test("merge-target normalizer prevents revision and acceptance callbacks from rewriting the proof input", async () => {
  const s = mergeTargetFixture();
  s.options.verifyRevision = async (input, payload) => {
    input.fact.sourceRevision = "rewritten-revision";
    payload.node_id = "PR_other";
    payload.merge_commit_sha = "c".repeat(40);
    return true;
  };
  s.options.acceptance = async (input, normalized) => {
    input.fact.subjectId = "PR_other";
    normalized.pullRequestMergeTargets[0].event.mergeRefName = "callback-branch";
    normalized.facts.find((fact) => fact.mergeTarget).mergeTarget.branch = "callback-branch";
    return [];
  };
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.equal(output.pullRequestMergeTargets[0].sourceRevision, observedAt);
  assert.equal(output.pullRequestMergeTargets[0].event.mergeRefName, "stack/topic");
  assert.equal(output.facts.find((fact) => fact.metricId === "pr_merged").mergeTarget.branch, "stack/topic");
});

test("merge-target normalizer rejects a foreign enriched subject without borrowing its native event", async () => {
  const s = mergeTargetFixture();
  s.options.enrich = async () => {
    const value = structuredClone(envelope(s));
    value.payload.node_id = "PR_other";
    value.payload.id = 20;
    return value;
  };
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.deepEqual(output.pullRequestMergeTargets, []);
  assert.ok(output.reasons.includes("merge_target_selected_source_unverified"));
  assert.ok(output.facts.every((fact) => fact.mergeTarget === undefined));
  assert.equal(s.state.requests.length, 0);
});

test("merge-target normalizer does not enable the profile for an unselected repository", async () => {
  const s = mergeTargetFixture();
  s.options.allowedRepositoryIds.push(3);
  s.options.pullRequestMergeTargetRepositoryIds = [3];
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.equal(output.pullRequestMergeTargets, undefined);
  assert.ok(output.facts.every((fact) => fact.mergeTarget === undefined));
  assert.equal(s.state.requests.length, 0);
});

test("merge-target normalizer leaves legacy numeric subjects unknown without a retained native-node binding", async () => {
  const s = mergeTargetFixture();
  s.input.fact.subjectId = String(s.payload.id);
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.ok(output.facts.some((fact) => fact.metricId === "pr_merged"));
  assert.deepEqual(output.pullRequestMergeTargets, []);
  assert.ok(output.reasons.includes("merge_target_selected_source_unverified"));
  assert.ok(output.facts.every((fact) => fact.mergeTarget === undefined));
  assert.equal(s.state.requests.length, 0);
});

test("merge-target normalizer rejects clock reversal and revocation without returning stale positive authority", async () => {
  const clock = mergeTargetFixture();
  const times = [observedAt, "2026-10-09T10:00:00.000Z"];
  clock.options.now = () => times.shift();
  await assert.rejects(createGithubEvidenceNormalizer(clock.options)(clock.input), /observation_clock_invalid/);
  const revoked = mergeTargetFixture();
  const normalize = createGithubEvidenceNormalizer(revoked.options);
  revoked.options.assertAuthorized = () => {};
  revoked.state.onRead = async (path) => {
    if (path === "/graphql") revoked.state.authorized = false;
  };
  await assert.rejects(normalize(revoked.input), /authorization-revoked/);
});

for (const [name, selection] of [
  ["single hole", Array(1)],
  ["valid then hole", [2, ,]],
  ["explicit undefined", [undefined]],
  ["duplicate repository", [2, 2]],
  ["unauthorized repository", [3]],
  ["numeric string", ["2"]],
])
  test(`merge-target normalizer rejects ${name} in its protected repository selection`, () => {
    const s = mergeTargetFixture();
    s.options.pullRequestMergeTargetRepositoryIds = selection;
    assert.throws(() => createGithubEvidenceNormalizer(s.options), /invalid_pull_request_merge_target_repositories/);
  });

test("merge-target normalizer requires an authorization callback for an enabled repository", () => {
  const s = mergeTargetFixture();
  delete s.options.assertAuthorized;
  assert.throws(() => createGithubEvidenceNormalizer(s.options), /invalid_pull_request_merge_target_repositories/);
});
