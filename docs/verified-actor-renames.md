# Verified source aliases across cached observations

Refs #36 and #85. This repairs the pipeline's treatment of a GitHub login change.
It does not implement account linking or identity split/merge corrections.

## Failure and identity boundary

A cached artifact can retain a contributor's earlier login while a later artifact
identifies the same GitHub account under its newer login. The pipeline previously
required all actor labels to be identical. That contradiction stopped publication
with `conflicting_actor_metadata`, even when both verified provider identifiers
agreed and the actor's contribution facts were unchanged.

The pipeline now admits a newer login only when the GitHub node ID and positive
numeric account ID agree with the same stable actor, both observations are visible,
and all remaining provider metadata and reviewed classification agree. A missing
node ID, contradictory provider binding, changed account kind, changed visibility,
or changed reviewed classification still fails closed. A display name or email
cannot establish identity, and no email field is read or published by this repair.

## Source ordering and ambiguity

The immutable source-fact row supplies its observation time and first collection
run. These source bindings are carried transiently alongside the normalization;
they are not added to public actors, metric facts, normalized document hashes or
private preview exports. The newest verified observation selects the public login.
The contribution's actor ID, artifact identity, event clock and credit remain the
same. Positively evidenced automated execution accumulates across both observations
and survives a newer login whose own execution mode is unknown.

Conflicting logins from the same collection run remain ambiguous. The pipeline
retains that check across the entire input, so an intervening newer observation
cannot hide an earlier contradiction. Different logins with the same retained
observation time also remain ambiguous. These rules do not manufacture a historical
GitHub rename event or its exact timestamp.

## Frozen replay and privacy

Publication and private frozen identity restoration use the same actor join and
the same immutable source rows. A capture that reconciles aliases binds each exact
source-fact key to its normalization document hash in the private authorization.
Frozen restoration loads
only those pairs from authorized repositories and requires every pair to remain
available. The source-fact keys are opaque hashes; source objects, collection-run
identifiers and observation timestamps are not copied into the frozen export.
An identical normalization from a later source cannot enter an earlier frozen
rename decision. Captures with identical source labels retain their existing
hash-only authorization bytes and join rule, preserving historical publication,
explanation and retry identities. Hash-only authorizations cannot infer a rename
because they did not bind the source ordering that it requires. Required private
aggregate explanations retain and validate the same bounded exact-source binding.
Earlier pinned snapshots keep their original labels and credited evidence; the
current snapshot uses the newer source label without dropping earlier artifacts.
Reopening the database and replaying either frozen policy input produces the same
credit and identity result.

The existing source suppression, contributor privacy, correction and configuration
checks remain in force. Minimal frozen inputs keep labels and account/execution
classes; private provider identifiers and collection-run metadata are not copied
into the preview or its public projection.

## Validation and remaining work

The original disposable synthetic reproduction failed at publication before this
change. `apps/pipeline/test/actor-renames.test.mjs` exercises actual collection,
normalization caches, the metric engine, public API, PGlite/SQLite persistence and
private frozen policy replay. It covers both source row orders, older credited
evidence, a retained historical label, positive automation, restart, conflicting
aliases within one scan or tied observations from distinct scans, and
missing/contradictory provider identity. Repeated actor-only normalization bytes
on a later source cannot change a frozen alias, including after database reopen;
missing source bindings and legacy attempts to infer alias history fail closed. Existing
service-account and cross-observation provider-conflict cases remain applicable.

These are synthetic behavioral tests. They do not certify a live GitHub rename
history, account-link authorization, identity correction receipts, installation
capability or production deployment. The broader #36 work package remains open.
