# Metric source semantics: bounded inclusion and exclusion cases

This is a partial implementation of [LB-19.01 / issue #72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72).
The new suite feeds synthetic GitHub source payloads through the actual normalizer
and metric engine. It adds explicit actor, clock, source-proof and grouping
checks for 13 metric IDs. It does not certify all 98 public definitions.

The [machine-readable inventory](../packages/metrics/test/fixtures/metric-source-semantics.json)
accounts for every registry ID exactly once. A metric with new cases has an
explicit policy role, aggregation, date basis, grouping, case identifiers and
remaining scope. Deferred groups have explicit reasons. The inventory guard
rejects missing, duplicate and unknown metric IDs or unregistered case names.
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

These are bounded source/engine behaviors. For example, the thread case tests a
host-proven transition boundary, not complete reconstruction of actual thread
identity, reopen history or the feedback author's contribution. The duration
case exercises internal engine rows and clocks, not the public team/repository
projection. The feedback cases exercise submitted review objects, not every
standalone inline-comment grouping. The inventory records those limits beside
the corresponding metric rather than marking its entire public definition done.

## Remaining acceptance and ownership

The other 85 IDs remain explicitly deferred in this inventory. This is not a
claim that their implementations lack tests: existing normalizer, domain,
recognition and portfolio suites contain substantial source evidence. This
bounded change has not established their complete per-metric inclusion/exclusion
mapping, so neither registry membership nor the 97 generic audit cases is used
to claim that mapping complete.

At this source lane's ownership check, [#382](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/382)
owned COV15 transfer lineage, alias conservation and privacy suppression;
[#377](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/377) and
[#385](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/385) owned
physical integration/cohort/revision work; [#375](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/375)
and [#367](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/367) owned
release/operations semantics; [#406](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/406)
owned Project configuration; and [#395](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/395)
owned Discussion capability handling. Those source paths and acceptance scopes
are unchanged. These links record coordination, not permanent ownership or
completed delivery.

`net_lines` has an explicit unsupported-aggregation disposition and a rejection
assertion. There is no invented positive case. Issue #72's unchecked requirement
for meaningful inclusion and exclusion evidence for **each** public metric
remains open, as do the separately owned COV15 correction and applicable public
source/policy gates. Synthetic fixtures are not live observations, actual
independent contributor acceptance, or production readiness evidence.

## Reproduce the focused suite

After installing the repository's locked dependencies, build its three imported
packages and run the new test file with the repository-supported Node version:

```sh
npm run build --workspace @pick-your-ai/contracts
npm run build --workspace @pick-your-ai/github
npm run build --workspace @pick-your-ai/metrics
node --test packages/metrics/test/metric-source-semantics.test.js
```

The normal metrics package test discovery includes this file. No workflow,
normalizer, engine, registry, policy, scope baseline or publication setting is
changed by this test-and-documentation increment.
