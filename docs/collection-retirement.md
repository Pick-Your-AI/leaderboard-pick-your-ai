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
The deployment must grant its designated protected retention role the required
function and table permissions. Database owners remain trusted migration
administrators; this is not a defense against an administrator rewriting tables
or disabling database protections.

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

Rollback 005 is allowed only while no retirement record exists. Once a permanent
retirement is recorded, rollback refuses to discard that history. Restoring an
older backup still requires loading the current retirement/suppression authority
before serving, collection or replay, as described in [recovery](RECOVERY.md).
This migration does not supply that cross-store recovery composition.

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

Foreign-key references from other stores block the entire batch. PostgreSQL
rolls back the attempted deletions of facts, links and enrichment together;
the operation retains its permanent fence and a `blocked` receipt with
`retained_dependencies`. A corrupt collection-item link from another repository
also blocks rather than deleting unrelated scope. No trigger is disabled, table
truncated or downstream relation cascaded by either API.

After the concrete owning store removes its authorized dependency, the same
blocked batch ID can retry. Its attempt count advances. An already successful
batch returns its original counts and completion clock without deleting another
batch; changing its limit rejects. Each operation has a 10,000-batch receipt
capacity guard. Exhaustion rejects and requires a separately reviewed archive
procedure; it does not delete audit history or silently change the operation ID.

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
locking. The embedded lane explicitly skips that multi-connection case.

The existing [cross-store investigation](source-retention-boundary.md) identifies
the remaining pipeline, controls, checkpoint and recovery work. This change
supplies the collection fence and scoped source-row deletion; it does not close
#95, certify production retention or replace those remaining implementations.
