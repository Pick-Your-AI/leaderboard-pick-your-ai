import test from "node:test";
import assert from "node:assert/strict";
import { GithubReadClient } from "../../../packages/github/dist/client.js";
import { syntheticCheckpointStore } from "../../../packages/github/test/synthetic-client.mjs";
import { createGithubCollectionSource } from "../src/github-source.mjs";

const approved = {
  id: 2,
  installationId: 1,
  slug: "synthetic-owner/repository",
  families: ["issues"],
};
const request = {
  runId: "synthetic-location-scan",
  repositoryId: 2,
  family: "issues",
  mode: "reconcile",
  since: null,
  until: "2026-10-18T00:00:00.000Z",
  cursor: null,
  limit: 100,
};

function harness(metadata, repository = approved) {
  const calls = [],
    unavailable = [];
  const client = new GithubReadClient({
    apiOrigin: "https://api.synthetic.invalid",
    token: async () => "synthetic-test-token",
    maxRetries: 0,
    checkpoints: syntheticCheckpointStore(),
    fetch: async (value) => {
      const url = new URL(value);
      calls.push(url.pathname);
      if (url.pathname === `/repos/${repository.slug}`)
        return new Response(JSON.stringify(metadata), { headers: { "content-type": "application/json" } });
      assert.equal(url.pathname, `/repos/${repository.slug}/issues`);
      return new Response("[]", { headers: { "content-type": "application/json" } });
    },
  });
  const source = createGithubCollectionSource({
    client,
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    onUnavailable: async (scope, reason) => unavailable.push({ repositoryId: scope.id, reason }),
  });
  return { source, calls, unavailable };
}

for (const [label, fullName] of [
  ["different owner", "different-owner/repository"],
  ["renamed repository", "synthetic-owner/renamed"],
  ["missing current location", undefined],
  ["null current location", null],
  ["numeric current location", 2],
  ["array current location", [approved.slug]],
  ["blank current location", ""],
  ["trailing slash", `${approved.slug}/`],
  ["leading whitespace", ` ${approved.slug}`],
  ["absolute URL", `https://github.com/${approved.slug}`],
]) {
  test(`repository probe rejects ${label} before collecting or accepting an empty inventory`, async () => {
    const h = harness({ id: approved.id, private: false, full_name: fullName });
    await assert.rejects(h.source.probeRepository(approved), /repository_identity_unverified/);
    await assert.rejects(h.source.readPage(request), /repository_probe_unavailable/);
    assert.deepEqual(h.calls, [`/repos/${approved.slug}`, `/repos/${approved.slug}`]);
    assert.deepEqual(h.unavailable, [{ repositoryId: approved.id, reason: "visibility_probe_unavailable" }]);
  });
}

for (const fullName of [approved.slug, "SYNTHETIC-OWNER/Repository"]) {
  test(`repository probe accepts the approved location with GitHub case semantics: ${fullName}`, async () => {
    const h = harness({ id: approved.id, private: false, full_name: fullName });
    const probe = await h.source.probeRepository(approved);
    assert.equal(probe.repositoryId, approved.id);
    assert.equal(probe.installationId, approved.installationId);
    assert.equal(probe.visibility, "public");
    const page = await h.source.readPage(request);
    assert.deepEqual(page.facts, []);
    assert.equal(page.expectedCount, 0);
    assert.equal(page.nextCursor, null);
    assert.equal(h.calls.filter((path) => path.endsWith("/issues")).length, 1);
    assert.deepEqual(h.unavailable, []);
  });
}

test("a reviewed new location can retain the numeric identity without authorizing the former binding", async () => {
  const relocated = { ...approved, slug: "different-owner/renamed" };
  const metadata = { id: approved.id, private: false, full_name: relocated.slug };
  const previous = harness(metadata);
  await assert.rejects(previous.source.readPage(request), /repository_probe_unavailable/);
  assert.equal(previous.calls.length, 1);
  const rebound = harness(metadata, relocated);
  assert.equal((await rebound.source.probeRepository(relocated)).repositoryId, approved.id);
  assert.equal((await rebound.source.readPage(request)).expectedCount, 0);
});

test("a matching location cannot replace the approved native identity or public visibility", async () => {
  const differentId = harness({ id: 3, private: false, full_name: approved.slug });
  await assert.rejects(differentId.source.readPage(request), /repository_probe_unavailable/);
  const privateSource = harness({ id: approved.id, private: true, full_name: approved.slug });
  await assert.rejects(privateSource.source.readPage(request), /public_repository_required/);
  assert.deepEqual(privateSource.unavailable, [
    { repositoryId: approved.id, reason: "visibility_or_scope_not_public" },
  ]);
  assert.equal(differentId.calls.length, 1);
  assert.equal(privateSource.calls.length, 1);
});
