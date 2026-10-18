# Public recognition component integration

Standalone components live in `apps/web/src/remote/Recognition.tsx`. They are mounted on validated contributor profiles and the current organization overview in the public app.

On a successfully validated contributor profile, mount `ContributorRecognition` with:

- `base`: the same validated public API base as the profile.
- `selected`: the exact approved scope selection.
- `snapshotId`: the loaded profile's snapshot ID (not a fresh unpinned query).
- `actorId`: the loaded contributor identity.
- `metricIds`: only metric IDs present in that profile's visible published results.

Remove the component when its parent profile becomes unavailable, hidden or replaced. Preserve ready same-selection DOM while the parent revalidates, and clear the evidence if that read fails. Key it by current profile snapshot, policy version and actor ID so outer policy changes discard local state immediately. Card links preserve organization, repository, workstream, dates and snapshot while dropping directory search, category and page cursors. The component requests achievements separately; a 503/unapproved policy is unavailable, never a synthetic award or permission to enable a policy.

On the current unfiltered organization overview, mount `EditorialSpotlights` only if a same-origin controls deployment is configured. Pass `controlsBase="/controls"`, the explicitly configured `organization` and `selected`. This API does not support historical or filtered scopes: the component rejects them before fetching. Do not describe its selections as part of a pinned metric snapshot. Source eligibility is still enforced by the controls backend and defaults to denial.

Both components abort replaced requests, preserve existing same-selection DOM while revalidating so focused source links remain focused, clear evidence on hidden state, changed selection or error, and refresh every 30 seconds plus browser visibility changes. Responses are allowlisted and source URLs restricted to public GitHub locators. Text is rendered by React without HTML injection. Backend suppression checks remain authoritative when a card/source view is opened. Downloaded copies cannot be remotely withdrawn.

A nonempty achievement response must include complete coverage for every declared source partition through the selected period end or exact snapshot cutoff. All-history awards additionally require coverage from each partition's known history start. The browser compares contract-valid source instants with their full fractional precision and rejects unverifiable supplied awards as `invalid_recognition_response`; this clears any previously displayed award and shows the existing unavailable state. Empty award lists remain valid with incomplete history. This enforces the existing candidate service rule and does not approve or activate it.

## Category milestones and shared-artifact proof

The [accepted-evidence/v2 decision](accepted-achievement-milestones.md) defines the additional rule and display conditions. The component accepts v1 or v2 explicitly. Achievement requests preserve the exact category and use their own 20-item cursor. A v1 service withholds the unsupported category request; there is no unfiltered fallback. Cards continue to use their existing independent scope helper.

Artifact identity remains an opaque source value in both versions. The readers preserve its exact already-public-projected spelling, including padding and punctuation, without interpreting it as a route segment or normalizing it. The artifact-only 2,000,000-code-unit guard follows the existing browser's whole-response 2,000,000-byte ceiling; it does not assert a source-specific ID length. Version 2 still enforces its stricter 1,500,000-byte complete-response ceiling. Actor/contribution navigation IDs and public source URLs retain their separate restrictions. Both clients reject an award whose exact source occurrence follows its snapshot's generated cutoff, including sub-millisecond differences; equal instants and equivalent offset spellings remain valid.

Current artifact suppression uses the same exact opaque identity domain, retaining the 20,000-entry control limit and the separate actor/snapshot restrictions. A valid opaque artifact retirement removes its public proof and awards, recomputes remaining shared-artifact pairs and invalidates a prior page cursor. It no longer makes the entire read unavailable merely because the ID contains padding or exceeds a navigation-ID bound. This repairs an availability failure that previously failed closed; it does not expand source or control authority. Noncanonical surrounding-whitespace control IDs still fail closed instead of silently being rewritten to a different suppression identity.

Version 2 adds source-linked category milestone headings and a separate “Accepted work on shared artifacts” region. Every pair displays its verified source roles, the selected contributor's original proof, the peer's original proof, a current pinned peer profile and the shared artifact. The visible count means links in this projected evidence, not a complete social graph or count of delivered work. Partial historical coverage can expose recorded qualifying pairs while withholding first-event awards. Category means a registered measure; neither workstream help nor newcomer status is inferred.

Previous, next and restart controls are independent of portfolio timeline paging. A page gesture moves keyboard focus to the resulting heading or error message. Successful same-page refresh preserves focused proof links; scope/actor changes reset pagination and discard obsolete responses. A changed current projection invalidates an old cursor even when its controls version was not updated, clears the old pairs and offers restart. The closed v2 schema and exact scope/actor/category/source-time checks run before any of this evidence is rendered.

## Card measurement context

Both actual card routes include the snapshot-compatible registry's exact unit,
aggregation and definition event clock. These fields describe the definition;
they do not establish a new source observation or convert the numeric value. A
recorded proportion remains a proportion, and elapsed hours do not become seconds.

The cards show supplied numerator, denominator, sample count, censored count,
missing-readiness count and p75 from the exact actor/metric diagnostic. Missing
diagnostics and null values remain explicitly unknown; they are not reconstructed
from the result or the number of source links. Supplied zeros remain zero. Pending
count, coverage state and value class come from the already projected row, so
current suppression can make a pinned pending count unknown before rendering.

HTML uses semantic definition terms and descriptions. Passive SVG images include
the same context in visible text and their accessible description; the canvas
height includes every added line. Existing text/output bounds, escaping, dated
snapshot labels, no-store responses, framing restrictions and current privacy
checks remain in force. This presentation does not supply missing denominator
evidence, authorize ranking a descriptive measure or establish a live service.

## Validation and remaining browser integration

Client tests cover exact scope/pin binding, dropped pagination/search filters, mismatched actor/policy/snapshot rejection, unsafe URLs, bounded evidence, private-field omission and unapproved-policy failures without fallback. Web TypeScript validation passes.

Real-service browser journeys cover dated HTML card navigation back to the visible pinned portfolio, approved and unapproved achievement handling, source-link focus preservation across successful refresh, failure clearing, and current-only editorial scope with source-eligibility revocation. The recognition region also passes automated axe checks. Run these tests after integration using the isolated port configuration:

```bash
VITE_PUBLIC_CONTROLS_BASE=/controls npm run build --workspace @pick-your-ai/web
npx playwright test --config apps/web/playwright.recognition.config.ts
```

Further manual accessibility/acceptance checks remain for: dated card navigation; unapproved achievement policy; successful accepted evidence and qualifying artifact links; a second request failing or suppressing evidence after success; changing actor/scope while requests are pending; current-only editorial scope; keyboard traversal and accessibility checks. Automated synthetic journeys do not certify assistive technology usability or close external evidence/policy gates for #69/#70/#123/#124.
