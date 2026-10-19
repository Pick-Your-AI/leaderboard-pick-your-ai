# Executable prototype validation

The browser suite supplies independently repeatable synthetic evidence for [CI #34](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/34), [accessibility #128](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/128), and [performance #129](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/129). It does not complete those issues' production, assistive-technology or owner acceptance gates.

## Run locally or on a fork

Use the repository's Node 24/npm 12 toolchain:

```sh
npm ci
npx --no-install playwright install chromium
npm run build
npm run typecheck
npm run test:browser
```

On Linux, install browser system dependencies with `npx --no-install playwright install --with-deps chromium`. The pinned Playwright package in the lockfile selects its corresponding Chromium revision; `--no-install` prevents fetching an unrelated CLI version. The test runner starts a production Vite preview at loopback port 4187 and refuses to reuse another server. No separately running service, database, GitHub token, private data, external account, or public deployment is required. Tests use only the explicitly invented prototype fixture and synthetic inputs passed through the real in-process service handler.

The [browser workflow](../.github/workflows/browser-ci.yml) runs for every pull request (including forks) and push to main on Ubuntu 24.04. It distributes the unchanged suite across two mandatory Playwright shards, each with the existing two workers, 600-second suite deadline and 20-minute job limit. Each shard clean-installs locked dependencies, installs the matching Chromium and system dependencies, builds production workspaces, checks formatting and types, and runs its assigned tests. The increasing suite previously reached its overall deadline before every test could run; sharding adds parallel capacity while preserving every case, assertion and per-test limit. The existing `fullyParallel` configuration permits individual tests from the route matrix to be distributed between shards.

The final `Browser accessibility and resource checks` job preserves the existing status-check name. It runs after both shards even when one fails or is skipped, and succeeds only when the combined shard result is `success`. Neither shard can continue after an error as a successful job, and a failure does not cancel the other shard's evidence collection. Retries remain disabled. Actions retain their pinned full commit SHAs, read-only repository permission, no stored checkout credentials and no deployment secrets.

Each shard's artifact step runs even after failure, has a two-minute limit, and retains its HTML report, screenshots and failure traces for seven days under `synthetic-browser-evidence-shard-1-of-2` or `synthetic-browser-evidence-shard-2-of-2`. Inspect both reports when qualifying a complete run; one successful shard does not establish whole-suite success. These artifacts contain synthetic data only. Local workflow validation is not a hosted-browser pass, and a workflow change alone does not demonstrate repository-rule enforcement.

To reproduce one shard locally after the same build and type checks, run `npm run test:browser -- --shard=1/2` or `npm run test:browser -- --shard=2/2`. Running without `--shard` still selects the complete suite and retains the same deadline. Run local shards separately because their preview server uses the same loopback port; keep each report before starting the next run. The shard selection follows [Playwright's documented distribution](https://playwright.dev/docs/test-sharding), and the final check uses GitHub's [required dependent-job guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), both checked 2026-10-19.

## Automated evidence

- All 31 canonical public-route examples and required-state examples run at 320, 360, 768, 1024 and 1280 CSS pixels in light and dark media settings. Checks require rendered headings, the synthetic notice, no uncaught page errors, no horizontal page overflow, and no axe violations for WCAG 2.0/2.1/2.2 A/AA plus best practices. Scoped unknown, empty, partial, unsupported, pending, stale, rebuilding, failed, suppressed, deleted and corrected examples are included. Protected routes are not implemented and cannot be certified here.
- Forced-colors and reduced-motion emulation repeat representative board, coverage and privacy checks at 320px. Font resource requests are blocked; the prototype currently uses system fonts. Wall screens are scanned at 1920×1080, 1080×1920 and 1024×768; pause/resume is exercised. Screenshots are observations for review, not approved visual baselines.
- A focused 320px regression checks that the longest selected snapshot remains inside the scope-control region in light, dark and forced-colors modes, with its 44px target height preserved. The select's flex label can shrink to the available content width; page overflow is not hidden. Reflow failures report element bounds to help locate the cause.
- The live-wall configuration also checks every fieldset, label and native control against its grid bounds at 320px in light, dark and forced-colors modes. Its single grid track has a zero minimum so a native select's intrinsic option width cannot expand the form beyond the page.
- Two native browser-zoom journeys exercise 200% and 400% zoom in light, dark and forced-colors modes. They use the browser's real zoom setting, preserve scoped form submission and proof navigation with fonts blocked, and retain device-pixel screenshots plus zoom readback. See the bounded evidence and review requirements below.
- The keyboard test opens proof with Enter, verifies focus on its heading, wraps focus at both narrow-screen dialog boundaries, closes with Escape and checks focus restoration. The live test advances the synthetic publication clock, holds updates independently under pointer and keyboard engagement and an open proof, and checks the final polite announcement after release.
- The service-backed browser cases use the built Fastify handler with synthetic inputs and intercepted browser API requests. They check scope and snapshot continuity, dense ties and cursor navigation, current suppression and revocation, failed-read behavior, keyboard focus during background rechecks, held new heads, and export withdrawal. They do not call a deployed API or external GitHub source.
- A fresh browser context records production resource sizes and durations, DOM size, DOMContentLoaded and Chromium heap observation when available. Candidate regression ceilings are 800,000 decoded resource bytes, 5,000 DOM nodes and 15 seconds to DOMContentLoaded on the local fixture. They are coarse regression guardrails pending owner review, not production latency or bandwidth commitments.
- Application-loading cases let the document entry and static module preloads run, then hold subsequent application downloads for both the public board and live wall. The static unknown-state page must remain visible with no API reads until the selected application is ready. A failed download must preserve that fallback, and reloading the same URL after recovery must restore the requested repository and snapshot through the real synthetic service handler. Prototype, API board, API wall and protected controls retain their existing mode and route selection; an inactive API application is no longer an eager dependency of the prototype.

Inspect the HTML report in `playwright-report/` and synthetic attachments in `test-results/browser/`. Resource measurements are attached as `performance-observations.json`; screenshot artifacts capture actual rendered media/width states. Failure traces support reproducing a failing journey.

Route-matrix overflow and axe assertions collect failures across all routes instead of stopping at the first failure. Any recorded failure still fails the test and CI job. The [second hosted run](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/actions/runs/39080484120) passed 20 of 22 cases, including the snapshot-control reflow, forced-colors and service-export cases; it exposed the separate live-wall grid overflow at 320px. Subsequent corrections require a fresh hosted result.

The suite exposed three prototype defects: closing proof could release a held update before React recorded restored keyboard focus; absolute accessible labels in a wide table could cause 768px page overflow; and navigation to an asynchronously loaded profile or receipt could leave focus on the document body. The follow effect now also checks actual focus in the table, the scroll region contains its positioned labels, and route focus waits for a rendered heading. These behaviors remain covered by the browser checks.

## Acceptance still needed

For #34, repository rules must require the actual planning/runtime/browser checks before merge, prevent bypass according to the accepted governance policy, and demonstrate that a representative failing change blocks merging. CI YAML alone cannot establish branch-rule enforcement. `npm run typecheck` invokes the tracked-source formatting check through `pretypecheck`; the runtime and browser workflows both run it. Dependency automation exists, but update-review ownership still needs acceptance. Repository administrators must verify these settings and permissions; this change does not alter them.

For #128, two representative screen-reader walkthroughs, real-device touch testing, target-size/manual contrast and visual-baseline review, protected-route checks once implemented, and participant review remain required. The native 200%/400% browser-zoom journeys below provide repeatable synthetic reflow evidence; their receiving visual review and the broader journey coverage must be assessed separately. Emulated media and axe cannot prove screen-reader usability or WCAG conformance.

For #129, owners must accept scale and budgets before pass/fail claims. Real API latency, ingest bursts, concurrent live clients, database/index/query cost, cold deployed starts, constrained mobile networking, sustained browser memory, source lag and safe overload behavior require the implemented production systems and documented test scale. One synthetic cold read does not prove any of those properties.

## Public activity feed regression coverage (#121)

The API-backed activity cases use the real service projection with synthetic
observed-only, pending and accepted records. They assert that `/activity` no
longer requests ranked boards, a 205-artifact burst has five previews plus bounded
proof pages (100/100/5), delayed collection differs from action time, category and
snapshot survive source drill-down and Back, and current suppression withdraws
previously focused work. A narrow-screen case verifies held publications, focus
and reading position during rechecks, no horizontal overflow and axe checks.
Browser assertions require the matching installed Chromium and a successful run;
TypeScript checks or collected tests are not execution evidence.

Service/client tests additionally exercise 205 equal-time groups, 1,000-artifact
and same-artifact bursts, 2,000 complete proof representations, canonical-fact
deduplication, explicit unknown clocks and acceptance, malformed/conflicting
facts, exact filters, current controls on pinned pages, cursor tampering/replay/
expiry and byte-limited continuation. These prove bounded synthetic behavior,
not source completeness, production load or a correction-event history.

## Native browser zoom journeys (#56)

[The zoom cases](../apps/web/browser/zoom.spec.ts) run in the ordinary browser suite. For a focused replay after building the workspace:

```sh
npm exec -- playwright test --config apps/web/playwright.config.ts --grep "native browser zoom"
```

Each case launches the pinned full Chromium browser in a fresh temporary persistent profile, with a 1280×960 outer window and no emulated viewport. The test-only extension is limited to loopback pages. It has no content script or product entry point. The harness uses the browser's [automatic zoom setting and readback](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom), following the supported [persistent-context extension setup](https://playwright.dev/docs/chrome-extensions). The regular Chromium channel supports this in headless CI; installing only the headless shell is insufficient and fails the test rather than falling back to CSS scaling.

The browser must report 2× or 4× automatic zoom. The layout viewport must become 640 or 320 CSS pixels wide, with the corresponding device-pixel ratio. The visual viewport scale and root/body CSS zoom remain 1. These independent observations distinguish browser reflow from changing an emulated viewport, CSS enlargement or pinch scaling. The local Chrome for Testing 155.0.8059.84 replay observed 640×436 CSS pixels at 200% and 320×218 at 400%; the retained receipt records the actual browser version and dimensions for every execution. The repository pin and CI installation remain unchanged.

For each zoom setting, light, dark and forced-colors journeys exercise the built application with synthetic inputs through the real public service handlers. The exact-scope form submits repository, workstream, paired UTC dates and snapshot selection through the keyboard. Board proof opens as the appropriate narrow-screen dialog; its heading, close button, source link and permanent-route control remain reachable. Tab wrapping, Escape, Back and returning focus are asserted. The permanent route retains its permitted proof. The prototype's longest snapshot selection and proof drawer also remain operable. Page overflow and native-control bounds are checked without hiding overflow. All font requests are blocked; the current system-font UI requests no web font and optional artwork remains absent.

The cases retain 24 visible-viewport PNG observations and two `native-zoom-observations.json` receipts. Images use a [DevTools visible-surface capture](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot) without a CSS clip, and their PNG dimensions must match the actual device-pixel viewport. This avoids the blank clipped images produced by the ordinary screenshot helper during initial native-zoom validation. Those initial crops are not visual evidence. Captures deliberately show the keyboard reader's current viewport, so content above or below it remains accessible by ordinary scrolling rather than being squeezed into one image.

The local implementation replay passed both cases with Chrome for Testing 155.0.8059.84. The initial headless-shell capability probe could not load the extension and executed no product assertions. Successful local runs demonstrate only the exercised synthetic browser behavior. The later [dated receiving decision](visual-system-acceptance.md) records the actual Chrome 156 hosted run, exact delivered tree, independent source/visual review and current system-font/empty-artwork choices for #56. It preserves the native #52 relationship and distinguishes usable inputs from that issue's wider acceptance. These receipts are not a physical-device trial, screen-reader session, approved production visual baseline or full WCAG certification; the separate #61/#71/#128 gates remain.

## Theme and contrast combinations (#56)

[The contrast cases](../apps/web/browser/theme-contrast.spec.ts) exercise all six combinations of the system/light/dark UI preference and light/dark operating-system media, then request increased contrast in the actual browser. They read the effective theme and media settings, compare all 12 text tokens against the three surfaces before and after that request, require at least 4.5:1 without reducing the ordinary contrast, and run axe's color-contrast rule against the rendered public API board. Each case retains its browser version, observed settings, token values, ratios and a screenshot. Inputs use the existing synthetic evidence service; there is no deployed-service or physical-display claim.

This matrix reproduced an existing system-dark defect: the increased-contrast selector treated every preference other than explicit dark as light. Muted text on the page background dropped from 7.87:1 to 1.38:1, links from 10.84:1 to 2.13:1, and muted text on the sunken surface became 1:1. The correction confines the existing light overrides to an effective light theme, including an explicit light selection on a dark operating system. System dark retains the same readable tokens as explicit dark. No token palette, font, remote stylesheet or native forced-color mapping changes.

The matrix measures CSS media behavior and rendered synthetic content. It complements the native-zoom journeys and existing static token checks; it does not replace the remaining receiving, assistive-technology, device or participant acceptance.
