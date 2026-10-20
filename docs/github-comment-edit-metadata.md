# GitHub comment and review edit metadata

This reader provides bounded edit-history metadata for an already-bound public GitHub comment or submitted review. It contributes to [inventory and backfill issue #59](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/59). It does not enumerate comments or enable a production source. The existing [Issue and PullRequest content-edit inventory](github-content-edit-metadata.md), its collection format and saved runs remain unchanged.

## Supported native targets

`readGithubCommentEditMetadata` accepts one exact target from the caller's authorized inventory:

| Target kind                         | Native GraphQL type        | Required native parent | Publication boundary                                                                                           |
| ----------------------------------- | -------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `issue_comment`                     | `IssueComment`             | Issue                  | Non-null `publishedAt`; native `pullRequest` is explicitly null                                                |
| `pull_request_conversation_comment` | `IssueComment`             | PullRequest            | Non-null `publishedAt`                                                                                         |
| `pull_request_review`               | `PullRequestReview`        | PullRequest            | Non-null `publishedAt` and `submittedAt`; state is `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED` |
| `pull_request_review_comment`       | `PullRequestReviewComment` | PullRequest            | Non-null `publishedAt`; state is `SUBMITTED`                                                                   |

The caller supplies the configured repository database ID and slug, target node ID and native URL, and parent kind, node ID, number and native URL. The reader requires exact agreement with the returned native target and parent. Both native objects must identify the same configured public repository. Missing objects, a private repository, pending reviews, unpublished comments and substituted parents fail the read.

The native URL must match its parent and a supported comment or review fragment. Decimal fragment identifiers are retained as text, including values larger than JavaScript's safe integer range. The helper does not derive a native node ID from a URL, infer the parent from a comment author, or treat a supplied identifier as permission.

## Metadata and publication

The query selects only native identity, repository/parent binding, publication state, `includesCreatedEdit`, `UserContentEdit` metadata and page information. It does not request body text, diffs, rendered content, title, login, email, author identity or author association. Extra provider response fields are not copied into saved pages or the result.

Each edit retains its native ID, creation/edit/update timestamps, nullable editor, nullable deletion timestamp and nullable deleter. User and Bot editors retain native identity; other native actor types remain explicitly unknown. Deletion time and deleter identity remain independent, and an unknown editor is never replaced by the comment's author. These edit fields use the same closed parser as the existing Issue/PullRequest reader.

The result has version `github-comment-edit-metadata/v1` and includes the exact repository, target, publication metadata and creation flag. Its history is either:

- `available`, with an exact retained total and validated records, including an explicitly empty array; or
- `unavailable`, with null total and null records for an explicitly null connection.

Missing connections, null edit nodes, malformed actors or timestamps, GraphQL errors and inconsistent totals fail the read. They do not become a successful empty history. Timestamps use a valid UTC calendar with at most millisecond precision and are normalized to canonical milliseconds without rounding. Records have deterministic native-ID order, which does not assert chronological order. The creation flag does not identify a particular record or justify subtracting a record from the provider count.

## Authorization, paging and recovery

The reader requires an explicit synchronous `assertAuthorized(): void` callback. Absence, a thrown denial, a non-void result or an asynchronous callback rejects access. A rejected native Promise returned by an accidental asynchronous guard is observed before the read fails, so it cannot escape as an unhandled rejection. The callback selects no format and grants no new repository authority; the caller must check its current host and repository policy.

The helper captures and copies the repository, target, source, scan ID and limits before the first await. It uses the repository-scoped `GithubReadClient`, passes the current authorization check through its read and checkpoint boundaries, and checks again before returning the complete result. Existing repository retirement controls still apply.

Every target has an independent `comment-edits:metadata-v1` checkpoint namespace bound to its exact repository, source, scan ID and target. Each saved item is a closed page envelope with the native binding, publication metadata, creation flag, availability, retained total and cursor state. Even completed saved pages are parsed and revalidated after loading. Interrupted reads resume the same target's saved cursor after reopening the checkpoint store.

| Bound                      | Allowed values        |
| -------------------------- | --------------------- |
| GraphQL page size, `first` | 1–100; default 100    |
| Page count, `maxPages`     | 1–10,000; default 100 |
| Retained edits, `maxEdits` | 0–100; default 100    |

Existing checkpoint byte limits also apply. Every page must retain the same repository, target, publication state, creation flag, availability and total. The reader rejects duplicate edit IDs, repeated cursors, missing intermediate pages, inconsistent terminal pages and a final count that does not equal the retained records. A budget failure does not return a truncated successful result. A failed or inconsistent checkpoint is not silently refreshed into a different observation.

These bounds concern the available native connection. GitHub's retained history does not establish every edit that ever happened, and access-time metadata cannot reconstruct a historical cutoff. An unavailable history or a redacted edit does not establish deletion of its comment, review or parent.

## Revision and integration boundary

`parseGithubCommentEditMetadata` validates and copies the closed DTO. `githubCommentEditRevision` returns `gh-content-edit-comment-v1:<semantic digest>.<scan digest>`. The semantic digest includes the exact target, parent, repository, publication fields and all selected edit metadata. Distinct scan IDs distinguish separate observations, including an A-to-B-to-A sequence at unchanged provider timestamps. Callers must supply the appropriate immutable scan identity.

`verifyGithubCommentEditRevision` validates the complete revision shape and recomputes the semantic digest. It does not authenticate provider data, prove access, or establish that an arbitrary scan suffix names an authorized collection. Other revision families and additional fields are rejected.

The new prefix lies within the existing collection boundary's reserved `gh-content-edit-*` namespace. The current Issue/PullRequest collection parser does not accept this new format, so a caller cannot silently persist it through the legacy fallback. This change adds no source selection, admission policy, inventory traversal, collection DTO, normalization or public contribution. Existing `gh-content-edit-v1`, REST comment revisions and saved source contexts keep their existing behavior.

A later integration must enumerate authorized published targets, preserve their exact native relationships, introduce an explicit versioned collection/admission contract, retain neutral private metadata, and account for saved-run and checkpoint compatibility. A valid edit timestamp or editor ID must not become contribution evidence merely because this reader returned it.

## Verification and remaining acceptance

The [focused reader tests](../packages/github/test/comment-edit-history.test.mjs) use the real `GithubReadClient` and `FileCheckpointStore` with [synthetic native responses](../tests/fixtures/comment-edit-metadata.mjs). They cover all four target kinds, submitted-state admission, exact native bindings, unknown and empty histories, interrupted paging and reopen, completed-cache validation, input capture, current authorization loss, repository retirement, bounds, malformed metadata and revision isolation. The existing Issue/PullRequest reader and normalizer suites protect the shared parser extraction.

Synthetic tests do not establish a GitHub App installation's actual GraphQL capabilities, complete historical coverage, production inventory/hydration, or full #59 acceptance. Those requirements remain separately tracked.

Primary references:

- [IssueComment and Issue schema](https://docs.github.com/en/graphql/reference/issues)
- [PullRequest, PullRequestReview and PullRequestReviewComment schema](https://docs.github.com/en/graphql/reference/pulls)
- [UserContentEdit and Actor schema](https://docs.github.com/en/graphql/reference/users)
- [GitHub edit-history retention and redaction](https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment)
