# Accepted activity breadth

`aggregateActivityBreadth` in the metrics package derives the registry's
`repositories` and `workstreams` measures from existing accepted source activities.
It is a private calculation API for [#72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72).
The repository/Project mapping and filter foundations from [#37](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/37)
and [#91](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91) retain
their existing source and acceptance boundaries.

The [98 registry definitions](METRICS.md) are unchanged. These two measures remain
descriptive, have no contributor rank and return `publicEnabled: false`. This
increment does not install a source policy, publish a service result, enable a
registry entry, derive collaboration pairs or implement signed `net_lines`.

## Explicit inputs

```js
import { aggregateActivityBreadth } from "@pick-your-ai/metrics";

const result = aggregateActivityBreadth(
  frozenInput,
  {
    version: "reviewed-breadth-policy/v1",
    definitionVersion: reviewedDefinitionVersion,
    sourcePolicies: reviewedSourcePolicies,
  },
  eventTimeScope,
  verifiedFrozenLineage,
);
```

`frozenInput` is the [engine input](metric-engine.md): stable repository and actor
identities, normalized source facts, immutable reviewed corrections, cutoff and
source coverage. Its caller must authenticate source/recognition/correction
evidence, retain source authorization and remove suppressed artifacts before
calculation. The engine's actor suppression and deleted-account rules also apply.
A receipt string or `verified: true` is a reference to that protected upstream
decision; this module does not authenticate a public request.

The source-policy list is required and selects the actual accepted activity
families. Policies must have unique metric IDs, the same definition version and
one shared evidence class: either `qualified` or `reviewed`. Observed, pending and
reviewed activity cannot be combined into an unspecified accepted total. Supported
inputs are contributor-attributed canonical count or sum source policies. Source
interval groupings, derived breadth policies, ratios and duration diagnostics are
rejected. No implicit list of qualifying activity families is chosen.

The existing source policy still supplies role eligibility, evidence class,
per-unit quantity admission and required coverage sources. A sum source requires
an explicit nonnegative safe-integer quantity. An accepted source with a missing
quantity is excluded, retained as `unknown_source_quantity` in the audit and
makes source coverage incomplete; other known activities remain useful. This
API counts distinct activity scopes, not the sum source's line total, so it does
not calculate or certify that aggregate's arithmetic. `selectAcceptedActivityFacts`
uses the engine's correction, duplicate/canonical identity, actor, allowed
repository, scope and independent-acceptance checks. It retains exact source IDs
and rejects cross-policy fact-ID collisions. Raw source facts do not acquire a
different metric ID or a new acceptance receipt.

Both breadth definitions use the source event clock. Selection therefore uses
`occurredAt`, even when a selected source board uses `acceptedAt`. Independent
acceptance must still be known by the frozen cutoff. The supplied scope must use
event context: a current Project association is not historical attribution.
Explicit repository, Project, workstream, actor and role filters remain in force.
For this accepted-activity selector, a workstream filter with no positive match
requires `workstreamsKnown: true` before treating membership as a known negative.
An omitted legacy marker leaves both filtered breadth results incomplete, just
as an explicit unknown marker does. A verified positive OR match remains useful.
Existing source-board and portfolio filter compatibility is unchanged.
Overlapping selected Projects use the existing OR lens without multiplying units.

## Distinct units and unknown mappings

For each admitted actor, repository breadth counts distinct stable `repoId`
values. Names, renamed logins, PR counts and affected file quantities do not
multiply a repository. Each returned unit retains all its selected source proof
IDs, including multiple accepted activities in the same repository.

Workstream breadth counts distinct IDs in the admitted facts' `eventContext`.
Known positive mappings remain useful when mapping coverage is partial. A missing
context, `workstreamsKnown: false`, or an older context without an explicit known
marker also retains the source fact in `unknownEvidenceIds`. Unknown membership
never becomes an invented workstream ID or an assertion that the actor supported
no workstream. Current context cannot fill that gap. Existing bounded mapping
validation and filtered unknown-versus-known-negative behavior are reused.

| Admitted workstream evidence | Value and state |
| --- | --- |
| Two known IDs with complete source coverage and complete mappings | `2`, measured |
| Two known IDs with a source gap or an additional unknown mapping | `2`, partial |
| Only unknown mappings | `null`, unknown |
| Explicitly known empty mappings with complete source coverage | `0`, zero |
| Explicitly known empty mappings without complete source coverage | `null`, unknown |
| No admitted actor activity | No invented actor row |

Source completeness uses the existing enclosing repository/source coverage rules.
All-time remains incomplete. A workstream mapping gap does not erase a known
repository ID. Unknown or ambiguous source qualification remains visible in the
private audit and prevents complete source claims.

## Copy lineage and replay

The final argument is an explicit array, including an explicit empty array when
the protected captured input contains no lineage. It must contain the complete
retained, source-verified lineage for that capture, with an observation time,
original artifact IDs, target artifact ID and source evidence IDs. Repository
fork flags, matching titles, mentions, payload prose and a shared commit are not
substitutes for this evidence. A caller that cannot supply an authorized frozen
capture must not use this API to certify breadth.

Source and evidence identifier arrays must contain distinct, non-empty strings
in every own array slot. Sparse holes, inherited values and explicit missing
values are rejected before a copy can be excluded. Admitted identifiers are
captured once for validation and the retained lineage signature; valid frozen
arrays remain supported without changing the caller's input.

An admitted `mirror_of` or `imported_from` relation excludes its target artifact
from both measures. Original source attribution remains eligible under its own
policy and scope. `squash_of`, `cherry_pick_of`, `reverted_by` and `transferred_to`
are not automatically classified as mirror/import copies. Their ordinary source
and reviewed correction semantics remain intact. Lineage observed after the
frozen cutoff cannot change the earlier calculation.

The result binds the source-policy signatures and the normalized retained
lineage in addition to the dataset, backfill, definition and policy identifiers.
Source-policy order, source observation order and lineage order cannot change
the calculation. A later reviewed exclusion is selected before breadth, so
removing an actor's last eligible source in a repository or workstream removes
that unit; historical replay can still reconstruct the preceding cutoff. The
input facts, policies and lineage are not mutated.

Rows contain selected proof IDs and the unknown mapping bucket. Audits and the
lineage signature may contain suppressed or excluded source identities. The
entire result is internal until a separately reviewed, currently authorized
public projection exists. This change adds no pipeline cache fields or public
contract and does not claim a complete source inventory or live authorization.

## Meaningful synthetic validation

[The focused source cases](../packages/metrics/test/breadth-source.test.js) begin
with the actual GitHub normalizer and independent recognition adapter, then call
the breadth engine. They cover accepted versus raw activity, repository identity,
overlapping Projects, historical versus current context, unknown/empty mappings,
verified copies, frozen lineage, event-time boundaries, reviewed corrections,
suppression, automation, source-policy separation and immutable replay. Explicit
malformed engine fixtures exercise receipt, identity and missing or invalid sum
quantity admission; they are not
claimed as provider observations.

Build the required workspaces before running the focused suite:

```sh
npm run build --workspace @pick-your-ai/contracts --workspace @pick-your-ai/github --workspace @pick-your-ai/metrics
node --test --test-isolation=none --test-reporter=tap packages/metrics/test/breadth-source.test.js
```

The repository's plan, generated-document, Python, formatting and type gates
remain required. Synthetic source/engine evidence does not close #72's remaining
metric cases or the separate public-source, policy and release acceptance gates.
