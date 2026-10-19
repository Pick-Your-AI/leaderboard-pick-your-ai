# Physical line context

The optional private `github-physical-context/v1` receipt describes one complete
default-branch integration already admitted by the GitHub normalizer. It adds
context to the existing physical quantities; it does not change a metric's
quantity, canonical unit, attribution, qualification, or ranking policy.

## Exact source binding

The normalizer emits a receipt only for a merged pull request whose actual merge
revision equals the integration's pinned after revision. Its repository default
branch, PR target, integration target, and diff pins must agree. The original
physical facts must have the same identified lead author and integration clock.
Missing or contradictory source context leaves the receipt absent. Existing
physical facts retain their original behavior.

The closed receipt records the repository and artifact identity, lead author,
canonical integration, both immutable revision pins, target branch, clock,
classifier version, and every original emitted physical fact ID/canonical key.
It requires exactly one additions, deletions, and changed-lines fact, plus one
unit fact for each eligible changed path. Their quantities must reconcile with
the complete inventory. Three line facts and several file facts therefore still
describe one integration; they do not establish several PR samples.

The receipt consumes the current classifier's result. It does not run another
path heuristic, consult a latest revision, or infer a missing classification.
Source, test, and documentation buckets distinguish raw and eligible counts.
Generated, vendor, lock, binary, and imported buckets are explicitly excluded;
formatting-only changes remain separate. A complete empty inventory is known
zero. A negative additions-minus-deletions value remains descriptive physical
net change, without introducing a signed ranked metric.

All counts and aggregate arithmetic are safe integers. The inventory is bounded
to 10,000 files. Duplicate/missing fact bindings, incompatible counts, unknown
classifier versions, extra payload fields, and inconsistent exclusion totals
are rejected. The minimized receipt contains no file paths, emails, raw GitHub
payloads, credentials, or public-display grant.

## Persistence and public use

The pipeline retains this optional receipt inside the private normalization
document and its existing content hash. Its consumer rebinds every declared fact
ID, canonical key, metric, quantity, original author, clock and proof to the
actual normalized records and collected source. The scalar canonical integration
units, merged-source revision/link and target branch must agree. A valid-looking
substitute hash, receipt string or arithmetic total supplies no authority. The
same checks run when a cached receipt is consumed. Synthetic provenance remains
on the enclosing normalization and is never upgraded by a context receipt.

Receipt absence does not trigger rehydration, change the normalization signature,
or manufacture a receipt from surviving classifier totals. Existing cached
normalizations or snapshots without one remain unknown; they must not be
reinterpreted as measured zero or silently reclassified by a newer reader.
The protected source adapter still owns the truth of the examined diff.
Structural validation cannot independently certify physical repository bytes or
resist an authorized producer coherently replacing every source fact, proof and
classification before capture. A supplied receipt is not an independent diff
audit or a claim of individual line authorship.

## Selected evidence and retained reads

The pipeline selects context from the actual metric aggregate's complete
`evidenceIds`, not from portfolio grouping or a fetched proof page. Original
fact IDs, canonical units, revisions, quantities, actor and engine comparison
signatures must agree. Every file unit belonging to the selected integration
must remain selected for the file-change metric. Corrected, collapsed, missing
or contradictory units withhold the entire optional context; they never turn
the surviving receipts into a smaller subtotal.

The original `pr_merged` author proof is a private dependency, even when that
metric is not enabled for publication. It binds the actual merged revision,
repository, artifact and integration clock. Keeping this dependency does not
create an extra public contribution or require enabling a different board.
Private contexts and merge dependencies are excluded from public serialization.

The same complete receipt can support the four physical metric contexts without
consuming four distinct-source budgets. Every copy must agree on the entire
parsed receipt and merged-evidence ID for the same repository, canonical
integration and actor; duplicate samples within one metric are rejected. A
separate raw-copy bound applies before schema parsing, while the original
40,000 distinct fact-reference budget remains. Discounting an identical copy
does not skip current dependency checks or authorize a conflicting receipt.

Snapshots with available physical context retain the existing private
`identityEvidence.normalizationSources` pairs and original document hashes.
Historical reads check those exact retained normalization copies under the
existing source authorization and locks. A missing copy, corrupted original
hash or coherently rehashed replacement makes the whole optional context
unavailable. The check does not fetch GitHub, call the normalizer, rewrite the
selected snapshot, change its metric quantities or replace its source pins with
a latest revision. The original explanation hash remains bound across awaited
work, and the existing final confirmation, configuration and privacy checks
still apply. Mandatory explanation corruption and unexpected storage errors
retain their existing failure path.

## Public response and exports

New snapshots that capture the versioned
[ranking presentation policy](ranking-presentation.md) can expose the closed
`physical-context/v1` row property. The response binds the selected snapshot,
actor, metric, methodology version and signature, complete selected evidence
IDs, metric quantity when present, and exact integration clocks. Each sample
has an opaque ID, repository and artifact identity, public PR URL, and distinct
before/after revision links. The before link is a pinned reference; displaying
it does not claim that the client fetched or tested that revision.

Current actor, artifact, repository and role privacy applies to every dependency
before any physical count, source pin or budget reason is released, including
historical snapshot reads. An unavailable dependency yields a count-free
unknown context, or the existing whole-row/response withholding required by its
ordinary evidence controls. A public size limit never truncates a sample list:
the entire context must fit within 10,000 selected units and 128 KiB. Combined
summary arithmetic passes the same safe-integer and exclusion checks as each
original receipt.

JSON and CSV `public-export/v4` carry the same row context, selected policy and
evidence binding. CSV uses a dedicated `physical_context` cell; a null cell is
explicit absence, not zero. Readers reject contradictory selected values,
unknown fields, malformed revision pairs, duplicate samples or evidence IDs,
out-of-window integrations and mismatched minimized source proofs. Export byte
and page limits remain in force independently of the optional context budget.
Legacy `public-export/v1`–`v3` retain their established fields and columns; they
do not infer a physical context or presentation policy from current code.

## Reading the breakdown

The board displays physical volume as context beside the unchanged metric. It
shows eligible additions, deletions, descriptive net change, changed lines,
file changes, PR sample count, selected evidence-record count and the original
revision links. File changes are repository/path/PR units: the same path changed
in two PRs can contribute two file changes. A PR sample is one selected canonical
integration, not every merged PR by the contributor. Neither sample count nor
evidence-record count substitutes for the metric's line quantity.

| Classification | Displayed context                               | Delivered physical totals |
| -------------- | ----------------------------------------------- | ------------------------- |
| Source         | Raw and eligible files, additions and deletions | Eligible changes count    |
| Tests          | Raw and eligible files, additions and deletions | Eligible changes count    |
| Documentation  | Raw and eligible files, additions and deletions | Eligible changes count    |
| Generated      | Raw classified changes                          | Excluded                  |
| Vendor         | Raw classified changes                          | Excluded                  |
| Lockfiles      | Raw classified changes                          | Excluded                  |
| Binary         | Raw classified changes                          | Excluded                  |
| Imported       | Raw classified changes                          | Excluded                  |

Formatting-only exclusions are shown separately. Unknown or legacy absence
shows no invented zero, count or revision link. The complete examined inventory
is distinct from repository history coverage, which remains visible separately
with its original freshness and limitations. Volume does not measure effort,
quality, source rights or overall contributor merit. The display policy can
withhold a small cohort's ranks without changing measured physical values;
`files_changed` remains descriptive and unranked under its existing definition.

The synthetic normalizer, private binding, persisted-reopen, public API,
serialized-reader and UI cases verify their named boundaries. They do not
certify real repository coverage, provider rights, physical-byte truth, a live
deployment or unexecuted browser scenarios. Actual executed checks must retain
their own source and environment identities.
