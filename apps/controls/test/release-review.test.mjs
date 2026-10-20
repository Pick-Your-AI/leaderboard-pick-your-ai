import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseReviewTarget, releaseReviewRequest } from "../src/release-review.mjs";

const target = () => ({
  targetFactId: "synthetic-release-change:91",
  releaseId: 84,
  pullRequestNumber: 91,
  proofHash: "e".repeat(64),
  policyVersion: "synthetic-release-v1",
});

test("release review parser returns only a detached exact private target", () => {
  const original = target();
  const parsed = parseReleaseReviewTarget(original);
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed, original);
  original.proofHash = "a".repeat(64);
  assert.equal(parsed.proofHash, "e".repeat(64));
});

test("release review request snapshot binds only the four current reviewed fields", () => {
  const request = {
    owner: "55",
    locator: "https://github.com/synthetic-owner/release-repository/pull/91",
    category: "deployment_work",
    scope: "repository:37:release:84",
    detail: "Synthetic private source discussion",
    session: "synthetic-session",
    collaborators: { 99: "pending" },
  };
  const snapshot = releaseReviewRequest(request);
  assert.deepEqual(snapshot, {
    owner: request.owner,
    locator: request.locator,
    category: request.category,
    scope: request.scope,
  });
  request.scope = "changed";
  assert.equal(snapshot.scope, "repository:37:release:84");
  assert.doesNotMatch(JSON.stringify(snapshot), /detail|session|collaborators/);
});

for (const [name, invalid] of [
  ["null", () => null],
  ["array", () => []],
  ["extra raw proof", () => ({ ...target(), rawProof: "synthetic-private-data" })],
  [
    "missing proof digest",
    () => {
      const value = target();
      delete value.proofHash;
      return value;
    },
  ],
  ["symbolic proof digest", () => ({ ...target(), proofHash: "latest" })],
  ["short proof digest", () => ({ ...target(), proofHash: "e".repeat(63) })],
  ["uppercase proof digest", () => ({ ...target(), proofHash: "E".repeat(64) })],
  ["string release identity", () => ({ ...target(), releaseId: "84" })],
  ["zero release identity", () => ({ ...target(), releaseId: 0 })],
  ["unsafe release identity", () => ({ ...target(), releaseId: Number.MAX_SAFE_INTEGER + 1 })],
  ["negative PR number", () => ({ ...target(), pullRequestNumber: -1 })],
  ["fractional PR number", () => ({ ...target(), pullRequestNumber: 1.5 })],
  ["nonfinite PR number", () => ({ ...target(), pullRequestNumber: Infinity })],
  ["boolean PR number", () => ({ ...target(), pullRequestNumber: true })],
  ["empty policy identity", () => ({ ...target(), policyVersion: "" })],
  ["oversized fact identity", () => ({ ...target(), targetFactId: "x".repeat(201) })],
  ["unsafe fact identity", () => ({ ...target(), targetFactId: "untrusted/../../fact" })],
  ["array policy identity", () => ({ ...target(), policyVersion: ["synthetic-release-v1"] })],
  ["accessor field", () => Object.defineProperty(target(), "releaseId", { enumerable: true, get: () => 84 })],
  ["hidden field", () => Object.defineProperty(target(), "releaseId", { enumerable: false, value: 84 })],
]) {
  test(`release review parser rejects ${name}`, () => {
    assert.throws(() => parseReleaseReviewTarget(invalid()), /^Error: Invalid release review target$/);
  });
}
