# Private accepted collaborator counts

Refs [#72](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/72) and
[#124](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/124).

`aggregateCollaborations` implements the registry's distinct evidenced peer
calculation for one subject under the explicit `accepted-peer-pairs/v1` policy.
It returns a private, descriptive result over supplied accepted activity. It
does not collect GitHub history, publish a collaborator graph, activate a metric,
or change a source policy, the registry, the pipeline, or the public service.

## Inputs and source admission

The caller supplies the existing frozen dataset, an explicit nonempty set of
source policies, a UTC selection, the subject's stable actor ID, and the current
protected artifact manifest. Source policies must use the selected definition
version, retain one policy per source metric, count canonical units, and select
one accepted evidence class: qualified or reviewed. Observed policies, sums,
derived breadth/history measures and implicit policy choices are rejected.
Both new array inputs and the policy/scope lists must be dense. Repeated exact
artifact records are harmless; conflicting records for one stable artifact ID
fail before visibility filtering.

The selector reuses the metric engine's correction, canonical identity,
independent acceptance, repository, actor, role and event-context admission.
It requires the user-account lens and event context. Each qualifying fact has
an original occurrence time at or before both acceptance and source observation,
known artifact identity,
and explicit author, coauthor or reviewer role. Both participants must be visible user accounts;
deleted, suppressed, unknown, bot and service accounts, and positively automated
user accounts are excluded. Unknown execution remains unknown and does not
establish manual work.

The original source observation may precede the later independent acceptance.
Both clocks retain their own meanings; an acceptance receipt does not replace
the source observation time.

Original source policies and their occurrence clocks remain unchanged. This
aggregate validates those policies before applying its own acceptance-time
formation rule to the retained original proofs.

The strict artifact contract and existing achievement-proof URL predicate
validate the manifest. An eligible artifact has a known kind, stable ID, matching
repository ID, public visibility and a safe GitHub URL. Missing or unavailable
artifacts are recorded in the audit and cannot supply a peer. A source proof whose
repository contradicts the manifest is excluded and audited; independent valid
pairs remain available. Conflicting manifest identities fail before any pairing.
Names, titles, mentions,
membership, assignments, current Project membership and private source content
do not establish a relationship. The host must supply actual source authority
and current controls; schema validity does not authenticate that authority or
prove that the URL resolves.

## Pair identity and acceptance time

Both original accepted proofs must bind the same exact artifact and repository.
Eligible relationships are shared authorship (author or coauthor on both sides)
and an author/coauthor paired with a reviewer. Two reviewers do not make a pair.
The subject cannot be their own peer. The existing actor validation rejects
contradictory known provider identities; display names are never identity keys.

For each artifact and actor, retain the earliest accepted original authorship
proof and earliest accepted original review proof. Equal acceptance instants
use stable fact IDs, then source metric and canonical identity, for deterministic
selection. A relationship forms when both sides are accepted: its `formedAt`
is the later of the two original `acceptedAt` instants. Select the earliest
qualifying relationship per artifact and peer. Shared authorship has precedence
only when formation instants tie; a later shared-authorship record cannot move
an earlier author/reviewer relationship into a different period.

Apply the requested half-open `[from, to)` interval after that selection. Source
admission therefore reads retained acceptance history before `to`, using an
unbounded start and the consistent `all` preset. An author accepted before the
requested start may form a relationship with a reviewer accepted within the
window. Repeated later representations cannot revive an already established
artifact/peer relationship in a new window. A genuinely different artifact can
supply its own qualifying pair, while the same peer still counts once across
all qualifying artifacts.

The per-peer records retain the selected per-artifact relationship, exact
artifact identity/URL, formation time, and both original source fact IDs,
canonical identities, metric IDs, actors, roles, occurrence/acceptance/observation
clocks and revisions. They do not combine several roles into an invented proof.
The helper does not modify the frozen inputs or mint replacement facts.

## Result and completeness

The result binds the dataset, cutoff, backfill revision, canonical requested
scope, subject, policy/definition versions, explicit source-policy signature and
validated artifact-manifest signature. Peers and proof pairs have stable identity
ordering; repeated exact manifests do not change their signature. The internal
audit retains inherited admission reasons and additional collaboration reasons.
These private bindings and audit records are not a public response contract.

Every result has `coverage: incomplete`, `publicEnabled: false` and `rank: null`.
Known peers produce their distinct positive count with `state: partial`. No
eligible peers produces `value: null` and `state: unknown`, including when the
supplied source partitions describe the selected month as complete. That month
does not establish complete prior counterparts or a complete collaboration
history. A separately reviewed origin/history protocol is needed before zero or
complete totals can be claimed. No first-ever partner, newcomer status, effort,
quality, social popularity or universal score is inferred.

This implementation is separate from the existing `accepted-evidence/v2`
occurrence-scoped achievement pages. Their bounded pair pages must not be added
together to obtain this acceptance-time aggregate. Public source authorization,
activation, real evidence review and the remaining #72/#124 acceptance criteria
retain their separate requirements.
