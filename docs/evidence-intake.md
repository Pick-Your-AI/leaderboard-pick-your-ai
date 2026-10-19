# Evidence intake and scoped attribution

The protected contributor controls accept an optional claim only after its submitter has seen the current terms and made an explicit choice. Each proposed collaborator makes a separate choice for that claim. An independent reviewer then decides whether the source may support the claim. Submission and consent supply review inputs; they do not create qualified contribution credit.

This implements the intake portion of [LB-10.02](DELIVERY_PLAN.md#lb-1002-create-evidence-submission-and-consent-flow), under the accepted [contributor-rights policy](evidence-contributor-rights.md), version `2026-10-18`. The existing [controls authentication and authorization](contributor-controls.md) and [recognition admission](recognition-runtime.md) remain applicable.

## What a contributor sees

The evidence form collects a public GitHub artifact locator, contribution category, public claim summary, private supporting detail and the stable account IDs of proposed collaborators. The submitter records a known source-use basis or explicitly marks it unresolved. Proposed roles may be unknown. Requested contribution dates may be a date, a date interval or unknown. The form never infers a role or date from a name, repository activity or successful workflow.

Before the explicit consent checkbox, the form displays the server's complete current terms. These explain the claim's possible public fields, the private review inputs, independent review, each participant's choice, withdrawal, retained-data deletion and the limits of removing third-party copies. No consent box is preselected.

An invitee sees the public claim, source locator, category, all proposed participant IDs, requested period and their own proposed role. The submitter's private detail, source-use statement, other participants' roles, consent records and review rationale are excluded. Seeing an invitation does not grant access to the full private receipt.

Decline remains available when a legacy record lacks current terms. An owner can amend or withdraw an old record. The forms treat malformed historical intake as requiring an update; it cannot prevent the recovery controls from rendering. A failed terms-only read prevents new affirmative submission or amendment until current terms are available, while existing receipts, decline, withdrawal and correction/privacy request paths remain available. Authentication and role failures still clear protected state.

## Versioned request contract

`GET /controls/evidence-terms` is authenticated and returns `{ terms }`. Its object contains `schemaVersion: "evidence-terms/v1"`, version `evidence-terms/2026-10-19`, the rights-policy version, all displayed paragraphs and a SHA-256 digest of the canonical content. Callers receive a defensive copy. Reading terms creates no consent or audit receipt.

Evidence submission and owner amendment require `consent: true` plus an `intake` object:

```json
{
  "schemaVersion": "evidence-intake/v1",
  "termsVersion": "evidence-terms/2026-10-19",
  "termsDigest": "<digest returned with the displayed terms>",
  "sourceUseBasis": { "state": "unresolved" },
  "roles": {
    "submitter": null,
    "collaborators": { "123": null }
  },
  "period": { "kind": "unknown" }
}
```

The example is a schema illustration, not evidence or consent from account `123`. The role map must contain exactly the proposed collaborator IDs. IDs must be unique, the verified submitter cannot also appear in that list, and the existing maximum is 20 collaborators.

| Field | Accepted alternatives and bounds |
| --- | --- |
| `sourceUseBasis` | `{ state: "unresolved" }` or `{ state: "declared", statement }`; a declared statement contains 1–1,000 characters. |
| Own and collaborator roles | `null` for unknown, or 1–200 characters for each proposed role. |
| `period` | `{ kind: "unknown" }`, `{ kind: "date", date: "YYYY-MM-DD" }`, or `{ kind: "interval", start, end }`. Dates must exist in the calendar, and the interval must be ordered. |
| Public claim summary | The existing 300-character limit. |
| Private supporting detail | The existing 2,000-character limit. |
| Source locator | The existing 2,048-character GitHub HTTPS artifact restriction, without userinfo or custom ports. |

Unexpected keys, unsupported terms or schema versions, mismatched digests and invalid role/date shapes are rejected before state changes. The server never fetches user-supplied locators or review references. A requested date remains a review input; it does not override the original source event clock used by a metric.

## Claim identity and individual consent

The server assigns a `claimRevision` and computes a `claimDigest` over the receipt identity, authenticated owner, locator, category, public summary, proposed collaborator IDs, requested period, terms identity, rights-policy version and claim revision. Each consent receipt additionally binds the participant's own proposed role.

The receipt records the authenticated actor, accepted or declined choice, `public-claim-attribution` scope, claim revision and digest, own role, terms version and digest, rights-policy version and server timestamp. The browser cannot supply the actor, role authority or timestamp. Current stored consent must exactly match these fields; a later acceptance time cannot precede a required consent.

The ordinary request `version` advances on recorded participant choices and review decisions. The `claimRevision` advances only when the owner amends the claim. Thus different participants can consent sequentially to one unchanged claim, while optimistic request versions still prevent stale actions.

An affirmative collaborator request supplies:

```json
{
  "version": 3,
  "consent": true,
  "claimDigest": "<exact invitation claim digest>",
  "termsVersion": "<exact displayed invitation terms version>",
  "termsDigest": "<exact displayed invitation terms digest>"
}
```

A decline supplies only `{ version, consent: false }`. A stale version, claim or terms identity returns a conflict and requires an explicit reload; the client does not silently retry a choice against changed text. A choice for an identical-looking second receipt cannot authorize the first receipt.

Owner amendment records fresh submitter consent, advances claim identity, returns the claim to pending and invalidates prior affirmative collaborator consent. Previous input and consent stay in protected amendment history. A carried decline retains its original timestamp and scope; carrying it forward does not manufacture a new choice. Every currently listed collaborator must consent before acceptance.

## Independent source-use decision

The reviewer must have current authenticated review authority, be independent of the submitter and all listed collaborators, declare no conflict and use an approved recognition policy. The receipt must be pending or appealed; intake eligibility alone cannot reopen an earlier decision. Acceptance also requires `sourceReviewedPublic: true` and a `sourceUseReview` object:

```json
{
  "disposition": "permitted",
  "rationale": "<reviewer's actual source-use reasoning>",
  "references": [
    { "locator": "<bounded GitHub HTTPS reference>", "revision": "<reviewed reference version>" }
  ]
}
```

The rationale is limited to 1,000 characters. There must be one to five references, each with a safe bounded locator and a nonempty version of at most 128 characters. Rejection, rollback and duplicate-merge actions cannot create a source-use permission record.

The server records the decision with the authenticated reviewer ID, current role-roster version, decision time, current claim and terms identity, rights and recognition policy versions, conflict and public-source declarations, and a digest of the complete protected review input. That digest includes the private supporting detail, source-use statement and proposed roles as well as the claim identity. Altered protected inputs invalidate the decision even when the public summary is unchanged.

A reviewer may resolve a submitter's explicitly unresolved source-use basis through an actual supported decision. The original unresolved declaration stays unchanged. A checked public-source box, a submitted declaration or a reference string alone does not supply that independent authority. The package does not fetch a reference, infer ownership or certify a license automatically.

## Eligibility, legacy records and withdrawal

Protected receipts expose `intakeEligibility` as a derived explanation. It does not rewrite the historical receipt state or replace the ordinary terminal-state, authorization and privacy checks.

| State | Meaning and recovery |
| --- | --- |
| `updated_intake_required` | Current structured intake or submitter consent is absent, malformed or stale. The owner presents it through amendment. |
| `participant_consent_required` | At least one currently required collaborator lacks valid affirmative consent. Participants make their own choices, or the owner amends the scope. |
| `awaiting_review` | Current consent exists but this receipt has no current accepted decision. Its ordinary receipt state determines which review action is available. |
| `source_use_review_required` | A stored accepted receipt lacks a matching independent source-use decision. Owner amendment or appeal, or an eligible independent rollback, returns it to review before fresh permitted acceptance. |
| `eligible` | The accepted receipt has current intake, individual consent and a matching independent source-use decision. Publication still applies privacy and other recognition rules. |

An older accepted receipt cannot bypass intake because its collaborator map is empty or every old collaborator flag says accepted. The controls public read narrows even an already saved public row against current private authority. Editorial nomination, approval and public reading apply the same gate. Neither startup nor reading fabricates intake, permission, dates or participant choices.

Recognition authority includes `manual-evidence-intake/v1` and the current terms/rights identity whenever manual evidence exists, including legacy owner-only and withdrawn claims. Earlier manual publications and confirmations must be reconciled under current authority. Configurations with no manual evidence retain their existing authority, subject to their independently applicable metric rules. The interrupted-dispatch guard preserves old operations and confirmations instead of relabeling their payload as newly reviewed.

Decline or owner withdrawal removes the affected optional claim and its derived recognition from service-controlled public views. Consent alone cannot reinstate an old accepted claim. Independently eligible original source facts retain their separate rules. Editorial participation requires its own opt-in and independent selection.

Public withdrawal and retained-data deletion are separate operations. This implementation preserves protected history and does not announce deletion completion. The approved retention settings, responsible operator, backup deletion and external-cache propagation must be established for an actual public deployment. It promises no retention duration or deletion deadline and does not treat missing settings as permission to retain indefinitely. Withdrawal cannot remove the upstream artifact or copies already downloaded by third parties.

## Verification and release evidence

`apps/controls/test/evidence-intake.test.mjs` exercises real authenticated HTTP and disposable SQLite storage. Literal legacy requests and their saved public rows test initial reads and reopening. Current cases cover terms identity, malformed input, exact actor/claim binding, sequential choices, independent review, protected invitation/public projections, amendment invalidation, carried declines, malformed participant containers and withdrawal with missing intake. The controls journey suite includes accepted and rejected governance, sanitized deployment and reliability/postmortem examples without awarding incident-count merit or human credit from CI execution.

The pipeline suites preserve historical fingerprint algorithms and raw source assertions. They exercise rejection of obsolete manual authority, durable interrupted dispatch, quarantine and fresh reconciliation after synthetic amendment, consent and independent review. Browser cases use the protected forms to cover displayed terms, exact requests, conflicts, malformed historical records, local focus, separate review and removal paths. Synthetic fixture helpers label their records explicitly and are never a migration or production permission source.

Build the workspaces before running their tests. Apply the repository's formatting, type, plan-validation and generated-document gates. Original failing executions and subsequent corrected results retain their own source identities in PR review.

This implementation does not by itself complete the prerequisite's real OAuth registration/rotation and identity probes, actual contributor journeys, approved retention operation, affected-owner acceptance or conditional external-source activation. Those remain distinct release evidence for the full LB-10.02 and review gates.
