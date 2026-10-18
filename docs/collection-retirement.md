# Permanent collection retirement and bounded source deletion

Refs [#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95) and
[#74](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/74).
`RepositoryRetirementStore` provides an executable PostgreSQL collection boundary.
It retires one exact numeric repository identity and separately deletes bounded
batches of its collected source facts. It does not choose a retention duration or
complete deletion across all application stores.

## Explicit migration and authority

Apply `packages/ingestion/sql/005_collection_retirement.up.sql` in a transaction
after migrations 001–004. Hosts opt into this migration; importing the package
does not migrate or retire anything. Existing migration files are unchanged.
The new deletion function is not executable by the PostgreSQL `PUBLIC` role.
It is `SECURITY DEFINER` with a fixed `pg_catalog` search path; every application
relation is schema-qualified. Its trusted owner must also own the erasure-receipt
table. The receipt trigger remains `SECURITY INVOKER` and permits writes only as
that table owner. Direct table grants to another role cannot forge the temporary
delete exception. Ownership drift therefore fails closed on receipt mutation.
All new and replaced guards also fix their search path to `pg_catalog`, so a
caller's schema or overloaded operators cannot alter their authorization checks.

Configure privileges explicitly when applying this optional migration:

- Ordinary ingestion writers retain their existing repository row-lock/table
  privileges and need `SELECT(repository_id)` on `repository_retirements` for
  the new invoker visibility guards. An active repository's payload writes must
  remain usable with these grants.
- A protected erasure caller needs schema `USAGE` and `EXECUTE` on
  `erase_collected_source_batch(text,text,integer)`. The TypeScript wrapper also
  needs `SELECT` on `repository_retirements` to verify all retained request
  identity fields. Do not grant it direct batch writes or source `DELETE`.
- The host that creates permanent retirement decisions requires the existing
  repository update privileges plus retirement-table `SELECT`/`INSERT`. Treat
  that role as a trusted retirement authority, separate from an ordinary source
  writer, and enforce the current authorization callback at its protected entry.

Migration/table owners remain trusted administrators; this is not a defense
against an owner rewriting tables, changing ownership or disabling protections.

Both API methods require the same exact request: `operationId`, `repositoryId`,
`expectedGeneration`, `policyVersion`, `authorizationReceipt` and `operatorId`.
The protected host must verify a current, attributable decision authorizing
**permanent repository collection retirement**. An observation-expiry cutoff,
transport failure or source becoming temporarily private is a different scope.
The callback receives a frozen copy of these fields and must return exactly
`true`; it is checked before work and again before commit. Missing or changed
authority rolls back the transaction. The library does not invent the operator,
policy or authorization receipt, and supplies no HTTP endpoint or scheduler.

`retire(request, authorize)` locks the existing repository row, checks its
expected generation, makes it unavailable, advances that generation and inserts
an immutable retirement record in one transaction. A retry with identical fields
returns the original receipt. A reused operation ID, repository, policy,
authorization, operator or original generation cannot change the decision. An
unknown repository or stale generation rejects before mutation.

## Durable serving and collection fence

The retirement record is distinct from installation lifecycle receipts. No
private/removed/revoked webhook is fabricated. A later public-visibility probe
cannot reactivate a retired repository, even with its current generation.
Database guards use the same repository row lock as collection and public
publication. They reject new retired collection runs, source facts, delivery
payloads and normalized delivery observations. A network request already in
flight cannot commit its source page after retirement. A source transaction
that already holds the row lock finishes before the retirement commits, so its
facts remain inside the subsequent deletion scope.

Existing retained-state replay, latest/pinned snapshot reads and notices obey
the unavailable repository gate. The actual pipeline's current boards and
exports return unavailable; pinned boards, evidence and exports return the
existing withdrawn-snapshot response. A database reopen does not clear this
fence. The separate controls public projection and external caches still need
their own coordinated retirement mechanisms; this collection fence alone does
not claim those copies are withdrawn.

Rollback 005 is allowed only while both the retirement and erasure-receipt tables
are empty. Its isolation check, locks, history check and every removal run inside
one atomic `DO` statement. It supports a standalone statement or an existing
`READ COMMITTED` transaction. An inherited `READ UNCOMMITTED`, `REPEATABLE READ`
or `SERIALIZABLE` transaction rejects with
`retirement_rollback_requires_read_committed` before changing any guard. In
particular, a repeatable snapshot could otherwise hide a retirement that committed
after the caller's earlier read, even after acquiring the required table locks.

Before reading history, rollback takes `ACCESS EXCLUSIVE` locks on repository
access, retirement history, erasure receipts and every other table touched by its
DDL. It requests repository access first, matching retirement's write order.
Every lock uses `NOWAIT`: conflicting traffic rejects immediately with SQLSTATE
`55P03`, so quiesce the active work before retrying. This also avoids waiting in a
cycle with an eraser or payload writer that already holds a dependent-table lock
before requesting repository access. The locks remain held through the end of
the containing transaction, covering both the fresh history check and the final
removal. See PostgreSQL's [table-lock and snapshot rules](https://www.postgresql.org/docs/16/sql-lock.html).

Once a permanent retirement or receipt is recorded, rollback rejects with
`retirement_history_prevents_rollback`. A failure in a later DDL operation also
restores all earlier guard changes in the statement. Restoring an older backup
still requires loading the current retirement/suppression authority before
serving, collection or replay, as described in [recovery](RECOVERY.md). This
migration does not supply that cross-store recovery composition.

## Bounded deletion and honest receipts

`eraseBatch(request, batchId, limit, authorize)` requires an already committed
retirement and an explicit batch limit of 1–100. It locks that repository and
selects exact fact keys in stable order. Only those retired source rows, their
collection-item links and their ingestion enrichment jobs can be deleted.
Collection-run/page metadata, delivery/observation history, snapshots,
normalizations, controls records and backups are outside this deletion claim.

Ordinary source `UPDATE` and `DELETE` remain forbidden. The reviewed migration
adds a narrow delete exception while the bounded function holds an active batch
for the same transaction, repository and selected keys. The active keys and
transaction ID are cleared before the function returns. Completed receipts do
not grant later deletion access, and successful batch receipts are immutable.
The source-fact and collection-item indexes bound selected-key lookups, while
partial receipt indexes keep capacity/completion checks independent of the size
of successful audit history. The limit counts source facts; it does not claim a
fixed latency or cap every downstream row associated with those facts.

Foreign-key references from other stores block the entire batch. PostgreSQL
rolls back the attempted deletions of facts, links and enrichment together;
the operation retains its permanent fence and a `blocked` receipt with
`retained_dependencies`. A corrupt collection-item link from another repository
also blocks rather than deleting unrelated scope. No trigger is disabled, table
truncated or downstream relation cascaded by either API.

After the concrete owning store removes its authorized dependency, the same
blocked batch ID can retry. Its attempt count advances. An already successful
batch returns its original counts and completion clock without deleting another
batch; changing its limit rejects. Each operation permits at most 10,000
unfinished batch receipts. At that limit an existing blocked batch can still
retry and finish; successful audit history does not impose a lifetime deletion
ceiling. An initially empty scope can record one successful empty batch. After
completion is recorded, another new empty batch ID rejects with
`source_scope_already_erased` without growing audit history. Retrying the exact
successful ID still returns its original result. Stop requesting new batches
when `sourceFactsRemaining` is false.

The result reports deleted source-fact count, whether any source facts remain,
attempt, completion time and a blocked reason. A successful batch is not complete
privacy deletion. These are logical database-row deletions: PostgreSQL storage
reclamation, WAL, encrypted backups and controlled external copies retain their
separate host-specific deletion and verification requirements. Receipt tables
retain minimal scope/authority identities and counts, not source documents,
URLs, actor payloads or completed-batch fact keys. Those integrity records remain
protected data with their own justified retention policy.

## Verification

```sh
npm run build
node --test packages/ingestion/test/retirement.test.mjs
node --test apps/pipeline/test/retirement-fence.test.mjs
```

The tests use synthetic identities and actual disposable PostgreSQL/PGlite stores.
They cover exact-scope deletion, duplicate requests, bounded retries, foreign-key
failure/rollback, authority loss before commit, delayed collection, immutable
source/audit guards, migration rollback/reapply and current/pinned API readback
after reopening the database. The hosted ingestion workflow also uses a fresh
dedicated PostgreSQL test database to exercise real independent-connection row
locking. The rollback race test pauses an actual retirement before commit,
observes either rollback rejection or a real PostgreSQL lock wait, then lets the
retirement commit. It requires rejection before that commit; an old script that
waits at a later `DROP` cannot pass merely because it eventually times out.
Separate PostgreSQL tests establish genuinely stale `REPEATABLE READ` and
`SERIALIZABLE` snapshots before another connection commits a retirement. Rejected
attempts preserve the guard schema and permanent fence. The embedded lane
explicitly skips these independent-connection cases; its isolation-configuration
and late-DDL-failure tests do not claim real concurrent execution.

The existing [cross-store investigation](source-retention-boundary.md) identifies
the remaining pipeline, controls, checkpoint and recovery work. This change
supplies the collection fence and scoped source-row deletion; it does not close
#95, certify production retention or replace those remaining implementations.
