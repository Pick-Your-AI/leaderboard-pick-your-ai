# Synthetic webhook-to-publication bridge

Partial implementation evidence for [#54](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/54),
[#58](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/58),
[#62](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/62) and
[#84](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/84).
This is a loopback synthetic integration, not source approval, issue closure or deployment.

## Bounded behavior

The existing signed receiver durably acknowledges a minimized delivery. The inbox
worker atomically writes the retained observation and outbox notice. An opt-in
pipeline dispatcher now consumes those notices, initially for `issues/opened`
only. Public-mode dispatch is explicitly rejected; the default remains disabled.
The configured metric policy must include `issues_opened` from `github_rest`, the
repository must already allow the issues family, and an approved publication
scope must include it. No webhook expands source permissions or supplies policy.

A notice is an invalidation trigger. Its sender, nullable occurrence time and
unqualified state are never copied into contribution credit. The dispatcher runs
the existing approved read-only collection plan, including its bounded configured
families, then hydrates the exact subject/revision through the real GitHub client
and evidence normalizer before invoking the metric engine and atomic publisher.
It requires matching target creation evidence even when its actor/time is unknown.
An unavailable subject, incomplete collection or failed hydration cannot produce a
successful dispatch receipt. Missing actor/time remains unknown and unranked;
creation is raw observed work, never accepted or reviewed recognition.

All fixture source HTTP responses are injected into the actual transport in the
integration tests. No GitHub installation, public source, upstream write, live
canary, hosting or paid infrastructure is enabled by these changes.

## Durable operation and failure boundaries

Apply `packages/ingestion/sql/004_outbox_dispatch.up.sql` after migrations 001–003
using the approved migration procedure. This additive migration gives every
existing notice a pending state. It adds token-fenced leases, attempts, capped
exponential retry time, fixed diagnostic codes, frozen operation fields, completion
receipts and attempt/replay history. Startup does not apply migrations.

The first claim freezes configuration identity/revision, policy and dispatcher
normalization versions, data mode, event cutoff and operation ID. After collection,
a separate durable checkpoint freezes the observation cutoff and repository access
generations. Retries preserve these values. Configuration changes quarantine the
old operation rather than silently assigning it a new policy. When a completed
listing has not yet exposed the target, a fenced collection revision grants the next retry a fresh source/cache key before the observation
cutoff is frozen. Partial scans and hydration retries retain their original scan.
A source-generation change fails closed; operator review or a separately authorized fresh operation is
needed when its original frozen evidence can no longer be reproduced.

Each scope's immutable snapshot and operation-to-snapshot binding commit in the
same PostgreSQL transaction. Confirmation still uses the protected controls store.
The outbox is completed only with confirmed publication receipts under its valid
lease and current source/configuration fences. SQL commit followed by failed
confirmation is retryable. A process crash after publication but before
acknowledgment resumes the original binding; it does not repoint a newer head to
an old snapshot or mint another revision. The existing API independently checks
current controls and source access on each read, including after changes that race
with a database commit. This is not a distributed transaction across SQLite and
PostgreSQL; publication confirmation and current read guards remain necessary.

One worker handles one notice at a time. Claims use `FOR UPDATE SKIP LOCKED`;
completion, failure and frozen checkpoints require the current token and unexpired
database lease. Expired workers cannot publish/acknowledge. A bounded sweep
quarantines workers that crashed on their final attempt. Retry delays are capped at
300 seconds; the default maximum is five attempts. Unsupported event/action or
observation versions quarantine immediately, without source requests. Status and
failure reports contain fixed codes, never raw API bodies or exceptions.

`OutboxStore.replay(eventKey, receiptId)` is an operator-only primitive. The host
must authorize a reviewed receipt before calling it. It preserves the frozen
operation and prior attempt history, records the previous quarantine reason and
grants a fresh bounded retry budget. It cannot change source/configuration binding.
There is no public replay endpoint or automatic operator authorization.

## Host integration

The existing `createPipeline` host configuration, `verifyConfiguration`, source
allowlist, visibility probes and protected controls remain mandatory. After
reviewing the synthetic setup, pass `dataMode: 'synthetic'` and
`webhookDispatch: true`. `start()` starts the outbox worker even without a webhook
listener, allowing a restarted consumer to drain previously acknowledged work.
When a webhook listener is supplied, the existing inbox worker also starts.
All synthetic listeners remain loopback-only. `stop()` stops new work and awaits
in-flight inbox/dispatch/publication operations before closing its servers.

`dispatchOnce()` permits one bounded protected-host dispatch for controlled tests
or an already-approved worker. It returns `blocked` when disabled/unapproved.
`runtime.outbox.health()` reports pending, leased, quarantined and completed notice
counts. These are internal processing states, not source freshness certification.
The standalone `runOutboxWorker` uses abortable idle/error waits and does not let
telemetry exceptions change durable outcomes.

## Validation and remaining acceptance

Synthetic tests exercise signed HTTP intake, duplicate delivery, runtime replacement
and embedded PostgreSQL database reopen, autonomous dispatch, confirmed HTTP board
and evidence reads, duplicate source/notice units, hydration retry, SQL commit
before confirmation, simulated process loss before acknowledgment with an intervening newer
head, expired leases, poison schema/action, configuration removal/restoration,
configuration changes across restart, source revocation and unknown timestamps.
Store tests cover retry budgets, final-attempt crashes, protected replay receipts,
transactional completion rollback and in-flight worker shutdown. The PostgreSQL
integration test uses independent connections and `SKIP LOCKED`; it is explicitly
skipped when only PGlite is available and must run in the existing disposable
PostgreSQL CI service. PGlite is not evidence of multiconnection locking behavior.

Remaining gates are explicit:

- #54: source/owner acceptance, broader event normalization/deduplication policy,
  production concurrency/retention/recovery evidence and protected operator flows.
- #58: general asynchronous classification, richer metadata families and accepted
  outcome evidence/owner policy. This slice reuses source hydration for issue
  creation only; it does not award qualification.
- #62: independently reviewed public release and every enabled scope's service/UI
  agreement. This slice demonstrates the existing atomic publisher locally.
- #84: captured real-source capability evidence, full error/schema matrices and
  explicitly approved live canaries. No canary or recurring source work is created.

Public webhook dispatch, other actions/families, installed capability, actual
PostgreSQL operations drills, production load/latency budgets, deployment and all
owner approvals remain separate work. No GitHub execution status, assignee,
project field or issue acceptance state is changed.
