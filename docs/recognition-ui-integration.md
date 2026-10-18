# Public recognition component integration

Standalone components live in `apps/web/src/remote/Recognition.tsx`. They are not mounted by this change because concurrent PR #153 owns the public app integration.

On a successfully validated contributor profile, mount `ContributorRecognition` with:

- `base`: the same validated public API base as the profile.
- `selected`: the exact approved scope selection.
- `snapshotId`: the loaded profile's snapshot ID (not a fresh unpinned query).
- `actorId`: the loaded contributor identity.
- `metricIds`: only metric IDs present in that profile's visible published results.

Remove the component whenever its parent profile becomes unavailable or is being revalidated. Key it by current profile snapshot, policy version and actor ID so outer policy changes discard local state immediately. Card links preserve organization, repository, workstream, dates and snapshot while dropping directory search, category and page cursors. The component requests achievements separately; a 503/unapproved policy is unavailable, never a synthetic award or permission to enable a policy.

On the current unfiltered organization overview, mount `EditorialSpotlights` only if a same-origin controls deployment is configured. Pass `controlsBase="/controls"`, the explicitly configured `organization` and `selected`. This API does not support historical or filtered scopes: the component rejects them before fetching. Do not describe its selections as part of a pinned metric snapshot. Source eligibility is still enforced by the controls backend and defaults to denial.

Both components abort replaced requests, clear their prior evidence at every refresh, clear errors rather than keeping stale successful data, and refresh every 30 seconds plus browser visibility changes. Responses are allowlisted and source URLs restricted to public GitHub locators. Text is rendered by React without HTML injection. Backend suppression checks remain authoritative when a card/source view is opened. Downloaded copies cannot be remotely withdrawn.

## Validation and remaining browser integration

Client tests cover exact scope/pin binding, dropped pagination/search filters, mismatched actor/policy/snapshot rejection, unsafe URLs, bounded evidence, private-field omission and unapproved-policy failures without fallback. Web TypeScript validation passes.

After mounting in the app, run browser journeys for: dated card navigation; unapproved achievement policy; successful accepted evidence and qualifying artifact links; a second request failing or suppressing evidence after success; changing actor/scope while requests are pending; current-only editorial scope; keyboard traversal and accessibility checks. Standalone components alone do not claim those integrated journeys passed or close #69/#70/#123/#124.
