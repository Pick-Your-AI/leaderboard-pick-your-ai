# Read-only GitHub collection client

`@pick-your-ai/github` supplies a read-only HTTP transport and resumable collection helpers for [LB-04.04 / #45](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/45). It does not install a GitHub App, enable a source family, infer visibility from access, or establish historical completeness. Real installation and per-family capability evidence remain pending under [#41](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/41) and [#44](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/44).

## Setup and collection

Build with `npm run build --workspace @pick-your-ai/github`; run synthetic tests with `npm test --workspace @pick-your-ai/github`. The client uses Node.js 24's fetch implementation by default. Injected fetch, clock, sleep and random functions support isolated tests. Callers supply credentials through a server-side token callback; no credentials are accepted from source payloads or written into checkpoints.

```ts
import { FileCheckpointStore, GithubReadClient } from "@pick-your-ai/github";

const client = new GithubReadClient({
  token: async source => obtainAuthorizedInstallationToken(source),
  checkpoints: new FileCheckpointStore(privateCollectorStateDirectory),
  concurrency: 4,
  maxRetries: 3,
});

const issues = await client.scanRest({
  source: installationAndPermissionScopeId,
  key: "approved-repository-issues/v1",
  url: approvedRepositoryIssuesApiUrl,
  maxPages: 100,
  select: body => validateAndSelectIssueArray(body),
});
```

The names in this example are caller-supplied configuration/functions, not fixture credentials. Use a stable source identifier for one authorization/quota pool. Tokens sharing a GitHub rate budget must share this identifier. Change it when the permitted installation/repository scope changes, so a different authorization cannot reuse an old cache or checkpoint. A single client coordinates requests within one process; separate processes require a shared scheduler and a transactional checkpoint implementation.

`rest` issues GET requests only. `graphql` issues POST requests containing read queries only; documents must begin with `query` or a shorthand selection and cannot contain mutation/subscription operation tokens outside comments/strings. This deliberately conservative guard also rejects read fields or operation names literally named `mutation` or `subscription`. There is no arbitrary method or headers override. Every request sets Accept, User-Agent and X-GitHub-Api-Version (default `2022-11-28`, configurable after API compatibility review). Redirects are never followed. Initial URLs, persisted next URLs and REST pagination links must remain on the configured HTTPS API origin without embedded credentials or fragments. Enterprise support requires an explicitly approved API origin and GraphQL path, such as `/api/graphql`.

REST responses with ETags are privately cached with their Link headers. Later requests send If-None-Match; 304 reuses both the validated representation and its pagination link. An unexpected 304 without a cached representation fails. Conditional requests preserve page traversal rather than treating unchanged pages as empty results.

Structured `email` fields inside `author` and `committer` objects (including REST `commit.author` and `commit.committer`) are omitted recursively before a response is returned, selected or cached, and before selected scan items are persisted. GitHub IDs, logins, SHAs, source URLs, names and timestamps are preserved. Callers must not depend on those prohibited email fields. Loaded legacy HTTP bodies and scan items are minimized and durably rewritten before reuse, including 304 responses and completed or interrupted scans; a failed migration write prevents reuse.

This is structured-field minimization, not complete payload sanitization: commit messages, Co-authored-by trailers, patches, signatures and other free text are unchanged and can contain addresses. GraphQL callers must not request prohibited email fields (including aliases); selectors must not introduce or rename sensitive fields. Unread legacy keys, backups and other downstream stores are not migrated by loading a different key. Operators still need the accepted private-storage, cleanup and retention procedures; this change establishes no retention duration or production privacy approval.

## Pagination and checkpoints

`scanRest` follows all next Link relations. `scanGraphql` manages `first` (1–100) and `after` for the selected connection, including a connection nested below a repository or node. The caller validates/selects the array or connection for its particular source family. GraphQL responses with any errors never become accepted pages, including partial HTTP 200 data. Permission, authentication, hidden/not-found, rate-limit, transient and invalid-response outcomes remain distinguishable.

For multiple child collections, first scan the parent connection, then call `scanNestedGraphql(parents, parent => childScanOptions)`. Give every parent's child scan a separate stable key and its parent ID in variables. Each child connection advances its own cursor; a parent cursor does not stand in for review/comment cursors. The helper bounds child tasks and waits for all started tasks to settle before reporting failure. Individual child checkpoints remain resumable.

Every scan fingerprints its URL/query, source operation key, API configuration and managed page size. It persists the accepted items, visited pages/cursors, next location and completion marker together after each fully validated page. A new process resumes the same operation without discarding earlier pages or appending a failed page. Changed query identities reject stale state. Page limits and repeated cursors fail explicitly and retain progress. A completed scan returns its saved result; `refresh: true` starts a deliberate new scan and can use REST ETags. Use a new operation key for a new historical window or changed selection semantics.

`CheckpointStore` is injectable: `save` must durably and atomically replace the whole value before resolving, and `load` must return independent values. `FileCheckpointStore` writes a private temporary file, fsyncs its contents, atomically renames it, and fsyncs the directory where supported. Windows requires appropriate directory ACLs; POSIX files/directories use restrictive modes. It supports one writer per scan/source key and persistent restarts, not concurrent processes editing the same state. Use a transactional implementation with locking for shared workers. Corrupt or mismatched checkpoint state fails closed. Never store this directory in Git or expose it through public assets: it contains source representations and must follow the approved retention/deletion policy. Files contain hashed keys, never authorization headers/tokens.

The scan result is not an atomic database commit with a downstream importer. Consume it through an idempotent canonical-event importer or a separately coordinated transaction. A checkpoint is collection progress, not evidence that downstream recognition was accepted. The client does not mark coverage complete merely because a supplied pagination chain ended.

## Retry and resource bounds

Primary and secondary limits pause the affected source, release its active request slot and retain checkpoints. The client honors Retry-After or primary reset time, falls back to at least 60 seconds for headerless secondary limits, and adds nonnegative jitter. Transient network/HTTP failures use bounded exponential backoff. Successful responses exhausting quota pause subsequent requests as well. Pause deadlines persist across client restarts. Sleep uses chunks of at most one minute so long reset times do not overflow Node timers. Retries stop at the configured bound and return a typed failure; the persisted source pause still applies to later attempts. Unrelated source IDs can continue through the concurrency pool.

Requests have a timeout (default 30 seconds), a response-byte bound (16 MiB), a shared concurrency bound (default four, maximum 100), and explicit scan page bounds. Response text, raw transport errors and credentials are excluded from exported error messages. Stored API data remains private collector state. This layer does not render untrusted content or fetch arbitrary evidence URLs.

Synthetic tests demonstrate 123-item REST retrieval, independent multi-page child reviews, restart/resume, ETag/304 page reuse, concurrency limits, primary/secondary pauses, jitter, partial-response rejection, read-only operations and URL/redirect restrictions. They do not prove a real installation can read a family or that all historical events are available. Before enabling a source, attach the authorized capability receipts, permissions, missing-history explanation and actual source-scope reconciliation required by #41/#44.

The implementation follows GitHub's [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [REST rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), and [GraphQL pagination guidance](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).
