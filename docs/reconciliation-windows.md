# Bounded reconciliation windows and rotating full audits

Refs #64. The protected pipeline can explicitly opt into recent overlapping
collection windows and rotating full audits. It uses the existing continuous
worker, collection receipts and durable scan continuation. The policy is part of
the host's approved configuration; importing this module starts no source reads
or scheduler.

## Configuration and admission

Add the following exact optional object to an independently approved pipeline
configuration. These values illustrate the shape; they do not activate a host or
choose a production schedule.

```js
reconciliation: {
  lookbackMs: 86400000,
  overlapMs: 60000,
  fullAuditsPerCycle: 2,
}
```

| Field | Accepted value | Meaning |
| --- | --- | --- |
| `lookbackMs` | Integer from 1,000 through 31 days in milliseconds | Maximum recent window selected for one cycle |
| `overlapMs` | Integer from 1,000 through `lookbackMs` | Re-read this interval before the last proven contiguous watermark |
| `fullAuditsPerCycle` | Integer from 1 through 1,200 | Maximum repository/family pairs receiving full traversal in a cycle |

An absent property preserves the original collector behavior. Explicit null,
unknown fields, strings, fractional values and out-of-range bounds are rejected.
The repository, family, installation, metric, publication, recognition and host
authorization checks remain required. There are at most 100 configured
repositories and 1,200 repository/family pairs.

Only `runOnce()` with an omitted cutoff, no dispatch operation and
`mode: "reconcile"` selects a scheduled plan. Explicit-cutoff callers, causal
webhook dispatch, and explicit audit/backfill modes retain their existing scan
identities and collection path. The worker's approved `--interval-ms` controls
when another batch runs; the reconciliation object does not create a timer.

## Selection and restart

The planner first selects the oldest completed full-audit pairs, with never-audited
pairs first. Repository ID and family name provide deterministic ties. A completed
full traversal with an unknown provider total still advances this rotation clock;
otherwise that pair could be selected forever and starve other families.

Each remaining recent-capable pair receives exactly one recent window. The current
recent families are `issues`, `comments`, `project_history` and `relationships`.
Pairs already selected for a full audit do not also receive a recent scan. Other
families are collected when their full-audit turn arrives.

For a proven contiguous watermark, the lower bound is the later of
`cutoff - lookbackMs` and `watermark - overlapMs`. Without a proven watermark it is
`cutoff - lookbackMs`. This bounds work after a long outage; it does not pretend the
omitted earlier interval was reconciled. Rotation eventually supplies another full
traversal, subject to authorization and successful source reads.

The continuation row and every selected `collection_runs` row commit in the same
SQL transaction before a source page is requested. The existing collection store
provides `startInTransaction` for this composition; standalone `start` keeps its
transaction-owning API. An interrupted insertion rolls back the entire new plan.

Scheduled run IDs use the reserved form
`rc1:<context digest>:<cycle UUID>:<ordinal>:<total>`. The context binds the complete
approved configuration, data mode, controls configuration revision, recognition
state and all current source generations. Every selected row retains its original
mode, exact millisecond bounds, generation and place in the plan. At most 1,201
rows are read when checking the 1,200-row limit.

On restart, the worker reloads those rows. It does not consult a later clock or
changed progress to select replacements. Missing, duplicate, malformed,
out-of-scope, incorrectly ordered or precision-losing rows fail closed. A source
generation or relevant configuration change selects a new authorized context;
it cannot resume the old plan under new authority. Publication keeps the existing
event/observation cutoff, expected-head and private confirmation fences.

## Source requests and immutable observations

GitHub's repository issue and issue-comment endpoints support updated-time
selection. The adapter requests ascending updated order and an outward-rounded
`since` boundary, then checks the exact lower bound on received objects. It
preserves pagination even when a page contributes no in-window objects. Current
state observed after the requested event cutoff remains current observation
evidence; it does not acquire a fabricated historical actor or transition time.

Typed Project and relationship history use GraphQL `timelineItems(since:)` while
enumerating the full approved parent inventory. The adapter filters actual event
timestamps to the exact saved interval. A cursor, timestamp or unsupported source
shape is not silently repaired. Other families do not receive an invented REST
updated-time filter.

Primary source contracts:

- [List repository issues](https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#list-repository-issues)
- [List repository issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments-for-a-repository)
- [GraphQL Issue and its timeline items](https://docs.github.com/en/graphql/reference/objects#issue)
- [GraphQL PullRequest and its timeline items](https://docs.github.com/en/graphql/reference/objects#pullrequest)

REST issue, pull-request, comment and release snapshots retain a versioned content
fingerprint plus scan identity. Hydration verifies the fields shared by the list
and object endpoints. A real content change is not lost merely because the
provider timestamp is unchanged, and a later return to an earlier value remains
an immutable new observation. Reserved malformed versions fail before a custom
verifier can authorize them. Unmarked legacy source revisions retain their
original interpretation.

Semantic reconciliation history compares adjacent retained observations within
the same repository, family, subject and access generation. Unchanged repeat
audits do not manufacture another history epoch. Actual edits and restorations
do; ambiguous same-time conflicting content fails closed. Committed observations
from a later failed scan remain part of the retained evidence. This does not
rename `changed_count`: that existing counter still counts inserted observations,
not semantic edits or credited actions.

## Coverage and diagnostics

Completed traversal and proven coverage have different requirements. Rotation and
the successful-sync clock require a valid terminal scan: complete state, no next
cursor, at least one retained page, coherent counts when known, and a finite
completion at or after the saved event bound and at or before observation time.
Unknown totals remain unknown.

A coverage baseline additionally requires an exact expected/item count for a
completed full audit. Completed recent intervals with exact counts can extend that
baseline only through an overlapping or touching chain. A later disjoint success
cannot jump an earlier gap. A later exact bridge or full audit can resolve it.
Future completions and sub-millisecond saved windows cannot be rounded into proof.

Frozen publication coverage, current public source health and protected operator
health use this same current-context progress reader. Repository summaries use the
oldest required family's verified watermark and successful observation clock; one
unknown family keeps the combined watermark unknown. A scope-specific health read
still binds the complete configured source-generation context. Final source and
configuration checks prevent an awaited read from authorizing stale progress.

The latest attempt remains visible independently of earlier successes. A failed
read is degraded or disconnected, a partial attempt is collecting, and a recent
completed window after a known gap remains unknown with reason
`reconciliation_gap`. A malformed newer completion cannot borrow an older
same-cutoff proof to claim quiet activity. A known complete empty window is distinct
from an unknown count, unknown baseline or unknown webhook state.

Every published coverage record remains `partial`, with unknown historical start
and `historical_capability_not_certified`. The opted-in producer adds explicit
baseline, gap, count or incomplete-scan reasons when applicable. A requested cutoff
is never substituted for a verified watermark. No new source history, webhook
connectivity, contributor identity or action time is inferred from an empty queue
or successful current-state scan.

## Retention boundary

The accepted ingestion eraser deletes only its selected enrichment jobs,
collection-item references and source facts after a permanent repository fence.
The derived-retirement API deletes only its closed set of owned pipeline and
SQLite payload stages. Neither production API deletes `collection_runs` or
`collection_pages`; this includes completed empty plan rows that have no source
fact referring to them. Normal worker retirement deletes only its exact pending
continuation token after confirmation or supersession.

The plan therefore uses existing retained metadata and introduces no new deletion
authority, retention duration, migration fingerprint or receipt kind. A future
metadata-pruning policy must explicitly preserve every active plan row and page,
including complete empty rows, until its exact cycle retires. Retained metadata
from a permanently retired source cannot supply current progress because the
reader requires a current public installation and matching source generation.
External checkpoint caches, backups and approved operating retention remain under
their separately documented ownership.

## Validation and operating limits

Focused source, plan, SQL progress, health and actual pipeline tests cover bounded
requests, immutable edits/restorations, atomic materialization, database/runtime
restart, pagination, unknown-count rotation, gaps and authorization changes. The
synthetic omitted-webhook path exercises normal collection and publication without
inserting a delivery or inventing an action actor. PGlite execution does not claim
independent PostgreSQL connection behavior or production deployment.

Issue #64 requires recovery of an omitted webhook and no guessed actor attribution.
The synthetic pipeline exercise provides bounded evidence for those written
criteria; final issue reconciliation also considers the linked prerequisites and
reviewed evidence.

Live source permissions, an approved host and schedule, operating ownership,
provider capability evidence and a deployed omitted-webhook recovery observation
remain separate operating and release limits. This implementation does not close
those external gates or the separate full-duration validation.
