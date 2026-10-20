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
   Optional `methodology` records bind each metric's policy version to a SHA-256
   policy signature and a safe public policy link (or null). These are separate
   from the current privacy-control epoch exposed as response `policyVersion`.
   Optional current `disabledMetrics` provide a bounded machine-readable reason
   and policy provenance; disabled board/export requests return 503 `metric_disabled`
   and their rows/evidence are removed from every route, including historical pins.
   Optional row-bound `diagnostics` preserve ratio numerators/denominators and
   duration sample counts, censoring, missing readiness and p75. Unknown diagnostic
   values remain null. Boards expose only their selected page's diagnostics, profiles
   only that contributor's visible measures; suppressed/disabled rows have none.
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
current suppression overlay before every response. Actor IDs must be unique across
the complete provider actor list, before hidden, deleted, unlinked or unresolved
records are removed. Contribution IDs must likewise be unique within the provider's
primary evidence collection before non-public or ineligible proof is removed.
That check uses the contract-parsed contribution ID, including its whitespace
normalization. In the selected read, a contradictory public copy cannot survive
by discarding its non-public counterpart; duplicate identities reject that read,
including historical pins and conditional responses. Visibility must also agree
across primary, portfolio and pending proof
for each contribution ID and each known artifact stable ID or contribution artifact
reference. Null or omitted artifact identities do not create a shared identity.
Legitimate matching proof across collections and multiple contributions to one
artifact are still supported. If only a prior rank-comparison baseline cannot be
projected, valid current totals remain available with comparison availability
withheld. Unique non-public actors remain suppressed without withholding unrelated
contributors. Removing an artifact removes
its dependent aggregate row; the service never subtracts evidence counts from
ratios or weighted values. Public URLs must be HTTPS GitHub repository URLs without
userinfo or query parameters; fragments are restricted to GitHub's numeric public
comment/review anchors. Excerpts, raw payloads and emails are not
public fields. Source exception strings and missing permission names become generic
public capability/error codes. Revoked snapshots return 410, including exports.

## Routes and scope

All paths are under `/api/v1`:

| GET path | Response |
| --- | --- |
| `/metrics` | Machine-readable existing v1 metric registry and definitions |
| `/boards?metric=pr_opened` | Approved ranking, definition, scope, coverage, versions, pinned share URL and cursor page |
| `/contributors` | Unranked public-evidence directory, username search, category artifact counts and cursor page |
| `/contributors/:actorId` | Same-snapshot metric totals, role/category counts, cursor-paginated timeline and page evidence IDs |
| `/evidence/:contributionId` | Public artifact, eligibility reasons, source revision links and snapshot metadata |
| `/health` | Per-source coverage, reconciliation watermark, sync time and safe degraded state |
| `/exports?metric=pr_opened&format=json` | Bounded selected board totals, minimized identity and page evidence provenance |
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

Opt-in `context=event|current` and comma-separated `project` node IDs select an
exact approved [versioned membership scope](public-membership-scopes.md). The
default remains event context; missing current/Project materializations never fall
back or trigger collection. Extended scopes use `public-scope/v2`, public API
envelopes use `public-read/v2`, and all scope dimensions remain bound through pins,
cursors, comparison windows and shared links.

An optional comma-separated `role` selects an exact approved union of contribution
roles through the separate [public role contract](public-role-scopes.md). Nonempty
role selections use `public-scope/v3`, `public-read/v3` and `public-export/v3`, with
explicit context, Projects and roles. Default and membership-only bytes remain
unchanged. Contribution roles grant no protected service authority. Missing role
materializations cannot fall back to an unfiltered head, and role identity remains
bound through pins, cursors, proof projection, comparison receipts and every link.

`limit` is 1–100 (default 50). Signed cursors bind exact scope, metric, limit,
snapshot, current policy version and offset. Cursors expire within 10–15 minutes;
deployment restart/key rotation may expire them earlier. Supply the original query
and `cursor` to continue. A policy change returns 410 and requires restarting the
view, preventing skipped rows after suppression. Rows sort using the explicitly
approved direction, stable actor ID as the tie breaker and dense ranks for
equal values (1, 1, 2). Approved descriptive-only policies set `rank: false`; these
rows have null ranks and stable actor-ID ordering. Unknown results have no rank or
numeric value. Profiles use the same rows as boards. Timelines are bounded by
`limit` and return `nextCursor` plus only that page's evidence IDs; there is no
100-record truncation ceiling. Hidden, deleted, suppressed and unlinked profiles
share a generic 404.

Directory `search` is a case-insensitive current public-username substring (1–39
ASCII letters, digits or hyphens). `category` is an existing published metric ID;
it is independent of board `metric`. Directory and profile cursors additionally
bind endpoint, search/category and profile actor, preventing cross-route reuse.
Directory ordering is current username (case-insensitive codepoint order), then
stable actor ID. Timeline ordering is newest occurrence instant then contribution
ID, so equal timestamps remain traversable. Same-query cursor replay is idempotent.

Source-time ordering retains all fractional digits accepted by the frozen contract,
including fractions smaller than a millisecond. Equivalent timezone and fraction
encodings compare equally, while distinct instants stay distinct. Unknown occurrence
times sort after dated evidence. Activity occurrence/collection ranges use the same
comparison; representations of a canonical fact with genuinely different occurrence
times fail closed instead of being silently combined.

The separate bounded portfolio projection retains attributable observed and
in-progress work even before ranking eligibility. It reuses frozen correction,
canonical attribution, role, source, context and independent-acceptance checks,
without changing the approved ranking policy. Portfolio dates use the actual
occurrence clock; board totals retain their declared metric clock. Each category
reports independent unique-artifact counts by observed, pending, accepted or unknown
state. Categories and states can overlap and must never be summed into a score.
Legacy snapshots without this projection retain unknown acceptance rather than
inferring acceptance from eligibility. Only policy-enabled categories can appear,
including through legacy detail routes. An actor roster, membership, mention or
assignment alone never establishes directory inclusion. See the
[bounded directory design and acceptance limits](contributor-directory-runtime.md).

Legacy event-scope JSON and CSV downloads use the unchanged `public-export/v1`
export envelope. Opt-in current-context or Project-filter selections use the
explicit [public membership scope and v2 response/export contracts](public-membership-scopes.md).
The API-backed browser validates their complete retained basis and Project identity,
and the explicit role union for public-export/v3, against the displayed selection.
Unknown or mismatched scope/export versions remain rejected.
Markdown
portfolio, print, HTML and SVG presentation exports are disabled: `format=markdown`,
`format=print` and other unknown formats return 400. No rendering/Markdown/URL-fetch
pipeline is enabled by the export module. The JSON/CSV automated package is accepted in
[#110](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/110).
That acceptance does not grant publication permission.

Both formats preserve the exact organization/repository/workstream/half-open date
scope, selected snapshot ID/revision/date, metric-definition version, computation
version, current control-policy version, full metric definition, approved ranking,
coverage, and any supplied methodology for that metric. Values and ranks come
unchanged from the selected board; evidence records never become extra metric rows.
Unknown values remain absent in JSON and blank in CSV; they never become zero.
Approved row diagnostics (numerator/denominator, sample count, censoring, missing
readiness and p75) remain bound to the selected visible page in both formats;
unknown diagnostic values remain null in JSON and blank in CSV.

JSON includes only each row's stable actor ID, public login (or null), rank, result,
and evidence IDs. The top-level `evidence` list contains only references used by
that page: evidence ID, repository ID, public source URL, event time, and supplied
source revision/URL. Display names, provider objects, internal canonical event IDs
and suppression lists are not export fields. Missing source revision/URL remains
null, and a supplied safe link is not a claim of immutable source provenance. The
provider remains responsible for immutable snapshot IDs, current authorization,
approved evidence and correctness of source revisions; the exporter does not
invent a revision or infer approval from a URL.

CSV has a header, exactly one `record_type=metadata` record and zero or more
`record_type=row` records. Consumers must select only `row` records for metric
totals. The metadata record retains snapshot, scope and definition even for a
valid empty or fully suppressed page. All records repeat the page metadata;
`total_rows`, `page_rows` and `next_cursor` describe pagination, not summed credit.
Structured metric definitions, ranking, coverage, methodology and row evidence are
JSON-valued CSV cells. Evidence objects preserve the source/revision association.
Every cell is quoted, embedded quotes are doubled and spreadsheet formulas are
prefixed with an apostrophe, including after whitespace or Unicode format
characters. Tabs/newlines remain quoted text; other ASCII controls are rejected.
JSON is served as an attachment with its JSON content type; CSV has its CSV content
type. Both set `nosniff` and a sandbox/default-deny content security policy.

Exports use the board's 1–100 row pages and authenticated continuation. A control
change invalidates a continuation; suppression, revocation, disabled metrics and
source failure are rechecked before all exports and conditional responses. Export
responses, including 304, use `Cache-Control: no-store`. This prevents authorized
server responses being cached for later suppression bypass; it cannot revoke a
file the recipient already downloaded.

Serialization fails closed with 413 `export_too_large` instead of dropping evidence
or truncating totals: at most 2 MiB per response, 16 KiB UTF-8 per text field,
256 KiB per rendered CSV cell and 2,000 distinct evidence records per page. The
JSON preflight additionally caps 100,000 visited nodes and 24 nested levels before
allocating the complete document. Request a smaller page when it reduces the
payload; an individually oversized row needs a reviewed producer correction.
Disallowed controls produce a generic 503 `export_content_unavailable`. These are
export serialization bounds, not a claim that provider ingestion/parsing or
production load has been fully bounded or independently validated.

## Caching, health and live behavior

Ordinary read responses use a content-derived ETag and
`Cache-Control: public, max-age=0, must-revalidate`. Each conditional read first
rechecks current publication controls; an old ETag cannot bypass an opt-out. There
is no stale-serving grace period or in-process response cache. Canonicalized scope
and stable ordering make equivalent queries produce equivalent entities; cursor
expiry uses five-minute issuance buckets. Exports, errors and SSE use `no-store`. A deployment
CDN must preserve revalidation and must never add stale-if-error/stale-while-revalidate.

Public health includes service version and last successful publish revision.
The top-level `coverage` and each source's `state`, `lastSuccessfulSync`,
`reconciledThrough`, `collectionState` and `degradedCapabilities` remain the selected
snapshot's frozen, sanitized coverage. Current diagnostics never rewrite a historic
snapshot or certify its missing historical coverage.

An optional `PublicSnapshotSource.readHealth(scope, snapshotId, signal)` uses the
same publication and current-authorization boundary as `read`, with an additional
`currentSourceHealth` projection (at most 100 repository records). The pipeline
implements this method; ordinary boards, exports and evidence reads do not scan
operational receipt stores. Legacy providers fall back to `read`, leaving current
collection and webhook lag unknown. The public projector rejects duplicate,
out-of-scope, malformed and unbounded diagnostics and copies only allowlisted fields.

For a GitHub source, `sources[].currentCollection` is explicitly repository-scoped:
the configured collection families in that selected repository, rather than a
claim that a particular transport is live. It reports the latest retained attempt
state, most recent attempt time, conservative successful sync/watermark from the
most recently completed scan of each configured family, and supported webhook
receipt state. A missing family or new
access generation is unknown; an unfinished run is collecting; a failed run is
degraded. `no_activity_in_window` means every latest configured scan completed with
an exact empty result. It does not establish complete historical coverage or prove
no new activity has occurred since that scan. A previous successful watermark is
retained after a newer failed run, alongside its current degraded state.

`webhookLagSeconds` measures the age of the oldest unfinished retained receipt,
including quarantined receipts, for this repository's current installation and
configured supported event families (`issues` and `pull_requests`). The explicit
`webhookLagBasis` is `oldest_unfinished_retained_receipt`; this is neither GitHub
delivery latency nor collection-to-publication latency. No retained matching
receipts, unsupported event families or a future receipt clock produce null,
never fabricated zero. Zero means matching retained receipts exist but none is
unfinished. Retained receipts from the same installation may predate a renewed
access generation; the inbox has no generation receipt and cannot prove a new
subscription is working. Foreign repositories, installations and unsupported
families do not affect the result. No raw envelope, actor, object, delivery ID,
installation ID, exception or internal topology becomes public.

`recently_reconciled` requires every frozen coverage record to be complete, have a
known watermark and a nonfuture successful sync within five minutes. Supplied
current collection additionally must be reconciled/empty with recent nonfuture
sync and watermark, no quarantined receipts and no measured backlog older than
five minutes. Otherwise health is `stale_or_degraded`. Unknown webhook activity
does not contradict bounded recent reconciliation and never becomes a live claim.
Current failures alter health and its ETag even when a historical snapshot is
pinned; successful current scans cannot upgrade partial frozen coverage. A source
visibility/authorization denial or unreadable source fails closed with a generic
503 (410 for unavailable historical pins). Tokens, backend hosts, stack traces and
raw source errors are never response fields.

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
pause/resume and explicit stop cleanup. It accepts only same-origin API base paths.
Health fetches omit credentials and reject redirects. The native EventSource uses
`withCredentials: false`; its browser-defined same-origin cookie behavior must not
be treated as an authenticated identity by the public endpoint. Polling continues
to verify freshness while streaming.
Health JSON is read incrementally with a 2 MiB decoded-byte limit, including when
Content-Length is absent or describes a smaller compressed body. Oversized advertised
lengths are rejected before reading, and rejected or aborted readers are cancelled.
Stream event data is checked against the same UTF-8 byte limit before JSON parsing;
an invalid notice closes that stream and returns to polling without applying it.
Native EventSource allocates received event text before delivering its callback, so
this application parse limit does not claim to bound the browser's network buffers.
Health and conditional validators are bound to the exact snapshot, revision and
policy identity. A changed stream notice clears that health cache; polling
responses overtaken by the notice are discarded even if JSON parsing finishes
later. A controls-only policy update cannot be undone by an older in-flight poll.
Transport status never implies live data: `onState` reports the observed health
state, unknown during outages/new notices, and paused when hidden. `onSnapshot`
requests a complete refetch; the consumer decides when to replace the visible board.

The API-backed web interface consumes the built, browser-only
`@pick-your-ai/service/live-client` export. Importing that entry does not start the
service or load its server dependencies. The interface subscribes to the current
organization/repository/workstream/period, membership basis, native Projects,
contribution-role union and actor selection, excluding any
historical snapshot, page cursor or proof selection. Registry-only pages still
request only the registry. The deployment-configured public API origin and path
are used for both full reads and update transport; route parameters cannot select
a different server. The web consumer validates complete health metadata against
its requested scope before accepting a freshness state. Its synchronous `validateNotice`
hook also checks the complete raw scope and envelope before stream or health acceptance
can update the highest revision, last notice or conditional-health validator. The hook
is optional for other helper callers and throws to use the existing fallback behavior.

New snapshot or privacy-policy notices immediately trigger a complete public
projection read, including for pinned snapshots. New rankings stay held until the
reader applies them or the existing opt-in safe-follow conditions permit an update.
Current suppression and revocation still apply while a historic snapshot is held.
The existing twenty-second visible-page privacy recheck and focus recheck remain
active. Hidden pages pause the transport, abort reads and remove displayed source
data; resuming checks the current publication and selected snapshot again.

### Applying a paced public update

An applied batch selects one exact snapshot and produces one compact polite
summary after that snapshot's matching public response and metric definitions
have been validated and committed to the page. The first eligible batch can start
immediately. A later batch waits until the previous read has completed and at least
one second has passed since its ready result and summary reached the page. This
one-second interval is an engineering policy for this interface, not a timing
requirement imposed by the accessibility criteria.

Automatic Follow coalesces newer observed heads only before the next batch starts;
it does not change an already admitted target. Source, privacy and Controls
rechecks remain immediate during that interval. A recheck of the same displayed
snapshot is not another applied batch and does not generate another update summary.

Manual Apply shows a brief, explained `aria-disabled` cooldown and guards click and
keyboard activation while busy or cooling down. It does not silently queue those
activations. When eligible, an activation captures the displayed pending snapshot.
The actual focused Apply node remains connected through loading and completion,
including automatic Follow resumed after reduced motion; deliberate focus moves
remain with their destination. Once Apply loses focus and has no pending target,
the inactive control can disappear.

Navigation, invalidation, an error, hiding the page or unmounting cancels an
unfinished batch and its summary. A later read must validate fresh state before a
new batch can start. Cancellation does not replay the old target, and failure
cleanup does not silently fetch an older snapshot to replace the error. Visible
loading text remains, but an identified Apply batch does not also announce that
loading text through a second live region. Initial loading and genuine error
alerts keep their existing behavior.

The paced-update browser cases use controlled time and synthetic provider inputs
through the real service handler. They cover delayed reads, advancing heads,
manual cooldown, current suppression, cancellation and exact focus ownership.
Their DOM summary observations do not establish assistive-technology speech,
physical-device acceptance or production source availability.

The visible **Current source freshness** section separates connection state from
`recently_reconciled`, `stale_or_degraded` or unknown source health. It names the
last successful health check without representing that time as a source-event or
snapshot date. New notices invalidate the freshness claim until their health is
verified; a failed or mismatched-scope response reports unknown. The timestamp is
not a repeating live-region announcement. Browser regressions exercise actual
EventSource reset delivery, conditional polling without EventSource, pinned
suppression/revocation, held keyboard-focused rows and visibility recovery against
synthetic inputs passed through the real service handler. They do not establish
source installation, production freshness, physical-device behavior or a display soak.

## Bounds and verification

Defaults: 48 KiB request targets, 100 rows/page, 10,000 projection rows/actors, 20,000
evidence records, 40,000 evidence references, 16 concurrent backend reads and 16
concurrent SSE windows. Backend timeout defaults to two seconds. Slots remain held
until a timed-out provider actually settles, so a provider ignoring cancellation
cannot exhaust the backend through unlimited retries. Saturation returns 429.
Deployments can lower the configurable bounds; backend timeout cannot exceed ten
seconds and concurrency cannot exceed 128. There is no claim of production load
validation from these deterministic limits.

The request-target bound admits 100 distinct 128-character Project IDs even when
every character needs percent encoding, three 200-character base scope fields,
all approved roles, and bounded route, pin and cursor fields. A target above the
bound returns 414 before provider I/O. Parsed header names and values plus normal
line framing have a separate inclusive 16 KiB budget and a 1,000-header limit;
overflow returns 431. The native parser captures one extra header to detect count
overflow before truncation. A fixed 65 KiB native parser limit bounds the bytes
Node accounts for across the target and headers. Node excludes leading optional
whitespace at both its original and current limits, so neither the parser setting
nor the retained-header check establishes an exact wire-byte ceiling. These use the
[Node HTTP server limits](https://nodejs.org/docs/latest-v24.x/api/http.html)
through Fastify's supported
[`http` option](https://fastify.dev/docs/latest/Reference/Server/#http).
Deployed proxies need corresponding reviewed request-target limits. The actual
loopback regressions establish the service boundary, not proxy or load acceptance.

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
ETag revalidation, parsed CSV formula/quote/newline attacks, empty-export provenance,
nullable revisions, UTF-8/cell/evidence/response limits, minimized JSON, sanitized
outages, invalid/costly queries, deadlines,
SSE reset/heartbeat and conditional polling/pause/fallback. A separate process smoke
test starts the service from dist-only workspace packages with no metrics source
tree, verifying the exported metrics registry package boundary. They do not verify a real
GitHub App, source permissions, metric correctness on real observations or deployment.
The bounded automated packages #99, #105, #106, #92 and #110 have reviewed completion
receipts. Their combined outcome and this projection ambiguity correction are mapped
in [public API acceptance](public-api-acceptance.md). Source authorization, complete
real-data reconciliation, assistive-technology journeys and operational/public-release
acceptance retain their separate gates. Anonymous production readback requires actual
approved hosting/deployment; passing synthetic runtime tests does not establish it.

## Bounded public activity feed (#121, partial delivery)

`GET /api/v1/activity` reads the same authorized portfolio projection as the
contributor directory, including observed-only and pending contributors with no
ranked row. Its optional `category` is an enabled metric ID; repository, workstream
and paired UTC action-date filters retain exact materialized-scope semantics.
`metric`, username search and CSV are not feed filters. No collector, raw webhook
inbox, live subscription, score or engagement count is introduced.

The reversible display policy `actor-repository-state-utc-hour-v1` groups canonical
facts by actor, repository, explicit activity state and fixed UTC occurrence hour.
This is a presentation grouping, not a contribution measure. Groups are sorted by
newest known occurrence, then stable group ID; unknown occurrence groups follow
and are isolated by artifact, without inferring a burst or substituting collection
time. Group identity does not depend on rank or page position. An observed,
pending or independently accepted state is supplied by the authorized portfolio;
legacy evidence remains acceptance-unknown. Missing occurrence and collection
clocks remain null. A date-window selection excludes unknown occurrence dates.

The shared source contract also validates coverage windows at their full fractional
precision: distinct sub-millisecond bounds form a valid half-open window, while
equivalent or reversed bounds do not. The service and browser use its shared
comparator. Browser activity validation rejects reversed occurrence/collection
bounds and proofs outside a group's exact source-time range, including differences
smaller than one millisecond. Timestamp representation, null clocks and UTC-hour
grouping remain unchanged. Direct contract and browser regressions cover these
boundaries, equivalent offsets and trailing zeros.

Canonical facts use source event, artifact and actor identity. Multiple metric
representations of that same fact count once within each explicit work state,
while every original contribution proof ID remains accessible. Acceptance belongs
to the metric policy: a fact observed under one policy and accepted under another
retains both states in separate groups with the same canonical-fact ID. State-group
counts must not be added. Conflicting occurrence/artifact metadata within one state,
or conflicting states for the same canonical fact and metric, fail closed with
`activity_fact_conflict`; the feed does not choose a more flattering state.
Category filtering precedes canonical conflict checks, so an unrelated category
cannot make the selected category unavailable.
Counts disclose distinct artifacts, canonical facts and proof representations,
never a sum of unlike metrics. A category-filtered feed/detail pair retains only
proofs in that category. Equal timestamps remain deterministically traversable.

Each feed card has at most five artifact previews. A 1,000-artifact same-hour
burst therefore occupies one card, retaining its counts and a proof-detail link.
`GET /api/v1/activity/:groupId` paginates the group's complete source proofs,
including separate representations of a canonical fact. Both endpoints accept
1–100 items/page and signed cursors bound to route, group where applicable,
grouping version, exact scope, category, page size, snapshot and current control
version. Pages never accumulate in the browser. The shared 20,000-evidence source
ceiling still applies. Entry JSON is capped at 1,000,000 UTF-8 bytes/page with a
continuation cursor when bytes limit a page before the item count; an individual
oversized item is explicitly unavailable. The whole activity response is capped
at 1,500,000 bytes, below the browser's 2,000,000-byte read ceiling.

Every page is reprojected under current actor/artifact suppression, metric
allowlisting/disablement, public-URL checks and snapshot revocation before any
conditional response. A current-control change invalidates cursors. Detail routes
cannot recover a suppressed group, and a held historic snapshot is not a privacy
cache. Existing source timeout/concurrency/query protections also apply.

The API-backed `/activity` UI displays action and collection times separately,
explains delayed collection, exposes category/repository/date controls, preserves
snapshot/category through proof pages and Back navigation, and holds new heads
while reading. Rechecks retain stable keyed DOM when content is unchanged; current
privacy removals still take effect immediately. New data is applied through the
existing explicit update control or opt-in safe-boundary follow behavior.

Optional [versioned evidence metadata](public-evidence-metadata.md) carries credited-fact actions, as-collected titles, original source and collection clocks, independently receipted acceptance times and explicitly public partial revision/correction records. Activity detail uses the same permitted-evidence renderer as the drawer and permanent route. The envelope declares `correctionHistory: "per_proof"`; it does not assert a complete correction-event timeline. Missing metadata remains unknown and no current privacy-control change is invented as an activity event.

Remaining #121 criteria include real source capability and public history provenance, deployed live refresh, human approval of the one-hour grouping default, assistive-technology journeys and affected-owner acceptance. Complete historical correction chronology and unavailable historic fields remain outside this partial implementation. Synthetic tests alone do not close #121.
