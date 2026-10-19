# Metric source semantics: bounded inclusion and exclusion cases

This is a partial implementation of [LB-19.01 / issue #72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72).
The new suite feeds synthetic GitHub source payloads through the actual normalizer
and metric engine. It adds explicit actor, clock, source-proof and grouping
checks for 18 metric IDs. The inventory separately maps 47 other IDs to existing
meaningful source cases, with exact test names and their limits. Thirty-three
IDs still require source implementation, additional cases or an active owner's
integration. This does not certify all 98 public definitions.

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

These are bounded source/engine behaviors. For example, the thread case tests a
host-proven transition boundary, not complete reconstruction of actual thread
identity, reopen history or the feedback author's contribution. The duration
case exercises internal engine rows and clocks, not the public team/repository
projection. The feedback cases exercise submitted review objects, not every
standalone inline-comment grouping. The inventory records those limits beside
the corresponding metric rather than marking its entire public definition done.

## Remaining acceptance and ownership

The inventory now has 18 direct-suite entries, 47 existing-source mappings and
33 explicit remaining dispositions. The 47 references include specialized domain
receipt admission, localization, bug/answer recognition, typed history,
participation history, physical diff eligibility, maintenance, automation and
editorial consent. Each maps a literal positive and exclusion test; parameterized
domain cases also name their metric input. These are bounded source-review
references, not 47 new executions or a claim that every remaining facet is done.

The remaining dispositions distinguish seven IDs with currently owned
implementations, twelve genuine derivation/admission prerequisites (including
signed repository net lines), and fourteen IDs whose complete semantic cases
are still being developed. The optional retained-line and commit-attributed
lenses are not silently assigned to the adjacent physical-context PRs. A raw
relationship cannot establish preserved duplicate evidence; a generic accepted
author fact cannot prove an exact suggestion link or a consented mentorship.

At this source lane's ownership check, [#382](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/382)
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
below do not adopt or alter those owners' semantics. These links record coordination,
not permanent ownership or completed delivery.

`net_lines` has an explicit unsupported-aggregation disposition and a rejection
assertion. There is no invented positive case. Issue #72's unchecked requirement
for meaningful inclusion and exclusion evidence for **each** public metric
remains open, as do the separately owned COV15 correction and applicable public
source/policy gates. Synthetic fixtures are not live observations, actual
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
`review-source-identity/v2`. The original unversioned controls remain, and a new
integrity-valid version-one fixture verifies actual PGlite/SQLite reopen,
withholding of obsolete public/private authority, rehydration, and preservation
of old source/cache hashes. It is a constructed migration fixture, not a run of
the old runtime. No source, snapshot or old normalization is deleted.

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
No workflow, source permission, public policy, scope baseline or publication
setting changes. The unrelated local Git fixture may require child-process
permission in a restricted execution environment; a blocked fixture is not a
passing original result.
