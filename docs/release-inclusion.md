# Accepted changes included in published releases

This is the bounded `release_changes` implementation for
[LB-07.05 / #77](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77).
The existing definition remains unchanged: a period counts distinct accepted
PR/release memberships, and an all-time scope conserves repeated inclusion of
the same accepted PR for its original contributor. Public enablement, source
permission, contributor consent and the remaining work-package gates are separate.

## Collection and source admission

The protected host selects a finite `releaseInclusionTargets` array in its pipeline
configuration. Each entry has exactly numeric positive safe-integer `repositoryId`,
`releaseId` and `pullRequestNumber`. At most 1,000 unique targets are supported;
every repository must already be authorized. The stock normalizer collects proof
only for its exact selected PR URL. Without targets, unrelated normalization and
HTTP traffic retain their preceding behavior. Changing targets changes the private
normalization cache identity even when the PR revision has not changed.

`collectGithubReleaseInclusion` performs actual bounded reads through the existing
repository-scoped `GithubReadClient`: public repository, release ID, merged PR,
tag ref, annotated tag objects where needed, and an immutable-SHA comparison.
The transport checks host authorization before every attempt and delivery, retains
its existing quota and retry behavior, and never follows a response-supplied URL.
The default annotation limit is eight with a hard ceiling of sixteen; zero accepts
lightweight tags only. Cycles, noncommit targets, incomplete chains, mismatched
native IDs and unproved ancestry fail closed.

The release must actually report `immutable: true`, `draft: false` and a known
publication clock. A mutable `target_commitish` is not a commit proof. Current
prerelease state is retained as current state, never reconstructed as historical
state. There is no invented release update timestamp or publisher transition.
The accepted PR's full integration SHA must be the base and merge base of the
actual requested comparison to the resolved release-tag commit. Only `ahead`
with positive ahead count or `identical` with zero count establishes membership;
behind count must be zero. A truncated commit list is not used as ancestry proof.

The minimized `github-release-inclusion/v1` record remains private. Its validator
checks structure, native identity relationships, clocks, tag chain and comparison
attribution. Validation is not a cryptographic attestation for arbitrary JSON;
only a protected collector or explicitly authenticated host normalization may
supply it. Raw API responses, release notes, emails and access credentials are
not retained in that record.

Source admission separately requires one original observed `pr_merged` author,
one source actor and one eligible public PR proof. Fact, proof, repository, native
PR node, native author database/node IDs, role, canonical action and merge clock
must agree. Existing full-SHA source pins must match the collected integration.
An open PR, unmerged PR, issue, merger, sender, synthetic source, prior qualified
fact, unsupported coauthor or missing inclusion cannot become a released change.
Bot work retains its actual actor and execution classification; a User account
does not prove manual execution. Unsupported sources remain outside this route.

## Exact private acceptance

The authenticated controls review accepts an optional `releaseInclusion` object
with exactly `targetFactId`, `releaseId`, `pullRequestNumber`, `proofHash` and
`policyVersion`. The two numeric IDs are positive safe integers; `proofHash` is
64 lowercase hexadecimal characters. The target's policy version must equal the
approved acceptance policy. The same parsed target is selected in the protected
recognition binding, whose source metric is `pr_merged` and destination is
`release_changes`.

`githubReleaseInclusionHash` hashes canonical minimized record fields, excluding
only the observation clock. It is a review pin, not a source signature. Repeated
collection alone preserves the pin; a changed release, author, ancestry or current
prerelease field requires another explicit review. Contradictory current records
for the same release or PR are rejected before choosing or deduplicating a target.

The review records an exact request snapshot, current request version, receipt
and single matching audit decision. A generic earlier acceptance cannot supply
these fields. Target substitution, changed request, policy mismatch, self-review,
collaborator-review, duplicate audit or a decision after the frozen cutoff cannot
qualify the source. Amendments, withdrawal, appeal, rollback and changed collaborator
consent retain their controls behavior; changed exact-target attribution requires
new review. The release target is absent from public request projections.

Both direct receipt application and the complete pipeline perform source
admission. The pipeline performs it before a host-supplied receipt callback and
before duplicate selection. Private collected proofs survive normalization and
combination; mixed synthetic provenance remains attached to individual facts.

## Clocks, counts and saved authority

The accepted membership uses the actual release publication as `occurredAt` in
both fact and public evidence. Independent acceptance stays in `acceptedAt`, and
collection stays in `observedAt`; acceptance cannot precede publication. Original
PR merge facts are unchanged. The collector preserves source precision; this
metric route refuses finer-than-millisecond clocks rather than rounding them.
Public proof retains the PR link and supplies the immutable release commit link.
Private target IDs, proof hashes and raw records do not enter the public proof.

Policies require `qualified`, the author role, `occurredAt`, canonical grouping,
and `groupingPolicyVersion: release-inclusion-units/v1`. Each release membership
has its own canonical identity. Period and custom windows count memberships;
a scope with no lower bound counts the same PR/contributor once across releases.
Correction, source identity, actor, repository, context, acceptance and half-open
window checks occur before lifetime conservation. Thus an excluded or out-of-scope
old release cannot hide a valid current membership. Descriptive portfolios retain
each eligible release membership even when the all-time arithmetic counts one.
Receipt aliases and caller-supplied bulk changesets cannot mint another unit.

The initial work identity is the exact repository, native PR and contributor.
This route does not infer equivalence across separate cherry-pick, squash, mirror
or imported PRs from names or commit strings. Those broader work-lineage adapters
require their own source and review evidence before cross-PR conservation is claimed.

`release-inclusion-recognition/v1` changes saved authority only for configurations
binding `release_changes`. Old generic snapshots are withheld from current and
pinned proofs, exports, previews and explanations until actual recomputation.
All earlier category markers and all other metric fingerprints remain unchanged.
The 98 metric definitions and current UI maturity are preserved; this bounded
implementation does not claim a selectable public release board.

## Remaining work-package evidence

All test data is fictional. The tests establish source rejection, accepted
inclusion, immutable tag traversal, authorization and retry boundaries, current
review binding, publication clocks, lifetime conservation, replay, withdrawal and
private-data projection. They do not establish any real contributor's acceptance,
actual source-use enrollment, operational release or live service.

Release-note authorship continues to require the independently reviewed authored
documentation route. Release coordination and stewardship require their own
checklist and actor evidence. A green workflow, release publisher or tag creator
does not prove either contribution. The broader #77 criteria and native
prerequisites remain open until their separate evidence is complete.
