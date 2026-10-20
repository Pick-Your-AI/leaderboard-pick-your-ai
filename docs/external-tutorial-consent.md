# External tutorial consent declarations

Refs #81. This is a dormant, private Controls capability. It records a participant's
consent to an exact tutorial declaration and proposed account attribution. It does
not accept tutorials for recognition, fetch them, enroll an external source, or
change a metric or public source contract.

## Explicit host capability

The existing authenticated Controls server accepts an optional
`externalTutorialConsent: true` constructor option. The default is `false`.
The option exposes a separate terms profile through the existing
`GET /controls/evidence-terms` response and enables submission, amendment, and
affirmative participant consent for that profile. It does not add an endpoint.

When the option is absent or false, the legacy terms response remains exactly
`{ terms: ... }`. Existing `evidence-intake/v1` terms, claim hashes, invitation
fields, and independent review behavior remain unchanged. An old receipt is not
silently migrated or reinterpreted as a tutorial declaration.

Disabling the option after records exist leaves their saved declaration and terms
available to authorized participants. New affirmative tutorial consent and
tutorial amendments are rejected. Decline, withdrawal, and amendment back to the
ordinary evidence profile remain available under the existing ownership, session,
CSRF, and version checks.

## GitHub carrier and external provenance

The request's existing `locator` remains a public-looking GitHub file URL pinned
to a full commit identifier. It is the **manifest carrier**, not a statement that
the tutorial itself is a GitHub artifact or that the manifest author wrote it.
The server never follows either URL.

The optional `evidence-intake/external-tutorial/v1` profile carries one strict
`externalTutorial` declaration:

- `canonicalUrl`: the stable HTTPS identity of the tutorial, distinct from any
  particular revision. Credentials and fragments are rejected; a canonical query
  may be part of an artifact's identity.
- `revision.id` and `revision.contentSha256`: the declared exact revision and
  SHA-256 of its content.
- `manifest.locator` and `manifest.contentSha256`: the same pinned GitHub
  locator as the request and the declared SHA-256 of that manifest.
- `publishedAt`: a declared UTC timestamp, or explicit `null` when unknown.
  It is not replaced with submission, consent, review, collection, or receipt time.
- `attribution`: exactly the authenticated submitter plus every listed
  collaborator, with the same proposed roles as the intake. Unknown roles remain
  `null`. A submitter cannot manufacture another account's consent.

The profile uses the existing `other` category while no tutorial qualifier is
available. No new registry category, scoring rule, unit, default source, reviewer
grant, or rights approval is introduced. Stable artifact identity must remain
separate from revisions and receipts in any later qualifier; a new manifest,
hash, or consent receipt must not mint a second outreach unit.

The declaration is detached through bounded own-data copying before its fields
are interpreted. Proxies, accessors, cycles, unknown fields, sparse arrays,
non-plain objects, and excessive depth, nodes, strings, or serialized bytes are
rejected. The API also requires a pinned manifest, exact participant membership,
matching roles, canonical hashes, and a valid nullable publication declaration.
These checks establish a safe declaration shape, not truth or source authority.

## Consent and display

The profile has separate terms,
`evidence-terms/external-tutorial/2026-10-20`. The existing contributor-rights
policy version is retained. The UI presents the carrier, stable tutorial identity,
both hashes, revision, declared publication time, and every proposed account
role before a participant chooses. It renders these values as text and does not
load external content.

The tutorial claim digest includes the complete normalized declaration in
addition to the existing receipt, owner, carrier, public summary, category,
participant set, contribution period, terms, rights policy, and claim revision.
A descriptor or role change cannot reuse a prior affirmative consent receipt.
The invitation includes the exact same descriptor and full attribution, plus the
claim/terms digests used by the existing consent operation.

Private review detail, source-use statement text, amendment reason, reviewer
rationale, and review references remain outside the invitation. The invitation
reports only whether a source-use basis was declared or remains unresolved.
Consent does not establish original tutorial authorship, publication time,
licensing, permission, or independent source-use approval.

The existing amendment transaction creates a new claim revision and returns the
receipt to pending review. Old affirmative choices remain in protected history;
current participant consent is empty or pending. A prior decline is retained as
the same historical decline. Stale receipt versions or claim/terms bindings
cannot confirm a new declaration.

## Qualification is deliberately unavailable

The review endpoint rejects acceptance of this profile even for an otherwise
authorized, independent reviewer with a permitted source-use review. The shared
`hasReviewedEvidenceIntake` predicate also returns `false`, including for a
forged or historical record marked accepted. This second boundary keeps the
profile out of Controls publication and existing recognition callers.

After all participants consent, the protected eligibility state is
`external_tutorial_qualification_unavailable`. This is neither acceptance nor
an unverified public contribution. Account privacy and restrictive withdrawal
continue to apply.

A subsequent, separately reviewed capability would need actual source-use
authority, independent original-authorship and publication evidence, approved
rights and operating prerequisites, and an explicit compatible qualification
rule. This change supplies none of those decisions and does not complete #81.

## Validation boundaries

The added Controls suite exercises the actual authenticated HTTP routes and
temporary SQLite state: default-disabled and legacy compatibility, exact
invitation privacy, amendment and stale-consent rejection, disabled-state decline
and withdrawal, malformed declarations, and rejection of forged accepted
publication. It also freezes the preexisting v1 terms and claim digests.

Client tests cover the submitted descriptor, explicit unknowns, immutable
manifest pins, malformed input, and unavailable acceptance. Browser cases cover
the actual forms with intercepted transport, including keyboard consent at a
320-pixel viewport, accessibility checks, participant display, amendment, and
disabled/reviewer affordances. Those browser fixtures are not actual consent or
source-use evidence; the separate Controls suite owns the real HTTP/SQLite
boundary.
