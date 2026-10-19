import assert from "node:assert/strict";
import test from "node:test";
import {
  createGithubEvidenceNormalizer,
  readGithubCommentIdentity,
  readGithubCommentSource,
  githubRestSnapshotRevision,
  githubRestSnapshotSemanticRevision,
} from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";

const slug = "synthetic-owner/repository";
const at = "2026-10-01T12:00:00Z";
const payload = (kind) => ({
  id: 10,
  node_id: kind === "inline" ? "PRRC_10" : "IC_10",
  url: "https://api.github.com/repos/" + slug + (kind === "inline" ? "/pulls/comments/10" : "/issues/comments/10"),
  html_url:
    "https://github.com/" +
    slug +
    (kind === "issue" ? "/issues/7#" : "/pull/7#") +
    (kind === "inline" ? "discussion_r10" : "issuecomment-10"),
  ...(kind === "inline"
    ? { pull_request_url: "https://api.github.com/repos/" + slug + "/pulls/7", pull_request_review_id: 90 }
    : { issue_url: "https://api.github.com/repos/" + slug + "/issues/7" }),
  body: "synthetic comment body",
  created_at: at,
  updated_at: at,
  user: { id: 42, node_id: "U_42", type: "User", login: "synthetic-author" },
});
const input = (value) => ({
  repository: { id: 2, slug },
  family: "comments",
  factKey: "synthetic-comment-fact",
  observedAt: "2026-10-02T12:00:00.000Z",
  policyVersion: "synthetic-policy",
  fact: {
    subjectId: value.node_id,
    sourceRevision: at,
    sourceUrl: value.html_url,
    evidence: "current_state",
    actorId: null,
    occurredAt: null,
    state: "present",
  },
});
const normalize = (value, calls = []) =>
  createGithubEvidenceNormalizer({
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    client: syntheticRepositoryClient(2, {
      async rest(_source, path) {
        calls.push(path);
        if (path === "/repos/" + slug) return { id: 2, private: false, full_name: slug };
        assert.equal(path, "/repos/" + slug + (value.pull_request_url ? "/pulls/comments/10" : "/issues/comments/10"));
        return structuredClone(value);
      },
    }),
  });

for (const [kind, action] of [
  ["conversation", "pull_request_conversation_comment_snapshot"],
  ["inline", "pull_request_review_comment_snapshot"],
]) {
  test(
    "default hydration retains neutral " + kind + " PR comment identity without answer or review credit",
    async () => {
      const value = payload(kind),
        calls = [];
      const out = await normalize(value, calls)(input(value));
      assert.equal(out.observations.length, 1);
      assert.equal(out.observations[0].artifactId, value.node_id);
      assert.equal(out.observations[0].sourceUrl, value.html_url);
      assert.equal(out.observations[0].action, action);
      assert.equal(out.observations[0].actorId, null);
      assert.equal(out.observations[0].occurredAt, null);
      assert.deepEqual(out.facts, []);
      assert.deepEqual(out.evidence, []);
      assert.deepEqual(out.participation, []);
      assert.ok(!out.reasons.includes("source_family_requires_exact_event_enrichment"));
      assert.ok(calls.some((path) => path.endsWith("/comments/10")));
      assert.equal(JSON.stringify(out).includes(value.body), false);
    },
  );
}

test("ordinary issue comments retain their existing pending answer-evidence semantics", async () => {
  const value = payload("issue");
  const out = await normalize(value)(input(value));
  assert.equal(out.facts.length, 1);
  assert.equal(out.facts[0].metricId, "issue_answers");
  assert.equal(out.facts[0].state, "pending");
  assert.equal(out.facts[0].acceptedAt, null);
  assert.equal(out.facts[0].actorId, "42");
  assert.ok(out.reasons.includes("comment_is_not_an_accepted_answer_or_substantive_response"));
});

test("PR comment identity rejects mismatched native parent, self, anchor and opaque node bindings", () => {
  const valid = payload("inline");
  assert.equal(readGithubCommentIdentity(slug, valid)?.kind, "pull_request_review_comment");
  for (const changed of [
    { ...valid, id: 11 },
    { ...valid, node_id: "" },
    { ...valid, node_id: "bad node" },
    { ...valid, url: valid.url + "?token=synthetic" },
    { ...valid, pull_request_url: "https://api.github.com/repos/" + slug + "/pulls/8" },
    { ...valid, issue_url: null },
    { ...valid, html_url: valid.html_url.replace("/pull/7", "/issues/7") },
    { ...valid, html_url: valid.html_url.replace(slug, "synthetic-other/repository") },
    { ...valid, _links: { self: { href: valid.url + "/different" } } },
    { ...valid, _links: { pull_request: { href: "https://api.github.com/repos/" + slug + "/pulls/8" } } },
  ])
    assert.equal(readGithubCommentIdentity(slug, changed), null);
  for (const invalid of [
    valid.html_url + "?extra",
    valid.html_url.replace("#discussion_r10", "#discussion_r010"),
    valid.html_url.replace("#discussion_r10", "#discussion-diff-1"),
  ])
    assert.equal(readGithubCommentSource(slug, invalid), null);
});

test("native inline comment edits invalidate the exact immutable snapshot without creating activity credit", async () => {
  const original = payload("inline");
  const fact = input(original);
  fact.fact.sourceRevision = githubRestSnapshotRevision("comments", original, "gc2:" + "a".repeat(64));
  const matching = await normalize(original)(fact);
  assert.equal(matching.observations.length, 1);
  assert.deepEqual(matching.facts, []);
  for (const changed of [
    { ...original, body: "synthetic edited comment at unchanged timestamp" },
    { ...original, pull_request_review_id: 91 },
    { ...original, in_reply_to_id: 9 },
    { ...original, commit_id: "b".repeat(40) },
  ]) {
    assert.notEqual(
      githubRestSnapshotSemanticRevision(githubRestSnapshotRevision("comments", changed, "synthetic-edited-inline")),
      githubRestSnapshotSemanticRevision(fact.fact.sourceRevision),
    );
    const rejected = await normalize(changed)(fact);
    assert.deepEqual(rejected.observations, []);
    assert.deepEqual(rejected.facts, []);
  }
});

test("unknown native PR comment author remains unknown rather than borrowing the parent actor", async () => {
  const value = { ...payload("inline"), user: null };
  const out = await normalize(value)(input(value));
  assert.equal(out.observations.length, 1);
  assert.equal(out.observations[0].actorId, null);
  assert.deepEqual(out.actors, []);
  assert.deepEqual(out.facts, []);
  assert.deepEqual(out.evidence, []);
});
