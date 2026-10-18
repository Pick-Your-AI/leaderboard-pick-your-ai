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

## Application boundary and remaining implementation

`verifiedGithubIdentitySchema`,
`verifiedIdentityCorrectionProposalSchema` and
`verifiedIdentityCorrectionDecisionSchema` validate record structure and
cross-field invariants. Successful parsing does **not** verify account control,
consent, evidence authenticity, authorization, the supplied digest, the complete
review history or live provider data. None of these schemas apply a correction.
The current exclusion-only correction handler does not consume this definition.

The application work tracked by LB-17.03 must resolve protected proofs, verify
the exact proposal digest and retained source revision, recheck current
authority and revocation, and compare the reviewed proposal revision and current
attribution revision atomically before any write. A prior application receipt
makes a retry idempotent; a different proposal or intervening decision requires a
new review. A stale review must fail without modifying attribution. The digest
encoding must be a specified canonical serialization shared by the protected
writer and reviewer before an executor is enabled.

Application retains original source attribution and appends a versioned overlay
and durable operation receipt. It recomputes only affected derived results while
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
