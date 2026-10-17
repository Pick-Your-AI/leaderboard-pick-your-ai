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

The [browser workflow](../.github/workflows/browser-ci.yml) defines `Browser accessibility and resource checks` for every pull request (including forks) and push to main on Ubuntu 24.04, with a 20-minute job limit, read-only repository permission, no stored checkout credentials and no deployment secrets. It clean-installs locked dependencies, installs the matching Chromium and system dependencies, builds production workspaces, checks formatting and types, and runs the browser suite. Actions are pinned to full commit SHAs verified against their official repositories. Failures fail the job without retries or `continue-on-error`. The artifact step runs even after failure, has a two-minute limit, and retains reports, screenshots and failure traces for seven days. These artifacts contain synthetic data only. The first successful hosted run and fork execution still need evidence after publication; local workflow validation is not a hosted-browser pass. Repository rules must select this check after publication before merge enforcement can be claimed.

## Automated evidence

- All 31 canonical public-route examples and required-state examples run at 320, 360, 768, 1024 and 1280 CSS pixels in light and dark media settings. Checks require rendered headings, the synthetic notice, no uncaught page errors, no horizontal page overflow, and no axe violations for WCAG 2.0/2.1/2.2 A/AA plus best practices. Scoped unknown, empty, partial, unsupported, pending, stale, rebuilding, failed, suppressed, deleted and corrected examples are included. Protected routes are not implemented and cannot be certified here.
- Forced-colors and reduced-motion emulation repeat representative board, coverage and privacy checks at 320px. Font resource requests are blocked; the prototype currently uses system fonts. Wall screens are scanned at 1920×1080, 1080×1920 and 1024×768; pause/resume is exercised. Screenshots are observations for review, not approved visual baselines.
- The keyboard test opens proof with Enter, verifies focus on its heading, wraps focus at both narrow-screen dialog boundaries, closes with Escape and checks focus restoration. The live test advances the synthetic publication clock, holds updates independently under pointer and keyboard engagement and an open proof, and checks the final polite announcement after release.
- The service-backed browser cases use the built Fastify handler with synthetic inputs and intercepted browser API requests. They check scope and snapshot continuity, dense ties and cursor navigation, current suppression and revocation, failed-read behavior, keyboard focus during background rechecks, held new heads, and export withdrawal. They do not call a deployed API or external GitHub source.
- A fresh browser context records production resource sizes and durations, DOM size, DOMContentLoaded and Chromium heap observation when available. Candidate regression ceilings are 800,000 decoded resource bytes, 5,000 DOM nodes and 15 seconds to DOMContentLoaded on the local fixture. They are coarse regression guardrails pending owner review, not production latency or bandwidth commitments.

Inspect the HTML report in `playwright-report/` and synthetic attachments in `test-results/browser/`. Resource measurements are attached as `performance-observations.json`; screenshot artifacts capture actual rendered media/width states. Failure traces support reproducing a failing journey.

The suite exposed three prototype defects: closing proof could release a held update before React recorded restored keyboard focus; absolute accessible labels in a wide table could cause 768px page overflow; and navigation to an asynchronously loaded profile or receipt could leave focus on the document body. The follow effect now also checks actual focus in the table, the scroll region contains its positioned labels, and route focus waits for a rendered heading. These behaviors remain covered by the browser checks.

## Acceptance still needed

For #34, repository rules must require the actual planning/runtime/browser checks before merge, prevent bypass according to the accepted governance policy, and demonstrate that a representative failing change blocks merging. CI YAML alone cannot establish branch-rule enforcement. `npm run typecheck` invokes the tracked-source formatting check through `pretypecheck`; the runtime and browser workflows both run it. Dependency automation exists, but update-review ownership still needs acceptance. Repository administrators must verify these settings and permissions; this change does not alter them.

For #128, two representative screen-reader walkthroughs, real-device touch testing, 400% browser zoom, target-size/manual contrast and visual-baseline review, protected-route checks once implemented, and participant review remain required. Emulated media and axe cannot prove screen-reader usability or WCAG conformance.

For #129, owners must accept scale and budgets before pass/fail claims. Real API latency, ingest bursts, concurrent live clients, database/index/query cost, cold deployed starts, constrained mobile networking, sustained browser memory, source lag and safe overload behavior require the implemented production systems and documented test scale. One synthetic cold read does not prove any of those properties.
