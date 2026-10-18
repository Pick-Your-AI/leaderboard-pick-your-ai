# Original planning-batch triage audit

## Finding and scope

The original Android and Apple planning batches can be inspected as observed
activity without turning their volume into accepted engineering outcomes. This
audit also found and fixed a concrete source gap: native `issue_type_added`
events were not recognized by the normalizer's existing `issue_typed` action,
and the timeline revision fingerprint did not bind the issue-type target.

The fix maps native additions and removals to the existing raw typed/untyped
actions, keeps the original native action in the source observation, and binds
the type target into collection/hydration revision verification. It changes no
metric definition, grouping interval, acceptance rule, ranking policy or public
release setting. Other native type transitions, including `issue_type_changed`,
remain unsupported until their complete source-specific transition is handled;
the audit observed no such transition.

This is bounded evidence for [LB-08.06](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/104).
It does not complete the active-triager review or the source/acceptance work in
[LB-08.02](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/78),
[LB-08.03](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87),
[LB-08.04](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79) and
[LB-08.05](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/96).

## Retrieval and reproducibility

The inventory contains the 129 original planning-marker issues numbered 1–129
in each of these two repositories:

- [Android issue inventory](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-android/issues?state=all&per_page=100&sort=created&direction=asc&page=1), followed by page 2; select issues carrying `pyai-android-plan:v1` and exclude pull requests.
- [Apple issue inventory](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-apple/issues?state=all&per_page=100&sort=created&direction=asc&page=1), followed by page 2; select issues carrying `pyai-ios-plan:v1` and exclude pull requests.

For every selected issue, read its issue-scoped `/issues/{number}/events`
endpoint with `per_page=100&page=1`. All 258 returned event arrays contained
fewer than 100 records; none failed or required a subsequent page. These reads
completed before the verification time **2026-10-18T14:46:10Z**. They were
sequential batches, not an atomic snapshot. Later issue or Project changes
are outside this capture.

The baseline replay used accepted code
`67b664953b55844c99d2aba81b907accdd7f7062`. The same captured input was replayed
after the bounded type-action fix. The sanitized local replay input has SHA-256
`43e074745557ebb53de856624238f60cb66715780c8c01283ab8bc51e1a2d0a2`.
Raw downloads, account payloads and replay datasets are not committed. The
repository retains these compact coordinates, conclusions and independently
synthetic regression cases.

For each event, the audit joins the issue-scoped endpoint's record to that
issue's captured stable ID and public URL. It passes the event's own actor,
timestamp and target to `normalizeGithubObservation`; issue snapshots are
separately replayed as creation observations. This is an association replay of
retrieved public records, not a new installed-App collection run. The native
type shape was additionally verified through the repository event hydration
endpoint below. The automated regression exercises the actual collection and
hydration adapters with synthetic records.

An exhausted visible REST page is not proof of complete deleted history,
webhook retention, GraphQL history, Project authorization or all-time source
coverage. No complete-coverage record or recognition receipt was supplied to
the replay. Both raw projections therefore retain incomplete coverage and
`publicEnabled: false`.

## Observed corpus

Android's original issues were created on 17 October 2026 between 01:18:45Z and
01:39:58Z; Apple's between 01:40:18Z and 01:44:05Z. Their retrieved histories
also include later activity through the capture described above.

| REST event name | Android records | Apple records |
| --- | ---: | ---: |
| issue_type_added | 129 | 0 |
| labeled | 398 | 486 |
| added_to_project_v2 | 129 | 104 |
| project_v2_item_status_changed | 136 | 143 |
| transferred | 129 | 129 |
| sub_issue_added | 128 | 128 |
| parent_issue_added | 252 | 253 |
| blocking_added | 230 | 221 |
| blocked_by_added | 402 | 354 |
| referenced | 173 | 104 |
| closed | 8 | 9 |
| reopened | 2 | 2 |
| **Total** | **2,116** | **1,933** |

All 4,049 event IDs are unique within their respective retrieved repository
histories. Counts in this table are source records, not accepted work units.
The Android records contain 1,989 `User` and 127 `Bot` actors; Apple contains
1,911 `User` and 22 `Bot` actors. The bot records comprise 147 Project status
events and two Android Project-add events. Account kind alone does not establish
manual, scripted or AI-assisted execution for a `User`, and a bot's occurrence
does not prove a beneficial or harmful outcome.

### Traceable examples

| Source coordinate | Observed boundary |
| --- | --- |
| [Android event 33500141151](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-android/issues/events/33500141151), on issue 1 | Hydrated native `issue_type_added`; event target has ID 906513011 and name Feature. The issue's stable ID and public URL are present independently of its current metadata. |
| [Android issue 47 history](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-android/issues/47/events?per_page=100&page=1), label event 33500190823 | The historical label target contains name/color, without a stable target ID. A current label lookup must not manufacture its historical identity. |
| [Apple issue 30 history](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-apple/issues/30/events?per_page=100&page=1), label event 33500305704 | The same name/color-only limitation occurs in the Apple batch. |
| Android issue 47 history, parent events 33500191217 and 33500194802 | Two distinct records refer to parent issue 2. Repeated records alone do not establish two independently accepted relationship outcomes. The embedded target has repository/number coordinates but no global issue ID. |
| [Android issue 1 history](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-android/issues/1/events?per_page=100&page=1), transfer 33500143745 and status 33500141309 | The REST transfer record lacks proven destination lineage; the bot-authored status record lacks the Project field and before/after values needed for qualified curation. |
| [Apple issue 1 history](https://api.github.com/repos/Pick-Your-AI/pick-your-ai-apple/issues/1/events?per_page=100&page=1), transfer 33500281922 and status 33500279242 | Equivalent destination/status limitations; the public issue container does not authorize inference about another Project or a linked target. |

GitHub's [IssueTypeAddedEvent and IssueTypeRemovedEvent documentation](https://docs.github.com/en/graphql/reference/issues#issuetypeaddedevent)
describes these as actor-bearing issue-type events. This corroborates the event
semantics; it does not substitute for the actual REST shape above or establish
that a particular installed App can read every corresponding source.

## Raw versus qualified replay

| Projection or boundary | Android result | Apple result |
| --- | --- | --- |
| Raw issue creation | 129 stable issue objects | 129 stable issue objects |
| Raw item-triage units before the fix | No measurable units from the type events; 398 label targets unknown | No measurable units; 486 label targets unknown |
| Raw item-triage units after the fix | 129 observed type groups; 398 label targets remain unknown | No measurable units; 486 label targets remain unknown |
| Label applications | 398 unknown facts | 486 unknown facts |
| Other events in this REST triage dispatch | 1,589 explicitly unsupported/unproven records after the fix | 1,447 explicitly unsupported/unproven records |
| Independently qualified or reviewed facts generated | None; no acceptance receipts supplied | None; no acceptance receipts supplied |

The corrected Android type facts count under the unchanged
`triage-raw-state/v1` policy: actor, item and exact raw state in fixed 3,600-second
UTC buckets. They do not turn the 129 type selections into accepted findings,
confirmed bugs, resolved issues, mentoring or code delivery. Label facts retain
unknown qualification and no raw-state value. An empty measurable projection is
unavailable evidence, not a certified zero contribution count. The absence of
generated qualified facts says nothing about whether real accepted work exists
outside these inputs.

The other REST events are retained in the audit inventory and excluded with an
explicit reason. The existing typed GraphQL relationship/Project paths and
trusted enrichment interfaces are separate adapters. This audit did not fill
their missing fields from current state or pretend that they had executed.

## Synthetic adversarial verification

[Native timeline regressions](../packages/github/test/triage-timeline.test.mjs)
exercise collection, target-sensitive revision checks and exact hydration.
Before the fix, three cases fail for the observed missing-action/target-binding
reasons, while the old non-type fingerprint compatibility case passes. The fixed
source passes all four cases. Missing native type identity remains unknown even
when the current issue carries another identified type.

[Fairness regressions](../packages/metrics/test/triage-fairness.test.js) exercise
the normalizer-to-engine boundary:

- A deliberately scripted 3,000-event batch applies and removes labels on 250
  issues for each of a self-triaging User and a Bot. Exact receipt replay adds
  no units. Raw user and automation projections each have 500 defined hourly
  state groups; 500 reversal-marked sessions yield no qualified outcomes.
  Separately seeded accepted PR and resolution boards retain their exact
  15-versus-14 counts, evidence and ranks after the entire batch is appended.
- Self-acceptance is rejected. One explicit synthetic independent correction
  receipt counts once across observation replay and preserves the original raw
  evidence; affected metadata records do not each gain an acceptance receipt.
- A public, allowed, identity-preserving transfer produces transfer lineage
  without another issue creation or a resolution. Private, unknown and
  unapproved destinations produce suppression directives.
- Missing/deleted edit history and a current body cannot manufacture an editor
  or clarification. Even an evidenced raw text edit requires separate
  acceptance before becoming a qualified clarification.
- Restricted linked targets and automatic references produce no intentional
  relationship or resolution facts; the restricted target ID is absent from
  normalized output.
- The disclosure inventory below must cover every canonical metric mapped to
  LB-08 exactly once, so a later category addition cannot silently omit its
  observability limits.

These tests do not prove that the real batch was scripted, certify all source
permissions or replace active-triager review. They establish the stated
adversarial behavior on synthetic inputs.

## Observability inventory

This covers every metric mapped to LB-08 in the canonical registry. A missing
event in this bounded corpus is not evidence that no such work occurred.
Definitions and source-specific units remain authoritative; the item-triage
hourly bucket is not a replacement for every category's grouping rule.

| Metric | What this audit can establish | Remaining observability or acceptance limit |
| --- | --- | --- |
| `issues_opened` | Stable IDs, authors and creation times for 258 issue objects | Exclude PRs and conserve transferred identity; creation does not establish quality or resolution. |
| `accepted_findings` | No acceptance receipt supplied | Requires a specific accepted finding revision and independent evidence. |
| `confirmed_bugs` | No confirmation receipt supplied | A bug label, title or closure cannot establish a confirmed defect. |
| `reproductions` | No accepted reproduction supplied | Requires a reproducible scenario and independent acceptance; comments or steps alone are insufficient. |
| `issue_resolution` | Closure records are visible, but no accepted deliverable is established by this replay | Requires linked accepted PR/decision evidence and correct implementer attribution. |
| `issue_closure_stewardship` | 17 closed and four reopened records are inventoried | The raw REST triage dispatch does not establish the final closure operation; retain state-reason and reopen history in the appropriate adapter. |
| `issue_answers` | No accepted answer supplied | Comment creation is pending evidence; require native selection or the definition's independent issue receipt. |
| `issue_clarifications` | No retained before/after edit or accepted clarification supplied | Current text and deleted history cannot identify a historical clarifier or prove clarification quality. |
| `duplicate_resolution` | No verified canonical duplicate link supplied | Automatic references and close reasons do not replace a proven canonical target and the required outcome evidence. |
| `items_triaged` | 129 identified native type additions; 884 label targets remain unknown | Use the exact raw-state hourly unit. No qualified credit from batching, persistence or current metadata. |
| `labels_applied` | 884 name/color-only historical label applications | Stable event target identity is missing; current label names/IDs cannot repair historical identity by inference. |
| `labels_corrected` | No accepted correction supplied | An apply/remove pair does not prove correctness; require independent correction evidence and deduplicate the reviewed unit. |
| `assignments_coordinated` | No assignment transition in this corpus | Require the transition's assignee identity and actual actor/time; current assignees are not historical coordinators. |
| `milestones_curated` | No milestone transition in this corpus | Require the event's own milestone identity; distinguish membership from milestone definition changes. |
| `title_scope_edits` | No before/after edit in this corpus | Raw evidenced edits and accepted item-day clarification groups remain distinct; deleted edits stay unknown. |
| `reference_links` | 277 automatic referenced records are inventoried | Require verified public endpoints and intentional reference evidence; automatic cross-references are not intentional-link merit. |
| `closing_links` | No verified PR-issue closing relation supplied | Require source event, stable endpoints and direction; do not infer a closing link from nearby prose. |
| `parent_child_links` | 505 parent-added and 256 sub-issue-added records with bounded coordinates | Native endpoint representations need stable identity and conservation; repeated records do not prove new accepted relationships. |
| `blocker_links` | 451 blocking-added and 756 blocked-by-added records | Preserve direction and prove both endpoints public; typed history or independently verified enrichment is still needed. |
| `related_links` | No verified relates-to transition supplied | An informational relation is not a delivery blocker; conserve one unordered relation and verify both endpoints. |
| `project_items_curated` | 233 Project-add records, two Bot-authored | REST records lack the Project/item transition detail used by the separate source adapter; current membership does not identify an editor. |
| `project_status_updates` | 279 status records, 147 Bot-authored | Require actual before/after status, Project identity and explicit automation provenance; actor presence alone is insufficient. |
| `project_field_updates` | No field-level change supplied | Require field identity, actual before/after values and source actor/time; current fields remain context only. |
| `issue_field_updates` | No native issue-field transition supplied | Issue type is a separate typed/untyped action; do not invent field updates from snapshot differences. |
| `project_updates` | No Project status-update artifact supplied | Requires its distinct published artifact, author and publication time; item status changes are different activity. |
| `routing_handoffs` | No accepted handoff supplied | Assignment and mentions do not prove useful routing; require the accepted handoff artifact. |
| `label_taxonomy` | No label-definition event supplied | Applying a label does not create taxonomy work; require stable definition identity and event history or a reviewed receipt. |
| `milestone_definitions` | No milestone-definition event supplied | Membership and closure do not prove a definition change; require the definition's own identity and history. |
| `project_configuration` | No reviewed before/after configuration supplied | Current views/fields/workflows cannot identify a configurator; one accepted change set must not multiply per affected item. |
| `issue_transfers` | 258 transfer records | The captured REST records lack complete public source/destination lineage; an approved public destination must be verified separately. |
| `issue_ordering` | No actor-bearing ordering transition supplied | Current ordering does not identify its author; require accepted public before/after evidence or a verified ordering source. |
| `public_moderation` | No pin/lock transition supplied | Public stewardship is descriptive; no private moderation intake or inferred sanction/quality score. |
| `mentorship` | No consented support receipt supplied | Replies, assignment or volume do not prove mentoring; require consent and independently accepted evidence. |
| `onboarding` | No accepted newcomer-support receipt supplied | A first contribution alone does not identify an onboarding helper or establish helpfulness. |

## Remaining evidence review

The source gap and synthetic invariants are reviewable engineering work. Full
LB-08.06 acceptance still requires an active triager to review the actual traces
and the versioned policy, with any missing authorized history and the four
prerequisite work packages resolved. Do not close the package or enable public
rankings on the strength of this audit alone. No upstream issue, label,
assignment, parent/blocker relationship or Project field is changed by replay.

Related specifications: [GitHub normalizers](github-normalizers.md),
[recognition policy](metric-recognition-policy.md),
[metric definitions](METRICS.md), and
[metric engine](metric-engine.md).
