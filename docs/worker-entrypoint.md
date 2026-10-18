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
publication mechanics independently. These host tests do not claim a deployed
end-to-end installation. Build with `npm run build --workspace @pick-your-ai/worker`
and run `node --test apps/worker/test/*.test.mjs`.

Source/controls retention is still separate work. The worker intentionally does
not pick a retention duration, purge source facts or delete pending receipts.
`infra/recovery/backup.mjs` already provides authenticated backup expiration with
receipts, but does not solve coordinated PostgreSQL/SQLite/source/cache deletion.
Accepted retention policy, protected host composition, actual source permissions,
operating ownership and deployed shutdown/recovery evidence remain release gates.
