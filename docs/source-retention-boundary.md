# Source retention: remaining cross-store boundary

The source-retention portion of [#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95)
requires actual deletion and durable receipts, not only hiding a source or expiring
backups. This investigation is based on integration commit
`67aa5c8bd97dde8fa0d9c16bdbc3e8b22476fe02` on 18 October 2026. It introduces no
purge job, migration, retention duration or production operation. The separate
[authentication-expiry module](../infra/retention/controls-expiry.mjs) removes only
expired authentication state under its existing deadlines; that narrower mechanism
does not remove contribution evidence.

## Delivered checkpoint component

[Repository checkpoint retirement](repository-checkpoint-retirement.md) now supplies
an exact numeric repository namespace, an operation-bound permanent tombstone,
scoped cleanup and restart/in-flight fencing for the default collector and built-in
normalizer. Its receipt covers only that repository's checkpoint payloads and
explicitly excludes legacy unscoped bytes. The initial investigation below records
the earlier baseline; this component resolves part of its checkpoint obstacle,
while the coordinated SQL, controls, publication and restore requirements remain.
The checkpoint operation alone is not completion of #95.

## Verified obstacles at the investigation baseline

| Boundary                        | Actual implementation                                                                                                                                                                          | Why a generic purge coordinator is insufficient                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable raw source facts      | [Migration 003](../packages/ingestion/sql/003_collection.up.sql) installs `immutable_source_fact`, rejecting every UPDATE and DELETE                                                           | A regular delete job fails. Disabling the trigger or using TRUNCATE would bypass an integrity boundary and is not a scoped audited retention implementation.                                                                                                                            |
| Recollection                    | [CollectionStore.verifyPublic](../packages/ingestion/src/collection.ts) accepts a fresh probe using the current generation                                                                     | `repository_access.state='unavailable'` is reversible. The only sticky installation guard is an actual `reason='revoked'` lifecycle receipt. A retention operation must not forge such a webhook receipt. A distinct permanent retention tombstone is needed.                           |
| PostgreSQL projections          | [Pipeline runtime](../apps/pipeline/src/runtime.mjs) retains normalizations, snapshots, frozen inputs, policy comparisons, corrections, dispatch bindings, receipts and aggregate explanations | Deleting a public snapshot alone leaves reconstructible inputs and duplicate copies. Policy comparisons contain evidence differences and audit trails; their JSON document references `snapshotId` without a foreign key. Removing a head alone does not erase its historical snapshot. |
| SQLite public output            | [ControlStore.projectPublic](../apps/controls/src/store.mjs) publishes accepted claims and profiles independently of PostgreSQL access state                                                   | A SQL tombstone alone cannot hide or delete those claims. Locator URLs, contributor IDs and receipt IDs are not a complete shared repository-retention key. Free-form request/audit content cannot be reliably scoped by substring matching.                                            |
| Approval and correction history | Controls store JSON retains requests and audit; pipeline keeps reviewed receipt bindings and corrections                                                                                       | Deleting the receipt before installing a durable semantic tombstone can remove the reason a later replay must reject the contribution. Keeping all audit content defeats source-content deletion. Define a minimal retained integrity receipt separately from deletable payload.        |
| Collector checkpoints           | [CheckpointStore](../packages/github/src/checkpoints.ts) exposes `load`/`save`; filesystem paths hash the opaque key                                                                           | There is no scoped enumerate/delete interface or mandatory retention check. A cached completed scan can retain source results beyond SQL cleanup. A callback reporting success cannot prove every cached copy is gone.                                                                  |
| Recovery                        | [Backup implementation](../infra/recovery/backup.mjs) reapplies an injected current suppression policy                                                                                         | A restore must load a durable tombstone authority newer than the backup before any read, replay or publication. Backup expiry and an acknowledged cache callback do not establish that restoration cannot reintroduce removed evidence.                                                 |

## Disposable synthetic probe

A local probe applied ingestion migrations 001–004 to a new in-memory PGlite
instance, used the actual built `CollectionStore`, and opened a new temporary
`ControlStore`. It used fictional repository/installation/account IDs and no
network, credentials or external database. It verified these concrete outcomes:

1. Insert one source fact under a real collection run; deleting that exact fact
   raises `immutable_source_fact`, and its row remains present.
2. Set the repository unavailable and advance its generation; a subsequent
   `verifyPublic` call with that current generation succeeds and returns the
   repository to public state. This is expected source-recovery behavior, not a
   durable retention ban.
3. Persist one fictional accepted evidence claim in the controls store; SQL
   repository denial leaves that independently published claim present in
   `ControlStore.publicSnapshot()`.

All assertions passed. Temporary stores were closed and removed. This is evidence
of the current integration boundary, not a deletion implementation or a real
PostgreSQL concurrency result. Existing ingestion tests already protect source-fact
immutability and generation fencing; no redundant permanent test was added merely
to assert that the proposed feature remains absent.

## Required engineering change before a source purge can report completion

A safe implementation needs a coordinated change across ingestion, pipeline,
controls, checkpoints and recovery, not just a new scheduled callback:

1. Define an exact retention scope and clock. Distinguish expiry of observations
   before a reviewed cutoff from permanent repository/actor exclusion. Specify
   treatment of still-current aggregates containing expired inputs and of shared
   records containing both retained and removed contributors. Do not infer a
   duration, actor identity or repository from display text.
2. Persist a distinct, authorized, operation-bound tombstone before deleting
   payload. Its minimal receipt needs scope, cutoff, policy/authorization identity,
   generation and retry state without retaining the payload being removed. Every
   collection, enrichment, snapshot publication, pinned/current read, policy
   preview, receipt materialization and controls public projection must consult
   the same durable meaning. A reapproval or fresh visibility probe must not clear
   this tombstone accidentally.
3. Add an explicit audited deletion exception through a reviewed migration while
   keeping ordinary source UPDATE/DELETE forbidden. Bound each batch, retain
   operation identity across retries, and fence concurrent workers/publication.
   Walk actual foreign-key dependencies and JSON references, including frozen
   inputs, policy comparisons, dispatch publications, collection items and modes.
   Do not broadly delete unrelated repositories, pending requests or audit records.
4. Give controls and checkpoint stores actual scoped deletion/tombstone APIs with
   comparable retry receipts. Keep public reads blocked while any required store
   is pending, failed or has an older fence. An SQL transaction cannot atomically
   acknowledge an unrelated SQLite transaction.
5. Require separately configured backup/cache adapters to return verified
   operation-bound acknowledgments, and have restore/import paths enforce the
   permanent tombstone. Missing or partial acknowledgment remains blocked;
   it must not produce a completed deletion receipt.
6. Prove crash recovery and concurrency with the real stores: crash after each
   boundary, retry after SQL success/SQLite failure and the reverse, concurrent
   source reprobe, stale checkpoint replay, old snapshot pin, policy comparison,
   recognition withdrawal, encrypted backup restore and cache failure. Verify
   unrelated scopes remain intact and removed payload is absent from each store.

These are implementation dependencies, not requests for production access. The
engineering work remains authorized, but a coordinator cannot safely claim the
required invariant without changes to all these paths and independent review.
Approved retention cutoffs/policy, external cache and backup architecture, operating
ownership and deployed recovery acceptance remain additional external gates. This
investigation changes no issue status and does not mark #95 complete.
