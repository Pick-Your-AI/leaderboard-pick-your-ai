import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  minimizeDiscussionFeedback,
  discussionFeedbackFingerprint,
  githubDiscussionRevision,
  createGithubEvidenceNormalizer,
} from "../dist/index.js";
import { discussionFeedbackLimits } from "@pick-your-ai/contracts";
import { feedbackNode, feedbackRepository, feedbackScenario } from "../../../tests/fixtures/helpful-feedback.mjs";

const minimize = (node) => minimizeDiscussionFeedback(node, feedbackRepository, githubDiscussionRevision(node));
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
test("feedback content hashes exact bounded UTF-8 without retaining or normalizing text", () => {
  const node = feedbackNode();
  node.title = "😀".repeat(discussionFeedbackLimits.titleBytes / 4);
  node.body = "é".repeat(discussionFeedbackLimits.bodyBytes / 2);
  node.answer.body = "a".repeat(discussionFeedbackLimits.bodyBytes);
  const result = minimize(node);
  assert.equal(result.titleDigest, hash(node.title));
  assert.equal(result.bodyDigest, hash(node.body));
  assert.equal(result.answer.bodyDigest, hash(node.answer.body));
  assert.doesNotMatch(JSON.stringify(result), /"(?:title|body)":/);
  const decomposed = feedbackNode();
  decomposed.body = "e\u0301";
  const composed = feedbackNode();
  composed.body = "é";
  assert.notEqual(minimize(decomposed).bodyDigest, minimize(composed).bodyDigest);
  assert.notEqual(
    discussionFeedbackFingerprint(minimize(decomposed)),
    discussionFeedbackFingerprint(minimize(composed)),
  );
});
for (const field of ["title", "body", "answer.body"])
  test(`feedback ${field} rejects oversize text, nontext and malformed Unicode before encoding`, () => {
    for (const value of [
      "a".repeat((field === "title" ? discussionFeedbackLimits.titleBytes : discussionFeedbackLimits.bodyBytes) + 1),
      "\ud800",
      "\udc00",
      "\ud800x\udc00",
      { text: "invented" },
      null,
    ]) {
      const node = feedbackNode();
      if (field === "answer.body") node.answer.body = value;
      else node[field] = value;
      assert.throws(() => minimize(node), /feedback_source_unverified/);
    }
  });
test("feedback observes selected native answer visibility and exact bounded identities", () => {
  for (const change of [
    (node) => {
      node.answer.isMinimized = true;
    },
    (node) => {
      node.answer.deletedAt = node.updatedAt;
    },
    (node) => {
      node.answer.isAnswer = false;
    },
    (node) => {
      node.author.login += "\n";
    },
    (node) => {
      node.id += "\n";
    },
    (node) => {
      node.author.databaseId = "101";
    },
  ]) {
    const node = feedbackNode();
    change(node);
    assert.throws(() => minimize(node), /feedback/);
  }
  const unknown = feedbackNode();
  unknown.author = { __typename: "Organization", login: "synthetic-org" };
  assert.equal(minimize(unknown).author, null);
});
test("direct feedback normalizer rejects a future native selection before its protected callback or hydration", async () => {
  const s = feedbackScenario();
  const normalizer = createGithubEvidenceNormalizer({
    client: {
      forRepository() {
        assert.fail("minimized feedback must not hydrate");
      },
    },
    sourceId: "installation:1",
    allowedRepositoryIds: [2],
    verifyDiscussionFeedbackSource: async () => {
      assert.fail("future observation reached callback");
    },
  });
  await assert.rejects(
    normalizer({
      repository: { id: 2, slug: feedbackRepository.slug },
      family: "discussions",
      factKey: "synthetic-source-key",
      policyVersion: "synthetic-policy",
      observedAt: "2026-10-11T12:00:00.000Z",
      selectedCurrentState: true,
      fact: {
        subjectId: s.source.metadata.descriptor.discussionId,
        sourceRevision: s.source.sourceRevision,
        sourceUrl: s.source.metadata.descriptor.threadUrl,
        evidence: "current_state",
        actorId: null,
        occurredAt: null,
        state: "present",
        discussionFeedback: s.source.metadata,
      },
    }),
    /feedback_contract/,
  );
});
