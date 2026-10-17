# Durable collection, suppression and recovery

This backend change advances #49, #58, #59, #63, #64, #73, #74, #75, #84 and #85.
It does not close their source-capability, policy, public-projection or operational
acceptance gates. Tests use synthetic evidence exclusively and make no GitHub writes.

## Schema and integration

Apply `packages/ingestion/sql/001_ingestion.up.sql`, `002_snapshots.up.sql` and
`003_collection.up.sql` in order with the approved migration runner. The third
migration leaves delivery observations immutable in place and adds independent
access, lifecycle receipts, scan checkpoints, source facts, page receipts, object
suppression and enrichment tables. Roll back in reverse order only for disposable
development databases. No automatic migration runs on startup.

Create `CollectionStore(database)`. Before permitting a repository, read its
actual visibility and installation access using an approved read-only client.
Read its current `repository_access.generation` **before** the probe and pass it
to `verifyPublic(repositoryId, installationId, expectedGeneration)` afterwards;
use null only for first registration. A failed compare-and-set means access changed
during the probe: repeat discovery and probe rather than reusing old evidence.
Stable repository IDs retain continuity across renames. This method records the
host's verification; it cannot establish visibility by itself.

All snapshot publication, latest/pinned reads, notices and object replay require
an explicit public access row. Missing access rows fail closed. Publication and
replay hold a shared access lock for their transaction. Signed repository
`privatized`/`deleted`, installation repository `removed`, and installation
`deleted`/`suspend` deliveries suppress affected scopes immediately on durable
acknowledgement. Removed/unavailable evidence from reconciliation additionally
suppresses its object's old snapshots and notices. Receipts retain only delivery
hash, IDs, reason and database observation time. Source ledgers are preserved.

Repository removal/private transitions can be restored only by a fresh fenced
probe. Installation revocation is terminal for that installation ID in this
implementation; do not delete revocation receipts to restore it. A replacement
installation needs its newly approved ID and fresh discovery/probe. Temporary
suspension also fails closed; a reviewed resumption workflow remains necessary.
Object deletion/unavailability suppression likewise requires a reviewed correction
workflow before restoration. No automatic reappearance of old evidence is implied.

The library does not invalidate a deployment's external CDN or browser caches.
Every public projection must check the same current suppression controls on every
read, including immutable IDs, exports and stream reconnects. Configure revalidation
without stale serving or cache bypass paths and prove it on the actual host.

## Bounded scans and truthful history

`start({runId, repositoryId, family, mode, since, until})` stores one immutable
scan scope. Supported families include issues, PRs, commits, reviews, comments,
releases, discussions, timelines, content edits, Project history/relationships,
and separate current Project state. `mode` is backfill, reconcile or audit.
The host selects overlapping recent windows and rotating audit scopes; scheduling
is external, so this library does not silently start collection.

`step(runId, source, limit)` performs at most one network page of at most 100
facts, then atomically checkpoints facts, page receipt, cursor, count and state.
A run stops after 10,000 pages. The injected `ReadOnlySource.readPage` adapter
must traverse **all** nested pagination through its bounded opaque cursor, verify
public visibility/stable repository identity, impose request timeouts and retry
limits, and report a source count for that fixed window only when actually proven.
This adapter contract introduces no dependency on the GitHub client package and
contains no upstream mutation method. Installation/permission/error probes and
quota accounting belong to the actual client; exceptions are not serialized.

Unknown totals stay null. Final counts are certified only when an exact source
total equals the accumulated item count. Duplicate items, repeated cursors,
nonadvancing empty pages, changing source totals, out-of-window transition times,
invalid payloads or changed access generations fail the page without advancing
its checkpoint. Failed scans remain visible and retry from their last committed
page. Concurrent workers commit one checkpoint; a worker with an old checkpoint
returns superseded. After an access-generation change, start a new run rather
than resuming a pre-revocation run. Source facts are content-addressed and immutable;
overlap/audit duplicates do not duplicate them. Page receipts record discrepancies
as changed facts and preserve the run that first observed each fact.
Fixed reason codes distinguish `source_read_failed`, `source_schema_drift` and
`source_commit_failed` without retaining raw source or database exceptions.

Source facts distinguish `current_state` from `observed_transition`. Current state
cannot contain an actor or occurrence time. Historical transitions permit null
actors/times, including deleted actors; neither is filled from owners, editors,
receive time or item order. Project current state is separate from history and
cannot award historical edit credit. Only explicit typed fields are retained;
repository text, adapter extras and raw errors are neither stored nor executed.
Deleted, unavailable and reverted state remain facts, never negative merit.

## Enrichment and operational diagnostics

`EnrichmentStore.enqueue(factKey, policyVersion)` creates a durable, idempotent job
for an immutable source revision. `processOne(readOnlyMetadataSource)` leases one
job with `SKIP LOCKED`, performs the bounded external metadata read, and fences
completion by the current token, lease expiry and access generation. The adapter
must honor its own request deadline. Failed/unknown evidence stays failed and
retryable with bounded exponential delay and a maximum attempt budget. Expired
leases can be reclaimed; exhausted leases become visibly failed. Revision drift,
unknown accepted outcome or invalid file counts cannot become classified.
Only accepted-outcome status, review state and file counts are retained.
Classified/excluded describes metadata readiness; it does not publish rankings
or award contribution credit. Metric-specific required evidence and policy still
belong to the reviewed computation/publication producer.

`CollectionStore.diagnostics(repositoryId, staleSeconds)` reports each exact scan
window, checkpoint counts, source age, last successful source read and current
access state. Never-read, empty successful read, partial progress, failed/stale
collector and unavailable access have distinct signals. An old successful count
is labeled `historical_counts_reconciled` when current access is unavailable;
it does not certify current availability. Suppressed object count is explicit.
The default staleness threshold is 3,600 seconds, configurable from 1 to 86,400;
this development default is not an accepted operational SLA. Scan bounds are
requested coverage, not proof of pre-installation completeness or historic edits.

`InboxStore.health()` reports unfinished queue age, state counts, latest intake
and last processed time using database clocks. It does not claim source
connectivity. `/healthz` remains process liveness only. Source quotas, measured
webhook occurrence lag and public publication delay are unknown without a real
source/publication adapter; do not report invented zeros.

Protected operator replay may supply a `ReplayAudit` with an actual operator ID,
fixed reason, policy version and resulting revision (null until proven). Each
individual delivery replay remains bounded, preserves prior attempt history and
records its opaque authorization receipt. No public replay endpoint or time-window
bulk replay is enabled. The host must authenticate/authorize this operation.

## Acceptance evidence and remaining prerequisites

The integration suite covers restart and source-failure recovery, omitted webhook
repair, overlap/audit deduplication, count drift rollback, current/history actor
separation, source staleness, signed private transition and pinned snapshot removal,
unverified access denial, in-flight scan/enrichment revocation fencing, rename
continuity, deleted actors, deleted artifact suppression, policy/revision-pinned
enrichment, replay audit and observable worker recovery. PostgreSQL-only tests
exercise competing workers, checkpoint commits, snapshot publication visibility
and `SKIP LOCKED` behavior. Existing replay tests cover all 120 arrival permutations,
correction chains and unknown clock ordering; snapshot tests compare content hashes
for fixed retained evidence and policy.

Real App capability receipts, complete family/nested GitHub adapters, enabled
source inventory and real paginated counts remain necessary for #49/#59/#63/#64.
Label/milestone source adapters and opt-in live canaries in #84 remain separate
source-verification work. #73 also needs source quota/publication-delay telemetry,
authorized bulk replay and an actual operational drill. #74 needs reviewed retention,
object restoration and public projection/CDN correction receipts; #75 needs matching
metric/definition-window comparison and public presentation; #85 needs a real
published source snapshot and reviewed retention/rebuild evidence. Enrichment
readiness alone is not accepted contribution recognition for #58.

Historical facts never observed, pre-installation/deleted timelines, inaccessible
Project editor history, vanished actors' identities and evidence removed after
retention expiry cannot be reconstructed from current state. This implementation
does not fabricate those gaps. Restoring an expired ledger requires an authorized
retained backup; an API fetch of current state is not equivalent historic evidence.
