# Retained-ledger normalization rebuild

The synthetic regression in
[`retained-ledger-rebuild.test.mjs`](../apps/pipeline/test/retained-ledger-rebuild.test.mjs)
addresses the fixed-source rebuild checks in [#85](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/85).
It collects two source facts through the actual collection, normalization, metric
and publication pipeline, then removes only disposable normalization cache rows
from its temporary database. After database close/reopen and runtime recreation,
the same cutoff forces both retained facts through normalization again.

The test compares every normalized document and digest, the full immutable
snapshot document and digest, public board rows, snapshot identity and revision,
and the durable publication receipts. Cache reconstruction must not create a
second publication or change totals. Per-attempt preview input identifiers may
change with the observation cutoff; they are not snapshot content identities.

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
[encrypted recovery procedures](RECOVERY.md). The broader evidence-review gate
for #85 remains open for its real-source and retention/rebuild receipts.
