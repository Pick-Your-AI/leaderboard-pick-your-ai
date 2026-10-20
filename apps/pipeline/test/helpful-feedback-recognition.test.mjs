import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  applyRecognitionReceipt,
  discussionFeedbackRevision,
  discussionFeedbackPublicRevision,
  discussionFeedbackFingerprint,
} from "@pick-your-ai/github";
import { parseDiscussionFeedbackSource, parseAcceptedFeedbackThreadText } from "@pick-your-ai/contracts";
import { aggregateMetric, getMetricUi } from "@pick-your-ai/metrics";
import { materializeRecognition, recognitionFingerprint } from "../src/recognition-adapter.mjs";
import { localizationReviewRequest } from "../../controls/src/localization-review.mjs";
import {
  feedbackScenario,
  feedbackRequest,
  feedbackBinding,
  feedbackCutoff,
  feedbackAcceptedAt,
  attachFeedbackIntake,
} from "../../../tests/fixtures/helpful-feedback.mjs";

const run = (s, apply = applyRecognitionReceipt, bindings = [s.binding]) =>
  materializeRecognition(s.input, s.state, bindings, s.policies, apply, feedbackCutoff);
const accepted = (input) => input.facts.filter((fact) => fact.metricId === "helpful_feedback");
for (const sourceMetricId of ["discussions_started", "discussion_answers"])
  test(`helpful feedback admits the actual ${sourceMetricId} author through current independent review`, () => {
    const s = feedbackScenario({ sourceMetricId }),
      output = run(s),
      [fact] = accepted(output);
    assert.equal(accepted(output).length, 1);
    assert.equal(fact.actorId, sourceMetricId === "discussions_started" ? "101" : "303");
    assert.equal(fact.acceptedAt, feedbackAcceptedAt);
    assert.equal(fact.acceptedBy, "202");
    assert.equal(fact.occurredAt, s.target.occurredAt);
    assert.equal(output.evidence.at(-1).occurredAt, feedbackAcceptedAt);
    assert.equal(output.evidence.at(-1).evidenceMetadata.sourceOccurredAt, s.target.occurredAt);
    assert.doesNotMatch(
      JSON.stringify(output.evidence),
      /synthetic-helpful-review|gdf1:|"bodyDigest"|"descriptorFingerprint"/,
    );
  });
test("unchanged later scans retain the original observed/reviewed clock and full original revision", () => {
  const s = feedbackScenario();
  const original = structuredClone(s.input.discussionFeedbackOriginals[0]);
  const current = s.input.discussionFeedbackSources[0];
  current.metadata.scanId = "synthetic-later-scan";
  current.sourceRevision = discussionFeedbackRevision(current.metadata);
  current.observedAt = "2026-10-15T09:00:00.000Z";
  for (const fact of s.input.facts) fact.observedAt = current.observedAt;
  for (const evidence of s.input.evidence) {
    evidence.sourceRevision = discussionFeedbackPublicRevision(current.metadata);
    evidence.evidenceMetadata.observedAt = current.observedAt;
  }
  const output = run(s);
  assert.equal(accepted(output)[0].acceptedAt, feedbackAcceptedAt);
  assert.deepEqual(s.input.discussionFeedbackOriginals[0], original);
  assert.notEqual(current.sourceRevision, original.sourceRevision);
});
test("one author/thread unit survives duplicate requests and start/answer aliases with earliest valid acceptance", () => {
  const s = feedbackScenario({ sameAuthor: true });
  const answer = s.input.facts.find((fact) => fact.metricId === "discussion_answers");
  const later = feedbackRequest(s.source, answer, {
    id: "synthetic-answer-alias",
    acceptedAt: "2026-10-14T11:00:00.000Z",
  });
  s.state.requests[later.request.id] = later.request;
  s.state.audit.push(later.decision);
  const bindings = [s.binding, feedbackBinding("discussion_answers")];
  const output = run(s, applyRecognitionReceipt, bindings);
  assert.equal(accepted(output).length, 1);
  assert.equal(accepted(output)[0].acceptedAt, feedbackAcceptedAt);
  assert.equal(accepted(output)[0].acceptanceReceipt, s.decision.id);
  const reverse = {
    ...s,
    state: { ...s.state, requests: Object.fromEntries(Object.entries(s.state.requests).reverse()) },
  };
  assert.deepEqual(accepted(run(reverse, applyRecognitionReceipt, bindings)), accepted(output));
});
const invalid = {
  "generation after observed mutation": (s) => {
    s.source.metadata.generation = "d".repeat(64);
    s.source.sourceRevision = discussionFeedbackRevision(s.source.metadata);
  },
  "missing completeness authority": (s) => {
    s.input.discussionFeedbackSources = [];
  },
  "missing original observation": (s) => {
    s.input.discussionFeedbackOriginals = [];
  },
  "noncurrent observation": (s) => {
    s.source.selectedCurrentState = false;
  },
  "different thread author": (s) => {
    s.target.actorId = "202";
  },
  "generic comment": (s) => {
    s.target.metricId = "issue_answers";
  },
  "qualified overlay": (s) => {
    s.target.state = "qualified";
  },
  "correction overlay": (s) => {
    s.target.revision = 1;
    s.target.correctionReceipt = "synthetic-correction";
  },
  "wrong artifact": (s) => {
    s.input.evidence[0].artifact.stableId = "OTHER_THREAD";
  },
  "invented native canonical identity": (s) => {
    s.target.canonicalKey = "synthetic-fake-canonical";
    s.input.evidence[0].contribution.canonicalEventId = s.target.canonicalKey;
  },
  "invented original qualification marker": (s) => {
    s.input.evidence[0].contribution.reasonCodes = ["accepted_by_payload"];
  },
  "unmatched original source-use reference": (s) => {
    s.decision.sourceUseReview.references[0].revision = "synthetic-unrelated-revision";
  },
  "duplicated original source-use reference": (s) => {
    s.decision.sourceUseReview.references.push(structuredClone(s.decision.sourceUseReview.references[0]));
  },
  "answer selector": (s) => {
    const review = JSON.parse(s.request.detail);
    review.actorId = "202";
    s.request.detail = JSON.stringify(review);
    attachFeedbackIntake(s.request);
  },
  "unknown original clock": (s) => {
    const review = JSON.parse(s.request.detail);
    review.observedAt = null;
    s.request.detail = JSON.stringify(review);
    attachFeedbackIntake(s.request);
  },
  "acceptance before observation": (s) => {
    s.decision.at = Date.parse("2026-10-12T12:00:00.000Z");
    attachFeedbackIntake(s.request);
  },
  "extra private claim fields": (s) => {
    const review = JSON.parse(s.request.detail);
    review.helpful = true;
    s.request.detail = JSON.stringify(review);
    attachFeedbackIntake(s.request);
  },
  "wrong original revision": (s) => {
    const review = JSON.parse(s.request.detail);
    review.sourceRevision = review.sourceRevision.slice(0, -1) + "f";
    s.request.detail = JSON.stringify(review);
    attachFeedbackIntake(s.request);
  },
};
for (const [name, mutate] of Object.entries(invalid))
  test(`helpful feedback rejects ${name} before any host callback`, () => {
    const s = feedbackScenario();
    mutate(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /feedback|recognition/,
    );
    assert.equal(calls, 0);
  });
test("every duplicate alias is validated before the earliest helpful receipt callback", () => {
  const s = feedbackScenario();
  const later = feedbackRequest(s.source, s.target, {
    id: "synthetic-invalid-later",
    acceptedAt: "2026-10-14T11:00:00.000Z",
  });
  const review = JSON.parse(later.request.detail);
  review.generation = "e".repeat(64);
  later.request.detail = JSON.stringify(review);
  attachFeedbackIntake(later.request);
  s.state.requests[later.request.id] = later.request;
  s.state.audit.push(later.decision);
  let calls = 0;
  assert.throws(
    () =>
      run(s, (input) => {
        calls++;
        return input;
      }),
    /feedback/,
  );
  assert.equal(calls, 0);
});
test("an earlier generic callback cannot enroll a reviewer through an array shared with a helpful binding", () => {
  const s = feedbackScenario();
  const earlier = feedbackRequest(s.source, s.target, {
    id: "synthetic-generic-before-feedback",
    acceptedAt: "2026-10-14T09:00:00.000Z",
  });
  earlier.request.category = "review";
  earlier.request.scope = "repository:2:synthetic-generic-review";
  attachFeedbackIntake(earlier.request);
  const genericBinding = {
    ...s.binding,
    category: earlier.request.category,
    scope: earlier.request.scope,
    metricId: "review_feedback",
  };
  delete genericBinding.helpfulFeedback;
  assert.equal(genericBinding.reviewerIds, s.binding.reviewerIds);
  s.decision.actor = "999";
  attachFeedbackIntake(s.request);
  s.state.requests[earlier.request.id] = earlier.request;
  s.state.audit.push(earlier.decision);
  s.policies.push({ policy: { ...s.policies[0].policy, metricId: "review_feedback" } });
  const calls = [];
  assert.throws(
    () =>
      run(
        s,
        (input, receipt, reviewers) => {
          calls.push(receipt.metricId);
          reviewers.push("999");
          return receipt.metricId === "review_feedback" ? input : applyRecognitionReceipt(input, receipt, reviewers);
        },
        [genericBinding, s.binding],
      ),
    /recognition_decision_unverified/,
  );
  assert.deepEqual(calls, ["review_feedback"]);
  assert.deepEqual(s.binding.reviewerIds, ["202"]);
});
test("a public-reasons callback cannot repair later source authority through an aliased contribution", () => {
  const s = feedbackScenario();
  const sourceRevision = s.source.sourceRevision;
  const localization = { category: "documentation", locale: "fr", policyVersion: "synthetic-locale-v1" };
  const reasons = [
    `documentation_path_policy:${localization.policyVersion}`,
    `locale:${localization.locale}`,
    `localization_category:${localization.category}`,
  ];
  const target = { ...s.target, id: "synthetic-localization-source", metricId: "localization" };
  const proof = structuredClone(s.input.evidence[0]);
  proof.sourceRevision = "a".repeat(64);
  proof.contribution.contributionId = target.id;
  proof.contribution.metricIds = ["localization"];
  proof.contribution.reasonCodes = reasons;
  // structuredClone preserves this alias inside the invocation snapshot. A
  // callback must receive its own copy even when the source graph shares data.
  proof.contribution.relatedObservation = s.source;
  s.input.facts.unshift(target);
  s.input.evidence.unshift(proof);
  const earlier = feedbackRequest(s.source, target, {
    id: "synthetic-localization-before-feedback",
    acceptedAt: "2026-10-14T09:00:00.000Z",
  });
  earlier.request.category = "localization";
  earlier.request.scope = "repository:2:synthetic-localization";
  attachFeedbackIntake(earlier.request);
  earlier.decision.localization = { ...localization, targetFactId: target.id, sourceRevision: proof.sourceRevision };
  earlier.decision.evidenceRequest = localizationReviewRequest(earlier.request);
  const binding = {
    ...s.binding,
    category: earlier.request.category,
    scope: earlier.request.scope,
    metricId: "localization",
    sourceMetricId: "localization",
    localization,
  };
  delete binding.helpfulFeedback;
  s.state.requests[earlier.request.id] = earlier.request;
  s.state.audit.push(earlier.decision);
  s.policies.push({ policy: { ...s.policies[0].policy, metricId: "localization", dateBasis: "occurredAt" } });
  s.source.sourceRevision = "gdf1:" + "e".repeat(64) + "." + "f".repeat(32);
  const invalidRevision = s.source.sourceRevision;
  const calls = [];
  let repairAttempts = 0;
  assert.throws(
    () =>
      materializeRecognition(
        s.input,
        s.state,
        [binding, s.binding],
        s.policies,
        (input, receipt) => {
          calls.push(receipt.metricId);
          return input;
        },
        feedbackCutoff,
        (contribution) => {
          if (contribution.relatedObservation) {
            repairAttempts++;
            contribution.relatedObservation.sourceRevision = sourceRevision;
          }
          return contribution.reasonCodes.filter((reason) => reasons.includes(reason));
        },
      ),
    /discussion_feedback_source_unverified/,
  );
  assert.equal(repairAttempts, 1);
  assert.deepEqual(calls, ["localization"]);
  assert.equal(s.source.sourceRevision, invalidRevision);
});
for (const patch of [
  { dateBasis: "occurredAt" },
  { rankedStates: ["observed"] },
  { groupBy: "actor_artifact" },
  { roles: ["reviewer"] },
  { groupingPolicyVersion: undefined },
])
  test(`helpful feedback rejects incompatible policy ${JSON.stringify(patch)}`, () => {
    const s = feedbackScenario();
    Object.assign(s.policies[0].policy, patch);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /recognition_policy/,
    );
    assert.equal(calls, 0);
  });
test("current withdrawal/consent and binding changes fence the selected authority, including empty intake", () => {
  const s = feedbackScenario(),
    before = recognitionFingerprint(s.state, [s.binding]);
  s.request.status = "withdrawn";
  assert.notEqual(recognitionFingerprint(s.state, [s.binding]), before);
  assert.equal(accepted(run(s)).length, 0);
  s.request.status = "accepted";
  s.request.detail += " ";
  assert.equal(accepted(run(s)).length, 0);
  const noRequests = { requests: {}, profiles: {}, audit: [] };
  assert.notEqual(recognitionFingerprint(noRequests, [s.binding]), recognitionFingerprint(noRequests, []));
});
test("valid feedback enrollment uses the exact versioned empty-intake authority and preserves unrelated fingerprints", () => {
  const s = feedbackScenario();
  const empty = { requests: {}, profiles: {}, audit: [] };
  const unrelated = { ...s.binding, metricId: "accepted_findings", sourceMetricId: "issues_opened" };
  delete unrelated.helpfulFeedback;
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const bindings of [[s.binding], [unrelated, s.binding], [s.binding, unrelated]]) {
    const historical = ["localization-review-target/v1", [], [], [], bindings];
    const expected = hash([...historical, "accepted-feedback-threads/v1"]);
    assert.equal(recognitionFingerprint(empty, bindings), expected);
    assert.notEqual(expected, hash(historical));
  }
  for (const bindings of [[], [unrelated]])
    assert.equal(
      recognitionFingerprint(empty, bindings),
      hash(["localization-review-target/v1", [], [], [], bindings]),
    );
});
test("missing or malformed feedback enrollment cannot preserve saved authority or reach a receipt callback", () => {
  for (const change of [
    (binding) => delete binding.helpfulFeedback,
    (binding) => (binding.helpfulFeedback = null),
    (binding) => (binding.helpfulFeedback.version = "accepted-feedback-threads/v2"),
    (binding) => (binding.sourceMetricId = "issues_opened"),
    (binding) => (binding.metricId = "accepted_findings"),
    (binding) => (binding.repositoryId = "02"),
  ]) {
    const s = feedbackScenario();
    const valid = structuredClone(s.binding);
    change(s.binding);
    for (const state of [s.state, { requests: {}, profiles: {}, audit: [] }])
      for (const bindings of [[s.binding], [valid, s.binding], [s.binding, valid]])
        assert.throws(() => recognitionFingerprint(state, bindings), /feedback/);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /feedback/,
    );
    assert.equal(calls, 0);
  }
});
test("direct receipt cannot bypass original/current feedback source admission with a same-metric overlay", () => {
  const s = feedbackScenario();
  const output = run(s),
    target = accepted(output)[0];
  assert.throws(
    () =>
      applyRecognitionReceipt(
        output,
        {
          id: "synthetic-overlay-receipt",
          verified: true,
          metricId: "helpful_feedback",
          actorId: target.actorId,
          reviewerId: "202",
          acceptedAt: feedbackAcceptedAt,
          decision: "accepted",
          targetFactId: target.id,
          evidenceIds: [target.id],
          helpfulFeedback: JSON.parse(s.request.detail),
        },
        ["202"],
      ),
    /feedback/,
  );
});

const futureClock = "2026-10-14T09:00:00.000Z";
for (const [name, change] of Object.entries({
  "thread update": (d) => {
    d.updatedAt = futureClock;
  },
  "thread edit": (d) => {
    d.updatedAt = futureClock;
    d.lastEditedAt = futureClock;
  },
  "answer update": (d) => {
    d.answer.updatedAt = futureClock;
  },
  "answer edit": (d) => {
    d.answer.updatedAt = futureClock;
    d.answer.lastEditedAt = futureClock;
  },
  "answer selection": (d) => {
    d.answerChosenAt = futureClock;
  },
}))
  test(`original and current observations reject a future ${name} clock before the host callback`, () => {
    const s = feedbackScenario();
    const original = s.input.discussionFeedbackOriginals[0];
    for (const source of [s.source, original]) {
      change(source.metadata.descriptor);
      source.metadata.fingerprint = discussionFeedbackFingerprint(source.metadata.descriptor);
      source.sourceRevision = discussionFeedbackRevision(source.metadata);
      // All descriptors and fingerprints are internally consistent. Only the
      // claimed observation time is earlier than the native content clock.
      assert.throws(() => parseDiscussionFeedbackSource(source), /feedback_contract/);
    }
    s.source.observedAt = "2026-10-15T09:00:00.000Z";
    parseDiscussionFeedbackSource(s.source);
    for (const fact of s.input.facts) fact.observedAt = s.source.observedAt;
    for (const proof of s.input.evidence) {
      proof.sourceRevision = discussionFeedbackPublicRevision(s.source.metadata);
      proof.evidenceMetadata.observedAt = s.source.observedAt;
    }
    const reviewed = JSON.parse(s.request.detail);
    reviewed.sourceRevision = original.sourceRevision;
    reviewed.descriptorFingerprint = original.metadata.fingerprint;
    s.request.detail = JSON.stringify(reviewed);
    attachFeedbackIntake(s.request);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /feedback/,
    );
    assert.equal(calls, 0);
  });

for (const duplicate of [
  '"actorId":"101",',
  '"actorId":"202",',
  '"\\u0061ctorId":"101",',
  '"sourceRevision":"invalid",',
])
  test(`protected feedback JSON rejects duplicate decoded keys ${duplicate} before admission`, () => {
    const s = feedbackScenario();
    s.request.detail = "{" + duplicate + s.request.detail.slice(1);
    attachFeedbackIntake(s.request);
    let calls = 0;
    assert.throws(() => parseAcceptedFeedbackThreadText(s.request.detail), /feedback_contract/);
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /feedback/,
    );
    assert.equal(calls, 0);
  });
test("protected feedback JSON accepts ordinary whitespace and rejects nested, trailing, excessive and malformed values", () => {
  const s = feedbackScenario(),
    ordinary = JSON.parse(s.request.detail);
  assert.deepEqual(parseAcceptedFeedbackThreadText(" \n" + JSON.stringify(ordinary, null, 1) + "\t"), ordinary);
  for (const detail of [
    s.request.detail + "{}",
    s.request.detail.slice(0, -1) + ",}",
    s.request.detail.replace('"actorId":"101"', '"actorId":{"value":"101"}'),
    s.request.detail.replace('"actorId":"101"', '"actorId":null'),
    s.request.detail.replace('"repositoryId":2', '"repositoryId":02'),
    s.request.detail.replace('"repositoryId":2', '"repositoryId":1e999'),
    s.request.detail.replace('"actorId":"101"', '"actorId":"101\\n"'),
    " ".repeat(2001),
  ])
    assert.throws(() => parseAcceptedFeedbackThreadText(detail), /feedback_contract/);
});
test("self-review, an unenrolled reviewer, a duplicated audit and an ambiguous source target cannot earn feedback", () => {
  for (const change of [
    (s) => {
      s.decision.actor = "101";
    },
    (s) => {
      s.binding.reviewerIds = ["999"];
    },
    (s) => {
      s.state.audit.push(structuredClone(s.decision));
    },
    (s) => {
      s.input.facts.push(structuredClone(s.target));
    },
  ]) {
    const s = feedbackScenario();
    change(s);
    let calls = 0;
    assert.throws(
      () =>
        run(s, (input) => {
          calls++;
          return input;
        }),
      /recognition|feedback/,
    );
    assert.equal(calls, 0);
  }
});
test("the metric uses independent acceptance windows while native facts, distinct authors and definition-only maturity remain intact", () => {
  const s = feedbackScenario();
  const answer = s.input.facts.find((fact) => fact.metricId === "discussion_answers");
  const receipt = feedbackRequest(s.source, answer, { id: "synthetic-distinct-answer-author" });
  s.state.requests[receipt.request.id] = receipt.request;
  s.state.audit.push(receipt.decision);
  const output = run(s, applyRecognitionReceipt, [s.binding, feedbackBinding("discussion_answers")]);
  assert.deepEqual(
    accepted(output)
      .map((fact) => fact.actorId)
      .sort(),
    ["101", "303"],
  );
  for (const source of s.input.facts)
    assert.deepEqual(
      output.facts.find((fact) => fact.id === source.id),
      source,
    );
  const frozen = {
    datasetId: "synthetic-feedback-metric",
    cutoff: feedbackCutoff,
    backfillRevision: "synthetic/v1",
    repositoryIds: ["2"],
    actors: output.actors,
    facts: output.facts,
    coverage: [],
  };
  const scope = {
    timezone: "UTC",
    from: "2026-10-14T00:00:00.000Z",
    to: feedbackCutoff,
    repos: [],
    projects: [],
    workstreams: [],
    roles: [],
    actors: "user",
    context: "event",
  };
  const board = aggregateMetric(frozen, s.policies[0].policy, scope);
  assert.deepEqual(board.rows.map((row) => [row.actorId, row.value]).sort(), [
    ["101", 1],
    ["303", 1],
  ]);
  assert.equal(
    board.rows.reduce((sum, row) => sum + row.evidenceIds.length, 0),
    2,
  );
  assert.equal(
    aggregateMetric(frozen, s.policies[0].policy, {
      ...scope,
      from: "2026-10-10T00:00:00.000Z",
      to: "2026-10-13T00:00:00.000Z",
    }).rows.length,
    0,
  );
  assert.equal(board.publicEnabled, false);
  assert.equal(getMetricUi("helpful_feedback").maturity, "definition_only");
});
