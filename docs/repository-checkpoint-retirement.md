# Repository checkpoint retirement

The GitHub client can permanently retire the checkpoint payloads of one explicitly
identified repository. This is a component of
[#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95), with a
receipt limited to that store and repository. The default pipeline collection
adapter and built-in normalizer use this scope for visibility probes, HTTP caches,
page progress and completed scans.

The remaining database, controls, archived-publication, external-cache and backup
work is tracked in the [cross-store boundary](source-retention-boundary.md). This
operation does not delete those stores or certify complete source removal.

## Bind source payloads to the verified repository

```ts
import { FileCheckpointStore, GithubReadClient } from "@pick-your-ai/github";

const checkpoints = new FileCheckpointStore(privateCheckpointDirectory, {
  tombstoneDirectory: durableCheckpointAuthorityDirectory,
  maxBytes: reviewedMaximumCheckpointBytes,
});
const transport = new GithubReadClient({
  token: (source) => obtainAuthorizedInstallationToken(source),
  checkpoints,
});
const repositoryClient = transport.forRepository(approvedRepository.id);
const issues = await repositoryClient.scanRest({
  source: installationQuotaPoolId,
  key: approvedCollectionOperationId,
  url: approvedRepositoryIssuesApiUrl,
  maxPages: 100,
  select: (body) => validateAndSelectIssueArray(body),
  assertAuthorized: assertCurrentSourceAuthorization,
});
```

These names stand for trusted host configuration and functions. The repository ID
must be an approved, positive safe integer. Neither a URL nor the installation
`source` string establishes the repository identity. The default adapter verifies
the configured ID, slug and installation before selecting its bound client; its
normalization inputs also carry the approved repository identity.

Repository views share the original transport's request concurrency and quota
pool. A source pause still belongs to the installation/account and survives the
retirement of one repository. Retained response and scan keys use both an isolated
repository directory and a repository-specific key hash. A view cannot be
rebound to a different repository.

An injected checkpoint implementation must provide `forRepository(id)` with
`repositoryId`, `load`, `save`, `assertActive` and `retire`. The default collector
fails if this capability is absent; it does not silently use legacy storage.
Custom source providers remain host integrations whose retention behavior must be
reviewed separately. Direct calls on the unbound transport remain supported for
legacy callers and quota state; they are outside repository retirement.

## Retire an exact scope

After the protected host has authorized this exact repository and operation:

```ts
const receipt = await transport.retireRepositoryCheckpoints(approvedRepository.id, {
  operationId: approvedRetirementOperationId,
  policyId: approvedRetentionPolicyId,
  authorizationId: currentHostAuthorizationReceiptId,
});
```

This is a privileged in-process API, without a public HTTP route. Its binding
contains exactly three opaque references: `operationId`, `policyId` and
`authorizationId`. Each is 1–128 ASCII characters, begins with an alphanumeric
character and then permits alphanumerics, underscores, periods, colons and hyphens.
These references must not contain credentials, source text or personal data. Their
presence is not authentication; the host must verify authorization before calling
the method.

The filesystem implementation performs the following sequence under the same
repository queue used by reads and writes:

1. Validate the binding and configured storage boundaries.
2. Write a minimal immutable tombstone, sync its contents, install it atomically
   without replacing an existing marker, and sync its directory.
3. Remove only `repositories-v1/<repositoryId>` from the payload directory and
   sync the containing namespace before acknowledging completion.

The returned receipt has schema `repository-checkpoint-retirement/v1`, the exact
repository and three binding references, `checkpointPayloadsRemoved: true` and
`legacyUnscopedPayloads: "outside_scope"`. It makes no claim about other stores,
total directory size or a retention cutoff. Retirement is permanent for that
repository in this authority; there is no reactivation or expiry endpoint.

A retry with the same binding rechecks the tombstone, repeats any remaining
cleanup and returns the same receipt. A different binding conflicts rather than
overwriting authority or reporting success. A failure after marker installation
keeps reads denied even if cleanup has not finished. Unreadable, corrupt,
oversized, ambiguous or nonregular authority records also deny access. Filesystem
errors never produce a successful cleanup receipt.

## In-flight work, restart and restore

Each scoped load and save checks authority while holding the repository queue.
The client also checks after awaited token, HTTP, body, quota and cache work,
before accepting pages, and before delivering direct, completed or nested results.
A detected retirement becomes a sanitized `unsafe_request` error. It cannot
trigger a transport retry or return old results. A write that started while active
may finish first; retirement waits for that write and then removes its payload.
Other repositories retain their bytes and can continue through the shared pool.

Restarted clients consult the same durable authority. Reintroducing an old payload
directory does not clear the tombstone; reads remain denied and an exact-binding
retirement retry removes that restored payload. The default pipeline's next source
verification therefore fails before another HTTP request and invokes its existing
unavailable-source fence for current and pinned publications. The checkpoint
retirement call itself does not synchronously fence or purge existing SQL/controls
publications; the coordinated cross-store operation is still required.

By default, authority is a sibling directory named
`<checkpointDirectory>.repository-retention`. An explicit `tombstoneDirectory`
must be outside the payload directory, with neither directory containing the
other. The host must keep the same authority configuration across all clients and
restarts, protect it as private integrity state, and preserve it independently of
payload expiry and restore. Restoring an older authority, deleting it, or changing
its configured location removes the prerequisite for durable denial. This module
does not authenticate storage administration or reconstruct a missing authority.

The store coordinates multiple instances and ancestor-path aliases within one
process. It rejects symlinked repository namespaces and nonregular payload or
marker files, and verifies real directory separation when both exist. It does not
provide cross-process locking or protect a private storage tree being concurrently
reconfigured by an external administrator. Shared workers need a transactional
backend implementing the same operation binding and fencing contract.

POSIX durability uses file and directory syncs. Windows does not perform directory
sync here and requires appropriate directory ACLs; the POSIX crash tests do not
establish equivalent power-loss durability on Windows or every filesystem.

## Legacy data and validation

Legacy unscoped payload names hash an opaque operation key and do not reliably
identify their repository. Retirement neither guesses their scope nor deletes
them. It explicitly excludes them from the receipt. They still require a reviewed
inventory and migration or cleanup procedure. The marker contains no source
payload; it is deliberately retained after scoped payload deletion.

Synthetic tests use the actual filesystem store to exercise exact-scope removal,
unrelated payload and quota preservation, matching and conflicting retries,
restart, old-payload restore, held writes, path aliases, corruption, unsafe file
types, failed syncs, and abrupt child-process exits before and after payload
removal. Client cases cover retirement during token acquisition, fetch and
streamed reads, completed/interrupted scans, nested delivery, and a full ETag cache
that must not cause network retries. The default pipeline test uses the real
adapter, normalizer, file checkpoints, PGlite and controls store; it verifies
scoped probe/list/hydration caches and the next failed probe's publication fence.

Those fixtures establish the tested component behavior. They are not a production
purge, real GitHub installation evidence, cross-process proof, or acceptance of the
remaining #95 retention, archived visibility and analytics requirements.
