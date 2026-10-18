# Completed webhook delivery payload expiry

This is the bounded PostgreSQL delivery-payload component of
[#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95).
It removes the two minimized delivery payload copies while retaining their
acknowledgment and processing integrity records. It is separate from permanent
repository exclusion and the remaining [cross-store source-retention boundary](source-retention-boundary.md).

## Retained data and eligibility

The signed receiver hashes the original HTTP bytes and stores a minimized
`inbox.envelope`. Raw signed bytes, titles, bodies, emails and logins are not
persisted by this receiver. Successful inbox processing copies the minimized
envelope into `observations.observation`, adding observation metadata, and creates
an outbox notice. Inbox completion alone is therefore insufficient for expiry:
the pending, leased or quarantined dispatcher still needs the observation.

`DeliveryPayloadExpiryStore.expireCompleted` selects at most the explicit
`batchLimit` of 1–100 deliveries for one exact numeric repository/installation
pair. Both inbox and outbox must be `done`, with durable successful-attempt
timestamps strictly before the caller's `completedBefore` cutoff. The outbox must
also have its committed operation-bound publication completion receipt: matching
64-character SHA-256 keys and 1–100 correctly typed scope/snapshot/revision entries.
The observation must match the original minimized envelope. Missing or inconsistent
scope/completion records and unsupported delivery normalization are ineligible. A completion
exactly at the cutoff is retained. Receive time and source event time do not
substitute for either processing-completion clock.

Pending, leased and quarantined work remains unchanged and replayable under its
existing authorization and retry budget. An expired lease or a final-attempt
quarantine is not completion. Unsupported dispatch families therefore remain
retained until their independently reviewed processing or disposal policy exists.

## Migration and protected host integration

Have the approved migration runner apply
[`006_delivery_payload_expiry.up.sql`](../packages/ingestion/sql/006_delivery_payload_expiry.up.sql)
inside a `READ COMMITTED` transaction after ingestion migrations 001–004, before running the
updated replay or operator readers. Migration 005 is reserved for the independent
collected-fact retention component; 006 has no dependency on its implementation.
This migration adds the operation and per-delivery receipt tables, selection and
completion indexes, and the narrow payload-absence guards. It does not apply on
startup or change `immutable_source_fact` or `immutable_snapshot`.

For the current dispatch producer, subsequently apply
[`008_dispatch_publication_scope_capacity.up.sql`](../packages/ingestion/sql/008_dispatch_publication_scope_capacity.up.sql).
It preserves the applied 006 migration and every retained value while extending
its completion recognizer to the producer's 16,384-character scope-key limit.
Canonical 100-Project scopes with all approved roles remain eligible under the
same authorization, completion, batch and cutoff checks. Roll back 008 before
006; the atomic downgrade requires read-committed isolation and refuses active
outbox access or retained references above the legacy bound. Stop and drain workers
before disposable rollback and resume only with the matching source version.

Every input below comes from the protected host's reviewed operation. There is no
default cutoff, retention duration, operator, policy, operation ID, batch size,
automatic scheduler, public endpoint or expiry CLI command.

```js
import { DeliveryPayloadExpiryStore } from '@pick-your-ai/ingestion';

const expiry = new DeliveryPayloadExpiryStore(database);
const receipt = await expiry.expireCompleted({
  operationId,
  repositoryId,
  installationId,
  completedBefore,
  policyVersion,
  operatorId,
  authorizationId,
  batchLimit,
}, async (operation) => {
  return await currentProtectedGrantAllowsDeliveryExpiry(operation);
});
```

`completedBefore` is a canonical UTC instant with millisecond precision and must
not be later than the database clock. Identities are bounded opaque strings;
source IDs are positive safe integers. The authorization callback must verify the
current actor, exact scope, policy, cutoff and operation grant. It must return
exactly `true`. The store checks it before database work, before writes and again
before transaction completion; a denial rolls back the batch. Readback of a
previous operation also rechecks current authorization. The supplied receipt
identity is an audit binding, not a substitute for authenticating the caller.
The host still owns connection, statement, lock and authorization deadlines.

Expiry, including an existing operation's readback, and the object-replay gate
require the transaction's actual isolation setting to be `read committed`.
They fail closed with `delivery_expiry_requires_read_committed` for other settings,
including `repeatable read` and `serializable`; they never change the caller's
isolation policy. This also applies to `SnapshotStore.publishObjectState` when it
reconstructs delivery evidence. A transaction-scoped advisory lock orders access,
but cannot refresh a snapshot established before a concurrent expiry committed.

## Atomic receipts and retry behavior

The transaction records one immutable operation receipt and one minimal receipt
per expired delivery, then sets both payload columns to SQL `NULL`. It retains
the original delivery UUID, original signed-body hash, receive time, attempt and
replay histories, observation identity/version and outbox completion records.
The minimal expiry receipt binds the original event/delivery IDs, numeric
repository/installation scope, subject ID and operation ID. It contains no action
actor, source URL, action value or source occurrence time. SQL `NULL` means actual
payload absence; the store does not replace the payload with a source-shaped
placeholder or forge a repository/installation lifecycle receipt.

Database guards reject unreceipted removal, receipt mutation, restoration of an
expired payload, and changes to the expired acknowledgment's identity or terminal
state. Deferred constraints reject a commit if either payload still exists or
the operation's count differs from its actual delivery receipts. A crash between
the two updates leaves both original copies and no completed expiry receipt.
While intake remains otherwise authorized, identical webhook redelivery remains
`duplicate`; reuse of the delivery UUID with different signed bytes remains
`conflict`. A permanent repository-retirement gate can reject intake before that
readback. Redelivery cannot restore the payload or requeue its completed dispatch.

Each operation ID denotes **one bounded batch**. An exact retry, including after
an uncertain commit or process restart, returns the original receipt. Reusing
that ID with a different scope, cutoff, policy, operator, authorization identity
or batch size fails with `delivery_expiry_operation_conflict`. Further batches
require new explicitly authorized operation IDs. The receipt's
`coverage: selected_completed_deliveries_only` and `expiredCount` describe only
that batch; a zero or short batch does not certify that the whole repository is
expired. Locked rows are skipped, and no remaining-row count or wall-time budget
is claimed.

Expiry and object replay share a transaction-scoped repository gate. A live
replay holds the shared side until its transaction ends. Expiry takes the
exclusive side without waiting and reports `delivery_expiry_scope_busy` if a
reader or another expiry owns it; this leaves no operation receipt and can retry
under the same operation ID. The expiry selection uses `SKIP LOCKED` for inbox,
observation and outbox rows, preserving a concurrently held processing lock.
Same-operation retries serialize separately and return one committed receipt.

The disposable down migration locks both expiry receipt tables before checking
their state and changing the schema. It succeeds only before the first recorded
operation, including a zero-row batch.
It first requires `READ COMMITTED` and rejects other transaction isolation with
`delivery_expiry_requires_read_committed`, before taking locks or checking receipts.
After the first recorded operation it refuses with
`delivery_payload_expiry_irreversible`. A migration cannot recreate removed
evidence or discard an immutable retry result. A zero-row result can reflect locked
work; removing it would allow the same operation ID to select a different batch
after migration reapplication. Database owners still need protected
roles and reviewed backup/restore procedures; these integrity guards do not
grant authority to a caller with unrestricted database administration privileges.

## Replay and publication after expiry

Object replay joins live observations with minimal expiry receipts using their
exact scope. If any selected observation expired, it returns:

```json
{
  "coverage": "unavailable_expired_observations",
  "sourceObservationCount": 1,
  "expiredObservationCount": 1,
  "reason": "delivery_payload_expired",
  "expiryOperationIds": ["synthetic-example-operation"],
  "replay": null
}
```

This is a synthetic result shape: the counts mean retained and expired receipts
within the bounded object history, not certified source coverage. The existing
256-receipt replay bound still applies, including expiry receipts; larger scopes
fail with `replay_limit_exceeded`. A new `SnapshotStore.publishObjectState` call
refuses an expired ledger with `snapshot_replay_unavailable_payload_expired`
before inserting a replacement snapshot, changing its head or publishing a
notice. It never silently reconstructs only the surviving subset. The replay
CLI serializes this explicit unavailable result. Scoped operator diagnostics
continue to count completed acknowledgments after their envelope has expired.

Previously materialized snapshots, source facts, pipeline normalizations and
frozen inputs, controls records, checkpoints, caches and backups are outside this
operation. Their existing source/privacy gates and retention obligations remain.
An old snapshot may still retain derived evidence and is not a certified rebuild
source for the expired ledger. This component does not hide or purge a repository,
erase contributor histories across stores, certify backup expiry, or close #95.

## Validation boundary

The focused actual-store tests exercise both payload copies, exact scope and
exclusive cutoff, bounded operation readback/conflicts, pending and dead-letter
recovery, transaction failure between deletions, changed authorization, SQL
integrity guards, unsupported transaction isolation, truthful replay, unchanged historical snapshots and an on-disk
PGlite close/reopen. They contain only synthetic deliveries and local stores.

Additional tests in the existing ingestion PostgreSQL suite exercise
independent connections: replay/expiry exclusion, skipping a locked completed
dispatch, a paused uncommitted deletion with waiting replay/publication and
same-operation retry, and rejection of a transaction whose older repeatable-read
snapshot predates a committed expiry. The isolation-policy regression also runs
against the actual PGlite store and checks inherited host defaults, operation
readback and rollback refusal without changing those defaults.
They run in the existing disposable PostgreSQL CI service and explicitly skip
when no `INGESTION_TEST_DATABASE_URL` is configured. PGlite results do not prove
multi-connection PostgreSQL locking behavior. Hosted PostgreSQL validation,
independent source review, approved operational retention policies and deployment
acceptance remain separate evidence; no production expiry was run here.
