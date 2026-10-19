import type { EvidenceConsentRecord, EvidenceTerms, StoredEvidenceIntake } from "../src/controls/client.ts";

// Transport fixtures for browser contract tests only. These are not source rights or real consent receipts.
export const syntheticEvidenceTerms: EvidenceTerms = {
  schemaVersion: "evidence-terms/v1",
  version: "evidence-terms/2026-10-19",
  rightsPolicyVersion: "2026-10-18",
  paragraphs: [
    "Synthetic terms: the proposed public claim and attribution require independent review and each participant's consent.",
    "Synthetic removal terms: withdrawal suppresses this service's claim; it does not erase source history or third-party copies.",
  ],
  digest: "b".repeat(64),
};
export function syntheticBrowserIntake(owner: string, collaborators: string[] = []): StoredEvidenceIntake {
  const consent = (actorId: string): EvidenceConsentRecord => ({
    actorId,
    choice: "accepted",
    scope: "public-claim-attribution",
    claimRevision: 1,
    claimDigest: "c".repeat(64),
    role: null,
    termsVersion: syntheticEvidenceTerms.version,
    termsDigest: syntheticEvidenceTerms.digest,
    rightsPolicyVersion: syntheticEvidenceTerms.rightsPolicyVersion,
    at: Date.parse("2026-10-19T00:00:00.000Z"),
  });
  return {
    schemaVersion: "evidence-intake/v1",
    termsVersion: syntheticEvidenceTerms.version,
    termsDigest: syntheticEvidenceTerms.digest,
    rightsPolicyVersion: syntheticEvidenceTerms.rightsPolicyVersion,
    claimRevision: 1,
    claimDigest: "c".repeat(64),
    sourceUseBasis: { state: "unresolved" },
    roles: { submitter: null, collaborators: Object.fromEntries(collaborators.map((id) => [id, null])) },
    period: { kind: "unknown" },
    submitterConsent: consent(owner),
    participantConsents: Object.fromEntries(collaborators.map((id) => [id, consent(id)])),
  };
}
