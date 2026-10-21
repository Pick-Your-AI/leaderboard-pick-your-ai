# Public decided PRs and pending backlog

This is an optional publication projection of the existing protected native
decision-history producer. It does not enable a repository, install an adapter,
approve a metric policy, or make the ratio rankable. A host must already enroll
the repository through `pullRequestDecisionRepositoryIds`, and the selected
publication must already configure the `pr_accepted_rate` policy.

## Two clocks with separate meanings

The persisted generation retains its collection event cutoff C, native capture
clocks, observation times and frozen-input cutoff F. A reporting window [S, E)
selects one native PR state strictly before E, with E <= C. The selector validates
the original complete API-visible history and stable before/after anchors, then
replays that history at E. It does not replace C, re-sign a receipt, recollect the
source, or infer the historical state from today's REST state.

Merged and finally closed-unmerged decisions count only when their final
decision time falls in [S, E). A close followed by a reopen before E is pending;
the earlier close does not remain in the denominator. A new decision exactly at
E is excluded. A PR created exactly at E is not yet part of the cohort. Equal
instants retain the native selector's fractional precision and exclusive-end
semantics.

Known pending PRs are a backlog as of E. They may have been created before S.
They never enter the merged numerator or decided denominator. Missing authors,
unavailable normalizations and incomplete or ambiguous native histories supply
neither a pending unit nor a decided unit. An empty or incomplete source does
not establish a measured pending zero. Existing partial coverage stays partial;
this projection does not certify a complete repository history.

## Source binding and public evidence

The reader consumes only the selected immutable collection runs. Existing
repository-generation, source-authority, data-mode, clock, row/byte and structural
checks run before a native selection is used. The ordinary default normalizer
independently supplies the public PR artifact, source revision and exact numeric
author/node binding. The new helper creates a compact derived metric fact only
when both sources agree. It does not credit a merger, editor or current text as
the PR author, and does not infer event-time Project membership from current
membership.

The original source observations and ordinary normalization documents are
unchanged. A private `pullRequestDecisionProjection` authorization binds the
projection version, E, original capture hash and derived base-fact hashes. The
frozen dataset contains the selected facts. Current, pinned and comparison
restoration re-read the original selected runs, reselect at E and verify the
derived facts against those exact retained normalizations. A changed outcome or
window binding is rejected; later collection does not rewrite an older capture.

Public evidence identifies the native PR, credited author, final decision time
or pending creation time, and original public source revision. Any title is an
as-collected label. The private timeline, event IDs, capture metadata and
projection authorization are not public evidence history and are not serialized.
Pending dependencies carry a provider-private E marker so the service can retain
older backlog through its normal scope filter. The service checks that marker
against the selected publication's coverage/window, metric and author role,
then removes it from response bodies.

The existing current source authorization, Controls, artifact/actor suppression,
snapshot retirement and post-read fences still apply to historical reads and
exports. The marker cannot bypass those checks. Pending dependencies remain
distinct from ranked outcomes; missing or suppressed dependencies withhold their
count as unknown. No ranking, composite score, readiness collection, target-branch
scope or new UI activation is added.

## Proposed automated verification

The added native-selector cases reuse one real captured receipt at earlier ends
and preserve its exact bytes. Engine cases cover pre-window pending, half-open
decision clocks, mismatched windows and unchanged ordinary pending rules. Service
cases traverse actual handlers and strict client/export parsers, including wrong
end/metric/role and current privacy controls.

The pipeline cases use fictional HTTP/native responses through the real GitHub
client, default collector and normalizer, file checkpoints, PGlite and Controls.
They compare earlier pending and later decided windows from one collection,
withhold incomplete history and outer inventories, and verify immutable A/B
publications, frozen comparison restore, reopening and current suppression.
These are synthetic engineering cases. Their source alone is not a passing
execution result, real source certification, policy approval or public launch
acceptance.
