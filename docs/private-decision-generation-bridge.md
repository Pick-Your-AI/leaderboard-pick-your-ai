# Private persisted PR decision generations

The pipeline can retain the private decision-history producer's result with the exact completed PR scan that selected
it. This bridge supplies immutable inputs for existing protected comparison and publication replay. It does not
activate a public metric, rate, readiness collector, or public decision-history endpoint.

## Host enrollment and provenance

Set `pullRequestDecisionRepositoryIds` when constructing the pipeline to a distinct, bounded list of configured
repository IDs whose families include `pull_requests`. Enrollment is a host decision, separate from metric policy
configuration. The pipeline captures the selected GitHub client, source ID, enrollment, and optional
`decisionHistoryNow` clock at construction. The default clock returns the current UTC instant. Tests can supply a
trusted synthetic clock; changing that clock does not change the database's observation time.

Enrollment requires the actual built-in GitHub source. A custom `source` cannot supply even a structurally valid
native receipt as an enrolled observation. The built-in path calls `capturePullRequestDecisionHistory` after the REST
inventory selects each PR, with its repository, PR number, native subject/author identity, semantic revision, scan ID,
and exclusive event cutoff. It retains the captured read and authorization method identities across awaits.
Authorization is synchronous: it must return `undefined`; an asynchronous result is rejected and its rejection is
consumed.

`migratePipeline` adds the nullable `collection_runs.decision_producer` column under an advisory lock. New enrolled
runs receive an INSERT-only binding containing the producer version, source ID, and data mode. The existing repository
and scan columns bind the enrolled scope. An update trigger prevents changing or filling the binding on an existing
row. Starting or resuming a run compares the constructor-selected binding, including before the completed-run fast
return. A legacy or custom complete run, including a complete empty inventory, cannot become a trusted decision
generation. An unbound store cannot resume a bound run. Existing unmarked runs remain usable by ordinary collection.

The producer prerequisite is the private `capturePullRequestDecisionHistory` implementation and strict contracts
exported by `@pick-your-ai/github` and `@pick-your-ai/contracts`. A receipt-returning host callback is not an
alternative producer.

## Immutable observation and clocks

The ordinary source fact keeps its native `sourceRevision` literal. The decision observation is a separate private
field, `pullRequestDecisionHistory`, admitted into the existing minimized source document before its fact key is
computed. The existing key includes the complete minimized document, so a later scan has a different immutable fact
key even when the selected PR's native revision is unchanged. Each generation also has its exact `collection_items`
membership.

The private observation records the binding and generation plus either a captured native receipt or the producer's
typed unavailable reason. It is strictly detached and bounded before schema traversal or hashing. A typed history
failure does not change the ordinary PR's outer state to unavailable or create an object suppression. A complete
zero-event history, an unavailable history, and a completed REST inventory containing no PRs remain different states.
An incomplete REST inventory cannot be selected as a complete empty generation.

The clock order is:

- **E**: the selected run's exclusive event cutoff.
- **C**: the native producer's completed capture instant, for a captured receipt.
- **O**: the source row's actual PostgreSQL insertion time.
- **F**: the retained observation freeze used by the private input.

A captured observation must satisfy `E <= C <= O <= F`. The database also supplies the completed-run timestamp, which
must fall between its observations and F. The collector reads O as database-generated UTC text with microsecond
precision and strictly validates that text before comparing it with the producer's potentially nanosecond instant. It
never rounds O through JavaScript `Date`, assigns O from C, or accepts a missing clock alias. A persistence chronology
failure rolls back the actual collection transaction; it cannot leave an item or completed page for the rejected
observation.

Unavailable results have no invented capture clock or proof. They still bind the selected run, PR, native revision,
actual O, and F. The bridge preserves the producer's distinction between unavailable and a valid pending decision.
The optional [decided-PR publication projection](public-decided-pull-requests.md) consumes this retained selection
only for an already configured ratio policy; enrollment alone does not activate a public metric.

## Selected completed runs and frozen replay

The runtime passes the actual selected scan IDs from its existing continuation or explicit run plan. The reader
requires one exact completed PR run for every selected repository: repository and family, event cutoff, current access
generation, INSERT-bound producer/data mode, completed count, and item membership must all agree. It does not use the
newest arbitrary PR observation or substitute a newer completed run for a frozen one.

The compact private authorization field, `pullRequestDecisionEvidence`, retains run IDs, source/access generations,
completion and observation times, fact keys, native revisions, and observation hashes. Raw timelines and decision
values stay in the private immutable source rows. The selected reader revalidates the native receipt against the
host-derived binding and generation before selecting its as-of decision. The reader also rechecks current repository
access and object suppression, configuration, and the caller's current authorization through final return.

A frozen unconfirmed run A can resume after a later unconfirmed run B has collected the same PRs. Resume uses A's
saved scan, normalization cache, and observation freeze; it does not recapture decision history or substitute B.
Existing current repository visibility probes still run. The full retained input is checked through the existing
comparison restoration, explanation, publication receipt, and final authorization paths.

Identical public content can reuse an already confirmed snapshot. When the original snapshot has a decision capture,
or a newly enrolled run reaches an older snapshot with no capture, reuse fully readmits the original immutable input
and keeps its exact authorization. It does not combine A's receipt with B's input, overwrite A's evidence, or backfill
a legacy snapshot. Ordinary legacy records with no decision field keep that absence. New publications continue to
retain the actual existing transfer authority alongside the optional decision capture; unsupported decision-only
operator proofs fail closed.

## Private payload and authorization limits

The observation parser limits one private observation to 2,100,000 bytes, 150,000 nodes, depth 20, and arrays of
10,000 members. Collection also bounds admitted page/run decision payloads to 8,000,000 bytes. The selected-generation
SQL reader bounds projected rows to 10,000 and projected payload to 8,000,000 bytes before returning large values to
JavaScript. It then applies structural admission before recursive hashes. These are admission limits, not a bound on
PostgreSQL's internal query work or the process's total heap.

Outer collection admission checks up to 20 prototype links and rejects trapping or revoked proxies before inherited
lookups or the older optional metadata readers. Unmarked legacy facts retain their ordinary accessor and inherited
field behavior. A present decision observation still requires a closed own-data fact. Source IDs, native revisions,
fact hashes, and access generations must match their complete string grammar; access generations are never coerced
from numbers or arrays, and a trailing line terminator is invalid.

Ordinary normalization and pair-history SQL projections omit the raw private observation. Only the explicit bounded
selected-generation reader loads it. Capture-bearing frozen inputs and publication receipts are withheld in SQL when
their payload exceeds 8,000,000 bytes, then structurally admitted before hashing. Existing explanation and comparison
byte limits remain in place; the new capture is admitted before their recursive integrity checks. The optional capture
is copied and compared through the existing closed authorization fields, including cached partial comparisons and
operator replay.

Withdrawal of current authority withholds the protected result even when its historical receipt is intact. Historical
receipt integrity is evidence about the original generation, not permission to bypass current repository,
configuration, privacy, or final confirmation checks.

## Regression boundaries

The admission suite exercises exact microsecond/nanosecond ordering, missing database clocks, immutable producer
bindings, complete-empty legacy/custom conflicts, data-mode mismatch, actual insertion rollback, and captured
authorization-method replacement. It also exercises trapping and revoked proxies at the outer fact, prototype, and
ancestor positions through the real collection path, with zero hook calls and no persisted facts, items, or pages.
Positive plain, accessor, and inherited legacy facts remain collectible. Complete-string and non-coercing generation
checks retain valid controls while rejecting line terminators and non-string access generations. The pipeline
generation suite uses the real native producer, default GitHub source,
CollectionStore, cache, and protected restore path with synthetic network and storage fixtures. Its cases distinguish
later-generation reuse, unavailable and empty histories, frozen A/B resume, same-content reuse, and current
authorization withdrawal.

These synthetic regressions specify the bridge's causal behavior. They do not qualify a live installation, assert
complete production history, establish a public metric policy, or supply deployment acceptance. Those remain separate
work.
