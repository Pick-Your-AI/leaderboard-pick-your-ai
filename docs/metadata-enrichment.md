# Durable metadata enrichment

This is an explicit host composition for LB-05.04 (#58). It connects retained
collection facts to the existing enrichment job store. It does not install a
GitHub adapter, grant source access, or establish the verified live-source gate
in #45. Default pipeline construction leaves `runtime.enrichment` null.

## Trusted adapter and authority

An authorized host may provide `metadataEnrichment` to `createPipeline` with
exactly three fields: `source`, `policyVersion` and `configurationCurrent`.
`source.readMetadata(request)` is a trusted read-only implementation, supplied
outside repository content. Repository bodies, comments, labels and files are
data and cannot select a callback, policy, command, prompt or approval.

Each request supplies the configured repository database ID, explicit collection
family, a detached source fact, an `AbortSignal`, and `assertAuthorized()`.
The adapter must use the approved repository-bound GitHub client and its bounded
transport, honor cancellation, and call the captured fence around its network
awaits. The fence checks current host authority; it does not replace the client's
live repository/installation permission checks or verify a provider response.
No network implementation or permission is inferred from this interface.

The adapter must bind its actual provider object and native identities to the
retained subject, family, URL and exact revision. Review metadata is for that
individual review and its exact `githubReviewRevision`/snapshot identity; a PR's
aggregate review decision is not an individual review state. A body may contribute
to that revision fingerprint, but is not returned or retained as metadata.

The returned fields are `sourceRevision`, `acceptedOutcome`, `reviewState`,
`additions`, `deletions` and `changedFiles`. Counts are nullable nonnegative safe
integers; zero stays zero and unknown stays null. Review state is nullable or
`approved`, `changes_requested`, or `commented`. The retained source revision is
the comparison authority even if the adapter edits its detached request.
`acceptedOutcome` must be an explicitly evidenced boolean. Unknown (`null`), a
mismatched revision or an invalid field fails the job; it is not converted to
false. The host must not infer acceptance merely from issue closure, array
membership or aggregate review state. Extra returned fields are discarded.

`configurationCurrent(binding)` is synchronous and must return exactly `true`.
The binding includes repository/installation/family and captured public access
generation, the canonical immutable configuration hash, captured private controls
configuration revision, explicit
metadata policy version and data mode. Each callback receives a fresh copy.
An exception, false/unknown value or promise denies the operation; rejected
promises are observed. Current configuration approval is also rechecked through
the original asynchronous pipeline authorization path. Enrichment captures its
own revision rather than borrowing the serialized publisher's mutable run state.
The synchronous fence also rejects a source with an admitted private derived
retirement, even when the controls configuration revision itself is unchanged.

## Durable queue and lifecycle

`start()` starts the worker only when explicitly configured and currently
authorized. It does not wait for metadata before returning or accepting webhook
intake. Privileged hosts can also call `runtime.enrichment.processOne()` for one
bounded operation; concurrent calls in one runtime are serialized independently
of collection and publication.

The sweep selects at most 100 facts per operation, from configured repositories
and families with the exact recorded data mode, current public installation and
access generation, and actual current-generation collection membership. Retired
or suppressed subjects are not queued or claimed. Because this is a retained
membership sweep, a crash after page commit and before enqueue does not lose the
job. Conflicting or unknown mode observations are not silently admitted.

Jobs are namespaced by the complete immutable authority binding. A change of
configuration, controls revision, explicit metadata policy, source scope, access
generation or data mode produces a distinct policy key; original records remain. Enqueue is
idempotent, and one operation claims at most one job under an exclusive row lease.
Different repositories, families, installations and policy keys cannot steal
each other's jobs or reset each other's exhausted leases.
After a repository is suppressed and freshly verified public, an identical
re-collected fact therefore gets a new generation-bound job. The previous
classification stays intact as historical state; it cannot suppress recovery or
be returned as current evidence. Every scoped admission, claim and read checks
the captured generation again inside the source-locking transaction. Scoped
enqueue retains this generation on the pending job as well as in its namespace;
a new generation cannot reclaim an older pending or failed job under the same key.

The pipeline uses a 60-second SQL lease. An individual adapter wait is bounded to
the lesser of 30 seconds and half the requested lease. Deadline or shutdown
signals cancellation; a late response or rejection has no metadata write path.
Cancellation is cooperative at the transport itself: an adapter that ignores its
signal may continue its own work, but the runtime stops awaiting it. `stop()`
aborts this lifetime and settles its outstanding worker operation. Database and
trusted authorization adapters retain their existing bounded-operation duties.

Successful results are `classified` for evidenced true and `excluded` for
evidenced false. Failures retain only `enrichment_unavailable`, or
`attempts_exhausted` after an expired final lease. Retry uses the existing
exponential delay capped at five minutes and default five-attempt budget.
Expired leases are reclaimable; late owners cannot overwrite a replacement.
Exhausted-lease cleanup also requires a current public, unsuppressed source; it
does not rewrite job state for a suppressed subject or unavailable repository.
Failure-state writes hold the shared repository gate and require its current
public generation and an unsuppressed subject, including the legacy store API.
Scoped authority loss rejects with the fixed authorization error. The legacy
two-argument API returns `lease_lost` on source-authority loss. Both preserve the
existing lease; neither writes a failure record after suppression or restoration.
At exhaustion, ordinary enqueue does not reset attempts. Recovery requires a
separately approved corrected adapter/policy or configuration binding; this slice
adds no implicit retry reset or operator recovery UI.

`runtime.enrichment.readStates(repositoryId, family, limit)` is a privileged
in-process read of at most 100 current-scope job records. It returns fact key,
source revision, state, attempts and a fixed reason, never adapter text or raw
metadata. It shares current source locks, checks suppression and generation, and
reauthorizes before returning. Currentness is checked after asynchronous
transaction completion as well. There is no new public or controls HTTP route.

## Classification and acceptance limits

Enrichment state and metadata do not create an observation, normalization,
recognition fact, receipt or publication. Existing normalizers and metric policies
still require their own accepted evidence; their behavior is unchanged. An
observed activity metric may already have independent evidence while this optional
metadata job is pending. That does not turn its activity into an accepted outcome.

The focused tests exercise synthetic adapters, current-generation SQL admission,
scope separation, unknown/zero values, source revision isolation, privacy changes,
lease competition, cancellation, durable job reuse and the actual native HTTP
intake boundary. The ingestion suite supports the configured disposable native
PostgreSQL job separately from embedded execution. Test availability is not a
claim that a particular run or live source has passed. Complete #58 acceptance,
an operational source adapter, #45 verification, deployment and recovery UI each
retain their own outstanding evidence gates.
