# Public account and automation selection

The connected public UI and API accept `actors=user`, `actors=automation`, or
`actors=all`. Omission preserves the existing all-activity view. The response's
`actorFilter` identifies the selection independently from the exact materialized
repository/workstream/date scope and snapshot. Refs #40.

| Selection | Meaning |
| --- | --- |
| `user` | Actors whose source account kind is `user`, including any positively known automated execution. |
| `automation` | Bot, GitHub App, reviewed service-account and system kinds, plus actors with positively evidenced `automated` execution. |
| `all` | All otherwise eligible public account kinds; unknown account or execution information is not reclassified. |

These views can overlap. Their counts must not be added together. A user-account
record does not certify manual execution or prove the absence of AI assistance.
Names, writing style, model names and unverified declarations do not classify an
actor. Reviewed service-account identity classification is a separate source
boundary.

Selection runs after current source authorization and privacy projection, including
for pinned snapshots. It removes complete actor rows, diagnostics and proof
collections before ranking, counts, grouping or pagination. It never subtracts
evidence counts from a metric, changes a denominator, or broadens source approval.
Dense ranks describe the selected view. Missing/hidden evidence retains the
existing unavailable behavior.

The selected value is bound into board, directory, profile and activity cursors.
Reusing a cursor with a different selection fails; navigation starts the new view
at its first page. Detail routes, portfolio timelines, pending evidence,
achievements, cards and exports use the same filtered projection. SSE identities
and polling links preserve selection. Current privacy changes continue to
invalidate old cursors and hide suppressed data.

Editorial spotlights use a separate controls projection that does not provide
account-kind evidence. They remain unavailable for user-account or automation
views rather than silently showing unfiltered selections.

JSON exports contain `actorFilter`; CSV metadata contains `actor_filter`. Downloads
also carry `X-Leaderboard-Actor-Filter`. The connected client rejects a response
that omits or widens a requested non-default selection, and verifies returned
account kinds against the requested view. Legacy responses without a selection
label remain compatible only with all activity.

Validation covers overlap between user accounts and known automation, invalid
selectors before source I/O, direct proof and card exclusion, filtered dense
ranks after suppression, cursor replay and selection changes, export provenance,
SSE/polling selection, and responsive keyboard-accessible UI navigation. Fixtures
are synthetic; this implementation does not establish real account classification,
source acceptance, manual authorship, or completion of every #40 criterion.
