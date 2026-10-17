# Public read API v1

The Fastify service implements anonymous reads over an explicitly approved public
projection. `createService({ source })` takes a `PublicSnapshotSource`; without it,
data and health requests return 503, never synthetic rankings or a live claim.
`/healthz` is process liveness only. `/api/v1` describes configuration, not source
health. No endpoint accepts GitHub credentials or mutates upstream state.

## Publication boundary

The frozen `@pick-your-ai/contracts` v1 Actor, Artifact, Contribution, MetricResult,
Coverage and Snapshot schemas remain authoritative. The service adapter adds exact
scope, approved ranking directions, actor publication states and evidence indexes;
it does not redefine those contracts. Definitions come from the existing 98-metric
registry and the snapshot definition version must match the loaded registry policy
version. Historic versions need their matching registry deployment; an unknown
version returns 409 instead of mislabeling results.

Implement `PublicSnapshotSource.read(scope, snapshotId, signal)` atomically:

1. Resolve an approved materialized snapshot for the **exact** requested scope,
   or its explicitly requested immutable ID. Return null for an unavailable,
   unapproved or expired selection. A scope with no known coverage is not a zero.
2. Return the current head together with the selected snapshot and **current**
   publication controls, including historical reads. `controls.version` must change
   whenever suppression, eligibility, opt-out or correction policy changes. Revoke
   affected historical snapshots when corrections cannot safely retain their
   aggregate values. Never serve historic controls as current controls.
3. Supply only source-policy-approved public actors and evidence, an eligibility
   explanation (`reasonCodes`), event time or null, source revision or null and
   approved metric-specific sort directions. Do not infer comparability or a
   universal score from unrelated metric families. Scope computation, identity
   verification and metric accuracy belong to their reviewed producers.
4. Respect AbortSignal and impose a backend query deadline. Do not hold database
   transactions while waiting for clients. Snapshots must be immutable within the
   same snapshot ID; replace the ID/revision after recomputation. Fail closed if
   current controls cannot be read.

`packages/ingestion`'s `SnapshotStore` publishes **internal retained-object replay**
documents. Its `latest`, `byId` and `notices` APIs are useful publication inputs,
but do not certify public visibility, attribution, metric eligibility or organization
coverage. Passing those raw documents to this API is intentionally unsupported.
The reviewed metric/publication pipeline must construct the adapter above; neither
this service nor a database credential grants permission to publish a source.

The public projection revalidates contracts, copies allowlisted fields, removes
hidden/deleted/unlinked actors and non-public/ineligible evidence, and applies the
current suppression overlay before every response. Removing an artifact removes
its dependent aggregate row; the service never subtracts evidence counts from
ratios or weighted values. Public URLs must be HTTPS GitHub repository URLs without
userinfo, query parameters or fragments. Excerpts, raw payloads and emails are not
public fields. Source exception strings and missing permission names become generic
public capability/error codes. Revoked snapshots return 410, including exports.

## Routes and scope

All paths are under `/api/v1`:

| GET path | Response |
| --- | --- |
| `/metrics` | Machine-readable existing v1 metric registry and definitions |
| `/boards?metric=pr_opened` | Approved ranking, definition, scope, coverage, versions, pinned share URL and cursor page |
| `/contributors/:actorId` | Same-snapshot metric totals, role counts, bounded contribution timeline and evidence IDs |
| `/evidence/:contributionId` | Public artifact, eligibility reasons, source revision links and snapshot metadata |
| `/health` | Per-source coverage, reconciliation watermark, sync time and safe degraded state |
| `/exports?metric=pr_opened&format=json` | Same selected board projection and filters |
| `/exports?metric=pr_opened&format=csv` | Escaped, bounded board rows with definitions, source URLs, versions and dates |
| `/updates` | Bounded SSE snapshot/reset notice or heartbeat; conditional health polling is the fallback |

Scope parameters are `organization` (default `Pick-Your-AI`), `repository` (stable
repository ID), `workstream`, and paired UTC `start`/`end`. Times use canonical
`YYYY-MM-DDTHH:mm:ss.000Z`; the half-open window requires start < end and is limited
to 366 days. Omitted dates select the publisher's explicitly materialized all-time
scope. The service does not sum multiple overlapping snapshots to approximate
filters. `snapshot` pins an immutable selection. Organization/repository/workstream
and metric IDs are bounded identifiers; duplicate, unknown and malformed parameters
are rejected before backend access.

`limit` is 1–100 (default 50). Signed cursors bind exact scope, metric, limit,
snapshot, current policy version and offset. Cursors expire within 10–15 minutes;
deployment restart/key rotation may expire them earlier. Supply the original query
and `cursor` to continue. A policy change returns 410 and requires restarting the
view, preventing skipped rows after suppression. Rows sort using the explicitly
approved direction, stable actor ID as the tie breaker and dense ranks for
equal values (1, 1, 2). Approved descriptive-only policies set `rank: false`; these
rows have null ranks and stable actor-ID ordering. Unknown results have no rank or
numeric value. Profiles use the same
rows as boards. Timelines are bounded by `limit` and expose truncation plus IDs for
individual evidence reads; they never silently imply that a truncated timeline is
complete. Hidden, deleted, suppressed and unlinked profiles share a generic 404.

JSON and CSV are enabled. Markdown portfolio and print presentation exports are
disabled: `format=markdown`, `format=print` and other unknown formats return 400.
This avoids adding another unreviewed public presentation path. CSV preserves the
selected scope and snapshot, quotes every field and prefixes spreadsheet formulas
even after leading whitespace/control characters. Exports are paged with the same
limits and next cursor as boards; an export is never an unbounded database dump.

## Caching, health and live behavior

Responses use a content-derived ETag and
`Cache-Control: public, max-age=0, must-revalidate`. Each conditional read first
rechecks current publication controls; an old ETag cannot bypass an opt-out. There
is no stale-serving grace period or in-process response cache. Canonicalized scope
and stable ordering make equivalent queries produce equivalent entities; cursor
expiry uses five-minute issuance buckets. Errors and SSE use `no-store`. A deployment
CDN must preserve revalidation and must never add stale-if-error/stale-while-revalidate.

Public health includes service version and last successful publish revision.
`recently_reconciled` means every supplied coverage record is complete, has a known
watermark and a nonfuture successful sync within five minutes. Otherwise it reports
`stale_or_degraded`. This is not proof that webhooks are live. Webhook lag remains
null because the current frozen coverage contract has no measured webhook lag field.
Missing data/source outages return 503 with a generic code. Tokens, backend hosts,
stack traces and raw source errors are never response fields.

SSE uses finite, bounded windows with a three-second reconnect hint. A fresh
connection receives `snapshot`; the same Last-Event-ID receives a heartbeat;
any changed/expired cursor receives `reset` pointing at the current full snapshot.
Notices include revision, snapshot and current policy version. Missed revisions are
coalesced: clients must fetch the entire selected snapshot rather than apply deltas.
The service holds no long-lived database/HTTP stream resource. Consumers should
retain the last event ID; browser reconnects may instead get a duplicate notice,
which is safe to deduplicate by snapshot/revision/policy.

`apps/service/src/live-client.ts` exports a browser helper with EventSource support,
conditional health polling, bounded exponential backoff (up to 30 seconds), a
five-second request deadline, duplicate/out-of-order notice rejection, visibility
pause/resume and explicit stop cleanup. It accepts only same-origin API base paths
and omits credentials. Polling continues to verify freshness while streaming.
Transport status never implies live data: `onState` reports the observed health
state, unknown during outages/new notices, and paused when hidden. `onSnapshot`
requests a complete refetch; the consumer decides when to replace the visible board.

## Bounds and verification

Defaults: 4 KiB query URLs, 100 rows/page, 10,000 projection rows/actors, 20,000
evidence records, 40,000 evidence references, 16 concurrent backend reads and 16
concurrent SSE windows. Backend timeout defaults to two seconds. Slots remain held
until a timed-out provider actually settles, so a provider ignoring cancellation
cannot exhaust the backend through unlimited retries. Saturation returns 429.
Deployments can lower the configurable bounds; backend timeout cannot exceed ten
seconds and concurrency cannot exceed 128. There is no claim of production load
validation from these deterministic limits.

Validation commands:

```sh
npm run build --workspace @pick-your-ai/contracts
npm run build --workspace @pick-your-ai/metrics
npm run build --workspace @pick-your-ai/service
node --test apps/service/test/*.test.mjs
python scripts/validate_plan.py
python -m unittest discover -s tests -v
python scripts/render_docs.py --check
```

HTTP integration and browser-helper tests use synthetic data exclusively and cover
pagination/pins, filter scope, ties/unknowns, suppression/revocation, private evidence,
ETag revalidation, safe CSV, sanitized outages, invalid/costly queries, deadlines,
SSE reset/heartbeat and conditional polling/pause/fallback. A separate process smoke
test starts the service from dist-only workspace packages with no metrics source
tree, verifying the exported metrics registry package boundary. They do not verify a real
GitHub App, source permissions, metric correctness on real observations or deployment.
Issues #99, #105, #106, #92 and #110 still require their applicable prerequisite policy
and affected-owner acceptance, plus a reviewed public projection producer. Anonymous
production readback additionally requires actual approved hosting/deployment. These
facts must not be inferred from passing scaffold/runtime tests.
