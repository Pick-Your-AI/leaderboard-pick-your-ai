import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  encodeGithubPullRequestMergeTargetCapture,
  githubPullRequestMergeTargetHash,
  isPullRequestMergeTargetBranch,
  supportsPullRequestMergeTarget,
  validateGithubPullRequestMergeTargetCaptureInput,
  validatePullRequestMergeTarget,
  verifyGithubPullRequestMergeTargetCapture,
} from "../dist/index.js";

const capture = () => ({
  schemaVersion: "github-pr-merge-target/v1",
  repository: { id: 42, slug: "synthetic-owner/merge-target" },
  pullRequest: { id: "PR_synthetic", number: 7, url: "https://github.com/synthetic-owner/merge-target/pull/7" },
  sourceRevision: "synthetic:revision:1",
  observedAt: "2026-10-04T00:00:00.000Z",
  mergedAt: "2026-10-03T12:00:00.000Z",
  status: "known",
  event: {
    id: "ME_synthetic",
    createdAt: "2026-10-03T12:00:00.000Z",
    mergeRefName: "feature/Release",
    commitOid: "a".repeat(40),
  },
  reason: null,
});

test("merge-target capture hashing has one domain-separated canonical encoding and detached verification", async () => {
  const original = capture();
  const bytes = encodeGithubPullRequestMergeTargetCapture(original);
  assert.equal(new TextDecoder().decode(bytes).startsWith("github-pr-merge-target/v1\n{"), true);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const reversed = Object.fromEntries(Object.entries(original).reverse());
  reversed.event = Object.fromEntries(Object.entries(reversed.event).reverse());
  assert.equal(await githubPullRequestMergeTargetHash(reversed), expected);
  const supplied = { ...original, proofHash: expected };
  const pending = verifyGithubPullRequestMergeTargetCapture(supplied);
  supplied.event.mergeRefName = "changed-after-validation";
  supplied.repository.id = 43;
  const verified = await pending;
  assert.equal(verified.event.mergeRefName, "feature/Release");
  assert.equal(verified.repository.id, 42);
  assert.equal(verified.proofHash, expected);
  assert.notEqual(verified.event, supplied.event);
  await assert.rejects(verifyGithubPullRequestMergeTargetCapture(supplied), /proof hash/);
});

test("known merge targets require exact public PR identity, native commit and normalized event clocks", () => {
  const mutations = [
    (value) => (value.repository.id = 0),
    (value) => (value.repository.slug = "synthetic-owner/../other"),
    (value) => (value.pullRequest.url += "?view=current"),
    (value) => (value.pullRequest.number = 8),
    (value) => (value.pullRequest.id = ""),
    (value) => (value.sourceRevision = ""),
    (value) => (value.event = null),
    (value) => (value.event.mergeRefName = null),
    (value) => (value.event.commitOid = null),
    (value) => (value.event.commitOid = "not-a-native-commit"),
    (value) => (value.event.createdAt = "2026-10-03T12:00:00.001Z"),
    (value) => (value.event.createdAt = "2026-10-03T12:00:00.0001Z"),
    (value) => (value.mergedAt = "2026-10-03T12:00:00Z"),
    (value) => (value.mergedAt = "2026-10-03T14:00:00.000+02:00"),
    (value) => (value.observedAt = "2026-10-03T11:00:00.000Z"),
    (value) => (value.reason = "merge_event_missing"),
    (value) => (value.event.mergeRef = { name: "current-main" }),
    (value) => (value.extra = true),
  ];
  assert.deepEqual(validateGithubPullRequestMergeTargetCaptureInput(capture()), capture());
  for (const [index, change] of mutations.entries()) {
    const candidate = capture();
    change(candidate);
    assert.throws(() => validateGithubPullRequestMergeTargetCaptureInput(candidate), `mutation ${index}`);
  }
});

test("unknown merge targets retain absent historical fields and a bounded reason without inventing a branch", async () => {
  const absent = { ...capture(), status: "unknown", event: null, reason: "merge_event_missing" };
  const missingBranch = {
    ...capture(),
    status: "unknown",
    event: { ...capture().event, mergeRefName: null, commitOid: null },
    reason: "merge_event_branch_missing",
  };
  for (const value of [absent, missingBranch]) {
    const verified = await verifyGithubPullRequestMergeTargetCapture({
      ...value,
      proofHash: await githubPullRequestMergeTargetHash(value),
    });
    assert.equal(verified.status, "unknown");
    assert.equal(verified.event?.mergeRefName ?? null, null);
  }
  assert.throws(() => validateGithubPullRequestMergeTargetCaptureInput({ ...absent, reason: null }));
  assert.throws(() => validateGithubPullRequestMergeTargetCaptureInput({ ...absent, reason: "arbitrary-error" }));
});

test("branch literals preserve slash, case and valid non-BMP identity while rejecting lossy or unsafe names", () => {
  for (const value of ["main", "Main", "feature/Release", "unknown", "feature/🚀", "a".repeat(255)]) {
    assert.equal(isPullRequestMergeTargetBranch(value), true, value);
    assert.equal(new URLSearchParams({ branch: value }).get("branch"), value);
  }
  for (const value of [
    "",
    null,
    " main",
    "main ",
    "feature//part",
    "feature/../part",
    "feature/.hidden",
    "feature/x.lock",
    "feature/",
    "feature@{old}",
    "feature?x",
    "HEAD",
    "@",
    "-option",
    "feature/\uD800",
    "feature/\uDC00",
    "a".repeat(256),
    "é".repeat(128),
  ])
    assert.equal(isPullRequestMergeTargetBranch(value), false, String(value));
});

test("normalized merge-target facts are strict private bindings and supported metrics remain explicit", () => {
  const fact = {
    schemaVersion: "pr-merge-target/v1",
    repositoryId: "42",
    pullRequestId: "PR_synthetic",
    eventId: "ME_synthetic",
    mergedAt: "2026-10-03T12:00:00.000Z",
    branch: "feature/Release",
    proofHash: "b".repeat(64),
  };
  assert.deepEqual(validatePullRequestMergeTarget(fact), fact);
  for (const patch of [
    { repositoryId: "042" },
    { repositoryId: "9007199254740992" },
    { pullRequestId: "" },
    { eventId: "" },
    { mergedAt: "2026-10-03T12:00:00Z" },
    { branch: null },
    { proofHash: "unverified" },
    { rawState: "target:main" },
  ])
    assert.throws(() => validatePullRequestMergeTarget({ ...fact, ...patch }), JSON.stringify(patch));
  for (const metric of ["pr_merged", "maintainer_merges", "pr_coauthored"])
    assert.equal(supportsPullRequestMergeTarget(metric), true);
  for (const metric of ["pr_opened", "pr_ready", "pr_accepted_rate", "reverted_delivery", "release_changes"])
    assert.equal(supportsPullRequestMergeTarget(metric), false);
});
