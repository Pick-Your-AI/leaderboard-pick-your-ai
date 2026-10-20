# Reviewed helpful Discussion threads

Refs [#46](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/46).
This gated production path supplies durable original/current source provenance
to independently reviewed `helpful_feedback`. The metric remains
`definition_only`; the default configuration enrolls no content source. This
implementation does not establish a real App capability, permission to process
text, contributor consent, helpfulness, operational retention ownership, or
the issue's empirical acceptance.

## Exact optional source authority

The host may explicitly provide `config.discussionFeedback`, with exactly
`version: "discussion-feedback-content/v1"` and `enrollments`. Each enrollment
contains these fields:

| Field | Required binding |
| --- | --- |
| `repositoryId`, `installationId` | Positive native IDs, matching the approved repository configuration and its Discussion family |
| `fieldScope` | Exactly `discussionFeedbackFieldScope`, including root title/body/update/edit fields and selected-answer body/update/edit/deletion/minimization fields |
| `sourceUseReceiptId`, `capabilityReceiptId` | Protected locators for actual independent source-use and installed-App field capability evidence |
| `policyVersion`, `retentionPolicyVersion` | Exact current source and protected-data retention policy references |

There are at most 100 unique repository enrollments. The runtime additionally
requires `discussionFeedbackAuthorityEpoch(binding)`. It must synchronously
return a current, nonempty bounded epoch for the entire exact binding,
including the runtime data mode. The host must verify the actual permission,
capability and retention authority and change the epoch whenever that authority
changes, including revocation followed by re-enrollment. Returning a promise,
an unavailable value or an unrelated binding grants no content read. Receipt
strings in configuration are locators, not approvals.

The epoch is checked before and after asynchronous boundaries, before each
content request and checkpoint, and inside the publication/private confirmation
fences. The repository must remain public, enrolled in the same installation,
and capable of Discussions. Existing configuration, current consent, reviewer,
privacy and source-generation checks remain required. Removing an enrollment
or changing its authority cannot silently reuse old publications.

The official [Discussion and DiscussionComment schema](https://docs.github.com/en/graphql/reference/discussions)
and [Discussions API guide](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)
describe the selected API fields. Documentation is distinct from a successful
probe under the product's installed App. No live source is activated here.

## Minimize before the first checkpoint

The optional repository query uses ten Discussions per GraphQL page. It adds
root `title`, `body`, `lastEditedAt`, and selected-answer `body`, `updatedAt`,
`lastEditedAt`, `deletedAt`, and `isMinimized` to the existing native identity,
author, creation/update and answer-selection metadata. It does not enumerate
ordinary comments, fetch attachments, follow links, or infer helpfulness from
comment volume or answer selection.

Each body has a 65,536-byte UTF-8 limit and each title a 4,096-byte UTF-8 limit.
Oversized strings, missing selected fields and malformed Unicode are rejected.
There is no truncation, Unicode normalization or replacement-character hashing.
Valid surrogate pairs encode their actual UTF-8 bytes. Canonically equivalent
but byte-different strings remain different observations.

The scan selector hashes text before `GithubReadClient` saves a checkpoint.
Only a closed descriptor containing hashes and native metadata enters the file
checkpoint, collection row or SQL coverage receipt. Normalization uses that
verified minimized observation directly; it makes no second, untracked content
read. Raw response text is transient process memory and is not attached to
errors, audit records, source facts, normalization documents or public output.
JavaScript does not guarantee secure erasure of transient strings from memory.

The descriptor binds the content contract version, repository and installation,
Discussion ID and canonical public thread URL, original author and clocks,
title/body hashes, and the actual selected answer's ID, author, body hash,
creation/update/edit clocks and selection metadata. A selected answer must be
present, explicitly selected and non-minimized. Unknown native actor kinds
cannot supply an invented author. Every applicable native clock must be no
later than its actual stored observation time. Missing or contradictory clocks
are unavailable.

`discussion-feedback-content/v1` fixes the descriptor's closed field order and
SHA-256 encoding. An observation separately binds its descriptor fingerprint,
authority hash, coverage epoch, per-thread generation and exact scan ID. Its
reserved full source revision is `gdf1:<64 hex>.<32 hex>` (102 characters),
within the existing protected source-reference limit. Legacy metadata-only
Discussion revisions cannot supply this provenance.

## Complete observations and continuity

A mutable per-repository head and immutable complete-scan receipts live in
separately versioned pipeline tables. Their integrity hashes, closed shapes,
repository access generation and exact source authority are checked. Scan
receipts reject SQL updates; the authorized repository retirement path may
erase their protected payloads. No default expiry interval is invented.

Before any content read, collection writes a pending scan attempt under the
repository's existing source lock and a per-repository transaction lock.
Only a complete, bounded inventory can clear that pending state. A complete
receipt retains the minimized observations, so retrying the same completed
collection replays those observations without another content read.

Across complete uninterrupted scans, an identical descriptor keeps its
per-thread generation. Any observed change receives a fresh random generation.
A missing thread is removed from the complete inventory; its later reappearance
receives a fresh generation even if its bytes are identical. An unfinished
attempt always starts a new coverage epoch on resume, including a resume with
the same run ID. Lost checkpoints therefore cannot conceal an intermediate
observation. A missing head cannot be reconstructed from whichever old receipts
happen to remain.

This durable head is essential. Retained observations A and A alone cannot
prove that a pruned intermediate B never existed. With the head retained,
observed A to B to A still has a different generation. With coverage evidence
missing, the system fails unavailable or begins a new epoch; it never guesses
continuity from a partial history. Current membership must also match the
actual completed collection and its retained item count. Pruning an original
review receipt or current collection membership withholds public and frozen
reads, not only the next publication attempt.

The inventory is bounded at 10,000 threads and an 8 MiB protected document.
Existing page/response budgets may impose a smaller practical limit; the
default source's 100 pages at ten threads per page permits 1,000 threads.
Exceeding a bound fails rather than treating a prefix as complete.

Equivalence means identical relevant descriptor, identity, authority, epoch
and generation across known complete observations. Native metadata changes
can conservatively require a new acceptance even when displayed text appears
unchanged. The contract does not establish an exhaustive remote edit history.
An edit and exact restoration between observations cannot be detected if the
API exposes no changed metadata. A stronger claim requires a separately
reviewed provider history contract.

## Protected independent acceptance

Existing authenticated evidence intake, source-use review, terms, participant
consent and independent enrolled reviewers remain the authority. The private
`request.detail` is a closed `accepted-feedback-threads/v1` record:

| Fields | Meaning |
| --- | --- |
| `schemaVersion` | Exactly `accepted-feedback-threads/v1` |
| `targetFactId`, `actorId`, `sourceMetricId` | Exact original observed native fact and author; source metric is `discussions_started` or `discussion_answers` |
| `repositoryId`, `discussionId`, `threadUrl` | Exact public native Discussion identity and locator |
| `sourceRevision`, `descriptorFingerprint` | Exact original full revision and minimized content descriptor reviewed |
| `authorityHash`, `coverageEpoch`, `generation` | Original protected authority and continuity proof |
| `observedAt` | Actual original collection observation, never a later scan time substituted into an earlier review |

The parser preserves the existing 2,000-character detail limit and rejects
extra or missing fields, nested records, malformed values and duplicate decoded
JSON keys. Escaped and literal aliases are duplicates. The current audited
source-use review must reference the exact original public thread URL and full
revision exactly once. The independent acceptance time and reviewer come from
the authenticated decision, not the submitted JSON.

Each selected recognition binding explicitly targets `helpful_feedback`, names
one native source metric and repository, enrolls its reviewers, and contains
`helpfulFeedback: {version: "accepted-feedback-threads/v1"}`. Separate
category/scope bindings may select thread authors and selected-answer authors.
Ambiguous bindings fail. The destination policy requires count aggregation,
`acceptedAt`, qualified author facts, canonical grouping and
`groupingPolicyVersion: "accepted-feedback-threads/v1"`.

Admission cross-checks the actual original and current stored observations,
content fingerprint, authority, epoch and generation. It verifies the native
fact/canonical identity, actual author ID/node identity, original observed
state, public artifact, roles, metric, source revision and distinct source,
observation, native selection and acceptance clocks. A correction, existing
recognized overlay, answer selector or ordinary comment cannot replace the
original author source. Current observation may postdate acceptance only when
this exact durable equivalence proof survives. The original observation and
source event must precede acceptance; acceptance and observations must fit the
selected frozen cutoff.

Every current matching alias is validated before any helpful-feedback host
callback or deduplication. The unit is contract version, repository, native
Discussion and credited author. Multiple receipts, the same author's start
and answer, or arbitrary caller changeset IDs cannot multiply a unit. Distinct
accepted authors remain distinct. The earliest current valid independent
acceptance wins. Native facts and source clocks remain intact alongside the
qualified overlay; only its independent acceptance clock determines the
feedback window. This supplies no overall productivity score.

Direct receipt consumers remain trusted hosts responsible for authenticating
their receipts and producing the same protected source evidence. A typed
descriptor or `verified` flag does not itself fetch a source or grant content
access. The production pipeline obtains provenance from its actual collection
and receipt store before calling the shared validator.

## Publication, privacy and retention

Scan context, normalized caches, frozen publication identity, private
confirmation, current/pinned reads, comparisons and replay verification bind
the new content version and exact coverage capture. Authority changes,
unfinished scans, changed content, missing coverage, withdrawal, changed
consent/intake, reviewer/policy changes and current privacy fences cannot
reconfirm an old accepted projection. Repeating an unchanged completed scan
preserves the original review while retaining its distinct scan identity.

Public evidence retains the existing metadata-only Discussion revision and
public thread locator. Content hashes, coverage generations, private claim
IDs and protected review records are not public evidence fields. Hashes may
still reveal predictable content to someone who has them; they remain
protected data under the explicitly enrolled retention policy.

The bounded derived-retirement manifest includes the actual feedback scan
receipts and heads before source erasure can complete. It checks the exact
repository and document binding, preserves unrelated repository payloads,
and supports durable retries. Existing checkpoint, private intake/audit,
backup and external-copy retention obligations still apply. This code supplies
no expiry schedule or operational purge attestation and does not invent
cross-store atomic deletion.

Synthetic tests exercise the real HTTP reader, pre-checkpoint minimizer,
collection SQL, protected controls, normalizer, metric engine, publication,
current/pinned and private frozen reads, persisted reopen, replay, withdrawal,
mutation/absence/resume continuity and authorized bounded retirement. Stored
sentinel checks cover actual checkpoint files and SQL/private records. These
are implementation checks, distinct from live permission, reviewer enrollment,
source availability and owner acceptance required before activation.
