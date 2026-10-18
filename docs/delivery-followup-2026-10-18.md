# Delivery follow-up — 18 October 2026

This supplements, and does not rewrite, the timestamped
[criterion acceptance audit](acceptance-audit-2026-10-18.md). That audit remains a
record of its earlier source and live-issue snapshot; its “unimplemented” findings
must be read alongside the subsequent implementation below.

[PR153](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/153) is merged
as `6ccc27374dbbe04440d0cc1f54c561a5812ff6c8`. The broader follow-up is associated with
[draft PR154](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/pull/154), which
was **open and unmerged** when this document was prepared. The implementation
inventory below describes local integration commit
`ae5e091` (including merged PR153), not a claim that all those changes have already
been pushed or merged through PR154. Final exact-head PR checks and independent
review evidence are authoritative; intermediate test runs and this inventory do
not establish issue acceptance or launch readiness.

## Changes against existing criteria

| Group and issue criteria | Implemented behavior at the integration commit | Source, tests and boundary documentation |
| --- | --- | --- |
| Reviews and Discussions — [#45](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/45), [#46](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/46), [#59](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/59), [#67](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/67): nested pagination, unavailable Discussions, separate answer author/selector, conserved review participation | Bounded PR/review inventory and public Discussion collection; source fingerprints and selected-current-state normalization prevent stale acceptance/dismissal states surviving newer observations. Disabled/unreadable sources remain unavailable. Native answer selection remains observed evidence, not an independent quality award. | [Collector](../apps/pipeline/src/github-source.mjs), [normalizer](../packages/github/src/normalizers.ts); [collector tests](../apps/pipeline/test/github-source.test.mjs), [mutable-source tests](../apps/pipeline/test/mutable-source.test.mjs), [normalizer tests](../packages/github/test/normalizers.test.mjs); [adapter coverage](GITHUB_SOURCE_ADAPTERS.md). |
| Project and relationship history — [#63](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/63), [#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79), [#87](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87): current state cannot invent historic editor credit; native transitions and public endpoints retain identity | Actor-backed repository issue events, explicitly approved current Project field identities/types, selected native issue Project-status and parent/blocker transitions. Unknown/automated status changes do not become human credit. Project scope is checked before detail hydration; current Project observations produce no contribution metric. | [Project reader](../packages/github/src/project-snapshots.ts), [timeline reader](../packages/github/src/timeline-history.ts); [Project tests](../packages/github/test/project-snapshots.test.mjs), [timeline tests](../packages/github/test/timeline-history.test.mjs); [coverage limits](GITHUB_SOURCE_ADAPTERS.md). |
| Evidence receipts and policy comparisons — [#60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60), [#115](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/115), [#122](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/122): independent acceptance, withdrawal propagation, reproducible comparisons and no unreviewed activation | Explicit protected recognition bindings map independently reviewed controls receipts to exact collected facts; ambiguous matches fail closed. Withdrawal/suppression changes invalidate historical publication guards. Immutable frozen inputs support persisted comparisons and reviewed, non-public release manifests with current privacy/source rechecks. This does not activate the proposed policy. | [Receipt adapter](../apps/pipeline/src/recognition-adapter.mjs), [runtime](../apps/pipeline/src/runtime.mjs); [adapter tests](../apps/pipeline/test/recognition-adapter.test.mjs), [runtime tests](../apps/pipeline/test/pipeline.test.mjs); [reviewed-input boundary](pipeline-reviewed-inputs.md). |
| Editorial recognition — [#69](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/69): verified evidence, selection explanation and no fabricated endorsement | Separate contributor opt-in for accepted evidence; versioned independent editorial decisions; distinct private reason/public explanation; current suppression/withdrawal and deny-by-default source-eligibility checks. Public selections are explicitly editorial and do not alter ranking. | [Editorial backend](../apps/controls/src/editorial.mjs), [nomination UI](../apps/web/src/controls/Spotlights.tsx); [editorial tests](../apps/controls/test/editorial.test.mjs), [controls tests](../apps/controls/test/controls.test.mjs), [recognition browser journeys](../apps/web/browser/recognition.spec.ts); [recognition boundary](recognition-runtime.md). |
| Achievements, cards and README images — [#70](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/70), [#123](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/123), [#124](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/124): reproducible evidence/date basis, incomplete-history withholding and current privacy on sharing | Explicitly activated accepted-evidence candidate rules; incomplete coverage withholds awards. Dated single-metric HTML cards and passive SVG images preserve scope/source/policy context and current suppression. Profiles expose recognition and copyable README Markdown; external framing remains denied. | [Achievements](../apps/service/src/achievements.ts), [cards](../apps/service/src/cards.ts), [public recognition UI](../apps/web/src/remote/Recognition.tsx); [service tests](../apps/service/test/read-api.test.mjs), [recognition client tests](../apps/web/test/recognition-client.test.mjs), [browser journeys](../apps/web/browser/recognition.spec.ts); [UI integration](recognition-ui-integration.md). |
| Protected account, review and configuration UI — [#53](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/53), [#55](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/55), [#93](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/93), [#94](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/94), [#101](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/101), [#119](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/119), [#122](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/122): verified ownership/roles, actual receipts and versioned source-tested configuration | Same-origin account/admin client, persisted profile readback, private requests, consent/review/appeal/withdrawal and editorial forms. Operator configuration proposals bind preview digests, independent approvals and activation receipts. Hidden/expired/superseded responses cannot restore private state. Metric-disable explanations are expressly public. | [Account/admin UI](../apps/web/src/controls/App.tsx), [configuration UI](../apps/web/src/controls/Configuration.tsx), [client](../apps/web/src/controls/client.ts); [client tests](../apps/web/test/controls-client.test.ts), [browser contracts](../apps/web/browser/controls.spec.ts); [protected UI limits](protected-controls-ui.md). |
| Public activity — [#121](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/121), [#120](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/120): source proof, distinct source/observation clocks and bounded progressive navigation | Merged PR153 supplies snapshot-bound public activity with paginated proof groups, scope-bound cursors and current privacy rechecks. This is publication-backed activity, not a claim of complete raw webhook history or immediate live delivery. | [Activity service](../apps/service/src/activity.ts), [activity UI](../apps/web/src/remote/Activity.tsx); [service tests](../apps/service/test/activity.test.mjs), [client tests](../apps/web/test/activity-client.test.mjs), [API-backed browser tests](../apps/web/browser/remote.spec.ts); [read API](read-api.md). |
| Worker and authentication retention — [#34](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/34), [#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95): executable bounded runtime and expired-state deletion with receipts | Explicit protected host worker runs sequential bounded batches, rechecks authority and drains before closing stores. SQLite authentication expiry removes only already-expired sessions/handshakes and commits minimized idempotent receipts; no arbitrary retention duration or scheduler is installed. | [Worker](../apps/worker/src/runner.ts), [worker tests](../apps/worker/test/runner.test.mjs), [authentication expiry](../infra/retention/controls-expiry.mjs), [expiry tests](../infra/retention/test/controls-expiry.test.mjs); [worker contract](worker-entrypoint.md), [retention scope](authentication-retention.md). |

## Engineering work still incomplete

- **Source retention (#95):** no coordinated source/derived-evidence purge exists.
  Immutable source rows, reversible source availability, independent SQLite public
  claims, checkpoint copies, frozen policy inputs/comparisons and restoration need
  a shared durable tombstone and verified deletion protocol. The
  [tested boundary investigation](source-retention-boundary.md) records concrete
  obstacles; authentication expiry and backup expiry do not satisfy this scope.
- **History and attribution (#63/#67/#79):** verified first-readiness cohorts,
  PR-specific Project timelines and broader typed historical events remain
  unsupported. Current Project collection retains approved field identities/types,
  not field values or complete historic workstream attribution. Unknowns remain
  unknown; a configured family is not proof of complete source history.
- **Domain recognition (#80/#88/#89/#81/#82/#90):** generic accepted-receipt wiring
  does not implement every research, catalog/pricing, market-source, documentation,
  localization, test/performance, design or security-specific evidence adapter.
  Required source/revision/comparable-measurement semantics still need their own
  implementation and meaningful inclusion/exclusion tests.
- **Recognition and operator breadth (#69/#70/#93/#94/#115/#122/#124):** richer
  spotlight taxonomy/selection governance, cross-workstream achievement conditions,
  shared-credit presentation, specialist identity/correction application, and
  full operational recovery remain incomplete. The mounted protected UI now supports
  version-bound evidence amendments with renewed review/consent, and an opt-in
  [operations panel](operator-operations.md) exposes minimized repository-scoped
  diagnostics and transactionally audited single-delivery inbox replay. Real
  controls HTTP/database browser tests cover queued receipts and revoked access;
  historical runs/receipts identify their own source generation. Approved host
  adapter wiring, real recovery drills, time-window/bulk replay and downstream
  publication reconciliation remain outstanding; outbox replay is not exposed.
  Policy comparisons persist reviewed manifests; a complete protected
  recalculation/activation UI and deployed reversible policy rollout are not
  established.
- **Sharing and long-running displays (#123/#127):** general external iframe
  embedding is not enabled. Third-party copied images/caches cannot be remotely
  withdrawn. Documented deployed soak and real display/accessibility acceptance
  remain outstanding.

## External acceptance remains separate

Actual installed read-only source capabilities, real historical reconciliation and
contributor review, approved recognition/achievement/grouping policies and authorized
reviewer/operator rosters remain required. OAuth registration and private storage,
cache/backup/retention architecture, accepted operating commitments, hosting/cost
approval, DNS/TLS, real-device/screen-reader journeys and staged recovery/public
readback are not supplied by these engineering changes. The configured target domain remains
`leaderboard.pickyour.ai`; that choice does not approve hosting or launch.

Use the final PR's exact-head build/typecheck/test/browser and independent-review
receipts when assessing a merge. Use each issue's full criteria and external
acceptance evidence when assessing closure. Neither this follow-up nor a merged
PR asserts that all remaining issues are resolved.
