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
| Sanitized 107 merged-PR entries / 92 unique SHAs; default-branch delivery only | Not represented by this suite; fabricated data with matching counts would not be evidence | Research-owned sanitized evidence with source identity, default-branch integration facts and safe provenance, then adapter/integration assertions |
| REST/GraphQL automation alias mismatch despite `wasAutomated=false` | Engine tests cover positive automation account evidence, but do not establish cross-API alias normalization | Sanitized alias fixture and adapter assertions against both API identities |
| Member assignment without earned work and all four unboarded issue cases | Not established by generic aggregate facts | Identified four source cases, reviewed normalized evidence and end-to-end exclusion/context assertions |
| Source deletion and policy changes | New deletion/cutoff reversal and existing policy comparison/replay tests | Authenticated correction and policy approval integration evidence |

Issue #72 remains open pending these criteria and its evidence review. No research fixture, external consent, metric-owner approval, production coverage or deployment is claimed.

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
