# Automation and tooling recognition admission

The `automation` metric recognizes accepted contributors to merged workflow or tooling changes. Its [versioned definition](METRICS.md) uses merged PR/tooling-category participation and the merge clock. A successful workflow run, a release publication, or the act of merging someone else's PR does not identify the person who authored the tooling change.

This implements the tooling source boundary in [LB-07.05](DELIVERY_PLAN.md#lb-0705-recognize-release-and-maintenance-work). It shares the original-source validator with [maintenance recognition](maintenance-recognition.md), while retaining distinct category units and independent configuration authority.

## Qualifying source and attribution

A protected tooling receipt must target one original `observed` `pr_merged` author or verified `pr_coauthored` participant. The source needs one registered contributor and one eligible public GitHub pull-request proof. The repository, artifact, actor, canonical event, metric, role and merge instant must agree between the fact and the proof. Optional display metadata, when present, must describe the same original observed merge without prior acceptance authority.

An open or closed-unmerged PR, a pending coauthor, an issue report, a release publisher or the merge operator cannot qualify as this source. Missing, duplicated, mismatched or ineligible proof is rejected. A supposedly original fact that already carries an acceptance time, reviewer or receipt is also rejected. Opaque collection revisions remain supported; the source need not invent a commit SHA that the collection did not provide.

The receipt still requires an independently authorized reviewer. The reviewer is recorded as the accepting person, separately from the change contributor. A bot or service-account contributor keeps its source identity and execution mode. Neither the category nor a successful CI job establishes that work was performed manually. Source classification and workflow observations do not automatically create a tooling acceptance receipt.

The direct GitHub receipt normalizer and the pipeline use the same source predicate. The pipeline applies it before calling a host-supplied receipt callback, after the existing protected review and exact audit checks. Raw observations are retained unchanged. Before that admission, publication reconciles contributor records from every original normalized source observation with the existing identity rules. Consistent repeated observations and qualified later login changes yield one admitted actor; conflicting identity, kind, classification or same-run/time aliases still fail under their original source bindings. Automated-execution evidence continues to accumulate.

## Merge clock and category unit

Acceptance cannot precede the evidenced merge, including timestamps with fractional-second precision. Facts and public evidence retain the merge instant in `occurredAt`. The category decision is separately retained in `acceptedAt` and acceptance metadata. Selecting a reporting period therefore follows the merge date rather than the later review date.

The canonical unit contains the category, repository, PR and contributor. Caller-supplied `changesetId` values and receipt aliases cannot create extra tooling units or collapse different PRs and coauthors. The pipeline validates every repeated request before keeping the earliest valid receipt in deterministic acceptance-time and request-ID order. An invalid later duplicate cannot be hidden by deduplication.

One PR participant may have independently accepted maintenance and tooling receipts. Those are two different metric/category units. The shared validator and duplicate set preserve both; neither receipt can replace the other category's authority. The existing 98 metric definitions remain unchanged.

## Protected policy and saved results

A configured tooling binding must select its actual repository, category, scope, policy version, source participant metric and authorized reviewer list. The matching policy requires:

| Field | Required value |
| --- | --- |
| `metricId` | `automation` |
| `version` | The binding's exact `policyVersion` |
| `dateBasis` | `occurredAt` |
| `groupBy` | `canonical` |
| `rankedStates` | Exactly `["qualified"]` |

An acceptance-time policy, raw-state ranking or artifact grouping is rejected before the receipt callback. Other policy approval, definition version, unit and scope checks still apply. This change adds no default binding, new source permission or selectable public tooling view.

Configurations containing an automation binding now include `automation-merged-participant/v1` in recognition authority, independently of the existing maintenance marker. This applies even if no request is currently accepted. Configurations without automation keep their existing fingerprint bytes.

Current and pinned publications, evidence, exports, private previews and explanations require current authority. Earlier saved tooling results remain unavailable after closing and reopening the stores until recomputed under the new source and policy rules. Existing withdrawal and audit-removal fences remain in force after recomputation. No stored-schema migration or raw-source rewrite is needed. An obsolete acceptance-time configuration must be updated through the normal approved-policy path before it can produce a new publication.

## Verification and remaining work

The source cases are shared by `packages/github/test/maintenance-source.test.mjs` and `packages/github/test/automation-source.test.mjs`; each category is independently exercised. `apps/pipeline/test/automation-recognition.test.mjs` covers the protected callback boundary, source periods, category/unit conservation and durable public/private authority across reopen and repair. Existing maintenance and confirmed-bug tests retain their independent category fences. `apps/pipeline/test/merged-change-runtime-actors.test.mjs` additionally sends separate PR observations through the actual collector, normalizer and publication stores for both categories, including repeated authors, unclaimed work, verified renames and identity conflicts.

These tests use fictional observations and disposable databases. The PR records the exact original failing and corrected source executions. Build the workspace before running the tests, and apply the repository's formatting, type, planning and generated-document checks.

LB-07.05 remains open for its complete evidence gate. This correction does not establish release-note or deployment-operation classification, COV-07 governance/deployment/postmortem examples, installed-source acceptance or production ranking accuracy.
