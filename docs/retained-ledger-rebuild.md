# Retained-ledger normalization rebuild

The synthetic regressions in
[`retained-ledger-rebuild.test.mjs`](../apps/pipeline/test/retained-ledger-rebuild.test.mjs)
address the fixed-source rebuild checks in [#85](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/85).
Each collects two source facts through the actual collection, normalization, metric
and publication pipeline, then removes only disposable normalization cache rows
from its temporary database. After database close/reopen and runtime recreation,
the same cutoff forces both retained facts through normalization again.

The test compares every normalized document and digest, the full immutable
snapshot document and digest, public board rows, snapshot identity and revision,
and the durable publication receipts. Cache reconstruction must not create a
second publication or change totals. Per-attempt preview input identifiers may
change with the observation cutoff; they are not snapshot content identities.

The deleted-actor variant supplies a null source user on one synthetic issue.
Before and after the same cache-loss/restart rebuild, its normalized fact remains
explicitly unknown with no actor or subject-actor ID, its evidence retains null
attribution, and no named actor is reconstructed. Only the other, known actor
appears in the public board and contributor directory, with the same total and
rank. Both retained facts must actually be normalized again; simply reusing a
cached unknown result does not satisfy this regression.

This is a synthetic cache-loss/restart regression, not a production backup restore
or proof that deleted source evidence can be recreated. Retained source records,
mode bindings, approved versioned configuration and publication history are
preserved. Provider enrichment still requires its authorized source availability;
the test does not claim offline rebuilding of missing enrichment. Never apply the
test's cache deletion to a running production database as a recovery procedure.

Historical facts never observed, inaccessible or deleted timelines, vanished
identity evidence, and evidence removed after retention expiry remain
non-reconstructible without an authorized retained backup. See
[ingestion recovery limits](ingestion-completion.md) and
[encrypted recovery procedures](RECOVERY.md).

## Evidence mapped to #85

- Rebuild from sanitized ledger and versioned policies; compare normalized facts
  and snapshot hashes: both pipeline regressions above use the persisted source
  ledger and unchanged policy/configuration, clear the derived normalization cache,
  reopen the database, and verify identical reconstructed facts and snapshot content.
- Installation interruption: the existing ingestion-store tests `resumable
  paginated backfill checkpoints atomically and recovers source failure without
  invented history` and `App revocation and repository removal fence in-flight
  scans and stale reactivation` exercise persisted checkpoint recovery and the
  installation/repository access fences. Revoked installation access is not
  silently restored.
- Renamed repository: `repository rename preserves stable scope identity and scan
  replay is idempotent` retains both source URL versions under one repository ID
  and verifies replay cannot duplicate or rewrite the collected facts.
- Deleted actor: the new pipeline variant above verifies unknown attribution
  through full normalization/publication rebuild, extending `current Project
  fields cannot become historical attribution, deleted actor remains unknown`.
  The source response is synthetic; a null user alone does not prove why an
  account became unavailable or supply its former identity.
- Identical totals for a fixed source snapshot: the two pipeline regressions
  compare public rows, IDs/revisions, full snapshot documents/digests and
  publication receipts before and after actual renormalization. The deleted-actor
  variant additionally requires the known actor's total and rank to stay at one.
- Non-reconstructible cases declared in operations documentation: the limitations
  above and [ingestion recovery limits](ingestion-completion.md) name unobserved
  history, deleted/inaccessible timelines, vanished identities and expired evidence.

The referenced ingestion tests are in
[`store.test.mjs`](../packages/ingestion/test/store.test.mjs). This is a bounded
code-level evidence map for the issue's evidence-review gate. Live source
permissions, production recovery and deployment require their own evidence.
