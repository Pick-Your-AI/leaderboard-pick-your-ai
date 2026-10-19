# Explicit GitHub metadata provider

`createGithubEnrichmentSource` in [github-enrichment-source.mjs](../apps/pipeline/src/github-enrichment-source.mjs) implements the existing private `EnrichmentSource.readMetadata` interface for immutable commits, exactly observed merged pull requests, and individual submitted reviews. It is a provider for the [asynchronous metadata worker](metadata-enrichment.md). Importing it installs no worker, changes no source or policy, and exposes no public route.

The module returns six fields: the original `sourceRevision`, an explicitly reviewed `acceptedOutcome`, nullable `reviewState`, and nullable `additions`, `deletions`, and `changedFiles`. Metadata classification remains separate from contribution observations, recognition, normalization, and publication. A merged or closed GitHub artifact does not establish an accepted outcome.

## Host composition and authority

The factory accepts this explicit configuration:

```js
createGithubEnrichmentSource({
  client, // Existing GithubReadClient with approved credentials/checkpoints.
  sourceId, // Existing source/quota label; not proof of installation rights.
  policyVersion, // The host's declared metadata decision policy.
  repositories: [{ id, slug, installationId }],
  readOutcome, // Current private decision lookup described below.
  now: Date.now, // Optional synchronous epoch-millisecond clock.
});
```

Repository and installation IDs are positive safe integers. Source and policy identifiers contain 1–128 ASCII letters, digits, underscores, dots, colons, or hyphens. The repository list must be nonempty and unambiguous; a numeric ID or case-insensitive slug cannot appear twice. This provider supports exact GitHub.com owner/repository paths. It does not translate Enterprise URLs or accept alternate origins, encoded paths, query strings, user information, or port aliases.

The factory captures configuration, callback and clock functions, and each repository-bound client's `rest` method before asynchronous work. It calls `client.forRepository(id)` without an unscoped fallback. The host must supply the correct installation credentials and repository approval for each declared scope. A source label, URL, numeric installation field, or returned `private: false` is not itself a permission grant.

For the existing worker, use the returned provider as `metadataEnrichment.source`, the same declared `policyVersion`, and a live `configurationCurrent` implementation. The worker separately binds the installation, durable access generation, current collection membership, configuration hash, controls revision, data mode, and its derived metadata job namespace. Those fields are not all available in the provider's `readMetadata` request. The provider does not claim to validate that invisible namespace.

### Current outcome record

Only after source validation does the provider call:

```js
readOutcome({ binding, signal, assertAuthorized });
```

`binding` is detached and frozen. Its scalar fields are:

| Group                     | Exact fields                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Configured scope          | `repositoryId`, `installationId`, `sourceId`, `family`, `policyVersion`                  |
| Retained fact             | `subjectId`, `sourceRevision`, `sourceUrl`, `evidence`, `actorId`, `occurredAt`, `state` |
| Optional retained context | `historySubjectId` and `projectSubjectId`, only when present in the input                |

The callback must return a plain record with **exactly** the binding fields above and these additional fields:

| Field             | Required meaning and shape                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `schemaVersion`   | Literal `github-enrichment-outcome/v1`                                                          |
| `recordId`        | Identifier of the host's actual decision record, using the identifier grammar above             |
| `evidenceId`      | Identifier of the private evidence supporting that decision, using the same grammar             |
| `acceptedOutcome` | Literal `true` or `false`; missing, null, and coerced values are unavailable                    |
| `recordedAt`      | Positive safe integer, epoch milliseconds, no later than the final clock                        |
| `validUntil`      | Positive safe integer, epoch milliseconds, strictly after both `recordedAt` and the final clock |

The complete original revision, including any observation suffix, must match. An earlier observation of content A cannot authorize a later A after an intervening B merely because the content fingerprint is the same. State, evidence kind, actor/time unknowns, and optional retained context are also bound. The provider invents no observation run ID and fills no missing decision, evidence reference, or expiry.

These references establish a structural binding to a trusted host record. They do not independently prove source-use rights, a person's approval, or policy adoption. The host must resolve the actual approved record, restrict its lifetime under that policy, and invalidate live worker/configuration authority when that decision is revoked or changed. Completed jobs are governed by the worker's current namespace; changing only a private lookup result cannot invalidate an already completed job. A replacement policy or configuration must follow the existing reviewed host procedure.

The callback receives the original cancellation signal and the captured synchronous `assertAuthorized` fence. It must preserve that authorization while doing its own asynchronous lookup. A successful fence returns `undefined`; promises and other return values are not authorization. The optional clock must remain synchronous, return safe integer milliseconds, and not move backward within a read. The provider samples the final decision time and then rechecks captured authorization after that clock callback. No further host callback or await separates the successful final fence from the fixed metadata return. There is no universal decision TTL or atomic remote permission snapshot.

## Source profiles and unknown fields

The three profiles accept the actual collector's current-state facts: `evidence: "current_state"`, unknown `actorId` and `occurredAt` represented by null, and the corresponding `present` or `merged` state. They do not turn those fields into historical actor or transition evidence. Collected node IDs are valid subject identities; a native SHA or numeric artifact ID is also accepted when it identifies the same returned artifact. Native identity, URL, and revision must agree.

Every operation first reads the approved repository through its bound client and requires the exact numeric identity, slug, and literal public flag. Any supplied visibility or repository URL must agree. Local host/checkpoint authorization is rechecked around every await. This does not make separate GitHub requests an atomic remote permission snapshot; the worker's current access and configuration fences remain required.

| Profile             | Required source observation                                                                                                                                                                                                                                                         | Reported metadata                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable commit    | Exact full 40- or 64-hex SHA in retained revision, native URL, and returned `sha`; matching native subject                                                                                                                                                                          | `stats.additions` and `stats.deletions` when supplied as nonnegative safe integers; otherwise null. A supplied total must be consistent when both operands are known. `changedFiles` is always null. |
| Merged pull request | Exact native pull identity and URL; collected state `merged`; returned closed, merged, non-draft pull with valid merge time, immutable merge/head/base pins and the approved base repository; exact reserved `gh-rest-v1` selected-field fingerprint and observation suffix grammar | GET-only aggregate `additions`, `deletions`, `changed_files`, each a nonnegative safe integer or null. `reviewState` remains null.                                                                   |
| Individual review   | Exact native review ID/subject/URL, parent pull number/identity/URL, and every supplied parent/source link; submitted `APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED` with valid actor identity, submission time, commit pin and review fingerprint                                 | Lowercase `approved`, `changes_requested`, or `commented`; all three file-statistic fields remain null.                                                                                              |

Missing or explicitly null counts stay null; literal zero remains zero. Supplied strings, booleans, negative, fractional, nonfinite, or unsafe counts are rejected. A commit response's `files.length`, even zero, does not prove the complete aggregate: the [Get a commit endpoint](https://docs.github.com/en/rest/commits/commits#get-a-commit) paginates large file listings, while the existing client's `rest` method returns only the body. This implementation performs no file pagination or completeness inference. It does not override the client's pinned API version.

For pull requests, the shared [REST snapshot projection](../packages/github/src/rest-snapshot.ts) intentionally excludes GET-only merge and diff details. The provider verifies the shared observation first and separately qualifies those dependencies. Missing-versus-null selected fields remain distinct. Legacy timestamp revisions, malformed reserved markers, and unsupported profile versions remain unavailable rather than falling back to a weaker comparison. A pull collected while open cannot be enriched as a later merged observation. Source merge and review timestamps retain their supplied fractional precision through the shared `compareSourceInstants` comparator: a source instant one nanosecond after the sampled clock remains future even when both truncate to the same millisecond.

For reviews, the public package exports `githubReviewRevision` and `githubSnapshotRevision`, but no public review-verification function. The provider follows the existing normalizer's exact private comparison: either the bare 64-lowercase-hex fingerprint, or that fingerprint followed by a dot and exactly 32 lowercase hex digits. It preserves the suffix; it does not reconstruct one from an invented scan. Its parent/link validation follows the same selected identity rules as the existing review source checks.

A review on an earlier commit remains a valid individual observation when the pull's head advances or the parent is open. The provider does not equate it with current-head approval, cohort completeness, first-review timing, or accepted-review credit. Pending, dismissed, unknown, malformed, and mismatched reviews remain unavailable. The [individual review endpoint](https://docs.github.com/en/rest/pulls/reviews#get-a-review-for-a-pull-request) and [pull request endpoint](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) are separate reads.

## Cancellation, retention and failures

The provider captures each request's fact, original signal, and authorization callback before awaiting. It observes cancellation while repository, artifact, parent or host reads are pending and rechecks authorization afterward. Replacing the caller's request properties cannot retarget an in-flight operation. Late resolution or rejection is observed and has no result path after cancellation. The existing worker continues to own its bounded wait, lease completion and transactional authority checks; the client has its own transport timeout. No unsupported transport-level AbortSignal is invented.

Runtime failures expose only `github_enrichment_unavailable`; invalid factory configuration exposes `invalid_github_enrichment_options`. The existing store retains its fixed failure reason and retry history. Explicit false decisions produce excluded metadata. Source text and private decision details never enter the six-field result. Text may participate in exact revision hashing, and the existing authorized client may retain source payloads in its repository-scoped cache; this provider does not replace that cache's separate retention rules.

## Synthetic validation and remaining acceptance

The [provider tests](../apps/pipeline/test/github-enrichment-source.test.mjs) exercise fixed native fixtures, a real repository-bound client with a synthetic HTTP transport, and the actual collection/store/metadata-worker composition with in-memory PGlite. They cover identity and observation mismatch, missing/zero/malformed statistics, individual reviews on older commits, exact current host records, per-await revocation/cancellation, mutation isolation, retry states, and zero contribution/publication writes. Every payload, decision identifier and credential string in those tests is synthetic.

Run the new module's syntax check and its focused tests after the usual workspace build:

```bash
node --check apps/pipeline/src/github-enrichment-source.mjs
node --test --test-isolation=none --test-reporter=tap apps/pipeline/test/github-enrichment-source.test.mjs
```

The existing test glob discovers the new file; no new default worker or manifest hook is required. Local tests do not certify a native PostgreSQL deployment, a real GitHub App installation, actual endpoint permission/availability, rights approval, live outcome records, or complete commit-file coverage. Whole [#58](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/58) acceptance retains [#45's verified source capability](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/45) and the actual host's reviewed composition and evidence requirements.
