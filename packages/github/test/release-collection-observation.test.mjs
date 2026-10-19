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
    user: {
      id: 101,
      node_id: "U_fixture_author",
      type: "User",
      login: "fixture-author",
    },
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
        object: {
          type: "commit",
          sha: head,
          url: `${api}${prefix}/git/commits/${head}`,
        },
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
  const state = {
    calls: [],
    authorized: true,
    acceptanceCalls: 0,
    onRead: () => {},
  };
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

const priorObservation = "2026-10-07T11:00:00.000Z";
const actualCollection = "2026-10-10T10:00:00.000Z";

function retainedSource({ observed = priorObservation, selected = true } = {}) {
  const s = fixture();
  delete s.options.enrich;
  // The stock hydrator sees one unchanged PR revision in every paired control.
  s.responses.get(`${prefix}/pulls/10`).updated_at = priorObservation;
  s.input.fact.sourceRevision = priorObservation;
  s.input.observedAt = observed;
  s.options.now = () => actualCollection;
  if (!selected) s.options.releaseInclusionTargets = [];
  s.options.authorizedReviewerIds = ["303"];
  s.options.acceptance = async (_input, normalized) => {
    s.state.acceptanceCalls += 1;
    if (!selected) return [];
    const target = normalized.facts.find((fact) => fact.metricId === "pr_merged");
    assert.ok(target, "the unchanged merged PR remains a real normalized source");
    const proof = normalized.releaseInclusions[0];
    return [
      {
        id: "fixture-later-release-acceptance",
        verified: true,
        targetFactId: target.id,
        actorId: target.actorId,
        reviewerId: "303",
        acceptedAt: actualCollection,
        decision: "accepted",
        metricId: "release_changes",
        evidenceIds: [target.id],
        releaseInclusion: {
          targetFactId: target.id,
          releaseId: 700,
          pullRequestNumber: 10,
          proofHash: githubReleaseInclusionHash(proof),
          policyVersion: "fixture-policy-v1",
        },
      },
    ];
  };
  return s;
}

async function inspect(s, expectsRelease) {
  const prior = structuredClone(s.input);
  try {
    const output = await createGithubEvidenceNormalizer(s.options)(s.input);
    const nativeSource = output.facts.filter((fact) => fact.metricId === "pr_merged");
    const release = output.facts.filter((fact) => fact.metricId === "release_changes");
    assert.equal(release.length, expectsRelease ? 1 : 0);
    assert.equal(nativeSource.length, 1);
    assert.equal(nativeSource[0].observedAt, prior.observedAt);
    if (expectsRelease) {
      assert.equal(release[0].occurredAt, publishedAt);
      assert.equal(release[0].acceptedAt, actualCollection);
      assert.equal(output.releaseInclusions[0].observedAt, actualCollection);
    }
    return output;
  } finally {
    assert.deepEqual(s.input, prior, "collection must never overwrite or backdate the retained PR observation");
  }
}

test("release collection clock control: an original later-observed source receives the published inclusion", async () => {
  await inspect(retainedSource({ observed: actualCollection }), true);
});

test("release collection clock control: an older unchanged PR remains normalizable without release selection", async () => {
  await inspect(retainedSource({ selected: false }), false);
});

test("release collection clock regression: selecting a later release for an already retained PR must qualify", async () => {
  await inspect(retainedSource(), true);
});

test("release collection clock paired control: the same PR revision and release qualify with the later observation", async () => {
  const output = await inspect(retainedSource({ observed: actualCollection }), true);
  assert.equal(
    output.evidence.find((entry) => entry.contribution.metricIds.includes("pr_merged")).sourceRevision,
    priorObservation,
  );
});

test("release collection clock: records the completed lookup without changing the retained PR clock", async () => {
  const s = retainedSource();
  const completedAt = "2026-10-10T10:00:01.000Z";
  const clockReads = [];
  s.options.now = () => {
    clockReads.push([...s.state.calls]);
    return clockReads.length === 1 ? actualCollection : completedAt;
  };
  const original = structuredClone(s.input);
  const output = await createGithubEvidenceNormalizer(s.options)(s.input);
  assert.equal(clockReads.length, 2);
  assert.equal(
    clockReads[0].some((path) => path.includes("/releases/")),
    false,
  );
  assert.equal(clockReads[1].at(-1), `${prefix}/compare/${merge}...${head}?per_page=1&page=1`);
  assert.equal(output.releaseInclusions[0].observedAt, completedAt);
  assert.equal(output.facts.find((fact) => fact.metricId === "release_changes").observedAt, completedAt);
  assert.equal(output.facts.find((fact) => fact.metricId === "pr_merged").observedAt, priorObservation);
  assert.equal(s.state.acceptanceCalls, 1);
  assert.deepEqual(s.input, original);
});

for (const [name, clock] of [
  ["non-function", 1],
  ["invalid start", () => "not-an-instant"],
  [
    "invalid completion",
    (() => {
      let reads = 0;
      return () => (++reads === 1 ? actualCollection : "invalid");
    })(),
  ],
  [
    "backward completion",
    (() => {
      let reads = 0;
      return () => (++reads === 1 ? actualCollection : "2026-10-10T09:59:59.999Z");
    })(),
  ],
]) {
  test(`release collection clock: ${name} cannot yield an accepted proof`, async () => {
    const s = retainedSource();
    s.options.now = clock;
    const original = structuredClone(s.input);
    await assert.rejects(
      createGithubEvidenceNormalizer(s.options)(s.input),
      /release_inclusion_observation_clock_invalid/,
    );
    assert.equal(s.state.acceptanceCalls, 0);
    assert.deepEqual(s.input, original);
    if (name === "non-function" || name === "invalid start")
      assert.equal(
        s.state.calls.some((path) => path.includes("/releases/")),
        false,
      );
    else assert.equal(s.state.calls.at(-1), `${prefix}/compare/${merge}...${head}?per_page=1&page=1`);
  });
}

test("release collection clock: revocation in the completion callback is rechecked before acceptance", async () => {
  const s = retainedSource();
  let reads = 0;
  s.options.now = () => {
    if (++reads === 2) s.state.authorized = false;
    return actualCollection;
  };
  const original = structuredClone(s.input);
  await assert.rejects(createGithubEvidenceNormalizer(s.options)(s.input), /fixture-revoked/);
  assert.equal(reads, 2);
  assert.equal(s.state.calls.at(-1), `${prefix}/compare/${merge}...${head}?per_page=1&page=1`);
  assert.equal(s.state.acceptanceCalls, 0);
  assert.deepEqual(s.input, original);
});

test("release collection clock: an unselected source never consults the new protected clock", async () => {
  const s = retainedSource({ selected: false });
  s.options.now = () => assert.fail("unselected normalization must not read the release clock");
  await inspect(s, false);
});
