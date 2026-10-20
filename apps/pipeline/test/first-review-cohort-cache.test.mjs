import assert from "node:assert/strict";
import test from "node:test";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
import { ago, components, harness } from "./harness.mjs";

const slug = "synthetic-org/synthetic-repo";
const parentUrl = `https://github.com/${slug}/pull/10`;
const parentApi = `https://api.github.com/repos/${slug}/pulls/10`;
const actor = (id) => ({ id, node_id: `U_SYNTHETIC_${id}`, login: `synthetic-${id}`, type: "User" });
const makeReview = (id, who, submittedAt) => ({
  id,
  node_id: `PRR_SYNTHETIC_${id}`,
  html_url: `${parentUrl}#pullrequestreview-${id}`,
  pull_request_url: parentApi,
  _links: {
    html: { href: `${parentUrl}#pullrequestreview-${id}` },
    pull_request: { href: parentApi },
  },
  user: actor(who),
  state: "COMMENTED",
  submitted_at: submittedAt,
  created_at: submittedAt,
  commit_id: "a".repeat(40),
  body: "Synthetic feedback body, never public evidence",
});

async function sequenceHarness(t, sourceKind) {
  const parent = {
    id: 10,
    node_id: "PR_SYNTHETIC_10",
    number: 10,
    html_url: parentUrl,
    user: actor(101),
    created_at: ago(4),
    updated_at: ago(1),
    state: "open",
    head: { sha: "a".repeat(40) },
  };
  const later = makeReview(51, 303, ago(2));
  const earlier = makeReview(50, 202, ago(3));
  const state = { reviews: [later], hydrations: new Map(), firstRun: null };
  const repository = { id: 2, installationId: 1, slug, families: ["reviews"] };
  const githubClient = syntheticRepositoryClient(2, {
    rest: async (_source, path) => {
      if (path === `/repos/${slug}`) return { id: 2, private: false, full_name: slug, default_branch: "main" };
      if (path === `/repos/${slug}/pulls/10`) return structuredClone(parent);
      const review = state.reviews.find((entry) => path === `/repos/${slug}/pulls/10/reviews/${entry.id}`);
      assert.ok(review, path);
      state.hydrations.set(review.id, (state.hydrations.get(review.id) ?? 0) + 1);
      return structuredClone(review);
    },
    scanRest: async ({ url }) => {
      if (url.startsWith(`/repos/${slug}/pulls?`)) return [structuredClone(parent)];
      assert.equal(url, `/repos/${slug}/pulls/10/reviews?per_page=100`);
      return structuredClone(state.reviews);
    },
  });
  const source =
    sourceKind === "native"
      ? createGithubCollectionSource({
          client: githubClient,
          sourceId: "installation:1",
          repositories: [repository],
          isSynthetic: true,
        })
      : {
          async readPage(request) {
            state.firstRun ??= request.runId;
            return {
              repositoryId: 2,
              visibility: "public",
              isSynthetic: true,
              nextCursor: null,
              expectedCount: state.reviews.length,
              facts: state.reviews.map((review) => ({
                subjectId: review.node_id,
                sourceRevision:
                  sourceKind === "stable"
                    ? components.github.githubReviewRevision(review)
                    : components.github.githubSnapshotRevision(
                        components.github.githubReviewRevision(review),
                        sourceKind === "reused"
                          ? state.firstRun
                          : sourceKind === "mismatched"
                            ? "synthetic-unrelated-scan"
                            : request.runId,
                      ),
                sourceUrl: review.html_url,
                evidence: "current_state",
                actorId: null,
                occurredAt: null,
                state: "present",
              })),
            };
          },
        };
  const h = await harness(t, {
    githubClient,
    source,
    configure(config) {
      config.repositories[0].families = ["reviews"];
      const base = config.policies[0].policy;
      config.policies = ["first_reviews", "prs_reviewed", "review_rounds", "review_feedback"].map((metricId) => {
        const policy = {
          ...base,
          metricId,
          unit: components.metrics.getMetricDefinition(metricId).definition.unit,
          roles: ["reviewer"],
          groupBy: ["first_reviews", "review_rounds"].includes(metricId) ? "canonical" : "actor_artifact",
          rank: false,
        };
        return {
          policy,
          signature: components.metrics.stableJSON(policy),
          approvalReceipt: "synthetic-sequence-policy",
        };
      });
    },
  });
  return { ...h, state, later, earlier };
}

async function positives(runtime, snapshotId = null, metric = "first_reviews") {
  const response = await runtime.app.inject(
    `/api/v1/boards?metric=${metric}${snapshotId ? `&snapshot=${snapshotId}` : ""}`,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response
    .json()
    .rows.filter((row) => row.result.value > 0)
    .map((row) => [row.actorId, row.result.value])
    .sort();
}

async function assertProjectedSequence(h, publication, expected) {
  assert.deepEqual(
    await positives(h.runtime, publication.snapshotId),
    expected.map((id) => [id, 1]),
  );
  const saved = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  for (const name of ["evidence", "portfolioEvidence", "pendingEvidence"])
    assert.deepEqual(
      [
        ...new Set(
          saved[name]
            .filter((entry) => entry.contribution.metricIds.includes("first_reviews"))
            .map((entry) => entry.contribution.actorId),
        ),
      ].sort(),
      name === "pendingEvidence" ? [] : expected,
      name,
    );
  const frozen = (
    await h.db.query("SELECT document FROM leaderboard_pipeline.frozen_inputs WHERE snapshot_id=$1", [
      publication.snapshotId,
    ])
  ).rows[0].document;
  assert.deepEqual(
    [
      ...new Set(frozen.frozen.facts.filter((fact) => fact.metricId === "first_reviews").map((fact) => fact.actorId)),
    ].sort(),
    expected,
  );
  for (const id of ["202", "303"])
    if (saved.actors.some((actor) => actor.actorId === id)) {
      const profile = await h.runtime.app.inject(
        `/api/v1/contributors/${id}?metric=first_reviews&snapshot=${publication.snapshotId}`,
      );
      assert.equal(profile.statusCode, 200, profile.body);
      assert.equal(profile.json().timeline.length, expected.includes(id) ? 1 : 0);
      assert.equal(profile.json().evidenceCount, expected.includes(id) ? 1 : 0);
    }
}

for (const sourceKind of ["native", "custom"])
  test(`${sourceKind} scan-bound first-review publications handle earlier and later arrivals without rewriting original authority`, async (t) => {
    const h = await sequenceHarness(t, sourceKind);
    const first = (await h.runtime.runOnce()).publications[0];
    await assertProjectedSequence(h, first, ["303"]);
    const original = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
    const originalSnapshot = (
      await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [first.snapshotId])
    ).rows;
    const initialLaterReads = h.state.hydrations.get(51);
    const originalRevision = components.github.githubReviewRevision(h.later);
    h.state.reviews = [h.earlier, h.later];
    const next = (await h.runtime.runOnce()).publications[0];
    assert.notEqual(next.snapshotId, first.snapshotId);
    assert.equal(components.github.githubReviewRevision(h.later), originalRevision);
    await assertProjectedSequence(h, next, ["202"]);
    await assertProjectedSequence(h, first, ["303"]);
    assert.ok(
      h.state.hydrations.get(51) > initialLaterReads,
      "sequence depends on the cohort, not only the individual review",
    );
    // This newly submitted review is after the original source observation.
    // A fresh scan supplies a fresh observedAt; it must not invalidate the
    // legitimate earlier first merely by reusing the old observation cutoff.
    h.state.reviews.push(makeReview(52, 404, new Date().toISOString()));
    const third = (await h.runtime.runOnce()).publications[0];
    await assertProjectedSequence(h, third, ["202"]);
    await assertProjectedSequence(h, first, ["303"]);
    const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
    for (const row of original)
      assert.deepEqual(
        retained.find((entry) => entry.fact_key === row.fact_key && entry.policy_signature === row.policy_signature),
        row,
      );
    assert.deepEqual(
      (await h.db.query("SELECT * FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [first.snapshotId])).rows,
      originalSnapshot,
    );
  });

for (const sourceKind of ["stable", "mismatched", "reused"])
  test(`${sourceKind} review revisions cannot project unbound first credit or badges while ordinary review evidence remains available`, async (t) => {
    const h = await sequenceHarness(t, sourceKind);
    const first = (await h.runtime.runOnce()).publications[0];
    await assertProjectedSequence(h, first, sourceKind === "reused" ? ["303"] : []);
    for (const metric of ["prs_reviewed", "review_rounds", "review_feedback"])
      assert.deepEqual(await positives(h.runtime, null, metric), [["303", 1]]);
    const original = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
    h.state.reviews = [h.earlier, h.later];
    const next = (await h.runtime.runOnce()).publications[0];
    await assertProjectedSequence(h, next, []);
    await assertProjectedSequence(h, first, sourceKind === "reused" ? ["303"] : []);
    for (const metric of ["prs_reviewed", "review_rounds", "review_feedback"])
      assert.deepEqual(await positives(h.runtime, null, metric), [
        ["202", 1],
        ["303", 1],
      ]);
    const retained = (await h.db.query("SELECT * FROM leaderboard_pipeline.normalizations ORDER BY fact_key")).rows;
    for (const row of original)
      assert.deepEqual(
        retained.find((entry) => entry.fact_key === row.fact_key && entry.policy_signature === row.policy_signature),
        row,
      );
  });
