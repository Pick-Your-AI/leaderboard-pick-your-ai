# Ingestion backend candidate

Partial implementation for [LB-05.01 / #51](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/51) and [LB-05.02 / #54](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/54). This package has no UI and does not install an App, collect live data, publish rankings or deploy a service. Scope is the authenticated intake and durable worker primitives, independently testable before a runtime host is approved.

## Run validation

Use Node 24, from this directory:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Default tests use PGlite's embedded PostgreSQL engine and explicitly skip the multi-connection test. CI repeats the suite against a fresh PostgreSQL 17 service, including concurrent duplicate inserts and `SKIP LOCKED` workers. For the same integration suite locally, supply `INGESTION_TEST_DATABASE_URL` pointing to a disposable database named `leaderboard_ingestion_test`. Tests refuse an existing ingestion schema and truncate only that dedicated test schema between cases. They leave it present for inspection; use a fresh database for another run. Never point this setting at a shared or production database.

## Host integration

1. Have the approved migration runner apply `sql/001_ingestion.up.sql` inside a transaction. This is a separate `leaderboard_ingestion` schema and does not modify the research contracts or other candidate migrations. The migration is intentionally not auto-run by the library. Rollback destroys this schema's intake state; use `001_ingestion.down.sql` only on disposable empty environments. Retain production receipts through reviewed backup/restore procedures.
2. Construct a `pg.Pool` using the host's managed connection and TLS settings, then `new InboxStore(postgresDatabase(pool))`. The database must have normal durable commit settings; do not disable `fsync` or synchronous commit. The pool and database are owned by the host.
3. Construct `createWebhookHandler({ secrets, scope, store })`. Secrets come from the approved secret store, with one current and optionally one previous key. Configure explicit installation-ID to repository-database-ID sets. Empty scope denies everything. Route only the intended webhook endpoint to this Fetch `Request` handler; preserve original bytes and set request timeouts and connection/rate limits in the host or proxy.
4. Poll `store.claim()` from a bounded worker. `null` means no available work. Call `store.complete(lease)` to persist the deterministic delivery observation and an outbox notice in one transaction. Call `store.fail(lease, reasonCode, permanent)` for a classified processing failure. A false result means the lease no longer belongs to that worker. An uncaught failure leaves the lease recoverable after expiry. Each call uses database time and a fresh token; never retry work using a stale token.
5. After reviewing a quarantined delivery and accepting an opaque operator receipt, call `store.replay(deliveryId, receiptId)` from a protected operator process. Replay retains the original body hash, envelope, receive time and attempt history, records the previous reason and attempt budget, and grants a new bounded retry budget. No public replay endpoint is supplied. A receipt cannot be reused; transaction rollback preserves quarantine on a receipt conflict.

All store writes are parameterized. Credentials, raw source bodies, titles, user text, emails and logins are not retained. Error responses contain fixed codes. Delivery IDs identify authenticated delivery receipts, not unique source contributions. Different delivery IDs describing the same GitHub action remain separate observations until the source-event deduplication and lineage layers reconcile them. The outbox is a durable internal notice queue; dispatch and public snapshot publication are separate work.

## Supported intake and failure behavior

The candidate accepts only signed JSON `issues` and `pull_request` deliveries with `opened`, `closed`, `reopened` or `edited` actions. It requires an explicit public visibility value, a false private flag and allowlisted stable installation/repository IDs. Other event/action types, lifecycle events and ping requests are rejected; they must be added with their own capability and minimization tests before routing an installed App here. Private or unknown-visibility deliveries are rejected without retaining their bodies. Issue payloads representing pull requests are rejected to avoid namespace overlap.

HMAC-SHA256 is evaluated on raw bytes before JSON parsing, with constant-time digest comparison and a maximum body size (default 1 MiB), including streamed bodies. Byte-changing redeliveries under the same delivery ID conflict. Identical redelivery returns success only after an existing durable receipt is found. A database failure returns 503, never an acknowledgement. Configure GitHub redelivery/reconciliation separately; GitHub delivery alone is not a guarantee that a failed request will be retried.

The minimized envelope retains only delivery/event/action IDs, source scope IDs, subject ID, source URL, nullable action actor and nullable occurrence time. Opening and closing use the subject's corresponding source timestamp when valid. Edit/reopen occurrence time remains unknown because `updated_at` does not establish that action's time. Receive time is recorded independently by the database. Observations are explicitly unordered and unqualified; this package does not infer contribution credit, source order, effective time, supersession, or metric eligibility.

Claims use `FOR UPDATE SKIP LOCKED`; state changes use the current lease token and database expiry checks. Completion commits the observation, outbox and inbox state atomically. Retries use exponential delays capped at 300 seconds and a bounded attempt budget (default five). Permanent failures and exhausted leases quarantine with fixed reason codes. A bounded sweep handles workers that crashed on their final attempt. Attempt receipts preserve retry, expiry and completion history, including across operator replay.

## Evidence and remaining gates

Synthetic tests cover GitHub's published signature vector, byte tampering, malformed inputs, rotation, bounded bodies, deny-by-default scope, public-only minimization, durable acknowledgement, duplicates/conflicts, atomic outbox rollback, expired-worker fencing, poison quarantine, replay provenance and migration rollback/reapply. CI additionally tests independent PostgreSQL connections and workers. These tests establish behavior for the supported candidate, not organizational permission or complete source coverage.

#51 still needs an installed-source capability review, HTTP host wiring, ingress load/rate/time budgets and reconciliation receipts. #54 still needs runtime worker integration and an accepted normalization/deduplication policy. Their governance and prerequisite issues remain open. Runtime placement, App installation, source permissions, retention/deletion of these minimized receipts, protected operator authorization, delivery-level monitoring, production restore drills and release approval need their respective owners. No project status, assignee or acceptance decision is changed by this package.

Implementation references checked 2026-10-17: [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [PostgreSQL row locking and SKIP LOCKED](https://www.postgresql.org/docs/17/sql-select.html). These describe protocol/transaction semantics; they do not prove permissions for an organization installation.
