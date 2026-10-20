# Public stewardship review descriptors

This module supplies a small private input boundary for COV-17 in
[#60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60) and the
remaining source/review work in [#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79).
A sanitized evidence document and the public comment that a person acted on are
different artifacts. Copying an evidence document's author, item identity or
creation date into a stewardship fact would attribute the wrong work.

[public-stewardship-review.ts](../packages/github/src/public-stewardship-review.ts)
parses a closed descriptor and binds it to an exact host review snapshot.
It does not produce a normalized fact, authenticate a reviewer, resolve source
rights or visibility, or enable a public view. The existing
[day grouping](public-stewardship-grouping.md) and its three evidence/clock pairs
remain unchanged. The UI definition remains `definition_only` and all public
enablement flags remain false.

## Why this first pair is limited to comment pin/unpin

The current #60 COV-17 text expressly calls for receipts for unsupported public
actions and gives issue-comment pinning its own source-object requirement. The
[registry](../packages/metrics/src/v1/registry.json) retains public pin/unpin and
lock/unlock facets and the `triager` contribution role. This initial descriptor
selects only `issue_comment` with `pinned` or `unpinned`, using opposite explicit
Boolean before/after states. It supplies no lock operation on a comment.
Issue-level actions, pull-request comments, Discussion targets and other
moderation actions need separately reviewed target contracts and integrations.

GitHub's current [IssueComment documentation](https://docs.github.com/en/graphql/reference/issues#issuecomment)
distinguishes the comment's own identity, database key, parent issue and URL.
The [pinned-comment wrapper](https://docs.github.com/en/graphql/reference/issues#pinnedissuecomment)
is a different object. The current schema also documents
[comment pin](https://docs.github.com/en/graphql/reference/issues#issuecommentpinnedevent)
and [unpin events](https://docs.github.com/en/graphql/reference/issues#issuecommentunpinnedevent),
including actor, event time and nullable comment references. These primary
definitions were checked on 2026-10-20. The platform capability is not declared
globally unavailable: this project still needs its own exact source subtype,
permissions, completeness and privacy qualification. This contribution performs
no source probe, mutation or live canary.

The target uses the comment's node ID and canonical decimal database ID, plus
the parent issue and repository coordinates. It never uses the wrapper's ID,
item author, current pin owner or a title as an action identity. The parser checks
internal shape and URL agreement; a qualified host must independently establish
that all IDs refer to the same current permitted public item. A well-shaped
GitHub URL does not prove public visibility.

## Closed descriptor

The exported `PublicStewardshipReview` interface is the complete field list.
All fields are mandatory, including `occurredAt: null`.

| Fields                                      | Meaning                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `version`                                   | Exact `public-stewardship-review/v1`                                                                                       |
| `requestId`, `claimRevision`, `claimDigest` | Exact retained claim identity                                                                                              |
| `reviewedInputDigest`                       | Exact reviewed private intake, including its source-use statement and contributor roles                                    |
| `actorId`, `contributorRole`                | Explicit contributor account and literal `triager`; this is a contribution role, not a GitHub permission                   |
| `target`                                    | One issue comment with its own node/database identity, issue identity/number, repository ID/slug and canonical comment URL |
| `action`, `before.pinned`, `after.pinned`   | One non-no-op pin or unpin claim                                                                                           |
| `before.evidence`, `after.evidence`         | Each has a pinned GitHub blob `locator`, exact `revision`, and declared original-byte `sha256`                             |
| `occurredAt`                                | Literal null; this profile carries no established original action clock                                                    |

The parser returns a detached, deeply frozen value. It has no source callback,
network operation or normalization side effect. It rejects unknown keys, hidden
properties, symbols, accessors, proxy objects, foreign prototypes and malformed
nested inputs without invoking supplied getters or serialization methods.
Plain objects with the ordinary or null prototype are accepted. Input strings
must be well-formed Unicode and are not normalized or trimmed. An unpaired
surrogate cannot silently hash as a replacement character.

Account and database IDs are canonical positive decimal strings of at most
20 digits. They never pass through JavaScript number conversion. Opaque node IDs
use this local bounded ASCII vocabulary: letters, digits, underscore, colon,
plus, slash, equals and hyphen, up to 200 characters. Claim and request versions
are positive safe integer values. These are local admission limits; they do not
claim that a larger or differently encoded upstream ID is nonexistent.

GitHub locators use exact HTTPS URLs without credentials, explicit ports, query
strings, encoded path separators or dot-segment normalization. Evidence
references point to a blob under their exact lowercase 40- or 64-hex revision,
with no fragment. Target URLs must exactly match the supplied repository, issue
number and comment database ID. Strings are bounded at 200 characters unless the
interface uses a 100-character policy version, 64-character digest,
24-character timestamp or 2,048-character URL. The canonical descriptor is at
most 16,384 UTF-8 bytes. The descriptor has no report-body, restricted-reason,
offender, severity, justification or quality-score fields.

One immutable sanitized document may contain both before/after snapshots.
When the same pinned locator is used for both, its declared byte hash must be
identical. This does not prove the snapshots are truthful. The independent
review must inspect the actual retained bytes and their relationship to the
specific actor, comment and transition. An arbitrary supplied digest is not
that review.

## Complete digest and current binding

`publicStewardshipReviewDigest(value)` first performs the same closed admission
and then hashes its fixed-field canonical UTF-8 JSON with SHA-256. Object key
insertion order is irrelevant; semantic string values and every descriptor field
remain exact. This digest is distinct from each evidence artifact's original-byte
hash. It is also distinct from the existing claim and reviewed-input digests.

`bindPublicStewardshipReview(value, current)` requires a closed host projection:

- `request`: `id`, `version`, `category`, `owner`, `collaborators`,
  `claimRevision`, `claimDigest`, `reviewedInputDigest`, `submitterRole`.
- `decision`: `requestId`, `requestVersion`, `descriptorDigest`, `reviewerId`,
  `reviewerRoleVersion`, `policyVersion`, `acceptedAt`, `references`.
- `currentReviewerRoleVersion`: the actual current version of that reviewer's
  authority, as obtained by the protected host.

The decision's descriptor digest must be the value retained by the actual
independent review. A consumer must not recompute it from a new caller payload
and label that recomputation the expected reviewed value. Keeping only the claim
digest or reference membership would allow a different target/action to reuse a
review of the same evidence document.

The binder admits every supplied nested record before comparing the exact
bindings. It requires the category `public_moderation`, exact current claim and
private-input identities, owner/actor agreement and `triager` role. The accepted
decision's request version must equal the current stored request version; the
module guesses no acceptance increment or historical-version offset. A later
amendment, withdrawal, appeal or other version advance therefore cannot reuse a
decision for an earlier version.

The reviewer must be distinct from the owner and every supplied collaborator;
the role version must still match. Collaborators are a dense unique list of
zero to 20 account IDs. Reviewed references are a dense unique list of one to
five closed `{ locator, revision }` pairs. Both evidence references must occur
in that list, including a single shared document when applicable. Even unused
references and collaborator entries undergo complete shape admission.

`acceptedAt` is the actual authenticated decision clock, represented as a
canonical UTC timestamp with exactly millisecond precision. It remains separate
from `occurredAt`, which stays null. The module does not obtain either value
from a current pin state, ingestion time, evidence-file timestamp or `Date.now`.
It creates no eligible occurrence-day fact. A future receiving implementation
must explicitly select any accepted-day lens, while retaining the distinction
from observed event-time evidence.

The result contains only the frozen review, descriptor digest, request version,
reviewer ID/role version, policy version and acceptance clock. Its type is
`BoundPublicStewardshipReview`, not a verified receipt or recognized metric.
Rejection is a `TypeError` with the stable message
`invalid_public_stewardship_review`, containing no input values.

## Required receiving work

This module is a companion to the
[existing #448 receiver route](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/448#issuecomment-6283536251).
It adds no package-root export and changes no adapter, normalizer, controls
request schema, runtime, source collector, retirement path or metric engine.
Importing the direct module cannot add recognition. Shared integration remains
with its existing controller and has not been accepted by silence.

A later integrated receiver still needs all of the following:

1. Retain the reviewed descriptor and its digest in the authenticated versioned
   decision/audit twin, with the existing current policy, independent reviewer,
   explicit conflict decision, participant consent, rights/source-use review and
   intake checks. Never accept this host projection directly from an HTTP body.
2. Qualify the exact public comment identity, actor role and immutable sanitized
   evidence bytes, including current source permission/visibility and absence of
   conflicting aliases. The evidence document's author or creation time cannot
   supply the claimed steward or original action time.
3. Construct a distinct typed target/action fact with an explicit source/receipt
   lineage. Do not spread the document's generic fact into `public_moderation`.
   Reconcile repeated receipts, observed transitions and daily groups without
   additive credit or invented complete history.
4. Recheck changed claims, current roles/consent, source withdrawal, suppression,
   aliases and policy changes through actual storage, replay, cache, export and
   public-projection paths. Cover negative, recovery and durable reopen cases.
5. Obtain the affected source, metric, governance and release decisions before
   selecting or enabling any public lens.

Those requirements, whole #60/#79 acceptance, private moderation exclusions and
the separate installed-source capability work remain outstanding. This guide
does not report real receipt acceptance, private-action access or a production
deployment.

## Focused validation

The [direct synthetic tests](../packages/github/test/public-stewardship-review.test.mjs)
exercise both transitions; the evidence/target distinction; full digest and
claim/version/role/reference substitution; independent-reviewer rejection;
unknown clocks; no-op and unsupported targets; exact large IDs; Unicode;
URL/pin admission; all-record preflight; proxy/getter rejection; dense bounds;
and detached immutable results.

Build the GitHub workspace with its existing pinned dependencies, then run:

```sh
node --test packages/github/test/public-stewardship-review.test.mjs
```

These are local parser/binder tests. They do not execute an HTTP/store receiver,
metric projection, withdrawal/replay integration or a live GitHub action.
