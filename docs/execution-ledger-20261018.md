# Execution ledger — 2026-10-18

This is a local implementation/evidence audit, not a reset of GitHub state, ownership, native dependencies or acceptance. Baseline: 133 issues (1 program, 20 epics, 112 packages), 98 metrics. Inspected source revision: `b1c9fea8807c0398e749aa2e849bf89a8a9048dd`. Scope is this repository only.

Live readback used repository ID 1422874501 on 2026-10-18: ascending and descending issue searches deduplicated all 133 issues; separate open and closed searches confirm 126 open and 7 closed. Search projections omit assignees, timestamps and comments; these are unknown, not unassigned. Parent coordination reports live PR154 comments confirming active parallel writers. Native blocker changes and individual issue comments require authoritative refresh before changing status. The baseline dependencies below are not represented as a fresh native-edge audit. CLI GraphQL read returned Forbidden; connector searches succeeded.

All listed source/test files are evidence locations, not test-pass claims for this audit. Raw connector payloads are excluded. Exact acceptance criteria are retained below; unchecked criteria are not asserted failed where evidence is merely missing. Closed issues remain closed and are not reopened by this audit.

## Active PR ownership and next actions

This pass adds `packages/metrics/test/invariants-audit.test.js` and
`docs/metric-invariant-audit.md`: 101 synthetic calculation-boundary cases,
covering 97 supported candidate definitions and explicitly rejecting unsupported
`net_lines`. They do not satisfy the research-owned source fixtures or approve
source qualification. Independent review identified an empty-count coverage
wording mismatch; the final suite now checks empty inputs for every supported
definition. Issue #72 remains open.

Additional active work discovered during final refresh: PR160
(`687986b4d1d1fc38244675a440ee4b40c5efd7cb`) owns structured checkpoint email
minimization (#45/#95); PR161
(`089f99bff7eec975bb75b6a9d6bc1e8470ad5b53`) owns resumable issue publication
(#29). Their authors retain their branches and merge coordination. The former
does not complete retention or free-text redaction; the latter still requires
connected-host adapter verification. These remain partial implementations.

| PR | Refreshed head | State and evidence | Next action |
| --- | --- | --- | --- |
| [#157](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/157) | `a493274ecd1252bafd325c9d40b16304d1a3bf28` | Open, mergeable=true. Recovery safeguards preflight; author reports review, six backup regressions and 27 Python tests; hosted PostgreSQL check required. | Refresh exact-head checks/reviews, resolve findings, sync with current main and merge only after required evidence. Do not duplicate author-owned files. |
| [#156](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/156) | `ad41072f63d782db3dcfbf14481f5acbe6cf418f` | Open, mergeable=true. Separate pending counts; author reports independent review and prior checks; synced head checks rerunning. Private snapshot-bound aggregate audit remains open. | Refresh exact-head checks/reviews, resolve findings, sync with current main and merge only after required evidence. Do not duplicate author-owned files. |
| [#154](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/154) | `e54027d166b79a81fc09aa6b3635dfecd1531745` | Draft, mergeable=false. Protected worker; parent confirms active collectors, account/admin UI, receipt/policy, recognition/cards writers. Broad implementation remains in progress. | Refresh exact-head checks/reviews, resolve findings, sync with current main and merge only after required evidence. Do not duplicate author-owned files. |
| [#158](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/158) | `2d6cb00a5850ef7497fcbba94030e79072d9f726` | Open; selected implementation after parent independent comparison. Broader generation binding and six race cases plus API tests (39 total); author retains merge ownership. | Author retains exact-head validation and protected merge; #159 was closed as duplicate after comparison. |
| [#159](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/159) | `39d8b6723c04a846e667e754e837d44d1a4bd3d7` | Closed as duplicate by the parent after reviewing #158. Alternative source/tests were backed up locally and removed from this working tree; no merged delivery is claimed. | Use #158; do not reopen or merge this duplicate. Neither closes #106/#127 full acceptance. |

PR155 is already merged in the inspected main revision. PR status is a point-in-time snapshot, not a merge authorization or CI certification.

## Dependency-ordered continuation

1. Review/sync existing PR156 and PR157, then PR154 when its active writers finish. Avoid touching those branches.
2. Independently address bounded validation gaps: aggregate-audit privacy review after author coordination, explicit per-enabled-metric invariant mapping, and reproducible soak tests.
3. Resolve policy/source prerequisites: authenticated acceptance and identity policies, existing authorized App canaries, inventory and paginated reconciliation. Never fill inaccessible historical actors or times with guesses.
4. Integrate final source-to-snapshot-to-UI and correction paths; run complete local and exact-head hosted checks with independent review.
5. Complete host/operator, retention, manual accessibility, real-data and release drills. These require concrete external evidence, not code-only closure.

## Program and epic map

| Issue | State | Evidence and remaining gate | Next step |
| --- | --- | --- | --- |
| [LB / #1](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/1) | OPEN | Planning baseline and runtime candidates; all in-scope children, accepted source/metric/UI/security evidence, verified production and operator handoff remain the program gate. | Complete or explicitly review scope changes for every child; no blanket closure. |
| [LB-01 / #2](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/2) — Product charter and contribution governance | OPEN | `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`. Decision proposals and product scenarios exist; attributable policy acceptance, reconciled live inventory and verified host/operator choices are not established by these files. | Resolve each named decision with actual evidence; preserve public target already selected. Complete accepted child outcomes before epic closure. |
| [LB-02 / #3](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/3) — Repository, delivery Project and engineering foundation | OPEN | `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`. Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts. | Verify package-specific receipts; retain already closed items; coordinate worker integration with PR154. Complete accepted child outcomes before epic closure. |
| [LB-03 / #4](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/4) — Metric contracts, identity and scope | OPEN | `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`. Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate. | Approve or keep unresolved policy values; test consumers and actual identity correction before enablement. Complete accepted child outcomes before epic closure. |
| [LB-04 / #5](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/5) — GitHub App and source capability verification | OPEN | `packages/github/src/client.ts; packages/github/test; docs/source-capability-candidate.md; planning/source-audit.json`. Bounded read client and source matrix exist; family capabilities remain unprobed rather than enabled. A personal-token read is not installed-App acceptance. | Obtain existing authorized App installation/canary evidence and sanitized permission/pagination receipts; do not create credentials. Complete accepted child outcomes before epic closure. |
| [LB-05 / #6](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/6) — Reliable live ingestion and event ledger | OPEN | `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`. Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate. | Review PR154 worker/collector integration; require real-source and host evidence before public operation. Complete accepted child outcomes before epic closure. |
| [LB-06 / #7](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/7) — Historical backfill, reconciliation and coverage | OPEN | `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`. Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified. | Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill. Complete accepted child outcomes before epic closure. |
| [LB-07 / #8](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/8) — Code, pull request and review recognition | OPEN | `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`. Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation. | Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154. Complete accepted child outcomes before epic closure. |
| [LB-08 / #9](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/9) — Issue, triage and project stewardship recognition | OPEN | `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`. State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified. | Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154. Complete accepted child outcomes before epic closure. |
| [LB-09 / #10](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/10) — Research, documentation and quality contributions | OPEN | `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`. Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code. | Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration. Complete accepted child outcomes before epic closure. |
| [LB-10 / #11](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/11) — Community evidence and editorial recognition | OPEN | `apps/controls/src; packages/metrics/src/engine.ts; apps/web/src/routes/People.tsx`. Controls primitives and synthetic presentation exist. Actual independent review, collaborator consent and complete discussion/editorial/badge integrations need evidence. | Coordinate PR154 receipt/recognition/card implementation; retain disabled states without invented endorsements. Complete accepted child outcomes before epic closure. |
| [LB-11 / #12](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/12) — Ranking, filters and fair comparison engine | OPEN | `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`. Count/sum/ratio/distribution, coverage, ties, correction and policy comparison candidates exist. Public activation and source-specific policies remain separate. | Review PR156 pending counts; capture private snapshot-bound aggregate audit separately; reconcile real enabled metric results. Complete accepted child outcomes before epic closure. |
| [LB-12 / #13](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/13) — Read API, snapshots and integration contracts | OPEN | `apps/service/src; apps/service/test; docs/read-api.md; docs/api-evidence-drawer.md`. Bounded public API, portfolio/activity/proof/exports and privacy rechecks exist with synthetic tests. Actual source/deployed freshness acceptance remains open. | Verify final integration and anonymous deployed readback with approved real snapshots and correction propagation. Complete accepted child outcomes before epic closure. |
| [LB-13 / #14](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/14) — Information architecture and visual system | OPEN | `planning/ui/ui-concept.json; apps/web/src; apps/web/browser; docs/ui-validation.md`. Recorded exact-model consultation and responsive synthetic UI exist. Automated browser evidence does not replace participant or assistive-technology review. | Validate exact consultation receipt and usability scenarios; run manual zoom, touch and screen-reader walkthroughs. Complete accepted child outcomes before epic closure. |
| [LB-14 / #15](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/15) — Public boards, organization overview and evidence | OPEN | `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`. Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate. | Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot. Complete accepted child outcomes before epic closure. |
| [LB-15 / #16](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/16) — Contributor portfolios and sharing | OPEN | `apps/service/src/app.ts; apps/web/src/remote; docs/contributor-directory-runtime.md; apps/service/test/read-api.test.mjs`. Directory and paginated portfolios exist with public observed-work eligibility and suppression. Account UI, cards and achievement integration remain owned work. | Coordinate PR154 account/card/recognition changes; verify consent and suppression across shares before public enablement. Complete accepted child outcomes before epic closure. |
| [LB-16 / #17](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/17) — Live activity and public display modes | OPEN | `apps/service/src/activity.ts; apps/service/src/live-client.ts; apps/web/src/remote/Activity.tsx; apps/web/browser/remote.spec.ts`. Bounded activity feed and polling/held-update primitives exist. Long-duration soak and actual display/readiness acceptance are not established. | Add bounded synthetic reconnect/soak evidence independently; verify real stale/quiet distinctions and assistive announcements. Complete accepted child outcomes before epic closure. |
| [LB-17 / #18](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/18) — Administration, moderation and contributor controls | OPEN | `apps/controls/src; apps/controls/test/controls.test.mjs; docs/contributor-controls.md`. Protected controls, OAuth/session primitives and projection suppression exist. Complete operator/account/evidence-review UI and real identity-provider acceptance remain owned work. | Coordinate PR154 admin/account/receipt/policy changes; prove direct API authorization, durable receipts and actual public correction impact. Complete accepted child outcomes before epic closure. |
| [LB-18 / #19](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/19) — Security, privacy and operational safeguards | OPEN | `docs/security-candidate.md; apps/controls/src; apps/service/src/public-source.ts; infra/recovery`. Fail-closed projections, content restrictions, session boundaries and recovery candidates exist. Evidence-retention purge policy/jobs and deployment secret drill remain distinct gaps. | Audit retention architecture and source boundaries; review PR157 safeguards; require independent final security/privacy evidence. Complete accepted child outcomes before epic closure. |
| [LB-19 / #20](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/20) — Verification, accessibility and performance | OPEN | `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`. Synthetic invariant/browser/database suites exist; no claim of real-data reconciliation, manual accessibility, accepted scale budgets or staging recovery follows. | Run required suite on reviewed head; add meaningful missing adversarial coverage; obtain actual source/participant/staging evidence. Complete accepted child outcomes before epic closure. |
| [LB-20 / #21](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/21) — Hosting, observability and release operations | OPEN | `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`. Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent. | Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch. Complete accepted child outcomes before epic closure. |

## Work-package ledger

Every package below retains its exact baseline acceptance criteria, dependency IDs, current observed issue state and concrete evidence boundaries. `OPEN / partial or acceptance unverified` deliberately does not claim every underlying implementation is unfinished.

### [LB-01.01 / #22: Define audiences, journeys and success](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/22)

- State: OPEN / partial or acceptance unverified. Gate: Approved decision.
- Dependencies (baseline): None.
- Implementation/test evidence: `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`.
- Remaining evidence / limit: Decision proposals and product scenarios exist; attributable policy acceptance, reconciled live inventory and verified host/operator choices are not established by these files.
- Next action: Resolve each named decision with actual evidence; preserve public target already selected.
- Acceptance criteria to verify against evidence:
  - All user journeys have a measurable acceptance scenario
  - Success measures do not depend on inflating counts

### [LB-01.02 / #24: Approve metric and recognition policy](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/24)

- State: OPEN / partial or acceptance unverified. Gate: Approved decision.
- Dependencies (baseline): LB-01.01.
- Implementation/test evidence: `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`.
- Remaining evidence / limit: Decision proposals and product scenarios exist; attributable policy acceptance, reconciled live inventory and verified host/operator choices are not established by these files.
- Next action: Resolve each named decision with actual evidence; preserve public target already selected.
- Acceptance criteria to verify against evidence:
  - Every public metric links to a versioned definition
  - Policy approval and outstanding decisions are recorded

### [LB-01.03 / #23: Map organization boundaries and existing ownership](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/23)

- State: OPEN / partial or acceptance unverified. Gate: Approved decision.
- Dependencies (baseline): None.
- Implementation/test evidence: `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`.
- Remaining evidence / limit: Decision proposals and product scenarios exist; attributable policy acceptance, reconciled live inventory and verified host/operator choices are not established by these files.
- Next action: Resolve each named decision with actual evidence; preserve public target already selected.
- Acceptance criteria to verify against evidence:
  - Coverage inventory reconciles with paginated GitHub results
  - Existing implementation and research work is referenced, not recreated

### [LB-01.04 / #25: Decide repository, domain and runtime placement](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/25)

- State: OPEN / partial or acceptance unverified. Gate: Approved decision.
- Dependencies (baseline): LB-01.03.
- Implementation/test evidence: `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`.
- Remaining evidence / limit: Public target leaderboard.pickyour.ai is selected in docs/PUBLIC_TARGET.md; host capabilities, budget and operator are still unresolved.
- Next action: Preserve domain decision; obtain verified approved host/runtime and accountable operator receipt.
- Acceptance criteria to verify against evidence:
  - Architecture decision identifies actual host capabilities and owner
  - No assumption that existing cPanel host runs Node services

### [LB-01.05 / #26: Set evidence and contributor-rights policy](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/26)

- State: OPEN / partial or acceptance unverified. Gate: Approved decision.
- Dependencies (baseline): LB-01.01.
- Implementation/test evidence: `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`.
- Remaining evidence / limit: Decision proposals and product scenarios exist; attributable policy acceptance, reconciled live inventory and verified host/operator choices are not established by these files.
- Next action: Resolve each named decision with actual evidence; preserve public target already selected.
- Acceptance criteria to verify against evidence:
  - Policy explains coverage gaps and data-removal behavior
  - Maintainer decisions require attributable audit records

### [LB-01.06 / #28: Define phased release and decision register](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/28)

- State: OPEN / partial or acceptance unverified. Gate: Approved decision.
- Dependencies (baseline): LB-01.02, LB-01.04, LB-01.05.
- Implementation/test evidence: `planning/decision-register.json; docs/GOVERNANCE.md; docs/PRODUCT.md; docs/PUBLIC_TARGET.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Decision proposals and product scenarios exist; attributable policy acceptance, reconciled live inventory and verified host/operator choices are not established by these files.
- Next action: Resolve each named decision with actual evidence; preserve public target already selected.
- Acceptance criteria to verify against evidence:
  - Each unresolved decision has alternatives, owner role and blocking scope
  - No launch claim follows solely from merged code or a rendered UI

### [LB-02.01 / #27: Create dedicated repository and governance shell](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/27)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-01.03.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md).
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Verify package-specific receipts; retain already closed items; coordinate worker integration with PR154.
- Acceptance criteria to verify against evidence:
  - Repository exists with reviewable planning and governance files
  - Research repository contains no leaderboard runtime changes

### [LB-02.02 / #29: Publish program, epics and work packages idempotently](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/29)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-02.01.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Verify package-specific receipts; retain already closed items; coordinate worker integration with PR154.
- Acceptance criteria to verify against evidence:
  - Every created issue has exactly one intended native parent
  - Rerunning publication creates no duplicate issue or relationship; unresolved decisions remain Backlog without blocking plan publication

### [LB-02.03 / #33: Configure Project fields, views and dependency readback](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/33)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-02.02.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Package-specific notes: [PRODUCT.md](PRODUCT.md), [UI.md](UI.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Verify package-specific receipts; retain already closed items; coordinate worker integration with PR154.
- Acceptance criteria to verify against evidence:
  - All planned packages appear once with Backlog and no invented owner
  - Dependency graph is acyclic and field IDs match live options

### [LB-02.04 / #30: Set contribution, ownership and review conventions](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/30)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-02.01, LB-01.02.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Verify package-specific receipts; retain already closed items; coordinate worker integration with PR154.
- Acceptance criteria to verify against evidence:
  - A new contributor can run one fixture journey from documentation
  - Metric policy changes request designated owner review

### [LB-02.05 / #34: Create CI, branch controls and dependency maintenance](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/34)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-02.07.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Package-specific notes: [runtime-foundation.md](runtime-foundation.md), [ui-validation.md](ui-validation.md).
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Verify package-specific receipts; retain already closed items; coordinate worker integration with PR154.
- Acceptance criteria to verify against evidence:
  - Representative failing changes block merge
  - Fork PR tests run without privileged credentials

### [LB-02.06 / #35: Establish local fixture environment and migration workflow](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/35)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-02.07.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Package-specific notes: [runtime-foundation.md](runtime-foundation.md).
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Fixture identities cannot leak into production import
  - Migration validation runs on a clean database

### [LB-02.07 / #31: Scaffold frontend, service and worker workspace](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/31)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-02.01, LB-01.04.
- Implementation/test evidence: `package.json; .github/workflows; infra/db; apps; docs/runtime-foundation.md; docs/PUBLICATION.json`.
- Package-specific notes: [PRODUCT.md](PRODUCT.md), [runtime-foundation.md](runtime-foundation.md).
- Remaining evidence / limit: Repository, native publication receipt, CI workflows and runtime scaffold exist. Branch enforcement, fork-check evidence and affected-owner review need current receipts.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Clean checkout builds each package using documented commands
  - No package contains production credentials or real contributor fixtures

### [LB-03.01 / #32: Define independent leaderboard data contracts](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/32)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-01.02, LB-02.01.
- Implementation/test evidence: `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`.
- Package-specific notes: [PRODUCT.md](PRODUCT.md), [UI.md](UI.md), [contract-candidate.md](contract-candidate.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Schema validates realistic ambiguous and missing-source cases
  - No changes to frozen research contracts/v1 are required

### [LB-03.02 / #36: Resolve contributor identity without publishing emails](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/36)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-03.01, LB-01.05.
- Implementation/test evidence: `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`.
- Package-specific notes: [contract-candidate.md](contract-candidate.md).
- Remaining evidence / limit: Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate.
- Next action: Approve or keep unresolved policy values; test consumers and actual identity correction before enablement.
- Acceptance criteria to verify against evidence:
  - Rename preserves historical credit
  - Unverified email/name matches cannot merge contributors

### [LB-03.03 / #40: Represent roles, coauthors and automation honestly](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/40)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-03.02.
- Implementation/test evidence: `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`.
- Package-specific notes: [INGESTION.md](INGESTION.md), [METRICS.md](METRICS.md), [contract-candidate.md](contract-candidate.md).
- Remaining evidence / limit: Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate.
- Next action: Approve or keep unresolved policy values; test consumers and actual identity correction before enablement.
- Acceptance criteria to verify against evidence:
  - Automated actions under a human account are not falsely certified manual
  - PR author, committer and merger cannot silently receive each other's credit

### [LB-03.04 / #37: Map repositories, Projects and workstreams over time](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/37)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-03.01, LB-01.03.
- Implementation/test evidence: `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`.
- Package-specific notes: [METRICS.md](METRICS.md).
- Remaining evidence / limit: Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate.
- Next action: Approve or keep unresolved policy values; test consumers and actual identity correction before enablement.
- Acceptance criteria to verify against evidence:
  - One contribution in multiple Projects counts once organization-wide
  - Unknown historic Project membership is labeled instead of inferred

### [LB-03.05 / #38: Implement metric registry and capability matrix](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/38)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-03.01.
- Implementation/test evidence: `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contract-candidate.md](contract-candidate.md), [security-candidate.md](security-candidate.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate.
- Next action: Approve or keep unresolved policy values; test consumers and actual identity correction before enablement.
- Acceptance criteria to verify against evidence:
  - Every enabled metric has a source, actor rule and verification case
  - Unsupported metrics cannot render as measured zero
  - Metric discovery, method sheets, supported filters and wall choices are generated from the same versioned registry; unsupported state/date combinations are not silently substituted

### [LB-03.06 / #43: Define credit conservation and object lineage](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/43)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-03.03, LB-03.05.
- Implementation/test evidence: `packages/contracts/src; packages/contracts/test; packages/metrics/src/v1/registry.json; docs/contract-candidate.md`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contract-candidate.md](contract-candidate.md).
- Remaining evidence / limit: Strict contracts and all 98 registry definitions exist with synthetic invariants. Candidate policy metadata and authenticated identity/credit decisions remain separate.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Webhook plus REST observation produces one contribution
  - PR, commit and LOC metrics are never summed into one implied total

### [LB-04.01 / #41: Probe source and permission support](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/41)

- State: OPEN / partial or acceptance unverified. Gate: Verified source capability.
- Dependencies (baseline): LB-03.05.
- Implementation/test evidence: `packages/github/src/client.ts; packages/github/test; docs/source-capability-candidate.md; planning/source-audit.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [github-client.md](github-client.md), [security-candidate.md](security-candidate.md), [source-capability-candidate.md](source-capability-candidate.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Bounded read client and source matrix exist; family capabilities remain unprobed rather than enabled. A personal-token read is not installed-App acceptance.
- Next action: Obtain existing authorized App installation/canary evidence and sanitized permission/pagination receipts; do not create credentials.
- Acceptance criteria to verify against evidence:
  - Capability report includes a real payload example per enabled event family
  - Project snapshots are not treated as change-author evidence
  - Verify native issue fields, issue types, Project item custom fields, Project item status transitions and Project progress-update posts as distinct event families

### [LB-04.02 / #44: Register and configure least-privilege GitHub App](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/44)

- State: OPEN / partial or acceptance unverified. Gate: Verified source capability.
- Dependencies (baseline): LB-04.01, LB-01.05.
- Implementation/test evidence: `packages/github/src/client.ts; packages/github/test; docs/source-capability-candidate.md; planning/source-audit.json`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [github-client.md](github-client.md), [security-candidate.md](security-candidate.md).
- Remaining evidence / limit: Bounded read client and source matrix exist; family capabilities remain unprobed rather than enabled. A personal-token read is not installed-App acceptance.
- Next action: Obtain existing authorized App installation/canary evidence and sanitized permission/pagination receipts; do not create credentials.
- Acceptance criteria to verify against evidence:
  - App can read allowed data and cannot write repository content
  - Permission table agrees with actual successful capability probes

### [LB-04.03 / #49: Handle installation and repository lifecycle events](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/49)

- State: OPEN / partial or acceptance unverified. Gate: Verified source capability.
- Dependencies (baseline): LB-04.02, LB-03.04.
- Implementation/test evidence: `packages/github/src/client.ts; packages/github/test; docs/source-capability-candidate.md; planning/source-audit.json`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ingestion-completion.md](ingestion-completion.md), [lifecycle-review-hardening.md](lifecycle-review-hardening.md).
- Remaining evidence / limit: Bounded read client and source matrix exist; family capabilities remain unprobed rather than enabled. A personal-token read is not installed-App acceptance.
- Next action: Obtain existing authorized App installation/canary evidence and sanitized permission/pagination receipts; do not create credentials.
- Acceptance criteria to verify against evidence:
  - Private transition prevents further public serving including caches
  - Repository rename retains source continuity

### [LB-04.04 / #45: Implement API client pagination and quotas](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/45)

- State: OPEN / partial or acceptance unverified. Gate: Verified source capability.
- Dependencies (baseline): LB-04.01.
- Implementation/test evidence: `packages/github/src/client.ts; packages/github/test; docs/source-capability-candidate.md; planning/source-audit.json`.
- Package-specific notes: [github-client.md](github-client.md), [security-candidate.md](security-candidate.md), [source-capability-candidate.md](source-capability-candidate.md).
- Remaining evidence / limit: Bounded read client and source matrix exist; family capabilities remain unprobed rather than enabled. A personal-token read is not installed-App acceptance.
- Next action: Obtain existing authorized App installation/canary evidence and sanitized permission/pagination receipts; do not create credentials.
- Acceptance criteria to verify against evidence:
  - Histories over 100 items and multi-page reviews are fully retrieved
  - Rate-limit tests pause only the affected source and resume safely

### [LB-04.05 / #50: Verify organizational visibility and public source policy](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/50)

- State: OPEN / partial or acceptance unverified. Gate: Verified source capability.
- Dependencies (baseline): LB-04.02, LB-01.05.
- Implementation/test evidence: `packages/github/src/client.ts; packages/github/test; docs/source-capability-candidate.md; planning/source-audit.json`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Bounded read client and source matrix exist; family capabilities remain unprobed rather than enabled. A personal-token read is not installed-App acceptance.
- Next action: Obtain existing authorized App installation/canary evidence and sanitized permission/pagination receipts; do not create credentials.
- Acceptance criteria to verify against evidence:
  - Restricted content is absent from APIs, exports, caches and error logs
  - Public metadata does not imply permission to expose private linked content

### [LB-05.01 / #51: Build authenticated webhook intake](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/51)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-04.02, LB-03.01.
- Implementation/test evidence: `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`.
- Package-specific notes: [lifecycle-review-hardening.md](lifecycle-review-hardening.md).
- Remaining evidence / limit: Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Forged, malformed and oversized requests create no contributions
  - Acknowledged events survive receiver restart

### [LB-05.02 / #54: Create durable inbox and worker leases](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/54)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-05.01, LB-02.06.
- Implementation/test evidence: `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`.
- Package-specific notes: [PIPELINE.md](PIPELINE.md), [webhook-dispatch.md](webhook-dispatch.md).
- Remaining evidence / limit: Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Crash after acknowledgment and before normalization loses no event
  - Duplicate concurrent delivery cannot produce duplicate contribution

### [LB-05.03 / #57: Normalize event time and source order](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/57)

- State: CLOSED in refreshed GitHub query; retain existing closure. Gate: Automated validation.
- Dependencies (baseline): LB-05.02, LB-03.01.
- Implementation/test evidence: `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`.
- Remaining evidence / limit: Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate.
- Next action: Preserve closure; verify regressions and links when dependent integrations change. No new closure or reopening is proposed.
- Acceptance criteria to verify against evidence:
  - Replayed permutation of a fixture converges to the same supported state
  - Unknown event time cannot silently become ingestion time

### [LB-05.04 / #58: Implement incremental enrichment and classification](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/58)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-05.02, LB-04.04.
- Implementation/test evidence: `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`.
- Package-specific notes: [PIPELINE.md](PIPELINE.md), [ingestion-completion.md](ingestion-completion.md), [webhook-dispatch.md](webhook-dispatch.md).
- Remaining evidence / limit: Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate.
- Next action: Review PR154 worker/collector integration; require real-source and host evidence before public operation.
- Acceptance criteria to verify against evidence:
  - Enrichment failures remain visible and retryable
  - No event is counted as accepted before required evidence arrives

### [LB-05.05 / #62: Publish atomic snapshot revisions and update notices](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/62)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-05.03, LB-05.04.
- Implementation/test evidence: `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`.
- Package-specific notes: [PIPELINE.md](PIPELINE.md), [webhook-dispatch.md](webhook-dispatch.md).
- Remaining evidence / limit: Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate.
- Next action: Review PR154 worker/collector integration; require real-source and host evidence before public operation.
- Acceptance criteria to verify against evidence:
  - API, board and evidence drawer agree on one snapshot
  - A failed rebuild cannot expose half-updated rankings

### [LB-05.06 / #73: Monitor ingestion health and replay](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/73)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-05.05.
- Implementation/test evidence: `packages/ingestion/src; packages/ingestion/test; apps/pipeline/src; docs/ingestion-completion.md`.
- Package-specific notes: [ingestion-completion.md](ingestion-completion.md).
- Remaining evidence / limit: Durable inbox, fenced leases, normalization, enrichment and outbox paths exist. Real host adapters/publication and source capability remain separate.
- Next action: Review PR154 worker/collector integration; require real-source and host evidence before public operation.
- Acceptance criteria to verify against evidence:
  - Recovery drill catches up without duplication
  - Health distinguishes no new activity from a disconnected collector

### [LB-06.01 / #59: Inventory and backfill public artifacts](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/59)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-04.04, LB-03.05, LB-05.02.
- Implementation/test evidence: `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [ingestion-completion.md](ingestion-completion.md).
- Remaining evidence / limit: Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified.
- Next action: Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill.
- Acceptance criteria to verify against evidence:
  - Backfill counts reconcile with paginated source totals
  - Historical gaps and deleted/unrecoverable activity remain explicit

### [LB-06.02 / #63: Backfill Project and relationship history selectively](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/63)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.01, LB-04.01.
- Implementation/test evidence: `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`.
- Package-specific notes: [METRICS.md](METRICS.md), [ingestion-completion.md](ingestion-completion.md).
- Remaining evidence / limit: Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified.
- Next action: Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill.
- Acceptance criteria to verify against evidence:
  - Evidence distinguishes observed transitions from current state
  - Fields lacking historic actor coverage are disabled historically

### [LB-06.03 / #64: Reconcile webhooks with scheduled source reads](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/64)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.01, LB-05.03.
- Implementation/test evidence: `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`.
- Package-specific notes: [ingestion-completion.md](ingestion-completion.md).
- Remaining evidence / limit: Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified.
- Next action: Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill.
- Acceptance criteria to verify against evidence:
  - Intentionally omitted webhook is recovered by reconciliation
  - Scans do not present guessed actor attribution as fact

### [LB-06.04 / #74: Model deletions, reverts and eligibility changes](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/74)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.03, LB-01.05.
- Implementation/test evidence: `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`.
- Package-specific notes: [METRICS.md](METRICS.md), [ingestion-completion.md](ingestion-completion.md), [lifecycle-review-hardening.md](lifecycle-review-hardening.md).
- Remaining evidence / limit: Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified.
- Next action: Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill.
- Acceptance criteria to verify against evidence:
  - Removed evidence no longer appears as currently verified
  - Reversion changes qualified views without inventing negative merit

### [LB-06.05 / #75: Expose coverage and freshness diagnostics](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/75)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.02, LB-06.03.
- Implementation/test evidence: `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ingestion-completion.md](ingestion-completion.md).
- Remaining evidence / limit: Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified.
- Next action: Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill.
- Acceptance criteria to verify against evidence:
  - Unknown, empty, partial, stale and disconnected render distinctly
  - Cross-period comparisons use compatible source and definition coverage

### [LB-06.06 / #85: Test complete replay and deterministic rebuild](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/85)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.04, LB-06.05.
- Implementation/test evidence: `packages/ingestion/src/collection.ts; packages/ingestion/src/snapshots.ts; packages/ingestion/src/replay.ts; docs/ingestion-completion.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ingestion-completion.md](ingestion-completion.md).
- Remaining evidence / limit: Synthetic backfill/reconcile/replay and suppression exist; real family adapters, reconciled totals, CDN behavior and retained historic evidence remain unverified.
- Next action: Review owned collector changes; run authorized bounded source comparison and deployed suppression/rebuild drill.
- Acceptance criteria to verify against evidence:
  - Rebuild yields identical totals for a fixed source snapshot
  - Non-reconstructible cases are declared in operations documentation

### [LB-07.01 / #65: Deliver PR contribution boards](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/65)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-03.06, LB-06.01.
- Implementation/test evidence: `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation.
- Next action: Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Reopen/reclose cycles do not inflate merged PR totals
  - One coauthored PR has explicit participation versus conserved totals
  - Decided-in-window merged-share denominator is merged plus closed-unmerged PRs; pending cases remain separately visible, with no quality rank

### [LB-07.02 / #76: Deliver transparent LOC and change-size boards](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/76)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.01, LB-05.04.
- Implementation/test evidence: `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation.
- Next action: Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Large/truncated diff cannot silently report complete LOC
  - Net LOC, churn and changed files retain separate units

### [LB-07.03 / #66: Deliver commit and collaboration attribution](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/66)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-03.06, LB-06.01.
- Implementation/test evidence: `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`.
- Package-specific notes: [METRICS.md](METRICS.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation.
- Next action: Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Squash and merge fixtures cannot double-credit the same unit
  - Authors and committers remain distinguishable

### [LB-07.04 / #67: Recognize reviews and follow-up](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/67)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.01, LB-03.05.
- Implementation/test evidence: `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation.
- Next action: Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Repeated approvals on one PR do not inflate distinct-review board
  - Comment length and approval alone are not treated as review quality
  - Review-wait distributions disclose readiness timestamp, n, missing data and unresolved/censored PRs
  - Current resolvedBy without resolvedAt does not produce period credit; require a timestamped observed transition or reviewed receipt
  - A substantive COMMENTED research review can qualify without an APPROVED state; outcome qualification follows published review policy

### [LB-07.05 / #77: Recognize release and maintenance work](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/77)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.01, LB-03.03.
- Implementation/test evidence: `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`.
- Package-specific notes: [METRICS.md](METRICS.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation.
- Next action: Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154.
- Acceptance criteria to verify against evidence:
  - A green run does not manufacture a named human achievement
  - Release author and release automation remain separate

### [LB-07.06 / #86: Validate engineering metrics against real examples](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/86)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.02, LB-07.03, LB-07.04, LB-07.05.
- Implementation/test evidence: `packages/github/src/normalizers.ts; packages/github/src/physical-diff.ts; packages/metrics/src/engine.ts; packages/github/test/normalizers.test.mjs`.
- Remaining evidence / limit: Engineering normalizers and aggregate invariants exist; registry coverage does not establish every enabled board or real attribution reconciliation.
- Next action: Require per-metric positive/negative examples, real sampled source reconciliation and reviewed policy; coordinate recognition with PR154.
- Acceptance criteria to verify against evidence:
  - All sampled discrepancies are resolved or publicly caveated
  - Engineering boards cannot launch with unexplained attribution gaps

### [LB-08.01 / #68: Recognize issue reporting and accepted outcomes](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/68)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.01, LB-01.02.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified.
- Next action: Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Closing another person's issue does not credit its implementation
  - Bulk issue creation cannot imply completed project delivery

### [LB-08.02 / #78: Recognize labels, milestones and ownership routing](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/78)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.02, LB-03.05.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified.
- Next action: Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Repeated add/remove cycles do not raise qualified standing
  - Current label/assignee alone never identifies the curator
  - Publish exact deterministic triage grouping/cooldown and reversal rules; label persistence does not prove label correctness

### [LB-08.03 / #87: Recognize links and relationship maintenance](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.02, LB-08.02.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified.
- Next action: Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154.
- Acceptance criteria to verify against evidence:
  - The same relationship viewed from both endpoints counts once
  - Compatibility or information links are not relabeled blockers

### [LB-08.04 / #79: Recognize issue edits and Project field curation](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-06.02, LB-03.03.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified.
- Next action: Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Current Project snapshots cannot create historical editor rankings
  - Actor kind is not inferred solely from one automation flag
  - Native IssueFieldChangedEvent, projects_v2_item field edits, ProjectV2ItemStatusChangedEvent and projects_v2_status_update are tested independently; unsupported subtypes remain unavailable

### [LB-08.05 / #96: Recognize unblocking, onboarding and resolution support](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/96)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-08.01, LB-08.03.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified.
- Next action: Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154.
- Acceptance criteria to verify against evidence:
  - Speed alone is not ranked as quality or availability obligation
  - Assignee status and dependency removal do not prove substantive unblocking

### [LB-08.06 / #104: Audit triage fairness and pathological cases](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/104)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-08.02, LB-08.03, LB-08.04, LB-08.05.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/ingestion/src/collection.ts; planning/metric-api-evidence.json`.
- Package-specific notes: [github-normalizers.md](github-normalizers.md).
- Remaining evidence / limit: State/history distinction and configurable grouping exist. Complete actor-bearing triage subtype adapters and real fairness review are not certified.
- Next action: Verify each event subtype separately; preserve unavailable historic editor attribution; coordinate collectors/recognition with PR154.
- Acceptance criteria to verify against evidence:
  - No single scripted metadata batch dominates unrelated outcome boards
  - Every triage category discloses its observability limits

### [LB-09.01 / #80: Recognize research notes and reviewed decisions](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/80)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.01, LB-01.03.
- Implementation/test evidence: `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code.
- Next action: Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration.
- Acceptance criteria to verify against evidence:
  - Merged partial PR is not automatically a completed research issue
  - Every accepted finding links to note revision and review evidence

### [LB-09.02 / #88: Recognize catalogs, pricing and compatibility work](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/88)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-09.01, LB-03.05.
- Implementation/test evidence: `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code.
- Next action: Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration.
- Acceptance criteria to verify against evidence:
  - Synthetic imported contracts cannot become real research achievements
  - Accepted proposals do not imply production catalog publication

### [LB-09.03 / #89: Recognize market research and source curation](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/89)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-09.01.
- Implementation/test evidence: `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code.
- Next action: Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration.
- Acceptance criteria to verify against evidence:
  - Adding many URLs does not automatically create accepted findings
  - Unavailable sources block verified-claim credit; a reviewed negative freshness check may still receive its own effort recognition

### [LB-09.04 / #81: Recognize documentation, localization and learning resources](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/81)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.01, LB-01.05.
- Implementation/test evidence: `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code.
- Next action: Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration.
- Acceptance criteria to verify against evidence:
  - Generated documentation is tagged and cannot masquerade as authored prose
  - Documentation recognition does not depend on code LOC

### [LB-09.05 / #82: Recognize tests, accessibility and performance findings](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/82)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.01, LB-08.01.
- Implementation/test evidence: `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code.
- Next action: Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration.
- Acceptance criteria to verify against evidence:
  - Reported performance improvement requires comparable real evidence
  - Test count or coverage percentage alone cannot certify contribution quality

### [LB-09.06 / #90: Recognize design and security contributions safely](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/90)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-01.05, LB-09.04.
- Implementation/test evidence: `packages/metrics/src/v1/registry.json; packages/metrics/src/engine.ts; apps/controls/src; planning/metric-backlog-coverage.json`.
- Package-specific notes: [METRICS.md](METRICS.md).
- Remaining evidence / limit: Definitions and independent-review primitives exist; real accepted findings, rights and specialized review receipts are not supplied by generic code.
- Next action: Request revision-bound accepted evidence from owning research/mobile projects; consume rather than rewrite their contracts; PR154 owns recognition integration.
- Acceptance criteria to verify against evidence:
  - No private advisory or participant information enters public feed
  - Design evidence can be recognized without a code patch

### [LB-10.01 / #46: Enable discussion and support source adapters](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/46)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-04.01, LB-03.05.
- Implementation/test evidence: `apps/controls/src; packages/metrics/src/engine.ts; apps/web/src/routes/People.tsx`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Controls primitives and synthetic presentation exist. Actual independent review, collaborator consent and complete discussion/editorial/badge integrations need evidence.
- Next action: Coordinate PR154 receipt/recognition/card implementation; retain disabled states without invented endorsements.
- Acceptance criteria to verify against evidence:
  - Disabled discussions render as unavailable rather than zero contribution
  - Answer acceptance actor and author remain separate

### [LB-10.02 / #55: Create evidence submission and consent flow](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/55)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-01.05, LB-03.02, LB-17.02.
- Implementation/test evidence: `apps/controls/src; packages/metrics/src/engine.ts; apps/web/src/routes/People.tsx`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contributor-controls.md](contributor-controls.md).
- Remaining evidence / limit: Controls primitives and synthetic presentation exist. Actual independent review, collaborator consent and complete discussion/editorial/badge integrations need evidence.
- Next action: Coordinate PR154 receipt/recognition/card implementation; retain disabled states without invented endorsements.
- Acceptance criteria to verify against evidence:
  - Submitting a form alone awards no qualified contribution
  - Each collaborator can decline public attribution

### [LB-10.03 / #60: Build independent evidence review and appeals](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-10.02.
- Implementation/test evidence: `apps/controls/src; packages/metrics/src/engine.ts; apps/web/src/routes/People.tsx`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contributor-controls.md](contributor-controls.md).
- Remaining evidence / limit: Controls primitives and synthetic presentation exist. Actual independent review, collaborator consent and complete discussion/editorial/badge integrations need evidence.
- Next action: Coordinate PR154 receipt/recognition/card implementation; retain disabled states without invented endorsements.
- Acceptance criteria to verify against evidence:
  - Contributor cannot unilaterally approve their own recognition
  - Withdrawal removes public claim and recomputes dependent views
  - Include accepted and rejected receipt examples for governance decisions, sanitized deployment work, mentoring and reliability/postmortem contributions

### [LB-10.04 / #69: Create editorial contributor spotlights](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/69)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-10.03.
- Implementation/test evidence: `apps/controls/src; packages/metrics/src/engine.ts; apps/web/src/routes/People.tsx`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Controls primitives and synthetic presentation exist. Actual independent review, collaborator consent and complete discussion/editorial/badge integrations need evidence.
- Next action: Coordinate PR154 receipt/recognition/card implementation; retain disabled states without invented endorsements.
- Acceptance criteria to verify against evidence:
  - Spotlight links to verified evidence and selection explanation
  - No fabricated quote or endorsement is generated

### [LB-10.05 / #70: Design achievements and participation milestones](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/70)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-03.05, LB-10.03.
- Implementation/test evidence: `apps/controls/src; packages/metrics/src/engine.ts; apps/web/src/routes/People.tsx`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Controls primitives and synthetic presentation exist. Actual independent review, collaborator consent and complete discussion/editorial/badge integrations need evidence.
- Next action: Coordinate PR154 receipt/recognition/card implementation; retain disabled states without invented endorsements.
- Acceptance criteria to verify against evidence:
  - Every badge is reproducible from accepted evidence
  - All-time and period achievements explain their date basis

### [LB-11.01 / #83: Implement independent metric aggregates](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/83)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-03.05, LB-05.05.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [metric-engine.md](metric-engine.md).
- Remaining evidence / limit: PR156 explicitly preserves pending separately and leaves private snapshot-bound aggregate audit capture open. Generic engine audit arrays exist but are not a durable protected snapshot audit.
- Next action: Coordinate PR156 author, then implement/test private audit persistence bound to snapshot and policy without leaking suppressed IDs to public endpoints.
- Acceptance criteria to verify against evidence:
  - Every displayed value reconciles to its underlying eligible count, sum, ratio or sample, with unit and denominator
  - No hidden weighted total changes the ordering
  - Qualified counts never add provisional counts; display 14 accepted and 3 pending separately, with only 14 in the accepted rank

### [LB-11.02 / #91: Implement date, repository and workstream filters](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-11.01, LB-03.04.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`.
- Package-specific notes: [METRICS.md](METRICS.md), [metric-engine.md](metric-engine.md).
- Remaining evidence / limit: Count/sum/ratio/distribution, coverage, ties, correction and policy comparison candidates exist. Public activation and source-specific policies remain separate.
- Next action: Review PR156 pending counts; capture private snapshot-bound aggregate audit separately; reconcile real enabled metric results.
- Acceptance criteria to verify against evidence:
  - DST and boundary events appear in exactly the correct window
  - Overlapping Project filters do not double-count organization totals

### [LB-11.03 / #97: Implement ties, rank movement and stable ordering](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/97)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-11.02, LB-06.05.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`.
- Package-specific notes: [metric-engine.md](metric-engine.md).
- Remaining evidence / limit: Count/sum/ratio/distribution, coverage, ties, correction and policy comparison candidates exist. Public activation and source-specific policies remain separate.
- Next action: Review PR156 pending counts; capture private snapshot-bound aggregate audit separately; reconcile real enabled metric results.
- Acceptance criteria to verify against evidence:
  - Alphabetical tie ordering is not displayed as superior rank
  - Late backfill cannot masquerade as fresh contributor progress

### [LB-11.04 / #98: Implement newcomer and sustained-participation views](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/98)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-11.02, LB-06.05.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`.
- Package-specific notes: [METRICS.md](METRICS.md), [metric-engine.md](metric-engine.md).
- Remaining evidence / limit: Count/sum/ratio/distribution, coverage, ties, correction and policy comparison candidates exist. Public activation and source-specific policies remain separate.
- Next action: Review PR156 pending counts; capture private snapshot-bound aggregate audit separately; reconcile real enabled metric results.
- Acceptance criteria to verify against evidence:
  - Incomplete historic coverage never certifies a person as new
  - Acceptance ratios and review-wait statistics remain descriptive context with sample/censoring disclosure, not personal quality rankings

### [LB-11.05 / #109: Implement abuse resistance and correction handling](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/109)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-11.01, LB-08.06.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [metric-engine.md](metric-engine.md).
- Remaining evidence / limit: Count/sum/ratio/distribution, coverage, ties, correction and policy comparison candidates exist. Public activation and source-specific policies remain separate.
- Next action: Review PR156 pending counts; capture private snapshot-bound aggregate audit separately; reconcile real enabled metric results.
- Acceptance criteria to verify against evidence:
  - Label toggles, review spam and self-approval do not inflate qualified boards
  - No contributor receives a public accusation from automatic detection alone

### [LB-11.06 / #115: Version metric policies and compare recalculations](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/115)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-11.05, LB-06.06.
- Implementation/test evidence: `packages/metrics/src/engine.ts; packages/metrics/test/engine.test.js; docs/metric-engine.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [metric-engine.md](metric-engine.md).
- Remaining evidence / limit: Count/sum/ratio/distribution, coverage, ties, correction and policy comparison candidates exist. Public activation and source-specific policies remain separate.
- Next action: Review PR156 pending counts; capture private snapshot-bound aggregate audit separately; reconcile real enabled metric results.
- Acceptance criteria to verify against evidence:
  - Policy rollout is reproducible and reversible
  - Historical comparisons identify mixed policy versions

### [LB-12.01 / #99: Implement public leaderboard query API](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/99)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-11.02, LB-04.05.
- Implementation/test evidence: `apps/service/src; apps/service/test; docs/read-api.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [read-api.md](read-api.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Bounded public API, portfolio/activity/proof/exports and privacy rechecks exist with synthetic tests. Actual source/deployed freshness acceptance remains open.
- Next action: Verify final integration and anonymous deployed readback with approved real snapshots and correction propagation.
- Acceptance criteria to verify against evidence:
  - Anonymous client can browse approved public boards
  - Invalid or costly queries fail safely without database exhaustion

### [LB-12.02 / #105: Implement contributor and evidence APIs](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/105)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-12.01, LB-03.02.
- Implementation/test evidence: `apps/service/src; apps/service/test; docs/read-api.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [contributor-directory-runtime.md](contributor-directory-runtime.md), [read-api.md](read-api.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Bounded public API, portfolio/activity/proof/exports and privacy rechecks exist with synthetic tests. Actual source/deployed freshness acceptance remains open.
- Next action: Verify final integration and anonymous deployed readback with approved real snapshots and correction propagation.
- Acceptance criteria to verify against evidence:
  - Profile totals reconcile with the same board snapshot
  - Private evidence cannot leak through artifact detail routes

### [LB-12.03 / #106: Implement live update transport and polling fallback](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/106)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-12.01, LB-05.05.
- Implementation/test evidence: `apps/service/src; apps/service/test; docs/read-api.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [read-api.md](read-api.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Bounded public API, portfolio/activity/proof/exports and privacy rechecks exist with synthetic tests. Actual source/deployed freshness acceptance remains open.
- Next action: Verify final integration and anonymous deployed readback with approved real snapshots and correction propagation.
- Acceptance criteria to verify against evidence:
  - Reconnect after missed notices converges to current snapshot
  - Fallback UI truthfully reports actual freshness

### [LB-12.04 / #110: Implement exports and public integration data](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/110)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-12.02.
- Implementation/test evidence: `apps/service/src; apps/service/test; docs/read-api.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [read-api.md](read-api.md).
- Remaining evidence / limit: Bounded public API, portfolio/activity/proof/exports and privacy rechecks exist with synthetic tests. Actual source/deployed freshness acceptance remains open.
- Next action: Verify final integration and anonymous deployed readback with approved real snapshots and correction propagation.
- Acceptance criteria to verify against evidence:
  - Exported totals reproduce selected filters and snapshot
  - Export cannot bypass privacy or eligibility controls
  - Enabled portfolio formats preserve metric definition, source URL, snapshot and date scope; disabled formats are explicitly documented

### [LB-12.05 / #92: Implement health and source coverage API](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/92)

- State: OPEN / partial or acceptance unverified. Gate: Automated validation.
- Dependencies (baseline): LB-06.05, LB-05.06.
- Implementation/test evidence: `apps/service/src; apps/service/test; docs/read-api.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [read-api.md](read-api.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Bounded public API, portfolio/activity/proof/exports and privacy rechecks exist with synthetic tests. Actual source/deployed freshness acceptance remains open.
- Next action: Verify final integration and anonymous deployed readback with approved real snapshots and correction propagation.
- Acceptance criteria to verify against evidence:
  - Source outage yields a stale/degraded response without fake live status
  - Public health output contains no operational secrets

### [LB-13.01 / #47: Integrate exact Claude Opus UI consultation](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/47)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-01.01, LB-04.01.
- Implementation/test evidence: `planning/ui/ui-concept.json; apps/web/src; apps/web/browser; docs/ui-validation.md`.
- Remaining evidence / limit: The consultation record names requested and observed claude-opus-5-5 and marks success at 2026-10-17T02:30:57.056827+00:00. docs/ui-prototype.md retains hashes of the prompt/full response/raw receipt and adopted/adapted/deferred choices. Freshly read issue comment explicitly leaves #41 source-capability reconciliation and affected-owner acceptance open. The receipt alone does not satisfy full completion.
- Next action: Keep open. Resolve unsupported data assumptions against actual #41 findings, verify retained artifact availability without committing session receipts, and obtain affected-owner acceptance of the accessible journey and evidence/privacy reconciliation.
- Acceptance criteria to verify against evidence:
  - Consultation receipt identifies claude-opus-5-5
  - Recommendations do not override evidence and privacy rules

### [LB-13.02 / #52: Design navigation and metric discovery](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/52)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-13.01, LB-03.05.
- Implementation/test evidence: `planning/ui/ui-concept.json; apps/web/src; apps/web/browser; docs/ui-validation.md`.
- Remaining evidence / limit: Recorded exact-model consultation and responsive synthetic UI exist. Automated browser evidence does not replace participant or assistive-technology review.
- Next action: Validate exact consultation receipt and usability scenarios; run manual zoom, touch and screen-reader walkthroughs.
- Acceptance criteria to verify against evidence:
  - PR, LOC, triage, research and review journeys are independently discoverable
  - Filters survive route changes and have shareable URLs
  - Back/forward and a copied URL restore the same supported scope and snapshot; invalid parameters receive a visible explanation

### [LB-13.03 / #56: Create responsive design tokens and components](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/56)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-13.02.
- Implementation/test evidence: `planning/ui/ui-concept.json; apps/web/src; apps/web/browser; docs/ui-validation.md`.
- Remaining evidence / limit: Recorded exact-model consultation and responsive synthetic UI exist. Automated browser evidence does not replace participant or assistive-technology review.
- Next action: Validate exact consultation receipt and usability scenarios; run manual zoom, touch and screen-reader walkthroughs.
- Acceptance criteria to verify against evidence:
  - Color and icon never carry meaning without text
  - 320px layout and 200%/400% zoom preserve content and controls
  - UI remains usable with custom fonts blocked and optional artwork disabled; remote website styling changes cannot silently alter the leaderboard build

### [LB-13.04 / #61: Prototype representative end-to-end journeys](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/61)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-13.03.
- Implementation/test evidence: `planning/ui/ui-concept.json; apps/web/src; apps/web/browser; docs/ui-validation.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md).
- Remaining evidence / limit: Recorded exact-model consultation and responsive synthetic UI exist. Automated browser evidence does not replace participant or assistive-technology review.
- Next action: Validate exact consultation receipt and usability scenarios; run manual zoom, touch and screen-reader walkthroughs.
- Acceptance criteria to verify against evidence:
  - Every prototype count links to a fixture explanation
  - Keyboard and touch walkthroughs complete all primary journeys

### [LB-13.05 / #71: Review usability, accessibility and visual coherence](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/71)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-13.04.
- Implementation/test evidence: `planning/ui/ui-concept.json; apps/web/src; apps/web/browser; docs/ui-validation.md`.
- Remaining evidence / limit: Recorded exact-model consultation and responsive synthetic UI exist. Automated browser evidence does not replace participant or assistive-technology review.
- Next action: Validate exact consultation receipt and usability scenarios; run manual zoom, touch and screen-reader walkthroughs.
- Acceptance criteria to verify against evidence:
  - Users can identify why a contribution counted and what is missing
  - Outstanding accessibility issues have explicit remediation owners
  - Participants can locate their contribution and public source and explain true zero versus unavailable data and observed versus accepted work

### [LB-14.01 / #107: Build organization overview and category entry points](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/107)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-13.05, LB-12.01.
- Implementation/test evidence: `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate.
- Next action: Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot.
- Acceptance criteria to verify against evidence:
  - Overview never combines incompatible metrics into one score
  - Research and triage remain visible without scrolling through code rankings
  - A department without a qualified outcome remains visible without fabricating an accepted metric or treating unsupported history as zero

### [LB-14.02 / #111: Build searchable sortable leaderboard views](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/111)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-14.01, LB-11.03.
- Implementation/test evidence: `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate.
- Next action: Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot.
- Acceptance criteria to verify against evidence:
  - Keyboard users can filter, sort, paginate and inspect a row
  - Visible values reconcile with selected snapshot API
  - Top-N views do not hide tied contributors as lower-ranked; all list expansion and pagination paths have documented resource bounds
  - LOC is never presented as overall contributor merit; the UI exposes generated/imported/formatting exclusions and unknown classification rather than hiding them

### [LB-14.03 / #116: Build contribution evidence drawer and detail route](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/116)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-12.02, LB-14.02.
- Implementation/test evidence: `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [api-evidence-drawer.md](api-evidence-drawer.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate.
- Next action: Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot.
- Acceptance criteria to verify against evidence:
  - A displayed count can be audited without administrative access
  - Unavailable source displays its limitation without fabricated replacement
  - Proof drawer and permanent detail route expose the same permitted evidence and preserve focus; no acceptance date is invented for a purely observed action

### [LB-14.04 / #117: Build Project, repository and workstream views](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/117)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-14.02, LB-03.04.
- Implementation/test evidence: `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate.
- Next action: Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot.
- Acceptance criteria to verify against evidence:
  - Android and Apple planning contributions are distinguishable
  - No duplicate credit is implied when the same PR serves multiple programs
  - Preserve distinct field vocabularies across all five Projects; only the new leaderboard Project receives the proposed new schema

### [LB-14.05 / #100: Build methodology, coverage and correction entry points](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/100)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-12.05, LB-03.05, LB-17.03.
- Implementation/test evidence: `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate.
- Next action: Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot.
- Acceptance criteria to verify against evidence:
  - Correction destination is functional and receipt-producing
  - Unknown and unavailable metrics cannot look like zero
  - Every enabled board exposes its method and coverage; corrected values link to a privacy-safe explanation and completeness percentages require a known denominator

### [LB-14.06 / #118: Implement full loading, empty and failure behavior](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/118)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-14.02, LB-12.05.
- Implementation/test evidence: `apps/web/src/remote; apps/web/browser; apps/service/src; docs/remote-ui.md; docs/api-evidence-drawer.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Service-backed boards, proof drawer, reference states and routes exist. Live source correctness, private correction delivery and full journey acceptance remain separate.
- Next action: Review PR154 controls integration and PR156 counts; execute keyboard/source reconciliation against final approved snapshot.
- Acceptance criteria to verify against evidence:
  - Each failure fixture has a truthful user-visible state
  - A disconnected source cannot retain a live-green indicator
  - A missing production snapshot cannot render invented contributor data; fixture routes remain visibly synthetic in all empty, error and share states

### [LB-15.01 / #112: Build contributor directory and profiles](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/112)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-12.02, LB-13.05.
- Implementation/test evidence: `apps/service/src/app.ts; apps/web/src/remote; docs/contributor-directory-runtime.md; apps/service/test/read-api.test.mjs`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contributor-directory-runtime.md](contributor-directory-runtime.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Directory and paginated portfolios exist with public observed-work eligibility and suppression. Account UI, cards and achievement integration remain owned work.
- Next action: Coordinate PR154 account/card/recognition changes; verify consent and suppression across shares before public enablement.
- Acceptance criteria to verify against evidence:
  - Non-members with public contributions appear when eligible
  - Deleted and hidden identities cannot leak through search
  - Directory includes people with attributable public observed work even before accepted outcomes, with status made clear; assignment, mention or membership alone does not create earned-work credit

### [LB-15.02 / #120: Build contribution portfolio and timeline](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/120)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-15.01, LB-14.03.
- Implementation/test evidence: `apps/service/src/app.ts; apps/web/src/remote; docs/contributor-directory-runtime.md; apps/service/test/read-api.test.mjs`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contributor-directory-runtime.md](contributor-directory-runtime.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Directory and paginated portfolios exist with public observed-work eligibility and suppression. Account UI, cards and achievement integration remain owned work.
- Next action: Coordinate PR154 account/card/recognition changes; verify consent and suppression across shares before public enablement.
- Acceptance criteria to verify against evidence:
  - Timeline and category totals share filter and snapshot semantics
  - Progressive loading preserves complete accessible navigation
  - Portfolio does not sum unlike contribution measures into a personal score and does not expose identity-linking emails or private work

### [LB-15.03 / #119: Implement profile claims, preferences and consent](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/119)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-15.01, LB-17.02.
- Implementation/test evidence: `apps/service/src/app.ts; apps/web/src/remote; docs/contributor-directory-runtime.md; apps/service/test/read-api.test.mjs`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contributor-controls.md](contributor-controls.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Directory and paginated portfolios exist with public observed-work eligibility and suppression. Account UI, cards and achievement integration remain owned work.
- Next action: Coordinate PR154 account/card/recognition changes; verify consent and suppression across shares before public enablement.
- Acceptance criteria to verify against evidence:
  - Anonymous visitors remain able to browse without login
  - Only verified account holder can change optional profile presentation

### [LB-15.04 / #123: Implement shareable cards and embeds](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/123)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-15.02, LB-12.04.
- Implementation/test evidence: `apps/service/src/app.ts; apps/web/src/remote; docs/contributor-directory-runtime.md; apps/service/test/read-api.test.mjs`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Directory and paginated portfolios exist with public observed-work eligibility and suppression. Account UI, cards and achievement integration remain owned work.
- Next action: Coordinate PR154 account/card/recognition changes; verify consent and suppression across shares before public enablement.
- Acceptance criteria to verify against evidence:
  - Shared card cannot imply live data after its snapshot date
  - Cards and embeds never reveal hidden contributor fields

### [LB-15.05 / #124: Implement newcomer, collaborator and achievement sections](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/124)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-15.02, LB-10.05, LB-11.04.
- Implementation/test evidence: `apps/service/src/app.ts; apps/web/src/remote; docs/contributor-directory-runtime.md; apps/service/test/read-api.test.mjs`.
- Package-specific notes: [METRICS.md](METRICS.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Directory and paginated portfolios exist with public observed-work eligibility and suppression. Account UI, cards and achievement integration remain owned work.
- Next action: Coordinate PR154 account/card/recognition changes; verify consent and suppression across shares before public enablement.
- Acceptance criteria to verify against evidence:
  - Achievement evidence is available to profile viewers
  - Newcomer status is withheld when historic coverage is insufficient

### [LB-16.01 / #121: Build live activity feed with source proof](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/121)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-12.03, LB-14.03.
- Implementation/test evidence: `apps/service/src/activity.ts; apps/service/src/live-client.ts; apps/web/src/remote/Activity.tsx; apps/web/browser/remote.spec.ts`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [read-api.md](read-api.md), [ui-prototype.md](ui-prototype.md), [ui-validation.md](ui-validation.md).
- Remaining evidence / limit: Bounded activity feed and polling/held-update primitives exist. Long-duration soak and actual display/readiness acceptance are not established.
- Next action: Add bounded synthetic reconnect/soak evidence independently; verify real stale/quiet distinctions and assistive announcements.
- Acceptance criteria to verify against evidence:
  - Feed event date differs visibly from delayed collection when needed
  - Bulk metadata updates cannot flood all other work off the screen

### [LB-16.02 / #125: Build public live wall and stream layout](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/125)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-16.01, LB-13.03.
- Implementation/test evidence: `apps/service/src/activity.ts; apps/service/src/live-client.ts; apps/web/src/remote/Activity.tsx; apps/web/browser/remote.spec.ts`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Bounded activity feed and polling/held-update primitives exist. Long-duration soak and actual display/readiness acceptance are not established.
- Next action: Add bounded synthetic reconnect/soak evidence independently; verify real stale/quiet distinctions and assistive announcements.
- Acceptance criteria to verify against evidence:
  - Live wall remains readable at intended display resolution
  - Disconnected collector produces an unmistakable stale state
  - Frozen mode never updates; live modes refresh only at safe boundaries; scope/freshness and pause remain visible; no external display application launches automatically
  - Wall defaults to avatars off, honors contributor display suppression and reduced motion, and does not repeatedly expose only highest-volume contributors

### [LB-16.03 / #126: Control live reordering and announcements](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/126)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-16.01, LB-14.02.
- Implementation/test evidence: `apps/service/src/activity.ts; apps/service/src/live-client.ts; apps/web/src/remote/Activity.tsx; apps/web/browser/remote.spec.ts`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Bounded activity feed and polling/held-update primitives exist. Long-duration soak and actual display/readiness acceptance are not established.
- Next action: Add bounded synthetic reconnect/soak evidence independently; verify real stale/quiet distinctions and assistive announcements.
- Acceptance criteria to verify against evidence:
  - Keyboard focus remains on the same control through an update
  - Screen reader receives useful summaries rather than every row movement
  - Background updates do not reorder an engaged table or replace focused proof; each applied batch uses one snapshot and one throttled polite summary

### [LB-16.04 / #127: Test reconnect, idle and long-running display behavior](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/127)

- State: OPEN / partial or acceptance unverified. Gate: Accessible user journey.
- Dependencies (baseline): LB-16.02, LB-16.03.
- Implementation/test evidence: `apps/service/src/activity.ts; apps/service/src/live-client.ts; apps/web/src/remote/Activity.tsx; apps/web/browser/remote.spec.ts`.
- Package-specific notes: [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Reconnect tests exist, but a documented sustained-display soak with bounded resource observations is not shown.
- Next action: Add a reproducible bounded synthetic soak harness with reconnect, duplicate suppression and resumed freshness assertions; distinguish it from deployed load acceptance.
- Acceptance criteria to verify against evidence:
  - Recovered display shows a fresh known snapshot without duplicate entries
  - No new activity and disconnected source have different states
  - Documented soak shows bounded resource use and correct resumed freshness without duplicate contributions

### [LB-17.01 / #93: Build protected operator console](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/93)

- State: OPEN / partial or acceptance unverified. Gate: Operational drill.
- Dependencies (baseline): LB-05.06, LB-17.02.
- Implementation/test evidence: `apps/controls/src; apps/controls/test/controls.test.mjs; docs/contributor-controls.md`.
- Remaining evidence / limit: Protected controls, OAuth/session primitives and projection suppression exist. Complete operator/account/evidence-review UI and real identity-provider acceptance remain owned work.
- Next action: Coordinate PR154 admin/account/receipt/policy changes; prove direct API authorization, durable receipts and actual public correction impact.
- Acceptance criteria to verify against evidence:
  - Public users cannot access operational controls
  - Every replay or exclusion action has a durable receipt

### [LB-17.02 / #53: Implement authentication and authorization boundaries](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/53)

- State: OPEN / partial or acceptance unverified. Gate: Operational drill.
- Dependencies (baseline): LB-04.02, LB-18.01.
- Implementation/test evidence: `apps/controls/src; apps/controls/test/controls.test.mjs; docs/contributor-controls.md`.
- Package-specific notes: [contributor-controls.md](contributor-controls.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Protected controls, OAuth/session primitives and projection suppression exist. Complete operator/account/evidence-review UI and real identity-provider acceptance remain owned work.
- Next action: Coordinate PR154 admin/account/receipt/policy changes; prove direct API authorization, durable receipts and actual public correction impact.
- Acceptance criteria to verify against evidence:
  - Role checks cannot be bypassed through direct API calls
  - GitHub ingestion App credentials are never reused as browser credentials

### [LB-17.03 / #94: Implement correction, opt-out and identity dispute workflow](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/94)

- State: OPEN / partial or acceptance unverified. Gate: Operational drill.
- Dependencies (baseline): LB-17.02, LB-06.04.
- Implementation/test evidence: `apps/controls/src; apps/controls/test/controls.test.mjs; docs/contributor-controls.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [contributor-controls.md](contributor-controls.md), [ui-prototype.md](ui-prototype.md).
- Remaining evidence / limit: Protected controls, OAuth/session primitives and projection suppression exist. Complete operator/account/evidence-review UI and real identity-provider acceptance remain owned work.
- Next action: Coordinate PR154 admin/account/receipt/policy changes; prove direct API authorization, durable receipts and actual public correction impact.
- Acceptance criteria to verify against evidence:
  - End-to-end request changes the actual public output
  - A rendered form without accepted storage/delivery fails acceptance
  - Privacy requests are not directed to public issues; no invented inbox or non-delivering form qualifies as complete; correction messaging does not unnecessarily reveal a named person's privacy choice

### [LB-17.04 / #122: Implement metric policy and evidence review console](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/122)

- State: OPEN / partial or acceptance unverified. Gate: Operational drill.
- Dependencies (baseline): LB-10.03, LB-11.06, LB-17.01.
- Implementation/test evidence: `apps/controls/src; apps/controls/test/controls.test.mjs; docs/contributor-controls.md`.
- Package-specific notes: [contributor-controls.md](contributor-controls.md).
- Remaining evidence / limit: Protected controls, OAuth/session primitives and projection suppression exist. Complete operator/account/evidence-review UI and real identity-provider acceptance remain owned work.
- Next action: Coordinate PR154 admin/account/receipt/policy changes; prove direct API authorization, durable receipts and actual public correction impact.
- Acceptance criteria to verify against evidence:
  - Reviewer decisions can be appealed and rolled back
  - Unreviewed policy cannot alter public qualified rankings
  - Moderation adjustments affect internal recognition/projections only; read-only ingestion never reverts upstream GitHub issues, labels or PRs

### [LB-17.05 / #101: Implement repository and metric configuration management](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/101)

- State: OPEN / partial or acceptance unverified. Gate: Operational drill.
- Dependencies (baseline): LB-17.01, LB-03.05.
- Implementation/test evidence: `apps/controls/src; apps/controls/test/controls.test.mjs; docs/contributor-controls.md`.
- Package-specific notes: [contributor-controls.md](contributor-controls.md).
- Remaining evidence / limit: Protected controls, OAuth/session primitives and projection suppression exist. Complete operator/account/evidence-review UI and real identity-provider acceptance remain owned work.
- Next action: Coordinate PR154 admin/account/receipt/policy changes; prove direct API authorization, durable receipts and actual public correction impact.
- Acceptance criteria to verify against evidence:
  - Config change is versioned and source-tested
  - Disabled metric retains clear explanation and historical policy link

### [LB-18.01 / #39: Threat-model trust boundaries](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/39)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-03.01, LB-01.05.
- Implementation/test evidence: `docs/security-candidate.md; apps/controls/src; apps/service/src/public-source.ts; infra/recovery`.
- Package-specific notes: [security-candidate.md](security-candidate.md), [source-capability-candidate.md](source-capability-candidate.md).
- Remaining evidence / limit: Fail-closed projections, content restrictions, session boundaries and recovery candidates exist. Evidence-retention purge policy/jobs and deployment secret drill remain distinct gaps.
- Next action: Audit retention architecture and source boundaries; review PR157 safeguards; require independent final security/privacy evidence.
- Acceptance criteria to verify against evidence:
  - Each high-risk trust boundary has a proposed mitigation, implementation package and test owner role
  - No source-provided text is treated as executable instruction

### [LB-18.02 / #108: Harden public content and export rendering](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/108)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-18.01, LB-12.01.
- Implementation/test evidence: `docs/security-candidate.md; apps/controls/src; apps/service/src/public-source.ts; infra/recovery`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [read-api.md](read-api.md), [security-candidate.md](security-candidate.md), [source-capability-candidate.md](source-capability-candidate.md).
- Remaining evidence / limit: Fail-closed projections, content restrictions, session boundaries and recovery candidates exist. Evidence-retention purge policy/jobs and deployment secret drill remain distinct gaps.
- Next action: Audit retention architecture and source boundaries; review PR157 safeguards; require independent final security/privacy evidence.
- Acceptance criteria to verify against evidence:
  - Malicious repository title/body/URL fixtures cannot execute
  - External evidence links cannot reach private network services; an enabled export module also requires accepted CSV formula-injection tests

### [LB-18.03 / #95: Implement data minimization and retention](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-18.01, LB-06.04.
- Implementation/test evidence: `docs/security-candidate.md; apps/controls/src; apps/service/src/public-source.ts; infra/recovery`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md).
- Remaining evidence / limit: Current expiry covers worker leases, OAuth/session expiry and bounded observability. A source-evidence retention purge with durable receipts is not demonstrated; suppression alone is not deletion. PR157 covers restore safeguards, not full retention.
- Next action: Design policy-bound purge across observations, snapshots, corrections and backups, preserving current suppression on restore; coordinate source/storage owners before coding.
- Acceptance criteria to verify against evidence:
  - Retention jobs remove expired data with receipts
  - Privatized repositories cannot remain visible through archived API snapshots
  - Analytics cannot reconstruct a contributor productivity dashboard or reveal suppressed profile choices; anonymous browsing remains usable without tracking consent

### [LB-18.04 / #42: Harden deployment and secret lifecycle](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/42)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-02.05, LB-18.01.
- Implementation/test evidence: `docs/security-candidate.md; apps/controls/src; apps/service/src/public-source.ts; infra/recovery`.
- Remaining evidence / limit: Fail-closed projections, content restrictions, session boundaries and recovery candidates exist. Evidence-retention purge policy/jobs and deployment secret drill remain distinct gaps.
- Next action: Audit retention architecture and source boundaries; review PR157 safeguards; require independent final security/privacy evidence.
- Acceptance criteria to verify against evidence:
  - Leaked or revoked test secret can be rotated without data loss
  - Untrusted PR jobs cannot read deployment or GitHub App secrets

### [LB-18.05 / #113: Review privacy and security release evidence](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/113)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-18.02, LB-18.03, LB-18.04, LB-17.03.
- Implementation/test evidence: `docs/security-candidate.md; apps/controls/src; apps/service/src/public-source.ts; infra/recovery`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Fail-closed projections, content restrictions, session boundaries and recovery candidates exist. Evidence-retention purge policy/jobs and deployment secret drill remain distinct gaps.
- Next action: Audit retention architecture and source boundaries; review PR157 safeguards; require independent final security/privacy evidence.
- Acceptance criteria to verify against evidence:
  - No unresolved critical public-data or authorization issue remains
  - Review report names what was tested and what remains unknown

### [LB-19.01 / #72: Build invariant and adversarial metric tests](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-03.05, LB-05.03.
- Implementation/test evidence: `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Engine and contract adversarial tests exist. Registry parity does not prove a meaningful inclusion and exclusion for each enabled metric or the exact 107-entry/92-SHA research case.
- Next action: Produce explicit enabled-metric coverage mapping and add missing invariant cases; source sanitization remains required for real research fixtures.
- Acceptance criteria to verify against evidence:
  - Each public metric has at least one meaningful inclusion and exclusion case
  - Regressions fail on incorrect actor, count or coverage
  - Use sanitized stacked research PR evidence: 107 merged-PR commit entries contain 92 unique SHAs; intermediate branch merges cannot inflate default-branch delivery
  - Test REST/GraphQL automation alias mismatch with wasAutomated=false, member assignments without earned work and all four unboarded issue cases

### [LB-19.02 / #84: Build source contract and integration tests](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/84)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-04.01, LB-05.05.
- Implementation/test evidence: `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [PIPELINE.md](PIPELINE.md), [ingestion-completion.md](ingestion-completion.md), [webhook-dispatch.md](webhook-dispatch.md).
- Remaining evidence / limit: Synthetic invariant/browser/database suites exist; no claim of real-data reconciliation, manual accessibility, accepted scale budgets or staging recovery follows.
- Next action: Run required suite on reviewed head; add meaningful missing adversarial coverage; obtain actual source/participant/staging evidence.
- Acceptance criteria to verify against evidence:
  - Schema drift quarantines affected events with clear diagnostics
  - No integration test mutates real contribution history

### [LB-19.03 / #128: Verify accessible primary journeys](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/128)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-14.06, LB-15.02, LB-16.03.
- Implementation/test evidence: `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-validation.md](ui-validation.md).
- Remaining evidence / limit: Synthetic invariant/browser/database suites exist; no claim of real-data reconciliation, manual accessibility, accepted scale budgets or staging recovery follows.
- Next action: Run required suite on reviewed head; add meaningful missing adversarial coverage; obtain actual source/participant/staging evidence.
- Acceptance criteria to verify against evidence:
  - Primary journeys complete with keyboard and screen reader
  - No known critical accessibility failure ships
  - Primary journeys and unknown/error/privacy/tie states preserve meaning, contrast and focus across documented assistive-technology and responsive checks

### [LB-19.04 / #129: Verify performance, scale and resource bounds](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/129)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-12.03, LB-16.04.
- Implementation/test evidence: `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [ui-validation.md](ui-validation.md).
- Remaining evidence / limit: Synthetic invariant/browser/database suites exist; no claim of real-data reconciliation, manual accessibility, accepted scale budgets or staging recovery follows.
- Next action: Run required suite on reviewed head; add meaningful missing adversarial coverage; obtain actual source/participant/staging evidence.
- Acceptance criteria to verify against evidence:
  - Results meet agreed budgets at documented test scale
  - Overload degrades safely without dropping acknowledged events

### [LB-19.05 / #114: Run real-data reconciliation and contributor review](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/114)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-07.06, LB-08.06, LB-09.06, LB-14.05.
- Implementation/test evidence: `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`.
- Package-specific notes: [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md).
- Remaining evidence / limit: Synthetic invariant/browser/database suites exist; no claim of real-data reconciliation, manual accessibility, accepted scale budgets or staging recovery follows.
- Next action: Run required suite on reviewed head; add meaningful missing adversarial coverage; obtain actual source/participant/staging evidence.
- Acceptance criteria to verify against evidence:
  - Sample audit has source links and accepted variance explanations
  - No unsupported quality claim appears in UI wording

### [LB-19.06 / #130: Run release, failure and recovery acceptance suite](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/130)

- State: OPEN / partial or acceptance unverified. Gate: Evidence review.
- Dependencies (baseline): LB-19.01, LB-19.02, LB-19.03, LB-19.04, LB-19.05, LB-18.05, LB-20.03, LB-04.03, LB-01.06, LB-09.02, LB-09.03, LB-09.05, LB-14.04, LB-11.06.
- Implementation/test evidence: `tests; packages/metrics/test; apps/web/browser; infra/recovery/test; docs/ui-validation.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OBSERVABILITY.md](OBSERVABILITY.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [RECOVERY.md](RECOVERY.md).
- Remaining evidence / limit: Synthetic invariant/browser/database suites exist; no claim of real-data reconciliation, manual accessibility, accepted scale budgets or staging recovery follows.
- Next action: Run required suite on reviewed head; add meaningful missing adversarial coverage; obtain actual source/participant/staging evidence.
- Acceptance criteria to verify against evidence:
  - Fresh useful staging progress resumes after controlled recovery
  - Every enabled production capability has accepted source, metric, security and journey evidence before authorization

### [LB-20.01 / #48: Provision approved staging and production infrastructure](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/48)

- State: OPEN / partial or acceptance unverified. Gate: Verified public release.
- Dependencies (baseline): LB-01.04, LB-18.04.
- Implementation/test evidence: `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md).
- Remaining evidence / limit: Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent.
- Next action: Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch.
- Acceptance criteria to verify against evidence:
  - Host capability and recurring-cost assumptions are verified
  - No production exposure occurs before authorized release step

### [LB-20.02 / #102: Instrument service and source observability](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/102)

- State: OPEN / partial or acceptance unverified. Gate: Verified public release.
- Dependencies (baseline): LB-20.01, LB-12.05.
- Implementation/test evidence: `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`.
- Package-specific notes: [OBSERVABILITY.md](OBSERVABILITY.md).
- Remaining evidence / limit: Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent.
- Next action: Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch.
- Acceptance criteria to verify against evidence:
  - An injected collection failure produces a useful actionable alert
  - Public status agrees with internal observed collection state

### [LB-20.03 / #103: Implement backup, restore and disaster recovery](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/103)

- State: OPEN / partial or acceptance unverified. Gate: Verified public release.
- Dependencies (baseline): LB-20.01, LB-06.06.
- Implementation/test evidence: `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [RECOVERY.md](RECOVERY.md).
- Remaining evidence / limit: Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent.
- Next action: Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch.
- Acceptance criteria to verify against evidence:
  - Restore drill reproduces a known snapshot and correction state
  - Recovery report records measured values, not estimated success

### [LB-20.04 / #131: Run shadow, beta and launch gates](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/131)

- State: OPEN / partial or acceptance unverified. Gate: Verified public release.
- Dependencies (baseline): LB-19.06, LB-20.02.
- Implementation/test evidence: `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`.
- Package-specific notes: [GOVERNANCE.md](GOVERNANCE.md), [OPERATIONS_PLAN.md](OPERATIONS_PLAN.md), [RECOVERY.md](RECOVERY.md).
- Remaining evidence / limit: Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent.
- Next action: Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch.
- Acceptance criteria to verify against evidence:
  - Each phase exit has actual evidence and named decision role
  - Deployed public page shows approved revision and working data refresh

### [LB-20.05 / #132: Integrate organization discovery surfaces](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/132)

- State: OPEN / partial or acceptance unverified. Gate: Verified public release.
- Dependencies (baseline): LB-20.04, LB-15.04.
- Implementation/test evidence: `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`.
- Remaining evidence / limit: Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent.
- Next action: Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch.
- Acceptance criteria to verify against evidence:
  - Organization and website links reach the actual live leaderboard
  - Existing issue ownership and Project metadata remain preserved

### [LB-20.06 / #133: Establish ongoing maintenance and expansion policy](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/133)

- State: OPEN / partial or acceptance unverified. Gate: Verified public release.
- Dependencies (baseline): LB-20.04, LB-17.05.
- Implementation/test evidence: `infra/observability; infra/recovery; docs/OBSERVABILITY.md; docs/RECOVERY.md; docs/OPERATIONS_PLAN.md; docs/PUBLIC_TARGET.md`.
- Package-specific notes: [METRICS.md](METRICS.md), [OBSERVABILITY.md](OBSERVABILITY.md).
- Remaining evidence / limit: Observability and local recovery primitives exist; target domain selected. Provisioning, cost/operator acceptance, real staging/production and handoff remain absent.
- Next action: Review PR157 then obtain approved existing host and operator inputs; perform measured drills and anonymous release readback before launch.
- Acceptance criteria to verify against evidence:
  - Operational owner and review cadence are explicitly accepted
  - Expansion does not silently collect private data or change score definitions
  - Retained-line blame remains explicitly deferred; enabling it requires its own approved package for bounded read-only blame, lineage, moved-code limitations, privacy and UI caveats

## Focused follow-up: protected aggregate audit (#83)

At the inspected source revision, `apps/pipeline/src/runtime.mjs` computes `aggregates` but persists only public rows/diagnostics and a publication receipt carrying dataset/configuration/policy metadata. `aggregate.audit` inclusion/exclusion reasons are not stored with a snapshot. `docs/metric-engine.md` explicitly warns that audit entries may contain suppressed actor/fact IDs and must not be serialized publicly. PR156 expressly defers private snapshot-bound aggregate audit capture.

The safe candidate is a separate private aggregate-audit table keyed by immutable snapshot ID and metric/policy signature, containing deterministic audit decisions plus dataset ID, scope, policy/definition versions and an integrity hash. Insert it atomically in the existing snapshot publication transaction before advancing the head; reject conflicting retries and require idempotent republish to verify the matching audit. The snapshot document, public read API, activity, exports and error messages must never include this data. Any read interface needs separate operator authorization; a storage-only first slice avoids inventing a public endpoint. Retention, encrypted backup/restore and correction-history handling must explicitly include this private table before production use.

Required regressions: a suppressed/excluded synthetic fact appears only in private audit; public responses/exports never serialize it; rollback leaves neither snapshot nor audit; retry preserves one identical audit; conflicting audit content fails; policy/snapshot/cutoff identity remains exact; historical public pins still enforce current suppression. Integrate after PR156 to preserve its selected pending provenance.

Ownership is **not yet cleared**: PR154's currently published changed files are worker/instructions/docs only, but active comments reserve receipt/policy wiring and collectors, which overlap pipeline publication. #83 has no comments. No explicit reservation for the audit itself was found, but absence of a published diff is not proof that the file is free. Coordinate with PR154 and PR156 authors before implementing `apps/pipeline/src/runtime.mjs` changes. This follow-up made no code or GitHub changes.

## Audit validation and limitations

- Coverage verified: all 133 publication-map IDs appear exactly once as a program, epic or work-package heading/row; all 112 package acceptance arrays are copied without omission. Every baseline acceptance criterion was also found verbatim in its freshly fetched live issue body; no acceptance drift was detected by that comparison.
- This audit does not change baseline scope, generated documents, assignees, native relationships, Project fields, GitHub comments or issue state.
- Validation run for this ledger: `python scripts/validate_plan.py` passed; `python -m unittest discover -s tests -v` passed all 27 tests; `python scripts/render_docs.py --check` passed (11 generated files, no changes). These checks do not certify runtime or release acceptance.
- Release gates still need real installed-source capability, approved policies and retention, accepted operating responsibilities, manual accessibility, measured host/recovery evidence and anonymous deployed readback. No production benchmarks, rights clearance, account credentials or external acceptance were manufactured.
