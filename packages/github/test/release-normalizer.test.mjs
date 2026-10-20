import assert from "node:assert/strict";
import test from "node:test";
import { GithubReadClient, createGithubEvidenceNormalizer, githubReleaseInclusionHash } from "../dist/index.js";
import { syntheticCheckpointStore } from "./synthetic-client.mjs";

// Synthetic transport under the actual configured normalizer and read client.
const slug = "synthetic-owner/repository",
  prefix = `/repos/${slug}`,
  api = "https://api.synthetic.invalid";
const mergedAt = "2026-10-07T10:00:00.000Z",
  publishedAt = "2026-10-08T10:00:00.000Z";
const observedAt = "2026-10-10T10:00:00.000Z",
  merge = "b".repeat(40),
  head = "c".repeat(40);
function fixture() {
  const repository = {
    id: 2,
    node_id: "R_fixture",
    full_name: slug,
    private: false,
    visibility: "public",
    url: `${api}${prefix}`,
    default_branch: "main",
  };
  const payload = {
    id: 10,
    node_id: "PR_fixture_10",
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
    user: { id: 101, node_id: "U_fixture_author", type: "User", login: "fixture-author" },
  };
  const responses = new Map([
    [prefix, repository],
    [
      `${prefix}/releases/700`,
      {
        id: 700,
        node_id: "RE_fixture_700",
        url: `${api}${prefix}/releases/700`,
        immutable: true,
        draft: false,
        prerelease: false,
        published_at: publishedAt,
        tag_name: "v1",
      },
    ],
    [`${prefix}/pulls/10`, payload],
    [
      `${prefix}/git/ref/tags/v1`,
      {
        ref: "refs/tags/v1",
        node_id: "REF_fixture",
        url: `${api}${prefix}/git/refs/tags/v1`,
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
  const state = { calls: [], authorized: true, acceptanceCalls: 0, onRead: () => {} };
  const client = new GithubReadClient({
    apiOrigin: api,
    token: async () => "fixture-token",
    checkpoints: syntheticCheckpointStore(),
    maxRetries: 0,
    fetch: async (value) => {
      const url = new URL(value),
        path = url.pathname + url.search;
      state.calls.push(path);
      state.onRead(path);
      assert.ok(responses.has(path), path);
      return new Response(JSON.stringify(responses.get(path)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const options = {
    client,
    source: "fixture-installation",
    allowedRepositoryIds: [2],
    assertAuthorized: () => {
      if (!state.authorized) throw new Error("fixture-revoked");
    },
    releaseInclusionTargets: [{ repositoryId: 2, releaseId: 700, pullRequestNumber: 10 }],
    enrich: async () => ({
      repository: { id: 2, slug, visibility: "public", defaultBranch: "main" },
      proof: { verified: true, source: "github_rest", revision: observedAt },
      family: "pull_request",
      action: "closed",
      occurredAt: mergedAt,
      observedAt,
      payload: { repository, pull_request: payload },
    }),
  };
  const input = {
    repository: { id: 2, slug },
    family: "pull_requests",
    observedAt,
    policyVersion: "fixture-policy-v1",
    factKey: "fixture-fact-key",
    fact: {
      subjectId: payload.node_id,
      sourceUrl: payload.html_url,
      sourceRevision: observedAt,
      evidence: "current_state",
      actorId: null,
      occurredAt: null,
      state: "closed",
    },
  };
  return { options, input, state, responses };
}

test("release normalizer collects exact configured ancestry before a protected acceptance callback", async () => {
  const s = fixture();
  s.options.authorizedReviewerIds = ["303"];
  s.options.acceptance = async (_input, normalized) => {
    s.state.acceptanceCalls += 1;
    assert.equal(normalized.releaseInclusions.length, 1);
    assert.equal(s.state.calls.length, 5);
    const record = normalized.releaseInclusions[0],
      target = normalized.facts.find((fact) => fact.metricId === "pr_merged");
    return [
      {
        id: "fixture-acceptance",
        verified: true,
        targetFactId: target.id,
        actorId: target.actorId,
        reviewerId: "303",
        acceptedAt: observedAt,
        decision: "accepted",
        metricId: "release_changes",
        evidenceIds: [target.id],
        releaseInclusion: {
          targetFactId: target.id,
          releaseId: 700,
          pullRequestNumber: 10,
          proofHash: githubReleaseInclusionHash(record),
          policyVersion: "fixture-policy-v1",
        },
      },
    ];
  };
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.equal(s.state.acceptanceCalls, 1);
  assert.equal(output.releaseInclusions.length, 1);
  const release = output.facts.find((fact) => fact.metricId === "release_changes");
  assert.ok(release);
  assert.equal(release.occurredAt, publishedAt);
  assert.equal(release.actorId, "101");
  assert.deepEqual(s.state.calls, [...s.responses.keys()]);
});

for (const [name, change] of [
  [
    "no selection",
    (s) => {
      s.options.releaseInclusionTargets = [];
    },
  ],
  [
    "different PR",
    (s) => {
      s.options.releaseInclusionTargets[0].pullRequestNumber = 11;
    },
  ],
  [
    "synthetic collection",
    (s) => {
      s.options.isSynthetic = true;
    },
  ],
])
  test(`release normalizer preserves raw source without release HTTP for ${name}`, async () => {
    const s = fixture();
    change(s);
    const output = await createGithubEvidenceNormalizer(s.options)(s.input);
    assert.equal(s.state.calls.length, 0);
    assert.equal(output.releaseInclusions, undefined);
    assert.ok(output.facts.some((fact) => fact.metricId === "pr_merged"));
    assert.equal(
      output.facts.some((fact) => fact.metricId === "release_changes"),
      false,
    );
  });

test("release normalizer snapshots its private target selection before collection", async () => {
  const s = fixture(),
    normalize = createGithubEvidenceNormalizer(s.options);
  s.options.releaseInclusionTargets[0].releaseId = 701;
  const output = await normalize(s.input);
  assert.equal(output.releaseInclusions[0].release.id, 700);
});

test("release normalizer refuses revoked access before any acceptance callback or later request", async () => {
  const s = fixture();
  s.state.onRead = (path) => {
    if (path.endsWith("/releases/700")) s.state.authorized = false;
  };
  s.options.acceptance = async () => {
    s.state.acceptanceCalls += 1;
    return [];
  };
  await assert.rejects(createGithubEvidenceNormalizer(s.options)(s.input));
  assert.deepEqual(s.state.calls, [prefix, `${prefix}/releases/700`]);
  assert.equal(s.state.acceptanceCalls, 0);
});

for (const [name, change] of [
  [
    "missing authorization",
    (s) => {
      delete s.options.assertAuthorized;
    },
  ],
  [
    "unapproved repository",
    (s) => {
      s.options.releaseInclusionTargets[0].repositoryId = 3;
    },
  ],
  [
    "duplicate target",
    (s) => {
      s.options.releaseInclusionTargets.push(structuredClone(s.options.releaseInclusionTargets[0]));
    },
  ],
  [
    "extra target field",
    (s) => {
      s.options.releaseInclusionTargets[0].notes = "untrusted";
    },
  ],
  [
    "fractional release",
    (s) => {
      s.options.releaseInclusionTargets[0].releaseId = 700.5;
    },
  ],
])
  test(`release normalizer rejects ${name} before collection`, () => {
    const s = fixture();
    change(s);
    assert.throws(() => createGithubEvidenceNormalizer(s.options), /invalid_release_inclusion_targets/);
    assert.equal(s.state.calls.length, 0);
  });

for (const [name, targets] of [
  ["single sparse slot", () => new Array(1)],
  ["leading sparse slot", (target) => Object.assign(new Array(2), { 1: target })],
  ["trailing sparse slot", (target) => Object.assign(new Array(2), { 0: target })],
  ["single undefined entry", () => [undefined]],
  ["leading undefined entry", (target) => [undefined, target]],
  ["trailing undefined entry", (target) => [target, undefined]],
])
  test(`release normalizer rejects ${name} before collection`, () => {
    const s = fixture();
    s.options.releaseInclusionTargets = targets(s.options.releaseInclusionTargets[0]);
    assert.throws(() => createGithubEvidenceNormalizer(s.options), { message: "invalid_release_inclusion_targets" });
    assert.equal(s.state.calls.length, 0);
  });
