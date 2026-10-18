# Engineering source reconciliation — 18 October 2026

Scope: [LB-07.06 / #86](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/86). The [minimized source record](engineering-source-reconciliation-2026-10-18.json) retains the selected public PR metadata, review events, file manifests, comparison pins and local results. It contains no review bodies, commit messages, emails, credentials or protected collector records.

Four deliberately selected PRs cover merged and in-progress work in the research and website repositories. The first read window was **15:21:58–15:25:58 UTC**; the follow-up window was **15:25:58–15:31:46 UTC**. Requests were separate observations inside those bounds. They are not an atomic snapshot, an exhaustive repository sample or a claim that source history is complete.

The local physical-diff evaluator is pinned to accepted leaderboard source `bf1a3d2df954873f4469041f082be09f9dffdc9c`, `packages/github/src/physical-diff.ts`, blob `4566dd47ab521a43be6bb619b431439c4d36db2f`. The actual `readPinnedGitDiff` and `classifyPhysicalDiff` functions ran under Node **v24.19.0**, reading isolated public Git objects without changing either source repository. No trusted collector proof, source watermark, metric configuration or publication control was manufactured for this audit.

## Sample observations

Counts below are physical PR changes at the selected comparison pins. They are neither effort estimates nor qualified contribution scores. The four API file manifests matched the corresponding bounded Git comparisons path by path and in all three totals.

| Public source | First observed state and selected head | Files | Added | Deleted | Returned review events at the first read |
| --- | --- | ---: | ---: | ---: | --- |
| [Research #352](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/352) | Merged; `fe4c0ca7e30fd126ca58889facd2e9d878a3b43e` | 1 | 74 | 37 | One `COMMENTED` event, on this head, from the same provider account as the author. |
| [Research #348](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/348) | Open; `197af1a64ca34b4553d571bc60daec9b0f939105` | 2 | 114 | 0 | Five `COMMENTED` events: four from the author's account and one from another account. All five refer to earlier heads. |
| [Website #14](https://github.com/Pick-Your-AI/pickyour.ai/pull/14) | Merged; `850e15cbd73ff407f82566e94306654f63b01821` | 6 | 379 | 0 | The requested public review page returned no records. |
| [Website #294](https://github.com/Pick-Your-AI/pickyour.ai/pull/294) | Open; `73d3ca4d91f29020837828c5e965f38934f39229` | 10 | 309 | 16 | One `COMMENTED` event, on this head, from a different provider account. |

All four source authors use the same GitHub database/node binding, retained in the JSON. The two initially merged PRs also report that provider account as merger. These are separate source roles attached to one account; they do not establish a human operator, manual execution, individual effort or independent acceptance. Mutable logins are unnecessary for the comparison and are not retained.

A source `COMMENTED` review is a feedback event. Its existence does not certify review quality, a requested outcome, a policy approval or an independent human reviewer. The empty website #14 response is recorded as an observed page result; it does not prove that no review occurred through another channel. No reviewer count is used as an accepted-work numerator.

### A merge during the audit

Research #348 changed state during the read window. The follow-up source reports a merge at **2026-10-18T15:27:32Z**, integration commit [`8cf075b1a887459337bfe886958b4c7d7f3c362f`](https://github.com/Pick-Your-AI/pick-your-ai-research/commit/8cf075b1a887459337bfe886958b4c7d7f3c362f), with sole parent `4f1c22bac91783a00384b3037bb64b040250c072`. The original head remained `197af1a64ca34b4553d571bc60daec9b0f939105`; the integration contains the same two-file, 114-addition change.

A sixth review event was subsequently returned: [5563672669](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/348#pullrequestreview-5563672669), submitted at **15:26:46Z** against that exact head by the author's provider account. The earlier different-account review remains tied to `d81f4cb34099e757096a59b7ad1fe3fda5d8509c`. The source record preserves both collections instead of rewriting the earlier open observation into merged work or moving a review onto a later head.

This transition supplies a real example for keeping occurrence, observation, review and integration clocks separate. It does not establish an accepted recognition claim, collector completeness or a policy-authorized historical result. Website #294 was still open at the follow-up read.

## Resolved discrepancy: PR base tip versus merge base

Website #14 exposes a material baseline-selection error. Its returned `base.sha` is `1322c29c9ad25cb5206e2ff2cfd9fcd3e288ace0`, while its head is `850e15cbd73ff407f82566e94306654f63b01821`. Passing those two endpoints directly to a two-tree diff produces **16 files, 379 additions and 591 deletions**. The ten additional paths are unrelated workflow, operations and live-test work present on that base tip. Those deletions are not this PR's delivered changes.

The [pinned GitHub comparison](https://api.github.com/repos/Pick-Your-AI/pickyour.ai/compare/1322c29c9ad25cb5206e2ff2cfd9fcd3e288ace0...850e15cbd73ff407f82566e94306654f63b01821) identifies merge base `5d6994c5c335965fdfc257148a2908b3ebcbea71`. Reading that merge base against the head yields the same **six files, 379 additions and zero deletions** as the PR file manifest. The actual default-branch integration [`f560f2c96e5002ce91076827da3d2d3044b7347a`](https://github.com/Pick-Your-AI/pickyour.ai/commit/f560f2c96e5002ce91076827da3d2d3044b7347a), against its sole parent `65bce2b71e9821deecafd7ced2cdd6a32e1b7d64`, independently yields those same six files and totals.

| Question | Correct pins | Observed result |
| --- | --- | --- |
| What changed on website #14's PR branch? | Verified merge base `5d6994c5…` → head `850e15cb…` | 6 files; +379 / −0. |
| What did its accepted integration add to the default branch? | Actual integration parent `65bce2b7…` → integration `f560f2c9…` | 6 files; +379 / −0. |
| What happens with the inappropriate current base-tip comparison? | Returned base tip `1322c29c…` → head `850e15cb…` | 16 files; +379 / −591, retained only as the negative control. |

The existing diff reader accurately reports the trees it is given. This discrepancy is resolved by selecting the correct source baseline and actual integration boundary. A complete local file manifest cannot itself prove that the caller chose the correct PR or delivery unit. The source normalizer's requirement for independently verified integration pins remains necessary; neither a PR's head nor its returned base tip can substitute for that proof.

Research #352 provides a second accepted integration control. Its PR comparison (`be60732a…` → `fe4c0ca7…`) and its actual receiving comparison (`0510f87c…` → [`4f1c22ba…`](https://github.com/Pick-Your-AI/pick-your-ai-research/commit/4f1c22bac91783a00384b3037bb64b040250c072)) both produce one file with +74 / −37. The JSON retains all full commit IDs, eight actual diff executions and the original inappropriate-baseline result.

## Attribution and qualification disposition

| Candidate measure | What this sample supports | Remaining limit |
| --- | --- | --- |
| Opened PR activity | Source PR identifiers, authors and creation times can be reconciled without using names or emails. | No organization-wide denominator, exhaustive source coverage or runtime policy is established. |
| Merged PR participation and merger operations | The source roles and actual merge times are separately retained for the accepted integrations. | A merge does not prove substantive outcome acceptance, sole authorship or human execution. Open observations stay separate from later integrations. |
| Review participation | Returned public review IDs, provider actors, states, submitted times and reviewed heads are inspectable. | Same-account reviews cannot prove account-independent acceptance; earlier-head reviews are not silently promoted. Review content, quality and actual receiving authority were not evaluated here. |
| Physical added/deleted/changed lines and files | PR manifests and properly pinned local comparisons agree; the incorrect website baseline is explicitly rejected. | Physical counts supply no effort, quality, shared-credit percentage or generated/imported provenance. Signed net remains descriptive. |
| Commit and coauthor attribution | PR heads, integration commits and their boundaries are recorded. | This audit does not resolve author/committer/coauthor trailers or count commits as delivered work. It performs no email/name account linking. |
| Generated imports, formatting and specialist outcomes | Existing classifier controls can be replayed independently of the real sample. | No sampled file was proved generated or imported; path naming and a non-whitespace diff cannot establish original authorship or a specialist acceptance claim. |

The local whitespace-insensitive comparison found no entirely whitespace-only changed file in the valid sampled comparisons. That is a specific Git comparison result, not semantic analysis: non-whitespace formatting, copied content and generated source can still require exclusion. Generated/imported provenance is explicitly `not_established` throughout the JSON; no eligible contribution total is published.

The two existing physical-diff regression methods were separately replayed and passed with zero failures or skips: generated/vendor/lock/binary/import/formatting exclusions, and the bounded local Git fallback including renames and whitespace-only churn. These controls use synthetic inputs and a temporary synthetic Git repository. They validate those mechanics without turning the four public samples into actual generated-import or mass-formatting acceptance evidence.

## Reproduction and remaining acceptance

Use the pinned evaluator source above with locked dependencies. Fetch only the full public commit IDs listed in the JSON into an isolated read-only checkout for each source repository. For each `diffComparisons` row, call `readPinnedGitDiff` with that repository path, `beforeSha` and `afterSha`, then `classifyPhysicalDiff`; keep the intentionally inappropriate baseline as a diagnostic rather than a contribution input. Compare valid PR rows with the retained API file manifests by path, additions and deletions. The default-branch comparisons use the actual integration commit's parent, not an assumed PR base.

The function's existing byte, file and time bounds, disabled external diff/textconv/hooks, and error behavior remain in force. A missing Git object or truncated/bounded-out read must remain a failure or incomplete result. The audit makes no change to the runtime normalizer, metric definitions, source approval, default policy or release manifest.

This advances the real sampling and reconciliation tasks in #86 and publicly explains the discrepancy found in this selected sample. Whole-package acceptance still requires representative generated-contract-import and mass-formatting cases, metric-specific receiving review, any remaining author/committer/coauthor and lineage evidence, approved source/policy scope, and resolution or explicit public caveats for every later sample. The engineering launch gate stays open until its actual attribution and source requirements are met. A reviewed audit can accept these observations and calculations; it cannot supply missing contributor consent, private runtime authorization or source completeness.
