# Issue creation across repository transfers

This pipeline boundary conserves an observed issue creation across proven
repository representations. It does not supply a historical collector, prove a
missing native destination, or establish completeness for other metrics.

## Identity and source scope

The normalizer emits two private typed projections alongside its existing raw
facts and lineage:

| Projection                       | Admission                                                                                         | What it establishes                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `github-issue-transfer/v1`       | Exact source observation and protected public source/destination coordinates                      | The two provider artifact IDs represent the transferred issue. |
| `github-issue-creation-scope/v1` | An actual webhook `opened` event, event ID, and explicit occurrence equal to native creation time | The repository of that observed creation event.                |

An equal native artifact ID also establishes identity without an enriched
transfer edge. A title, generic lineage entry, current REST snapshot, or an
assumed old issue number does not establish a different-ID alias or its birth
repository. The raw transfer fact remains activity by its original actor; it
does not become another issue creation or authorship credit.

Current repository scope follows a continuous, unambiguous transfer chronology
or a later explicit current observation. Event repository scope requires the
actual opened proof. Unknown or contradictory scope produces an explicit
unavailable/conflict disposition; it is not assigned to the first observed
repository. Current Project context comes from the selected current endpoint.
A source Project is not inherited through the transfer.

The immutable original facts and evidence remain private source records. A
derived creation retains an original canonical fact ID for correction admission,
uses an actually observed creation clock, and exposes only a proven endpoint
locator. Its public repository scope remains the requested scope. Additional
repositories required for private proof are not new approved public sources.

## Retained proof and configuration changes

`pipeline-issue-transfer/v1` metadata binds the typed records to their exact
source row and referenced observations. The relational index points to the
normalization's fact key, policy signature, and document hash. Its endpoint
projection supplies bounded graph discovery without a predicate over mutable
JSON arrays. Every selected document is then hashed before its metadata is read,
and every indexed endpoint is matched to the rederived projection.

Discovery can find a retained source through a selected destination even when
the source is absent from the current configuration. Retained coordinates prove
dependency identity; current configuration and repository access separately
govern permission. A missing, unavailable, unapproved, or mismatched endpoint
withdraws its connected aliases. It does not add its private actors to the
public view or withdraw unrelated issues merely because they share a repository.

The installation migration pages all preceding normalization rows and verifies
their hashes before metadata presence checks. Untyped cache history is not
subject to the typed graph's record limit. A same-source refresh cannot silently
drop an already admitted typed binding.

## Current privacy and private captures

Current suppression expands across the complete proven component, including
retained edges omitted by a later normalization and endpoints with no current
source view. Exact native artifact dependencies are discovered through retained
`source_artifacts` as well as typed transfer endpoints.

Frozen captures separately bind the literal selected repository scope, exact
normalization pointers, and actual dependency generations. Later dependency
growth does not rewrite old evidence. Each public/pinned read and private
comparison rechecks the current graph, source permission, and correction
authority. An old capture that lacks required binding evidence is unavailable.

An immutable correction receipt remains bound to its original fact and operation.
If new proof changes the canonical creation selected for a view, a transient
projection applies that exclusion to the same proven creation. A private-capture
exemption requires that exact projected exclusion to have been effective in the
same hash-bound capture. Merely proposing a mapping does not confer an exemption.

## Lock order and final admission

Graph membership is protected by a transaction-scoped namespace advisory gate.
Repository access rows are discovered first and locked in numeric order before
normalization locks. The graph gate prevents a previously unseen endpoint from
appearing between discovery and final source admission.

| Path                                     | Graph gate | Repository gates | Following work                                                                                 |
| ---------------------------------------- | ---------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| Publication and public/private reads     | Shared     | Shared           | Verify retained proof and perform the existing final source-authority check.                   |
| Normalization and dependency persistence | Exclusive  | Update           | Persist exact normalization, artifact dependencies, and endpoint index together.               |
| Correction and reviewed reversion        | Shared     | Update           | Recheck source/receipt authority and persist the correction without changing graph membership. |
| Authorized derived erasure               | Exclusive  | Update           | Preserve unavailable IDs before deleting the owned proof and dependencies.                     |

No path upgrades a shared graph gate while holding repository locks. The eraser
acquires its graph/dependency gates before its owning repository lock. Network
hydration completes before normalization persistence acquires the exclusive
gate. Existing protected authorization callbacks are still rechecked inside
correction/retirement transactions; they must not reenter graph/source-locking
work on a second connection while waiting for that same transaction. Their
duration remains part of the protected transaction, and no claim is made that an
arbitrary injected callback is network-free.

Dispatch completion prepares its shared graph and repository gates at transaction
entry, before taking the outbox lease row. Operator replay and health readers
prepare the same gates after initial operator authorization and before their first
source row. Nested publication verification therefore follows the same order.
Its content check uses the exact retained dependency IDs and transfer-evidence
hash; an older capture without this binding keeps its original absent-field hash.

Discovery preserves its final single SQL access/removal/Project-denial statement.
The current graph and dependency set are captured under the same source gates,
and alias removal expands synchronously after that statement. Existing host
approval, control-epoch, and final-read checks remain separate requirements.

## Permanent retirement

Before an authorized eraser removes an issue normalization, it retains only a
minimal unavailable artifact ID. This includes untyped issue normalizations:
the same native ID may already occur in another repository without any explicit
transfer metadata. The minimal record has no foreign key to the erased source
and carries no actor, title, URL, raw payload, or source content.

The lookup is by normalized artifact identity across repository configurations.
Consequently, erasing the final source/artifact rows or omitting the retired
repository from configuration cannot make that issue visible through an old or
new representation. Existing object-suppression reasons and original retirement
or correction receipts are preserved. This does not create permission to erase
other repositories or to rewrite their source facts.

## Bounds and validation scope

Typed discovery is bounded to 10,000 normalization pointers, 10,000 distinct
artifact IDs, 20,000 endpoint/transfer records, and 100 actual repository
dependencies. Exceeding a bound produces an explicit unavailable/error result;
it does not truncate a component and publish partial credit. These are local
admission limits, not measured production sizing or history-completeness claims.

The focused tests cover pure provenance/projection cases and synthetic database
admission, privacy, correction, and retirement scenarios. A single-connection
PGlite test can verify transaction results and modeled lock order; it cannot
prove PostgreSQL interconnection scheduling or production race behavior.
