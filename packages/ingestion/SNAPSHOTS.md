# Atomic retained-state snapshot candidate

Partial backend delivery for [LB-05.05 / #62](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/62), with additional reproducibility/recovery coverage for [LB-06.06 / #85](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/85). This publishes internal retained-object-state revisions. It does not implement contribution scores, public rankings, public read routes, source completeness, evidence qualification or a UI.

## Transaction and identity

`SnapshotStore.publishObjectState(repositoryId, subjectId, definitionVersion, expectedRevision)`:

1. Validates explicit stable scope, definition label and expected decimal revision.
2. Acquires a PostgreSQL transaction-owned advisory lock for that scope, including its first publication.
3. Checks the current revision against the caller's expected revision; stale publishers fail with `snapshot_revision_conflict`.
4. Reads and reconstructs that scope's retained observations in one statement on the transaction's connection. Replay has the existing 256-record bound and explicit uncertainty semantics.
5. Derives a `retained-state-snapshot/v1` document containing scope, definition/computation versions, retained-only coverage, receipt count and the full evidence-preserving replay.
6. Inserts the immutable snapshot, advances the current head, and inserts a compact scoped-revision notice in the same transaction. Only committed results are returned to the caller.

The snapshot ID is SHA-256 over canonical JSON with sorted object keys. Array order comes from deterministic replay. This avoids dependence on PostgreSQL JSONB key ordering. Stored snapshot IDs are checked against reconstructed content when read, along with the document's format, scope, coverage and replay. Snapshot payloads cannot be updated or deleted through normal SQL because the migration installs an append-only trigger. The current head is a separate mutable pointer.

Rebuilding unchanged evidence with the same definition label returns the existing snapshot and revision with `changed: false`; it emits no duplicate notice. New evidence or a different definition label changes the content identity. A definition label records the caller's selected definition; accepting it as an argument does not certify owner approval or evaluate an arbitrary scoring policy. Computation is explicitly pinned to `transition-replay/v1`.

Publication time and original snapshot creation time are separate database timestamps outside content identity. Revisions are canonical decimal strings backed by PostgreSQL `bigint`, so JavaScript number precision cannot corrupt a cursor. A scope begins at expected revision `"0"`; its first successful publication is `"1"`. Revisions advance monotonically within that scope, with overflow rejected.

## Consistent reads and notices

`latest(repositoryId, subjectId)` joins the current head and immutable snapshot in one statement. `byId(snapshotId)` reads the exact archived document, independent of later publications. Both return null when no matching snapshot exists. Consumers should capture a snapshot ID once, then use that ID for all detail/evidence reads belonging to the same result. Separate calls to `latest` are allowed to observe different publications; they are not a pinned session.

`notices(repositoryId, subjectId, afterRevision, limit)` returns only revision, snapshot ID and publication time, with a bounded page size (1–100). Notice cursors are per scope and use committed revisions. They do not use a globally allocated sequence that could be committed out of allocation order by unrelated transactions. Since same-scope publishers are serialized through commit, advancing a scoped cursor does not skip a later-committing earlier revision. Every committed notice references an available immutable snapshot through a scoped foreign key.

There is no global notice cursor, public SSE transport or automatic publication worker in this candidate. No source ingestion or replay receipt is acknowledged as publicly published merely because its internal observation outbox row exists. Snapshot publication is a separate explicit operation and its notices live in `snapshot_notices`.

## Failure behavior and bounds

A rebuild failure, snapshot insert failure, head update failure or notice insertion failure rolls the transaction back. Existing readers retain the last valid head. Missing observations are unavailable, not a published measured zero. Unsupported normalization versions, conflicting event identities, invalid evidence and oversized histories fail closed. A publisher must refetch the current revision and reconsider its work after a revision conflict; the library does not silently overwrite a competing publication.

One observation SELECT fixes the retained evidence set for a document. Observations committed after that SELECT may appear in the next revision. `retained_observations_only` is always explicit: no collected-through watermark, complete GitHub history, real-time freshness or metric eligibility is inferred from a publication timestamp. Empty/edit-only or ambiguous replay states retain their existing meanings; an edit-only receipt can produce an empty set of state assertions, never a claim that the source has no work.

Advisory locks are cooperative: approved publishers must use this store/locking convention. Other authorized database writers are outside the library's concurrency guarantee. A hash collision can serialize unrelated scopes but does not merge them, because rows and foreign keys still use the full scope key. Higher transaction isolation can reject a competing transaction with a serialization failure; rollback still preserves the last valid publication. The host owns database query/lock timeouts and retry policy. No latency or scale acceptance is claimed.

## Migration and local commands

Have the approved migration runner apply `sql/001_ingestion.up.sql`, then `sql/002_snapshots.up.sql`, each transactionally. Startup does not migrate automatically. Existing observation and inbox tables are preserved. Snapshot rollback drops only the three publication tables and their immutability function; it does not remove delivery observations. This rollback destroys publication history and cursors and is intended for disposable validation environments. Production retention, redaction, deletion and restore procedures require their separate reviewed design before exposure.

After building with `npm run build`, supply the host's managed `INGESTION_DATABASE_URL`. The following commands use a synthetic scope and definition label as examples only:

```sh
npm run --silent snapshot:publish -- 2 SYNTHETIC_ISSUE synthetic-policy-v1 0
npm run --silent snapshot:latest -- 2 SYNTHETIC_ISSUE
npm run --silent snapshot:read -- SNAPSHOT_SHA256_FROM_THE_RESULT
```

The first command writes an internal publication; the other commands only read. Publication does not register an App, collect source data, open a listener or deploy a service. Commands close their pool after completion. Invalid arguments and database errors produce fixed diagnostics without reflecting connection credentials. This is a protected operator workflow, not a public mutation endpoint.

## Verification and acceptance limits

Tests exercise initial and unchanged publication, content/definition changes, pinned archived reads, scoped notice pagination, immutable rows, stale revision rejection, empty input, bounds and migration rollback/reapply. Injected notice failure proves rollback of both an already inserted payload and updated head, followed by fresh useful publication. PostgreSQL-only tests exercise simultaneous publishers and pause a transaction after updating its head to verify that independent readers cannot see uncommitted payloads, heads or notices.

These tests use synthetic receipts. They establish the backend consistency behavior for retained object state, not the whole acceptance of #62/#85. Aggregate computation/metric policy, classification inputs, accepted public contracts, full multi-object release snapshots, source and contributor-rights reconciliation, API/board/evidence agreement, global transport and affected-owner acceptance remain required. Internal delivery evidence IDs and historical snapshots are not approved public projections. No issue ownership, Project status, source permission, release gate or UI file changes here.

Primary transaction references checked 2026-10-17: [PostgreSQL 17 locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html).
