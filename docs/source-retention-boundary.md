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

## Pipeline-owned derived component

[Pipeline-derived retirement](pipeline-derived-retirement.md) consumes the exact
committed collection-retirement authority and removes explicitly bound unlinked
pipeline payloads through bounded PostgreSQL/SQLite manifests and acknowledgements.
It preserves unrelated sources and immutable dispatch/replay proof, reports retained
proof as incomplete, and fences delayed derived writes and private confirmation.
Its scoped receipt does not cover general controls records, other stores, backup
copies, retention windows or a deployed purge schedule. The historical investigation
below remains the baseline for the remaining cross-store requirements.

## Internal driver for the delivered components

The protected host can call
[advanceRepositoryRetirement](../infra/retention/repository-retirement.mjs) to
coordinate permanent retirement of collected source facts, pipeline-owned derived
payloads and one exact repository checkpoint namespace. This internal API does not
install a schedule or public endpoint, choose a retention window, apply migrations,
or authorize an operation itself. It uses the existing collection ledger, derived
manifests and receipts, and checkpoint tombstone. There is no new journal or table.

The input contains the six existing collection-retirement fields as `retirement`
and the three existing checkpoint fields as `checkpointBinding`. Both operation
IDs must match. The checkpoint `policyId` and `authorizationId` remain distinct
from the SQL `policyVersion` and `authorizationReceipt`; equality is neither
assumed nor substituted for approval. The protected host supplies the actual SQL
database, Controls store, scoped checkpoint store and an `authorizeEnvelope`
function. That function must authorize the complete exact envelope on every call:

```js
const envelope = {
  retirement: {
    operationId,
    repositoryId,
    expectedGeneration,
    policyVersion,
    authorizationReceipt,
    operatorId,
  },
  checkpoint: {
    repositoryId,
    binding: { operationId, policyId, authorizationId },
  },
  options: { sourceLimit, derivedLimit, cursor },
};
```

The envelope includes normalized, frozen options: both validated requested limits
and the validated cursor (or `null` for a new invocation). The host can reject a
specific requested option or resume context. These options are authorization
context and do not enter the deterministic batch identity.

The host must approve permanent retirement of these components under the current
policy and operator authority. A cursor, an operation hash or a receipt is not an
authorization credential. The callback must return exactly `true`; denial or an
authorization-service error propagates. Authorization is rechecked at native
transaction boundaries, before checkpoint cleanup and before returning a result.
It must cover native retries at their already persisted batch limits: the optional
`sourceLimit` and `derivedLimit`, each an integer from 1 to 100 and defaulting to
100, apply only when a new batch is admitted. Changing those requested limits
cannot rewrite or replace an existing batch.

### Preflight, progress and interruption

Before installing a new fence, the driver validates both component requests, both
limits and the entire optional cursor. It rejects accessors, proxies, unknown
fields and malformed cursor references. The checkpoint store must expose the new
read-only `preflightRetirement` capability; an older custom scoped store remains
usable by existing clients, but this driver rejects it before retirement.
Preflight checks the exact marker binding and existing cache/authority/namespace/
payload directory layout without creating a marker or deleting files. Source
progress also checks the exact six-field operation and repository generation under
the existing repository lock.

The phases retain the existing component lock order:

1. Replay or install the permanent collection fence.
2. Replay the derived PostgreSQL admission and repair its SQLite fence if a prior
   interruption committed only the PostgreSQL side.
3. Replay checkpoint retirement, including cleanup and durability work even when
   its exact marker already exists.
4. Replay derived manifests and receipts. Only the actual native
   `owned_scope_erased` receipt at stage `complete` permits source erasure.
5. Finish pending source batches before using a terminal source receipt. Recheck
   that no source batch remains pending and reauthorize before reporting the
   bounded internal result.

These stores do not share one atomic transaction. A concurrent state change or
authorization loss after preflight can leave a permanent fence or partial durable
work. Such an error is returned unchanged; it is not a generic retry success or a
claim that earlier commits were rolled back. Retrying the same exact authorized
operation repairs the admitted components through their existing APIs.

Both new `readProgress` methods return protected metadata hints. Collection
progress uses the existing operation/repository identity, pending index, terminal
index and exact batch key. Derived discovery selects at most 65 ordered manifest
metadata rows, exposes at most 64 entries, and returns the last exposed key as a
continuation. Neither method enumerates payload bodies or treats a status hint as
proof of deletion. Before using a hint to advance or complete, the driver calls
the existing batch API with the persisted ID and limit and verifies its actual
immutable receipt.

New driver batch IDs are deterministic digests of the exact operation, component
and the previous replayed receipt. An unfinished batch is retried under its
persisted identity; a final receipt is replayed before deriving a successor.
Concurrent callers using different requested limits converge on the winning
persisted limit. Only that proven limit race, a known pending batch or an already
recorded terminal disposition produces a retry/discovery result. Integrity errors,
foreign operations and authorization failures remain errors.

The returned cursor is a private resume hint, bound to the operation and exact
checkpoint binding. Keep it to avoid replaying older progress. A lost cursor can
start again: the driver replays its deterministic chain or discovers existing
native work one metadata page per invocation. Each cursor reference must resolve
to the same retained operation before any new fence is installed.

### Result and resource boundaries

`internal_components_erased` means that this invocation obtained the actual
collection fence, derived admission, checkpoint cleanup, verified derived terminal
receipt and source erasure receipt, observed no pending source batch, and passed
the final authorization check. A `blocked` result, including
`retained_dispatch_authority`, remains incomplete. `in_progress`, `retry` and
`discovering` return the next private cursor; none is a deletion receipt for the
whole product.

An invocation performs at most one new or previously unfinished SQL-component
payload batch, or one 64-entry discovery page with a one-row continuation probe.
It may replay already finalized receipts and repeat checkpoint cleanup. This is
not a universal I/O, heap or duration bound: existing checkpoint cleanup removes
the exact namespace recursively, and native derived admission/erasure retains
its existing scope-validation scans and Controls reads. The default file
checkpoint store still supports one process sharing its private directory;
concurrent calls in that process do not establish cross-process filesystem safety.
A deployment with multiple checkpoint-writing processes needs a separately
qualified transactional backend or locking design.

The result excludes general Controls requests/audit, retained dispatch and replay
proof, legacy unscoped checkpoints, webhook inbox/observation stores, collection
run/page metadata, external caches/search indexes, backup copies and restore
acceptance. In particular, source retirement removes selected `source_facts` and
their `collection_items`/`enrichment_jobs` dependencies; it does not remove
`collection_runs` or `collection_pages`. The accepted private decision history
stored inside a source fact is covered when that fact is erased, while the run's
`decision_producer` remains part of retained run metadata. Ordinary derived
normalizations, source artifacts and source modes remain covered by their existing
exact fact/repository bindings, including sources with no recognized metric facts.

The [store-backed integration cases](../infra/retention/test/repository-retirement.test.mjs)
use the actual PGlite adapter, Controls SQLite store and private
`FileCheckpointStore`. They cover preflight rejection, exact authority, interrupted
admission and acknowledgement, durable reopen, final receipt-disclosure denial,
same-process concurrent calls with a forced absent-ID admission race, changed retry
limits, bounded metadata discovery, multiple blocked source receipts
and retained proof. They do not establish independent PostgreSQL-session races,
multi-process checkpoint safety, deployed policy or external-store deletion.
Existing PostgreSQL retirement tests remain a separate gate. No production
retirement or completion of #95 is implied by adding this internal driver.

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
