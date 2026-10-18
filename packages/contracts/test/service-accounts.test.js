import assert from "node:assert/strict";
import test from "node:test";
import { actorSchema, serviceAccountClassificationSchema } from "../dist/index.js";

const classification = {
  schemaVersion: "leaderboard-service-account/v1",
  classificationId: "synthetic-service-account-review-1",
  githubDatabaseId: 101,
  githubNodeId: "U_synthetic_101",
  source: "reviewed_configuration",
  evidenceIds: ["synthetic-reviewed-configuration-revision-1"],
  reviewerActorId: "202",
  reviewedAt: "2026-10-01T00:00:00Z",
};

test("service-account classification requires versioned stable-ID review evidence", () => {
  assert.deepEqual(serviceAccountClassificationSchema.parse(classification), classification);
  assert.equal(serviceAccountClassificationSchema.safeParse({ ...classification, source: "reviewed_source" }).success, true);
  for (const patch of [
    { schemaVersion: "unknown/v1" }, { githubDatabaseId: undefined }, { githubDatabaseId: 0 },
    { githubDatabaseId: Number.MAX_SAFE_INTEGER + 1 }, { githubNodeId: "" }, { classificationId: "" },
    { evidenceIds: [] }, { reviewerActorId: "101" }, { reviewerActorId: "U_synthetic_101" }, { reviewerActorId: "" }, { reviewedAt: "unknown" }, { source: "login_heuristic" },
    { login: "looks-like-a-bot" }, { email: "synthetic@example.invalid" },
  ]) {
    assert.equal(serviceAccountClassificationSchema.safeParse({ ...classification, ...patch }).success, false, JSON.stringify(patch));
  }
});

test("public service-account kind does not expose review receipts or certify execution mode", () => {
  const actor = { schemaVersion: "leaderboard/v1", identityState: "resolved", githubDatabaseId: 101,
    kind: "service_account", executionMode: "unknown" };
  assert.deepEqual(actorSchema.parse(actor), actor);
  assert.equal(actorSchema.safeParse({ ...actor, executionMode: "automated" }).success, true);
  assert.equal(actorSchema.safeParse({ ...actor, executionMode: "manual" }).success, false);
  assert.equal(actorSchema.safeParse({ ...actor, serviceAccountClassification: classification }).success, false);
  // Legacy user means a GitHub User account, not proof of a human or manual work.
  assert.equal(actorSchema.safeParse({ ...actor, kind: "user" }).success, true);
});
