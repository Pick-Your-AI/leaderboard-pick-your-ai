# Audiences, journeys and product success

Decision for [LB-01.01 / #22](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/22). Source examples reviewed on **2026-10-18 UTC**.

## Decision and acceptance boundary

Adopt the five journeys below as the product's acceptance scenarios. The purpose is to help people discover contributions, understand their evidence and find useful ways to participate. Success depends on correct discovery and understanding, including work outside ranked boards. It does not depend on producing more commits, comments, closed issues or points.

This is a product decision under the maintainer's delegated engineering authority. Its reviewed merge records adoption of the scenarios and evaluation protocol. It does not record participant results, assign an absent owner or certify a public service. Implementation, source permissions, metric enablement, accessibility, privacy, operations and release retain their own gates in the [release manifest](../planning/release-manifest.json). A conditional module is assessed when enabled; its absence must be explicit and must not be presented as a working feature.

The existing [98 metric definitions](METRICS.md), [contribution categories](../planning/concept.json) and [delivery work packages](DELIVERY_PLAN.md) remain the scope baseline. The evaluation measures in this decision assess the product; they are not additional contributor rankings or a combined productivity score.

## Common evaluation protocol

Each journey has two distinct forms of evidence:

1. **Deterministic acceptance:** execute the stated scenario against a declared, labeled synthetic fixture and record every expected result. All correctness assertions must pass. An unavailable capability, skipped step or missing receipt cannot count as a pass.
2. **Usability acceptance:** observe at least five independent task attempts for that audience with the task and time limit stated below. At least four of five attempts must finish unaided, with the correct interpretation of the evidence. Report the actual numerator and denominator, every failure and any assistance. Larger samples use the same threshold of at least 80%; this initial target is a design choice, not a measured result or statistical claim about all users.

Start timing after the declared test environment is ready and the participant receives the task. Stop only when the participant completes the task and explains the required distinction. Record loading or connection failures rather than silently excluding them. Do not replace correctness failures with a faster time. Use a new task for a repeated participant so rehearsed answers are not reported as independent first attempts.

Evaluate desktop keyboard, small-screen touch and supported assistive-technology paths under their own accessibility acceptance work. Report which paths were actually exercised. An automated accessibility scan or a mouse-only session does not establish completion of those paths. Run public-data acceptance only after the relevant sources and privacy projection are authorized; synthetic examples must never become public contributor observations.

A bounded acceptance receipt identifies the scenario/version, tested source commit and artifact, fixture or authorized snapshot, policy version, scope and UTC interval, enabled modules, platform/input method, actual results and unresolved limits. Retain only the necessary consented test evidence under the privacy policy. This decision does not enable person-level analytics or publish participant identities.

## J1 — Visitor discovers a contribution and checks its evidence

**Task:** Starting at the public overview, find a contribution in a non-code category, choose a repository or Project and a date interval, open the contributor and follow the contribution to its original public source. Explain who did what, whether acceptance is established and what the source coverage cannot tell you. Usability target: **three minutes**.

**Fixture:** Include an accepted item, an observed item awaiting acceptance, one contributor outside every ranked podium, a shared-rank tie, an unavailable category and a scope with partial historical coverage. Give at least one artifact membership in two Projects.

**Deterministic pass:**

- The selected category, scope and half-open UTC interval survive navigation and a copied URL. Overview, directory, portfolio and evidence detail agree on the same snapshot and filters.
- The attributable contributor outside the podium is discoverable. Pending work stays visible where eligible and is separate from accepted totals and ranks.
- The evidence detail exposes the original public source, attributed role, event basis and acceptance evidence or its absence. Assignment or a mention alone never becomes earned-work credit.
- Partial history and unavailable categories are described explicitly. Unknown activity is not rendered as zero, and incomparable coverage cannot produce a movement claim.
- The organization view counts a canonical contribution once even if its source artifact belongs to two Projects. Distinct qualifying roles retain their own provenance.

**Successful explanation:** The visitor identifies the source and role correctly and can distinguish observed work from an accepted outcome. Opening a drawer or clicking a link without that understanding is not evidence comprehension.

## J2 — First-time contributor finds a realistic way to help

**Task:** Find a public source issue that matches an interest, inspect its current acceptance requirement and prerequisites, and identify the existing owner or the stated path for agreeing ownership. Explain the next useful action without claiming or changing the issue through the leaderboard. Usability target: **five minutes**.

**Fixture:** Include an owned issue with a genuine prerequisite, an unassigned issue awaiting a decision, a completed child under an open parent and a contributor first observed within an incomplete history window.

**Deterministic pass:**

- The issue link reaches the original artifact. The interface distinguishes issue state, native hierarchy, prerequisites and Project context instead of deriving one from another.
- A missing assignee is shown as missing information or a need to agree ownership. It is not a promise that the task is available, abandoned or reserved for the viewer.
- A completed child does not close its parent or certify the parent outcome. A ready-looking Project field cannot override an unresolved delivery prerequisite.
- The first-observed contributor label states its history boundary; it does not claim a first-ever contribution or infer tenure.
- Browsing, filtering and following evidence do not mutate upstream issues, assignments, labels, relationships or Project fields.

**Successful explanation:** The participant names a concrete source task, its acceptance gate and one next action consistent with its actual ownership and prerequisites. An unassigned issue is not automatically a suitable first task.

## J3 — Regular contributor explains and shares a portfolio

**Task:** Find a contributor's work across two roles, explain the accepted and pending portions for a chosen interval, and copy a portfolio URL that another anonymous reader can inspect. Usability target: **three minutes**.

**Fixture:** Include author, reviewer and maintainer contributions; observed-only work; a tied rank; partial coverage; a corrected attribution; and an item removed by the current privacy projection.

**Deterministic pass:**

- The portfolio includes attributable observed work even when the contributor has no qualifying rank. Roles and category totals reconcile with the same evidence and snapshot as the board.
- The shared URL preserves the chosen public scope and interval. The receiving reader sees the publication time and current coverage caveats, with no implied live update to a dated result.
- A privacy-suppressed or revoked item does not reappear through a stale URL, detail page or retained snapshot. The result communicates unavailability without exposing the removed private content.
- If exports, cards or embeds are enabled, test those surfaces against the same current privacy projection, revocation and dated-snapshot requirements. If disabled, no enabled sharing control may claim to deliver them; copying the ordinary public portfolio URL remains the base journey.
- Human-account, automation, coauthor and reviewer attribution retain their actual provenance. The portfolio does not infer manual work, hours, AI use or comparative effort from account type or event volume.

**Successful explanation:** The contributor can point to two different evidenced roles and explain why a pending or suppressed item is not an accepted public outcome. More events are not required to complete the task.

## J4 — Maintainer investigates and corrects a public claim

**Task:** Starting from an incorrect attribution or outdated public claim, find the original evidence, submit a correction through the supported destination, obtain its receipt and inspect the resulting state. Usability target: **five minutes** for submission and receipt; a review decision is not promised within that interval.

**Fixture:** Include a demonstrably wrong attribution, a merely disputed interpretation, a source that is no longer public, an authorized maintainer and an unauthorized requester. Exercise an actual supported correction path in the tested environment.

**Deterministic pass:**

- The reader can identify the source artifact, current claim and relevant policy. A correction submission yields a durable, retrievable receipt with its actual pending or decided state; a decorative button or email address alone is insufficient.
- Public reporting and a protected decision are distinct. An unauthorized request cannot apply a correction, recover hidden content or grant itself a reviewer role.
- The authorized decision records the actor, reason, relevant evidence, scope and policy/version. It updates the public projection consistently and preserves the appropriate audit history without publishing sensitive request content.
- A source that becomes private or otherwise ineligible is suppressed across enabled public surfaces. The source issue, assignees and Project fields are not rewritten by ingestion or a leaderboard correction.
- An operational response commitment is shown only after a real operator accepts it. The interface states the actual pending status while review is outstanding.

**Successful explanation:** The maintainer distinguishes a received request from an accepted correction, identifies its receipt and understands what changed publicly. Submission count and rapid closure are not success measures.

## J5 — Live-display operator presents current work without misleading viewers

**Task:** Open the wall for a declared category/scope/interval, inspect its freshness, pause while a new snapshot becomes available, then deliberately apply the update. Observe what viewers see when collection becomes stale or disconnected. Usability target: **three minutes**, with the freshness boundary advanced by a declared synthetic clock for the fixture.

**Fixture:** Include more eligible contributors than fit on one screen, a tie spanning a page boundary, observed-only work, a new snapshot, a privacy revocation, an expired freshness deadline and a disconnected source. Declare the configured freshness deadline; do not invent a production service commitment.

**Deterministic pass:**

- A complete rotation visits every eligible row in the declared snapshot exactly as the wall policy specifies, including rows beyond the first page. The displayed filters, publication time and collected-through state remain visible.
- A paused display makes zero automatic rank or reading-position changes. It signals available updates and applies a coherent new snapshot only through the supported user action. Current privacy suppression still takes effect while rotation or ordinary updates are paused.
- A cycle does not mix category, policy or snapshot versions. Equal-rank ordering is stable, and missing coverage never creates a fabricated movement or zero.
- At the configured stale boundary or a known disconnection, the wall shows the appropriate quiet/freshness state without claiming collection is live. Recovery identifies the newly applied snapshot.
- Pause, resume, navigation and exit remain usable through the supported keyboard, touch and assistive-technology paths. Motion and live announcements follow the separate accessibility acceptance rules.

**Successful explanation:** The operator can identify the scope and freshness, show that reading is preserved during pause and explain the stale state. A screenshot, a shortened synthetic clock or a passing page-rotation test does not substitute for an actual required-duration operational soak.

## Success measures and resistance to inflated counts

Record each result for a declared fixture or authorized evaluation cohort and version. Do not compare different source coverage, policies or enabled-module sets as if they were equivalent. A zero denominator produces **not evaluated**, never 100% success.

| Measure | Numerator and denominator | Acceptance target and interpretation |
| --- | --- | --- |
| Contribution discovery | Task attempts that find the requested eligible contribution and correct source / all assigned discovery attempts | At least 80% unaided within J1's time limit; report the count and every failed path. Searching only for a familiar top contributor does not test breadth. |
| Evidence follow-through and understanding | Attempts that open the original source and correctly identify actor/role, acceptance and coverage / all assigned evidence tasks | At least 80% unaided within the relevant journey limit. Raw click-through may describe navigation, but it cannot replace the understanding check. |
| Breadth of contributor discovery | Distinct eligible contributors reachable through the directory and scope navigation / distinct eligible contributors in the declared fixture | 100%, including observed-only contributors outside ranked boards. Ineligible or suppressed records are outside the denominator and must be absent from the public view. |
| Breadth of contribution kinds | Planned categories with eligible fixture evidence whose contribution can be reached and explained / planned categories with eligible fixture evidence | 100% in the deterministic fixture across the 11 planned categories. Unsupported or empty categories disclose their state; the product does not invent entries to fill a category. |
| Independent audience completion | Correct unaided attempts / all attempts, reported separately for J1 through J5 | At least 80% for each audience; good results for visitors cannot conceal a failing correction or live-display journey. |
| Public-claim correctness | Incorrect attribution, acceptance, coverage, freshness or privacy assertions found in the declared acceptance cases | Zero unresolved correctness failures. Privacy or false-credit defects block the affected capability regardless of a favorable average task score. |

Apply these negative checks to the same evaluation fixture before accepting an implementation:

- Replaying the same source event, adding another Project membership or ingesting a duplicate receipt does not increase distinct qualified contribution totals or product success measures.
- Additional raw comments or commits may change a correctly labeled activity measure under its existing definition. They do not improve a task-completion score or become accepted outcomes without the relevant evidence and published rule.
- Removing an inconvenient participant attempt, unsupported category or coverage failure from a denominator is not an improvement. Record exclusions with their reasons before evaluation and report uncompleted attempts.
- Recognition remains possible through research, design, issue work, triage, planning, code, review, testing, documentation, maintenance/security and community evidence. Do not make the highest-volume category a prerequisite for visibility.

## Reviewed public repository examples

The organization inventory on 2026-10-18 contained the six public, non-archived repositories below. Stable repository IDs prevent a rename from silently changing scope. These are dated source observations, not synthetic test data, source-installation grants or a live production dataset. Recheck visibility, eligibility and the source's current state before collection or a later acceptance run. Repository and Project membership define views; neither is sufficient evidence that a person performed work.

| Repository and stable ID | Public example reviewed | What the journeys must preserve |
| --- | --- | --- |
| [pick-your-ai-research](https://github.com/Pick-Your-AI/pick-your-ai-research) · `1421934086` | [#11](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/11) and its [T2 criteria reconciliation #266](https://github.com/Pick-Your-AI/pick-your-ai-research/pull/266) | Eight documented criteria can be reconciled while receiving review remains open. J1/J3 separate research evidence, reviewed delivery and receiving acceptance; merged research is not a runtime certification. |
| [pickyour.ai](https://github.com/Pick-Your-AI/pickyour.ai) · `1422238606` | [#31](https://github.com/Pick-Your-AI/pickyour.ai/issues/31), distinguishing incomplete required selections from actual incompatibility | J1/J2 follow the original product defect and its existing owner/PR rather than equating an open issue with a missing contributor or a finished implementation. This example is a read-only source reference. |
| [.github](https://github.com/Pick-Your-AI/.github) · `1422014674` | Closed [#2](https://github.com/Pick-Your-AI/.github/issues/2), organization metadata/profile maintenance | J1/J3 can discover eligible guidance and maintenance without requiring membership in a delivery Project. Closing a metadata task does not claim application delivery. |
| [pick-your-ai-leaderboard](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard) · `1422874501` | Merged [#210](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/210), delivery [646041b](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/commit/646041b98c9f48f7bbed183961f9ab20d562f231) | J1/J3/J5 distinguish reviewed source and browser test results from source-installation permission, an operational soak and public release. |
| [pick-your-ai-apple](https://github.com/Pick-Your-AI/pick-your-ai-apple) · `1422897390` | Merged toolchain [#195](https://github.com/Pick-Your-AI/pick-your-ai-apple/pull/195), delivery [acb0b57](https://github.com/Pick-Your-AI/pick-your-ai-apple/commit/acb0b578cbca098867abcd10f7137a81f98fe483) | J1/J3 recognize maintenance and validation while retaining the separate installed-device and user-journey acceptance gates. A selected Xcode toolchain is not a completed app journey. |
| [pick-your-ai-android](https://github.com/Pick-Your-AI/pick-your-ai-android) · `1422897313` | Merged pinned secret-scanning [#252](https://github.com/Pick-Your-AI/pick-your-ai-android/pull/252), delivery [a33e9cf](https://github.com/Pick-Your-AI/pick-your-ai-android/commit/a33e9cf7310fac94b46e00d616c026f4e7bd6d1b) | J1/J3 recognize security work from its source and bounded tests while keeping emulator, store and production acceptance separate. |

## Reviewed public Project examples

All six Projects below were inspected and their public visibility checked on 2026-10-18. Field values are dated context, not additional contribution events or instructions to update upstream state. Retain each Project's field names and option meanings. An issue appearing in two Projects remains one source artifact.

| Project | Example reviewed | Acceptance consequence |
| --- | --- | --- |
| [1 · AI Builder Research](https://github.com/orgs/Pick-Your-AI/projects/1) | Research #11 was open and In Progress with Readiness Ready, Research Confidence Unverified and Dependency Status Unblocked after the criteria-only merge. | J1/J2 show these as independent dimensions. Ready or Unblocked does not mean the research is verified or the receiving gate complete. |
| [2 · Market Research & Competitive Intelligence](https://github.com/orgs/Pick-Your-AI/projects/2) | [Research #61](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/61) was In Progress with Research Readiness Awaiting decision and Evidence Confidence Unverified; [#62](https://github.com/Pick-Your-AI/pick-your-ai-research/issues/62) was In Review with Ready and Unverified. | J1/J3 distinguish a review-stage artifact from an accepted benchmark observation and preserve this Project's own readiness/confidence fields. No measured GPU result is inferred from a workflow status. |
| [3 · PickYour.AI Website Implementation](https://github.com/orgs/Pick-Your-AI/projects/3) | Website #31 was In Progress with linked [#294](https://github.com/Pick-Your-AI/pickyour.ai/pull/294); open deployment work showed completed child progress without its own completion. | J2 follows the native issue and actual linked PR. Child completion and an implementation proposal do not establish parent acceptance or a deployment. |
| [4 · Android Application Delivery](https://github.com/orgs/Pick-Your-AI/projects/4) | [Product-scope epic #2](https://github.com/Pick-Your-AI/pick-your-ai-android/issues/2) displayed Needs owner and the Decision accepted gate; [program #1](https://github.com/Pick-Your-AI/pick-your-ai-android/issues/1) required Integrated behavior verified. | J2 distinguishes decision and program gates. An empty assignee and a historical Backlog field cannot erase independently evidenced merged contributions. |
| [5 · Apple/iOS Application Delivery](https://github.com/orgs/Pick-Your-AI/projects/5) | Open [scope epic #2](https://github.com/Pick-Your-AI/pick-your-ai-apple/issues/2) showed four of six children complete. Closed [#20](https://github.com/Pick-Your-AI/pick-your-ai-apple/issues/20) showed Done; closed [#22](https://github.com/Pick-Your-AI/pick-your-ai-apple/issues/22) still showed In Progress and Awaiting decision. | J1/J2 retain source issue state and contextual Project fields without silently resolving a mismatch. A completed child does not complete its parent; a stale field does not negate source evidence. |
| [6 · Contributor Leaderboard Delivery](https://github.com/orgs/Pick-Your-AI/projects/6) | The hierarchy and owner/readiness views separate Status, Phase, Readiness, Level and Acceptance Gate. [This package #22](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/22) requires an Approved decision; [public-service delivery](../planning/release-manifest.json) has additional evidence gates. | J2/J4 preserve the difference between adopting this product decision, implementing a feature and operating a verified public release. No source or Project ownership is inferred from a proposed owner role. |

## Non-goals and decision maintenance

The product does not make or support employment, hiring, promotion, compensation or individual performance decisions. It does not estimate hours, effort, intent, AI use, manual authorship or a person's worth. It does not publish inactivity lists, pressure streaks, a universal score or an unsupported endorsement. Reviewed recognition and editorial selections remain labeled, attributable and separate from raw activity.

The product does not take ownership of source issues, rewrite other teams' workflows or turn missing evidence into a favorable result. Public visibility alone does not authorize every possible source, retained field or reuse. Contributor corrections and privacy choices remain governed by [LB-01.05 / #26](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/26) and the mandatory source/privacy gates.

Revisit this decision when an audience, source scope, category or enabled capability changes, or when observed acceptance failures show a scenario is inadequate. Version the changed scenario, explain the reason and retain comparable prior results. Refresh the repository/Project example inventory before a new source installation or a scope-changing release; do not reset live work to the original planning snapshot.

For #22, the review must verify all five measurable scenarios, all three requested outcomes, explicit non-goals, all six repository and six Project examples, and the negative checks against inflated counts. Actual execution receipts belong to the implementation and release packages when those capabilities are assessed.
