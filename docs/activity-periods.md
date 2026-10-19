# Private accepted activity periods

Refs [#98](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/98) and
[#72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72).

`aggregateActivityPeriods` derives the existing `active_periods` definition from
explicitly selected, source-qualified activity. The caller chooses Monday-start
UTC calendar weeks or UTC calendar months. The result is private, descriptive,
unranked and always `publicEnabled: false`. It records source-policy signatures,
the frozen dataset/cutoff/backfill identity and the selected scope.

## Source admission and raw counts

The calculation reuses the reviewed `selectAcceptedActivityFacts` boundary from
the activity-breadth implementation. Each explicit canonical source policy must
select qualified or reviewed evidence; a calculation cannot mix those classes.
Policies must share a definition version and have distinct metric IDs. An
observed action, pending recognition, a metric ID merely relabeled as activity,
or a current association cannot supply an accepted historical activity unit.
Existing identity, source scope, correction, automation, role, independent
acceptance, quantity and event-time admission remain in force.

Periods use each retained source fact's original `occurredAt`, inside the
half-open selection and frozen cutoff. A later acceptance, import, observation
or publication date cannot move the activity into a new period. Many events,
repositories or selected source metrics in the same calendar period contribute
one active period per account. Each period retains all its selected proof IDs.
Calendar boundaries use actual months and Monday-start weeks, including leap
days and year transitions; they are not fixed 30-day or rolling seven-day bins.

Known activity remains visible as a lower bound under incomplete source or
qualification evidence. Such a row is `partial`, even when its known count is
positive. A `measured` row requires every selected source policy's complete
coverage of the entire selected interval and a frozen cutoff reaching its end.
Actors with no admitted activity are absent from the rows; absence is not an
invented individual zero, proof of no work, or evidence of nonparticipation.

These are private source facts and audit records. The caller must already hold
authenticated, currently authorized source inputs and complete source-specific
eligibility evidence, including any required imported/mirrored-work exclusions.
Receipt text, hashes and `verified` markers are not authentication. This helper
does not infer source lineage, grant permissions, or bypass later serving checks.

## Optional covered-calendar share

Raw active-period counts include activity in partial calendar periods at either
selection edge. The optional share uses a stricter population: only calendar
periods wholly inside the selected interval count in either share term. Every
such period must also be inside the actual source coverage and frozen cutoff.

The denominator is the number of these fully covered calendar periods. The
numerator is the number containing at least one admitted activity unit. For
example, a Thursday-to-Thursday window can intersect four weeks while containing
only two whole weeks. Activity in all four yields a raw count of four and a
covered share of two out of two; the partial edge weeks are absent from both
share terms. The calculation uses bounded calendar arithmetic, without walking
every date in a long interval.

The shared source selector rejects a requested window extending beyond the
frozen cutoff. The result withholds the share and gives an explicit reason when
the selected window is unbounded or any selected source or qualification remains
incomplete. It conservatively withholds the whole share
instead of choosing a favorable subset of sources or calendar periods. When
complete coverage is known but no full calendar period fits, the denominator
and numerator are zero, the share is null, and the reason is
`no_fully_covered_periods`. Zero is never used as a substitute for an unknown
denominator. No future portion of a week or month becomes observed time.

## Existing interfaces and remaining acceptance

The public `leaderboard-activity-summary/v1` selected-snapshot extension retains
its existing per-measure, intersecting-week contract. This separate private
aggregate implements the registry's optional fully covered-calendar share;
it does not change that public protocol or promote a UI computation combination.
All 98 definitions and the registry's public activation state remain intact.

Synthetic source, coverage, calendar, identity and correction cases verify this
helper. They do not supply real source collection, public producer integration,
newcomer or first-ever history, contributor acceptance, human accessibility
evidence, a release, or whole #98/#72 completion. There is no streak, attendance,
hours-worked estimate, personal score or activity-pressure notification.
