import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGithubEvidenceNormalizer, githubReviewRevision } from "../dist/index.js";
import { syntheticRepositoryClient } from "./synthetic-client.mjs";

const fixture = JSON.parse(await readFile(new URL("fixtures/engineering.json", import.meta.url), "utf8"));
const source = fixture.pull_request.html_url;
const parentApi = "https://api.github.com/repos/synthetic-owner/repository/pulls/10";
const first = "2026-10-02T10:00:00Z";
const submitted = "2026-10-07T10:00:00Z";
const observedAt = "2026-10-08T10:00:00Z";
const makeReview = (id, at = submitted, patch = {}) => ({
  id,
  node_id: `PRR_synthetic_${id}`,
  user: structuredClone(fixture.reviewer),
  state: "COMMENTED",
  commit_id: "a".repeat(40),
  submitted_at: at,
  created_at: at,
  html_url: `${source}#pullrequestreview-${id}`,
  pull_request_url: parentApi,
  _links: { html: { href: `${source}#pullrequestreview-${id}` }, pull_request: { href: parentApi } },
  body: "synthetic private body must not leave the normalizer",
  ...patch,
});
const metrics = (output, name) => output.facts.filter((fact) => fact.metricId === name);
const harness = () => {
  const review = makeReview(51);
  const state = {
    parent: { ...structuredClone(fixture.pull_request), user: structuredClone(fixture.author) },
    review,
    cohort: [makeReview(50, first), structuredClone(review)],
    scans: 0,
  };
  const input = {
    repository: { id: 2, slug: "synthetic-owner/repository" },
    family: "reviews",
    factKey: "synthetic-scoped-review",
    observedAt,
    policyVersion: "synthetic/v1",
    fact: {
      subjectId: review.node_id,
      sourceRevision: githubReviewRevision(review),
      sourceUrl: review.html_url,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "present",
    },
  };
  const client = syntheticRepositoryClient(2, {
    rest: async (_source, path) => {
      if (path === "/repos/synthetic-owner/repository/pulls/10") return structuredClone(state.parent);
      if (path === "/repos/synthetic-owner/repository/pulls/10/reviews/51") return structuredClone(state.review);
      assert.equal(path, "/repos/synthetic-owner/repository");
      return structuredClone(fixture.repository);
    },
    scanRest: async (options) => {
      state.scans += 1;
      assert.equal(options.url, "/repos/synthetic-owner/repository/pulls/10/reviews?per_page=100");
      return structuredClone(state.cohort);
    },
  });
  const normalize = createGithubEvidenceNormalizer({
    client,
    source: "synthetic",
    allowedRepositoryIds: [2],
    isSynthetic: true,
  });
  return { state, input, run: () => normalize(input) };
};

test("complete same-PR review history preserves first participation, distinct head rounds and raw feedback", async () => {
  const h = harness();
  h.state.cohort.unshift(makeReview(49, "2026-10-01T10:00:00Z", { commit_id: "b".repeat(40) }));
  h.state.cohort.push(makeReview(52, null, { state: "PENDING", user: null }));
  h.state.cohort[1].user.login = "synthetic-earlier-login";
  const before = JSON.stringify(h.state);
  const result = await h.run();
  assert.equal(metrics(result, "prs_reviewed")[0].occurredAt, "2026-10-01T10:00:00.000Z");
  assert.equal(metrics(result, "review_rounds")[0].occurredAt, "2026-10-02T10:00:00.000Z");
  for (const name of ["prs_reviewed", "review_rounds", "review_feedback"]) {
    assert.equal(metrics(result, name).length, 1);
    assert.equal(metrics(result, name)[0].artifactId, fixture.pull_request.node_id);
    assert.equal(metrics(result, name)[0].actorId, String(fixture.reviewer.id));
  }
  assert.equal(metrics(result, "first_reviews").length, 0);
  assert.ok(result.reasons.includes("review_quality_requires_independent_receipt"));
  assert.equal(JSON.stringify(result).includes(h.state.review.body), false);
  assert.equal(JSON.stringify({ ...h.state, scans: 0 }), before);
  assert.deepEqual(await h.run(), result, "same-source replay preserves every conserved fact");
});

for (const [name, change] of [
  [
    "different parent PR",
    (h) =>
      Object.assign(h.state.parent, {
        id: 999,
        node_id: "PR_synthetic_other",
        number: 999,
        html_url: source.replace("/10", "/999"),
      }),
  ],
  [
    "parent number conflicts with its URL",
    (h) => {
      h.state.parent.number = 999;
    },
  ],
  [
    "parent lacks a REST identity",
    (h) => {
      delete h.state.parent.id;
    },
  ],
  [
    "hydrated review belongs to another PR",
    (h) => {
      h.state.review.html_url = h.state.review.html_url.replace("/10#", "/999#");
    },
  ],
  [
    "hydrated review URL names another review ID",
    (h) => {
      h.state.review.html_url = `${source}#pullrequestreview-50`;
    },
  ],
  [
    "review API parent contradicts its HTML parent",
    (h) => {
      h.state.review.pull_request_url = parentApi.replace("/10", "/999");
    },
  ],
  [
    "nested parent link contradicts its HTML parent",
    (h) => {
      h.state.review._links.pull_request.href = parentApi.replace("/10", "/999");
    },
  ],
  [
    "nested review link contradicts its source",
    (h) => {
      h.state.review._links.html.href = `${source}#pullrequestreview-50`;
    },
  ],
  [
    "source has another fragment",
    (h) => {
      h.input.fact.sourceUrl += "#ignored";
    },
  ],
]) {
  test(`${name} cannot publish review credit or read a cohort`, async () => {
    const h = harness();
    change(h);
    h.input.fact.sourceRevision = githubReviewRevision(h.state.review);
    const result = await h.run();
    assert.equal(result.facts.length, 0);
    assert.equal(result.evidence.length, 0);
    assert.equal(h.state.scans, 0);
    assert.deepEqual(result.reasons, ["review_parent_or_source_identity_unverified"]);
  });
}

for (const [name, change] of [
  [
    "foreign PR source",
    (h) => {
      h.state.cohort[0].html_url = h.state.cohort[0].html_url.replace("/10#", "/999#");
    },
  ],
  [
    "review-ID source mismatch",
    (h) => {
      h.state.cohort[0].html_url = `${source}#pullrequestreview-51`;
    },
  ],
  [
    "conflicting review database identity",
    (h) => {
      h.state.cohort[0].id = 51;
      h.state.cohort[0].html_url = h.state.review.html_url;
      h.state.cohort[0]._links.html.href = h.state.review.html_url;
    },
  ],
  [
    "conflicting review node identity",
    (h) => {
      h.state.cohort[0].node_id = h.state.review.node_id;
    },
  ],
  [
    "conflicting actor node",
    (h) => {
      h.state.cohort[0].user.node_id = "U_synthetic_other";
    },
  ],
  [
    "one actor node reused by another account",
    (h) => {
      h.state.cohort[0].user.id += 1;
    },
  ],
  [
    "conflicting actor kind",
    (h) => {
      h.state.cohort[0].user.type = "Bot";
    },
  ],
  [
    "unknown earlier actor kind",
    (h) => {
      delete h.state.cohort[0].user.type;
    },
  ],
  [
    "current cohort node differs from hydrated review",
    (h) => {
      h.state.cohort[1].node_id = "PRR_synthetic_other";
    },
  ],
  [
    "current cohort actor differs from hydrated review",
    (h) => {
      h.state.cohort[1].user.node_id = "U_synthetic_other";
    },
  ],
  [
    "missing earlier review URL",
    (h) => {
      delete h.state.cohort[0].html_url;
    },
  ],
  [
    "nested malformed links",
    (h) => {
      h.state.cohort[0]._links = { html: false };
    },
  ],
]) {
  test(`${name} cannot backdate first participation or head-round credit`, async () => {
    const h = harness();
    change(h);
    const result = await h.run();
    assert.equal(metrics(result, "prs_reviewed").length, 0);
    assert.equal(metrics(result, "review_rounds").length, 0);
    assert.equal(metrics(result, "review_feedback").length, 1, "independently scoped target feedback remains raw");
    assert.equal(metrics(result, "review_feedback")[0].occurredAt, "2026-10-07T10:00:00.000Z");
    assert.ok(result.reasons.includes("first_submitted_review_milestone_unverified"));
  });
}

test("source scope and actor-node drift invalidate the collected review fingerprint", async () => {
  for (const change of [
    (review) => {
      review.html_url = review.html_url.replace("/10#", "/999#");
    },
    (review) => {
      review.pull_request_url = parentApi.replace("/10", "/999");
    },
    (review) => {
      review._links.html.href += "1";
    },
    (review) => {
      review._links.pull_request.href += "1";
    },
    (review) => {
      review.user.node_id = "U_synthetic_other";
    },
  ]) {
    const review = makeReview(51);
    const original = githubReviewRevision(review);
    change(review);
    assert.notEqual(githubReviewRevision(review), original);
  }
  const h = harness();
  h.state.review.user.node_id = "U_synthetic_other";
  h.state.cohort = [structuredClone(h.state.review)];
  const result = await h.run();
  assert.equal(result.facts.length, 0);
  assert.deepEqual(result.reasons, ["hydrated_source_revision_unverified"]);
});

test("completed cohort reuse is revalidated and exact source recovery restores the original facts", async () => {
  const h = harness();
  const original = await h.run();
  const saved = structuredClone(h.state.cohort);
  h.state.cohort[0].user.node_id = "U_synthetic_other";
  assert.equal(metrics(await h.run(), "prs_reviewed").length, 0);
  h.state.cohort = saved;
  assert.deepEqual(await h.run(), original);
});

test("malformed optional source identities cannot reuse a valid missing-field fingerprint", async () => {
  for (const [remove, invalidate] of [
    [(review) => delete review.node_id, (review) => (review.node_id = null)],
    [(review) => delete review.pull_request_url, (review) => (review.pull_request_url = null)],
    [(review) => delete review.user.node_id, (review) => (review.user.node_id = null)],
    [(review) => delete review._links, (review) => (review._links = null)],
    [(review) => delete review._links, (review) => (review._links = false)],
    [(review) => delete review._links.html, (review) => (review._links.html = null)],
    [(review) => delete review._links.pull_request, (review) => (review._links.pull_request = false)],
  ]) {
    const review = makeReview(51);
    remove(review);
    const original = githubReviewRevision(review);
    invalidate(review);
    assert.notEqual(githubReviewRevision(review), original, "present invalid values require fresh normalization");
  }

  const h = harness();
  delete h.state.review._links;
  h.input.fact.sourceRevision = githubReviewRevision(h.state.review);
  h.state.cohort[1] = structuredClone(h.state.review);
  assert.equal(metrics(await h.run(), "prs_reviewed").length, 1);
  h.state.review._links = null;
  assert.notEqual(githubReviewRevision(h.state.review), h.input.fact.sourceRevision);
  const result = await h.run();
  assert.deepEqual(result.reasons, ["review_parent_or_source_identity_unverified"]);
  assert.equal(result.facts.length, 0);
});
