# Maintenance recognition admission

This implements the merged-change boundary for `maintenance` under [LB-07.05](DELIVERY_PLAN.md#lb-0705-recognize-release-and-maintenance-work). The [versioned metric definition](METRICS.md) specifies merged PR/category participations, credited to the accepted change contributors, with `merged_at` as the event clock. A protected category review can qualify that participation. It cannot create a merge, change its author, or infer human work from CI success.

## Source and attribution

Both the GitHub receipt normalizer and the pipeline require one original `observed` source fact identifying either a `pr_merged` author or a verified `pr_coauthored` participant. Open PRs, closed-unmerged PRs, pending coauthors, issue reports, release publication and the maintainer's merge operation are insufficient maintenance source facts.

The selected fact needs a unique registered contributor and one public pull-request evidence record. Repository, PR, contributor, canonical source event, source metric, role and merge time must agree. Duplicate or mismatched facts and evidence are rejected, including an explicitly ineligible proof or a supposedly original source fact already carrying an acceptance time, reviewer or receipt. The source revision must be present; it can be an opaque collection revision, because a normalized PR observation does not always use a commit SHA. Optional public display metadata may be absent. When present, its source action, activity state and event clock must describe that original merged participation.

Receipt authentication and independent reviewer authorization remain required. The category reviewer is recorded separately from the contributor. A bot author remains a bot; the reviewer and merge operator do not become the change author. Synthetic fixtures remain usable in the isolated test kernel and are still subject to the existing public-runtime provenance fences. These rules do not designate a new human reviewer or infer a maintenance category from a PR title, label or green workflow.

## Clock and conserved unit

Acceptance cannot precede the evidenced merge. The source fact and public evidence retain the merge time in `occurredAt`; the later category review is separately recorded in `acceptedAt` and accepted evidence metadata. Timestamp comparison preserves fractional precision. Period selection therefore follows the merge date, including half-open period boundaries, even if review happens later.

The conserved unit is the maintenance category, repository, PR and contributor. Neither a receipt identifier nor a caller-supplied `changesetId` can mint another unit or combine distinct PRs. Verified coauthors retain separate participant units. This does not introduce a finer category taxonomy or change the 98 metric definitions.

The pipeline processes currently accepted requests in deterministic acceptance-time and request-ID order. All requests, including duplicates, must pass current policy, independent review, exact audit and source validation. Only then does a repeated unit retain its earliest valid receipt. A later invalid duplicate cannot silently disappear behind deduplication. A withdrawn or rejected request supplies no accepted overlay; a direct rejected receipt on a valid source remains explicitly excluded. Raw observations remain unchanged.

## Protected configuration

A maintenance recognition binding selects a protected category, scope, policy version, repository and authorized reviewer list. Its `sourceMetricId` must identify the verified merged participant. Author and coauthor bindings may coexist under one applicable maintenance policy.

The matching policy must use:

| Field          | Required value                      |
| -------------- | ----------------------------------- |
| `metricId`     | `maintenance`                       |
| `version`      | The binding's exact `policyVersion` |
| `dateBasis`    | `occurredAt`                        |
| `groupBy`      | `canonical`                         |
| `rankedStates` | Exactly `["qualified"]`             |

The normal metric-policy validation, definition version, unit, source/role scope and approval requirements also apply. An acceptance-time policy, raw-state ranking or artifact-level grouping fails before a receipt callback is invoked. The shared source validator also runs before a host-supplied receipt callback, so swapping that callback cannot bypass maintenance source admission.

This correction does not enable the definition-only maintenance UI, add a default binding, authorize a new source, or establish live ranking accuracy. The broader [recognition runtime](recognition-runtime.md) and [metric policy](metric-recognition-policy.md) controls remain applicable.

## Previously saved results

Configurations containing a maintenance binding now include `maintenance-merged-participant/v1` in their recognition authority. Other configurations keep their prior fingerprint bytes. Even a maintenance configuration with no accepted request requires the new authority, so old publications cannot be reused as though this source rule had already run.

Existing publication checks withhold current and pinned reads, evidence, exports, policy previews and aggregate explanations when their saved recognition authority differs. The boundary survives closing and reopening both the controls and pipeline stores. A fresh run must recompute accepted overlays under the current rules before the data becomes available again. Recognition withdrawal continues to invalidate the recomputed publication.

No persisted schema migration or source-data rewrite is required. An operator upgrading a configured maintenance deployment must update an obsolete acceptance-time policy through the ordinary approved-policy path before recomputation; old results remain unavailable while that configuration is invalid.

## Verification and remaining acceptance

The regression files use fictional source observations and disposable databases:

- `packages/github/test/maintenance-source.test.mjs` covers direct source denial, accepted/rejected merged participants, merge/acceptance clocks, receipt aliases, distinct PRs and coauthors, optional metadata, opaque source revisions, fractional timing and bot attribution.
- `apps/pipeline/test/maintenance-recognition.test.mjs` covers admission before a custom callback, policy validation, deterministic duplicate handling, reporting periods, the exact prior authority for all 98 bindings, private-reason filtering, persisted public reads and private previews across reopen and repair, and subsequent withdrawal.
- `apps/pipeline/test/confirmed-bug-admission.test.mjs` continues to isolate the existing confirmed-bug source fence while accounting for the independent maintenance marker.

Before this correction, 27 of the original 28 direct cases failed on unchanged accepted source. The pipeline baseline had 3 passing and 24 failing cases: its old acceptance-time policy gate masked deeper source checks, while direct tests established those source failures. These are synthetic causal comparisons, not measurements of a live deployment.

Build the workspace first, then run the three regression files together with Node's test runner. Repository-wide formatting, type checks and the planning/document gates remain required. The actual PR records the executed source and results.

LB-07.05 remains open until its complete evidence gate is met. This change establishes the maintenance admission boundary; it does not independently complete the authored release-note and deployment-operation classification, the governance/deployment/postmortem receipt examples in COV-07, installed-source acceptance, or the prerequisite and affected-owner decisions.
