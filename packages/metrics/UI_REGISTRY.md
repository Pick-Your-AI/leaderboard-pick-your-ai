# UI registry and raw triage policy

Refs [LB-03.05](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/38).

## Decision and scope

`src/v1/registry.json` keeps the 98 canonical metric definitions byte-for-value
identical to `planning/metrics-and-ingestion.json`. Definition IDs, attribution,
source clocks and the 98-metric scope are retained. Definition policy
`candidate-0.1.1` corrects only the `items_triaged` unit, numerator and counting
text to describe its existing fixed UTC-hour/raw-state grouping; the earlier
`candidate-0.1.0` text incorrectly advertised actor/item/day groups. UI decisions
live separately under `ui_metadata`, version
`leaderboard-ui/v1`. They do not change planning scope or issue status.

The departments reuse the existing metric families and their existing UI
labels, in contribution-lifecycle order. They are navigation categories, not
team assignments. Synonyms are literal ID/name expansions plus familiar
terms for the existing seven prototype boards. Lead and wall defaults reuse
those same seven examples, now recorded in one registry instead of independent
UI constants. These are reversible engineering defaults, not unresolved
owner choices and not a claim that the metrics are approved for public use.

## Capability boundaries

Every definition has a unique metadata entry. `maturity` is one of:

- `synthetic_verified`: an explicitly listed candidate state/date pair has a
  synthetic verification case. Seven pairs correspond to the existing web
  fixture adapters; `items_triaged` has engine grouping and synthetic
  normalizer-to-engine verification, with no prototype data adapter.
  The 20 protected domain adapters also have source-to-engine verification for
  their canonical qualified units and exact event clocks.
  `localization` additionally has source-to-pipeline and public-evidence
  regressions for qualified PR/language/category units on the source merge
  clock, with no prototype data adapter. Its acceptance clock remains separate
  proof, and raw participation does not qualify for the selectable count.
- `definition_only`: searchable and documented, with no selectable view in
  this UI metadata version. Generic engine support for counting is not proof
  that the definition's particular attribution/grouping is implemented.
- `deferred`: the canonical definition explicitly defers this implementation.

`source_class` categorizes the canonical source design: reconstructible
(including explicitly partial history), since-installation, evidence-reviewed,
conditional/hybrid, or unsupported. It is not an installation permission,
coverage report or proof that a source currently exists. All original source
limitations and launch gates remain visible. `public_enabled` is always false.

The UI-supported pairs are intentionally bounded. `supported_states` and
`supported_date_bases` are projections of `supported_combinations`, never a
Cartesian product. A default must be one of those exact pairs. Empty
combinations mean not measured, never a measured zero. Each consumer also
checks its own data-adapter support; engine-only triage is not silently enabled
in the prototype, and fixture existence cannot invent a registry capability.

The [domain evidence adapters](../../docs/domain-recognition.md#qualification-and-canonical-units)
advertise `qualified/acceptedAt` for 16 metrics and `qualified/occurredAt` for
documentation, tests, freshness checks and security. Documentation and tests use
merge time, freshness uses check time, and security uses public disclosure time.
Their synthetic regressions
normalize a source, apply exact protected review evidence, count one canonical
unit in the metric engine, and preserve that count through repeated reviews and
observation delivery. Each event is included only in its half-open clock window.
Documentation adds this domain combination while retaining its existing
`qualified/acceptedAt` prototype default and overview/wall choices. The prototype
rejects the domain-only pair and all 19 other domain adapters remain not measured
there. These additions preserve all 98 definitions, source classes and public
enablement flags; they supply no installation or policy approval.

`getMetricUi`, `getRegistryDepartments`, `getLeadMetrics` and `selectMetricView`
accept an explicit registry so API consumers can use the version they loaded.
Discovery, synonyms, method sheets, overview leads, supported view controls
and wall choices read that same registry. The prototype accepts route-local
`state` and `date_basis` parameters. Unsupported pairs, unknown dates/states and
unimplemented adapters show an error without fallback. Explicit empty selections
remain in the URL across unrelated scope changes until deliberately corrected. A paired dropdown avoids
constructing an invalid combination from independently valid options. Explicit
invalid wall lists fail as a whole rather than dropping unsupported choices.
The public snapshot API's existing unknown-query rejection remains intact; this
change does not advertise live state/date recomputation.

## API-backed discovery and methods

The public API UI loads the complete registry from `/api/v1/metrics`, validates
its strict contract, and uses that fetched version for department filters,
synonym search, maturity labels and method metadata. A malformed response fails
closed; there is no bundled-registry or prototype-record substitution. Board
responses must also agree exactly with the fetched canonical metric definition
as well as its definition-policy version.

`/leaderboards` and `/methodology` support bounded, URL-persisted `q` and
`department` discovery filters. These search definitions locally, not source
activity, and are never sent to the data API. Unknown departments and discovery
parameters on other routes are rejected, including explicit empty unsupported
parameters. Cross-route links retain the selected scope/snapshot and drop these
route-local discovery filters. A no-match search remains empty.

`/methodology/:metric` reads a definition without requiring a materialized board.
This keeps all 98 methods discoverable, including deferred definitions, while
making no claim that the selected scope has a snapshot, approved policy or
measured zero. Candidate state/date pairs and lead/wall defaults are labelled
as metadata for tested candidate implementations. They are not live API filter
choices, and state/date parameters remain unsupported by the public snapshot
API. An older unresolved registry exposes its definitions with capability
metadata explicitly unavailable, without inferring aliases or departments.

Synthetic unit/contract tests and browser cases cover fetched-only aliases,
all-definition discovery, unmaterialized and unknown methods, malformed
metadata, unsupported filters, and absence of source reads for methods/catalogs.
Browser cases must execute in a browser-capable CI environment; compilation
alone is not a browser or accessibility acceptance result. This addresses the
capability-assumption portion of LB-13.01 (#47), not its entire consultation or
affected-owner acceptance gate.

## COV-09: deterministic raw triage grouping

`grouping_policies` pins `items_triaged` to `triage-raw-state/v1`:

- Only observed state, `occurredAt`, and the triager role are supported.
- Group by stable actor, stable artifact, the exact opaque raw source state,
  and a fixed 3,600-second UTC bucket anchored at the Unix epoch.
- Bucket bounds are half-open: `floor(occurredAt / 3,600 seconds)`. The source
  clock, not observation time or display timezone, determines the bucket.
- Repeated identical state within one bucket counts once. Another literal
  state, artifact or bucket is a different raw group. Case and punctuation are
  not normalized into an invented semantic category. Canonical observation
  deduplication still happens before policy grouping.
- Missing actor/artifact/state/time fails closed with unknown audit evidence.
  The source adapter must supply a proven raw value, not a guessed label.
  Target-dependent label, assignment, milestone and issue-type transitions,
  including removals, also require the action's own stable target identity.
  Missing targets emit unknown facts without a fabricated raw state; another
  metadata field or the item's current snapshot cannot supply that identity.
- Qualified clarification/correction measures remain separate definitions and
  require independent acceptance; this policy cannot manufacture them.

One hour is an explicit conservative anti-repeat choice consistent with the
engine's existing interval fixture, not a claim about effort or a source API
session. Fixed UTC buckets make replay and boundaries deterministic, while the
version pin makes a future interval change explicit. They do not suppress
repetition across bucket boundaries. A sliding-window or transition-aware
policy would need its own version and replay comparison, not a silent edit.
For example, the same actor, item and raw state at 10:00 and 11:00 UTC count as
two distinct actor-item-raw-state UTC-hour triage groups. A repeat at 10:59:59
UTC still belongs to the first group. The canonical unit, numerator and counting
rule advertise these same boundaries, with no subjective qualification claim.

The engine requires the exact `groupingPolicyVersion`, interval, grouping,
state, date and role for `items_triaged`. Registry validation also requires every
advertised triage pair to match that pinned policy. Other metric policies are untouched.

## Compatibility and verification

### COV-12/COV-13 definition-day implementation

`label_taxonomy` and `milestone_definitions` have their own
`triage-definition-day/v1` grouping policies. Each groups one stable
actor/repository/definition per fixed UTC calendar day, combining definition
facets without counting attached item effects. Observed/source-day,
qualified/source-day and qualified/acceptance-day are explicit separate pairs;
receipt time never supplies a missing raw source date. The registry and engine
pin the exact interval, grouping, role and supported pair.

The [full policy](../../docs/triage-definition-grouping.md) records unknowns,
reversals, clock limits, replay and distinct-artifact summaries. Both UI entries
remain definition-only, with no selectable pair or default. Their canonical
definitions and `candidate-0.1.1` remain unchanged; the new grouping has its own
version and does not reinterpret `triage-raw-state/v1` or old snapshots.

### Earlier raw-item definition correction

This is an unreleased candidate registry update, not a migration of published
production snapshots. The corrected definition uses `candidate-0.1.1` so the
previous candidate is never silently reinterpreted. `triage-raw-state/v1` and its
3,600-second behavior stay unchanged; this is a correction to the definition's
advertised meaning, not an interval change. Other metric definitions are
byte-for-value unchanged, but snapshots pin the registry-wide definition version.
Current synthetic fixtures therefore use the new candidate. A snapshot pinned
to `candidate-0.1.0` is rejected by the updated API with
`metric_definition_unavailable`, as the compatibility regression demonstrates.
Retain old snapshots with their original definition version; serve them only
with the matching registry or explicitly recompute under the new candidate.
Do not relabel stored results in place. The definition envelope stays `leaderboard-metrics/v1`;
UI metadata has its own explicit version. Updated readers accept the earlier
`decision_state: unresolved` candidate but give it no selectable capabilities.
Older strict readers must be upgraded before receiving the new candidate
metadata; they fail validation rather than silently guessing. Future changes
to the meaning of these UI capabilities or grouping rules must use a new
metadata/policy version. Existing snapshots are not reinterpreted.

Schema tests reject missing/duplicate mappings, invalid departments, mismatched
state/date projections, unsupported defaults, unsupported wall choices, fake
public enablement and missing triage policy pins. Tests cover all 98 definitions,
all fixture combinations, unavailable definitions, wall rejection, exact raw
states, repeated states, UTC bucket boundaries and permutation invariance.

Real source canaries, authenticated source/acceptance receipts and public
release gates remain separate work. Synthetic test success does not close those
gates or demonstrate actual contributor data.

## LB-03.05 automated acceptance evidence

The package gate is **Automated validation**. Department ordering, synonyms and
lead/wall defaults are implemented candidate metadata, not pending owner gates.
The package's testable boundaries are:

- Source, actor and verification: all 98 definitions retain their source and
  attribution rules; advertised candidate pairs link verification cases. The
  triage integration regressions exercise all eight item target transitions,
  missing identities and same-state cross-hour grouping. Configuration tests
  reject enabled metrics with false/missing `sourceTested` or missing metric
  `evidenceId` at both preview and fresh activation, even after approval.
- Unknown rather than zero: normalizer/engine tests exclude unknown targets;
  engine, API and UI tests distinguish incomplete/unavailable source coverage
  from a measured zero. No catalog definition independently enables a source.
- Shared discovery and filters: registry, API and web tests derive method,
  department, lead and wall choices from the same versioned registry and reject
  unsupported state/date pairs without substitution. Browser registry tests
  remain part of the repository's browser CI, not a claim of this unit run.

See `packages/metrics/test/registry-ui.test.js`,
`packages/metrics/test/triage-normalizer.test.js`,
`apps/controls/test/controls.test.mjs`, `apps/service/test/registry-api.test.mjs`,
`apps/service/test/read-api.test.mjs`, `apps/web/test/registry-ui.test.ts`,
`apps/web/test/registry-api.test.ts` and `apps/web/browser/registry-api.spec.ts`.
Review and required CI against the final revision establish package acceptance.
Actual source canaries, authorization, policy approval and public launch remain
their own gates before public enablement; they are not additional owner gates
invented for this automated-validation package.
