import assert from "node:assert/strict";
import test from "node:test";
import {
  githubRestSnapshotFingerprint,
  githubRestSnapshotRevision,
  githubRestSnapshotSemanticRevision,
  verifyGithubRestSnapshotRevision,
} from "../dist/index.js";
const payload = {
  id: 10,
  node_id: "PRRC_SYNTHETIC_10",
  html_url: "https://github.com/synthetic-owner/repository/pull/7#discussion_r10",
  url: "https://api.github.com/repos/synthetic-owner/repository/pulls/comments/10",
  pull_request_url: "https://api.github.com/repos/synthetic-owner/repository/pulls/7",
  pull_request_review_id: 90,
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  body: "synthetic inline",
};
// Issued by the unchanged d8 version against this exact synthetic payload.
const legacy =
  "gh-rest-v1:8cd9493968bda4c2fabe05ce5b3c7c15a26c2190602bc335fb5db8484c6b1911.d21884b1c4f6482f7ac06cbfd1b02c60";
test("retained custom inline v1 markers retain their exact historical verification projection", () => {
  assert.equal(verifyGithubRestSnapshotRevision("comments", payload, legacy), true);
  assert.equal(
    githubRestSnapshotFingerprint("comments", payload),
    "8cd9493968bda4c2fabe05ce5b3c7c15a26c2190602bc335fb5db8484c6b1911",
  );
  assert.equal(verifyGithubRestSnapshotRevision("comments", { ...payload, body: "synthetic edit" }, legacy), false);
});
test("new inline markers version their expanded dependency projection and reject dependency edits", () => {
  const current = githubRestSnapshotRevision("comments", payload, "gc2:" + "a".repeat(64));
  assert.match(current, /^gh-rest-comment-v2:/);
  assert.equal(verifyGithubRestSnapshotRevision("comments", payload, current), true);
  for (const changed of [
    { ...payload, pull_request_review_id: 91 },
    { ...payload, in_reply_to_id: 9 },
    { ...payload, commit_id: "b".repeat(40) },
  ])
    assert.equal(verifyGithubRestSnapshotRevision("comments", changed, current), false);
  assert.notEqual(githubRestSnapshotSemanticRevision(current), githubRestSnapshotSemanticRevision(legacy));
  assert.equal(verifyGithubRestSnapshotRevision("issues", payload, current), false);
});
test("ordinary comment markers keep v1 while malformed reserved inline versions fail closed", () => {
  const issue = { ...payload, issue_url: "https://api.github.com/repos/synthetic-owner/repository/issues/7" };
  delete issue.pull_request_url;
  delete issue.pull_request_review_id;
  const current = githubRestSnapshotRevision("comments", issue, "synthetic-new-issue");
  assert.match(current, /^gh-rest-v1:/);
  assert.equal(verifyGithubRestSnapshotRevision("comments", issue, current), true);
  for (const malformed of [
    "gh-rest-comment-v2:",
    current.replace("gh-rest-v1:", "gh-rest-comment-v3:"),
    current.replace("gh-rest-v1:", "gh-rest-comment-v2:"),
  ])
    assert.equal(verifyGithubRestSnapshotRevision("comments", issue, malformed), false);
});
