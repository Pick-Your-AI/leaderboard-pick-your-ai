# Project configuration and native dependency readback

This dated readback verifies the dedicated [Contributor Leaderboard Delivery Project](https://github.com/orgs/Pick-Your-AI/projects/6) for [LB-02.03 / issue #33](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/33). All 133 planned issues are actual Project members exactly once: one program, 20 epics and 112 work packages. The seven single-select fields, their 53 options and all ten saved views match the delivery baseline. All 132 native parent edges and 227 genuine blocked-by edges match the plan, and both graphs are acyclic.

The [structured readback](../planning/project-configuration-readback-2026-10-18.json) contains public identities, option IDs, view definitions, complete per-item field values and relationships, pagination coverage and the explicit observation windows. It omits issue bodies, comments and private content. The baseline at [00d9278a58701560ade3332c175668c7214ff1f5](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/commit/00d9278a58701560ade3332c175668c7214ff1f5) supplies the stable LB IDs and intended configuration; the observed GitHub data supplies execution state.

## Acceptance and preservation

| Requirement | Observed result |
| --- | --- |
| Dedicated Project and required fields | Project number 6, database ID `27113479`, node ID `PVT_kwDOFHg4Xc4BnbgH`; all seven planned single-select fields exist |
| Complete membership without duplicates | All 133 native issue identities match the publication map; all 112 work packages appear once |
| Every field resolves to a live option | All 931 per-item values resolve to the 53 observed option IDs; all 798 non-Status values match the baseline |
| Saved navigation views | All ten names, layouts, filters, grouping fields and board status columns match the planned definitions |
| Native hierarchy | All 132 parent edges match the plan and the inverse native child collections; no unmapped or duplicate relationships |
| Native delivery prerequisites | All 227 blocked-by edges match the plan; both dependency and hierarchy graphs are acyclic |
| Closed prerequisites | All 83 edges pointing to closed prerequisites remain recorded; completion does not erase a genuine dependency |
| Existing references | All 640 baseline contextual-link instances, covering 22 distinct source URLs, remain linked in their issue bodies |
| Existing ownership and progress | All 133 Assignees remain empty. At the membership capture, 105 items were Backlog, 26 Done and two In Progress; no status or owner was reset |

The initial Backlog/no-assignee publication requirement is evidenced by the historical [publication record](PUBLICATION.json), including its 1,644 successful publication checks. That record is a dated initialization receipt. The later [idempotent publication acceptance](publication-acceptance-20261018.md) and this readback preserve subsequent accepted work. They do not interpret the initial Backlog requirement as an instruction to reopen completed work.

## Field and option identities

| Field | Database ID | UI identity | Options |
| --- | --- | --- | ---: |
| Status | `427831012` | `Status` | 6 |
| Priority | `427831084` | `427831084` | 4 |
| Readiness | `427831101` | `427831101` | 5 |
| Level | `427831110` | `427831110` | 3 |
| Phase | `427831124` | `427831124` | 7 |
| Workstream | `427831140` | `427831140` | 21 |
| Acceptance Gate | `427831150` | `427831150` | 7 |

The structured readback records every option name and its exact ID. Each item refers to those observed option IDs, so a valid-looking display label cannot conceal a mismatched field or option. The existing [organization inventory](organization-boundaries.md) supplies the broader Project and repository identities. Database IDs, UI identifiers, option IDs and native GraphQL node IDs are kept distinct; the readback does not invent Project content-item node IDs.

Built-in Title, Assignees, Parent issue and Sub-issues progress remain visible alongside the seven fields. Ownership stays in native Assignees; contextual owner-role text does not assign a contributor.

## Saved views

| View | Database ID | Verified purpose and configuration |
| --- | --- | --- |
| [01 Hierarchy and outcomes](https://github.com/orgs/Pick-Your-AI/projects/6/views/1) | `50761718` | Unfiltered table with native hierarchy enabled |
| [02 Owner and readiness intake](https://github.com/orgs/Pick-Your-AI/projects/6/views/2) | `50761730` | Unassigned, unfinished work grouped by Readiness |
| [03 Delivery board](https://github.com/orgs/Pick-Your-AI/projects/6/views/3) | `50761734` | Unfinished work grouped into Status columns, including Ready |
| [04 Dependencies and decisions](https://github.com/orgs/Pick-Your-AI/projects/6/views/4) | `50761736` | Needs input, Awaiting decision and Blocked work grouped by Workstream |
| [05 Metric sources and coverage](https://github.com/orgs/Pick-Your-AI/projects/6/views/5) | `50761739` | Metric/source/recognition workstreams 03–11 |
| [06 UI and accessibility](https://github.com/orgs/Pick-Your-AI/projects/6/views/6) | `50761741` | Public experience workstreams 13–16 |
| [07 Security and privacy](https://github.com/orgs/Pick-Your-AI/projects/6/views/7) | `50761742` | Administration, privacy and security workstreams 17–18 |
| [08 Verification and launch](https://github.com/orgs/Pick-Your-AI/projects/6/views/8) | `50761744` | Verification and operations workstreams 19–20 |
| [09 Decisions to resolve](https://github.com/orgs/Pick-Your-AI/projects/6/views/9) | `50761746` | Awaiting decision work grouped by Workstream |
| [10 Operations and corrections](https://github.com/orgs/Pick-Your-AI/projects/6/views/10) | `50761747` | Administration/corrections and operations workstreams 17 and 20 |

The readback retains the exact saved filters and field IDs, including full workstream names. The Ready queue is a Status column on the delivery board; the intake view exposes missing ownership and readiness. Neither view implies that an unassigned issue has an accepted operator.

## Collection and verification

Native identity and relationship reads ran from **09:59:05 to 10:04:04 UTC on 2026-10-18**. Every issue's blocked-by and sub-issue collection was read: 266 collections and 266 terminal pages, each below the requested 100-item page size. Initial and final issue collections were fully paginated, and native relationship summaries were reconciled with the actual edge sets.

Actual Project membership was read from **10:14:59.014 to 10:19:46.427 UTC** through nine overlapping windows in the unfiltered table. Hierarchy display was temporarily turned off without saving the view, allowing the audit to distinguish actual members from descendants that a hierarchical view may display. The captured positions cover 1–133 without gaps; repeated rows agree on their native identities, and the final scroll reached the loaded table bottom. The temporary display change was discarded and saved hierarchy remained enabled.

The contextual-link read ran from **10:35:18 to 10:35:20 UTC**. Three complete issue/PR pages contained all 133 issues; their Markdown links retained all 640 baseline reference instances. Existing issue database IDs, node IDs, titles, parents and empty Assignees also remained unchanged at that later read.

Deterministic reconciliation checked the complete stable-ID map, native identities, all option assignments, non-Status values, saved view semantics, edge uniqueness, inverse parent/child agreement, topological ordering and reference preservation. Repository validation additionally runs:

```bash
python scripts/validate_plan.py
python -m unittest discover -s tests -v
python scripts/render_docs.py --check
```

The observation windows are not an atomic transaction. Issues #27 and #28 closed during the native read and were retained as legitimate progress. Issue #23 closed after the membership capture, following its separately reviewed inventory delivery; the later native-state change is recorded without rewriting the earlier snapshot. Live GitHub remains authoritative after these dates.

## Boundaries

This verifies Project configuration and the recorded plan relationships. It does not certify upstream source permissions, ingestion correctness, native device execution, hosting or a public release. All live completion decisions remain tied to their own issue gates. No issue bodies, assignments, field definitions or relationships were changed by the configuration readback, and no separate ownership system was created.
