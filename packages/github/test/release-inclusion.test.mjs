import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubClientError,
  GithubReadClient,
  GithubReleaseInclusionError,
  collectGithubReleaseInclusion,
  validateGithubReleaseInclusion,
} from "../dist/index.js";
import { syntheticCheckpointStore } from "./synthetic-client.mjs";

// Synthetic HTTP underneath the actual authorized, repository-scoped client.
// These records are protected collector products, not cryptographic attestations
// or observations of a real repository's release, source rights or human roles.
const api = "https://api.synthetic.invalid";
const repositoryId = 37;
const repositorySlug = "synthetic-owner/release-repository";
const prefix = `/repos/${repositorySlug}`;
const merge = "a".repeat(40);
const head = "b".repeat(40);
const firstTag = "c".repeat(40);
const secondTag = "d".repeat(40);
const mergedAt = "2026-10-01T12:00:00.0000001Z";
const publishedAt = "2026-10-04T12:00:00.0000002Z";
const observedAt = "2026-10-05T12:00:00.0000003Z";
const notes = "RAW RELEASE NOTES synthetic-sensitive@example.invalid";
const repositoryBody = () => ({
  id: repositoryId,
  node_id: "R_synthetic_repository",
  full_name: repositorySlug,
  url: `${api}${prefix}`,
  private: false,
  visibility: "public",
  owner: { login: "raw-owner", email: "private-owner@example.invalid" },
});
const target = (type, value) => ({
  type,
  sha: value,
  url: `${api}${prefix}/git/${type === "commit" ? "commits" : "tags"}/${value}`,
});
const annotated = (value, next) => ({
  sha: value,
  node_id: `TAG_${value.slice(0, 8)}`,
  url: `${api}${prefix}/git/tags/${value}`,
  tag: "an-independently-named-inner-tag",
  tagger: { name: "raw-tagger", email: "private-tagger@example.invalid", date: mergedAt },
  message: notes,
  verification: { payload: notes },
  object: next,
});

function fixture({ mode = "lightweight", same = false, tagName = "release/v1.0", maxRetries = 0 } = {}) {
  const commit = same ? merge : head;
  const comparePath = `${prefix}/compare/${merge}...${commit}`;
  const refPath = `${prefix}/git/ref/tags/${tagName.split("/").map(encodeURIComponent).join("/")}`;
  const bodies = {
    repository: repositoryBody(),
    release: {
      id: 84,
      node_id: "RE_synthetic_release",
      url: `${api}${prefix}/releases/84`,
      immutable: true,
      draft: false,
      prerelease: false,
      published_at: publishedAt,
      tag_name: tagName,
      // This mutable branch hint never supplies tag proof or a request target.
      target_commitish: "https://untrusted.invalid/not-a-commit",
      body: notes,
      author: { login: "raw-publisher", email: "private-publisher@example.invalid" },
    },
    pullRequest: {
      id: 173,
      node_id: "PR_synthetic_pull",
      number: 91,
      url: `${api}${prefix}/pulls/91`,
      merged: true,
      state: "closed",
      draft: false,
      merged_at: mergedAt,
      merge_commit_sha: merge,
      base: { repo: repositoryBody() },
      user: {
        id: 55,
        node_id: "U_synthetic_author",
        type: "User",
        login: "raw-author",
        email: "private-author@example.invalid",
      },
      merged_by: { id: 88, node_id: "U_synthetic_merger", login: "raw-merger" },
      body: notes,
    },
    reference: {
      ref: `refs/tags/${tagName}`,
      node_id: "REF_synthetic_ref",
      url: `${api}${prefix}/git/refs/tags/${tagName.split("/").map(encodeURIComponent).join("/")}`,
      object: target(mode === "lightweight" ? "commit" : "tag", mode === "lightweight" ? commit : firstTag),
    },
    firstTag: annotated(firstTag, target(mode === "nested" ? "tag" : "commit", mode === "nested" ? secondTag : commit)),
    secondTag: annotated(secondTag, target("commit", commit)),
    comparison: {
      url: `${api}${comparePath}`,
      base_commit: { sha: merge, commit: { author: { email: "private-base@example.invalid" } } },
      merge_base_commit: { sha: merge },
      status: same ? "identical" : "ahead",
      ahead_by: same ? 0 : 2,
      behind_by: 0,
      // Deliberately incomplete lists: they are neither ancestry flags nor a
      // requirement for an unrelated complete physical file-diff acquisition.
      commits: [],
      files: [],
    },
  };
  const paths = new Map([
    [prefix, "repository"],
    [`${prefix}/releases/84`, "release"],
    [`${prefix}/pulls/91`, "pullRequest"],
    [refPath, "reference"],
    [`${prefix}/git/tags/${firstTag}`, "firstTag"],
    [`${prefix}/git/tags/${secondTag}`, "secondTag"],
    [`${comparePath}?per_page=1&page=1`, "comparison"],
  ]);
  const state = {
    authorized: true,
    authorizationChecks: 0,
    tokenRequests: 0,
    now: Date.parse(observedAt),
    calls: [],
    statuses: new Map(),
    onRequest: undefined,
    onSleep: undefined,
  };
  const client = new GithubReadClient({
    apiOrigin: api,
    token: async () => {
      state.tokenRequests++;
      return "synthetic-token";
    },
    checkpoints: syntheticCheckpointStore(),
    maxRetries,
    now: () => state.now,
    sleep: async (milliseconds) => {
      state.now += milliseconds;
      state.onSleep?.();
    },
    random: () => 0,
    fetch: async (url, request) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, api);
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      const path = parsed.pathname + parsed.search;
      const endpoint = paths.get(path);
      assert.ok(endpoint, `Only exact authorized relative source reads are allowed: ${path}`);
      const preceding = state.calls.at(-1)?.authorizationChecks ?? -1;
      assert.ok(state.authorizationChecks > preceding, "every read is authorized before transport");
      state.calls.push({ endpoint, path, authorizationChecks: state.authorizationChecks });
      state.onRequest?.(endpoint);
      const configured = state.statuses.get(endpoint) ?? 200;
      const status = Array.isArray(configured) ? (configured.shift() ?? 200) : configured;
      return new Response(JSON.stringify(status === 200 ? bodies[endpoint] : { message: notes }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const options = {
    client,
    source: "synthetic-installation",
    repository: { id: repositoryId, slug: repositorySlug },
    releaseId: 84,
    pullRequestNumber: 91,
    observedAt,
    assertAuthorized: () => {
      state.authorizationChecks++;
      if (!state.authorized) throw new Error(notes);
    },
  };
  return { bodies, paths, options, state, read: () => collectGithubReleaseInclusion(options) };
}

const inclusionFailure = (reason) => (error) => {
  assert.ok(error instanceof GithubReleaseInclusionError);
  assert.equal(error.reason, reason);
  assert.equal(error.message.includes(notes), false);
  return true;
};
const clientFailure = (kind) => (error) => {
  assert.ok(error instanceof GithubClientError);
  assert.equal(error.outcome.kind, kind);
  assert.equal(error.message.includes(notes), false);
  return true;
};

for (const mode of ["lightweight", "annotated", "nested"]) {
  for (const same of [false, true]) {
    test(`release collector reads ${mode} tag and exact ${same ? "identical" : "ahead"} immutable integration`, async () => {
      const f = fixture({ mode, same });
      const result = await f.read();
      assert.equal(result.schemaVersion, "github-release-inclusion/v1");
      assert.deepEqual(result.request, { repositoryId, repositorySlug, releaseId: 84, pullRequestNumber: 91 });
      assert.equal(result.repository.visibility, "public");
      assert.equal(result.release.publishedAt, publishedAt);
      assert.equal(result.pullRequest.mergedAt, mergedAt);
      assert.equal(result.observedAt, observedAt);
      assert.deepEqual(result.pullRequest.author, { id: 55, nodeId: "U_synthetic_author", type: "User" });
      assert.equal(result.tag.commitSha, same ? merge : head);
      assert.equal(result.tag.annotatedTags.length, mode === "nested" ? 2 : mode === "annotated" ? 1 : 0);
      assert.deepEqual(result.comparison, {
        requestedBaseSha: merge,
        requestedHeadSha: same ? merge : head,
        baseCommitSha: merge,
        mergeBaseCommitSha: merge,
        status: same ? "identical" : "ahead",
        aheadBy: same ? 0 : 2,
        behindBy: 0,
      });
      assert.deepEqual(
        f.state.calls.map((call) => call.endpoint),
        [
          "repository",
          "release",
          "pullRequest",
          "reference",
          ...(mode === "lightweight" ? [] : mode === "annotated" ? ["firstTag"] : ["firstTag", "secondTag"]),
          "comparison",
        ],
      );
      assert.deepEqual(validateGithubReleaseInclusion(result), result);
      assert.doesNotMatch(
        JSON.stringify(result),
        /raw-|RAW RELEASE|email|message|target_commitish|updated_at|revisionAt|merged_by|physicalDiff|human/,
      );
    });
  }
}

test("release collector retains only the current prerelease context for an immutable published release", async () => {
  const f = fixture();
  f.bodies.release.prerelease = true;
  const result = await f.read();
  assert.equal(result.release.currentPrerelease, true);
  assert.equal(result.release.publishedAt, publishedAt);
  assert.equal(Object.hasOwn(result.release, "prereleaseAtPublication"), false);
});

test("release collector retains a Bot account without inventing authored notes or publication roles", async () => {
  const f = fixture();
  f.bodies.pullRequest.user.type = "Bot";
  const result = await f.read();
  assert.equal(result.pullRequest.author.type, "Bot");
  assert.equal(Object.hasOwn(result, "publisher"), false);
  assert.equal(Object.hasOwn(result, "notesAuthor"), false);
});

test("release collector supports encoded Unicode and literal percent signs in an observed tag", async () => {
  const f = fixture({ tagName: "release/café%2026" });
  const result = await f.read();
  assert.equal(result.release.tagName, "release/café%2026");
  assert.equal(result.tag.ref, "refs/tags/release/café%2026");
});

test("release collector honors zero annotated depth for a lightweight tag and an exact nested bound", async () => {
  const light = fixture();
  light.options.maxAnnotatedTags = 0;
  assert.equal((await light.read()).tag.annotatedTags.length, 0);
  const nested = fixture({ mode: "nested" });
  nested.options.maxAnnotatedTags = 2;
  assert.equal((await nested.read()).tag.annotatedTags.length, 2);
});

test("release collector snapshots mutable host selection before any asynchronous source read", async () => {
  const f = fixture();
  f.state.onRequest = (endpoint) => {
    if (endpoint !== "repository") return;
    f.options.repository.id = 99;
    f.options.repository.slug = "another-owner/another-repository";
    f.options.releaseId = 99;
    f.options.pullRequestNumber = 99;
    f.options.observedAt = "2026-01-01T00:00:00Z";
  };
  const result = await f.read();
  assert.deepEqual(result.request, { repositoryId, repositorySlug, releaseId: 84, pullRequestNumber: 91 });
  assert.equal(result.observedAt, observedAt);
});

const inputFailures = [
  [
    "unsafe numeric repository identity",
    (o) => {
      o.repository.id = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "repository path traversal",
    (o) => {
      o.repository.slug = "synthetic-owner/..";
    },
  ],
  [
    "repository query injection",
    (o) => {
      o.repository.slug = "synthetic-owner/repo?x=y";
    },
  ],
  [
    "string release identity",
    (o) => {
      o.releaseId = "84";
    },
  ],
  [
    "fractional PR number",
    (o) => {
      o.pullRequestNumber = 91.5;
    },
  ],
  [
    "invalid observation clock",
    (o) => {
      o.observedAt = "2026-02-30T12:00:00Z";
    },
  ],
  [
    "missing synchronous authorization callback",
    (o) => {
      delete o.assertAuthorized;
    },
  ],
  [
    "oversized annotated depth",
    (o) => {
      o.maxAnnotatedTags = 17;
    },
  ],
  [
    "negative annotated depth",
    (o) => {
      o.maxAnnotatedTags = -1;
    },
  ],
];
for (const [name, mutate] of inputFailures) {
  test(`release collector rejects ${name} before token resolution or HTTP`, async () => {
    const f = fixture();
    mutate(f.options);
    await assert.rejects(f.read(), inclusionFailure("invalid_request"));
    assert.equal(f.state.tokenRequests, 0);
    assert.equal(f.state.calls.length, 0);
  });
}

const responseFailures = [
  [
    "repository numeric mismatch",
    "repository",
    "repository_unverified",
    (b) => {
      b.repository.id = 38;
    },
  ],
  [
    "repository slug mismatch",
    "repository",
    "repository_unverified",
    (b) => {
      b.repository.full_name = "other/repo";
    },
  ],
  [
    "missing repository node identity",
    "repository",
    "repository_unverified",
    (b) => {
      delete b.repository.node_id;
    },
  ],
  [
    "private repository",
    "repository",
    "repository_unverified",
    (b) => {
      b.repository.private = true;
    },
  ],
  [
    "missing public visibility",
    "repository",
    "repository_unverified",
    (b) => {
      delete b.repository.visibility;
    },
  ],
  [
    "unknown repository visibility",
    "repository",
    "repository_unverified",
    (b) => {
      b.repository.visibility = "unknown";
    },
  ],
  [
    "mutable release",
    "release",
    "immutable_release_required",
    (b) => {
      b.release.immutable = false;
    },
  ],
  [
    "unsupported missing immutable field",
    "release",
    "immutable_release_required",
    (b) => {
      delete b.release.immutable;
    },
  ],
  [
    "draft release",
    "release",
    "release_unverified",
    (b) => {
      b.release.draft = true;
    },
  ],
  [
    "missing native publication clock",
    "release",
    "release_unverified",
    (b) => {
      b.release.published_at = null;
      b.release.created_at = publishedAt;
    },
  ],
  [
    "release numeric mismatch",
    "release",
    "release_unverified",
    (b) => {
      b.release.id = 85;
    },
  ],
  [
    "release returned URL mismatch",
    "release",
    "release_unverified",
    (b) => {
      b.release.url = `${api}${prefix}/releases/85`;
    },
  ],
  [
    "missing current prerelease context",
    "release",
    "release_unverified",
    (b) => {
      delete b.release.prerelease;
    },
  ],
  [
    "future publication below millisecond precision",
    "release",
    "clock_inconsistent",
    (b) => {
      b.release.published_at = observedAt.replace("0000003", "0000004");
    },
  ],
  [
    "invalid tag traversal",
    "release",
    "release_unverified",
    (b) => {
      b.release.tag_name = "../main";
    },
  ],
  [
    "generic inclusion flags on unmerged PR",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.merged = false;
      b.pullRequest.included = true;
      b.pullRequest.ancestryVerified = true;
    },
  ],
  [
    "open PR",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.state = "open";
    },
  ],
  [
    "draft PR",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.draft = true;
    },
  ],
  [
    "missing PR merge clock",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.merged_at = null;
    },
  ],
  [
    "merge after publication below millisecond precision",
    "pullRequest",
    "clock_inconsistent",
    (b) => {
      b.pullRequest.merged_at = publishedAt.replace("0000002", "0000003");
    },
  ],
  [
    "abbreviated integration SHA",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.merge_commit_sha = merge.slice(0, 7);
    },
  ],
  [
    "missing actual merge SHA despite head hint",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.merge_commit_sha = null;
      b.pullRequest.head = { sha: merge };
    },
  ],
  [
    "PR number mismatch",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.number = 92;
    },
  ],
  [
    "PR base repository numeric mismatch",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.base.repo.id = 38;
    },
  ],
  [
    "PR base repository node mismatch",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.base.repo.node_id = "R_other";
    },
  ],
  [
    "PR base repository slug mismatch",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.base.repo.full_name = "other/repo";
    },
  ],
  [
    "PR base private repository",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.base.repo.private = true;
    },
  ],
  [
    "missing native PR author",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.user = null;
    },
  ],
  [
    "unsupported native account type",
    "pullRequest",
    "pull_request_unverified",
    (b) => {
      b.pullRequest.user.type = "Organization";
    },
  ],
  [
    "ref substituted with branch",
    "reference",
    "tag_unverified",
    (b) => {
      b.reference.ref = "refs/heads/main";
    },
  ],
  [
    "missing reference node identity",
    "reference",
    "tag_unverified",
    (b) => {
      delete b.reference.node_id;
    },
  ],
  [
    "non-commit tree target",
    "reference",
    "tag_unverified",
    (b) => {
      b.reference.object.type = "tree";
    },
  ],
  [
    "object SHA and returned object URL mismatch",
    "reference",
    "tag_unverified",
    (b) => {
      b.reference.object.url = `${api}${prefix}/git/commits/${merge}`;
    },
  ],
  [
    "returned reference from another repository",
    "reference",
    "tag_unverified",
    (b) => {
      b.reference.url = `${api}/repos/other/repo/git/refs/tags/release/v1.0`;
    },
  ],
  [
    "returned object from untrusted origin",
    "reference",
    "tag_unverified",
    (b) => {
      b.reference.object.url = `https://untrusted.invalid${prefix}/git/commits/${head}`;
    },
  ],
  [
    "diverged comparison",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.status = "diverged";
    },
  ],
  [
    "behind comparison",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.status = "behind";
    },
  ],
  [
    "nonzero behind count",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.behind_by = 1;
    },
  ],
  [
    "unrelated returned base",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.base_commit.sha = head;
    },
  ],
  [
    "unrelated returned merge base",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.merge_base_commit.sha = firstTag;
    },
  ],
  [
    "reversed returned comparison identity",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.url = `${api}${prefix}/compare/${head}...${merge}`;
    },
  ],
  [
    "symbolic returned comparison identity",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.url = `${api}${prefix}/compare/main...release`;
    },
  ],
  [
    "fractional ahead count",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.ahead_by = 1.5;
    },
  ],
  [
    "zero ahead count with distinct commits",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.ahead_by = 0;
    },
  ],
  [
    "identical status with distinct commits",
    "comparison",
    "ancestry_unverified",
    (b) => {
      b.comparison.status = "identical";
      b.comparison.ahead_by = 0;
    },
  ],
];
for (const [name, endpoint, reason, mutate] of responseFailures) {
  test(`release collector rejects ${name} at its actual source boundary`, async () => {
    const f = fixture();
    mutate(f.bodies);
    await assert.rejects(f.read(), inclusionFailure(reason));
    assert.equal(f.state.calls.at(-1).endpoint, endpoint, "invalid evidence must not trigger later acquisition");
  });
}

const chainFailures = [
  [
    "annotated returned SHA mismatch",
    "tag_unverified",
    (f) => {
      f.bodies.firstTag.sha = secondTag;
    },
  ],
  [
    "missing annotated node identity",
    "tag_unverified",
    (f) => {
      delete f.bodies.firstTag.node_id;
    },
  ],
  [
    "annotated self-cycle",
    "tag_unverified",
    (f) => {
      f.bodies.firstTag.object = target("tag", firstTag);
    },
  ],
  [
    "multi-object annotated cycle",
    "tag_unverified",
    (f) => {
      f.bodies.firstTag.object = target("tag", secondTag);
      f.bodies.secondTag.object = target("tag", firstTag);
    },
  ],
  [
    "annotated blob target",
    "tag_unverified",
    (f) => {
      f.bodies.firstTag.object.type = "blob";
    },
  ],
  [
    "missing annotated target",
    "tag_unverified",
    (f) => {
      delete f.bodies.firstTag.object;
    },
  ],
  [
    "mixed target hash formats",
    "tag_unverified",
    (f) => {
      f.bodies.firstTag.object = target("commit", "b".repeat(64));
    },
  ],
  [
    "annotated chain exceeds configured bound",
    "tag_chain_limit",
    (f) => {
      f.options.maxAnnotatedTags = 1;
      f.bodies.firstTag.object = target("tag", secondTag);
    },
  ],
];
for (const [name, reason, mutate] of chainFailures) {
  test(`release collector rejects ${name} before comparison`, async () => {
    const f = fixture({ mode: "annotated" });
    mutate(f);
    await assert.rejects(f.read(), inclusionFailure(reason));
    assert.equal(
      f.state.calls.some((call) => call.endpoint === "comparison"),
      false,
    );
  });
}

for (const endpoint of ["repository", "release", "pullRequest", "reference", "firstTag", "comparison"]) {
  test(`release collector preserves native hidden-or-missing outcome at ${endpoint}`, async () => {
    const f = fixture({ mode: "annotated" });
    f.state.statuses.set(endpoint, 404);
    await assert.rejects(f.read(), clientFailure("not_found_or_hidden"));
    assert.equal(f.state.calls.at(-1).endpoint, endpoint);
  });
}

test("release collector denies revoked access before token resolution", async () => {
  const f = fixture();
  f.state.authorized = false;
  await assert.rejects(f.read(), clientFailure("unsafe_request"));
  assert.equal(f.state.tokenRequests, 0);
  assert.equal(f.state.calls.length, 0);
});

for (const endpoint of ["release", "comparison"]) {
  test(`release collector denies access revoked during ${endpoint} before accepting its response`, async () => {
    const f = fixture();
    f.state.onRequest = (name) => {
      if (name === endpoint) f.state.authorized = false;
    };
    await assert.rejects(f.read(), clientFailure("unsafe_request"));
    assert.equal(f.state.calls.at(-1).endpoint, endpoint);
  });
}

test("release collector reuses per-attempt authorization on a transient retry", async () => {
  const f = fixture({ maxRetries: 1 });
  f.state.statuses.set("repository", [503, 200]);
  assert.equal((await f.read()).request.repositoryId, repositoryId);
  assert.deepEqual(
    f.state.calls.slice(0, 2).map((call) => call.endpoint),
    ["repository", "repository"],
  );
  assert.ok(f.state.calls[1].authorizationChecks > f.state.calls[0].authorizationChecks);
});

test("release collector rechecks revoked authority during retry delay before a second attempt", async () => {
  const f = fixture({ maxRetries: 1 });
  f.state.statuses.set("repository", [503, 200]);
  f.state.onSleep = () => {
    f.state.authorized = false;
  };
  await assert.rejects(f.read(), clientFailure("unsafe_request"));
  assert.equal(f.state.calls.length, 1);
});

test("release record structural revalidation returns detached minimized containers", async () => {
  const record = await fixture({ mode: "nested" }).read();
  record.tag.annotatedTags.rawPayload = notes;
  const validated = validateGithubReleaseInclusion(record);
  assert.deepEqual(JSON.parse(JSON.stringify(validated)), JSON.parse(JSON.stringify(record)));
  assert.notEqual(validated, record);
  assert.equal(Object.hasOwn(validated.tag.annotatedTags, "rawPayload"), false);
  record.request.repositoryId = 999;
  record.pullRequest.author.id = 999;
  record.tag.annotatedTags[0].target.sha = merge;
  assert.equal(validated.request.repositoryId, repositoryId);
  assert.equal(validated.pullRequest.author.id, 55);
  assert.equal(validated.tag.annotatedTags[0].target.sha, secondTag);
});

const recordFailures = [
  [
    "unsupported version",
    (v) => {
      v.schemaVersion = "github-release-inclusion/v2";
    },
  ],
  [
    "generic replay source",
    (v) => {
      v.source = "github_replay";
    },
  ],
  [
    "extra raw record payload",
    (v) => {
      v.rawPayload = notes;
    },
  ],
  [
    "request and repository mismatch",
    (v) => {
      v.request.repositoryId = 38;
    },
  ],
  [
    "unknown repository visibility",
    (v) => {
      v.repository.visibility = "unknown";
    },
  ],
  [
    "release numeric mismatch",
    (v) => {
      v.release.id = 85;
    },
  ],
  [
    "mutable release substitution",
    (v) => {
      v.release.immutable = false;
    },
  ],
  [
    "private release note retention",
    (v) => {
      v.release.body = notes;
    },
  ],
  [
    "PR repository node mismatch",
    (v) => {
      v.pullRequest.repositoryNodeId = "R_other";
    },
  ],
  [
    "missing actual author identity",
    (v) => {
      delete v.pullRequest.author.nodeId;
    },
  ],
  [
    "future publication clock",
    (v) => {
      v.release.publishedAt = "2026-12-01T00:00:00Z";
    },
  ],
  [
    "merge after publication clock",
    (v) => {
      v.pullRequest.mergedAt = observedAt;
    },
  ],
  [
    "unbound reference name",
    (v) => {
      v.tag.ref = "refs/tags/other";
    },
  ],
  [
    "missing annotated chain",
    (v) => {
      v.tag.annotatedTags = [];
    },
  ],
  [
    "annotated requested/returned identity mismatch",
    (v) => {
      v.tag.annotatedTags[0].requestedSha = merge;
    },
  ],
  [
    "unresolved annotated target",
    (v) => {
      v.tag.annotatedTags[1].target = { type: "tag", sha: firstTag };
    },
  ],
  [
    "extra annotated proof after commit",
    (v) => {
      v.tag.annotatedTags.push(structuredClone(v.tag.annotatedTags[0]));
    },
  ],
  [
    "unbound resolved commit",
    (v) => {
      v.tag.commitSha = merge;
    },
  ],
  [
    "unbound comparison request head",
    (v) => {
      v.comparison.requestedHeadSha = merge;
    },
  ],
  [
    "unbound comparison merge base",
    (v) => {
      v.comparison.mergeBaseCommitSha = head;
    },
  ],
  [
    "nonzero comparison behind count",
    (v) => {
      v.comparison.behindBy = 1;
    },
  ],
  [
    "ambiguous string count",
    (v) => {
      v.comparison.aheadBy = "2";
    },
  ],
  [
    "accessor field pretending to be retained data",
    (v) => {
      Object.defineProperty(v.release, "immutable", { enumerable: true, get: () => true });
    },
  ],
];
for (const [name, mutate] of recordFailures) {
  test(`release record revalidation rejects ${name}`, async () => {
    const record = await fixture({ mode: "nested" }).read();
    mutate(record);
    assert.throws(() => validateGithubReleaseInclusion(record), inclusionFailure("record_unverified"));
  });
}
