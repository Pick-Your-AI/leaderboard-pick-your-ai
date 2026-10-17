import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  actorSchema,
  artifactLineageSchema,
  artifactSchema,
  attributionSchema,
  coverageSchema,
  identityCorrectionSchema,
  metricResultSchema,
  snapshotSchema,
  sourceEventSchema,
} from "../dist/index.js";

const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../../../tests/fixtures/contracts/v1/${name}`, import.meta.url),
      "utf8",
    ),
  );

test("login alone is not a stable actor identity and email is rejected", () => {
  const loginOnly = {
    schemaVersion: "leaderboard/v1",
    identityState: "resolved",
    login: "synthetic-user",
    kind: "user",
    executionMode: "unknown",
  };
  assert.equal(actorSchema.safeParse(loginOnly).success, false);
  assert.equal(
    actorSchema.safeParse({
      ...loginOnly,
      identityState: "unresolved",
      email: "synthetic@example.invalid",
    }).success,
    false,
  );
});

test("public artifact requirements and ambiguous missing-source event are explicit", async () => {
  assert.equal(
    artifactSchema.safeParse({
      schemaVersion: "leaderboard/v1",
      source: "github",
      kind: "issue",
      visibility: "public",
    }).success,
    false,
  );
  const event = await fixture("ambiguous-event.json");
  assert.equal(sourceEventSchema.safeParse(event).success, true);
  assert.equal(event.occurredAt, null);
  assert.equal(event.actor.identityState, "unresolved");
});

test("verified attribution requires evidence and coverage gaps cannot be complete", async () => {
  assert.equal(
    attributionSchema.safeParse({
      schemaVersion: "leaderboard/v1",
      state: "verified",
      actorId: "actor:1",
      role: "author",
      evidenceEventIds: [],
      method: "stable_source_actor_id",
    }).success,
    false,
  );
  const missingSource = await fixture("missing-source.json");
  assert.equal(coverageSchema.safeParse(missingSource).success, true);
  assert.equal(
    coverageSchema.safeParse({ ...missingSource, state: "complete" }).success,
    false,
  );
});

test("identity corrections and artifact lineage require review evidence", () => {
  const correction = {
    schemaVersion: "leaderboard/v1",
    correctionId: "correction:synthetic:1",
    kind: "merge",
    state: "accepted",
    subjectActorIds: ["actor:old"],
    resultActorIds: ["actor:canonical"],
    evidenceEventIds: [],
    reviewerActorId: null,
    reviewedAt: null,
    supersedesCorrectionId: null,
  };
  assert.equal(identityCorrectionSchema.safeParse(correction).success, false);
  assert.equal(
    identityCorrectionSchema.safeParse({
      ...correction,
      evidenceEventIds: ["event:reviewed"],
      reviewerActorId: "actor:reviewer",
      reviewedAt: "2026-01-05T00:00:00Z",
    }).success,
    true,
  );
  assert.equal(
    artifactLineageSchema.safeParse({
      schemaVersion: "leaderboard/v1",
      lineageId: "lineage:synthetic:1",
      relation: "cherry_pick_of",
      sourceArtifactIds: ["commit:source"],
      targetArtifactId: "commit:target",
      state: "verified",
      evidenceEventIds: [],
    }).success,
    false,
  );
});

test("an incomplete zero is rejected while a complete zero is valid", async () => {
  const incompleteZero = await fixture("incomplete-zero.json");
  assert.equal(metricResultSchema.safeParse(incompleteZero).success, false);
  const completeZero = {
    ...incompleteZero,
    coverage: {
      ...incompleteZero.coverage,
      state: "complete",
      missingPages: 0,
      lastSuccessfulSync: "2026-02-01T00:00:00Z",
    },
  };
  assert.equal(metricResultSchema.safeParse(completeZero).success, true);
  assert.equal(
    metricResultSchema.safeParse({
      ...completeZero,
      coverage: { ...completeZero.coverage, scopeId: null },
    }).success,
    false,
  );
});

test("snapshot contract rejects a universal score field", () => {
  const snapshot = {
    schemaVersion: "leaderboard/v1",
    snapshotId: "snapshot:synthetic:1",
    revision: 1,
    generatedAt: "2026-02-01T00:00:00Z",
    metricDefinitionVersion: "leaderboard-metrics/v1",
    computationVersion: "candidate-0.1.0",
    coverage: [],
    results: [],
    universalScore: 100,
  };
  assert.equal(snapshotSchema.safeParse(snapshot).success, false);
});
