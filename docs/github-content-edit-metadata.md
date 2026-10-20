# GitHub content-edit metadata

This reader provides bounded metadata for the available edit histories of native Issues and PullRequests. It contributes to [the inventory and backfill work package](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/59). Native issue-field timeline events remain a separate source capability.

The separate [comment and review edit reader](github-comment-edit-metadata.md) reads already-bound published comment/review targets. The [expanded inventory](github-comment-edit-inventory.md) adds those targets to new admitted default-source audits and backfills. Its distinct metadata and checkpoint versions preserve this parent DTO and previously selected parent-only runs.

The default source connects the [GitHub metadata reader](../packages/github/src/content-edit-history.ts), [private inventory selector](../apps/pipeline/src/content-edit-inventory.mjs), collection boundary and normalizer. An approved configuration can include `content_edits` for an explicitly admitted full audit or backfill. The resulting private parent snapshots carry native edit metadata without producing metric evidence. Source approval and actual provider capability remain separate requirements.

## Native metadata contract

The reader selects repository database identity and public visibility, parent node ID, parent kind, number, native URL and `includesCreatedEdit`. A parent is either an Issue under `/issues/<number>` or a PullRequest under `/pull/<number>` in the configured repository. It rejects missing, foreign, private or changed native bindings.

Each available `UserContentEdit` contains its native ID, `createdAt`, `editedAt`, `updatedAt`, nullable editor, nullable deletion timestamp and nullable deleter. These nullable fields remain independent. A known deletion timestamp does not imply a known deleter, and an unknown editor is never replaced by the parent author.

The GraphQL Actor interface does not supply a common node ID. The query selects `__typename` and explicit User/Bot identity fragments. User and Bot identities retain their native node ID and nullable database ID; other actor types retain only an explicit unknown kind and native typename. Login, email and author-association fields are not selected.

Dates use a valid UTC calendar with at most millisecond precision and are represented in canonical milliseconds. Unsupported precision is rejected without rounding. The reader does not impose an undocumented ordering between the three native timestamps. Records are returned in native-ID order for deterministic identity, which is not a claim of chronological ordering. `includesCreatedEdit` remains a parent flag; the reader does not infer which record represents creation or subtract a record from the source total.

The closed metadata DTO retains either:

- `available`: an exact retained connection count and its validated metadata records, including an explicitly empty array;
- `unavailable`: a null count and null records for an explicitly null connection.

Missing fields, null nodes, GraphQL errors and inconsistent counts fail the scan. They are not transformed into a successful empty history. An unavailable history or redacted edit does not establish deletion of its parent.

## Collection and checkpoints

`readGithubContentEditParents` traverses the separate Issue and PullRequest parent connections and then every selected parent history before returning any snapshots. Its `parentTotals` reports Issue and PullRequest counts separately. Its `snapshots` contains one metadata snapshot per native parent. Parent counts and edit counts have different units.

`readGithubContentEditMetadata` reads one already-bound parent for a later metadata-only hydration step. Both entry points capture source, repository, scan, paging and authorization options before their first await. They reuse the existing repository-scoped `GithubReadClient` and checkpoint retirement controls.

Parent and child connections have independent cursors and versioned checkpoint keys. Each selected checkpoint item is a closed page envelope, retaining identity, availability, count, creation flag and page information even when a connection is empty or null. The query does not select body, diff, rendered text, title or relationship content; unselected response extras are not copied into retained page envelopes.

After the existing scanner returns, the reader revalidates every retained envelope, including completed checkpoints whose selection callback did not run again. Page sequence, native identities, stable counts, stable creation flags and unique edit IDs must still agree. Interrupted child scans resume their own saved cursor after reopening the checkpoint store. A failed or inconsistent checkpoint is not silently refreshed into a different observation.

The explicit bounds are:

| Bound                                                |                                   Maximum |
| ---------------------------------------------------- | ----------------------------------------: |
| Issue plus PullRequest parents                       |                                    10,000 |
| Retained edits across all available parent histories |                                    10,000 |
| Retained edits for one parent                        |                                       100 |
| GraphQL page size                                    |                                       100 |
| Page count per connection                            | Configured positive bound, at most 10,000 |

Callers can choose smaller parent/edit budgets. Existing checkpoint byte limits also apply. A bound failure retains the checkpoint and produces no successful truncated inventory. Duplicate native parent IDs/numbers and edit IDs across different parents are rejected.

GitHub retains a bounded edit history; a successful traversal proves the available connection totals, not every edit that ever existed. The adapter returns `expectedCount: null`, and the collection boundary rejects finite counts on pages containing this typed metadata. A count of parent snapshots cannot become proven edit-history coverage. Metadata is observed at access time and does not reconstruct a run's historical cutoff. Access time, fixed run cutoff and unknown earliest coverage remain distinct in the collection record.

## Revision and neutral-use boundary

`parseGithubContentEditMetadata` validates and copies the closed DTO. `githubContentEditRevision` produces a separate `gh-content-edit-v1:<metadata digest>.<scan digest>` revision. Its semantic digest includes the native parent and every selected nullable metadata field. The observation suffix distinguishes separate scans, including an A-to-B-to-A sequence at unchanged provider times.

`verifyGithubContentEditRevision` accepts only this complete revision shape and matching metadata. It does not reinterpret `gh-rest-v1`, `gh-rest-comment-v2` or an old custom revision. Existing REST fingerprint, comment revision and SQL history code remain unchanged.

The integration retains neutral current-state metadata. A parent snapshot has `evidence: "current_state"`, `state: "present"`, and null `actorId` and `occurredAt`. Native editor identities and edit timestamps remain inside the private metadata DTO. They do not become a body-edit, answer, review, relationship or other contribution, and a redacted edit or unavailable connection cannot suppress its parent.

The collection boundary validates the closed metadata and its semantic revision, binds its parent ID and URL to the fact, and copies the validated data before the first SQL write await. Extra body/diff fields and field-history or Project aliases are rejected. The existing 128-character stored subject/revision limits remain in force; the reader's wider native identity bound does not widen those collection limits. A captured reserved `gh-content-edit-*` revision without valid metadata cannot fall through to legacy persistence. Ordinary legacy content-edit facts retain their existing contract.

Before creating a normalization, the default normalizer captures the exact collected parent and revision, reads only that parent's native metadata, and verifies the semantic revision again. Successful hydration returns `content_edit_metadata_only` with empty contribution, actor, evidence, participation and assistance collections. It never forwards edit metadata into those public evidence fields. A completed saved run can reuse its unchanged private normalization; replay does not silently refresh the immutable observation. Repository access, source generation and current configuration checks still apply.

## Run selection and saved plans

The parent-only context helper retains `github-content-edits/metadata-v1`. The current default runtime explicitly requests `github-content-edits/metadata-v2`, which includes the [comment/review inventory](github-comment-edit-inventory.md). Both compose after the unchanged comments context; a disabled or custom-source context returns its original object. A context change uses the existing durable-cycle supersession mechanism rather than reusing old history coverage.

For an ordinary logical run, `startGithubContentEditRun` checks retained legacy, `gce1:` and `gce2:` identities in one transaction. Expanded selection prefers an existing `gce2:` row, then an existing `gce1:` row, then an existing legacy operation, otherwise a new `gce2:` run. Parent-only selection preserves its original `gce1:`/legacy preference and refuses a logical run already selected as `gce2:`. The existing CollectionStore validates the full tuple. Completed, pending, failed and conflicting old runs are not reset or bypassed. A pending old operation remains outside capabilities that its saved format did not select.

Both current selector modes take the same logical `gce1:` advisory lock before reading candidate IDs, without taking a collection-row update lock ahead of the repository gate. Existing generation and late host-authorization checks remain in force. An older deployed binary is not claimed to participate in this expanded selection protocol.

`createGithubContentEditAdmission` is a private selector for one serialized runtime operation. A versioned selection must be explicitly recorded. Scheduled requests must be seeded from the actual materialized or reloaded plan, with exact repository, context digest, cycle token, run ID, cutoff and audit tuple. A parseable `rc1` prefix alone grants no capability. Clear the transient admission at operation boundaries and reseed it from the saved plan on resume. These format-selection helpers never replace current repository or host authorization.

Only full `audit` and `backfill` requests with null `since` and a canonical millisecond UTC cutoff are supported. For example, a configured default pipeline can select `runOnce({ mode: "audit", cutoff })`. The family is not added to recent-window scanning. A scheduled plan may use it only in its actual full-audit selection; an unplanned default reconciliation is rejected before metadata I/O or new content-run materialization. The runtime does not relabel a reconciliation request as an audit.

The standalone adapter requires the explicit synchronous `includeContentEditMetadata(request)` callback, which must return a boolean. Its default is disabled. An additional synchronous `includeCommentEditMetadata(request)` callback defaults to false and selects expanded inventory only after the first callback admits the captured request. The pipeline derives both decisions from the current saved selection or plan and clears transient admission at operation boundaries. Invalid native Promise results are observed before the post-callback authorization check, then rejected without awaiting them or invoking arbitrary thenables. These callbacks select formats; they do not grant repository access or replace live authorization.

## Focused verification and remaining acceptance

The [reader tests](../packages/github/test/content-edit-history.test.mjs) use the real read client and FileCheckpointStore with [synthetic GraphQL responses](../tests/fixtures/content-edit-metadata.mjs). They cover nested paging/restart, exact totals, native identity, null/redacted metadata, query minimization, bounds, cached-page tampering, authorization loss and revision changes.

The [inventory tests](../apps/pipeline/test/content-edit-inventory.test.mjs) use the real CollectionStore, ScanContinuationStore and reconciliation plan/progress helpers on PGlite. They cover retained old tuples, new namespace preference, rollback, lock ordering, generation fences, context separation and exact materialized-plan admission/resume.

The [source tests](../apps/pipeline/test/content-edit-source.test.mjs) and [normalizer tests](../packages/github/test/content-edit-normalizer.test.mjs) exercise the real read client, admission checks, captured inputs, source errors, live denial and neutral hydration. The [private DTO tests](../apps/pipeline/test/content-edit-metadata-parity.test.mjs) compare canonical bytes with the reader, while the [collection tests](../packages/ingestion/test/content-edit-collection.test.mjs) exercise page atomicity, malformed metadata, immutable revisions, physical database reopen and the existing generation and host fences.

The [runtime tests](../apps/pipeline/test/content-edit-runtime.test.mjs) run actual synthetic collection, normalization and publication beside the `gc2` comments inventory. They cover a saved failed `rc1` audit across database reopen, unknown coverage, completed/pending/failed legacy operations, configuration withdrawal and custom-source context preservation. These local PGlite and SQLite tests do not establish independent-connection PostgreSQL concurrency or provider permission.

The approved GitHub App permission and canary work remains external to these synthetic tests. No live GraphQL request, body-edit metric, complete historical coverage or full #59 acceptance is established here.

Primary references:

- [UserContentEdit and Actor schema](https://docs.github.com/en/graphql/reference/users)
- [Issue schema](https://docs.github.com/en/graphql/reference/issues)
- [PullRequest schema](https://docs.github.com/en/graphql/reference/pulls)
- [GitHub edit-history retention and redaction](https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment)
