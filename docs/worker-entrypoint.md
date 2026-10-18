# Protected collection worker entrypoint

The worker replaces the log-only scaffold with a bounded collection runner. It is
partial runtime implementation evidence, not an approved host, source grant or
production deployment. It starts no listeners, applies no migrations and creates
no credentials. It does not start the synthetic webhook dispatcher.

After building, run `node apps/worker/dist/index.js --host /absolute/private/host.mjs`.
The host path must identify a regular `.mjs` file, not a symlink or remote URL.
This is trusted executable service configuration: protect the file **and its parent
directories** with the selected host's ACLs. The path check is not a sandbox for
untrusted code. No host is selected by default. Development accepts the same
arguments through `npm run dev:worker -- --host /absolute/private/host.mjs` only
when forwarded by the workspace script; invoking the compiled command directly
is the reproducible entrypoint.

The module exports a default object with these asynchronous methods:

- `authorize()` returns exactly `true` only after checking the actual protected
  host/source approval. An absent callback, false result or exception denies work.
- `open()` constructs the actual `createPipeline` runtime with approved protected
  configuration, token provider, SQL and controls stores, returning
  `{ runtime, close }`. It must clean up any partial acquisition if it throws.
- The returned `close()` closes externally owned SQL pools and controls storage.
  The worker calls it only after `runtime.stop()` successfully drains work. A
  failed drain is an error and does not close a database beneath active work.

The production pipeline's own `verifyConfiguration`, source allowlists, privacy
fences and receipt verification remain mandatory. `authorize()` is an additional
host boundary, not a replacement for those checks. Module import itself runs
trusted code; put resource acquisition in `open()`, not at module top level.
The runner rechecks host authorization after opening resources and before every
batch. Authorization changes during a batch are handled by the pipeline's existing
per-request and publication fences; the runner cannot cancel already issued work.

The default is one `runtime.runOnce({ maxPages: 100 })` attempt. Set `--max-pages`
to an integer from 1 to 10000 to choose the pipeline's existing per-family page
budget. This is a bounded page budget, not a wall-clock deadline. An approved
continuous runner requires an explicit `--interval-ms` from 1000 to 3600000;
it waits that duration after each completed batch, never overlaps batches, and
rechecks authorization before the next one. Transport/provider deadlines remain
the protected host's responsibility.

The production pipeline persists an implicit scan's continuation in its private
SQL store. After applying the additive `migratePipeline` schema, repeated batches
and process restarts reuse the same event cutoff and per-family cursors until all
configured pages and publications finish. One pending row is keyed by the full
approved configuration, data mode and scan mode. A relevant controls configuration,
recognition or source-generation change replaces that row's cycle; unrelated
controls audit/current-state revisions do not restart collection. Explicit
`runOnce({ cutoff })` callers retain their fixed-window contract.

Approved named-period templates resolve inside a new continuation's transaction
from its selected event cutoff, including the complete role and Project scope keys
whose heads are retained. A resumed cycle keeps those exact windows when the clock
crosses into another month. New cycles still require a valid, unambiguous named
window with a whole-second event cutoff; the host must supply that compatible
clock or explicit cutoff. An already valid pending cycle can finish at a later
fractional observation time. These rules do not round the clock or choose the
host's period scheduling policy.

The event cutoff bounds the requested collection window. Once every family is
complete, a separate observation cutoff is frozen for normalization and publication.
A failure after the last page, or after the SQL publication but before its private
confirmation, retains both cutoffs for retry. The pending cycle also binds each
scope's initial head and records its own head changes in the publication transaction.
A delayed batch cannot replace an externally advanced head or another cycle's
result. That conflict fails closed and retires only the superseded implicit token;
a later authorized invocation can begin a fresh scan. Successfully confirmed cycles
also retire their pending row. Collection facts, immutable publications and causal
dispatch receipts are retained under their existing policies.

SIGTERM and SIGINT stop scheduling new work, interrupt idle waits and await the
in-flight batch before draining the runtime and closing external stores. No forced
process termination or shortened database lifetime is used. Failed or blocked
batches terminate with exit status 1 rather than silently retrying forever. A
single attempt that exhausts its page budget reports `worker_collecting`, exit 2;
it does not claim publication. A published batch reports `worker_completed`, and
an orderly signal shutdown reports `worker_stopped`, both exit 0. CLI errors expose
only `worker_failed`; raw provider exceptions, paths and credentials are omitted.
Trusted host code must independently avoid logging secrets.

## Validation and remaining gates

`apps/worker/test/runner.test.mjs` tests bounds, authorization denial/revocation,
sequential lifecycle, signal draining, partial progress and sanitized subprocess
failure with synthetic hosts. Existing pipeline tests establish collection and
publication mechanics independently. `apps/pipeline/test/worker-continuation.test.mjs`
additionally runs the actual compiled continuous worker against a two-page source,
reopens its SQL database/runtime, and verifies last-page/confirmation recovery,
authorization changes, bounds and delayed implicit/explicit publication races.
It also exercises mixed named, role-filtered, custom and all-time scopes through
a month-boundary database reopen, new-window validation before collection, and
selection of concrete scope heads under the continuation row lock.
These synthetic tests do not claim a deployed
end-to-end installation. Build with `npm run build --workspace @pick-your-ai/worker`
and run `node --test apps/worker/test/*.test.mjs`.

Source/controls retention is still separate work. The worker intentionally does
not pick a retention duration, purge source facts or delete pending receipts.
Abandoned configurations' incomplete continuation metadata must participate in the
same protected host retention/backup/deletion policy as the existing private tables;
this change does not select an expiry interval or implement generic derived-store erasure.
`infra/recovery/backup.mjs` already provides authenticated backup expiration with
receipts, but does not solve coordinated PostgreSQL/SQLite/source/cache deletion.
Accepted retention policy, protected host composition, actual source permissions,
operating ownership and deployed shutdown/recovery evidence remain release gates.
Scheduled recent-window overlap, rotating audit policy and actual omitted-webhook
reconciliation acceptance remain separate work in #64. A completed page traversal
still reports partial, historically uncertified coverage and does not manufacture
actor or occurrence-time evidence.
