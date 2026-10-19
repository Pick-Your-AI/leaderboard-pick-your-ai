import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRecognitionReceipt, normalizeGithubObservation } from "../../../packages/github/dist/index.js";
import { materializeRecognition } from "../src/recognition-adapter.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/github/test/fixtures/engineering.json", import.meta.url), "utf8"),
);
const observedAt = "2026-10-08T10:00:00.000Z";
const mergedAt = "2026-10-07T10:00:00.000Z";
const acceptedAt = "2026-10-08T10:00:00.000Z";
const beforeSha = "a".repeat(40);
const mergedSha = "b".repeat(40);
const reviewerIds = ["202"];
const cases = [
  { kind: "open PR", sourceMetricId: "pr_opened" },
  { kind: "closed-unmerged PR", sourceMetricId: "pr_opened" },
  { kind: "issue report", sourceMetricId: "issues_opened" },
  { kind: "merged PR without release proof", sourceMetricId: "pr_merged" },
];

function source(kind) {
  const issue = kind === "issue report";
  const merged = kind === "merged PR without release proof";
  const open = kind === "open PR";
  const resource = issue
    ? { ...structuredClone(fixture.issue), user: fixture.author, state: "open" }
    : {
        ...structuredClone(fixture.pull_request),
        user: fixture.author,
        merged,
        merged_at: merged ? mergedAt : null,
        merge_commit_sha: merged ? mergedSha : null,
        merged_by: merged ? fixture.merger : null,
        state: open ? "open" : "closed",
      };
  return normalizeGithubObservation({
    repository: { id: 2, slug: "synthetic-owner/repository", visibility: "public", defaultBranch: "main" },
    // All payloads and receipt decisions in this file are synthetic. This flag
    // exercises the existing protected host-source arm, not real GitHub evidence.
    proof: {
      verified: true,
      source: "github_webhook",
      revision: mergedAt,
      eventId: "synthetic-release-admission",
      isSynthetic: false,
    },
    family: issue ? "issue" : "pull_request",
    action: issue || open ? "opened" : "closed",
    occurredAt: mergedAt,
    observedAt,
    payload: {
      repository: fixture.repository,
      [issue ? "issue" : "pull_request"]: resource,
      sender: merged ? fixture.merger : fixture.author,
    },
    ...(merged
      ? {
          integration: {
            before: beforeSha,
            after: mergedSha,
            targetBranch: "main",
            defaultBranch: "main",
            canonicalChangeId: "synthetic-accepted-change-10",
            commitShas: [mergedSha],
            diff: {
              before: beforeSha,
              after: mergedSha,
              complete: true,
              files: [{ path: "src/synthetic-change.ts", additions: 1, deletions: 0 }],
            },
          },
        }
      : {}),
  });
}

function target(input, sourceMetricId) {
  const matches = input.facts.filter((fact) => fact.metricId === sourceMetricId && fact.actorId === "101");
  assert.equal(matches.length, 1, "the original normalized source must exist uniquely");
  assert.equal(matches[0].state, "observed");
  return matches[0];
}

function receipt(input, sourceMetricId, metricId = "release_changes") {
  const original = target(input, sourceMetricId);
  return {
    id: `synthetic-${metricId}-decision`,
    verified: true,
    metricId,
    actorId: original.actorId,
    reviewerId: reviewerIds[0],
    acceptedAt,
    decision: "accepted",
    targetFactId: original.id,
    evidenceIds: [original.id],
  };
}

function materialize(input, sourceMetricId, metricId, apply = applyRecognitionReceipt) {
  const original = target(input, sourceMetricId);
  const proof = input.evidence.find((entry) => entry.contribution.contributionId === original.id);
  assert.ok(proof, "the receipt must select its actual normalized public artifact");
  const decision = {
    id: `synthetic-${metricId}-decision`,
    action: "accepted",
    actor: reviewerIds[0],
    at: Date.parse(acceptedAt),
    policyVersion: "synthetic-release-admission-v1",
  };
  const request = {
    id: `synthetic-${metricId}-request`,
    kind: "evidence",
    status: "accepted",
    owner: original.actorId,
    category: `synthetic-${metricId}`,
    scope: "repo",
    policyVersion: decision.policyVersion,
    locator: proof.artifact.publicUrl,
    collaborators: {},
    history: [decision],
  };
  const binding = {
    category: request.category,
    scope: request.scope,
    policyVersion: decision.policyVersion,
    metricId,
    sourceMetricId,
    repositoryId: "2",
    reviewerIds,
  };
  // acceptedAt is the existing generic route that admitted the false positives.
  // Rejection must not rely on an unknown future collector or receipt property.
  const dateBasis = metricId === "maintenance" || metricId === "automation" ? "occurredAt" : "acceptedAt";
  return materializeRecognition(
    input,
    { requests: { [request.id]: request }, profiles: {}, audit: [decision] },
    [binding],
    [
      {
        policy: {
          metricId,
          version: decision.policyVersion,
          dateBasis,
          groupBy: "canonical",
          rankedStates: ["qualified"],
        },
      },
    ],
    apply,
    acceptedAt,
  );
}

for (const { kind, sourceMetricId } of cases) {
  test(`release admission fixture retains the original ${kind} without release evidence`, () => {
    const input = source(kind);
    const original = target(input, sourceMetricId);
    assert.equal(original.actorId, "101");
    assert.equal(original.acceptedAt, null);
    assert.equal(
      input.facts.some((fact) => fact.metricId === "release_changes"),
      false,
    );
    assert.equal(
      input.evidence.some((entry) => entry.artifact.kind === "release"),
      false,
    );
    if (sourceMetricId === "pr_merged") {
      const proof = input.evidence.find((entry) => entry.contribution.contributionId === original.id);
      assert.equal(original.occurredAt, mergedAt);
      assert.equal(proof.sourceRevision, mergedSha);
      assert.equal(original.role, "author");
      assert.ok(input.facts.some((fact) => fact.metricId === "maintainer_merges" && fact.actorId === "202"));
    }
  });

  test(`release changes rejects ${kind} through the direct receipt API`, () => {
    const input = source(kind);
    const prior = structuredClone(input);
    const selected = receipt(input, sourceMetricId);
    assert.throws(
      () => applyRecognitionReceipt(input, selected, reviewerIds),
      Error,
      "independent review cannot manufacture release/tag inclusion from this source",
    );
    assert.deepEqual(input, prior);
  });

  test(`release changes rejects ${kind} through the complete materialization path`, () => {
    const input = source(kind);
    const prior = structuredClone(input);
    assert.throws(
      () => materialize(input, sourceMetricId, "release_changes"),
      Error,
      "the existing receipt route must not qualify a change with no release evidence",
    );
    assert.deepEqual(input, prior);
  });

  test(`release changes rejects ${kind} before invoking a host receipt callback`, () => {
    const input = source(kind);
    const prior = structuredClone(input);
    let calls = 0;
    let failure;
    try {
      materialize(input, sourceMetricId, "release_changes", (...args) => {
        calls += 1;
        return applyRecognitionReceipt(...args);
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(calls, 0, "invalid release inclusion must fail before a host adapter can grant recognition");
    assert.ok(failure instanceof Error, "unsupported release evidence must be rejected explicitly");
    assert.deepEqual(input, prior);
  });
}

for (const metricId of ["maintenance", "automation"]) {
  for (const route of ["direct", "materialized"]) {
    test(`release admission preserves qualified ${metricId} through the ${route} route`, () => {
      const input = source("merged PR without release proof");
      const prior = structuredClone(input);
      const original = target(input, "pr_merged");
      let calls = 0;
      const apply = (...args) => {
        calls += 1;
        return applyRecognitionReceipt(...args);
      };
      const output =
        route === "direct"
          ? apply(input, receipt(input, "pr_merged", metricId), reviewerIds)
          : materialize(input, "pr_merged", metricId, apply);
      const facts = output.facts.filter((fact) => fact.metricId === metricId);
      assert.equal(calls, 1);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].actorId, "101");
      assert.equal(facts[0].role, "author");
      assert.equal(facts[0].state, "qualified");
      assert.equal(facts[0].occurredAt, mergedAt);
      assert.equal(facts[0].acceptedAt, acceptedAt);
      assert.equal(facts[0].acceptedBy, reviewerIds[0]);
      const proof = output.evidence.find((entry) => entry.contribution.contributionId === facts[0].id);
      assert.equal(proof.occurredAt, mergedAt);
      assert.equal(proof.artifact.kind, "pull_request");
      assert.equal(proof.sourceRevision, mergedSha);
      assert.deepEqual(
        output.facts.find((fact) => fact.id === original.id),
        original,
      );
      assert.equal(
        output.facts.some((fact) => fact.metricId === "release_changes"),
        false,
      );
      assert.deepEqual(input, prior);
    });
  }
}
