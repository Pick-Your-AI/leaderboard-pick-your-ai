# Separate pending metric counts

Refs #83. This implementation is synthetic-test evidence for one acceptance scenario; it does not approve policies, certify source completeness, complete the issue gate or authorize publication/deployment.

## Contract

`pendingCountSchema` defines the optional `leaderboard-pending/v1` extension on public board rows and diagnostics:

- `valueClass` is the configured ranked evidence class (`observed`, `qualified` or `reviewed`). The UI labels a qualified value as accepted without mislabeling observed activity.
- `count` counts distinct pending policy units, not lines, accepted outcomes or a weighted score. It never changes the primary result, numerator, denominator or ranking.
- `evidenceIds` identifies exactly the engine-selected pending units after canonical duplicate handling, policy grouping, corrected revision selection, source scope and actor checks. The finite nonnegative integer count must equal the distinct bounded ID list (at most 10,000).
- `state` is `measured`, `partial` or `unknown`. Unknown has null count and no IDs. Partial positive values are known observations with incomplete coverage; an empty incomplete observation set stays unknown. A measured zero requires complete source coverage throughout a bounded scope. Legacy snapshots lacking this extension remain unknown.

The engine returns pending selection provenance separately and adds `pending_not_ranked` audit entries. Pipeline publication persists a separate `pendingEvidence` collection. The public projector applies the same allowlisted URLs, current actor/artifact controls, repository/window restrictions and enabled policy checks used by other evidence. A count with any missing or suppressed dependency becomes unknown; its dependency IDs and orphaned pending receipts are withheld. It does not subtract one from an immutable count or corrupt the unaffected accepted aggregate. Source revocation and disabled-policy checks still apply to pinned snapshots.

The public projector compares source coverage instants with their complete fractional
precision. A known-history or coverage start even a fraction of a millisecond after
the requested start cannot certify a measured zero; that result remains unknown.
Equivalent timestamp encodings retain the same meaning.

JSON and CSV exports preserve the separate versioned count and minimized pending provenance. Public detail routes can read the approved pending receipt. Diagnostics derive their pending data from the projected row, never an unchecked duplicate count. The browser validates the versioned schema and displays the accepted value and pending count separately, with pending explicitly unranked.

## Verification

- Engine tests: 14 accepted plus 3 pending, canonical duplicates, repeated units, accepted precedence, reviewed reversals and actor suppression.
- Service/client/export tests: exact accepted rank below a contributor with 15 accepted; current suppression and revocation on historical pins; disabled policies; absent/private/unsafe/wrong actor/metric dependency evidence; bounded known zero; date-scope exclusion; malformed versions and counts.
- Pipeline integration: real materialization and read API retain 14/3, replay does not inflate either count, current correction overlays hide pending history, and recomputation publishes 14/2 with the same accepted rank.
- Browser regression: `apps/web/browser/pending-counts.spec.ts` exercises the real service projection and API-mode page, including reload under changed current controls. Browser execution requires the pinned CI Chromium; local execution can be unavailable independently of the API assertions.
