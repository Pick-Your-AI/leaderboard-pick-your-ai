# Triage definition days and artifact summaries

`triage-definition-day/v1` implements the existing actor/definition/day units
for `label_taxonomy` and `milestone_definitions`. The
[canonical definitions](../packages/metrics/src/v1/registry.json) retain their
existing units, facets, clocks and release limits. This policy does not change
`items_triaged` or make either definition selectable in the candidate UI.

The [normalizer](../packages/github/src/normalizers.ts),
[engine](../packages/metrics/src/engine.ts) and
[source-to-engine regressions](../packages/metrics/test/triage-definition-days.test.js)
implement the boundary below. Their synthetic envelopes prove local behavior;
they are not installed webhook canaries or historical source coverage.

## Definition identity and observed units

A definition action owns its label or milestone artifact. Its stable provider
identity persists through rename. An issue included as context cannot replace
that definition or multiply its contribution by the number of attached issues.
A missing definition artifact remains unavailable. A label application or issue
milestone membership change has its own metric and item identity; it emits no
definition-change fact.

The normalizer preserves a supplied GitHub node ID exactly. Without one, it
namespaces the definition's own ID as `github:<repository ID>:<kind>:<ID>`, where
kind is `label` or `milestone`. Positive numeric IDs and the same string spelling
share an identity; nonempty opaque provider strings retain their bytes within
that namespace. Thus label 90 and milestone 90, or labels in different
repositories, cannot alias in evidence or distinct-artifact summaries. A rename
does not change that identity. Missing IDs remain unknown; neither a definition
name nor an attached issue supplies a fallback.

The engine forms each definition group from this tuple:

`(metric ID, repository ID, actor ID, stable definition ID, UTC day)`

The day is `floor(selected timestamp in milliseconds / 86,400,000)`, anchored
at `1970-01-01T00:00:00Z`. Bounds are half-open. This is a UTC calendar day,
not a sliding 24-hour period, a display-timezone day or an ingestion-day bucket.
The existing normalizer and metric engine require canonical UTC instants with
at most millisecond precision. Unsupported offset spellings, higher precision
or invalid dates remain unknown/rejected at that boundary; this change does
not silently truncate them or expand source timestamp support.

Creation, rename, description/color edits, archive/unarchive, state changes and
deletion are facets when their source proves them. All eligible facets for the
same actor and definition on one UTC day share one group. A proven no-op emits
no fact. Repeated reversals cannot add daily groups. They do not become negative
credit, and surviving metadata does not prove correctness. Repeated changes on
another UTC day are another observed day, not another accepted outcome.

| Source observations within the selected scope | Observed groups |
| --- | ---: |
| One actor creates, renames and changes the color of one label on one UTC day | 1 |
| The same actor changes that label at 23:59:59.999 UTC and again at 00:00:00 UTC | 2 |
| Two actors change one label on the same UTC day | 2, attributed separately |
| A same-day rename is accompanied by applications to ten issues | 1 definition group; applications retain their separate item metric |
| One due-date adjustment affects a milestone containing 100 issues | 1 milestone-definition group |
| A definition has a known creator but no proven event actor | Unknown actor; no attributed group |

Canonical event deduplication and reviewed correction selection run before
day grouping. The retained representative is the earliest eligible occurrence,
then stable fact ID; other contributing observations remain in the immutable
input and the `repeated_policy_unit` audit. Reordering input or replaying an
exact duplicate does not add a group. Missing actor, artifact or selected clock
remains unknown and keeps coverage incomplete. An empty partial source cannot
be presented as a measured zero.

## Explicit evidence and clock choices

The existing receipt adapter can independently qualify the same definition
metric. The day policy preserves the canonical definition's separate receipt
lenses instead of substituting a receipt date into raw history:

| Selected state | Selected clock | Required meaning |
| --- | --- | --- |
| `observed` | `occurredAt` | Proven source action and occurrence time |
| `qualified` | `occurredAt` | Independent acceptance plus proven original occurrence time |
| `qualified` | `acceptedAt` | Independent acceptance in a separately labeled acceptance-day lens |

The registry pins those three pairs, the triager role, grouping version and
86,400-second interval. The engine rejects another interval, grouping, version,
role or pair. Registry validation cannot advertise an incompatible pair. The
two UI entries still have no selectable combinations or default; a policy entry
does not certify an adapter, source or public release.

The acceptance path retains its existing authorized-reviewer, actor binding,
receipt and cutoff checks. Raw observations never create a qualified group.
Self acceptance is rejected. A later independent receipt does not invent a
missing source timestamp: only its acceptance-day lens can use the acceptance
time. A source-day policy still excludes that missing time. Pending evidence
remains separate and uses its existing occurrence clock; an unaccepted item
cannot supply an acceptance date or a qualified value.

A webhook event plus its confirming receipt is one underlying definition unit
within a selected lens. The observed and qualified lenses remain separate;
their totals must not be summed. A group alone supplies no quality judgment,
installation permission, complete history or recognition-review authority.

## Sessions and distinct artifacts

`groupTriageTransitions` is a separate descriptive helper. Callers provide an
explicit reviewed policy version, positive adjacency interval and positive
cooldown. It has no silent interval default. Its exact procedure is:

1. Deduplicate exact event IDs. Conflicting records with one event ID reject the
   input; the helper does not pick a convenient copy.
2. Keep events with a known actor, stable artifact and supported occurrence time.
   Unknown events remain named in `unknownEventIds` and in the global raw count.
   They cannot create an actor or distinct-artifact total.
3. Partition by actor, artifact, facet and target. Sort each partition by source
   time, then event ID. Adjacent events join a session when the gap from the
   previous event is less than or equal to the supplied interval. A larger gap
   starts a new session; a chain can therefore be longer than the interval.
4. Mark a session `reversalSuppressed` when its final supplied state equals its
   initial supplied state. Mark `repeatedStateSuppressed` when its terminal state
   was already the terminal state of a previous session within the supplied
   cooldown, measured between their last event times. Equality includes the
   boundary. This is literal source-state comparison, not a correctness classifier.
5. Keep every session descriptive: `qualifiedCandidate` is false and
   `qualifiedOutcomes` is zero, regardless of persistence, volume or suppression.

For example, explicit `intervalSeconds: 300` and `cooldownSeconds: 3600` combine
actions five minutes apart, split actions more than five minutes apart and mark
a repeated terminal state within one hour. Those values are an example supplied
by the caller, not a newly inferred default or a claim about a person's effort.
A production choice needs its own reviewed version and replay comparison.

The helper now returns `distinctArtifacts` for all usable sessions in the
supplied input, plus sorted `actorSummaries` with each actor's `rawActions`,
session count and distinct-artifact count. An artifact used by two actors is
one global artifact and one artifact for each actor. Repeated sessions, facets,
targets or days do not add unique artifacts. Per-actor artifact counts overlap
and must not be summed to infer a global unique count. Artifact IDs must already
carry the source's stable repository/kind namespace; names are not identities.

The global `rawActions` includes exact-deduplicated unknown events. Per-actor
raw counts include only events with usable actor/artifact/time evidence, so their
sum may be lower. Reversal flags do not remove raw observations or erase an
artifact from this descriptive summary. Callers determine the authorized input
scope before invoking the helper; it does not authorize a new repository or
reconstruct absent historical transitions.

## Compatibility and remaining acceptance

`triage-raw-state/v1` retains its exact registry fields, 3,600-second raw-state
buckets and existing behavior. The 98 metric definitions and definition policy
version remain unchanged. The new rule has its own grouping version. Definition
policies must opt into that exact version; old generic configurations are not
silently reinterpreted. Public methodology pages distinguish definition days
from the existing item raw-state grouping and retain unavailable-view labels.

Existing node IDs and non-definition artifact IDs are unchanged. Previously
normalized definitions without node IDs used an unscoped generic/string ID;
replaying their source now emits the repository/kind namespace above. Old and
new materialized identities must not be concatenated into one snapshot or
treated as aliases inferred from a name. A host adopting this policy must
rebuild those source facts within its versioned snapshot/replay boundary.

The regression suite covers definition identity, attached-item separation,
facets/no-ops/reversals, midnight, source-clock limits, namespaces, actor
attribution, duplicates, immutable replay, unknowns, independent receipt clocks
and both global and per-actor artifact summaries. Existing item triage cases
remain controls for the unchanged policy.

For [#78](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/78),
installed label/milestone webhook canaries, endpoint permissions, actor/time and
before/after coverage, missing/deleted/pre-install history and receipt-based
receiving acceptance remain explicit source work. The
[fairness audit](triage-fairness-audit.md) is bounded historical evidence;
[active-triager acceptance in #104](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/104)
and public activation remain separate. This implementation does not close those
gates by presenting synthetic observations as live coverage.
