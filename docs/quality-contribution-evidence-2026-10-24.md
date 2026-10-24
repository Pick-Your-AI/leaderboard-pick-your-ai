# Quality contribution evidence for LB-09.05

Refs [#82](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/82).
Evidence checked on 2026-10-24 against main
`a1f8f07ac31d0851c1752cf3b1dd5696c4ba9fb9`.

This packet connects existing delivered changes to the four work-package tasks
and records a fresh, bounded reproduction of their software behavior. It is ready
for evidence review; it does not accept contributor claims, activate a metric or
complete the issue. Keep the existing
[delivery record](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/82#issuecomment-6250321197)
and [maintainer scope check](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/82#issuecomment-6381478497)
as the issue's decision history.

## Task-to-evidence map

| Task | Source and observed behavior | Acceptance still needed |
| --- | --- | --- |
| T1: reproducible defect, regression test and accepted fix | [#278](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/278) introduced the comparison-index correction; [#280](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/280) delivered it to main as `67b664953b55844c99d2aba81b907accdd7f7062`. The identical regression fixture fails two read budgets before the correction and passes all four cases after it, while both semantic controls pass on each revision. See the comparison below. [#306](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/pull/306) separately delivered reproduction recognition; an accepted negative/inconclusive scenario does not confirm a bug. | Independent acceptance of the scenario, attribution and source evidence for any actual recognition request; #68's separate bug-confirmation requirements remain. |
| T2: accessibility testing/design fixes with reviewer evidence | [#370](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/370), merged as `2af24b39d9f87a8a077cca252d229ac0f3553869`, fixes long SVG fields overflowing their canvas and losing complete accessible identities. [Source review](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/370#pullrequestreview-5567399085) and [receiving review](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/370#pullrequestreview-5567893989) retain their exact source scopes. Current card route tests and nine Chromium scenarios pass. | Reviewer acceptance of the specific artifact/version, phase, criteria and method. Current browser tests establish DOM/geometry/accessible-name behavior with synthetic inputs; physical assistive technology, representative participants and general accessibility certification remain unproven. |
| T3: versioned benchmark conditions and actual results | The exact before/after comparison below independently reproduces the operation counts reported in #278/#280, on unchanged locked dependencies and the same fixture blob. These are measured lookup operations in actual code on a synthetic workload. | The evidence reviewer must decide whether this bounded operation-count comparison satisfies the stated benchmark criterion. The measured code behavior is real; the generated contribution data is synthetic and cannot be enrolled as source facts. No production latency, end-to-end capacity or deployment result follows. |
| T4: test artifacts without assertion count as value | [#278's regression artifact](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/blob/0ef920058edc2f63ffac388d9e7f3db73b489129/packages/metrics/test/policy-comparison-scale.test.mjs) checks complete output before applying deterministic budgets. The [tests definition](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/blob/a1f8f07ac31d0851c1752cf3b1dd5696c4ba9fb9/packages/metrics/src/v1/registry.json#L2912-L2933) counts PR/testing-category participation. The [qualifier](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/blob/a1f8f07ac31d0851c1752cf3b1dd5696c4ba9fb9/apps/pipeline/src/domain-recognition.mjs#L650-L655) requires authored `test_artifact` and substantive review. | Acceptance of the actual artifact and attribution. Neither the test totals below nor assertion/file/coverage counts establish contribution quality or regression-prevention credit. No public test board is activated by this packet. |

## Comparable lookup experiment

The subject is the real `comparePolicies` implementation. All contribution data
in the experiment is explicitly synthetic. Fixture actor IDs, acceptance receipts
and complete-coverage declarations are test inputs, not observed source facts.

| Condition | Exact value |
| --- | --- |
| Before source | `73f0e5d31fdab8691220f6681a78eaba60ff3700` |
| After source | `0ef920058edc2f63ffac388d9e7f3db73b489129`, whose sole parent is the before source |
| Production change | [Complete engine diff](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/compare/73f0e5d31fdab8691220f6681a78eaba60ff3700...0ef920058edc2f63ffac388d9e7f3db73b489129): index generated actor rows and evidence membership; the other two changed paths are the regression fixture and documentation |
| Fixture | `packages/metrics/test/policy-comparison-scale.test.mjs`, Git blob `f1bb65d9be7dbcbb53fb3173c0185995d26bc3f0`; identical to the delivered #280 fixture and the current-main fixture |
| Installation | Separate detached worktrees; each uses its own unchanged committed lockfile and `npm ci`. The two sources have no lockfile or contracts-package differences. |
| Build | Build `@pick-your-ai/contracts`, then `@pick-your-ai/metrics` in each worktree |
| Runtime used | Node.js `v24.22.1`, npm `11.10.1`, macOS (`darwin`), `arm64` |
| Instrumentation | Existing synchronous fixture observes generated row `actorId` reads and evidence-array index reads, restores instrumentation in `finally`, and freezes inputs. It is not enabled in the production runtime. |
| Units | Actual property/index reads; no wall-clock measurement is used as an acceptance result |
| Invocation | `node --test packages/metrics/test/policy-comparison-scale.test.mjs` |

| Identical workload | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| 10,000 contributors, two facts each: actor identity reads | 100,060,000 | 50,000 | Replaced actor-row lookup work is reduced on this fixture. |
| Same workload: evidence index reads | 90,000 | 90,000 | This control does not change. |
| One contributor, 4,000 evidence records: actor identity reads | 6,004 | 6,002 | Recorded without claiming a broader effect. |
| Same workload: evidence index reads | 10,013,000 | 18,000 | Replaced evidence-membership lookup work is reduced on this fixture. |

The before run exits 1: exactly the two read-budget cases fail. Both remaining
semantic cases pass. The after run exits 0: all four cases pass, with zero skips
or cancellations. Complete result, rank, evidence order and audit assertions run
before the operation budgets. The additional controls cover zero versus unknown,
one-sided evidence, pending-only omission, rank-only movement, input permutations,
policy-version guards and inverse rollback.

The [original source review](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/278#pullrequestreview-5563138467)
and [delivered receiving review](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/280#pullrequestreview-5563411796)
are existing engineering records. Their account is `CompleteDotTech`; this packet
does not reinterpret a `COMMENTED` review as an approving vote or prove who
operated the account. This fresh reproduction is a separate execution on the
specified local environment, not a reacquisition of their historical CI logs.

### Reproduce without changing the baseline

Use two clean detached checkouts at the commits above. In the before checkout,
add only the exact after-revision fixture under the same test path and verify its
Git blob. Do not change the baseline engine, budgets or assertions.

From each checkout, using Node.js 24 and npm 11 or later:

```bash
npm ci
npm run build --workspace @pick-your-ai/contracts
npm run build --workspace @pick-your-ai/metrics
git hash-object packages/metrics/test/policy-comparison-scale.test.mjs
node --test packages/metrics/test/policy-comparison-scale.test.mjs
```

The hash must be `f1bb65d9be7dbcbb53fb3173c0185995d26bc3f0` in
both checkouts. Preserve the before run's nonzero exit as the expected causal
result. A changed fixture, missing instrumentation, semantic failure, or changed
source/dependency identity is a different experiment and needs its own record.

## Current accessibility and qualification checks

On `a1f8f07ac31d0851c1752cf3b1dd5696c4ba9fb9`, the following
actual commands completed on 2026-10-24 with Node.js `v24.22.1`:

```bash
node --test apps/pipeline/test/domain-recognition.test.mjs \
  packages/metrics/test/policy-comparison-scale.test.mjs \
  apps/service/test/cards.test.mjs
npm run test:browser -- cards.spec.ts
```

The Node run reports 250 passing tests and zero failures, skips or cancellations;
the total includes parent/subtest reporting and is not a count of independent
contributions. The browser command includes its TypeScript compilation and
reports nine passing Chromium scenarios with zero retries. Its current source
also includes subsequent XML-safety and measure-context cases, so nine is not
presented as the historical #370 case total.

The [browser assertions](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/blob/a1f8f07ac31d0851c1752cf3b1dd5696c4ba9fb9/apps/web/browser/cards.spec.ts)
inspect actual SVG `getBBox()` results against the canvas, retain full source,
scope and maximum Project identities in the accessible name/description, and
check admitted Unicode/XML boundaries. The HTML scenario runs the existing
automated axe check. These browser scenarios use the real service route with
synthetic fixture data and browser request interception. They do not read an
authorized live leaderboard or establish a physical screen-reader result.

For the review decision, the candidate accessibility phase is `delivered_fix`
for the #370 renderer change. The fresh verification method is automated
Chromium testing of the current source, with these explicit project criteria:

- Complete admitted source/repository/Project identity remains in the accessible
  name/description even when the visible representation is abbreviated.
- Each rendered text bounding box fits within its declared SVG canvas.
- Maximum Project selection stays within the existing 1,024-pixel height budget.
- Free-text abbreviation does not split an admitted surrogate pair.

These are project criteria directly asserted by the linked test, not a claim
of WCAG conformance. A reviewer can accept this bounded delivered fix while
leaving physical assistive-technology and participant evidence unaccepted.

The domain suite checks independent source/audit admission, refusal of
non-substantive test review, unlike performance conditions/units/metrics,
non-improvements, exact decimal comparisons, canonical conservation, current
withdrawal/suppression and private-field exclusion. Those are software checks;
no private receipt or fictional contributor is enrolled by executing them.

## Remaining decisions before issue completion

1. The existing owners must identify the accountable independent evidence
   reviewer and accept or reject the specific source/artifact scope above. Record
   the disposition in #82's existing history; do not replace assignees or reset
   triage from the original plan text.
2. For accessibility recognition, select the actual artifact/version and phase,
   identify the validated criteria and review method, and retain the reviewer
   evidence. Do not infer physical assistive-technology or participant acceptance
   from Chromium assertions.
3. Accept or reject the bounded lookup comparison as benchmark evidence for
   #278/#280, using its immutable before/after source, workload, environment,
   conditions, units, results and limitations. If the issue's intended benchmark
   scope requires timing, capacity or an actual deployment workload, supply and
   review that additional measurement instead of extrapolating these counters.
   The synthetic participant/coverage inputs are never real source evidence.
4. Preserve the comparison-qualification work already owned by
   [#500](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/500) and its
   receiving [#503](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/503).
   As checked on 2026-10-24, #503 remains draft and its head
   `0c5334f8467a5c6baffcd641d98c92c988050dd5` has successful checks.
   This is check metadata, not independent original-log qualification, merge or
   whole-issue acceptance. Confirm its actual delivery before relying on the new
   immutable comparison-revision boundary.
5. Reconcile #65/#68, applicable source permissions, attribution, policy/reviewer
   enrollment and affected-owner acceptance to the exact supported claim. Their
   open state does not prevent bounded local testing; it does prevent assuming
   their whole delivery gates have passed. Update #82's checklist only for
   accepted evidence and close it only after its full gate is satisfied.

The repository's ordinary different-account approval and maintainer merge rules
still apply to any PR containing this packet. No source permission, contributor
credit, metric definition, policy, public activation or native issue relationship
changes as a result of adding the document.
