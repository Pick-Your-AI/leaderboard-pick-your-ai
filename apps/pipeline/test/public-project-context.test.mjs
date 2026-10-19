import assert from "node:assert/strict";
import test from "node:test";
import { publicScopeParameters } from "../../../packages/contracts/dist/index.js";
import { clock, publicScope } from "./harness.mjs";
import { publicScopeHarness, projectIds } from "./public-scope-harness.mjs";
import { createPublicProjectContextProjector } from "../src/public-project-context.mjs";

async function profile(h, scope, extra = {}) {
  const query = new URLSearchParams({ ...publicScopeParameters(scope), ...extra });
  const directory = await h.runtime.app.inject(`/api/v1/contributors?${query}`);
  assert.equal(directory.statusCode, 200, directory.body);
  const actorId = directory.json().contributors[0].actorId;
  const response = await h.runtime.app.inject(`/api/v1/contributors/${actorId}?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function capturedCurrent(t) {
  const captured = [];
  const current = { ...publicScope, context: "current" };
  const h = await publicScopeHarness(t, {
    scopes: [publicScope, current],
    transformProjectOutput(output) {
      captured.push(structuredClone(output.projectContext));
      return output;
    },
  });
  const result = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(result.state, "published");
  assert.equal(h.normalizedProjects(), 2);
  assert.equal(captured.length, 2);
  return { h, current, captured };
}

test("public profile retains the actual native two-Project membership and observation receipt", async (t) => {
  const { h, current, captured } = await capturedCurrent(t);
  const value = await profile(h, current);
  assert.equal(value.evidenceCount, 2, "Project overlap does not duplicate native work");
  const proof = value.timeline.find((item) => item.artifact.publicUrl.endsWith("/issues/1"));
  assert.ok(proof);
  const receipt = captured.find((item) => item.subjectId === "SYNTHETIC_ISSUE_1");
  assert.deepEqual(receipt.context.projects, projectIds);
  assert.deepEqual(receipt.context.projectScope, projectIds);
  assert.ok(proof.projectContext, "the public projection must preserve verified membership");
  assert.deepEqual(proof.projectContext, {
    schemaVersion: "public-project-context/v1",
    binding: {
      repositoryId: proof.artifact.repositoryId,
      artifactId: proof.artifact.stableId,
      contributionId: proof.contribution.contributionId,
    },
    basis: "current",
    state: "known",
    projects: projectIds,
    projectScope: projectIds,
    observedAt: receipt.observedAt,
  });
});

test("public profile distinguishes verified empty native membership from unknown", async (t) => {
  const { h, current, captured } = await capturedCurrent(t);
  const value = await profile(h, current);
  const proof = value.timeline.find((item) => item.artifact.publicUrl.endsWith("/issues/2"));
  assert.ok(proof);
  const receipt = captured.find((item) => item.subjectId === "SYNTHETIC_ISSUE_2");
  assert.deepEqual(receipt.context.projects, []);
  assert.deepEqual(receipt.context.projectScope, projectIds);
  assert.ok(proof.projectContext, "known absence within the approved scope must survive projection");
  assert.equal(proof.projectContext.state, "known");
  assert.deepEqual(proof.projectContext.projects, []);
  assert.deepEqual(proof.projectContext.projectScope, projectIds);
  assert.equal(proof.projectContext.observedAt, receipt.observedAt);
});

test("current Project collection does not invent historical membership or a different proof population", async (t) => {
  const { h } = await capturedCurrent(t);
  const value = await profile(h, publicScope);
  assert.equal(value.evidenceCount, 2);
  assert.equal(new Set(value.evidenceIds).size, 2);
  for (const proof of value.timeline) {
    if (proof.projectContext !== undefined) {
      assert.equal(proof.projectContext.basis, "event");
      assert.equal(proof.projectContext.state, "unknown");
      assert.deepEqual(proof.projectContext.projects, []);
      assert.deepEqual(proof.projectContext.projectScope, []);
      assert.equal(proof.projectContext.observedAt, null);
    }
  }
});

test("current membership pins retain the original receipt while the latest full inventory records empty or unknown", async (t) => {
  const { h, current } = await capturedCurrent(t);
  const first = await profile(h, current);
  const snapshotBefore = (
    await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
      first.snapshotId,
    ])
  ).rows;
  h.setMemberships([null, []]);
  assert.equal((await h.runtime.runOnce({ cutoff: clock() })).state, "published");
  const latest = await profile(h, current);
  assert.notEqual(latest.snapshotId, first.snapshotId);
  const missing = latest.timeline.find((proof) => proof.artifact.publicUrl.endsWith("/issues/1"));
  const empty = latest.timeline.find((proof) => proof.artifact.publicUrl.endsWith("/issues/2"));
  assert.equal(
    missing.projectContext.state,
    "unknown",
    "a missing current subject must not reuse its former membership",
  );
  assert.deepEqual(missing.projectContext.projects, []);
  assert.equal(missing.projectContext.observedAt, null);
  assert.equal(empty.projectContext.state, "known");
  assert.deepEqual(empty.projectContext.projects, []);
  assert.deepEqual(empty.projectContext.projectScope, projectIds);
  const oldPin = await profile(h, current, { snapshot: first.snapshotId });
  assert.deepEqual(
    oldPin.timeline.map((proof) => proof.projectContext),
    first.timeline.map((proof) => proof.projectContext),
  );
  assert.equal(oldPin.evidenceCount, first.evidenceCount);
  assert.deepEqual(
    (
      await h.db.query("SELECT document,document_hash FROM leaderboard_pipeline.snapshots WHERE snapshot_id=$1", [
        first.snapshotId,
      ])
    ).rows,
    snapshotBefore,
  );
  h.setPrivate(true);
  await h.runtime.runOnce({ cutoff: clock() }).catch(() => {});
  const query = new URLSearchParams({ ...publicScopeParameters(current), snapshot: first.snapshotId });
  const denied = await h.runtime.app.inject(`/api/v1/contributors/${first.actorId}?${query}`);
  assert.equal(denied.statusCode, 410, denied.body);
  assert.equal(denied.body.includes("PVT_"), false);
});

test("the public projector independently binds native subject kind, URL, fact and observation cutoff", async (t) => {
  const { h, current, captured } = await capturedCurrent(t);
  const value = await profile(h, current);
  const proof = value.timeline.find((item) => item.artifact.publicUrl.endsWith("/issues/1"));
  const receipt = captured.find((item) => item.subjectId === "SYNTHETIC_ISSUE_1");
  const fact = {
    id: proof.contribution.contributionId,
    artifactId: proof.artifact.stableId,
    repoId: proof.artifact.repositoryId,
  };
  const entry = { family: "project_current", document: { projectContext: receipt } };
  const before = JSON.stringify([entry, proof, fact]);
  const project = createPublicProjectContextProjector([entry], "current", receipt.observedAt);
  assert.deepEqual(project(proof, fact).projectContext, proof.projectContext);
  for (const mutation of [
    (copy) => {
      copy.document.projectContext.subjectKind = "pull_request";
    },
    (copy) => {
      copy.document.projectContext.sourceUrl = "https://github.com/synthetic-org/synthetic-repo/issues/99";
    },
    (copy) => {
      copy.document.projectContext.observedAt = "2099-01-01T00:00:00Z";
    },
  ]) {
    const copy = structuredClone(entry);
    mutation(copy);
    assert.throws(
      () => createPublicProjectContextProjector([copy], "current", receipt.observedAt)(proof, fact),
      /invalid_public_project_context_source/,
    );
  }
  assert.throws(() => project(proof, { ...fact, artifactId: "foreign" }), /invalid_public_project_context_source/);
  assert.throws(
    () => createPublicProjectContextProjector([entry, entry], "current", receipt.observedAt),
    /invalid_public_project_context_source/,
  );
  assert.equal(JSON.stringify([entry, proof, fact]), before);
});
