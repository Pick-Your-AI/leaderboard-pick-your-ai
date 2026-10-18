# Pipeline-owned derived retirement

Refs [#95](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/95).
`PipelineDerivedRetirementStore` removes explicitly bound pipeline payloads after
an already committed [permanent collection retirement](collection-retirement.md).
It supplies a protected host API, database fences, durable manifests and per-store
acknowledgements. It does not select a retention duration, run on a schedule,
retire a source by itself or certify removal from every product store.

## Authority and installation

Apply all ingestion migrations required by the deployed runtime and the ordinary
`migratePipeline(db)` schema first. The current accepted runtime requires
ingestion 001–005, `006_delivery_payload_expiry` and
`007_operator_replay_results`; the derived component itself
has a minimum ingestion prerequisite of 005. Then explicitly call
`migratePipelineDerivedRetirement(db)`, exported by
[the pipeline entry point](../apps/pipeline/src/index.mjs). Its optional
[SQL migration](../apps/pipeline/sql/001_derived_retirement.up.sql) is transactional.
The loader executes its checked-in statement boundaries without splitting
PL/pgSQL bodies. Importing or starting the ordinary pipeline does not apply this
migration or start deletion. Ingestion migrations 005, 006 and 007 remain unchanged.

The optional normalization foreign key keeps exact source facts present until
their final normalization has been removed. A legacy normalization without its
source fact rejects the entire migration. Do not disable a trigger, use an
unvalidated constraint or assign a repository by matching text to get past this
failure. Reconcile that legacy scope under a separately reviewed migration.
The new pipeline authority and receipt tables reject updates and deletes; there
is no rollback that discards recorded retirement history.

The host must use the same six fields as the committed collection decision:
`operationId`, numeric `repositoryId`, original `expectedGeneration`,
`policyVersion`, `authorizationReceipt` and `operatorId`. Every call verifies
those exact retained fields, the advanced source generation and the still
unavailable repository. A fresh authorization callback receives a frozen request
and must return exactly `true` before work and before PostgreSQL commit. A
visibility failure, actor suppression, observation-expiry cutoff or display URL
is not permanent repository-retirement authority.

Use a restricted host database role with only the required pipeline table
read/write privileges, repository/retirement reads and repository row-lock
privileges. Ordinary pipeline writers need reads of the new marker tables for
the invoker guards. Apply schema DDL through the trusted migration owner; do not
grant migration ownership or retirement-table mutation to public request roles.
Functions use a fixed `pg_catalog` search path and qualified application tables.
This component does not grant a new source-fact deletion exception or expose a
public route. Database owners remain trusted; it does not defend against an
owner rewriting tables or disabling protections.

`admit(request, authorize)` persists PostgreSQL admission and then installs the
SQLite marker and guards in the existing synchronous controls transaction. It
returns `derived_writes_fenced`, which is not a payload-removal receipt. A failed
SQLite admission can leave the PostgreSQL admission committed; retry the exact
request. `eraseBatch` performs admission itself before planning work.

## Exact owned scope

| Payload | Selection and disposition |
| --- | --- |
| Normalizations, source modes and artifact links | Join exact fact keys to the retired numeric repository. Remove normalizations before permitting independent source erasure. |
| Unlinked snapshots and frozen input | Validate snapshot identity, revision, document hash, numeric repository IDs, frozen string IDs and typed source-generation authority. A mixed-source snapshot is one immutable object and is removed whole. A snapshot belonging only to other repositories survives. |
| Private preview inputs and results | Bind the retained snapshot/revision, input identity, typed sources, engine-scope hash and content digest. Remove dependent results before their inputs. |
| Aggregate explanations | Bind the exact snapshot and the publication's original full capture hash; that hash is distinct from the frozen-input hash. |
| SQL policy comparisons | Require their snapshot binding and content-addressed comparison identity. |
| Current heads and private confirmations | Remove only the captured snapshot/version. A newer head for another, unretired publication remains intact; the selected old version is acknowledged absent. |
| Pipeline corrections | Use the explicit repository column and exact request key. General controls requests and audit are outside this component. |
| Dispatch-linked snapshot bundle | Retain the snapshot, frozen input, confirmations, private captures, source-derived support and immutable causal/publication proof. Return an explicit incomplete disposition. |

No free-text search, inferred actor identity, broad table truncation or cascading
foreign-key deletion is used. Before planning or resuming deletion, a paged
metadata scan resolves every remaining SQL snapshot and frozen source list.
String-valued numeric SQL IDs, conflicting frozen bindings and orphan private
publication/head confirmations remain unresolved; they block deletion before
causal support rows can be removed. An absent frozen input is accepted only with
its hash-verified durable stage acknowledgement, including an acknowledgement
from another authorized retirement sharing that snapshot. Missing, contradictory
or malformed legacy source bindings block completion. Remaining private source lists are checked as typed
IDs; a malformed value such as a zero-padded repository number is not silently
classified as an unrelated source. Approved/candidate policy-version registries,
minimal publication receipts, controls audit/configuration and the separate
controls public projection remain exact.

[The replay owner](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/pull/296)
uses dispatch bindings and linked snapshots as causal authority. This component
neither erases that proof nor changes its fields. Its invoker write fence rejects
a new binding to an already retired snapshot/source, so a delayed dispatch cannot
turn a partly removed ordinary snapshot into new causal proof. Existing linked
bundles produce `blocked` with `retainedReason: retained_dispatch_authority`;
the operation must not be advertised as complete while that payload remains.
This version records that retained disposition immutably. Releasing such proof
requires the owning replay contract and a reviewed successor policy, not retries
that silently broaden deletion.

## Batches, interruptions and late work

The only public methods are `admit` and `eraseBatch`. Internal selection and
application methods are private. Call
`eraseBatch(request, batchId, limit, authorize)` with a durable, caller-owned batch
ID and a limit of 1–100. A batch processes one stage and at most that many records;
document-bearing stages process one record even if a larger limit is requested.
Each document is validated against a 16 MiB limit. Manifests are at most 256 KiB
and retain only exact keys, typed source bindings and hashes. These are logical
work/payload bounds, not a promise of fixed database scan latency or allocator
usage when a database driver reads corrupt oversized data.

A repository lock and transaction-scoped coordinator lock serialize admission,
selection and application against permanent retirement. The PostgreSQL manifest
commits before deletion begins. Only one unfinished batch is allowed per
operation. The same batch ID and limit resume its exact manifest; a conflicting
limit or another pending batch rejects. Two independently authorized retirements
sharing an immutable snapshot wait for its first pending cross-store registration
instead of creating incompatible registrations. They can subsequently consume
that validated shared binding under their own exact repository authority.

PostgreSQL stages delete and acknowledge in one transaction. A SQLite stage
commits a separate immutable acknowledgement, keyed by operation, batch and
manifest hash, before the final PostgreSQL receipt. If the SQL acknowledgement
fails or authority is revoked afterward, the SQLite deletion is still committed.
The SQL manifest remains pending. Reopen both stores and retry that same batch
with renewed authority: the existing SQLite acknowledgement supplies the original
counts without deleting or counting another record. There is no distributed
rollback claim. A row independently removed by an existing expiry path counts as
`alreadyAbsent`; a changed payload with the same selected identity fails its hash
check and is preserved.

Invoker triggers share the existing repository lock and reject retired writes
to normalizations, source modes/artifacts, snapshots, frozen inputs, heads,
comparisons, corrections and dispatch bindings. SQLite input/result/explanation
guards inspect the permanent source marker. The existing private confirmation
transaction checks the marker before creating any capture, version binding or
head. Thus an already running normalizer or a delayed SQL-publication
acknowledgement cannot recreate removed derived data through those paths.

Each result names its schema, operation, repository, batch, manifest hash, stage,
selected count, removed count, already-absent count and scoped status:

- `applied`: this batch is acknowledged; request a new durable batch ID.
- `owned_scope_erased`: this component's explicit scope is empty. Stop allocating
  batch IDs; exact successful retries return the retained receipt.
- `blocked`: dispatch authority remains. Preserve that incomplete disposition.

Errors and unavailable stores do not become completed receipts. Unknown or
contradictory scope can leave a pending manifest that requires source-owner
reconciliation. Never discard a manifest or change its batch ID to hide an
uncertain store commit. The library returns receipts to its protected caller;
it does not transmit them, contribution payloads or diagnostics to another site.

## Verification and remaining boundaries

Build the workspace packages first, then run the focused embedded suite:

```sh
npm run build
node --test --test-isolation=none apps/pipeline/test/derived-retirement.test.mjs
```

It uses synthetic data, the actual collector/normalizer/metric/public-handler
journeys, on-disk PGlite and SQLite. It checks bounded exact removal, source-erasure
ordering, authority rejection, mixed/foreign source preservation, dispatch-proof
retention, both interrupted store handoffs, reopen/retry, revocation, delayed
writers, newer head replacement, a shared-snapshot registration race, corrupt
bindings and atomic rejection of legacy orphan normalizations. PGlite does not
prove independent PostgreSQL connection locking.

The existing runtime CI PostgreSQL service runs
`derived-retirement-postgres.test.mjs` explicitly. It requires the configured
local `leaderboard_test` service, rejects connection-string query/fragment
overrides before opening a connection, creates only its own uniquely named disposable
database and removes only that database after closing its own connections. It
observes a real separate writer waiting on retirement's repository lock, verifies
foreign writes remain usable, and exercises the SQLite/SQL acknowledgement
failure and reopening against PostgreSQL. With no explicit
`PIPELINE_RETIREMENT_TEST_DATABASE_URL`, those two cases are reported skipped;
the dedicated CI step requires the variable and cannot count missing PostgreSQL
as a pass. No service is created by the test itself.

These checks establish only their exact synthetic executions. Hosted PostgreSQL
results must be inspected before accepting that gate; none of this is deployed
retention evidence. Logical row deletion does not erase PostgreSQL WAL, SQLite
journals/free pages, disks, replicas or backup copies. Checkpoint retirement,
completed intake payload expiry, delivery/observation/run history, causal proof,
controls requests/profiles/claims, search/CDN caches, restore authority, justified
retention windows, scheduling and operational receipts keep their own owners and
acceptance. No tracker or public snapshot is added. The
[cross-store boundary](source-retention-boundary.md) and whole #95 remain open.
