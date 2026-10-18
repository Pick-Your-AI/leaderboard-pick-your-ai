import assert from "node:assert/strict";
import test from "node:test";
import { directory, portfolioParameters, selection, uiHref, evidence } from "../src/remote/client.ts";

test("directory filters are explicit, normalized, bounded and separate from board metric selection", () => {
  const selected = selection(
    "?ui=api&search=Synthetic-A&category=documentation&metric=pr_opened&limit=100&snapshot=public-1&cursor=payload.signature",
  );
  assert.equal(selected.search, "synthetic-a");
  const params = portfolioParameters(selected, true);
  assert.equal(params.get("metric"), null);
  assert.equal(params.get("search"), "synthetic-a");
  assert.equal(params.get("category"), "documentation");
  assert.equal(params.get("snapshot"), "public-1");
  assert.equal(params.get("cursor"), "payload.signature");
  assert.equal(params.get("limit"), "100");
  assert.equal(portfolioParameters(selected).get("search"), null);
  for (const query of [
    "?search=",
    "?search=" + "a".repeat(40),
    "?search=a&search=b",
    "?search=mail%40example.invalid",
    "?category=bad%20category",
  ])
    assert.throws(() => selection(query));
});

test("portfolio navigation pins scope, drops the old page and never carries username search to an actor or board", () => {
  const selected = selection(
    "?ui=api&search=alice&category=documentation&repository=repo-1&snapshot=public-1&cursor=old.signature",
  );
  const profile = new URL(uiHref("/contributors/actor-1", selected), "https://example.invalid");
  assert.equal(profile.searchParams.get("snapshot"), "public-1");
  assert.equal(profile.searchParams.get("category"), "documentation");
  assert.equal(profile.searchParams.get("repository"), "repo-1");
  assert.equal(profile.searchParams.get("search"), null);
  assert.equal(profile.searchParams.get("cursor"), null);
  const next = new URL(uiHref("/contributors", selected, { cursor: "new.signature" }), "https://example.invalid");
  assert.equal(next.searchParams.get("search"), "alice");
  assert.equal(next.searchParams.get("cursor"), "new.signature");
  const board = new URL(uiHref("/leaderboards/pr_opened", selected), "https://example.invalid");
  assert.equal(board.searchParams.get("search"), null);
  assert.equal(board.searchParams.get("category"), null);
});

test("directory rejects mismatched filters before rendering supplied contributors", () => {
  const selected = selection("?search=alice&category=documentation");
  assert.throws(
    () => directory({ search: "bob", category: "documentation", contributors: [] }, selected),
    /api_filter_mismatch/,
  );
  assert.throws(
    () => directory({ search: "alice", category: "pr_opened", contributors: [] }, selected),
    /api_filter_mismatch/,
  );
});

test("legacy evidence does not turn eligibility into accepted work", () => {
  const record = {
    artifact: {
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "issue",
      stableId: "issue-1",
      repositoryId: "repo-1",
      publicUrl: "https://github.com/synthetic/example/issues/1",
      visibility: "public",
    },
    contribution: {
      schemaVersion: "leaderboard/v1",
      contributionId: "evidence-1",
      canonicalEventId: "event-1",
      artifactId: "issue-1",
      actorId: "actor-1",
      roles: ["reporter"],
      qualification: "eligible",
      metricIds: ["issues_opened"],
      reasonCodes: [],
    },
    occurredAt: "2026-10-17T00:00:00.000Z",
    sourceRevision: null,
    sourceRevisionUrl: null,
  };
  assert.equal(evidence(record).activityState, "unknown");
  assert.equal(evidence(record).observedAt, null);
  assert.throws(() => evidence({ ...record, activityState: "implicitly_accepted" }));
});
