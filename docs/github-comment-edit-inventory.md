# GitHub comment and review edit inventory

An approved default pipeline can include published comment and submitted review edit metadata in a full `content_edits` audit or backfill. The [inventory reader](../packages/github/src/comment-edit-inventory.ts) completes native target enumeration and every available edit-history read before returning an observation page. Collection and hydration retain private, neutral metadata. They produce no contribution credit and make no claim of complete lifetime history.

This implements part of [inventory and backfill issue #59](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/59). Actual GitHub App capability, deployment, source-total reconciliation across allowed repositories and earliest proven coverage remain separate acceptance requirements.

## Native inventory and publication

The reader first reuses the complete [Issue/PullRequest parent inventory](github-content-edit-metadata.md), including its unchanged metadata and checkpoints. For each parent it then traverses these independent connections:

| Parent or container | Connection | Included observations |
| --- | --- | --- |
| Issue | `comments` | Published issue comments |
| PullRequest | `comments` | Published PR conversation comments |
| PullRequest | `reviews`, filtered to submitted states | Reviews in `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED` state |
| PullRequest | `reviewThreads` | Validated review-thread identities, used as containers |
| Each review thread | `comments` | Published inline comments in `SUBMITTED` state |

Every container and target must match its native type, node ID, configured public repository and exact parent. The parent binding includes kind, node ID, number and native URL. Comment/review URLs must match the supported fragment under that parent. Submitted reviews require both publication and submission timestamps. Missing connections, private or substituted objects, malformed publication states and inconsistent counts fail the inventory.

Inline comments are enumerated through review threads. The GraphQL schema allows their `pullRequestReview` relationship to be null; this implementation does not invent or require an associated review ID. A thread's exact PullRequest and public-repository binding remains mandatory.

A valid inline comment in `PENDING` state with null `publishedAt` is counted as an excluded pending object. Its native identity and parent are checked at selection, but its history is never requested and no comment metadata snapshot is returned. The retained inventory page stores only a domain-separated identity digest for that excluded object, together with the containing connection's public binding. It does not retain the pending comment's ID, URL or text. This stable private digest supports whole-inventory duplicate and count checks after restart; it is not an anonymity claim.

The query selects no body, rendered text, diff, title, login, email or inferred author. Extra response fields are not copied into checkpoints or observations. No source request changes upstream GitHub state.

## Complete results, counts and bounds

`readGithubCommentEditInventory` returns three fields:

- `parentTotals`: separate Issue and PullRequest totals.
- `targetTotals`: separate counts of published issue comments, PR conversation comments, submitted reviews, submitted inline comments, excluded pending inline comments and review threads.
- `snapshots`: unchanged parent metadata plus one [comment/review metadata DTO](github-comment-edit-metadata.md) for each included published target.

These counts have different units. Review threads are containers, pending comments are excluded identities, and snapshots are observations of targets. None is a count of all edits that ever happened. A native edit connection can be available and empty, available with retained records, or explicitly unavailable. Unavailable history and deleted/redacted edit metadata do not establish deletion of the target.

Each target connection has its own cursor sequence and closed `github-comment-edit-inventory-page/v1` envelope. The checkpoint namespace starts with `comment-edits:inventory-v1` and binds source, repository, immutable scan ID and exact connection selection. Parent checkpoints and target history checkpoints retain their existing separate namespaces. Cached and resumed pages are revalidated, including stable totals, native bindings, publication fields, entry kinds, cursor continuity and terminal counts.

| Option | Default | Accepted range | Unit |
| --- | ---: | ---: | --- |
| `first` | 100 | 1–100 | Nodes per native page |
| `maxPages` | 100 | 1–10,000 | Pages per connection |
| `maxObjects` | 10,000 | 1–10,000 | Parents plus all enumerated comment/review identities, including excluded pending comments |
| `maxThreads` | 10,000 | 0–10,000 | Review-thread containers |
| `maxEdits` | 10,000 | 0–10,000 | Retained edit IDs across parent and published target histories |

The existing limit of 100 retained edits per individual target and checkpoint byte limits also apply. Global object, thread and edit budgets are separate. Duplicate target identities across connections, duplicate threads and duplicate edit IDs across histories reject the scan. Retained pages are checked against the current invocation's smaller limits too.

All child target inventories finish before any child edit-history read. All parent and included child histories finish before the helper returns. A changed publication between inventory and history, an interrupted nested connection, malformed late history or exhausted budget cannot yield an earlier successful partial observation page. The source adapter applies its offset cursor only to this complete inventory, retaining `expectedCount: null` even when the number of current snapshots is known.

## Versioned selection and saved runs

The default runtime requests `github-content-edits/metadata-v2` in its scheduled source context. Standalone helpers keep their parent-only default unless the caller explicitly selects the expanded format. Disabled and custom sources preserve their original context object and receive no implicit admission.

For an ordinary logical run, the current selector reads legacy, `gce1:` and `gce2:` candidates under the same logical `gce1:` advisory lock. It preserves repository-before-collection lock order and lets CollectionStore validate the complete saved tuple.

| Retained selection | Expanded caller's result | Comment inventory admitted? |
| --- | --- | --- |
| Existing `gce2:` row | Reuse that exact row | Yes, for the exact admitted tuple |
| Existing `gce1:` row, no `gce2:` | Reuse that exact parent-only row | No |
| Existing legacy row, no versioned row | Reuse that exact legacy row | No |
| No retained row | Create `gce2:` for the captured logical operation | Yes |

This preference applies to complete, pending and failed rows. The selector neither resets a cursor nor allocates a second run to bypass an older selected format. A parent-only caller encountering an existing `gce2:` operation fails explicitly instead of creating a downgrade row. Tuple conflicts, repository-generation changes and late authorization failures retain the existing transaction safeguards.

Scheduled reconciliation uses the exact materialized or reopened `rc1` plan, including repository, context digest, cycle token, run ID, cutoff and audit tuple. A parseable run prefix grants no capability. The existing ScanContinuationStore supersedes a v1 context when a new v2 context is claimed; it leaves old rows and immutable observations intact and rejects the obsolete cycle's later freeze. The current operation reseeds transient admission from its actual saved plan and clears admission at its boundaries. PGlite tests verify these transitions and concurrent helper submissions; they do not establish independent-session PostgreSQL lock contention or compatibility with an older deployed binary.

Only full `audit` and `backfill` operations with null `since` and a canonical UTC millisecond cutoff are eligible. `content_edits` remains outside recent-window scanning. Source access time, the run's fixed cutoff and unknown earliest history are distinct; the implementation does not reconstruct past body state at a historical cutoff.

## Collection, hydration and authorization

Both metadata formats use the existing eight-field collection fact with `contentEditMetadata`. A comment/review fact binds `subjectId` and `sourceUrl` to its target, uses `gh-content-edit-comment-v1:<semantic digest>.<scan digest>`, and requires `current_state`, `present`, null actor and null occurrence time. The closed ingestion parser accepts plain data objects only, binds the metadata repository ID to the saved collection run, rejects extra fields/accessors/sparse arrays, and copies validated data before the first SQL write await. Existing stored identity/revision length limits remain unchanged.

The reserved `gh-content-edit-*` branch handles both supported versions explicitly. Missing DTOs, mismatched identities or unsupported versions cannot enter legacy persistence or hydration. Ordinary legacy facts and the v1 parent parser preserve their original contract.

The normalizer captures the selected repository, target, fact key and semantic revision before awaiting the native reader. It requires the explicit synchronous authorization guard, rechecks current authority after hydration, and verifies the fresh semantic revision. A changed target, parent, publication or history yields no verified metadata result. Successful hydration returns `content_edit_metadata_only` with empty contribution, actor, evidence, participation and assistance collections. Current source generation, configuration and repository-retirement checks remain in force.

The source adapter requires two synchronous boolean selectors: `includeContentEditMetadata` first admits the captured operation; `includeCommentEditMetadata` then selects expanded inventory. The second cannot bypass the first. Both receive frozen copies of the invocation's original tuple. Invalid native Promise results are observed immediately, before the following authorization check, so a simultaneous revocation cannot leave an unhandled rejection. They are never awaited as authorization decisions, and arbitrary thenable properties are not invoked.

## Verification and remaining acceptance

The synthetic tests exercise real readers, durable checkpoint stores, CollectionStore, ScanContinuationStore and the default runtime:

- [Inventory reader](../packages/github/test/comment-edit-inventory.test.mjs): every nested connection, null review association, pending exclusion, restart, stable identities/counts, malformed pages, authorization, budgets and duplicate detection.
- [Admission and run compatibility](../apps/pipeline/test/content-edit-inventory.test.mjs): exact retained legacy/v1/v2 rows, both concurrent selection orders, shared lock identity, rollback and actual scheduled-plan supersession/resume.
- [Source adapter](../apps/pipeline/test/comment-edit-source.test.mjs): all four published families, offset paging after complete traversal, interrupted scans, captured inputs, selector denial, rejected asynchronous policies and live revocation.
- [Collection](../packages/ingestion/test/comment-edit-collection.test.mjs) and [normalization](../packages/github/test/comment-edit-normalizer.test.mjs): closed DTO and revision boundaries, canonical byte parity, saved-repository binding, atomicity, physical reopen, publication/history changes and neutral hydration.
- [Default runtime](../apps/pipeline/test/content-edit-runtime.test.mjs): actual collection, hydration and neutral publication beside the separate comment source, retained complete/pending/failed parent-only runs, interrupted v2 schedules and configuration/source-generation withdrawal.

Synthetic observations are not live source evidence. The configured App still needs demonstrated access to these native connections, and a successful bounded inventory does not establish earliest lifetime coverage or full #59 acceptance. No public recognition is derived from these edit metadata snapshots.

Primary references:

- [IssueComment and Issue schema](https://docs.github.com/en/graphql/reference/issues)
- [PullRequest, review and review-thread schema](https://docs.github.com/en/graphql/reference/pulls)
- [UserContentEdit and Actor schema](https://docs.github.com/en/graphql/reference/users)
- [GitHub edit-history retention and redaction](https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment)
