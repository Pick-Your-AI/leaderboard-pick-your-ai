# Resumable issue publication

This is the bounded publication/reconciliation implementation for [LB-02.02 (#29)](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/29).
The [delivery baseline](../planning/project-backlog.json) defines stable LB IDs;
[PUBLICATION.json](PUBLICATION.json) records their already-published issue URLs.
GitHub remains authoritative for progress and ownership. These receipts do not
authorize publishing, replacing content, changing ownership, or changing a Project.

## Current real verification

The latest [issue-specific acceptance record](publication-acceptance-20261018.md)
and [native readback](publication-readback-20261018T035627.json) were completed at
03:56:27 UTC on 2026-10-18. Exhaustive all-state issue reads (100, 78, and 0 source
rows) and 133 separate native-parent reads confirm 133 unique planned issues and
all 132 intended edges. Two planner executions returned the same zero-action
result. Eleven issues were already closed; their progress was preserved.

### Earlier independent readback

The [sanitized read-only receipt](publication-readback-20261018.json) records an
actual connected-GitHub read on 2026-10-18, completed at 00:36:45 UTC:

- Five REST issue-list pages were read in creation order with `state=all`, including
  a terminal empty page. The source pages contained 50, 50, 50, 6, and 0 rows;
  pull requests were excluded, leaving 133 issues.
- All 133 issue bodies had exactly one unique expected LB marker. Historical
  publication URLs matched the current issue numbers and immutable GitHub IDs
  were captured. Titles were not used as primary identity.
- All 133 native-parent endpoints were read. The root returned the explicit
  `No parent issue found` response; all 132 other issues had their intended parent.
  The root is the intentional exception to “one parent per issue.”
- Running the planner against those reads returned `actions: []`, `noop: true`.
  A second run returned the same result. The observed issues included 126 open
  and 7 closed issues. No issue or relationship was created, edited, or deleted.

The receipt contains only IDs, parent numbers, states, body hashes and summary
hashes, with no raw API payload, account details or credentials. It is a historical
observation, not a substitute for fresh reads before any later publication.
Sequential reads are not an atomic snapshot. Project fields, blocker edges,
issue types and runtime release acceptance are outside this verification.
This does not supersede the separate historical publication audit in
[PUBLICATION.json](PUBLICATION.json).

## Offline dry run

Python's standard library is sufficient; no GitHub CLI, token, network client or
mutation switch is included:

```bash
python scripts/publish_plan.py --inventory /path/to/captured-inventory.json
python -m unittest discover -s tests -p test_publish_plan.py -v
```

The CLI only reads local files and writes a plan to stdout. `--backlog` and
`--publication` can select reviewed alternate input files. There is no `--apply`.
The versioned receipt intentionally omits issue bodies and is not an inventory
input. Do not reconstruct bodies from hashes or present reconstructed data as a
live read. Raw reads should remain in temporary/private working storage.

An inventory has this shape (all example values below are synthetic):

```json
{
  "repository_url": "https://github.com/synthetic/publication-test",
  "state": "all",
  "pages": [
    {
      "cursor": null,
      "next_cursor": null,
      "source_count": 1,
      "issues": [{
        "number": 1,
        "id": 1001,
        "title": "Synthetic program",
        "body": "<!-- pick-your-ai-leaderboard-plan:LB -->",
        "parent_number": null,
        "parent_readback": true,
        "state": "open"
      }]
    }
  ]
}
```

The adapter supplies cursors from the actual pagination protocol, starting with
null and terminating with an explicit null `next_cursor`. Every page must be
present and linked; the source's exhaustion signal must be observed. For the REST
read above, page numbers were used as cursors and an empty page proved exhaustion.
`source_count` includes PR rows before filtering. The collection helper rejects
cursor loops and limits reads to 100 pages and 10,000 issues. It is the connected
adapter's responsibility to use an exhaustive repository issue-list endpoint,
include closed issues, and read native parents. A capped search response is not
complete inventory. Missing permissions, rate limits, timeouts and general 404s
must not be interpreted as an absent issue/parent; only an explicit native-parent
absence response establishes `parent_number: null`.

## Authorized adapter boundary

`publish(specs, repository_url, adapter, journal)` defaults to `dry_run=True`.
An authorized connected-integration host may explicitly select `dry_run=False`.
There is deliberately no standalone credential flow or bundled live mutation
adapter. The injected adapter has only three operations:

1. `inventory()` returns a fresh exhaustive inventory, including native-parent
   readback for every planned issue. It must not use a stale search index/cache.
2. `create_issue(payload)` creates one new issue using the exact rendered title,
   identity marker, body/checklists, labels and native issue type. The host maps
   the issue type through its supported connected integration. No implicit retry
   of a timeout or ambiguous response is permitted.
3. `attach_parent(child_number, parent_number, replace=False)` attaches a native
   parent only when absent and must atomically refuse a different existing parent.
   A provider without no-reparent semantics is not a valid apply adapter.

There is no edit/delete/assign/close/Project-field operation. Existing bodies,
titles, labels, issue types, assignees, checked tasks, native blockers and progress
are not reconciled to the original baseline. The engine only proposes missing
issues and missing native parents, and stops on conflicting existing parents.
The creation renderer includes all small task steps as checklists, not additional
issues or duplicate native-child checklists. Readiness never gates publication:
new text explicitly starts Backlog and unassigned, even with unresolved decisions.
Project membership/field initialization is separate work; this engine does not
claim that rendering the word Backlog sets a GitHub Project field. Existing
Project fields are preserved because no Project writes occur.

## Durable receipts and recovery

Use one private journal path shared by **all cooperating publishers for this
repository**. Applying requires POSIX advisory locking (`fcntl`); planning remains
platform independent. The journal binds the repository and exact plan fingerprint
to observed issue numbers and immutable IDs. Writes use a same-directory temporary
file, file `fsync`, atomic replacement and directory `fsync`. The OS releases the
lock if a process crashes. Do not commit live journals or raw inventory payloads.

Every operation follows this sequence:

1. Acquire the journal lock; load and validate receipts. Obtain a fresh complete
   inventory, reconcile stable markers, and validate recorded IDs/native parents.
2. Save observed identity bindings and a durable pending intent **before** the
   remote mutation. If persistence fails, do not make the remote call.
3. Make one remote call. Ignore its response as proof of final state; read a fresh
   complete inventory and native parents, then save the confirmed bindings and
   clear the pending intent.
4. Repeat up to `max_mutations` (20 by default, maximum 1,000). A budget stop leaves
   confirmed receipts and remaining actions, which can be resumed with the same
   journal. All existing issues and relationships produce zero further calls.

If a create succeeded but its response or receipt write was lost, the next run
adopts the uniquely marked existing issue. If a parent attach succeeded but its
receipt write was lost, the next run confirms the existing edge and does not add
it again. If the outcome is still absent, the intent remains pending and the
engine raises `UncertainAction`: it never treats absence after a timeout as safe
permission to create again. Investigate through the connected integration; wait
for definitive readback or obtain explicit evidence of non-execution before an
authorized operator repairs the journal. Do not delete receipts to force a retry.

Duplicate/malformed/unknown markers, a planned title whose marker disappeared,
changed or missing recorded identity, incomplete pagination, unknown native
parents, parent conflicts, receipt corruption and plan drift all fail closed.
Pending intents must have exactly their operation's defined fields; extra fields
cannot suppress an uncertain operation. Clearing a parent intent requires positive
native-edge readback. Supplied and durable issue numbers and immutable IDs must
agree before their constraints are combined.
Resolve the underlying ambiguity explicitly; the publisher never guesses a
replacement issue or takes over unrelated work.

GitHub issue creation has no server-side stable-LB-id uniqueness constraint. The
shared journal lock serializes this publisher, but cannot guarantee exactly-once
behavior against an independent concurrent publisher using a different journal
or a manual creator racing the read/create interval. Coordinate a single writer
for publication. If another writer creates a duplicate, readback fails closed
instead of quietly choosing an issue. This limitation is distinct from concurrent
unrelated body/progress edits, which are preserved without any writeback.

## Evidence boundary

`tests/test_publish_plan.py` uses only an in-memory synthetic adapter and temporary
journals. It exercises interrupted creates and parent attachments, persistence
failure, partial/budgeted resume, repeated no-op publication, exclusive locking,
pagination failure, duplicate/ambiguous identity, closed issues, receipt drift,
conflicting parents and concurrent unrelated edits. Synthetic runs do not claim
that a live failure was induced. The actual production-repository verification is
the separate read-only receipt linked above. No destructive or duplicate-producing
live drill is necessary to verify the already-published issue tree.
