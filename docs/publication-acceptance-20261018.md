# Issue publication acceptance

This record covers [LB-02.02 / #29](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/29), the existing issue-publication implementation merged in [PR #161](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/161). Its implementation is inspected at `364df873bb736cd4a077a9de7bcfd8bb8115171d`. It does not accept repository security staffing, Project configuration, source installation, or public-service release work.

## Current source verification

The [sanitized native GitHub readback](publication-readback-20261018T035627.json) was completed at **2026-10-18T03:56:27.177Z**. The repository issue-list endpoint was read with `state=all`, ascending creation order, and 100 rows per page. The three responses contained **100, 78, and 0 source rows**; the final empty page established exhaustion. Excluding pull requests left **133 issues: 122 open and 11 closed**. Every expected stable LB marker appeared exactly once, and historical publication bindings matched the live issue numbers and immutable IDs.

All **133 native-parent endpoints** were read separately. The program returned the explicit `No parent issue found` response. Each of the other **132 issues** returned its intended parent. The top-level program is the existing documented root exception to the issue criterion's “one parent” wording; no self-parent or extra hierarchy level is introduced.

The actual captured inventory was supplied to `scripts/publish_plan.py` twice. Both executions returned the same complete bindings and **`actions: []`, `noop: true`, 133 existing issues, and 132 verified parent edges**. The checked-in receipt contains body hashes and identity/parent/state columns, not raw issue bodies, user records, or authentication material. The raw inventory remained temporary.

## Task and criterion evidence

| Issue requirement | Evidence and result |
| --- | --- |
| Render issue bodies from stable local LB identifiers | `specs_from_backlog` and `render_issue` in [the publisher](../scripts/publish_plan.py) retain the LB marker, outcome, task checklists, criteria, references, and initial readiness wording. Live readback found all 133 unique expected markers. |
| Create one program, native epic children and work-package children | Actual repository readback and the [baseline publication map](PUBLICATION.json) agree on one root, 20 epics, 112 work packages, and all 132 intended parent edges. |
| Store small implementation and verification steps as checklists | The renderer emits each package's tasks as checklists. It creates issues only from the program, epics, and work packages, and never emits a second native-child checklist. Baseline validation confirms 474 tasks within the 112 work packages. |
| Persist publication receipts and resume safely after partial failure | The durable journal binds repository, plan fingerprint, issue IDs, pending intent, and confirmed parents. The existing [31 publisher tests](../tests/test_publish_plan.py) passed in this review, including interrupted create/attach responses, persistence failure, locking, budgeted resume, changed identities, conflicting parents, and uncertain outcomes. These failure cases use a synthetic adapter; no disruptive live failure was induced. |
| Every created issue has exactly one intended native parent | All 132 non-root issues have the correct native parent. The root's verified absence is the documented hierarchy exception above. |
| Rerunning publication creates no duplicate issue or relationship; unresolved decisions remain Backlog without blocking plan publication | Two runs against the exhaustive real inventory produced identical zero-action plans. Readiness does not filter out initial publication. New issue bodies explicitly say Backlog and unassigned; the publisher has no update, assignment, closure, or Project-field operation, so reconciliation cannot reset existing progress or promote an unresolved decision. The historical [publication audit](PUBLICATION.json) records initial Project-field verification; this new readback makes no fresh Project-field claim. |

## Review and completion boundary

The prerequisite repository output from [#27](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/27) is available: this dedicated public repository contains the reviewed planning baseline and publisher. That does not close the remaining security-contact, access-setting, ownership, or other acceptance work in #27, and does not close the Project-field work in [#33](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/33).

The issue-specific publication result is ready for independent receiving review. Closure of #29 requires that review and merge of this record. This file changes no live issue body, assignee, native relationship, or Project field. The earlier [00:36 readback](publication-readback-20261018.json) remains an independent historical receipt.

Verification used Python 3.12.14: the two real-inventory planner runs, the 31 publication regression tests, and the repository's plan, full Python, generated-document, and whitespace checks. Automated tests establish the publisher's failure/recovery behavior under their documented synthetic conditions. Actual source reads establish the published hierarchy. Neither proves service deployment or complete organizational governance.
