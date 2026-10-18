# Public participation in a selected snapshot

Refs [#98](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/98) and
[#124](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/124).

The contributor profile response includes the optional `activitySummary` extension
(`leaderboard-activity-summary/v1`), and the public portfolio renders it alongside
the existing measure results.
It describes the full selected snapshot, independent of timeline page size or cursor.
It uses only metric evidence that has already passed the current source, artifact,
actor, category, policy and snapshot projection. It reads no private frozen history.
An affected aggregate is withheld when one of its required receipts becomes private;
the summary does not guess a replacement by subtracting an evidence count.

For each permitted count/sum measure the summary reports distinct active calendar
weeks, the number of dated and undated evidence records, and the earliest dated
qualifying receipt in this selection. Each week starts on Monday in UTC. Bounded
windows expose the number of calendar weeks intersecting their half-open bounds;
the end boundary never adds another week. All-time has no invented denominator.
Evidence clocks follow the selected metric's existing date basis, not publication
time. Earliest-evidence ordering preserves source offsets and fractional precision;
its independently supplied observation time remains unknown when absent.

Known activity is partial unless bounded source coverage encloses the entire
selected interval with no gaps. Zero active weeks needs that coverage and a
published zero result. Unknown dates do not become zero. Pending receipts do not
enter this summary. Decided-PR ratios and readiness/review durations remain in the
existing descriptive diagnostics with their policy-qualified sample and censoring
values; participation does not recompute these or change any rank.

**Newcomer status remains unknown.** Complete coverage of one selected window is
not reviewed organization-wide origin evidence. The public protocol cannot yet
carry that origin and all required historical scopes, so this extension has an
explicit unavailable-history state and never labels a person new or established.
The earliest visible receipt is not a joining date or proof of no earlier work.
The separate metric-engine `participationView` still owns its reviewed-history
calculation; completing its protected-to-public origin authority is remaining
implementation/acceptance work, not a silently enabled inference in this UI.

The client validates the versioned extension, its selected-window denominator and
its metric membership against the same profile response. Older publications that
omit the extension show unavailable data. No additional background request, local
storage or share-card cache is introduced. Existing profile revalidation clears
the entire summary on source failure, suppression, navigation or revoked pins;
earliest-proof links retain the snapshot and filters and discard timeline cursors.

Synthetic verification lives in `apps/service/test/participation.test.mjs` and
`apps/web/browser/participation.spec.ts`. It exercises real service handlers,
timeline pagination, unknown/zero boundaries, exact clocks, current privacy and
disabled metrics, legacy clients, narrow layout, accessible markup and pinned
proof navigation. These checks do not establish real contributor history,
source grants, screen-reader acceptance or public-service operation. The wider
work packages remain open until their complete gates have actual evidence.
