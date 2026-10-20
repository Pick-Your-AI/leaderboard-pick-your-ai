import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../dist/app.js";
import { projectRead } from "../dist/public-source.js";
import { at } from "../../../tests/fixtures/pending-metric.mjs";
import { projectFixture } from "../../../tests/fixtures/public-project-context.mjs";

function read(input) {
  const original = JSON.stringify(input);
  try {
    return projectRead(input, input.selected.scope, input.head.snapshotId);
  } finally {
    assert.equal(JSON.stringify(input), original);
  }
}

function allCopies() {
  const input = projectFixture();
  const pending = input.selected.pendingEvidence[0];
  input.selected.evidence.push(structuredClone(pending));
  input.selected.portfolioEvidence.push(structuredClone(pending));
  return input;
}

test("all three public proof collections preserve identical bound Project context", () => {
  const input = allCopies();
  const output = read(input);
  const id = input.selected.pendingEvidence[0].contribution.contributionId;
  for (const collection of ["evidence", "pendingEvidence", "portfolioEvidence"])
    assert.deepEqual(
      output.selected[collection].find((proof) => proof.contribution.contributionId === id).projectContext,
      input.selected.pendingEvidence[0].projectContext,
    );
});

test("each public proof copy rejects malformed, absent-vs-present and foreign Project context before suppression", () => {
  for (const collection of ["evidence", "pendingEvidence", "portfolioEvidence"]) {
    for (const mutate of [
      (proof) => {
        proof.projectContext = null;
      },
      (proof) => {
        delete proof.projectContext;
      },
      (proof) => {
        proof.projectContext.binding.repositoryId = "other";
      },
      (proof) => {
        proof.projectContext.binding.artifactId = "other";
      },
      (proof) => {
        proof.projectContext.binding.contributionId = "other";
      },
      (proof) => {
        proof.projectContext.basis = "current";
      },
      (proof) => {
        proof.projectContext.projects = ["PVT_A"];
      },
      (proof) => {
        proof.projectContext.projectScope.push("PVT_C");
      },
      (proof) => {
        proof.projectContext.observedAt = "2026-10-18T00:00:00Z";
      },
    ]) {
      const input = allCopies();
      const id = input.selected.pendingEvidence[0].contribution.contributionId;
      mutate(input.selected[collection].find((proof) => proof.contribution.contributionId === id));
      input.controls.suppressedContributionIds = [id];
      assert.throws(
        () => read(input),
        (error) =>
          error.name === "ZodError" || (error.status === 503 && error.code === "public_projection_unavailable"),
        collection,
      );
    }
  }
});

test("Project context cannot survive current actor, artifact, unit or snapshot denial on a pin", async (t) => {
  for (const deny of [
    (input) => {
      input.controls.suppressedActorIds = ["101"];
    },
    (input) => {
      input.controls.suppressedArtifactIds = [input.selected.evidence[0].artifact.stableId];
    },
    (input) => {
      input.controls.suppressedContributionIds = [input.selected.evidence[0].contribution.contributionId];
    },
    (input) => {
      input.controls.revokedSnapshotIds = [input.head.snapshotId];
    },
  ]) {
    const input = projectFixture();
    const app = createService({
      now: () => Date.parse(at),
      source: {
        async read() {
          return structuredClone(input);
        },
      },
    });
    t.after(() => app.close());
    const url = "/api/v1/contributors/101?snapshot=synthetic-pending-1";
    const initial = await app.inject(url);
    assert.equal(initial.statusCode, 200, initial.body);
    assert.ok(initial.body.includes("public-project-context/v1"));
    const removed = input.selected.evidence[0].contribution.contributionId;
    deny(input);
    const response = await app.inject({ url, headers: { "if-none-match": initial.headers.etag } });
    assert.notEqual(response.statusCode, 304);
    assert.equal(response.body.includes(removed), false);
    if (response.statusCode === 200) assert.equal(response.json().evidenceCount, 13);
    else assert.ok([404, 410].includes(response.statusCode), response.body);
  }
});

test("complete profile byte paging preserves exact UTF-8 proofs, global counts and signed cursor offsets", async (t) => {
  const projects = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(125)}`);
  const input = projectFixture({ count: 100, projects, pad: "界".repeat(300) });
  const original = JSON.stringify(input);
  const app = createService({
    now: () => Date.parse(at),
    source: {
      async read() {
        return structuredClone(input);
      },
    },
  });
  t.after(() => app.close());
  const ids = [];
  let cursor = null;
  let first;
  let pages = 0;
  do {
    const query = new URLSearchParams({ snapshot: input.head.snapshotId, limit: "100", category: "pr_merged" });
    if (cursor) query.set("cursor", cursor);
    const response = await app.inject(`/api/v1/contributors/101?${query}`);
    assert.equal(response.statusCode, 200, response.body.slice(0, 300));
    assert.ok(Buffer.byteLength(response.body) <= 2_000_000);
    const body = response.json();
    if (!first) first = body;
    assert.equal(body.evidenceCount, 100);
    assert.deepEqual(body.categories, first.categories);
    assert.deepEqual(body.results, first.results);
    assert.equal(body.snapshotId, input.head.snapshotId);
    assert.equal(body.policyVersion, input.controls.version);
    assert.ok(body.timeline.length > 0);
    assert.deepEqual(
      body.evidenceIds,
      body.timeline.map((proof) => proof.contribution.contributionId),
    );
    for (const proof of body.timeline) {
      const originalProof = input.selected.evidence.find(
        (item) => item.contribution.contributionId === proof.contribution.contributionId,
      );
      assert.deepEqual(proof.projectContext, originalProof.projectContext);
    }
    ids.push(...body.evidenceIds);
    cursor = body.nextCursor;
    assert.equal(body.timelineTruncated, cursor !== null);
    if (cursor) assert.equal(JSON.parse(Buffer.from(cursor.split(".")[0], "base64url")).offset, ids.length);
    pages++;
    assert.ok(pages < 10);
  } while (cursor);
  assert.ok(pages > 1, "full provider profile exceeds the original client byte budget");
  assert.equal(new Set(ids).size, 100);
  assert.deepEqual(ids, input.selected.evidence.map((proof) => proof.contribution.contributionId).sort());
  assert.equal(JSON.stringify(input), original);
  const altered = new URLSearchParams({
    snapshot: input.head.snapshotId,
    limit: "99",
    category: "pr_merged",
    cursor: first.nextCursor,
  });
  assert.equal((await app.inject(`/api/v1/contributors/101?${altered}`)).statusCode, 400);
  input.controls.version = "synthetic-controls-changed";
  altered.set("limit", "100");
  assert.equal((await app.inject(`/api/v1/contributors/101?${altered}`)).statusCode, 410);
});
