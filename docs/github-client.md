# Read-only GitHub collection client

`@pick-your-ai/github` supplies a read-only HTTP transport and resumable collection helpers for [LB-04.04 / #45](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/45). It does not install a GitHub App, enable a source family, infer visibility from access, or establish historical completeness. Real installation and per-family capability evidence remain pending under [#41](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/41) and [#44](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/44).

## Setup and collection

Build with `npm run build --workspace @pick-your-ai/github`; run synthetic tests with `npm test --workspace @pick-your-ai/github`. The client uses Node.js 24's fetch implementation by default. Injected fetch, clock, sleep and random functions support isolated tests. Callers supply credentials through a server-side token callback; no credentials are accepted from source payloads or written into checkpoints.

```ts
import { FileCheckpointStore, GithubReadClient } from "@pick-your-ai/github";

const client = new GithubReadClient({
  token: async (source) => obtainAuthorizedInstallationToken(source),
  checkpoints: new FileCheckpointStore(privateCollectorStateDirectory),
  concurrency: 4,
  maxRetries: 3,
});

const issues = await client.forRepository(approvedRepositoryId).scanRest({
  source: installationAndPermissionScopeId,
  key: "approved-repository-issues/v1",
  url: approvedRepositoryIssuesApiUrl,
  maxPages: 100,
  select: (body) => validateAndSelectIssueArray(body),
});
```

The names in this example are caller-supplied configuration/functions, not fixture credentials. Use a stable source identifier for one authorization/quota pool. Tokens sharing a GitHub rate budget must share this identifier. Change it when the permitted installation/repository scope changes, so a different authorization cannot reuse an old cache or checkpoint. Bind source payloads to the separately verified numeric repository ID with `forRepository(id)`; the default collector and built-in normalizer require repository-scoped storage. Repository views share the original quota and concurrency pool. A single client coordinates requests within one process; separate processes require a shared scheduler and a transactional checkpoint implementation.

Hosts with revocable access should pass the optional synchronous `assertAuthorized` callback to direct reads and scans. It must throw whenever that source is no longer authorized. The client checks before each HTTP attempt, after awaited response/quota/body/cache work, before invoking page selectors, before accepting a selected page into its scan checkpoint, and before delivering results. Loaded pause/cache state is checked before validation or waiting, and retry-pause persistence and scan continuation are checked before retry exhaustion or pagination errors. Direct reads and scans also check before delivering a rejected operation, so a concurrent denial takes precedence over stale body-validation or checkpoint errors. A denial becomes a sanitized `unsafe_request` failure and is not retried. An unread rejected response body is cancelled without retaining its concurrency slot; requests for other authorized source IDs can continue.

These checks stop newly unauthorized responses from being returned and stop a page rejected before checkpoint admission from advancing a scan. They do not erase earlier accepted pages or HTTP caches, roll back a durable write already started while authorized, or interrupt a pending network/body read, checkpoint operation or quota sleep at the instant access changes. Quota waiting rechecks access after each sleep chunk, which is at most one minute. The host still owns cancellation and the coordinated source-revocation/retention procedure under [#49](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/49). Without a supplied callback, this client cannot observe changes in the host's authorization policy. Repository-bound views additionally check the durable checkpoint authority; an explicit repository retirement remains denied without a callback. See [repository checkpoint retirement](repository-checkpoint-retirement.md) for its exact receipt, restore requirements and remaining cross-store limits.

`rest` issues GET requests only. `graphql` issues POST requests containing read queries only; documents must begin with `query` or a shorthand selection and cannot contain mutation/subscription operation tokens outside comments/strings. This deliberately conservative guard also rejects read fields or operation names literally named `mutation` or `subscription`. There is no arbitrary method or headers override. Every request sets Accept, User-Agent and X-GitHub-Api-Version (default `2022-11-28`, configurable after API compatibility review). Redirects are never followed. Initial URLs, persisted next URLs and REST pagination links must remain on the configured HTTPS API origin without embedded credentials or fragments. Enterprise support requires an explicitly approved API origin and GraphQL path, such as `/api/graphql`.

REST responses with ETags are privately cached with their Link headers. Later requests send If-None-Match; 304 reuses both the validated representation and its pagination link. An unexpected 304 without a cached representation fails. Conditional requests preserve page traversal rather than treating unchanged pages as empty results.

Successful REST and GraphQL response bodies require well-formed UTF-8 before JSON parsing. A damaged sequence produces a sanitized `invalid_response` failure; it cannot be replaced with a Unicode replacement character and then accepted as source identity. Validation precedes ETag caching and page selection. A malformed later page retains the previously accepted checkpoint and resumes that page on the next scan; it cannot mark the scan complete or replace an existing valid cached representation. Valid multilingual text, including an explicitly encoded replacement character and code points split across network chunks, is preserved. For unsuccessful HTTP responses, the status still determines authentication, visibility and retry classification even when the body is malformed. Previously decoded legacy caches cannot recover lost original bytes; this check does not retroactively certify them.

JSON processing admits at most 128 nested object/array containers, counting the root container and any GraphQL response wrapper. The same bound applies to each loaded HTTP body and the array of retained or selected scan items. It includes values that identity-email minimization subsequently omits. An excessive successful response or selector result fails as `invalid_response`; excessive retained state fails as `invalid_checkpoint` before reuse. These failures neither trigger retries nor create failure-backoff pauses, and they cannot replace a valid ETag representation or advance scan progress. Independently reported quota headers retain their existing observation and pause behavior. This is a local structural bound, separate from the response-byte and checkpoint-size limits; it does not certify source-family schemas or installed capability.

Structured `email` fields inside `author` and `committer` objects (including REST `commit.author` and `commit.committer`) are omitted recursively before a response is returned, selected or cached, and before selected scan items are persisted. GitHub IDs, logins, SHAs, source URLs, names and timestamps are preserved. Callers must not depend on those prohibited email fields. Loaded legacy HTTP bodies and scan items are minimized and durably rewritten before reuse, including 304 responses and completed or interrupted scans; a failed migration write prevents reuse.

This is structured-field minimization, not complete payload sanitization: commit messages, Co-authored-by trailers, patches, signatures and other free text are unchanged and can contain addresses. GraphQL callers must not request prohibited email fields (including aliases); selectors must not introduce or rename sensitive fields. Unread legacy keys, backups and other downstream stores are not migrated by loading a different key. Operators still need the accepted private-storage, cleanup and retention procedures; this change establishes no retention duration or production privacy approval.

## Pagination and checkpoints

`scanRest` follows all next Link relations. `scanGraphql` manages `first` (1–100) and `after` for the selected connection, including a connection nested below a repository or node. The caller validates/selects the array or connection for its particular source family. GraphQL responses with any errors never become accepted pages, including partial HTTP 200 data. Permission, authentication, hidden/not-found, rate-limit, transient and invalid-response outcomes remain distinguishable.

For multiple child collections, first scan the parent connection, then call `scanNestedGraphql(parents, parent => childScanOptions)`. Give every parent's child scan a separate stable key and its parent ID in variables. Each child connection advances its own cursor; a parent cursor does not stand in for review/comment cursors. The helper bounds child tasks and waits for all started tasks to settle before reporting failure. Before returning the grouped result, it rechecks every child's original source and authorization callback, so access revoked while a later child runs also prevents delivery of earlier results. The child-options factory is called once per started parent. Individual child checkpoints remain resumable.

Every scan fingerprints its URL/query, source operation key, API configuration and managed page size. It persists the accepted items, visited pages/cursors, next location and completion marker together after each fully validated page. A new process resumes the same operation without discarding earlier pages or appending a failed page. Changed query identities reject stale state. Page limits and repeated cursors fail explicitly and retain progress. A completed scan returns its saved result; `refresh: true` starts a deliberate new scan and can use REST ETags. Use a new operation key for a new historical window or changed selection semantics.

Each scan captures its original scalar options and selector/authorization function references before asynchronous work. GraphQL variables are converted to a detached JSON object at that entry, before fingerprinting, and every page uses that same value with its managed `first`/`after`. Direct GraphQL reads capture their complete JSON request body before asynchronous work; retries reuse the captured bytes. Ordinary JSON conversion is preserved, including nested `Date`/`toJSON`, omitted object `undefined`, and array nulls for holes or non-JSON values. A scan's converted variables must be an object without `first` or `after`; conversion cannot replace managed pagination. Cycles, BigInt, throwing conversion hooks, and invalid converted scan variables fail with sanitized `unsafe_request` before token lookup, HTTP, retry pauses or scan/cache writes. Current host and repository authorization still guard that rejection. Plain JSON variable fingerprints remain compatible with existing checkpoints; a changed conversion result cannot reuse a mismatched fingerprint.

The captured authorization function remains live and is invoked at the existing access boundaries; this snapshot is no authorization grant. Selectors retain their original options receiver, and callbacks retain their own closure/receiver behavior. Callers still own that callback logic and selection validation. Reusing or mutating an options object does not replace an in-flight scan's source, query, selector function or authorization function. `scanNestedGraphql` applies the same entry boundary independently to each started child; its caller-supplied parent collection remains the host's responsibility. The synthetic `scan-input-snapshot.test.mjs` cases cover mutations during checkpoint/token awaits, pages/retries, shared child options, JSON conversion, rejection and live denial. They do not execute a real GitHub installation or establish source completeness.

`CheckpointStore` is injectable: `save` must durably and atomically replace the whole value before resolving, and `load` must return independent values. `FileCheckpointStore` writes a private temporary file, fsyncs its contents, atomically renames it, and fsyncs the directory where supported. Windows requires appropriate directory ACLs; POSIX files/directories use restrictive modes. It supports one writer per scan/source key and persistent restarts, not concurrent processes editing the same state. Use a transactional implementation with locking for shared workers. Corrupt or mismatched checkpoint state fails closed. Never store this directory in Git or expose it through public assets: it contains source representations and must follow the approved retention/deletion policy. Files contain hashed keys, never authorization headers/tokens.

Each filesystem checkpoint has a 64 MiB UTF-8 JSON record limit by default. Configure a smaller reviewed collector budget with `new FileCheckpointStore(directory, { maxBytes })`; changing it is an explicit host decision, not an automatic retry. Loading reads at most the configured limit plus one byte from one opened file, so a large, growing or replaced pathname cannot bypass the read bound. Saving checks encoded bytes before creating a temporary file or replacing the previous checkpoint. `CheckpointLimitError` identifies a capacity failure; an HTTP cache write that exceeds the cap does not retry the network or synthesize a quota pause. The same limit applies to repository-scoped and legacy records. A failed oversized scan save leaves its last accepted page resumable; it does not truncate results or mark the scan complete. Existing oversized records remain on disk and fail closed until an operator handles them under the retention policy. This limits each encoded record, not directory size, the caller's preexisting objects or total process memory; JSON serialization/parsing also consumes memory. Shared storage, retention and the broader source-deletion requirements in [#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95) remain separate.

Repository-bound records live under `repositories-v1/<repositoryId>`. Their permanent retirement marker is stored separately from payloads and is checked on every scoped load/save and awaited client delivery boundary. `retireRepositoryCheckpoints(id, binding)` first durably installs the operation-bound denial marker, then removes only that repository namespace. Read the [retirement procedure and limitations](repository-checkpoint-retirement.md) before integrating this privileged host operation. Legacy unscoped bytes are explicitly outside its receipt; it does not purge database, controls or backup payloads.

Filesystem loads require well-formed UTF-8 before JSON parsing. Damaged bytes produce the existing fixed corrupt-checkpoint error without rewriting the saved record; they cannot become replacement characters in restored source identities. Valid encoded Unicode, including a literal replacement character, remains readable. Leading UTF-8 BOMs retain the existing JSON-parser rejection behavior. This check cannot recover original bytes from legacy records already rewritten by a lossy decoder.

The scan result is not an atomic database commit with a downstream importer. Consume it through an idempotent canonical-event importer or a separately coordinated transaction. A checkpoint is collection progress, not evidence that downstream recognition was accepted. The client does not mark coverage complete merely because a supplied pagination chain ended.

## Retry and resource bounds

Primary and secondary limits pause the affected source, release its active request slot and retain checkpoints. The client honors Retry-After or primary reset time, falls back to at least 60 seconds for headerless secondary limits, and adds nonnegative jitter. Transient network/HTTP failures use bounded exponential backoff. Successful responses exhausting quota pause subsequent requests as well. Pause deadlines persist across client restarts. Sleep uses chunks of at most one minute so long reset times do not overflow Node timers. Retries stop at the configured bound and return a typed failure; the persisted source pause still applies to later attempts. Unrelated source IDs can continue through the concurrency pool.

When a failed rate-limit response supplies both a valid Retry-After and a valid primary reset with `x-ratelimit-remaining: 0`, the later deadline applies before nonnegative jitter is added. A shorter Retry-After cannot release an exhausted primary budget early. A nonexhausted or unknown primary balance does not make its reset a scheduling constraint. The synthetic `mixed-quota-deadline.test.mjs` controls exercise both deadline orders for REST and GraphQL HTTP 403/429, a persisted zero-retry pause followed by a new filesystem store/client, independent-source progress during that pause, and continuation without replaying the first accepted page. They do not establish live installed-source capability.

Retry-After accepts decimal integer seconds or the three UTC HTTP-date formats defined by [RFC 9110 sections 10.2.3 and 5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) (checked 2026-10-18). Signed, fractional and exponent numbers, partial dates, impossible calendar values, years before 1900 and unrepresentable delays do not supply a deadline. The year floor follows the [RFC 5322 section 3.3 semantics](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.3) imported by HTTP-date; the synthetic `retry-after-year.test.mjs` cases retain both the invalid-year fallback and the valid 1900 boundary. A rate-limit response with such a header uses its separately valid exhausted-primary reset or the normal 60-second fallback; an otherwise ordinary 403 remains a permission failure. Obsolete two-digit years use the HTTP fifty-year rule, and the asctime date form uses UTC regardless of the host timezone. The fifty-year comparison includes leap-second rounding, so a rounded instant beyond the cutoff selects the past century before its weekday is validated. The synthetic `retry-after.test.mjs` cases exercise actual client restart, retained source pause and independent-source progress without contacting GitHub.

The source pause is rechecked immediately before HTTP dispatch, after awaited token and authorization work. If a sibling response paused that source meanwhile, the request releases its slot and returns to the existing quota wait without spending a retry attempt. Other authorized source IDs remain free to dispatch. The synthetic `packages/github/test/quota-dispatch.test.mjs` cases cover this boundary for REST and GraphQL, including a later transient failure that retains its configured retry allowance.

Requests have a timeout (default 30 seconds), a response-byte bound (16 MiB), a shared concurrency bound (default four, maximum 100), and explicit scan page bounds. Response text, raw transport errors and credentials are excluded from exported error messages. Stored API data remains private collector state. This layer does not render untrusted content or fetch arbitrary evidence URLs.

Rejected or unused response bodies begin cancellation without waiting for a transport cleanup hook to settle. An oversized body or redirect therefore releases its request slot even if cleanup is slow, so an unrelated source can continue. Cleanup rejection cannot replace the original typed failure or turn a rejected redirect into a retryable transport error. Malformed rate-limit bodies still retain their HTTP classification and source-specific pause. The dedicated `packages/github/test/response-cleanup.test.mjs` regressions exercise these boundaries for REST and GraphQL with held and rejecting cancellation hooks; they use synthetic transport responses and establish no installed-source capability.

Synthetic tests demonstrate 123-item REST retrieval, independent multi-page child reviews, restart/resume, ETag/304 page reuse, concurrency limits, primary/secondary pauses, jitter, partial-response rejection, read-only operations and URL/redirect restrictions. They do not prove a real installation can read a family or that all historical events are available. Before enabling a source, attach the authorized capability receipts, permissions, missing-history explanation and actual source-scope reconciliation required by #41/#44.

Authorization regressions also exercise revocation during REST/GraphQL fetch and streamed-body reads, malformed or oversized successful bodies, initial pause/cache loading, pending cache/checkpoint saves, retry and 304 quota persistence, and second-page selection. They verify denied delivery, cancellation of unread responses, source-slot release, no further retry sleep or pagination request after detected revocation, and preservation of writes already started while authorized. All transport and policy facts in those cases are synthetic.

`packages/github/test/response-encoding.test.mjs` supplies the synthetic response-byte regressions for [#84](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/84): isolated continuation bytes, truncated and malformed sequences, overlong encodings, encoded surrogates, out-of-range code points, retained ETags, interrupted-page restart, valid byte-split Unicode, and malformed error-body classification. These are client integrity checks; the installed-source canaries and remaining source-family acceptance criteria are separate work.

The implementation follows GitHub's [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [REST rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), and [GraphQL pagination guidance](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).

## Retained quota observations

`await client.readQuota(installationAndPermissionScopeId, assertAuthorized)` is a
protected-host diagnostic read. It resolves no token and makes no GitHub request.
The supplied synchronous host grant is checked before and after the awaited
checkpoint reads and before queued observation writes, so a revocation withholds
the result and prevents new writes from starting. The operator HTTP bridge
must still derive the installation/account scope from its current repository
grant; this method does not authenticate a browser or authorize a source ID.

Repository views share the original observer and its per-resource write queue.
Quota metadata remains in the installation/account store, outside repository
payload namespaces. `view.readQuota(...)` checks that view's durable retirement
authority before and after its read; a retired view is denied even without a
host callback. A queued observation rechecks the producing view's durable
authority before starting its write. Retiring one repository therefore neither
authorizes its diagnostic reads nor deletes the quota observation used by an
active sibling. These checks do not roll back a pool write already started while
authorized, and do not grant a cross-process atomic revocation boundary.

The client records the latest successfully retained response for each of `core`,
`search`, `code_search` and `graphql`, plus one `unknown` resource slot. The
resource comes only from the response header; an omitted or unfamiliar resource
does not inherit an endpoint's expected pool. At most five checkpoint values are
read. Their binding hashes the configured HTTPS API origin and the exact source
pool identity, so another installation, account or Enterprise origin cannot reuse
the observation. A shared client serializes writes for each bound resource; a
multi-process host still requires the transactional storage/scheduler described
above.

Each observation contains its actual `observedAt`, HTTP `responseStatus`, numeric
`limit`, `remaining` and `used`, a UTC `resetAt`, and numeric
`retryAfterSeconds`. Missing or malformed numeric values remain null; a valid zero
remains zero. Missing records have state `unknown`, and unreadable, corrupt or
mismatched records have state `unavailable`. Readback returns detached fixed fields.
No source label, URL, token, arbitrary header, response body or error text is
stored in this quota record. A response without quota headers does not refresh an
old observation. A failed telemetry save preserves the previous retained record
and does not retry an otherwise successful source request or invent a pause.

Conditional 304 and HTTP error responses are observed after the ordinary trusted
origin, redirect and current-authorization checks. GraphQL can return errors with
HTTP 200, so `responseStatus` is a transport observation, not collection success.
The existing typed request outcome remains authoritative for that operation.
Previously stored unbound retry-pause deadlines are not exposed as if they were
origin-bound quota observations.

These values describe a response, not an exact global remaining balance or a
collector heartbeat. GitHub's [REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [GraphQL rate-limit documentation](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
(checked 2026-10-18) define these headers and note that later response counters can
increase because requests may be processed in different regions. The observer
preserves the later retained values without summing them, taking a minimum or
manufacturing global consumption. Unobserved clients, resources and secondary
quota balances remain unknown. Freshness, queue recovery and confirmed
publication diagnostics are separate from this observation.
