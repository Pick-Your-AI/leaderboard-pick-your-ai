import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createGithubEvidenceNormalizer, githubDiscussionRevision, normalizeGithubObservation } from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/engineering.json", import.meta.url), "utf8"));
const createdAt = "2026-10-07T10:00:00.000Z";
const answerCreatedAt = "2026-10-07T11:00:00.000Z";
const chosenAt = "2026-10-07T12:00:00.000Z";
const observedAt = "2026-10-07T13:00:00.000Z";
const discussion = () => ({
  id: "D_SYNTHETIC_TIME",
  url: "https://github.com/synthetic-owner/repository/discussions/4",
  createdAt,
  updatedAt: chosenAt,
  author: fixture.author,
  answerChosenAt: chosenAt,
  answerChosenBy: fixture.merger,
  answer: { id: "DC_SYNTHETIC_TIME", createdAt: answerCreatedAt, isAnswer: true, author: fixture.reviewer },
});
const normalize = (payload = discussion(), extra = {}) =>
  normalizeGithubObservation({
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public" },
    proof: { verified: true, source: "github_graphql", revision: observedAt, isSynthetic: true },
    family: "discussion",
    action: "snapshot",
    occurredAt: null,
    observedAt,
    discussionAnswerSelection: { verified: true },
    payload,
    ...extra,
  });
const answers = (output) => output.facts.filter((fact) => fact.metricId === "discussion_answers");
const observedAnswers = (output) => answers(output).filter((fact) => fact.state === "observed");

test("native Discussion selection preserves exact answer-author and selector roles with ordered source clocks", () => {
  const output = normalize();
  const [answer] = answers(output);
  assert.equal(answers(output).length, 1);
  assert.equal(answer.actorId, "303");
  assert.equal(answer.acceptedBy, "202");
  assert.equal(answer.subjectActorId, "101");
  assert.equal(answer.occurredAt, chosenAt);
  assert.equal(answer.acceptedAt, chosenAt);
  assert.equal(answer.state, "observed");
  assert.equal(output.facts.filter((fact) => fact.metricId === "helpful_feedback").length, 0);
  const proof = output.evidence.find((entry) => entry.contribution.contributionId === answer.id);
  assert.equal(proof.evidenceMetadata.activityState, "observed");
  assert.equal(proof.evidenceMetadata.acceptedAt, null);
});

test("native Discussion selection allows equal millisecond instants and preserves canonical clock output", () => {
  const payload = discussion();
  payload.createdAt = "2026-10-07T13:00:00Z";
  payload.answer.createdAt = "2026-10-07T13:00:00.0Z";
  payload.answerChosenAt = "2026-10-07T13:00:00.00Z";
  assert.equal(observedAnswers(normalize(payload))[0].occurredAt, observedAt);
});

for (const [name, mutate] of [
  [
    "selection before Discussion creation",
    (value) => {
      value.createdAt = "2026-10-07T12:00:00.001Z";
    },
  ],
  [
    "selection before answer creation",
    (value) => {
      value.answer.createdAt = "2026-10-07T12:00:00.001Z";
    },
  ],
  [
    "answer creation before Discussion creation",
    (value) => {
      value.answer.createdAt = "2026-10-07T09:59:59.999Z";
    },
  ],
  [
    "selection after its immutable source observation",
    (value) => {
      value.answerChosenAt = "2026-10-07T13:00:00.001Z";
    },
  ],
]) {
  test(`native Discussion chronology rejects ${name}`, () => {
    const payload = discussion();
    mutate(payload);
    const output = normalize(payload);
    assert.equal(answers(output).length, 0);
    assert.ok(output.reasons.includes("discussion_answer_chronology_invalid"));
    assert.equal(output.facts.find((fact) => fact.metricId === "discussions_started").actorId, "101");
  });
}

const unknownClocks = [
  undefined,
  null,
  "",
  0,
  "2026-02-30T10:00:00Z",
  "2026-10-07",
  "2026-10-07T10:00:00",
  "2026-10-07T10:00:00+00:00",
  "2026-10-07T10:00:00.0001Z",
  "2026-10-07T10:00:00Z\n",
];
for (const field of ["discussion_created", "answer_created", "answer_chosen"]) {
  test(`native Discussion ${field} cannot borrow a missing or unsupported source clock`, () => {
    for (const value of unknownClocks) {
      const payload = discussion();
      if (field === "discussion_created") payload.createdAt = value;
      else if (field === "answer_created") payload.answer.createdAt = value;
      else payload.answerChosenAt = value;
      const output = normalize(payload);
      assert.equal(observedAnswers(output).length, 0, `${field}: ${JSON.stringify(value)}`);
      assert.ok(output.reasons.includes("discussion_answer_time_unverified"));
    }
  });
}

test("native Discussion unknown answer author never gives credit to the known selector", () => {
  const payload = discussion();
  payload.answer.author = null;
  const output = normalize(payload);
  assert.equal(observedAnswers(output).length, 0);
  assert.equal(answers(output)[0].actorId, null);
  assert.equal(answers(output)[0].acceptedBy, "202");
  assert.equal(answers(output)[0].state, "unknown");
});

test("native Discussion unknown selector remains unknown without replacing the answer author", () => {
  const payload = discussion();
  payload.answerChosenBy = null;
  const [answer] = observedAnswers(normalize(payload));
  assert.equal(answer.actorId, "303");
  assert.equal(answer.acceptedBy, null);
});

test("native Discussion chronology does not manufacture selection, answer, or helpfulness evidence", () => {
  const payload = discussion();
  assert.equal(answers(normalize(payload, { discussionAnswerSelection: undefined })).length, 0);
  assert.equal(answers(normalize({ ...payload, answer: null })).length, 0);
  assert.equal(answers(normalize({ ...payload, answer: { ...payload.answer, isAnswer: false } })).length, 0);
});

test("Discussion revision binds the exact supplied answer-creation field independently of updatedAt", () => {
  const payload = discussion();
  const original = githubDiscussionRevision(payload);
  for (const created of [undefined, null, "2026-10-07T11:00:00.001Z", "2026-10-07T11:00:00Z"]) {
    assert.notEqual(
      original,
      githubDiscussionRevision({ ...payload, answer: { ...payload.answer, createdAt: created } }),
    );
  }
  assert.equal(original, githubDiscussionRevision(structuredClone(payload)));
});

function hydration() {
  let payload = discussion();
  const queries = [];
  const normalize = createGithubEvidenceNormalizer({
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    client: syntheticRepositoryClient(2, {
      rest: async () => fixture.repository,
      graphql: async (_source, query) => {
        queries.push(query);
        return { repository: { databaseId: 2, isPrivate: false, hasDiscussionsEnabled: true, discussion: payload } };
      },
    }),
  });
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "discussions",
    factKey: "synthetic-discussion-time",
    selectedCurrentState: true,
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: payload.id,
      sourceRevision: githubDiscussionRevision(payload),
      sourceUrl: payload.url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  return {
    input,
    queries,
    normalize,
    set: (value) => {
      payload = value;
    },
  };
}

test("Discussion hydration requests answer creation and preserves a valid selected answer", async () => {
  const h = hydration();
  assert.equal(observedAnswers(await h.normalize(h.input)).length, 1);
  assert.match(h.queries[0], /answer\s*\{[^}]*\bcreatedAt\b/);
});

test("Discussion hydration refuses a changed answer-creation field at an unchanged parent revision clock", async () => {
  const h = hydration();
  const payload = discussion();
  payload.answer.createdAt = "2026-10-07T11:00:00.001Z";
  h.set(payload);
  const output = await h.normalize(h.input);
  assert.equal(output.facts.length, 0);
  assert.ok(output.reasons.includes("hydrated_source_revision_unverified"));
});

test("Discussion hydration binds native selection to the original collection observation cutoff", async () => {
  const h = hydration();
  const output = await h.normalize({ ...h.input, observedAt: "2026-10-07T11:59:59.999Z" });
  assert.equal(answers(output).length, 0);
  assert.ok(output.reasons.includes("discussion_answer_chronology_invalid"));
});
