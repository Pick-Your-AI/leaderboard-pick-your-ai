import test from "node:test";
import assert from "node:assert/strict";
import { nominateSpotlight, decideSpotlight, projectSpotlights } from "../../controls/src/editorial.mjs";
import { attachSyntheticEvidenceState } from "../../../tests/fixtures/evidence-intake.mjs";
import { spotlights } from "../src/remote/recognition-client.ts";

function reviewedProjection(explanation = "Reviewed synthetic contribution") {
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const claim = {
    id: "synthetic-claim",
    owner: "1",
    kind: "evidence",
    status: "accepted",
    version: 2,
    collaborators: {},
    locator: "https://github.com/synthetic/example/issues/1",
    category: "governance",
    scope: "One synthetic governance decision",
    detail: "Synthetic source-use detail",
    policyVersion: "synthetic-editorial-1",
    history: [],
  };
  claim.history.push({
    id: "synthetic-independent-claim-review",
    receipt: claim.id,
    actor: "2",
    action: "accepted",
    version: 2,
    at: now - 2000,
    policyVersion: claim.policyVersion,
  });
  const state = {
    profiles: { 1: { public: true, bio: "Consented synthetic profile" } },
    requests: { [claim.id]: claim },
    audit: structuredClone(claim.history),
  };
  attachSyntheticEvidenceState(state);
  const nomination = nominateSpotlight(
    state,
    { actorId: "1", roles: [] },
    { claimId: claim.id, consent: true },
    now - 1000,
  );
  decideSpotlight(
    state,
    { actorId: "2", roles: ["reviewer"] },
    nomination.id,
    {
      version: 1,
      action: "accept",
      reason: "Private editorial decision",
      publicExplanation: explanation,
      conflict: false,
    },
    now,
  );
  return JSON.parse(JSON.stringify(projectSpotlights(state, () => true)));
}

for (const [label, whitespace] of [
  ["line feed", "\n"],
  ["carriage return", "\r"],
  ["CRLF", "\r\n"],
  ["tab", "\t"],
]) {
  test(`the public client reads an actually reviewed explanation containing ${label}`, () => {
    const explanation = `Reviewed synthetic contribution.${whitespace}Its selection has a public reason.`;
    const response = reviewedProjection(explanation);
    assert.equal(response.spotlights.length, 1);
    const [selected] = spotlights(response);
    assert.equal(selected.selectionExplanation, explanation);
    assert.equal(selected.bio, "Consented synthetic profile");
    assert.equal(selected.sourceUrl, "https://github.com/synthetic/example/issues/1");
    assert.doesNotMatch(JSON.stringify(selected), /Private editorial decision|source-use detail/);
  });
}

test("public explanations retain the service's exact character bound and reject invalid display values", () => {
  const explanation = "a".repeat(499) + "\n" + "b".repeat(500);
  assert.equal(spotlights(reviewedProjection(explanation))[0].selectionExplanation, explanation);
  const response = reviewedProjection();
  for (const invalid of ["", " ", "\t", "\n", "\r\n", "a".repeat(1001), null, false, 1, [], {}]) {
    const changed = structuredClone(response);
    changed.spotlights[0].selectionExplanation = invalid;
    assert.throws(() => spotlights(changed), { status: 502, code: "invalid_recognition_response" });
  }
  assert.throws(() => reviewedProjection("a".repeat(1001)), { status: 400 });
});

test("both editorial admission and the public client reject forbidden explanation controls", () => {
  const response = reviewedProjection();
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
    if ([9, 10, 13].includes(code)) continue;
    const explanation = `Before${String.fromCharCode(code)}after`;
    assert.throws(() => reviewedProjection(explanation), { status: 400 }, `producer control ${code}`);
    const changed = structuredClone(response);
    changed.spotlights[0].selectionExplanation = explanation;
    assert.throws(
      () => spotlights(changed),
      { status: 502, code: "invalid_recognition_response" },
      `consumer control ${code}`,
    );
  }
});

test("explanation whitespace does not relax spotlight identities, links, categories, timestamps or profile text", () => {
  const response = reviewedProjection();
  for (const field of ["id", "actorId", "claimId", "sourceUrl", "category", "selectedAt", "bio"]) {
    for (const whitespace of ["\t", "\n", "\r"]) {
      const changed = structuredClone(response);
      changed.spotlights[0][field] += whitespace;
      assert.throws(() => spotlights(changed), { status: 502, code: "invalid_recognition_response" }, field);
    }
  }
});
