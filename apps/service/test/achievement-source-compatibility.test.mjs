import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { achievementProofSchema, achievementMilestoneSchema } from "@pick-your-ai/contracts";
import { normalizeGithubObservation, applyRecognitionReceipt } from "../../../packages/github/dist/index.js";
import { createService } from "../dist/app.js";
import { milestoneFixture } from "./fixtures/achievement-milestones.mjs";
import { evidence, selection } from "../../web/src/remote/client.ts";
import { achievements, cardHref } from "../../web/src/remote/recognition-client.ts";

// Fictional opaque source identities, not real objects or source authorization.
const opaqueId = Buffer.from("011:PullRequest10").toString("base64");
const compatibleIds = [opaqueId, "opaque/source+identity==", "x".repeat(201), "x".repeat(2048)];
const query = "?snapshot=synthetic-milestones&limit=20";
const selected = selection(query);
function fixture(artifactId = opaqueId) {
  const value = milestoneFixture();
  for (const collection of [value.selected.evidence, value.selected.portfolioEvidence]) {
    for (const entry of collection) {
      if (entry.artifact.stableId !== "synthetic-pr-1") continue;
      entry.artifact.stableId = artifactId;
      entry.contribution.artifactId = artifactId;
    }
  }
  return value;
}
function service(t, value, version = "accepted-evidence/v2") {
  const app = createService({
    approvedAchievementRuleVersion: version,
    cursorSecret: "synthetic-opaque-artifact-secret-000000",
    source: {
      read: async (scope) => ({ ...structuredClone(value), selected: { ...structuredClone(value.selected), scope } }),
    },
  });
  t.after(() => app.close());
  return app;
}
async function awards(app) {
  return app.inject("/api/v1/contributors/alex/achievements" + query);
}

async function normalizedArtifact(artifactId, retired = false) {
  const input = JSON.parse(
    await readFile(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
  );
  return normalizeGithubObservation({
    repository: {
      id: 2,
      slug: "synthetic-owner/repository",
      visibility: retired ? "private" : "public",
      defaultBranch: "main",
    },
    proof: {
      verified: true,
      source: "github_webhook",
      revision: "synthetic-source-revision",
      eventId: "synthetic-opaque-event",
      isSynthetic: true,
    },
    family: "pull_request",
    action: "closed",
    occurredAt: "2026-10-07T10:00:00Z",
    observedAt: "2026-10-08T10:00:00Z",
    decisionCohort: {
      verified: true,
      asOf: "2026-10-08T10:00:00Z",
      outcome: "merged",
      decisionAt: "2026-10-07T10:00:00Z",
    },
    frozenCutoff: "2026-10-08T10:00:00Z",
    payload: {
      repository: { ...input.repository, private: retired },
      sender: input.merger,
      pull_request: { ...input.pull_request, node_id: artifactId, user: input.author, merged_by: input.merger },
    },
  });
}

test("the actual GitHub normalizer and accepted-receipt adapter retain a padded opaque artifact ID", async () => {
  assert.match(opaqueId, /=+$/);
  const normalized = await normalizedArtifact(opaqueId);
  const target = normalized.facts.find((fact) => fact.metricId === "pr_merged");
  assert.ok(target);
  assert.equal(target.artifactId, opaqueId);
  const accepted = applyRecognitionReceipt(
    normalized,
    {
      id: "synthetic-independent-receipt",
      verified: true,
      metricId: "pr_merged",
      actorId: "101",
      reviewerId: "303",
      acceptedAt: "2026-10-08T10:00:00Z",
      decision: "accepted",
      targetFactId: target.id,
      evidenceIds: [target.id],
    },
    ["303"],
  );
  const proof = accepted.evidence.find((entry) =>
    entry.contribution.reasonCodes.includes("independent_recognition_receipt"),
  );
  assert.ok(proof);
  assert.equal(proof.artifact.stableId, opaqueId);
  assert.equal(proof.contribution.artifactId, opaqueId);
  assert.equal(proof.contribution.qualification, "eligible");
  assert.equal(proof.evidenceMetadata.activityState, "accepted");
});

test("public proof and v1 service preserve opaque artifacts beyond the navigation-ID size and alphabet", async (t) => {
  for (const artifactId of compatibleIds) {
    const app = service(t, fixture(artifactId), "accepted-evidence/v1");
    const proof = await app.inject("/api/v1/evidence/alex-authored" + query);
    assert.equal(proof.statusCode, 200, proof.body);
    assert.equal(evidence(proof.json(), selected).artifact.stableId, artifactId);
    assert.equal(proof.json().contribution.artifactId, artifactId);
    const response = await awards(app);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().achievements[0].artifactIds[0], artifactId);
  }
});

test("v1 browser accepts the same exact opaque artifact identity as its actual public service", async (t) => {
  for (const artifactId of compatibleIds) {
    const response = await awards(service(t, fixture(artifactId), "accepted-evidence/v1"));
    assert.equal(response.statusCode, 200, response.body);
    const parsed = achievements(response.json(), selected, "alex");
    assert.equal(parsed.achievements[0].artifactIds[0], artifactId);
  }
});

test("v2 service and browser retain opaque proof and milestone identities without losing shared-artifact pairs", async (t) => {
  for (const artifactId of compatibleIds) {
    const response = await awards(service(t, fixture(artifactId)));
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.achievements[0].artifactIds[0], artifactId);
    assert.equal(data.achievements[0].proof.artifactId, artifactId);
    const parsed = achievements(data, selected, "alex");
    assert.equal(parsed.totalCoContributions, 3);
    assert.equal(parsed.coContributions.length, 3);
    const pairs = parsed.coContributions.filter((pair) => pair.subject.artifactId === artifactId);
    assert.equal(pairs.length, 2);
    for (const pair of pairs) {
      assert.equal(pair.peerProof.artifactId, artifactId);
      assert.equal(pair.subject.sourceUrl, "https://github.com/synthetic-milestones/example/pull/1");
    }
  }
});

test("actual source artifact retirement withholds public proof, invalidates old pages and retains unrelated awards", async (t) => {
  for (const artifactId of compatibleIds) {
    const retired = await normalizedArtifact(artifactId, true);
    assert.deepEqual(retired.suppressArtifactIds, [artifactId]);
    const value = fixture(artifactId);
    const current = service(t, value);
    const legacy = service(t, value, "accepted-evidence/v1");
    const pageQuery = "?snapshot=synthetic-milestones&limit=2";
    const first = await current.inject("/api/v1/contributors/alex/achievements" + pageQuery);
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(first.json().nextCursor);
    value.controls.suppressedArtifactIds = retired.suppressArtifactIds;
    assert.equal(value.controls.version, "synthetic-controls-1");
    const stale = await current.inject(
      "/api/v1/contributors/alex/achievements" + pageQuery + "&cursor=" + first.json().nextCursor,
    );
    assert.equal(stale.statusCode, 400, stale.body);
    assert.equal(stale.json().error, "cursor_scope_mismatch");
    for (const app of [current, legacy]) {
      const hidden = await app.inject("/api/v1/evidence/alex-authored" + query);
      assert.equal(hidden.statusCode, 404, hidden.body);
      const response = await awards(app);
      assert.equal(response.statusCode, 200, response.body);
      const parsed = achievements(response.json(), selected, "alex");
      assert.equal(parsed.achievements[0].evidenceIds[0], "alex-reviewed");
      assert.equal(JSON.stringify(parsed).includes(JSON.stringify(artifactId)), false);
      if (parsed.ruleVersion === "accepted-evidence/v2") {
        assert.equal(parsed.totalCoContributions, 1);
        assert.equal(parsed.coContributions[0].peer.actorId, "dev");
      }
    }
  }
});

test("noncanonical source control spelling stays fail-closed instead of silently rewriting suppression authority", async (t) => {
  const raw = " \t" + opaqueId + "\n ";
  const retired = await normalizedArtifact(raw, true);
  assert.deepEqual(retired.suppressArtifactIds, [raw]);
  const value = fixture(raw);
  const app = service(t, value, "accepted-evidence/v1");
  const proof = await app.inject("/api/v1/evidence/alex-authored" + query);
  assert.equal(proof.statusCode, 200, proof.body);
  assert.equal(proof.json().artifact.stableId, opaqueId);
  assert.equal(proof.json().contribution.artifactId, opaqueId);
  value.controls.suppressedArtifactIds = retired.suppressArtifactIds;
  const unavailable = await awards(app);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error, "public_projection_unavailable");
});

test("artifact suppression retains list bounds and never widens actor or snapshot control identity", async (t) => {
  for (const [field, ids] of [
    ["suppressedActorIds", [opaqueId]],
    ["revokedSnapshotIds", [opaqueId]],
    ["suppressedArtifactIds", "wrong-list-shape"],
    ["suppressedArtifactIds", [null]],
    ["suppressedArtifactIds", [""]],
    ["suppressedArtifactIds", ["x".repeat(2_000_001)]],
    ["suppressedArtifactIds", Array(20_001).fill(opaqueId)],
  ]) {
    const value = milestoneFixture();
    value.controls[field] = ids;
    const response = await awards(service(t, value));
    assert.equal(response.statusCode, 503, field);
    assert.equal(response.json().error, "public_projection_unavailable", field);
  }
});

test("artifact-only wire validation preserves opaque public spelling and the existing response-size envelope", async (t) => {
  const response = await awards(service(t, milestoneFixture()));
  assert.equal(response.statusCode, 200, response.body);
  const award = response.json().achievements[0];
  const supplied = (artifactId) => ({ ...award, artifactIds: [artifactId], proof: { ...award.proof, artifactId } });
  for (const artifactId of [".", "..", "opaque é /+=\nvalue", "x".repeat(2_000_000)]) {
    const result = achievementMilestoneSchema.parse(supplied(artifactId));
    assert.equal(result.artifactIds[0], artifactId);
    assert.equal(result.proof.artifactId, artifactId);
  }
  for (const artifactId of [null, 1, [], {}, "", " x", "x ", "x".repeat(2_000_001)]) {
    assert.equal(achievementMilestoneSchema.safeParse(supplied(artifactId)).success, false);
    assert.equal(achievementProofSchema.safeParse({ ...award.proof, artifactId }).success, false);
  }
  const oversized = await awards(service(t, fixture("x".repeat(250_000))));
  assert.equal(oversized.statusCode, 503);
  assert.equal(oversized.json().error, "achievement_response_too_large");
});

test("opaque artifact compatibility never relaxes actor, contribution, repository or source URL checks", async (t) => {
  const response = await awards(service(t, milestoneFixture()));
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  for (const field of ["contributionId", "canonicalEventId", "actorId", "repositoryId"]) {
    assert.equal(achievementProofSchema.safeParse({ ...data.achievements[0].proof, [field]: opaqueId }).success, false);
  }
  assert.throws(() => cardHref("/api/v1", selected, "synthetic-milestones", opaqueId, "pr_merged"));
  const legacy = await awards(service(t, milestoneFixture(), "accepted-evidence/v1"));
  const invalid = legacy.json();
  invalid.achievements[0].evidenceIds = [opaqueId];
  assert.throws(() => achievements(invalid, selected, "alex"));
  for (const sourceUrl of ["javascript:alert(1)", "https://github.com/synthetic/example/pull/1?private=1"]) {
    assert.equal(achievementProofSchema.safeParse({ ...data.achievements[0].proof, sourceUrl }).success, false);
  }
});

test("v2 source-time reader preserves equal cutoff spellings and rejects a future sub-millisecond proof", async (t) => {
  const response = await awards(service(t, milestoneFixture()));
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  data.achievements = data.achievements.slice(0, 1);
  data.coContributions = [];
  data.totalCoContributions = 0;
  data.nextCursor = null;
  for (const occurredAt of ["2026-10-17T12:00:00.0000Z", "2026-10-17T08:00:00.000-04:00"]) {
    data.achievements[0].occurredAt = occurredAt;
    data.achievements[0].proof.occurredAt = occurredAt;
    assert.equal(achievements(data, selected, "alex").achievements[0].occurredAt, occurredAt);
  }
  for (const occurredAt of ["2026-10-17T12:00:00.0001Z", "2026-10-17T08:00:00.0001-04:00"]) {
    data.achievements[0].occurredAt = occurredAt;
    data.achievements[0].proof.occurredAt = occurredAt;
    assert.throws(() => achievements(data, selected, "alex"), { status: 502, code: "invalid_recognition_response" });
  }
});
