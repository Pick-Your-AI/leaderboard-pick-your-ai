# Verified account links and scoped identity corrections

This is the private definition for the account-link and split/merge task in
[LB-03.02](DELIVERY_PLAN.md). It uses
`leaderboard-verified-identity-correction/v1`, exported from
`@pick-your-ai/contracts`. The existing `leaderboard/v1` wire contract and public
database-ID serving aliases retain their current meaning. The separate
[rename contract](verified-actor-renames.md) continues to govern display-name
changes supported by the same verified provider identity.

## Identity and evidence

Every requester, affected account and reviewer is identified by an exact GitHub
node ID, positive safe database ID, corresponding decimal serving actor ID and
provider account kind. Node IDs are opaque. The complete proposal and review
history must have a consistent mapping in both directions; conflicting account
kinds are also invalid. A new provider ID format requires an explicit verified
provider migration; decoding an ID or comparing its spelling is insufficient.
Service-account classification remains a separate reviewed policy.

Names, login similarity, commit emails, social accounts, IP addresses and
matching contribution text do not verify identity or link accounts. These
records have no email or raw proof fields. Only bounded opaque references enter
the contract. Evidence contents, authorization, consent and conflict checks stay
in access-controlled stores under the
[contributor-rights policy](evidence-contributor-rights.md). A provider account's
verified controller may be an authorized organizational representative; account
ownership is not evidence that all work was human or manual.

The proposal records its policy, revision, preparation time, affected identities
and precise scope. Its evidence inventory distinguishes account control,
explicit consent and source attribution. Control checks expire. Evidence must
exist and be valid when the proposal is prepared; accepted decisions must still
have valid evidence when reviewed. All timestamp comparisons retain fractional
precision. A verifier must separately check current revocation and scope.

## Three distinct operations

| Operation | Scope | Required basis | Result |
| --- | --- | --- | --- |
| Link | At least two existing verified accounts; the source and result sets are identical | Verified control and explicit consent for every affected account | A private association; each account and its contributions keep their identity |
| Merge | Multiple source accounts, one existing source account as target, and an explicit list of contributions to move | Verified control and consent for all affected accounts, or independently reviewed source attribution; every assignment needs attribution evidence | Only named contributions receive a reviewed attribution overlay |
| Split | One source account, at least two resulting accounts, and an explicit partition of contributions to move | The same two available bases as a merge; every assignment needs attribution evidence | Named contributions move to their evidenced targets; unlisted contributions retain their original attribution |

An account that retains unchanged contributions may remain in a split's result
set. Every new result must receive a named contribution, and every removed
source must supply one. A contribution appears at most once in a proposal. An
assignment cannot be a no-op or introduce an account outside the declared sets.
Large corrections need separately reviewed scopes within the 256-contribution
bound; splitting a scope must not circumvent aggregate authority or privacy
checks.

Each assignment binds a contribution ID, original source event and revision,
original attribution digest, original role, original actor and resulting actor.
Its cited source-attribution evidence must cover that contribution and both
actors. The protected resolver must compare these bindings with the actual
retained source record. It must reject changed or missing source revisions,
invented roles, already superseded attribution and evidence for another event.
Corrections do not create events, duplicate credit or promote one contribution
role to another.

Voluntary consolidation uses the verified-account-control basis. A correction
of an incorrectly attributed contribution may use reviewed source attribution
without requiring consent from the account that was incorrectly credited. That
basis still requires documented authority, original-source evidence, conflict
review and the contributor's correction and appeal rights. It cannot establish
a voluntary account link or justify optional public identity disclosure.

## Review, appeals and reversal

A proposal is not an accepted decision. The separate decision record binds the
exact proposal with its SHA-256 digest, reviewer, protected authorization and
reason receipts, review time and complete prior review references. The reviewer
must be independent of the requester, every affected account and all previous
reviewers. Both provider identifiers participate in that check. The protected
authority service must establish the reviewer's permission for this operation,
policy and scope and resolve the complete prior history; caller-supplied
references do not establish those facts.

The decision outcomes are `accepted`, `rejected`, `needs_information` and
`reversed`. Rejection and information requests do not change attribution. Intake
requests that cannot yet form a structurally complete proposal remain request
receipts under the contributor-rights workflow. They must not be fabricated into
review-ready records. No schema state is an application receipt.

A reversal is a new decision that references an actual earlier reviewed
decision. It has a new independent reviewer and an authorized reason. The
resolver must establish that the referenced decision was accepted, belongs to
the same correction lineage and can still be reversed; the schema can check
reference structure but cannot read that history. Expired control evidence can
be withdrawn through a reversal. Old decisions and original source records are
retained according to the approved restricted retention policy. A reversal
re-evaluates current source validity, suppression, consent and privacy; it
cannot blindly restore an old public snapshot or a revoked link.

## Canonical proposal encoding and digest

The contracts package exports `encodeVerifiedIdentityCorrectionProposal(input)`
and `digestVerifiedIdentityCorrectionProposal(input)`. Both accept an unknown
value and first parse it with the strict proposal schema above. Invalid records,
unknown fields, unsafe integers and failed cross-field invariants are rejected;
this encoding does not relax the proposal contract.

The encoding version is
`leaderboard-verified-identity-correction-proposal/v1`, exported as
`verifiedIdentityCorrectionProposalEncodingVersion`. The encoded bytes are:

1. That exact ASCII version marker followed by one LF byte (`0a`).
2. The canonical JSON representation of the complete parsed proposal, encoded
   as UTF-8, without a BOM or trailing newline.

Canonical JSON uses `{`, `}`, `[`, `]`, `:`, and `,` without insignificant
whitespace. Every object's keys are sorted in ascending UTF-16 code-unit order
(the order of JavaScript's default string sort). All arrays retain their original
order, including actors, assignments, proofs, subjects, contributions and
referenced evidence. Reordering an object while retaining its fields therefore
preserves its bytes; reordering an array changes them.

String escaping is ECMAScript's well-formed `JSON.stringify` representation:
quotes, backslashes and control characters are escaped; unpaired UTF-16
surrogates use lowercase `\uXXXX` escapes, while valid surrogate pairs encode as
their Unicode scalar's UTF-8 bytes. No Unicode normalization, case folding,
identifier conversion or timestamp parsing is applied. An opaque ID containing
an unpaired surrogate remains distinct from U+FFFD. Equivalent timestamp instants
with different offset or fractional-second spellings remain different strings
and produce different bytes. JSON `null` is retained, including an explicit
`expiresAt: null`; omitting a required nullable field is invalid. The schema's
positive safe-integer database IDs and proposal revisions use their exact decimal
JSON representation. This is the proposal-specific format defined here, not a
claim of conformance to a different canonical JSON standard.

`encodeVerifiedIdentityCorrectionProposal` returns a newly allocated `Uint8Array`.
`digestVerifiedIdentityCorrectionProposal` hashes those exact bytes with
Web Crypto SHA-256 and returns 64 lowercase hexadecimal characters. It completes
schema parsing, serialization and private byte allocation synchronously before
its first asynchronous wait. Caller changes made after invoking the digest do
not alter the pending digest, and changing a returned encoding does not change
the input or later encodings. Web Crypto must be available; there is no alternate
hash or Node-only implementation in the browser-consumable package.

The digest binds every admitted field, including the proposal version and
revision, authority basis, requester, policy version, all source/result actors,
assignment source-event/revision/attribution/role/evidence bindings, and proof
scope and exact time strings. It covers the proposal only, so decision fields
such as reviewer, outcome and `proposalSha256` are not recursively included.
The separate decision schema still checks the supplied digest's shape; a
protected consumer must calculate and compare the digest for the reviewed
proposal. Encoding or matching a digest does not authenticate evidence, authorize
a correction, apply an overlay or satisfy LB-17.03's operational acceptance.

## Private accepted-decision consumer

`verifiedGithubIdentitySchema`, `verifiedIdentityCorrectionProposalSchema` and
`verifiedIdentityCorrectionDecisionSchema` validate record structure and
cross-field invariants. Parsing does **not** verify account control, consent,
evidence authenticity, authorization, complete history or live provider data.
The explicitly configured [private consumer](../apps/controls/src/identity-corrections.mjs)
uses those schemas and the canonical proposal encoder inside a `ControlStore`
transaction. The existing exclusion-only HTTP handler remains separate; no
server route, caller-supplied authority object or operational activation is added.

`createVerifiedIdentityCorrectionConsumer({ store, readAuthority, now })` returns
`apply(decisionId)`. Its sole request input is a bounded opaque decision ID.
`store` must be a private `ControlStore`; `readAuthority` and the synchronous
clock are trusted host configuration. Configuring the consumer creates three
private SQLite tables: `identity_correction_revision`,
`identity_correction_overlays` and `identity_correction_receipts`. Their revision
is independent of the existing public projection revision.

### What establishes a current authority snapshot

After `BEGIN IMMEDIATE` acquires the database write lock, the consumer calls
`readAuthority({ database, decisionId })` using that **same** `DatabaseSync`
connection. The integration must read the canonical protected decision, proposal,
complete review history, provider identities, verified proof records, retained
source bindings, reason receipt and current authorization through that
connection. Every writer of those records, including revocation and source
replacement, must participate in the same SQLite transaction discipline. A
precomputed snapshot, eventually consistent cache, separate database or network
lookup cannot satisfy this contract. The consumer does not infer that a supplied
boolean or callback establishes real-world proof verification.

The reader returns a strict `leaderboard-private-identity-authority/v1` record:

| Field | Required protected content |
| --- | --- |
| `revision`, `validUntil` | A positive safe authority revision and an exclusive validity deadline from the canonical protected authority. |
| `decision`, `currentProposal`, `currentDecisionId` | The retained decision, exact current proposal and latest decision ID for its lineage. The proposal digest is recomputed with SHA-256 over the existing canonical bytes. |
| `priorDecisions` | Every earlier retained decision in order, with matching correction lineage and canonical digest. Each record's prior references must equal its complete earlier prefix; the current decision must name the entire history. Duplicate reviewer identities and inconsistent provider mappings are rejected. |
| `identities` | Exactly the requester, affected accounts, current reviewer and prior reviewers. Each record has an exact `identity`, current `expiresAt`, literal `verified: true` and `revoked: false`; the actor/node mapping must remain one-to-one. |
| `proofs` | Exactly the proposed proof descriptors, with literal verified/nonrevoked status. Each source proof's `attributions` binds the exact contribution, event, source revision, original attribution digest, role and original/result actor pair. Account proofs have no contribution bindings. |
| `sources` | Exactly the retained original source bindings for the proposed assignments, with literal verified/nonrevoked status. An original binding has all assignment fields except `evidenceIds` and `resultActorId`. |
| `authorization` | The immutable authorization receipt ID, `scope: private_identity_correction`, decision ID, proposal digest, exact reviewer, policy and operation kind, reviewed `attributionRevision`, grant time, exclusive expiry and literal nonrevoked status. The grant must exist by review time. The digest binds the complete actor, evidence and contribution scope. |
| `reason` | The verified, retained, nonrevoked reason receipt bound to this decision and proposal digest. Actual private reason/proof contents are not copied into these records. |

The synchronous reader is called again before commit. Both parsed snapshots
must be identical. The reader also cannot omit or rewrite an applied decision
already retained in this store: every such decision in the lineage must match
the resolved history in full. Every relevant deadline must still be current under the
final clock read. Clock reversal is rejected. Timestamp comparisons retain
fractional precision. Asynchronous functions, returned promises and foreign
thenables cannot supply authority. The retained decision must have outcome
`accepted`; rejection, information requests and reversal do not acquire write
permission through this consumer.

### Atomic application and retry

For a new application, the protected authorization's reviewed attribution
revision must equal the current private revision. No caller-provided revision
can replace it. A link appends its private association and moves no contributions;
a merge or split appends only the exact named assignments, preserving their
roles. An original contribution already present in an accepted overlay is
superseded and cannot be assigned again through this consumer. The separate
private cancellation consumer below can withdraw an application without reusing
its attribution. Review and application of a subsequent attribution generation
remain separate work; reusing the old original-source binding cannot bypass it.

One transaction appends the overlay, retains the complete decision and immutable
authorization, stores its application receipt and advances the private revision
once. Original source records and existing private/public profile state are not
rewritten. A failed authority read, append, receipt write, revision update,
final guard or database commit rolls back the entire transaction. The consumer
performs no network, cache or other external side effects inside that transaction.

An exact retry still requires the current protected read and nonrevoked scope.
It must match the entire retained decision and authorization, not merely the
proposal hash. It checks the durable overlay/receipt pair and binds the receipt's before-revision
to the immutable authorization's reviewed attribution revision. Its authority
revision must be positive, and its application time must lie between the retained
review time and the current read. It returns a detached copy of the original
receipt without advancing the revision or appending again.
It can acknowledge that receipt after an unrelated private application has
advanced the revision. Reusing a decision ID with different content, replacing
its reviewed authorization revision/lifetime, or presenting a partial receipt
fails. Modifying a returned object cannot change stored state or later retries.

After the final protected-authority and clock callbacks, both paths recheck the
exact current private revision and complete stored decision, authorization,
receipt and overlay against their detached expected result. A missing or changed
record rolls back the whole transaction. On retry this check preserves the
original receipt and the current revision observed by that transaction, even when
the latter is newer than the receipt's after-revision.

The [synthetic SQLite suite](../apps/controls/test/identity-corrections.test.mjs)
exercises all three accepted operations, closed authority/source/history scope,
current revocation and precise expiry, source replacement, independent-connection
write contention, failures at each durable write and deferred commit, throwing
first/final readers, final-callback durable-state changes, reopening and repeated
delivery. These are local engineering controls; they are not real identity
decisions or live propagation evidence.

## Private cancellation of an accepted application

The optional [cancellation consumer](../apps/controls/src/identity-correction-reversals.mjs)
provides `createVerifiedIdentityCorrectionReversalConsumer({ store, readAuthority, now })`
and returns `reverse(decisionId)`. The sole request value is the new reversal
decision ID. It requires the accepted consumer's existing private tables and
adds `identity_correction_cancellations`; it does not initialize an absent
accepted-decision store. The module has no server route or automatic activation.

This operation appends a private cancellation of exactly one retained accepted
link, merge or split. It keeps the original overlay, original decision,
authorization, receipt and source records. Its receipt explicitly records
`outcome: cancelled_private` and `restoration: withheld`. Neither the original
source attribution nor a public identity, profile, snapshot or previously
suppressed result is restored. Public propagation and a subsequent attribution
generation require their own implementation and current authority.

### Protected cancellation authority

The reader must resolve canonical protected records through the same locked
`DatabaseSync` connection, twice in one `ControlStore` transaction. All writers
must use the same transaction discipline. Its strict version is
`leaderboard-private-identity-reversal-authority/v1`:

| Field | Required protected content |
| --- | --- |
| `revision`, `validUntil` | A positive safe authority revision and an exclusive current deadline. |
| `decision`, `currentDecisionId` | The exact new `reversed` decision and the current decision ID for this lineage. Its proposal must equal the retained accepted target's entire historical proposal; changing assignments or attribution generations is outside this operation. |
| `priorDecisions` | The complete ordered history, including the exact target acceptance and every locally retained application or cancellation in the lineage. Each decision binds its complete earlier prefix. Reviewers are independent; provider identity mappings and proposal digests remain consistent. |
| `reviewer` | The new decision's exact provider identity, exclusive current `expiresAt`, `verified: true` and `revoked: false`. The reviewer is independent of the requester, affected identities and every previous reviewer. |
| `authorization` | A fresh purpose-specific receipt with `scope: private_identity_cancellation`, `receiptId`, new `decisionId`, accepted `reversesDecisionId`, `targetApplicationSha256`, `proposalSha256`, exact `reviewer`, `policyVersion`, `kind`, reviewed `attributionRevision`, `grantedAt`, exclusive `expiresAt` and `revoked: false`. |
| `reason` | A current verified, nonrevoked receipt with exact `receiptId`, new `decisionId` and `proposalSha256`. Private reason contents are not copied. |
| `observations` | Exact, complete current actor and source observations described below. These describe present restrictions and availability; they grant no permission to restore anything. |

The target application must exist before the new grant and review:
`target.appliedAt <= authorization.grantedAt <= decision.reviewedAt <= now`.
Its after-revision must not exceed the grant's reviewed private revision. A new
cancellation also requires that reviewed revision to equal the current private
revision. This prevents a reversal reviewed before an accepted application
exists from authorizing that later application. Both authority snapshots must
be identical, the final clock cannot move backwards, and all new authority
deadlines must remain current before commit.

The old target's proof, identity and source descriptors remain historical.
Current expiry, revocation, withdrawal or unavailability of that old evidence
cannot grant attribution again and does not prevent a newly authorized
restrictive cancellation. The retained bundle is still validated: the old
application time must be at or after its accepted review, inside the original
authorization lifetime and before every bounded original proof expiry. Its
before-revision must equal the original authorization's reviewed revision; the
after-revision must be exactly one higher and equal the overlay revision. The
consumer does not invent unavailable historical identity snapshots.

### Current observations without restoration authority

`observations.actors` contains exactly one closed record for every unique actor
in the target's source/result sets, with no missing, duplicate or foreign actor.
The requester or reviewer is not added unless also affected. Each record has
`actorId` and all three state fields:

| Field | Allowed values |
| --- | --- |
| `suppression` | `clear`, `suppressed`, `unavailable` |
| `deletion` | `retained`, `deleted`, `unavailable` |
| `consent` | `current`, `withdrawn`, `expired`, `not_applicable`, `unavailable` |

`not_applicable` is admitted only when the historical target has no consent
proof scoped to that actor. A missing or inaccessible record must be represented
explicitly as `unavailable`, never inferred to be clear, retained or current.

`observations.sources` contains exactly one closed record for each target
assignment, with `contributionId` and `validity`. Allowed validity values are
`current`, `changed`, `revoked`, `deleted` and `unavailable`. A link has no
assignments and therefore has an empty source observation list. Source binding
details remain in the exact retained target bundle; unavailable current source
records are not fabricated from those old details.

Suppressed/deleted actors, withdrawn/expired consent and changed, revoked or
unavailable sources all allow cancellation under the fresh cancellation grant.
Every combination still yields `restoration: withheld`. The reader must resolve
these observations from actual protected current state; a synthetic callback or
literal enum value is not operational evidence that this integration exists.

### Whole-target binding, durable history and retry

`digestPrivateIdentityCorrectionApplication(input)` validates the complete
retained `{ decision, authorization, receipt, overlay }` target bundle and returns
its SHA-256 binding. It is separate from the proposal-only digest. Its exact
encoding is the ASCII marker
`leaderboard-private-identity-application-binding/v1`, one LF byte, then the
complete parsed bundle as canonical JSON in UTF-8, with no trailing newline.
Object keys use ascending UTF-16 code-unit order, arrays retain order and scalar
escaping follows well-formed `JSON.stringify`, as specified for proposal encoding
above. No normalization or timestamp-spelling conversion occurs. A matching hash
does not establish authority or apply a cancellation.

The consumer reads the target directly from the retained accepted receipt and
overlay tables. It cross-validates every decision, authorization, proposal,
receipt, revision, time and overlay binding before comparing the new grant's
target digest. A caller-supplied target record is never an application input.

One transaction appends the cancellation state, stores the new reversal
decision, immutable cancellation authorization and receipt in the existing
`identity_correction_receipts` table, then advances the private revision once.
The cancellation table is unique by target acceptance, reversal decision and
resulting revision. Using the shared receipt history means the unchanged
accepted consumer rejects a later history that omits or replaces this local
reversal. Keeping the old overlay also preserves its superseded-source guard:
a later acceptance cannot reuse the old original contribution attribution.

The cancellation receipt and state retain the observations at the original
cancellation application time. An exact retry requires two identical fresh
authority reads and the same immutable decision and grant, and validates the
durable cancellation/receipt pair. It returns a detached copy of the original
receipt without changing its observations, even after a reopen, an unrelated
private revision or a later negative/unavailable current observation. Current
revocation or expiry of the cancellation grant still rejects the retry. A
different reversal cannot cancel the same target a second time.

Any failed read, target/history check, append, receipt write, revision update,
final guard or deferred database commit rolls back the whole transaction. The
[focused synthetic suite](../apps/controls/test/identity-correction-reversals.test.mjs)
covers these cancellation boundaries alongside the unchanged accepted-consumer
suite. These synthetic cases do not establish live reviewer authorization,
real identity decisions, public propagation or completion of issue #94.

## Remaining application and acceptance

The protected authority provider and its real proof/source admission must be
integrated and independently qualified before this consumer is enabled for any
operational identity decision. Authenticated intake, private request delivery,
reviewer custody, operational cancellation admission and public propagation
retain their separate gates.
Whole LB-17.03 remains open.

Downstream application must consume the private overlay and durable receipt,
then recompute only affected derived results while
preserving unrelated contributors and role distinctions. Current suppression
and deletion controls apply across public reads, search, caches, exports,
historical and frozen replay; a link must not reveal an opted-out identity or
bypass a privacy tombstone. Completion requires verified propagation receipts,
bounded recovery and independent readback, as defined by the contributor-rights
policy. Until that implementation and its acceptance evidence exist, this
definition provides no operational claim that links, merges or splits work.

The definition is deliberately separate from the remaining LB-03.02 work:
real node-ID resolution, unavailable/suspended/unlinked lifecycle handling and
source-backed historical credit must each meet their own acceptance. This file
does not mark the parent issue complete.
