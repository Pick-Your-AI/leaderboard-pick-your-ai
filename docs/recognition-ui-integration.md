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

The [accepted-evidence/v2 decision](accepted-achievement-milestones.md) defines the additional rule and display conditions. The component requires the literal `accepted-evidence/v1` or `accepted-evidence/v2` string; an array or another alias cannot become a valid version through coercion, including on an empty page. Achievement requests preserve the exact category and use their own 20-item cursor. A v1 service withholds the unsupported category request, and the browser also rejects any v1 response for a category-selected profile, even a successful empty response or one echoing that category. There is no unfiltered fallback. Cards continue to use their existing independent scope helper.

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
height includes every added line. Both formats derive their source summaries from
distinct validated public URLs in first-observed order. Several review rounds may
share one source page; the SVG's additional-source count describes the other
distinct URLs, while the contribution values and proof records retain their own
counts and identities. Existing text/output bounds, escaping, dated snapshot
labels, no-store responses, framing restrictions and current privacy checks remain
in force. This presentation does not supply missing denominator
evidence, authorize ranking a descriptive measure or establish a live service.

SVG image text uses the [XML 1.0 character range](https://www.w3.org/TR/xml/#charsets).
An admitted JSON label can contain a character that XML cannot encode. In the
image presentation, such code points become the visible replacement character
U+FFFD before grapheme abbreviation and row measurement. This also keeps the
title and accessible description well-formed XML. TAB, LF, CR, permitted BMP
characters and complete supplementary code points remain unchanged; the XML
parser's ordinary CR-to-LF normalization still applies. Publisher objects,
evidence identities, admission rules and the original HTML serialization are
unchanged. This is an image-format fallback, not a correction to contributor data.

## Grouped Activity explanations

Grouped Activity proof retains the accepted authored-notes purpose and reviewed
maintenance facets from the same validated public proof used by the shared
Receipt. Only the existing bounded public explanation helpers supply these
labels. The original contribution, artifact, actor, source revision, full-precision
clocks and accepted state remain intact; multiple maintenance facets describe one
contribution and add no counted units. Missing classifications remain unknown.
Arbitrary legacy provider reasons and private reviewer strings stay absent.
Current source and suppression checks run before grouped detail, including reads
of a pinned snapshot.

The [service-to-Activity regression](../apps/web/test/activity-proof-explanations.test.mjs)
uses the actual service projection, response decoders and Activity/Receipt renderers
with synthetic publication input. It covers authored purpose, all reviewed
maintenance facets, unknown legacy classifications and withdrawal after current
artifact suppression. It does not establish live publication or contributor and
assistive-technology acceptance.

## Validation and remaining browser integration

Client tests cover exact scope/pin binding, dropped pagination/search filters, mismatched actor/policy/snapshot rejection, unsafe URLs, bounded evidence, private-field omission and unapproved-policy failures without fallback. Web TypeScript validation passes.

Real-service browser journeys cover dated HTML card navigation back to the visible pinned portfolio, approved and unapproved achievement handling, source-link focus preservation across successful refresh, failure clearing, and current-only editorial scope with source-eligibility revocation. The recognition region also passes automated axe checks. Run these tests after integration using the isolated port configuration:

```bash
VITE_PUBLIC_CONTROLS_BASE=/controls npm run build --workspace @pick-your-ai/web
npx playwright test --config apps/web/playwright.recognition.config.ts
```

Further manual accessibility/acceptance checks remain for: dated card navigation; unapproved achievement policy; successful accepted evidence and qualifying artifact links; a second request failing or suppressing evidence after success; changing actor/scope while requests are pending; current-only editorial scope; keyboard traversal and accessibility checks. Automated synthetic journeys do not certify assistive technology usability or close external evidence/policy gates for #69/#70/#123/#124.

## Reader-controlled overview rotation

The configured organization overview shows one currently approved editorial spotlight at a time. Previous/Next controls wrap through the exact server response order: round-robin categories, oldest reviewed selection first within a category. The visible position describes navigation, not rank. Category, consented bio, original selection explanation, selection time and the reviewed public evidence link remain visible. No timer, new scoring, nomination taxonomy or publication schedule is introduced.

Same-item revalidation retains the reader's selection and focused proof link. If the selected approved item disappears, the view uses the current response's first item and moves focus from the replaced proof to the current heading. A single item has disabled controls. Empty, failed, hidden, unsupported-scope and unconfigured states retain the existing reader and default-deny availability behavior; no cached contributor content supplies a fallback. The UI never enables an unconfigured controls endpoint.

The [overview discovery checks](../apps/web/browser/overview-discovery.spec.ts) build the actual application with explicit same-origin controls configuration. Synthetic accepted/opted-in records pass through the existing controls projection; this exercises presentation and current suppression, not controls HTTP admission or real editorial review. The separate [render checks](../apps/web/test/overview-discovery-render.test.mjs) cover exact scope links, transparent proof, escaping and bounded DOM for the maximum admitted inventory. Real nomination governance, source admission, newcomer/behind-the-scenes taxonomy and contributor/assistive-technology acceptance remain tracked by [#69](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/69).
