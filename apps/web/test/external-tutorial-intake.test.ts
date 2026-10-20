import assert from "node:assert/strict";
import test from "node:test";
import {
  canAcceptEvidence,
  evidenceSubmissionInput,
  verifiedExternalTutorialTerms,
  type EvidenceTerms,
  type Receipt,
} from "../src/controls/client.ts";

const terms: EvidenceTerms = {
  schemaVersion: "evidence-terms/v1",
  version: "evidence-terms/2026-10-19",
  rightsPolicyVersion: "2026-10-18",
  paragraphs: ["Synthetic legacy terms for client boundary tests."],
  digest: "b".repeat(64),
};
const tutorialTerms: EvidenceTerms = {
  ...terms,
  version: "evidence-terms/external-tutorial/2026-10-20",
  paragraphs: ["Synthetic consent-only tutorial terms; no source approval or public credit."],
  digest: "d".repeat(64),
};
const carrier = "https://github.com/synthetic/fixtures/blob/" + "a".repeat(40) + "/tutorial.json";
function form(patch: Record<string, string> = {}) {
  const data = new FormData();
  for (const [name, value] of Object.entries({
    externalTutorial: "on",
    locator: carrier,
    category: "other",
    scope: "Synthetic tutorial attribution",
    detail: "PRIVATE_TUTORIAL_REVIEW",
    collaborators: "9007199254740993",
    submitterRoleChoice: "described",
    submitterRole: "Declared author",
    "participantRole-9007199254740993Choice": "unknown",
    periodKind: "unknown",
    sourceUseState: "unresolved",
    tutorialUrl: "https://tutorial.example.invalid/lesson?id=stable",
    tutorialRevision: "revision-one",
    tutorialHash: "c".repeat(64),
    manifestHash: "e".repeat(64),
    tutorialPublishedAt: "",
    consent: "on",
    ...patch,
  }))
    data.set(name, value);
  return data;
}

test("tutorial form keeps stable identity separate from exact pins and includes every proposed attribution", () => {
  const result = evidenceSubmissionInput(form(), terms, "1", ["other"], tutorialTerms);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.intake.externalTutorial, {
    schemaVersion: "external-tutorial-declaration/v1",
    canonicalUrl: "https://tutorial.example.invalid/lesson?id=stable",
    revision: { id: "revision-one", contentSha256: "c".repeat(64) },
    manifest: { locator: carrier, contentSha256: "e".repeat(64) },
    publishedAt: null,
    attribution: [
      { actorId: "1", role: "Declared author" },
      { actorId: "9007199254740993", role: null },
    ],
  });
  assert.equal(result.value.intake.schemaVersion, "evidence-intake/external-tutorial/v1");
  assert.equal(result.value.intake.termsDigest, tutorialTerms.digest);
  assert.equal(Object.hasOwn(result.value.intake, "participantConsents"), false);
  assert.doesNotMatch(JSON.stringify(result.value.intake.externalTutorial), /PRIVATE_TUTORIAL/);
});

test("tutorial form capability and profile terms are required without changing ordinary evidence output", () => {
  assert.equal(evidenceSubmissionInput(form(), terms, "1", ["other"]).ok, false);
  assert.equal(verifiedExternalTutorialTerms(tutorialTerms), tutorialTerms);
  assert.throws(() => verifiedExternalTutorialTerms(terms), /terms are unavailable/);
  const result = evidenceSubmissionInput(form({ externalTutorial: "" }), terms, "1", ["other"], tutorialTerms);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.intake, {
    schemaVersion: "evidence-intake/v1",
    termsVersion: terms.version,
    termsDigest: terms.digest,
    sourceUseBasis: { state: "unresolved" },
    roles: { submitter: "Declared author", collaborators: { "9007199254740993": null } },
    period: { kind: "unknown" },
  });
});

test("tutorial client rejects malformed identity, pin, time and consent before sending a request", () => {
  for (const [patch, field] of [
    [{ tutorialUrl: "http://tutorial.example.invalid/lesson" }, "tutorialUrl"],
    [{ tutorialUrl: "https://tutorial.example.invalid/lesson#" }, "tutorialUrl"],
    [{ tutorialUrl: "https://user:secret@tutorial.example.invalid/lesson" }, "tutorialUrl"],
    [{ locator: carrier.replace("a".repeat(40), "main") }, "locator"],
    [{ locator: carrier + "?" }, "locator"],
    [{ tutorialHash: "short" }, "tutorialHash"],
    [{ manifestHash: "F".repeat(64) }, "manifestHash"],
    [{ tutorialRevision: "" }, "tutorialRevision"],
    [{ tutorialPublishedAt: "2026-02-30T00:00:00Z" }, "tutorialPublishedAt"],
    [{ category: "mentorship" }, "category"],
    [{ consent: "" }, "consent"],
  ] as Array<[Record<string, string>, string]>) {
    const result = evidenceSubmissionInput(form(patch), terms, "1", ["other", "mentorship"], tutorialTerms);
    assert.equal(result.ok, false, field);
    if (!result.ok) assert.ok(result.errors[field], field);
  }
  const known = evidenceSubmissionInput(
    form({ tutorialPublishedAt: "2026-10-18T12:30:00Z" }),
    terms,
    "1",
    ["other"],
    tutorialTerms,
  );
  assert.equal(known.ok, true);
  if (known.ok) assert.equal(known.value.intake.externalTutorial?.publishedAt, "2026-10-18T12:30:00Z");
});

test("tutorial intake never exposes the ordinary acceptance affordance even with forged review eligibility", () => {
  const result = evidenceSubmissionInput(form(), terms, "1", ["other"], tutorialTerms);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const receipt = {
    kind: "evidence",
    status: "pending",
    intake: { ...result.value.intake, claimRevision: 1, claimDigest: "c".repeat(64) },
    intakeEligibility: { state: "awaiting_review" },
  } as Receipt;
  assert.equal(canAcceptEvidence(receipt), false);
});
