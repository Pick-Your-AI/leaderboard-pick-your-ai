# Candidate metric invariant audit

Refs [LB-19.01 / #72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72).

The new [audit suite](../packages/metrics/test/invariants-audit.test.js) exercises normalized calculation boundaries. All inputs, identities and receipts are synthetic. No metric is publicly enabled by this suite, and no source qualification rule, metric definition, policy or external acceptance is approved by these tests.

For each of the 97 definitions with an implemented aggregation, the named test checks an included independently accepted unit, excluded/self-accepted/out-of-window/future-observed units, duplicate adapter observations, distinct actor attribution, permutation invariance, input immutability, incomplete qualification coverage, and reviewed deletion with historical cutoff replay. Assertions pin expected values independently of the engine implementation: count 1, line sum 7, decided ratio 1, elapsed duration 2 hours. These are calculation tests using deliberately synthetic policies; for example, using the generic `author` role does **not** prove that an actual review metric has the correct source reviewer or approved role policy.

| Aggregation class | Definitions | Additional boundary |
| --- | --- | --- |
| Distinct eligible counts | 90; enumerated individually below | Empty inputs never invent people or activity |
| Eligible line sums | `pr_lines_added`, `pr_lines_removed`, `pr_lines_changed`, `commit_attributed_lines`, `retained_lines` | Zero versus missing source coverage |
| Decided ratio | `pr_accepted_rate` | Genuine closed-unmerged zero versus unknown coverage |
| Elapsed duration | `review_wait` | Same-instant zero versus unknown coverage |
| Unsupported signed net sum | `net_lines` | Explicitly rejected; never silently omitted from the audit |

The zero boundary is tested with one representative sum definition and each diagnostic class. Existing [engine tests](../packages/metrics/test/engine.test.js) cover exact integer/overflow constraints, conflicting quantities/outcomes/durations, readiness censoring, triage interval grouping, self-review, deleted/renamed identities, automation kinds, policy replay and newcomer-history uncertainty. Existing [normalizer tests](../packages/github/test/normalizers.test.mjs) provide source-specific synthetic tests for reviewed coauthors, squash lineage, imported changes and readiness transitions. Registry membership alone is not evidence that a metric has a complete production normalizer.

## Issue acceptance evidence and outstanding work

| Acceptance criterion | Evidence and limit | Remaining prerequisite |
| --- | --- | --- |
| Each public metric has meaningful inclusion/exclusion | Each implemented candidate aggregation now has named boundary tests; every result asserts `publicEnabled: false` | Reviewed enabled-policy inventory and metric-specific source inclusion/exclusion mapping before any enablement; these generic tests do not fulfill semantic acceptance for all 98 definitions |
| Incorrect actor, count or coverage fails | Independent two-actor values, duplicate exclusion, review rejection and zero/unknown assertions | Independent review of tests and the final integrated implementation |
| Sanitized 107 merged-PR entries / 92 unique SHAs; default-branch delivery only | The later [historical stack fixture](historical-stack-fixture.md) and its four adapter cases retain the sanitized source identity relationships, unknown integration times and explicitly synthetic diff overlays | Those source-linked tests do not establish actual eligible historical LOC or an installed source |
| REST/GraphQL automation alias mismatch despite `wasAutomated=false` | [Source boundary tests](../packages/metrics/test/source-boundaries.test.js) join the two synthetic typed Bot aliases by stable identity and exclude both from the user view; login alone remains unresolved | The historical case shape is tested, without claiming a fresh live Project event read or source permission |
| Member assignment without earned work and all four unboarded issue cases | Each historical case label now has an actual synthetic collector → hydration → engine assertion: repository-wide inclusion, PR exclusion, creator attribution, no assignee outcome, and explicit unknown Project context | Payloads and identities are synthetic overlays; current membership and real accepted findings are not asserted |
| Source deletion and policy changes | New deletion/cutoff reversal and existing policy comparison/replay tests | Authenticated correction and policy approval integration evidence |

Issue #72 remains open pending these criteria and its evidence review. These tests do not establish new live source observations, external consent, metric-owner approval, production coverage or deployment.

## Repeated source observations

The [source boundary suite](../packages/metrics/test/source-boundaries.test.js)
also reproduces a calculation defect: two observations of the same fact ID and
revision, differing only in `observedAt`, were quarantined as a conflicting
revision. The four expected source units disappeared from both the aggregate
and the portfolio. The same mismatch affected reobserved correction receipts.

The engine now compares the full semantic fact without its collection timestamp
and retains the earliest observation of the highest eligible revision. Equal
instants with different UTC spellings have a deterministic tie break. Every
other field still participates in conflict detection. The frozen observation
cutoff, independent correction receipt requirement and exclusion state are
unchanged. The pipeline's existing normalization combiner already separates
collection time from fact semantics; this change supplies the same boundary to
the exported engine and portfolio selector.

The ten source boundary cases include three failures before the correction and
ten passes afterward. They test all four historical unboarded case labels,
input ordering, retained first observation, genuine actor/role/artifact/repository/
time/state/receipt/context conflicts, reobserved reviewed corrections, historical
cutoffs, unreviewed revision rejection and typed automation aliases. These
tests do not alter the registry, qualification policy or source allowlist.

Run `npm run build` followed by
`node --test packages/metrics/test/source-boundaries.test.js`. The root and
metrics workspace test commands discover the new `.test.js` file. The earlier
101-test aggregation inventory below remains a separate suite.

## Accepted localization in portfolios

The [localization portfolio suite](../packages/metrics/test/localization-portfolio.test.js)
exercises the actual source normalizer, recognition adapter and metric selector
with two fictional language contributions. It reproduces a separate display
defect: an accepted localization replaced its original observed activity only
when their collection timestamps matched. Recollecting the same source unit
before its independent acceptance left both activities visible in the portfolio.

The selector now matches the original source fact ID, actor, artifact, repository,
role, locale/category state and occurrence time without requiring equal
collection timestamps. It retains the accepted activity once and leaves an
unaccepted language's observed activity visible. The source facts and acceptance
receipts remain intact for audit; board values and independent acceptance rules
are unchanged.

Two of the four focused cases failed before this correction; all four pass
afterward. The cases exercise both input orders, repeated accepted observations,
source/actor/artifact/repository/role/locale/time mismatches, invalid or future
acceptance, reviewed withdrawal, historical cutoffs and input immutability.
These are synthetic adapter-to-engine assertions, not a real localization review
or a claim of public recognition authority. Run `npm run build`, then
`node --test packages/metrics/test/localization-portfolio.test.js`.

## Reproduction

Run from the repository root after dependency installation:

```sh
npm run build --workspace @pick-your-ai/metrics
node --test packages/metrics/test/invariants-audit.test.js
```

The audit contains 101 tests. Both the root `npm test` and the metrics workspace `npm test` discover this `.test.js` file.

## Distinct-count definition inventory

The audit generates a separately named case for every definition below. This is a candidate engine coverage inventory, not a declaration of metric-specific source or public-release coverage.

- `pr_opened`
- `pr_ready`
- `pr_merged`
- `pr_coauthored`
- `commits_integrated`
- `maintainer_merges`
- `direct_changes`
- `reverted_delivery`
- `release_changes`
- `files_changed`
- `prs_reviewed`
- `review_rounds`
- `review_feedback`
- `review_threads_resolved`
- `accepted_suggestions`
- `first_reviews`
- `cross_workstream_reviews`
- `evidence_reviews`
- `issues_opened`
- `accepted_findings`
- `confirmed_bugs`
- `reproductions`
- `issue_resolution`
- `issue_closure_stewardship`
- `issue_answers`
- `issue_clarifications`
- `duplicate_resolution`
- `items_triaged`
- `labels_applied`
- `labels_corrected`
- `assignments_coordinated`
- `milestones_curated`
- `title_scope_edits`
- `reference_links`
- `closing_links`
- `parent_child_links`
- `blocker_links`
- `related_links`
- `project_items_curated`
- `project_status_updates`
- `project_field_updates`
- `issue_field_updates`
- `project_updates`
- `routing_handoffs`
- `label_taxonomy`
- `milestone_definitions`
- `project_configuration`
- `issue_transfers`
- `issue_ordering`
- `public_moderation`
- `decision_records`
- `catalog_proposals`
- `pricebook_proposals`
- `compatibility_proposals`
- `primary_sources`
- `freshness_checks`
- `reproduced_measurements`
- `negative_findings`
- `rights_reviews`
- `assumptions_resolved`
- `market_research`
- `evidence_manifests`
- `documentation`
- `tests`
- `regressions_prevented`
- `accessibility`
- `design`
- `usability`
- `localization`
- `performance`
- `security`
- `automation`
- `discussions_started`
- `discussion_answers`
- `helpful_feedback`
- `mentorship`
- `onboarding`
- `governance`
- `outreach`
- `appreciation`
- `release_stewardship`
- `deployment_work`
- `incidents`
- `maintenance`
- `data_quality`
- `first_contribution`
- `repositories`
- `workstreams`
- `collaborations`
- `active_periods`
