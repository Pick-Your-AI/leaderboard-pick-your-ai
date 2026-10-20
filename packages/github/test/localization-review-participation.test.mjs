import assert from "node:assert/strict";
import test from "node:test";
import {
  createGithubEvidenceNormalizer,
  githubReviewRevision,
  githubSnapshotRevision,
  localizationReviewNormalizationVersion,
  normalizeGithubObservation,
} from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";
import {
  localizationReviewFixture,
  localizationReviewSlug,
  localizationReviewUrl,
} from "../../../tests/fixtures/localization-review.mjs";

const repository = { id: 2, slug: localizationReviewSlug, visibility: "public", defaultBranch: "main" };
const localeFacts = (value) => value.facts.filter((fact) => fact.metricId === "localization");
function mergedInput(fixture) {
  return {
    repository,
    proof: { verified: true, source: "github_rest", revision: fixture.parent.updated_at, isSynthetic: true },
    family: "pull_request",
    observedAt: fixture.at(0),
    payload: { pull_request: fixture.parent },
    integration: fixture.integration,
  };
}
function reviewInput(fixture, current, cohort) {
  return {
    repository,
    proof: { verified: true, source: "github_rest", revision: githubReviewRevision(current), isSynthetic: true },
    family: "review",
    observedAt: fixture.at(0),
    payload: { pull_request: fixture.parent, review: current },
    reviewParticipation: {
      verified: true,
      firstSubmittedAt: fixture.first.submitted_at,
      roundFirstSubmittedAt: fixture.first.submitted_at,
    },
    reviewSequence: { verified: true, reviews: cohort },
  };
}

function assertNativeReviewRound(output, fixture, observedAt) {
  for (const review of [fixture.first, fixture.later]) {
    assert.equal(Object.hasOwn(review, "created_at"), false);
    assert.equal(Object.hasOwn(review, "createdAt"), false);
  }
  const round = output.facts.find((fact) => fact.metricId === "review_rounds");
  assert.ok(round);
  assert.equal(round.state, "observed");
  assert.equal(round.actorId, "202");
  assert.equal(round.subjectActorId, "101");
  assert.equal(round.occurredAt, fixture.first.submitted_at);
  assert.equal(round.observedAt, observedAt);
  assert.equal(round.rawState, "submitted_head:" + fixture.head);
  const feedback = output.facts.find((fact) => fact.metricId === "review_feedback");
  assert.ok(feedback);
  assert.equal(feedback.state, "unknown", "locale enrollment does not invent a generic feedback clock");
  assert.equal(feedback.occurredAt, null);
}

test("locale review opt-in adds private merge proof without changing author participation", () => {
  const fixture = localizationReviewFixture();
  const input = mergedInput(fixture);
  const original = normalizeGithubObservation(input, fixture.policy);
  const enabled = normalizeGithubObservation(input, fixture.policy, undefined, true);
  const { localizationMergeSource, ...ordinary } = enabled;
  assert.deepEqual(ordinary, original);
  assert.equal(localizationMergeSource.schemaVersion, localizationReviewNormalizationVersion);
  assert.equal(localizationMergeSource.authorId, "101");
  assert.equal(localizationMergeSource.headRevision, fixture.head);
  assert.equal(localizationMergeSource.mergeRevision, fixture.after);
  assert.equal(localizationMergeSource.mergedAt, fixture.parent.merged_at);
  assert.deepEqual(
    localizationMergeSource.units.map((unit) => [unit.locale, unit.category]),
    [
      ["de", "documentation"],
      ["fr", "documentation"],
    ],
  );
  assert.ok(localeFacts(enabled).every((fact) => fact.role === "author" && fact.state === "observed"));
  assert.equal(enabled.localizationReviewSource, undefined);
});

test("native locale review proof identifies the reviewer and first head submission, not an acceptor", () => {
  const fixture = localizationReviewFixture();
  const cohort = [fixture.later, fixture.first];
  const input = reviewInput(fixture, fixture.first, cohort);
  const original = normalizeGithubObservation(input);
  const enabled = normalizeGithubObservation(input, fixture.policy, undefined, true);
  const { localizationReviewSource, ...ordinary } = enabled;
  assert.deepEqual(ordinary, original);
  assertNativeReviewRound(enabled, fixture, input.observedAt);
  assert.deepEqual(localizationReviewSource, {
    schemaVersion: localizationReviewNormalizationVersion,
    repositoryId: "2",
    artifactId: fixture.parent.node_id,
    publicUrl: localizationReviewUrl,
    sourceRevision: githubReviewRevision(fixture.first),
    headRevision: fixture.head,
    observedAt: fixture.at(0),
    reviewerId: "202",
    authorId: "101",
    reviewId: "51",
    reviewNodeId: fixture.first.node_id,
    submittedAt: fixture.first.submitted_at,
  });
  assert.deepEqual(localeFacts(enabled), [], "only the later pipeline join can create reviewer locale facts");
  assert.equal(JSON.stringify(enabled).includes(fixture.first.body), false);
  const later = normalizeGithubObservation(
    reviewInput(fixture, fixture.later, cohort),
    fixture.policy,
    undefined,
    true,
  );
  assert.equal(later.localizationReviewSource, undefined);
  assert.ok(later.facts.some((fact) => fact.metricId === "review_feedback"));
});

for (const [name, change] of [
  [
    "self review",
    (f) => {
      f.first.user = structuredClone(f.parent.user);
    },
  ],
  [
    "unknown native actor",
    (f) => {
      f.first.user = null;
    },
  ],
  [
    "non-user native actor",
    (f) => {
      f.first.user.type = "Bot";
    },
  ],
  [
    "stale reviewed head",
    (f) => {
      f.first.commit_id = "d".repeat(40);
    },
  ],
  [
    "stale parent head",
    (f) => {
      f.parent.head.sha = "d".repeat(40);
    },
  ],
  [
    "wrong native parent",
    (f) => {
      f.first.pull_request_url += "0";
    },
  ],
  [
    "missing first submission",
    (f, cohort) => {
      cohort.splice(0, 1);
    },
  ],
  [
    "conflicting review identity",
    (f, cohort) => {
      cohort[0] = { ...f.first, node_id: "PRR_SYNTHETIC_OTHER" };
    },
  ],
  [
    "dismissed first submission",
    (f) => {
      f.first.state = "DISMISSED";
    },
  ],
  [
    "review after observation",
    (f) => {
      f.first.submitted_at = f.at(-1);
    },
  ],
]) {
  test(`locale reviewer proof withholds ${name}`, () => {
    const fixture = localizationReviewFixture();
    const cohort = [fixture.first, fixture.later];
    change(fixture, cohort);
    const result = normalizeGithubObservation(
      reviewInput(fixture, fixture.first, cohort),
      fixture.policy,
      undefined,
      true,
    );
    assert.equal(result.localizationReviewSource, undefined);
    assert.deepEqual(localeFacts(result), []);
  });
}

test("locale reviewer proof withholds author node copied onto another reviewer", () => {
  const fixture = localizationReviewFixture();
  fixture.first.user.node_id = fixture.parent.user.node_id;
  assert.throws(
    () =>
      normalizeGithubObservation(
        reviewInput(fixture, fixture.first, [fixture.first, fixture.later]),
        fixture.policy,
        undefined,
        true,
      ),
    { message: "Conflicting observed actor database/node identity bindings" },
  );
});

test("dismissed earliest review cannot promote a later duplicate into locale participation", () => {
  const fixture = localizationReviewFixture();
  fixture.first.state = "DISMISSED";
  const result = normalizeGithubObservation(
    reviewInput(fixture, fixture.later, [fixture.later, fixture.first]),
    fixture.policy,
    undefined,
    true,
  );
  assert.equal(result.localizationReviewSource, undefined);
});

test("native stock hydration binds locale review proof to exact source revision and complete cohort", async () => {
  const fixture = localizationReviewFixture();
  const calls = [];
  const state = { cohort: [fixture.first, fixture.later], hydrated: fixture.first };
  const client = syntheticRepositoryClient(2, {
    async rest(_source, path) {
      calls.push(path);
      if (path === "/repos/" + localizationReviewSlug) {
        return { id: 2, private: false, full_name: localizationReviewSlug, default_branch: "main" };
      }
      if (path === "/repos/" + localizationReviewSlug + "/pulls/10") return structuredClone(fixture.parent);
      assert.equal(path, "/repos/" + localizationReviewSlug + "/pulls/10/reviews/51");
      return structuredClone(state.hydrated);
    },
    async scanRest({ url }) {
      calls.push(url);
      assert.equal(url, "/repos/" + localizationReviewSlug + "/pulls/10/reviews?per_page=100");
      return structuredClone(state.cohort);
    },
  });
  const options = {
    client,
    source: "synthetic-locale-native",
    allowedRepositoryIds: [2],
    isSynthetic: true,
    documentationPolicies: [fixture.policy],
    localizationReviews: true,
  };
  const normalize = createGithubEvidenceNormalizer(options);
  options.localizationReviews = false;
  const input = {
    repository: { id: 2, slug: localizationReviewSlug },
    family: "reviews",
    factKey: "synthetic-locale-first-review",
    observedAt: fixture.at(0),
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: fixture.first.node_id,
      sourceRevision: githubSnapshotRevision(githubReviewRevision(fixture.first), "synthetic-complete-scan"),
      sourceUrl: fixture.first.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  const output = await normalize(input);
  assert.equal(output.localizationReviewSource.reviewerId, "202");
  assert.equal(output.localizationReviewSource.sourceRevision, input.fact.sourceRevision);
  assert.equal(output.localizationReviewSource.reviewId, "51");
  assertNativeReviewRound(output, fixture, input.observedAt);
  assert.equal(calls.filter((path) => path.includes("reviews?")).length, 1);
  assert.deepEqual(await normalize(input), output);
  state.hydrated = { ...fixture.first, commit_id: "d".repeat(40) };
  const stale = await normalize(input);
  assert.equal(stale.localizationReviewSource, undefined);
  assert.deepEqual(localeFacts(stale), []);
});
