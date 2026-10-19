import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubReadClient,
  createGithubEvidenceNormalizer,
  githubReleaseInclusionHash,
} from "../../github/dist/index.js";
import { syntheticCheckpointStore } from "../../github/test/synthetic-client.mjs";
import {
  aggregateActivityBreadth,
  aggregateMetric,
  getMetricDefinition,
  metricRegistryV1,
  stableJSON,
} from "../dist/index.js";

// Synthetic HTTP payloads exercise the real release collector and recognition
// adapter. Protected host fixtures supply historical mappings separately; no
// live authorization or provider-derived Project history is claimed here.
const slug = "synthetic-owner/release-breadth";
const prefix = `/repos/${slug}`;
const api = "https://api.synthetic.invalid";
const mergedAt = "2026-10-07T10:00:00.000Z";
const observedAt = "2026-10-10T10:00:00.000Z";
const acceptedAt = "2026-10-11T10:00:00.000Z";
const cutoff = "2026-10-19T12:00:00.000Z";
const merge = "b".repeat(40);
const head = "c".repeat(40);
const releaseTimes = ["2026-10-08T10:00:00.000Z", "2026-10-09T10:00:00.000Z"];
const mapping = (workstreams) => ({
  projects: ["PVT_synthetic_release"],
  workstreams,
  workstreamsKnown: true,
  projectScope: ["PVT_synthetic_release"],
  workstreamScope: ["engineering", "research"],
});
const lifetime = {
  timezone: "UTC",
  from: null,
  to: cutoff,
  repos: [],
  projects: [],
  workstreams: [],
  roles: [],
  actors: "user",
  context: "event",
};
const finite = { ...lifetime, from: "2026-10-01T00:00:00.000Z" };
const sourcePolicy = {
  metricId: "release_changes",
  version: "synthetic-release-breadth/v1",
  definitionVersion: metricRegistryV1.policy_version,
  unit: getMetricDefinition("release_changes").definition.unit,
  aggregation: "count",
  dateBasis: "occurredAt",
  rankedStates: ["qualified"],
  roles: ["author"],
  groupBy: "canonical",
  groupingPolicyVersion: "release-inclusion-units/v1",
  sources: ["github_rest"],
  minimumSamples: 1,
  rank: false,
};
const breadthPolicy = {
  version: "synthetic-release-breadth/v1",
  definitionVersion: metricRegistryV1.policy_version,
  sourcePolicies: [sourcePolicy],
};

async function collectRelease(releaseId, publishedAt) {
  const tag = `v${releaseId}`;
  const repository = {
    id: 2,
    node_id: "R_synthetic_breadth",
    full_name: slug,
    private: false,
    visibility: "public",
    url: `${api}${prefix}`,
    default_branch: "main",
  };
  const pull = {
    id: 10,
    node_id: "PR_synthetic_breadth_10",
    number: 10,
    url: `${api}${prefix}/pulls/10`,
    html_url: `https://github.com/${slug}/pull/10`,
    created_at: mergedAt,
    updated_at: observedAt,
    state: "closed",
    merged: true,
    draft: false,
    merged_at: mergedAt,
    merge_commit_sha: merge,
    base: { ref: "main", repo: repository },
    user: { id: 101, node_id: "U_synthetic_author", type: "User", login: "synthetic-author" },
  };
  const responses = new Map([
    [prefix, repository],
    [
      `${prefix}/releases/${releaseId}`,
      {
        id: releaseId,
        node_id: `RE_synthetic_${releaseId}`,
        url: `${api}${prefix}/releases/${releaseId}`,
        immutable: true,
        draft: false,
        prerelease: false,
        published_at: publishedAt,
        tag_name: tag,
      },
    ],
    [`${prefix}/pulls/10`, pull],
    [
      `${prefix}/git/ref/tags/${tag}`,
      {
        ref: `refs/tags/${tag}`,
        node_id: `REF_synthetic_${releaseId}`,
        url: `${api}${prefix}/git/refs/tags/${tag}`,
        object: { type: "commit", sha: head, url: `${api}${prefix}/git/commits/${head}` },
      },
    ],
    [
      `${prefix}/compare/${merge}...${head}?per_page=1&page=1`,
      {
        url: `${api}${prefix}/compare/${merge}...${head}`,
        base_commit: { sha: merge },
        merge_base_commit: { sha: merge },
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
      },
    ],
  ]);
  const calls = [];
  const client = new GithubReadClient({
    apiOrigin: api,
    token: async () => "synthetic-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value) => {
      const url = new URL(value);
      const path = url.pathname + url.search;
      calls.push(path);
      assert.ok(responses.has(path), path);
      return new Response(JSON.stringify(responses.get(path)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const normalize = createGithubEvidenceNormalizer({
    client,
    now: () => observedAt,
    source: "synthetic-release-installation",
    allowedRepositoryIds: [2],
    assertAuthorized: () => {},
    releaseInclusionTargets: [{ repositoryId: 2, releaseId, pullRequestNumber: 10 }],
    authorizedReviewerIds: ["303"],
    enrich: async () => ({
      repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
      proof: { verified: true, source: "github_rest", revision: observedAt },
      family: "pull_request",
      action: "closed",
      occurredAt: mergedAt,
      observedAt,
      payload: { repository, pull_request: pull },
    }),
    acceptance: async (_input, normalized) => {
      assert.deepEqual(calls, [...responses.keys()]);
      assert.equal(normalized.releaseInclusions.length, 1);
      const record = normalized.releaseInclusions[0];
      const target = normalized.facts.find((fact) => fact.metricId === "pr_merged");
      assert.equal(target.state, "observed");
      return [
        {
          id: `synthetic-release-acceptance-${releaseId}`,
          verified: true,
          targetFactId: target.id,
          actorId: target.actorId,
          reviewerId: "303",
          acceptedAt,
          decision: "accepted",
          metricId: "release_changes",
          evidenceIds: [target.id],
          releaseInclusion: {
            targetFactId: target.id,
            releaseId,
            pullRequestNumber: 10,
            proofHash: githubReleaseInclusionHash(record),
            policyVersion: "synthetic-release-policy-v1",
          },
        },
      ];
    },
  });
  const output = await normalize({
    repository: { id: 2, slug },
    family: "pull_requests",
    observedAt,
    policyVersion: "synthetic-release-policy-v1",
    factKey: "synthetic-release-pr",
    fact: {
      subjectId: pull.node_id,
      sourceUrl: pull.html_url,
      sourceRevision: observedAt,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "closed",
    },
  });
  const facts = output.facts.filter((fact) => fact.metricId === "release_changes");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].occurredAt, publishedAt);
  assert.equal(facts[0].state, "qualified");
  assert.equal(facts[0].actorId, "101");
  assert.equal(facts[0].releaseInclusion.releaseId, releaseId);
  assert.equal(facts[0].releaseInclusion.proofHash, githubReleaseInclusionHash(output.releaseInclusions[0]));
  assert.ok(output.facts.some((fact) => fact.metricId === "pr_merged" && fact.state === "observed"));
  return { actors: output.actors, fact: facts[0] };
}

async function frozen(contexts = [mapping(["engineering"]), mapping(["research"])]) {
  const outputs = await Promise.all(releaseTimes.map((at, index) => collectRelease(700 + index, at)));
  return {
    datasetId: "synthetic-release-breadth",
    cutoff,
    backfillRevision: "synthetic-release-breadth/v1",
    repositoryIds: ["2"],
    actors: [...new Map(outputs.flatMap((out) => out.actors).map((actor) => [actor.id, actor])).values()],
    // This private caller supplies explicit release-time mapping fixtures after
    // collection. Source identities, receipts and membership proof stay exact.
    facts: outputs.map((out, index) => ({ ...out.fact, eventContext: contexts[index] })),
    coverage: [],
  };
}
const calculate = (input, scope = lifetime) => aggregateActivityBreadth(input, breadthPolicy, scope, []);

test("lifetime breadth retains release-time workstreams while release totals conserve PR work", async () => {
  const input = await frozen();
  const before = stableJSON(input);
  assert.equal(new Set(input.facts.map((fact) => fact.id)).size, 2);
  assert.equal(new Set(input.facts.map((fact) => fact.artifactId)).size, 1);
  assert.equal(aggregateMetric(input, sourcePolicy, lifetime).rows[0].value, 1);
  assert.equal(aggregateMetric(input, sourcePolicy, finite).rows[0].value, 2);
  assert.equal(calculate(input, finite).workstreams.rows[0].value, 2);

  const result = calculate(input);
  assert.equal(result.workstreams.rows[0].value, 2);
  assert.equal(result.workstreams.rows[0].state, "partial");
  assert.deepEqual(
    result.workstreams.rows[0].units.map((unit) => unit.id),
    ["engineering", "research"],
  );
  assert.deepEqual(result.workstreams.rows[0].unknownEvidenceIds, []);
  assert.equal(result.repositories.rows[0].value, 1);
  assert.deepEqual(result.repositories.rows[0].evidenceIds, input.facts.map((fact) => fact.id).sort());
  assert.equal(result.repositories.rows[0].units[0].evidenceIds.length, 2);
  assert.equal(result.repositories.publicEnabled, false);
  assert.equal(result.workstreams.rows[0].rank, null);
  assert.equal(result.workstreams.coverage, "incomplete");
  assert.deepEqual(calculate({ ...input, facts: [...input.facts].reverse() }), result);
  assert.equal(stableJSON(input), before);
});

test("release breadth retains a later unknown mapping and respects the release event window", async () => {
  const input = await frozen([mapping(["engineering"]), null]);
  const result = calculate(input);
  assert.equal(result.workstreams.rows[0].value, 1);
  assert.deepEqual(result.workstreams.rows[0].unknownEvidenceIds, [input.facts[1].id]);
  assert.deepEqual(result.repositories.rows[0].evidenceIds, input.facts.map((fact) => fact.id).sort());
  const later = calculate(input, { ...finite, from: releaseTimes[1] });
  assert.equal(later.workstreams.rows[0].value, null);
  assert.equal(later.workstreams.rows[0].state, "unknown");
  assert.deepEqual(later.workstreams.rows[0].unknownEvidenceIds, [input.facts[1].id]);
  assert.deepEqual(later.repositories.rows[0].evidenceIds, [input.facts[1].id]);
});

test("release breadth still rejects missing membership and self-accepted source units", async () => {
  const original = await frozen();
  // Deliberately invalid frozen engine inputs exercise admission after the real
  // collector/recognition fixture; they are not alleged provider observations.
  for (const [reason, change] of [
    [
      "release_inclusion_unverified",
      (fact) => {
        delete fact.releaseInclusion;
      },
    ],
    [
      "missing_independent_acceptance",
      (fact) => {
        fact.acceptedBy = fact.actorId;
      },
    ],
  ]) {
    const input = structuredClone(original);
    change(input.facts[1]);
    const result = calculate(input);
    assert.equal(result.workstreams.rows[0].value, 1);
    assert.deepEqual(
      result.workstreams.rows[0].units.map((unit) => unit.id),
      ["engineering"],
    );
    assert.deepEqual(result.repositories.rows[0].evidenceIds, [input.facts[0].id]);
    assert.ok(
      result.workstreams.audit.some((entry) => entry.reason === reason && entry.factIds.includes(input.facts[1].id)),
    );
  }
});
