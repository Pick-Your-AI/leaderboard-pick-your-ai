# Public GitHub comment inventory and hydration

This implementation addresses the comment-source portion of leaderboard issue #59. It does not establish a complete historical baseline for every source family or close the issue's other baseline and validation criteria.

## Native source identities

The GitHub REST issue-comment inventory includes comments on both issues and pull requests. Inline pull-request review comments use a separate repository-wide inventory. The adapter reads both complete bounded inventories before returning a combined exact observed count:

| Native collection                 | Repository endpoint                         | Exact hydration endpoint                                 | Retained neutral kind                                            |
| --------------------------------- | ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Issue or PR conversation comments | `GET /repos/{owner}/{repo}/issues/comments` | `GET /repos/{owner}/{repo}/issues/comments/{comment_id}` | Existing issue semantics, or `pull_request_conversation_comment` |
| Inline PR review comments         | `GET /repos/{owner}/{repo}/pulls/comments`  | `GET /repos/{owner}/{repo}/pulls/comments/{comment_id}`  | `pull_request_review_comment`                                    |

Both inventories follow the existing read client's pagination, authorization, retry and bounded checkpoint rules. A recent window supplies the same outward one-second `since` overlap to both endpoints. Current objects newer than the event cutoff remain current observations; they are not invented historical transitions. An unread/failed inline page cannot establish a complete combined count. The total remains bounded at 10,000 objects, and duplicate native node identities fail closed.

PR comment hydration requires the native numeric comment ID, opaque node ID, exact self URL, full anchored HTML URL and native issue/PR parent link to agree. Supplied `_links` must agree too. Numeric IDs from separate comment types are not conflated. Modern `issuecomment-`, `discussion_r` and `r` anchors are recognized; an ambiguous or unsupported anchor remains unhydrated. This public GitHub adapter does not invent an enterprise-host mapping.

A PR comment produces a neutral current-state observation with its exact comment URL, distinct action and native artifact identity. Its actor and occurrence time remain unknown because a current resource does not prove an observed comment event. A known native author can be retained as source identity, but no `issue_answers`, submitted-review unit, participation or accepted evidence is emitted. Existing ordinary issue-comment pending-answer semantics are unchanged. Body text contributes only to the immutable content fingerprint and is not copied into the public normalized observation.

New inline fingerprints use the explicit `gh-rest-comment-v2` marker and bind supplied native review/thread/commit/location dependencies. Missing, null and values remain distinct. Every retained `gh-rest-v1` marker preserves its exact original projection and verification, including custom inline observations; ordinary issue and PR-conversation comments continue to use v1. The history reader admits the new marker only for comments, keeps the first version transition distinct, and counts later content changes/restorations without counting repeated equal observations as edits. Unsupported versions and families fail closed. New immutable observation keys prevent a prior empty PR-comment normalization from silently masking new hydration.

## Durable inventory compatibility

An expanded comments inventory has a different coverage meaning. The default adapter therefore adds `github-comments-inventory/v2` to the existing scheduled context hash only when the selected source is the default adapter and comments are configured. The scan key remains unchanged. The existing serialized continuation claim replaces an old context's pending token; the new reconciliation context cannot inherit an old issue-comment-only full-audit baseline. Custom providers and configurations without comments retain their prior context bytes.

For explicit-cutoff, dispatch and non-plan default comments collection, the original logical run ID is computed exactly as before. Inside one database transaction, upgraded callers lock that logical operation and choose an already materialized `gc2:<original ID>` run, otherwise the original retained run, otherwise a new `gc2:` run. The existing collection-start guard validates the full repository/family/mode/since/until tuple and source admission. A conflicting or failed old run is never bypassed by creating a new run. Once v2 exists, its choice remains pinned on retries even if a legacy row later appears.

An existing old run keeps its original ID, expected count, cursor, items, state and inventory. A completed run performs no new comment reads. A pending old run continues reading only issue/conversation comments. This preserves frozen operation cutoffs and source generations; it does not recollect a historical operation under newer source state. New versioned runs read both inventories and use immutable REST observation revisions. Inventory selection comes from the captured durable run identity rather than current policy. The standalone adapter keeps its previous issue-comment-only default; the default pipeline supplies the explicit versioned inventory selector. The existing eight-field invocation snapshot, source-access gates, immutable facts and page transaction guards remain in force.

The additional advisory lock coordinates upgraded callers. It is not a claim that simultaneously running unmodified old binaries participate in that lock. Deployment coordination for mixed binary versions remains the host's responsibility. No schema, retention authority, source fact rewrite or historic receipt rewrite is introduced.

## Evidence and remaining boundaries

Focused synthetic tests cover real client pagination, count failure, strict hydration, immutable edits, neutral credit, and real PGlite collection/continuation compatibility. They distinguish known source timestamps from observation and event cutoffs. Original failing controls and later successful executions are retained separately by the delivery review.

The bounded inventories can count only currently returned accessible objects. Deleted, hidden or inaccessible past comments do not become verified absent events. This work does not assert full PR review fanout, edit history, all-source baseline completeness, production coverage or live actor credit. Those remain subject to the literal issue #59 criteria and their existing owners.

Official API references:

- [Issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28).
- [Pull request review comments](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28).

The project retains its existing `2022-11-28` request-version pin.
