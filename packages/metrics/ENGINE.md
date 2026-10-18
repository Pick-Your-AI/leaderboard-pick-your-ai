# Candidate metric engine: filtering and evidence boundaries

Refs #91, #98 and #115. `src/engine.ts` computes candidate snapshots from a
caller-supplied frozen dataset. It never activates a public policy. All tests
use synthetic evidence; no test or manifest authenticates a review receipt,
certifies actual source coverage, or satisfies owner/release approval.

## Windows and scope

`resolveMetricWindow` defaults to a rolling 30-day UTC window and also supports
7/90-day, all-time, calendar-to-date month/quarter/year, and explicit custom
bounds. UTC bounds are half-open: a boundary action belongs to the later
window only. The timezone is returned explicitly as UTC; other selected
zones and their calendar presets are not implemented. Current Project and
workstream context is an explicit alternative to event-time context and
never substitutes for missing historical membership. Project selections are
set unions; overlapping selections do not multiply a canonical action.

Actor-kind and role validation follow the versioned contract enums.
Automation requires a known automation account kind or explicit source
`executionMode: automated`; an organization or an unknown account is not
inferred to be automation. User-account and automation views can overlap for
a user account executing automated actions. An absent execution mode remains
unknown. Source adapters and review services must authenticate the identity,
membership, source rights and repository inventory supplied to this boundary.
Reviewed `service_account` actors must carry matching versioned private
classification evidence no later than the frozen cutoff; they cannot enter
the `user` filter. Evidence attached to an actor relabeled `user` is rejected.
Service accounts remain in automation/all scopes without claiming every action
was automated. Public projections omit the private evidence. See
[service-account compatibility](../../docs/service-account-classification.md).

## Qualification uncertainty and exact arithmetic

Source completeness is distinct from qualification completeness. An explicit
list of uncertain audit reasons covers unknown qualification and missing
independent acceptance, as well as ambiguous canonical evidence, unreviewed
revisions, missing history and conflicting policy-unit measurements. Such
inputs cannot certify complete newcomer history. An unknown qualification
cannot disappear behind an eligible observation of the same policy unit.

Line quantities and their aggregate must be nonnegative exact safe integers.
A fractional or overflowing line count fails closed. Repeated eligible
observations grouped as one policy unit must agree on their sum quantity,
ratio outcome or ready-to-review timestamps. Contradictory or missing-versus-
known measurement evidence excludes the unit and records
`conflicting_policy_unit`, rather than choosing a convenient value by ID.
Duration timestamps compare normalized instants, so equivalent second and
millisecond encodings do not manufacture a conflict.
Identical repeated evidence remains deduplicated. The existing explicit
qualified-over-pending unit precedence remains unchanged.

## Participation and policy comparisons

Newcomer certification requires reviewed known-history bounds that form a
valid interval, start no later than the selected period, have complete
repository/source coverage, and contain no uncertain evidence. Otherwise
`newcomer` remains null and `historyCoverage` is incomplete. Review receipt
strings alone are not approval. First-observed qualifying contribution is
not employment tenure or proof that no earlier activity exists.

Acceptance ratios and review-wait distributions remain descriptive and
unranked, with denominators, sample counts and censoring disclosures.
`comparePolicies` runs old/new definitions against the same frozen dataset;
release manifests preserve policy signatures and require a designated
approval and release notes. They remain candidate artifacts with
`publicEnabled: false`. Actual approver authentication, atomic persistence,
rollout and rollback execution are outside this pure engine.

## Verification and remaining gates

The synthetic metric tests cover unknown historic qualification, missing
acceptance, malformed history intervals, actor-kind filters, exact integer
bounds, contradictory sum/ratio/duration evidence, policy replay, Project
selection overlap and adjacent UTC windows at a DST fallback boundary.

Issue completion still requires reviewed integration, source-certified
inputs, API/UI behavior and the stated acceptance gates. No live service,
accepted policy, operator approval or completed issue is claimed here.
