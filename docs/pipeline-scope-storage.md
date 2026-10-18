# Retained pipeline scope storage

The pipeline stores the complete canonical public scope, including every selected
Project and contribution role. The maximum supported v2 and v3 keys exceed the
size of a PostgreSQL B-tree index entry. Repeated padding can compress well enough
to conceal that limit, so the capacity regressions use 100 distinct, deterministic
SHA-512 Project IDs. PostgreSQL documents the approximate
[one-third-page B-tree entry limit](https://www.postgresql.org/docs/17/btree.html).

This storage correction supports the existing scope contract. It changes neither
the selected dimensions nor source authorization. Snapshot content IDs, raw scope
strings, raw publication operation keys, receipt IDs, frozen inputs, approved
configuration hashes and private publication confirmations retain their original
meaning and bytes. The public membership/role consumer and release remain
separately owned under [issue #91](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/91).

## Bounded indexes and exact identity

| Retained table | Indexed key after migration | Exact original value |
| --- | --- | --- |
| `leaderboard_pipeline.heads` | Primary key on 32-byte `scope_hash` | Unchanged `scope_key` |
| `leaderboard_pipeline.dispatch_publications` | Primary key on `(operation_key, scope_hash)` | Unchanged dispatch operation and `scope_key` |
| `leaderboard_pipeline.receipts` | Unique 32-byte `operation_hash`; existing receipt-ID primary key | Unchanged `operation_key` and derived `receipt_id` |

PostgreSQL computes each digest with the built-in
[`sha256(convert_to(original, 'UTF8'))`](https://www.postgresql.org/docs/17/functions-binarystring.html).
No extension, truncation, generated string alias or rewritten public key is used.
Validated, non-null check constraints bind each digest to the complete original
UTF-8 string. The digest supplies a bounded index lookup; reads also require exact
raw equality. A conflicting digest occupied by another original key cannot
replace a head, bind a dispatch or acknowledge a receipt. It causes the enclosing
publication transaction to fail, preserving the prior committed publication.

Configuration approval and public reads also probe persisted Project denials by
the bounded `operation_hash` index, then require the original operation key and
the denial receipt kind. A denial from another repository or configuration
version cannot revoke the selected configuration.

## Upgrade and startup

The host continues to invoke the exported `migratePipeline(db)` using its existing
transaction-capable PostgreSQL adapter after the independently owned ingestion
migrations. This entrypoint now upgrades retained databases as well as creating
new ones. `createPipeline` verifies the resulting version and changed constraints
before configuration verification, source collection or publication starts.

Before an operating upgrade, stop and drain every old pipeline writer and retain
a verified, restorable backup. Run the migration from the matching source version
on one host; concurrent calls from that same version serialize on a transaction
advisory lock. The migration explicitly uses READ COMMITTED so a waiting caller
observes the preceding committed migration even when its pool has a stricter
session default. Its exclusive table locks cover schema changes and backfill.

The entire operation is one transaction: inspect the legacy shape and original
head/dispatch/receipt identities, fill the three digest columns, establish their
constraints, replace the three oversized indexes and record the exact migration
checksum as `pipeline-storage/v2`. The version record is written last. Any
interruption or failed validation rolls back both data and DDL. A retry then starts
from the retained original state. Repeating an already successful migration
checks the same version, checksum and constraints without rewriting records.

Unknown future versions, edited migration checksums, unrecorded partial upgrades,
missing/unvalidated digest constraints and remaining raw-key B-tree indexes are
refused. The migrator preserves such a database for investigation; it does not
guess a repair, delete conflicting data, accept an altered migration or claim
that a failed upgrade completed. Older readers and writers must not be started
against the new schema: their raw-key `ON CONFLICT` targets are incompatible.

There is no automatic down migration. Restoring oversized raw indexes after new
long scopes have been admitted can fail or require data loss. Recovery therefore
uses the retained pre-upgrade backup in an isolated compatible environment or a
reviewed forward correction, with matching writer source and the existing
[source-retention and revocation boundaries](source-retention-boundary.md).
This code does not operate on an actual hosted database or establish a production
restore result, rolling deployment compatibility or a recovery-time commitment.

## Publication telemetry

The monitor retains its existing 200-character input bound. A publication scope
of at most 200 characters uses its previous literal monitor identity. Longer
scopes use `pipeline-scope/v1:<sha256-of-full-UTF8-scope>` at the publication
telemetry boundary. This preserves short-scope history while giving distinct long
scopes bounded identities for success, failure and freshness. Raw Project IDs
remain absent from exported fixed-field telemetry. Telemetry failure still cannot
change durable publication results.

## Automated qualification

`apps/pipeline/test/scope-storage.test.mjs` consumes the exact old schema fixture
from accepted `a17ee101826973c62ed5a69f05367927e13760a6`. It tests old-index rejection,
new maximum v2/v3 capacity, original-row and receipt preservation, interruption
after every executed schema/backfill write, successful retry, corruption and
version rejection, and file close/reopen. These are explicitly synthetic records.

`scope-storage-runtime.test.mjs` exercises the actual collector/publisher,
original frozen/public/private identities, retained native source reads and pins,
revocation, adversarial occupied digest slots, interrupted dispatch confirmation
and restart, and the real fixed-field monitor. A test that deliberately removes a
check constraint represents corruption after startup; it does not claim to have
constructed a SHA-256 collision. The SQL constraints themselves have separate
wrong-digest rejection cases.

The approval regression captures the actual runtime query, checks that its digest
predicate can use the receipt index, and exercises the complete 100-repository
set, unrelated/old/wrong-kind receipts, a corrupted occupied digest slot and an
exact denial retained through restart. The query-plan check discourages small
fixture sequential scans; it does not assert a production latency measurement.

Local execution uses a disposable file-backed PGlite database. The existing
runtime CI PostgreSQL 17 service additionally supplies the storage-specific
`PIPELINE_SCOPE_STORAGE_TEST_DATABASE_URL` to the test step. The suite accepts
only an explicit loopback test source without connection overrides, creates a
unique database, and never resets an existing database. The independent-connection
case observes PostgreSQL's actual advisory-lock wait before releasing the first
migrator. It is explicitly skipped when that dedicated service is absent; a
PGlite result is not evidence of independent PostgreSQL connection behavior.

The original storage-only qualification exposed a separate HTTP failure: the
service's former 4,096-character request-URL cap rejected a valid 100-Project query
after its snapshot was stored and authorized. The separately reviewed
[HTTP capacity correction](read-api.md#bounds-and-verification) admits the complete
encoded canonical scope while retaining explicit request and header budgets.

`scope-capacity-http.test.mjs` connects the actual collector, audited replay,
publication indexes, durable outbox completion, SQL completion recognizer,
protected result verifier and public loopback GET for both v2/v3 scopes containing
100 distinct maximum-width Project IDs. Reopen preserves exact pins and receipt
identity without duplicate publications; current privacy withdrawal defeats old
conditional reads. The public service's separate socket suite also checks the
maximum percent-encoded canonical query, cursors and header admission. These
synthetic boundaries do not establish actual Project enrollment, proxy capacity,
live collection, or the complete issue #91 acceptance gate.
