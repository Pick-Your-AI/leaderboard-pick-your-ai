# Metric source semantics: bounded inclusion and exclusion cases

This is a partial implementation of [LB-19.01 / issue #72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72).
The new suite feeds synthetic GitHub source payloads through the actual normalizer
and metric engine. It adds explicit actor, clock, source-proof and grouping
checks for 25 metric IDs. The inventory separately maps 64 other IDs to existing
meaningful source cases, with exact test names and their limits. Nine IDs
remain explicitly deferred in the inventory. The accepted eleven-reference update,
two pair mappings, two accepted-source mappings and the bounded Project item-day
mapping below do not certify all 98 public definitions.

The [machine-readable inventory](../packages/metrics/test/fixtures/metric-source-semantics.json)
accounts for every registry ID exactly once. A metric with new cases has an
explicit policy role, aggregation, date basis, grouping, case identifiers and
remaining scope. Existing-source entries name the positive and negative test,
its path and its remaining scope; the guard checks that those exact tests still
exist. Deferred groups have explicit reasons. The inventory guard rejects missing,
duplicate and unknown metric IDs, stale source references or unregistered cases.
That guard establishes traceability; the separately named assertions establish
the specific behaviors below.

## Why these cases are separate

The existing [metric invariant audit](metric-invariant-audit.md) includes 97
implemented aggregation cases and explicitly rejects the unsupported signed
`net_lines` aggregation. Its generic qualified facts are valuable for engine
invariants, but an author-role fixture cannot establish reviewer attribution,
readiness provenance or the decided-PR denominator. Those tests are retained.

The new [source-semantic suite](../packages/metrics/test/metric-source-semantics.test.js)
uses the existing synthetic engineering payloads. Review cases also call
`createGithubEvidenceNormalizer` with a repository-bound transport fixture, so
the actual immutable-revision, parent and cohort checks run before aggregation.
The suite does not relabel hand-written normalized author facts as source
coverage. The selected policies are explicit test inputs, not approved public
metric policies. `publicEnabled` remains false, all ranks remain null, and
coverage remains incomplete in every result.

## Added boundaries

| Metric                      | Meaningful inclusion                                                                           | Meaningful exclusion or separation                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pr_opened`                 | One creation unit for the PR author, including a draft PR                                      | Missing creation time and a merger-role selection cannot supply author credit                                                                                |
| `pr_ready`                  | A proven first-ready author unit conserved across toggles                                      | Current draft state, unproven toggles and later toggles cannot invent or move the original readiness clock                                                   |
| `pr_merged`                 | One merged PR attributed to its author at the merge clock                                      | Closed-unmerged objects, missing merge time, wrong roles and out-of-window merges do not count                                                               |
| `pr_coauthored`             | One merged coauthor participation with an explicit synthetic verification link                 | Repeated links, primary-author overlap, empty verification and pending work do not create additional delivery                                                |
| `maintainer_merges`         | One operation attributed to `merged_by`                                                        | The sender cannot replace an unknown merger; Bot merger activity remains separate from the user lens                                                         |
| `pr_accepted_rate`          | One merged and one closed-unmerged decision produce 1/2                                        | Pending work and replays do not enlarge the denominator; inconsistent selected history is withheld; no decided sample is unavailable                         |
| `prs_reviewed`              | Submitted COMMENTED, APPROVED and CHANGES_REQUESTED reviews conserve reviewer/PR participation | Self-review, Bot review, pending drafts, wrong roles and incomplete cohorts do not count                                                                     |
| `review_rounds`             | Multiple submissions on one head conserve a round; another head contributes another round      | Missing head proof and dismissed reviews do not become counted rounds                                                                                        |
| `review_feedback`           | Distinct submitted review objects contribute raw feedback groups                               | Replays and pending reviews add no group; raw activity is separate from independent synthetic acceptance, and self-acceptance or rejection cannot qualify it |
| `review_threads_resolved`   | A host-proven transition uses its own resolver and event clock                                 | Current `resolvedBy`, missing event time and author-role selection do not establish a period resolution                                                      |
| `review_wait`               | A proven two-hour pair yields one duration sample                                              | Unresolved PRs are censored, missing readiness is separate, no complete pair is unavailable, and individual ranking is rejected                              |
| `issues_opened`             | The issue's reporter receives its creation unit                                                | Assignment, the closing actor and missing reporter identity do not substitute for the reporter                                                               |
| `issue_closure_stewardship` | An explicit closing transition attributes one operational unit to the closer                   | A closed snapshot does not establish a closer; closing does not establish implementing work, accepted findings or confirmed bugs                             |
| `labels_applied` | Actual synthetic collection and exact hydration retain the editor, label ID and original clock | Missing/unrelated targets, changed revision, wrong subject, current labels and unknown/Bot actors cannot supply user credit |
| `assignments_coordinated` | The observed editor receives a raw assignment unit, separately from the assignee | Current assignments are not history; the separate explicit transition helper does not approve an interval or award completed curation |
| `milestones_curated` | Membership events retain their own actor, milestone and clock; replay is stable | Current membership and milestone-definition changes are not membership events; a reversal remains raw activity, not qualified curation |
| `public_moderation` | Public pin/unpin/lock/unlock facets share one actor/item/UTC-day group | Private moderation, organization blocks, missing source history, wrong interval/policy and ranking are rejected |
| `first_reviews` | The complete default REST sequence identifies the earliest eligible nonself review and shared timestamp ties | Self/Bot/service-account/pending participation, unknown/conflicting identities, incomplete cohorts and invalid clocks cannot manufacture first credit |
| `title_scope_edits` | One webhook edit whose prior title or body text differs from the current text gives its editor one observed triager unit, once across replay and once for a combined title and body edit | Missing, empty, equal, non-text or unrelated-field history, no event proof or clock, unknown or Bot editors in the user lens, private repositories, out-of-window edits and initial issue creation count nothing. The item author is never the editor. Whether the edit is meaningful or one item-day group is not decided |
| `project_updates` | A proven published-update transition gives its publisher one triager unit, once across replay; two publications at different source times give two | No-op or incomplete transitions, missing event proof, unsupported subtypes, Project status, Project item-field and issue-field changes, unknown or Bot publishers in the user lens, private repositories and out-of-window publications do not count. The enriched envelope is synthetic; the optional Project status-update feature, substantive content and native collection are not established |
| `duplicate_resolution` | An intentional, publicly verified, event-proven duplicate relation event is one unit for its triage actor; swapped endpoints and replay of that event stay one. A later removal or un-mark of the same pair is not handled as a reversal and yields a second raw unit | Automatic relations, unverified endpoints, other or malformed relation kinds, missing proof, unknown or Bot actors in the user lens, private repositories, out-of-window marks, a plain issue closure and a `related` link do not count. Preserved unique evidence on the duplicate is not verified, and reversal or un-mark handling remains out of scope (a reversal remains raw activity) |
| `accepted_findings` | An independent receipt on the reporter's issue fact gives one qualified unit on the acceptance clock, once across replay, while the raw issue unit remains | Issue closure alone, rejected receipts, self or unauthorized reviewers, a different actor, missing target or evidence, unverified or ineligible receipts, the observed lens and out-of-window acceptance do not count. Finding substance, versioning and collaborators rest on the reviewer |
| `issue_resolution` | The same receipt contract on the merged deliverable fact credits its author | A closed assigned issue and the closer as a substituted actor do not count, nor do the receipt failures above. The issue-to-deliverable closing link and solution quality are not verified by the gate |
| `issue_clarifications` | The same receipt contract on a proven edit fact credits the editor, while the raw edit unit remains | A raw edit, unchanged text and the item author as a substituted actor do not count, nor do the receipt failures above. Whether the edit improved scope or reproduction is the reviewer's judgment |
| `routing_handoffs` | The same receipt contract on an assignment fact credits the coordinator, while the raw assignment unit remains | A raw assignment notification and the assignee as a substituted actor do not count, nor do the receipt failures above. The handoff note and the receiving owner's acceptance are not verified |

These are bounded source/engine behaviors. For example, the thread case tests a
host-proven transition boundary, not complete reconstruction of actual thread
identity, reopen history or the feedback author's contribution. The duration
case exercises internal engine rows and clocks, not the public team/repository
projection. The feedback cases exercise submitted review objects, not every
standalone inline-comment grouping. The inventory records those limits beside
the corresponding metric rather than marking its entire public definition done.

## Remaining acceptance and ownership

The inventory now has 25 direct-suite entries, 64 existing-source mappings and
nine explicit remaining dispositions. The references include specialized domain
receipt admission, localization, bug/answer recognition, typed history,
participation history, physical diff eligibility, maintenance, automation,
editorial consent and observed Project item days. Each maps a literal positive
and exclusion test; parameterized domain cases also name their metric input.
These are bounded source-review references, not 64 new executions or a claim
that every remaining facet is done.
The original 18/47/33 inventory and its semantic/cache executions remain attributed
to the earlier source. The separately reviewed repository-net helper adds one
reference backed by its own 20 synthetic source cases, producing the historical
18/48/32 inventory. The eleven references added here are present in accepted
`4d1df3b12cf9a7d74b27dfa6463c8dbf263ca3ed`. This update preserves every earlier
direct case and existing reference and does not relabel their executions.

| Newly mapped metric | Meaningful source case | Exclusion and remaining limit |
| --- | --- | --- |
| `issue_transfers` | Exact retained transition, actor and both approved endpoints | Private, unknown, unapproved or unavailable endpoints yield no transfer fact. The admitted fact remains raw; qualified merit, public aggregation and whole COV15 acceptance are separate. |
| `release_changes` | Accepted PR author and immutable release link yield one unit in the publication window | Review before publication fails in both admission paths. Live release coverage and public activation remain separate. |
| `release_stewardship` | A reviewed publisher counts once at publication, separately from the acceptance clock | Missing or stale intake, pending or declined consent, withdrawal and suppression withhold admission. Named-contributor and checklist receipts remain separate. |
| `deployment_work` | Reviewed authored deployment improvement retains its exact source and acceptance clock | Execution-only runs, unknown source use, missing or repeated deployment objects and private free-text environment names used as identifiers fail qualification. Actual permission and public activation remain separate. |
| `incidents` | An approved postmortem or remediation contribution retains its author and acceptance clock | Incident count, personally owned uptime and unapproved narrative fail qualification. Recognition remains a narrative spotlight and rejects ranked output. |
| `project_configuration` | Typed before/after evidence and contributor roles admit one change set across its facets | Generic receipts cannot supply configuration proof. Current Project creator or update time cannot establish later authorship. |
| `issue_ordering` | Audited before/after ordering with exact contributor and source-use bindings admits one accepted-at unit | Legacy receipts and mismatched roles, details, revisions or digests grant no claim or recognized fact. This covers a reviewed plan, not observed drag history. |
| `governance` | Independently reviewed authored governance work retains its accepted decision and version | Permission administration alone, unaccepted proposals and undeclared access rosters fail qualification. Real policy adoption and public activation remain separate. |
| `repositories` | Three accepted source activities yield two stable repositories with all evidence retained | Raw observations, assignment and approval words supply no accepted breadth. Supplied policy and incomplete coverage remain explicit. |
| `workstreams` | Overlapping Project lenses count each supplied event-time workstream once | Raw activity supplies no accepted breadth; unknown historical mapping stays unknown or partial, and current membership cannot replace history. |
| `collaborations` | Accepted author, coauthor and reviewer facts produce two distinct evidenced peers with their pair-formation times | Actual unreviewed source facts yield unknown value/state, incomplete coverage and no peers. Real consent, complete peer history and public activation remain separate. |

The inventory gives the literal positive and negative test names for these
references. Operations entries also name the metric parameter in their shared
test template. Their same-file acceptance-clock cases assert direct aggregate
`rows[].value === 1` and `publicEnabled === false`. Project configuration and
ordering additionally test actual publication using `rows[].result.value === 1`
and deny access after authority withdrawal. These are different return contracts;
neither accessor substitutes for the other. All eleven mappings concern synthetic
source or review inputs, with their remaining limits retained beside each entry.

The eleven-reference inventory reconciliation was accepted through
[#456](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/456) at
`0cea9173d81598f910bf44a377b55c802e5169ff`, producing the historical 18/59/21
inventory. This composition preserves all eleven references and adds the two
relationship-pair mappings below without relabeling either source's executions.

The dedicated [reference/closing source cases](../packages/metrics/test/reference-closing-source.test.js)
add two further mappings for the conserved directed reference and typed closing
pairs. Their literal inclusion and later-window/actor exclusion tests are linked
separately for each metric. The [source-contract guide](relationship-pair-units.md)
describes the synthetic typed endpoint bindings, first-known-history limit and
retained-generation guards. Both pair mappings retain their source completeness,
capability and public-activation limits beside the inventory entries.

A bounded review of accepted `21bdfbe0790d63c5502ab8d24f34f0829b189ae2`
adds two further source references. The [direct-change cases](../packages/metrics/test/direct-changes-source-semantics.test.js)
exercise linked-author credit, the supplied first-integration clock, replay and
PR/ordinary-commit exclusion through the actual normalizer and engine. Their
protected host supplies direct-versus-PR classification; these cases do not
implement a push/DAG collector or complete PR-overlap resolution. The
[helpful-feedback cases](../apps/pipeline/test/helpful-feedback-recognition.test.mjs)
bind exact original/current Discussion observations to synthetic intake whose
enrolled reviewer is distinct from the source author, followed by actual receipt
application/aggregation. Acceptance windows,
distinct authors, self/unlisted-reviewer rejection, duplicate audits and ambiguous
targets have explicit assertions. These references do not establish real
participant consent, live permission, public policy approval or public activation.

Every existing-source mapping names a distinct positive test and a distinct
exclusion test, and the inventory guard rejects an entry whose two names are equal.
Nine mappings that earlier cited one test for both were separated. Seven gained a
new exclusion test with exact-value assertions through the actual normalizer or
engine: `commits_integrated`, `reverted_delivery`, `pr_lines_added`,
`pr_lines_removed`, `labels_corrected`, `related_links` and `discussions_started`.
The added/removed-line inclusion test remains the classifier quantity test; its
exclusion test runs the normalizer and asserts the exact quantity for each
ineligible file class and for unverified integrations, without borrowing the
separate changed-line integration result. Two mappings were re-pointed to existing
tests that already assert their exclusions: `milestone_definitions` now cites the
test showing that applying a milestone to an issue and a missing definition emit no
definition unit (the label-only midnight test is still not substituted), and
`active_periods` now cites the activity-period aggregator tests for distinct UTC
weeks and for unaccepted, suppressed and automated exclusion, rather than the
participation view. Its calendar denominator is context, not a certified fully
covered participation share. The distinct names show where each assertion lives;
they do not widen what a synthetic case proves.

The remaining dispositions retain six derivation/admission prerequisites and
three IDs needing additional semantic cases (`accepted_suggestions`,
`mentorship` and `onboarding`). The accepted eleven-reference review
left 21 entries; the prior composition mapped two pairs plus direct changes and
helpful feedback, leaving 17. The [Project field item-day cases](../packages/metrics/test/project-field-days.test.js)
added one bounded mapping for explicitly enriched synthetic item transitions
under `project-field-day/v1`, leaving 16. The [grouping guide](project-field-day-grouping.md)
preserves the limits: no native `projects_v2_item` collection, installed grants,
complete history, live sender identity, manual-effort classification, independent
correction authorization or public activation is established. A later bounded
batch of issue and triage cases moved seven further IDs into the direct suite
(`title_scope_edits`, `project_updates`, `duplicate_resolution`,
`accepted_findings`, `issue_resolution`, `issue_clarifications` and
`routing_handoffs`), leaving nine. `project_updates` is now covered by the
published-update case above, but only for an enriched synthetic transition; the
optional Project status-update feature, substantive progress content and native
collection remain unproven. The inventory's `remaining_gap.maximum_deferred_metrics`
must equal the deferred count, and the guard also pins a reviewed literal ceiling
(currently nine) that the fixture value may not exceed. The deferred set therefore
cannot grow without editing that literal, and both values are lowered in the same
reviewed change that closes a gap.
The optional retained-line and commit-attributed
lenses are not silently assigned to the adjacent physical-context PRs. A generic
accepted author fact cannot prove an exact suggestion link or a consented
mentorship. The three IDs were reviewed again in the evidence-separation batch and
stay deferred: `accepted_suggestions` counts on an `integrated_at` clock and an
exact link that no admitted source or receipt supplies, and `mentorship` and
`onboarding` need recorded consent and, for onboarding, a first-contribution
milestone tied to a support relationship, while the generic receipt checks only
reviewer independence and target identity. The duplicate case verifies an intentional, publicly verified
relation, not preserved unique evidence on the duplicate.

At the original source lane's ownership check, [#382](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/382)
owned COV15 transfer lineage, alias conservation and privacy suppression;
[#377](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/377) and
[#385](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/385) owned
physical integration/cohort/revision work; [#375](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/375)
and [#367](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/367) owned
release/operations semantics; [#406](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/406)
owned Project configuration; and [#395](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/395)
owned Discussion capability handling. The later [#410](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/410)
maintenance-facet and [#412](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/412)
manual-ordering lanes are also preserved. The narrow shared normalizer changes
below do not adopt or alter those owners' semantics. These links record historical
coordination, not permanent ownership or individual PR delivery. In particular,
#375, #367, #406 and #412 closed without separate merges; the new references prove
that the relevant source is present in accepted `4d1df3b`, without claiming that
each donor PR merged.

`net_lines` now has a [repository-only projection](repository-net-lines.md) and
named signed-subtotal and file-class exclusion assertions. Its supplied verified
default-branch integration envelopes do not establish complete collection or
source authorization. Known subtotals remain partial, missing evidence stays
unknown, and public output/ranking remain disabled. The actor-row engine still
rejects signed net aggregation; that assertion is retained independently of the
new repository-context positive. Issue #72's unchecked requirement
for meaningful inclusion and exclusion evidence for **each** public metric
remains open. The transfer admission pair alone does not establish complete
COV15 acceptance, and applicable public source/policy gates remain separate.
Synthetic fixtures are not live observations, actual
independent contributor acceptance, or production readiness evidence.

## Narrow production corrections

The day grouping already required by `public_moderation` now has its own closed
`public-stewardship-day/v1` registry/schema entry: 86,400-second UTC buckets,
public facets sharing one item, and the existing separately labeled qualified
receipt-clock lenses. The earlier raw triage and definition-day entries stay
exact; the engine uses its existing grouping implementation. Metric definitions,
UI maturity/defaults and public enablement do not change.

Default review hydration supplies an ephemeral, complete exact-PR sequence to
the new first-submission helper. It applies the existing protected account
classification to cohort identities without adding unrelated actors or review
bodies to the output. Earliest eligible submissions share exact-time ties.
An earlier dismissed submission still constrains historical ordering; it does
not promote a later review, and a dismissed observation receives no first-review
credit. A special event-action string cannot substitute for this sequence.

The [review cache migration](review-cache-migration.md) advances to
`review-source-identity/v3`. The original unversioned controls remain, and
integrity-valid version-one and version-two fixtures verify actual PGlite/SQLite
reopen, withholding of obsolete public/private authority, a fresh scan-bound
observation, and preservation of old source/cache hashes. These are constructed
migration fixtures, not runs of the old runtimes. No source, snapshot or old
normalization is deleted.

The pipeline separately binds first-review sequence admission to the latest
completed review observation scan at the frozen cutoff. Native collection
already supplies these per-scan revisions. Custom collectors can use the same
`githubSnapshotRevision(githubReviewRevision(review), request.runId)` contract;
a stable individual-review revision cannot establish current cohort authority.
The dedicated persistence regression covers discovery of earlier reviews,
later arrivals, preserved historical pins and normalizations, and exclusion of
unbound first-review facts and profile evidence while other review metrics stay
available. This does not promote any metric's UI maturity or public enablement.

## Reproduce the focused suite

After installing the repository's locked dependencies, build its imported
packages and run the new test file with the repository-supported Node version:

```sh
npm run build --workspace @pick-your-ai/contracts
npm run build --workspace @pick-your-ai/github
npm run build --workspace @pick-your-ai/metrics
npm run build --workspace @pick-your-ai/ingestion
node --test --test-isolation=none packages/metrics/test/metric-source-semantics.test.js
```

The normal metrics package discovery includes the source suite. For the persistence
regression, also build `@pick-your-ai/service`, then run
`node --test --test-isolation=none apps/pipeline/test/review-cache-migration.test.mjs`.

To rerun the inventory guard and all eight files supplying the eleven new references,
build the repository workspaces and run:

```sh
npm run build
node --test --test-isolation=none \
  packages/metrics/test/metric-source-semantics.test.js \
  packages/github/test/issue-transfer-provenance.test.mjs \
  apps/pipeline/test/release-recognition.test.mjs \
  apps/pipeline/test/release-stewardship-recognition.test.mjs \
  apps/pipeline/test/operations-recognition.test.mjs \
  apps/pipeline/test/project-configuration-recognition.test.mjs \
  apps/pipeline/test/ordering-recognition.test.mjs \
  packages/metrics/test/breadth-source.test.js \
  packages/metrics/test/collaborations-source.test.js
```

No workflow, source permission, public policy, scope baseline or publication
setting changes. The unrelated local Git fixture may require child-process
permission in a restricted execution environment; a blocked fixture is not a
passing original result.
