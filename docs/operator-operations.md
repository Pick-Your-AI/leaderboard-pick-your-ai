# Protected diagnostics and audited inbox replay

Refs #73 and #93. This documents the protected operator console, audited inbox replay, retained source health and independently verified publication results. The native recovery checks use synthetic source responses, actual HTTP handlers, persisted PostgreSQL-compatible data and the private publication store. Production deployment, live OAuth, the staffed #93 drill and #94 specialist correction handling retain their separate acceptance gates.

The approved host constructs `new OperatorInbox(database)` from the ingestion package and passes it as `operations` to `createControlsServer`. It must also supply `authorizeRepository({actorId,repositoryId})`, returning `{allowed:true,policyVersion,revision}` only for a currently authorized operator/repository pair under an approved policy. Every missing option defaults to unavailable; the operator role alone grants no repository. The callback must use current authority, not a cached browser declaration. Changing authority must change `revision`; changed policy/revision invalidates previously displayed replay selections. The host remains responsible for database statement timeouts and connection/resource budgets.

`GET /controls/operations/:repositoryId` requires an authenticated operator and repository grant. It reports only repository-scoped retained inbox counts, at most 50 quarantined delivery identifiers with attempts/reason codes, 50 collection run summaries and 50 sanitized replay receipts. Truncation is explicit. It does not return source URLs, subjects, raw payloads, authentication material or stack traces. Counts describe processing, not connectivity or complete historical coverage. Collection expected totals and last success remain unknown when unavailable.

`POST /controls/operations/:repositoryId/replay` accepts only `{deliveryId,expectedRevision,reason,confirmed:true}` with ordinary session, origin and CSRF protections. Reasons are `source_recovered`, `normalization_corrected` or `operator_reviewed`. The server derives operator identity. A transaction locks the current public repository-access generation and exact quarantined inbox record; the opaque displayed revision binds repository, access generation, authority/policy, delivery digest, attempt count/reason and attempt timestamp. Authority is rechecked before mutation and after the receipt/queue writes, before transaction commit; revocation during those writes rolls both changes back. Foreign, withdrawn, already queued or changed records fail closed.

The transaction writes the durable replay receipt and resets only that retained delivery to pending with a fresh bounded attempt budget. The receipt records operator, reason, policy, repository generation, prior attempts/reason, before revision and queued revision. `resultingPublicationRevision` remains null in this immutable queued audit. The separate result read below can establish actual processing and verified publication references without rewriting that audit. An uncertain HTTP response must be resolved through receipt readback rather than an automatic retry. No unaudited outbox replay endpoint is exposed.

Both diagnostic and replay responses recheck the current session and repository authority after adapter/database completion, and require the same policy and grant revision as at request admission. A synchronous session check after response serialization prevents an expired or revoked session from receiving the result. If authority changes after a replay has committed, the response is withheld; this does not undo an already committed receipt, and authorized receipt readback remains the recovery path.

`<Operations session={session}/>` is mounted inside the authenticated operator console. It requires repository selection and scoped confirmation, clears private output on visibility/session changes, ignores superseded completions, and never reads operational data from the public API. The parent controls UI retains authority over session state. The mounted integration preserves the separately reviewed evidence amendment workflow. Collection runs and historical receipts explicitly identify their own source generation; they are not relabeled as current-generation evidence.

## Bounded receive-time replay

`OperatorInbox.previewReplayWindow(window, authorize)` and
`OperatorInbox.replayWindow(request, authorize)` provide the bounded replay
primitive for #73. The protected operator console exposes an explicit preview and
confirmation flow through the same opt-in host adapter as single-delivery replay.
No CLI command or scheduler invokes it. A preview is read-only and does not grant
authority to execute a replay.

| Protected POST route | Accepted body | Result |
| --- | --- | --- |
| `/controls/operations/:repositoryId/replay-window/preview` | `receivedSince`, `receivedUntil`, `limit`, `policyVersion` | Current eligible selection and its opaque revision; no receipt or queue mutation |
| `/controls/operations/:repositoryId/replay-window` | The same window fields, `expectedRevision`, `reason`, `confirmed: true` | Transactional batch receipt and per-delivery receipts, with queued status |

Both routes require the existing same-origin session, operator role, CSRF token
and explicit repository grant. Repository identity comes from the authorized route;
operator identity comes from the authenticated session. Browser-supplied identity
fields are rejected. A host adapter without the window methods returns unavailable.
Every response rechecks the initial policy and grant revision after the adapter
finishes. If a response is lost or authority changes after commit, inspect durable
receipts under fresh authority before deciding whether further work is needed.

The explicit window fields are:

- `repositoryId`: one stable repository ID; only its currently public, current-installation inbox is eligible.
- `receivedSince` and `receivedUntil`: canonical UTC instants such as `2026-10-01T00:00:00.000Z`, forming an inclusive/exclusive receive-time window. Both are required; the duration must be positive and no more than 31 days.
- `limit`: an explicit integer from 1 to 50. A query reads at most `limit + 1` candidates and rejects the entire operation on overflow. It never silently replays a prefix or automatically splits windows.
- `policyVersion`: the expected policy, which must match the current authenticated authorization callback.

The preview returns only the selected quarantined delivery IDs, sanitized failure
codes/attempt counts and opaque revisions. Selection is ordered by receive time
then delivery ID. Pending, leased and completed records, foreign repositories,
previous installations and out-of-window deliveries are excluded. Receive time is
not source occurrence time, and an empty preview does not prove a connected source
or complete coverage.

The mounted form labels both date inputs as UTC and converts them without using
the browser's local timezone. It requires a full explicit receive window and limit,
then shows every selected delivery, exact boundaries, current source generation,
policy, authorization and selection revisions before a separate confirmation.
An empty selection offers no queue action. Editing the window clears its prior
selection and confirmation. The client rejects mismatched scope, generation,
authority, duplicate delivery IDs or incomplete batch receipts; queued success
must account for every delivery that was shown. A stale selection, exceeded limit
or changed authority clears the private result and requires fresh diagnostics.
Visibility/session changes and superseded requests cannot restore an old preview.

After explicit review, the protected host passes those same window fields plus
`expectedRevision` (the preview revision), an authenticated `operatorId` derived by
the host, and one of the existing fixed `reason` values. The host must implement
`authorize(repositoryId)` by rechecking the current session/operator and explicit
repository grant on every invocation. Supplying a preview token, an operator ID
or a policy name alone is never authorization. The callback returns the current
`{policyVersion, revision}`; no permission is added by this primitive.

Commit reselects and locks the quarantined rows, then checks the selection revision
against the window, current source generation, policy/grant, delivery digests,
receive timestamps and each quarantine attempt cycle. A matching arrival between
preview and commit, a changed attempt or source, or an altered limit/window fails
closed and requires a fresh preview and review. An empty selection cannot be
committed. Authorization is rechecked before and after writes; receipt failure or
changed authority rolls back the entire batch.

Each delivery keeps its original identity, envelope, body hash, receive timestamp
and attempt history. Its durable receipt records the ordinary operator, reason,
policy, source generation, prior attempts/reason and before/queued revisions, plus
a batch ID, batch size, exact window and selection revision. The batch result
contains those per-delivery receipt IDs and a queued batch revision. Protected
receipt readback adds a sanitized `batch` field (null for legacy single-delivery
receipts). The queued audits keep their original null publication revision;
the result read independently verifies each delivery's later publication.
Existing bounded worker retries and observation/outbox identity deduplication
continue to apply.

This is a bounded snapshot of retained eligible rows, not a serializable lock on
the entire time range. `FOR UPDATE` locks existing selected rows; a delivery that
arrives or becomes quarantined after selection can remain outside that batch.
Future arrivals or later failures require another explicit preview/review. The
host still owns database statement timeouts and resource budgets. After an
uncertain result, read the durable receipts before deciding whether another
operation is needed; never automatically replay a window again.

The focused synthetic suite runs with one embedded database:

```sh
npm run build --workspace @pick-your-ai/ingestion
node --test --test-concurrency=1 packages/ingestion/test/operator-window.test.mjs packages/ingestion/test/operator.test.mjs
node --test --test-concurrency=1 apps/controls/test/operations-window.test.mjs apps/web/test/operations-window.test.ts
npm run test:browser -- operations.spec.ts
```

It exercises exact time boundaries, foreign/current installation filtering,
overflow and the 50-delivery cap, stale membership and attempt revisions, changed
authority/source/policy, post-write revocation, transaction rollback, audit
minimization, preserved history and resumed workers producing no duplicate
observations/outbox records. These tests do not certify production concurrency,
throughput, complete source coverage or a deployed operational drill.

The original #232 window HTTP tests exercise the actual controls server and transactional PGlite
store: preview without writes, half-open receive boundaries, foreign/current
installation filtering, overflow and empty selection, stale arrivals, exact
identity/CSRF/role checks, durable batch readback, duplicate retry refusal and
authorization loss after the first write rolling back the whole batch. The browser
journeys use that actual HTTP/database bridge, including keyboard confirmation,
320px reflow and Axe checks, edited/empty/stale selections, withheld late responses
and revoked grants. That original window slice did not establish downstream
publication. The native result and recovery tests below add the actual publisher
and restart boundary; production scale, live OAuth and staffed recovery remain separate.

The original single-delivery bridge also exercises anonymous/non-operator/foreign-repository denial, CSRF, confirmation, server-derived identity, changed authority/source/policy, stale replay revisions, single receipt persistence and payload minimization. Its browser fixture uses synthetic established sessions. The following native integration extends that evidence without relabeling the earlier queued-only receipts.

## Native health and replay results

Apply `007_operator_replay_results.up.sql` after ingestion migrations 001–004,
inside the approved host migration transaction, before starting this version of
the inbox worker or operator bridge. The optional permanent-retirement migration
005 remains independently owned and composes with 007. Migration 007 adds exact
receipt/delivery and attempt/delivery foreign keys, an inbox pointer to the audited
replay, and an immutable processing-result table. It does not backfill older
receipts by matching timestamps or a delivery's earlier publication. Roll back 007
before 004 on disposable databases only; its rollback removes the added result
records and must not discard retained production audit evidence.

For the native pipeline integration, explicitly supply `operatorDiagnostics` to
`createPipeline`:

- `freshnessBudgetSeconds`: an approved integer from 1 to 86,400. This is an
  observation freshness threshold, not a newly approved production SLO.
- `configurationCurrent(binding)`: a synchronous function that returns exactly
  `true` only while the host still authorizes this runtime's immutable
  `configurationHash`, `configurationVersion`, `dataMode`, `repositoryId`,
  `installationId` and `sourceGeneration`. A missing, false, throwing or
  promise-returning currentness check cannot authorize a diagnostic.

The runtime exposes `operations` only when this option is supplied. The existing
`controlsAuthentication` integration uses it when no custom operations adapter is
provided; a separately mounted controls server can receive `runtime.operations`.
The existing session, operator role and current `authorizeRepository` grant remain
required. None of these options chooses an installation, acquires a public-source
grant or enables the synthetic dispatcher for public data.

| Protected GET route | Meaning |
| --- | --- |
| `/controls/operations/:repositoryId/health` | Current-generation collection observations, retained current-installation queues, bounded quota observations and the latest independently verified completed publication |
| `/controls/operations/:repositoryId/replays/:receiptId` | The exact retained replay receipt's causal processing result and, when verified, every resulting publication scope, immutable snapshot ID and revision |

Both reads reject query parameters and return fixed minimized JSON with
`repositoryId`, `sourceGeneration`, current `policyVersion` and `authorityRevision`.
Receipt IDs use the existing opaque `[A-Za-z0-9_-]{1,128}` grammar; delivery IDs
remain UUIDs. Browser-selected repository or receipt identity cannot replace the
route and authenticated grant. The new GET routes do not queue or retry work.

### Causal processing and publication

`InboxStore.complete` reads the persisted replay pointer under the current lease
lock. Its single transaction commits the observation, newly inserted outbox notice,
processing result, attempt history and inbox completion. The processing result
binds the receipt to that exact delivery and persisted lease. Its `event_key` is
set only when this lease actually inserts a new notice. A duplicate observation
whose notice already exists receives `no_new_publication_notice`; the earlier
notice and publication are never attributed to a later replay. A stale worker or
failed transaction cannot manufacture a result. Low-level legacy replay clears
the operator pointer instead of silently inheriting a previous audited operation.

| Result state | Retained reason | What is established |
| --- | --- | --- |
| `unknown` | `legacy_unbound` | No causal binding was recorded for this older audit |
| `queued` | `awaiting_intake` | The audited replay is pending |
| `processing` | `intake_in_progress` or `publication_in_progress` | A current worker lease exists; completion remains unconfirmed |
| `failed` | `intake_failed` or `publication_failed` | The respective stage is quarantined |
| `superseded` | `later_replay_queued` | A later replay replaced this still-unprocessed queued attempt |
| `processed` | `no_new_publication_notice` or `awaiting_publication` | Intake completed; this replay has no verified publication yet |
| `published` | `verified_publication` | The actual publication ledger and current private/source authority verify all returned references |
| `unavailable` | `source_generation_changed`, `result_binding_unavailable` or `publication_verification_unavailable` | The necessary current binding or verification is unavailable; publication references and publication delay are withheld |

The native verifier checks the persisted outbox operation and actual SQL
`dispatch_publications` mappings, exact configured scope set, each immutable
snapshot/document digest, and the private arithmetic explanation and publication
confirmation. It reconstructs the publisher's content ID with this operation's
recorded event cutoff and configuration. An authentic snapshot from a different
window cannot establish this replay. A genuinely content-identical dispatch may
retain an existing revision after a later observation freeze: the first private
explanation remains immutable, and the current source/cache and privacy checks
still apply. A future explanation cannot authorize an earlier observation freeze.
Outbox completion JSON alone is insufficient.

Current installation/generation, approved configuration, normalized source
identities, source suppression, private actor suppression, active metric
configuration and recognition authority remain independent checks. The native
reader keeps its PostgreSQL source and normalization locks through the last
asynchronous session/grant check, JSON serialization, synchronous private
currentness check and HTTP send. A changed session, grant, policy, configuration
or private publication authority withholds the response. Permanent source
retirement denies both reads across a database/runtime restart. A retired
repository checkpoint view also denies its quota health read while preserving an
active sibling's shared source-pool observation.

Each result can retain its original `queuedAt` and a trustworthy `processedAt`.
`processingDelaySeconds` measures queued-to-processing completion.
`publicationCompletedAt`, `publicationDelaySeconds`, `publicationPolicyVersion`
and the nonempty `publications` set appear only for a verified publication;
publication delay measures queued-to-publication completion. Current read policy,
queued replay policy and publication policy are separately named and need not be
the same version. Invalid, missing, future or backward clocks never become zero
delay or successful completion. A later correction or loss of current authority
can make an earlier successful result unavailable without rewriting its audit.

Verification reads at most 100 publication references and enforces a combined
16 MiB budget for SQL snapshot documents and private proof material. It checks
the SQL size manifest before loading document payloads, deduplicates private
authorization sets, and bounds their normalization identities at 10,000. The
existing source/cache validation budget remains in force. The host must still
set database statement/transaction timeouts, connection limits and request budgets.

### Health observations

Health carries its explicit `asOf` UTC instant and configured freshness budget.
Collection summaries consider only configured source families in the current
repository generation. Each has a fixed state/reason, latest usable attempt,
last complete success, reconciled-through time and nullable actual/expected counts.

`quiet` requires a recent complete window whose actual and expected item counts
are both known zero. A missing attempt remains `unknown`. A failed collector
read has state `disconnected` and a fixed `source_read_failed` reason; it reports
the failed read, not a diagnosis of the physical network. Other failures are
`degraded`, incomplete recent work is `collecting`, and old attempts or completed
reconciliation are `overdue`. Fresh complete nonempty work is `progress`.
The aggregate cannot hide a disconnected, degraded, overdue, unknown or collecting
family behind another family's successful read.

Intake counts and lag cover retained envelopes for the selected repository and
current installation. Pending, leased and quarantined records all contribute to
the oldest unfinished queue age. Completed payload expiry removes an envelope
from those counts; it does not turn a retained-payload observation into complete
history. Intake lag uses that latest retained delivery's source time and independent
receive time. Missing or future source time remains unknown. Publication queue
age covers the corresponding retained notices. Its latest completed publication
must pass the same native proof verifier before exposing revisions or completion
delay; that health delay measures received-to-publication completion, separately
from a replay result's queued-to-publication delay.

Quota health uses the accepted scoped observations in [the GitHub client
contract](github-client.md#retained-quota-observations). It reads exactly the five
fixed resource buckets for the current API origin/source pool and performs no
token lookup or GitHub request. A valid remaining count of zero stays zero;
missing, corrupt or inaccessible observations remain unknown or unavailable.
The reported reset may be in the future. Counters are separate retained response
observations and cannot establish an exact global balance or collector heartbeat.

The console offers explicit health and per-receipt result reads. Its independent
browser validator binds all four authority fields, receipt/delivery identity,
state/reason combinations, scope-set bounds, response clocks and nullable values.
Repository edits, visibility/session changes, replay/window edits and newer reads
clear the old private observations. Late responses cannot restore them. An
unavailable or denied read clears the private view and requires fresh diagnostics;
there is no background poll, automatic replay or fallback to public API data.

### Automated recovery evidence

The new executable tests use established synthetic sessions and actual native
components. `operator-results.test.mjs` covers persisted receipt/lease causation,
stale workers, new-notice attribution, rollback, legacy audits, timing and result
minimization. The pipeline's `operator-health`, `operator-http` and
`operator-retirement` suites cover fresh empty versus failed collection, unknown
clocks/counts, scoped quota reads, actual multi-scope publication, incorrect-window
grafts, legitimate existing-revision reuse, final HTTP authorization/serialization
fences, source and checkpoint retirement, and proof-size bounds.

The native recovery case closes and reopens the on-disk database, constructs a new
pipeline runtime, rejects the expired worker lease, processes its replacement once
and dispatches the actual publication. It checks one observation, one notice, one
processing result and the exact two scoped publications. The browser recovery
journey queues the audit through real HTTP, observes queued status, performs that
restart and reads the native publication identities. Additional browser cases
cover quiet/disconnected health, zero/unknown quotas, revoked grants, current
suppression, late responses, keyboard confirmation, 320px reflow and Axe checks.

Run the current source with Node 24 and the repository's pinned dependencies:

```sh
npm run build
node --test --test-concurrency=1 packages/ingestion/test/operator-results.test.mjs packages/ingestion/test/operator-window.test.mjs packages/ingestion/test/operator.test.mjs apps/pipeline/test/operator-health.test.mjs apps/pipeline/test/operator-http.test.mjs apps/pipeline/test/operator-retirement.test.mjs apps/web/test/operations-observed.test.ts
npm run test:browser -- operations.spec.ts operations-observed.spec.ts
```

These automated software checks support the #73 recovery and health distinction.
Their actual execution receipts, independent source review, protected delivery and
literal issue acceptance remain separately recorded in the PR/issue discussion.
They do not replace the staffed #93 drill, installed-source authorization,
production capacity/SLO qualification or the actual-duration wall soak.
