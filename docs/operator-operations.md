# Protected diagnostics and audited inbox replay

Refs #73 and #93. This supplies an opt-in backend bridge and an independently mountable `Operations` component. It does not claim source connectivity, successful recovery, a published revision, production deployment or operational acceptance. #94 specialist correction handling and staffed private verification remain separate.

The approved host constructs `new OperatorInbox(database)` from the ingestion package and passes it as `operations` to `createControlsServer`. It must also supply `authorizeRepository({actorId,repositoryId})`, returning `{allowed:true,policyVersion,revision}` only for a currently authorized operator/repository pair under an approved policy. Every missing option defaults to unavailable; the operator role alone grants no repository. The callback must use current authority, not a cached browser declaration. Changing authority must change `revision`; changed policy/revision invalidates previously displayed replay selections. The host remains responsible for database statement timeouts and connection/resource budgets.

`GET /controls/operations/:repositoryId` requires an authenticated operator and repository grant. It reports only repository-scoped retained inbox counts, at most 50 quarantined delivery identifiers with attempts/reason codes, 50 collection run summaries and 50 sanitized replay receipts. Truncation is explicit. It does not return source URLs, subjects, raw payloads, authentication material or stack traces. Counts describe processing, not connectivity or complete historical coverage. Collection expected totals and last success remain unknown when unavailable.

`POST /controls/operations/:repositoryId/replay` accepts only `{deliveryId,expectedRevision,reason,confirmed:true}` with ordinary session, origin and CSRF protections. Reasons are `source_recovered`, `normalization_corrected` or `operator_reviewed`. The server derives operator identity. A transaction locks the current public repository-access generation and exact quarantined inbox record; the opaque displayed revision binds repository, access generation, authority/policy, delivery digest, attempt count/reason and attempt timestamp. Authority is rechecked before mutation and after the receipt/queue writes, before transaction commit; revocation during those writes rolls both changes back. Foreign, withdrawn, already queued or changed records fail closed.

The transaction writes the durable replay receipt and resets only that retained delivery to pending with a fresh bounded attempt budget. The receipt records operator, reason, policy, repository generation, prior attempts/reason, before revision and queued revision. `resultingPublicationRevision` remains null: a queued replay is not collection success. An uncertain HTTP response must be resolved through receipt readback rather than an automatic retry. No unaudited outbox replay endpoint is exposed.

Both diagnostic and replay responses recheck the current session and repository authority after adapter/database completion, and require the same policy and grant revision as at request admission. A synchronous session check after response serialization prevents an expired or revoked session from receiving the result. If authority changes after a replay has committed, the response is withheld; this does not undo an already committed receipt, and authorized receipt readback remains the recovery path.

`<Operations session={session}/>` is mounted inside the authenticated operator console. It requires repository selection and scoped confirmation, clears private output on visibility/session changes, ignores superseded completions, and never reads operational data from the public API. The parent controls UI retains authority over session state. The mounted integration preserves the separately reviewed evidence amendment workflow. Collection runs and historical receipts explicitly identify their own source generation; they are not relabeled as current-generation evidence.

## Bounded source/time-window host primitive

`OperatorInbox.previewReplayWindow(window, authorize)` and
`OperatorInbox.replayWindow(request, authorize)` add a host-only bounded replay
primitive for #73. They have no HTTP route, UI action, CLI command or scheduler.
Existing single-delivery controls are unchanged. A preview is read-only and does
not grant authority to execute a replay.

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
receipts). All resulting publication revisions remain null until actual
publication is independently established; resetting the inbox is not publication.
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
```

It exercises exact time boundaries, foreign/current installation filtering,
overflow and the 50-delivery cap, stale membership and attempt revisions, changed
authority/source/policy, post-write revocation, transaction rollback, audit
minimization, preserved history and resumed workers producing no duplicate
observations/outbox records. These tests do not certify production concurrency,
throughput, complete source coverage or a deployed operational drill.

Validation covers the real controls HTTP boundary and transactional PostgreSQL-compatible PGlite store, including denied anonymous/non-operator/foreign-repository access, CSRF, confirmation, server-derived identity, changed authority/source/policy, stale replay revisions, single receipt persistence and no payload leakage. Browser integration forwards synthetic authenticated requests through the real controls HTTP server and transactional database adapter, verifies scoped replay and receipt readback, denial clearing, 320px reflow and axe checks. It is not a live OAuth/deployment exercise. Real worker catch-up/publication and a staffed operational drill remain required acceptance evidence.
