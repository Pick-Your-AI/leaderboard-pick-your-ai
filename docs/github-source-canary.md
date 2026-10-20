# Protected-host GitHub source canary

The opt-in entrypoint in
[`apps/pipeline/src/github-source-canary.mjs`](../apps/pipeline/src/github-source-canary.mjs)
exercises the existing [read-only client](github-client.md) against one explicitly
authorized public repository. It reads one issue's event collection and one pull
request's review collection, closes the first checkpoint handle, opens another,
and verifies exact retained identity and observation digests. This prepares a
repeatable host procedure for [#45](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/45).
It does not install an App, authorize a repository, activate a source family,
publish contributor evidence, or close that work package.

The repository supplies no credential, default host module, installation lookup,
private-repository probe, or quota-exhaustion experiment. Actual source and
permission acceptance remains under
[#41](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/41) and
[#44](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/44);
hosting and secrets remain under
[#48](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/48).

## Prepare the trusted host

An operator must supply all of the following before a real invocation:

- A reviewed App installation and token source, the approved HTTPS API origin and
  API version, and an explicitly authorized repository ID and current slug.
- The native numeric ID and repository-local number of one issue and one pull
  request in that repository. Choose independently verified public collections
  with more than 100 eligible event and review records if the large-pagination
  observation is required. A small collection is an insufficient sample.
- One stable authorization/quota pool identifier. All tokens sharing the same
  quota must use that identifier; changing it to escape a pause is prohibited.
- A private checkpoint namespace with the accepted retention and deletion policy,
  an exclusive writer for these scan/source keys, and an explicit new run ID or
  deliberate resume of the same run. Its lifetime must span both opened handles.
- Host authorization checks that bind those inputs to the current installation,
  permission, repository and retirement state. A callback returning true is a
  trusted host decision, not independent evidence that those prerequisites exist.

The host module is trusted executable code. Keep it, its parent directories and
its imports under the operator's normal ownership and access controls, outside
the repository and public assets. The command requires an absolute regular
`.mjs` file and rejects a final-path symlink; that check is not a sandbox, an
opened-file identity guarantee or verification of its dependency graph. Do not
construct this path or its contents from contributor text, a URL, an HTTP request
or a public configuration field.

The module's default export has three callbacks and one request:

| Member                             | Required contract                                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`                          | Exactly the fields in the example below; no extra keys. Inputs are copied and frozen before the first await.                                                                                                                                               |
| `authorize(request)`               | A bounded asynchronous current-authority read returning exactly `true`. Any other result denies the operation. It runs before opening, after asynchronous opening, around completed phases and at delivery.                                                |
| `assertAuthorized(request)`        | A synchronous current-authority fence returning exactly `true`; a Promise does not qualify. It remains callable for the entire invocation, including after both resource handles close. It must observe revocation without depending on a disposed handle. |
| `open({ phase, request, signal })` | Opens resources for `phase === "scan"` or `"reuse"`. Return a new handle to the same durable checkpoint namespace, with the members below. Opening must not implicitly install, expand permissions, or reset retained state.                               |

Each opened handle supplies:

| Member                      | Required contract                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpoints`               | The existing `CheckpointStore` contract, including `forRepository(id)`. Saves must atomically and durably replace the complete value; loads return independent values. Repository retirement checks remain mandatory.                        |
| `token(source, { signal })` | Returns a nonempty credential from the host's existing authorized provider for the exact source pool. No credential is accepted in the request or report.                                                                                    |
| `fetch`                     | Optional trusted fetch-compatible function; otherwise Node's fetch is used. An injected function must honor the supplied signal and must not be treated as evidence of a real GitHub response. Bind any required receiver when supplying it. |
| `close()`                   | Closes only this resource handle after all its started work settles. It must preserve durable checkpoints and the host-level authorization fence. A close failure withholds the report.                                                      |

For example, the request shape is as follows. Every identity here is **synthetic**;
substitute separately verified host configuration before any actual invocation.
The application does not resolve these values automatically.

```js
const request = {
  runId: "operator-reviewed-run-001",
  source: "installation-and-permission-pool",
  repository: {
    id: 42,
    installationId: 73,
    slug: "synthetic-project/leaderboard",
  },
  history: { number: 11, id: 1001 },
  reviews: { number: 12, id: 1002 },
  scanMode: "refresh",
  apiOrigin: "https://api.github.com",
  apiVersion: "2022-11-28",
  maxPages: 10,
};
```

`runId` and `source` are ASCII identifiers of 1–128 characters, starting with a
letter or digit and then using letters, digits, `_`, `.`, `:`, or `-`. Numeric
identities and numbers must be positive safe integers. The repository slug is
bounded to 200 characters with one owner/name separator. `maxPages` is an integer
from 1 to 100 per collection. The API version is an explicit date-shaped value;
admission does not establish that GitHub supports it. This entrypoint uses the
fixed `/repos/...` REST routes on the supplied origin; it does not add an
Enterprise REST path prefix automatically.

The source pool, installation/repository identity, API configuration, targets,
run ID and canary version participate in the checkpoint binding. The page budget
and `refresh`/`resume` choice do not: after a bounded failure, the operator can
explicitly resume the same accepted prefix with a reviewed higher page budget.
A different run ID cannot borrow that run's completed scan.

## Invoke and inspect

Use the repository's pinned Node/npm toolchain and normal dependency setup, then
build the client and its contract dependency:

```bash
npm run build --workspace @pick-your-ai/contracts
npm run build --workspace @pick-your-ai/github
node apps/pipeline/src/github-source-canary.mjs --host /absolute/private/canary-host.mjs
```

There is no default host, environment credential scan or anonymous fallback.
The command performs only the configured repository/subject GETs and the two
fixed collection GETs. Each collection requests `per_page=100`; next links must
retain the exact repository and subject, approved origin, and fixed two-parameter
page query. Redirects, URL credentials, extra query keys and changing targets are
rejected. The wrapper permits at most `2 * maxPages + 8` HTTP dispatches across
both phases. The existing client's 16 MiB response bound, repository authority,
private cache and durable checkpoint guards still apply.

The command prints one JSON report on success. Its exit code is 0 for `observed`,
2 for `insufficient_sample`, or 1 with only `source_canary_failed` on failure.
The exported `runGithubSourceCanary(host, { signal })` instead rejects with a
fixed `source_canary_...` category; provider exception text, paths, URLs and
credential values are not included. The module loader is trusted code and must
not itself print sensitive information.

| Report field                                                 | Meaning and limit                                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `binding`                                   | Versioned canary identity and a hash of the exact requested scope. These are not a permission grant or a cryptographic attestation of GitHub.                                                                    |
| `repository`, `apiOrigin`, `requestedApiVersion`, `scanMode` | Explicit requested host context. The repository's ID, slug and public state were checked; the installation ID is still host supplied.                                                                            |
| `state`                                                      | `observed` requires both collections to contain more than 100 distinct retained records and to have selected more than one page during the first phase. Otherwise a completed probe is `insufficient_sample`.    |
| `installedCapability`, `sourceEnabled`                       | Always `"unverified"` and `false`. The canary never changes source configuration.                                                                                                                                |
| `passes[].results`                                           | Collection/subject IDs and counts, selected pages in that phase, ordered identity and observation digests, and explicit counts of unknown actor, time or action. Individual records are not returned.            |
| `observations`                                               | Each actual HTTP response's endpoint class, target, page, status, next-page number, digest of its Link header and selected numeric quota headers. Raw Link headers and payloads are not returned.                |
| `quotaBefore`, `quotaAfter`                                  | The client's retained, source/origin-bound resource observations. Missing values stay null and zero stays zero; they are not a reservation, a reconciled global balance or proof that other processes were idle. |

`selectedPages` counts pages supplied to the selector in this invocation. A
deliberate refresh can receive a 304 and select its conditionally validated
cached representation; the response status remains visible in `observations`.
That is distinct from the second phase's completed-checkpoint reuse, which must
select zero pages and make **no collection HTTP request**. The second phase still
reads the repository and both subjects to recheck visibility and native identity.
An empty or mismatched reopened store fails before a collection request can be
used to impersonate retained reuse.

Only native record ID, actor ID if known, normalized UTC timestamp if valid, and
the event/review action are projected into scan checkpoints. The first and
second phases must return exactly the same ordered identity and observation
digests. Duplicates, unexpected retained fields or a changed retained observation
withhold the report. A native review's state remains that review's state; it is
not an aggregate PR decision, accepted outcome, recognition score or historical
completeness guarantee.

The underlying HTTP cache still contains privately retained source
representations, including free text. The scan projection and report do not make
that cache safe to publish. Store all checkpoints under the existing private
retention policy; never add them to Git or public assets.

## Failure, pause and cancellation

The canary uses one request slot and zero retries. It does not induce exhaustion,
shorten an existing deadline, sleep until quota becomes available, or switch
source pools to bypass a pause. A real primary/secondary limit retains the
existing client's pause and accepted prefix, then fails with its fixed category.
A subsequent invocation encountering that retained pause stops before token or
HTTP dispatch. The operator must investigate the actual response and wait for
the existing authorized policy to permit another attempt. No partial report is
returned as successful acceptance evidence.

`refresh` deliberately starts a new scan, preserving normal conditional-cache
behavior. After an incomplete scan, use `resume` with the same binding to retain
the prior accepted prefix. A resumed probe that reads only the final page cannot
claim that its earlier pages were read during that invocation: its first-phase
`selectedPages` records only current selections and its state can remain
`insufficient_sample`. A rejected page save does not deliver a successful canary result. The test retains
the prior committed cursor when a save fails before durable replacement; hosts
remain responsible for atomic writes and recovery from uncertain storage outcomes.

An asynchronous `assertAuthorized` result is denied immediately. A native
Promise's rejection is observed without awaiting it or granting access later;
other objects' `then` getters and callbacks are not invoked. Host
authorization is checked before and after awaited host work and at the
client's existing network, body, cache, quota, checkpoint and delivery boundaries.
Repository views also retain their durable retirement guard. These checks
withhold newly denied results; they do not undo a storage write that began while
authorized or erase earlier retained representations. The host still owns the
coordinated revocation and retention procedure.

SIGINT/SIGTERM request cancellation. The runner passes the signal to resource
opening, token acquisition and HTTP transport, and checks it before admission
and delivery. HTTP requests use the existing 30-second client timeout. There is
no hard overall process deadline: host authorization, opening, token,
checkpoint and close operations must have their own finite bounds, and injected
transport must cooperate with cancellation. The runner waits for started work
to settle before closing its handle; it does not close a store underneath an
unsettled operation. Ordinary handle cleanup must not revoke or disable
`host.assertAuthorized`; the final check intentionally occurs after both handles
have closed. Actual authority loss during cleanup does withhold the report.

## Validation and actual acceptance

The synthetic
[`github-source-canary.test.mjs`](../apps/pipeline/test/github-source-canary.test.mjs)
uses the actual compiled client and file checkpoint store with explicitly
synthetic responses. It covers multiple pages, real store reopening, stable
request capture, route and subject identity checks, unknown values, changed
retained state, explicit resume, denied writes/delivery, retained rate pauses,
cancellation, cleanup and fixed error/CLI boundaries. Run it after building:

```bash
node --test --test-isolation=none --test-reporter=tap apps/pipeline/test/github-source-canary.test.mjs
```

A synthetic pass is implementation evidence only. An actual acceptance record
must independently identify the reviewed executable revision, trusted host
revision, verified installation/permission receipt, UTC start/end, exact public
repository and native targets, authorized API version, actual response metadata,
checkpoint ownership/reopen evidence and any limitations. Review the sanitized
record before making any of it public. Do not attach tokens, host modules,
checkpoint payloads, private bodies or raw downloads. Larger source-family,
GraphQL, permission, rate-limit and public-release acceptance criteria still need
their own authorized observations.

The fixed REST shapes follow GitHub's primary documentation for
[issue events](https://docs.github.com/en/rest/issues/events) and
[pull request reviews](https://docs.github.com/en/rest/pulls/reviews). Consult the
approved API version's actual permissions and endpoint availability when
preparing the host; a documentation reference alone does not verify access.
