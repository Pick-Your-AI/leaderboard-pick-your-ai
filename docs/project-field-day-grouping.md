# Project field item days

`project-field-day/v1` supplies the explicit grouping policy for the existing
`project_field_updates` definition: **deduplicated observed item-day field
groups**. It uses the existing
[normalizer](../packages/github/src/normalizers.ts) and
[metric engine](../packages/metrics/src/engine.ts). The
[registry](../packages/metrics/src/v1/registry.json) keeps the same 98 definitions
and the same metric unit, source clock and release conditions.

## Exact unit and clock

The policy forms each unit from:

`(metric ID, repository ID, observed actor ID, stable Project item ID, UTC day)`

The day is `floor(occurredAt in milliseconds / 86,400,000)`, anchored at
`1970-01-01T00:00:00Z`. Windows remain half-open: the start is included and the
end is excluded. A UTC day is independent of collection time, replay time and
the user's display timezone. The existing source boundary accepts canonical UTC
instants with at most millisecond precision; an unsupported offset, finer
precision or missing event date is not silently converted into a source clock.

Different field facets, repeated changes and reversals on the same item by the
same actor on one UTC day share one unit. Changes on another day form another
observed item day. Two actors retain separate attribution. Repository, item and
metric identity remain part of the grouping; a Project containing many items
is not the item identity.

| Admitted observations within the selected scope | Observed item days |
| --- | ---: |
| One editor changes priority and workstream, then reverses priority on one item on one UTC day | 1 |
| The same editor changes the item at 23:59:59.999 UTC and at 00:00:00 UTC | 2 |
| One editor changes two items in the same Project on one UTC day | 2 |
| Two editors change one item on one UTC day | 2, attributed separately |
| Equal before/after JSON values, including reordered object members | No change fact |
| Only a current Project snapshot or an unknown editor/event time | No attributed day |

Canonical source deduplication and reviewed revision selection precede day
grouping. Repository, actor, role, event/current context and time filters also
precede selection of the daily representative. An earlier out-of-scope
observation therefore cannot hide an eligible later change on the same day.
The earliest eligible occurrence, then stable fact ID, supplies the
representative. Other contributing facts remain in the frozen input and
`repeated_policy_unit` audit. Grouping does not delete source observations,
convert reversals into negative credit or infer whether an edit was useful.

## Explicit source and policy authority

This profile consumes already admitted field facts. The protected enrichment
boundary must supply the actual stable Project **item** identity, authenticated
observed sender, source occurrence time, event proof and actual before/after
values for `project_item_field_changed`. Its item locator may point at the
containing Project, but that URL or a Project name does not supply item identity.
An underlying issue, current item creator, current field snapshot or unscoped
numeric fallback is not proof of an item transition. Existing conflicting
canonical identities remain rejected; this profile does not create aliases or
repair the normalizer's generic non-definition numeric namespace.

The source-to-engine fixtures explicitly construct that enriched synthetic
input. They do not parse a native `projects_v2_item` delivery, acquire an
installation grant, establish complete field history or certify a live sender.
The existing retained-field-generation fixture also supplies synthetic
cross-family claims to test cache and recovery authority; it is not a native
Project item admission test.

Only the pair `observed` / `occurredAt` is admitted by this profile. A policy
must specify the exact `project-field-day/v1` version,
`actor_artifact_interval` grouping, 86,400 seconds and sole `triager` role.
Other intervals, groupings, roles, receipt-time substitutions and
qualified/reviewed selections are rejected. The registry likewise cannot
advertise an incompatible selection. No receipt lens is added.

An observed User account can have explicitly automated execution. That remains
a User account and an observed raw field action; the count does not certify
manual effort or independent acceptance. User-account and automation views can
overlap and must not be added together as distinct work.

## Compatibility and verification scope

Hosts must approve and pin the new grouping policy in their complete metric
configuration. Old generic Project field count policies are rejected rather
than silently reinterpreted. Adopting the profile requires the existing
versioned replay/publication process; retained source, policy and snapshot
records are not edited by this change. The other four grouping profiles,
normalizer, grouping arithmetic and current source-generation fences are
unchanged.

The [Project field cases](../packages/metrics/test/project-field-days.test.js)
exercise the real normalizer and engine with explicit synthetic source input:
same-day facets/reversals, midnight and half-open bounds, exact duplicates,
later reobservation, item/editor/repository separation, filter-before-grouping,
missing authority fields, no-op JSON, snapshots and distinct raw subtypes.
The correction case supplies a prequalified synthetic engine revision to check
revision selection before grouping; it does not authenticate a reviewer or
execute a controls/database correction workflow. The
[existing field-value cases](../packages/metrics/test/field-change-source-semantics.test.js)
and [retained-field-generation fixture](../apps/pipeline/test/field-change-generation.test.mjs)
explicitly pin this profile while preserving their original assertions.

The public metric remains `definition_only`, with no selectable combination or
default, and `public_enabled` remains false. Missing or partial history cannot
be displayed as a measured zero. Native custom-field acquisition, its own
source/permission/history evidence and the other separately named capabilities
remain work under [#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79).
A scalar field change is not a published Project progress-update artifact.
This grouping slice does not resolve that publication source, public-policy or
participant acceptance, or the whole [#72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72)
inventory gate.
