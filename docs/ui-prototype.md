# UI prototype candidate

This branch adds a working design prototype for the information architecture and visual system epic, [LB 13](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/14). It builds on the runtime scaffold in [runtime-foundation.md](runtime-foundation.md). It runs only on synthetic data. It is not a production leaderboard, not an accepted design specification and not evidence about any real contributor. [docs/UI.md](UI.md) remains the generated design baseline. This document records what the prototype implements against that baseline and what is still open.

Run it with `npm run dev:web` and open `/prototype`. That page links every journey and every required state.

## Issue coverage

| Issue | What this branch provides | Still open |
| --- | --- | --- |
| [LB 13.01](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/47) consultation | A decision record mapping consultation advice to adopted, adapted and deferred choices (below), with hashes of the retained local artifacts. | The prompt, raw response and receipt stay outside the repository, because AGENTS.md excludes assistant session receipts. Affected-owner acceptance. Reconciliation with source capability findings from LB 04.01 (#41). |
| [LB 13.02](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/52) navigation | Canonical routes, a registry-driven metric catalog with search, and URL-only scope with stable serialization, snapshot pinning, back/forward restore and visible invalid-parameter messages (`apps/web/src/lib/scope.ts`, tested). | Department names and lead metrics are unresolved registry fields (`ui_metadata`), so the UI groups by registry family and labels examples as prototype choices. Depends on LB 03.05 (#38). |
| [LB 13.03](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/56) tokens and components | Versioned local tokens with source SHA, light/dark/system/high-contrast/forced-colors support and a test asserting WCAG AA contrast for every text pair. Components: rank cells, value cells, state and health labels with words, scope bar, freshness indicator, update control, method disclosure, coverage note, evidence drawer and page, empty, loading and error states, and the synthetic data banner. | ASCII decoration slot (website #32/#33) intentionally absent. Serif title font deferred. Manual 200%/400% zoom review. |
| [LB 13.04](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/61) prototype | Journeys covered: overview → board → evidence drawer → portfolio → contribution; newcomer discovery; triage proof with a corrected exclusion; LOC context; held live updates; the live wall with pause. Every board count opens the fixture rows behind it, and each row carries a fixture explanation. | A recorded keyboard and touch walkthrough on real devices. |
| [LB 13.05](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/71) usability review | Nothing. It needs sessions with real participants and cannot be simulated. | All of it. |

LB 14–16 screens (#100, #107, #111, #112, #116–#118, #120, #121, #123–#127) exist here only as prototypes over the fixture. Their acceptance requires the read API (LB 12.01/12.02, #99/#105), live transport (#106), health API (#92), consent and identity work (#53, #94, #119) and real data, so none of them is complete.

## Routes and scope contract

Routes follow docs/UI.md: `/`, `/leaderboards`, `/leaderboards/:metric`, `/contributors`, `/contributors/:login`, `/contributions/:id`, `/activity`, `/projects/:id`, `/methodology`, `/methodology/:metric`, `/methodology/changes`, `/coverage`, `/corrections` and `/live`. `/account/*` and `/admin/*` are later authenticated work and are not routed.

Scope parameters are `period` (`7d`, `30d` default, `90d`, `all`, `month`, `quarter`, `year`), `from`/`to` (half-open UTC dates; both required, and they imply a custom period), `repo` and `project` (comma-separated stable IDs), `actor` (`user` default, `automation`, `all`), `snapshot` (an immutable pin; absent means latest) and `density`. Defaults are omitted, so equal scopes serialize to equal URLs. Route parameters (`q`, `family`, `sort`, `rows`, `proof`) follow the scope in key order. An unknown value is reported in a visible alert, and the documented default is used in its place. Windows resolve against the snapshot cutoff, not the viewer's clock.

## Data honesty in the prototype

- Ranked values use only the metric's ranked evidence states. Pending work is a separate column, and contributors with only pending work are listed beneath the table without a rank.
- Ranks are dense (1, =2, =2, 3). A page cut never splits a tie.
- Zero appears only when every source in scope has complete coverage for the whole window. Otherwise the board says why it is empty. Measures without fixture data say "not measured".
- Suppressed people are absent from boards, the directory, profiles, contribution pages and the wall. Their profile URL looks the same as an unknown one.
- User accounts and automation are separate actor scopes.
- New snapshots are held until the reader applies them. Follow mode applies them only while the pointer and focus are outside the table and the drawer is closed. One polite announcement is made per applied batch.
- The correction section shows what a future form would prefill. It does not claim to send anything.

## LB 13.01 consultation decision record

The consultation ran on 2026-10-17 with requested and observed model `claude-opus-5-5`, no tools and no MCP servers ([ui-concept.json](../planning/ui/ui-concept.json) `consultation`). The retained local artifacts and their SHA-256 hashes are:

- prompt `opus-ui-prompt.txt`: `de69fcd2b080b9db09dcc3de9a2243026f480370012fdc90c72d50cd9f0b32b1`
- response `opus-ui-consultation.txt`: `932a4148b31698c4d470e0ba47fe6f8326cac3c47841343283a01b0adbdaad37`
- raw output `opus-ui-raw.json`: `9cec4648076ae11d8158263bfa5197aec2c644799b6a8486457faf8aac409c5c`

**Adopted:** editorial ledger direction with hairline rules; equal-weight families; evidence-first rows with a drawer and a full-page equivalent; held updates with an explicit apply control; wall modes, controls, 30-second default and 20-second minimum, avatars off, and an unranked credits roll; persistent synthetic banner; teal/slate/amber with words on every state.

**Adapted (master plan prevails):** dense instead of competition ranks; a last-30-days default instead of the calendar quarter; canonical route names; "user accounts / automation" instead of "humans / bots"; review amendments A01–A15 (for example, no "accepted" label for persistence, directory inclusion for observed work, and bounded pagination).

**Deferred:** Instrument Serif page titles (licence, subset and layout-shift checks); ASCII decoration (website #32/#33 remain unmerged); department names and lead metrics (registry decision); export, share cards and embeds (LB 12.04, LB 15.04); signed-in preferences and the admin console.

## Verification

`npm run build`, `npm run typecheck` and `npm test` cover the web tests in `apps/web/test/`. They check scope round-trips and invalid input, dense ranking and tie cuts, fixture conformance to the v1 contract schemas, pending/ranked separation, suppression, automation separation, LOC exclusions, corrections, true-zero rules, snapshot rebuilding and failure, and token contrast. A browser pass on the dev server confirmed every required-state URL on `/prototype`, the drawer's Escape and focus behaviour, held updates and their announcement, and no horizontal scroll at 320px on all routes.

These checks are not done: screen-reader testing, real-device touch walkthroughs, 400% zoom review, axe or another automated accessibility scan, and participant usability sessions. The production bundle is about 526 kB because it includes zod and the full metric registry. Splitting it belongs with the performance work in LB 19.04.
