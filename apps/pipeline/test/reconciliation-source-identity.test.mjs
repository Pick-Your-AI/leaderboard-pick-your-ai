import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRepositoryClient } from "../../../packages/github/test/synthetic-client.mjs";
import {
  githubRestSnapshotSemanticRevision,
  verifyGithubRestSnapshotRevision,
} from "../../../packages/github/dist/rest-snapshot.js";
import { createGithubCollectionSource } from "../src/github-source.mjs";
import { reconciliationRunId } from "../src/reconciliation-plan.mjs";

const families = ["issues", "pull_requests", "comments", "releases"];
const repository = { id: 2, installationId: 1, slug: "synthetic-owner/repository", families };
const since = "2026-10-01T00:00:00.000Z";
const until = "2026-10-02T00:00:00.000Z";
const updated = "2026-10-01T12:00:00Z";
const runId = (n) =>
  reconciliationRunId("a".repeat(64), `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, 0, 1);
const request = (family, changes = {}) => ({
  repositoryId: 2,
  family,
  runId: runId(1),
  mode: "audit",
  since: null,
  until,
  cursor: null,
  limit: 100,
  ...changes,
});
const payload = (family) => ({
  id: 1001,
  node_id: "SYNTHETIC_REST_OBJECT",
  number: 1,
  html_url: `https://github.com/${repository.slug}/${
    family === "pull_requests" ? "pull/1" : family === "releases" ? "releases/tag/v1" : "issues/1"
  }${family === "comments" ? "#issuecomment-1001" : ""}`,
  created_at: since,
  updated_at: updated,
  body: "Synthetic content A",
  user: { id: 101, node_id: "U_SYNTHETIC_A", login: "synthetic-alice", type: "User" },
  ...(family === "releases" ? { tag_name: "v1", published_at: since } : { state: "open" }),
});
function sourceFor(family) {
  const state = { value: payload(family), reads: 0 };
  const source = createGithubCollectionSource({
    sourceId: "synthetic",
    repositories: [repository],
    isSynthetic: true,
    client: syntheticRepositoryClient(2, {
      async rest() {
        state.reads++;
        return { id: 2, private: false, full_name: repository.slug };
      },
      async scanRest(options) {
        state.reads++;
        return options.select([state.value]);
      },
    }),
  });
  return { state, source };
}

for (const family of families) {
  test(`legacy ${family} scans preserve native revisions across dispatch and explicit scan identities`, async () => {
    const { state, source } = sourceFor(family);
    const original = structuredClone(state.value);
    for (const [index, mode] of ["reconcile", "audit", "backfill"].entries()) {
      const first = await source.readPage(request(family, { runId: `synthetic-legacy-${index}-a`, mode }));
      const second = await source.readPage(request(family, { runId: `synthetic-legacy-${index}-b`, mode }));
      assert.equal(first.facts[0].sourceRevision, "2026-10-01T12:00:00.000Z");
      assert.equal(second.facts[0].sourceRevision, first.facts[0].sourceRevision);
      assert.equal(githubRestSnapshotSemanticRevision(first.facts[0].sourceRevision), null);
    }
    assert.deepEqual(state.value, original);
  });

  test(`scheduled ${family} audits preserve same-clock content edits and restoration as fresh observations`, async () => {
    const { state, source } = sourceFor(family);
    const original = structuredClone(state.value);
    const values = [];
    for (const [index, body] of ["Synthetic content A", "Synthetic content B", "Synthetic content A"].entries()) {
      state.value.body = body;
      const page = await source.readPage(request(family, { runId: runId(index + 1) }));
      const fact = page.facts[0];
      assert.equal(page.expectedCount, 1);
      assert.equal(page.nextCursor, null);
      assert.ok(verifyGithubRestSnapshotRevision(family, state.value, fact.sourceRevision));
      assert.equal(fact.actorId, null);
      assert.equal(fact.occurredAt, null);
      assert.doesNotMatch(JSON.stringify(fact), /Synthetic content/);
      values.push(fact.sourceRevision);
    }
    assert.equal(new Set(values).size, 3);
    assert.equal(githubRestSnapshotSemanticRevision(values[0]), githubRestSnapshotSemanticRevision(values[2]));
    assert.notEqual(githubRestSnapshotSemanticRevision(values[0]), githubRestSnapshotSemanticRevision(values[1]));
    assert.deepEqual(state.value, original);
  });
}

for (const family of ["issues", "comments"]) {
  test(`scheduled recent ${family} scans use the same verified content marker`, async () => {
    const { state, source } = sourceFor(family);
    const page = await source.readPage(request(family, { mode: "reconcile", since }));
    assert.equal(page.facts.length, 1);
    assert.ok(verifyGithubRestSnapshotRevision(family, state.value, page.facts[0].sourceRevision));
  });
}

test("malformed reserved plan identities fail before repository or collection I/O", async () => {
  const valid = runId(1);
  for (const malformed of [
    "rc1:",
    valid.replace("rc1:" + "a".repeat(64), "rc1:" + "a".repeat(63)),
    valid.replace("a".repeat(64), "A".repeat(64)),
    valid.replace("00000000-0000-4000-8000-000000000001", "not-a-token"),
    valid.slice(0, -4) + "0000",
    valid.slice(0, -4) + "1201",
    valid.replace(":0000:0001", ":0001:0001"),
    valid + "\n",
  ]) {
    const { state, source } = sourceFor("issues");
    await assert.rejects(
      source.readPage(request("issues", { runId: malformed })),
      /reconciliation_plan_identity_invalid/,
    );
    assert.equal(state.reads, 0);
  }
});

test("reserved plans require canonical audit or bounded recent shapes before I/O", async () => {
  for (const changes of [
    { mode: "backfill" },
    { mode: undefined },
    { since: undefined },
    { since },
    { until: "2026-10-02T00:00:00Z" },
    { until: "2026-10-02T00:00:00.000001Z" },
    { until: "2026-02-30T00:00:00.000Z" },
    { mode: "reconcile", since: null },
    { mode: "reconcile", since: undefined },
    { mode: "reconcile", since: "2026-10-01T00:00:00Z" },
    { mode: "reconcile", since: until },
    { mode: "reconcile", since: "2026-10-03T00:00:00.000Z" },
  ]) {
    const { state, source } = sourceFor("issues");
    await assert.rejects(source.readPage(request("issues", changes)));
    assert.equal(state.reads, 0);
  }
});
