# GitHub source adapter coverage

Refs #45, #46, #59, #63, #67, #79. This is implementation evidence, not installation,
source-owner acceptance, real-data reconciliation, or launch approval.

The default collection adapter reads complete paginated issue, PR, comment,
commit and release lists. Review inventory first traverses every PR, then every
review connection; a failed nested scan prevents publishing a partial count.
All requests retain the configured authorization fence and transport quotas.
The 10,000-record and configured page limits fail closed.

Review snapshots use a SHA256 fingerprint of source identity, submission time,
state, commit, author and body. Text influences revision identity but is not
retained in collection facts. A scan-identity suffix distinguishes later observations
of restored state (A → B → A) while same-scan replay stays idempotent. Hydration
must reproduce the payload fingerprint. A
complete review cohort establishes first reviewer/PR participation and first
reviewer/PR/head submission; duplicate IDs, unknown earlier actors, unknown
heads, unsupported states or missing submission clocks prevent that proof.
Self reviews, bots and review quality retain the existing independent policy
rules. A submitted review does not establish first-ready review-wait history.

Discussion collection uses the read-only GraphQL repository connection, checks
repository identity, public visibility and enabled capability on every page,
and preserves disabled/unreadable sources as unavailable rather than zero.
It imports public Discussion identities, not arbitrary external support content.
The Discussion fingerprint includes native answer selection and removal, even
when the Discussion updatedAt field is unchanged. Hydration credits creation to
the author. Native accepted answers retain the answer author, selector and
selection clock separately and remain observed evidence rather than independent
quality review. Answer metrics require the trusted host's selectedCurrentState
flag: the host must exclude superseded subject snapshots at its frozen cutoff.
Otherwise answer credit stays unavailable. Raw comment volume is never counted
as helpfulness. Unknown authors and clocks remain unknown.

Schema references: [GitHub Discussions API guide](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)
and [Discussion fields](https://docs.github.com/en/graphql/reference/discussions).

Repository issue-event history now supplies the `timelines` family through the
paginated repository events endpoint and exact event hydration. Attribution uses
the event actor and event creation clock, never the issue's current assignee or
updated timestamp. Unknown metadata target identities (for example historical
labels containing only names) remain unknown. Unsupported event subtypes remain
uncredited; this endpoint is not a claim of complete GitHub timeline coverage.
See [issue events](https://docs.github.com/en/rest/issues/events).

The `project_current` adapter traverses each approved repository issue/PR's
explicitly approved Project memberships (`repository.allowedProjectIds`) and each
item's complete field-identity connection. Missing approval fails closed. Unapproved
Projects are filtered before field hydration; a metadata-only probe precedes field reads. Public
Project and content-repository scope are checked on every nested page. Item
changes during field pagination fail closed. Only field IDs and types form current-only fingerprints; no field values or
historic editors are collected. Field-value collection needs its own approved scope. A Project snapshot produces a source observation and
no contribution metrics. The runtime retains opaque source provenance, not a
published Project field-value or current-context view. See [Project item fields](https://docs.github.com/en/graphql/reference/projects)
and [issue Project memberships](https://docs.github.com/en/graphql/reference/issues).

Selected native issue and PR histories support ProjectV2ItemStatusChangedEvent.
Issue histories also support ParentIssueAdded/RemovedEvent and BlockedByAdded/RemovedEvent.
They traverse the bounded filtered GraphQL timelineItems connection and retain exact event IDs,
actors and creation clocks. Distinct native events in the same second remain
distinct; replaying one event does not create another unit. Status details are
hydrated only after the event's public Project matches repository.allowedProjectIds.
The native wasAutomated flag is bound into event revision proof; automated or
unknown automation states receive no human status-update credit.
Parent/blocker endpoints must both be public in the approved repository; foreign
or hidden endpoints remain unavailable. Current parent or blocker fields never
stand in for missing history. Other event subtypes remain unsupported.

Relationship records are checked again after every fresh, resumed or completed
timeline read. The exact selected event type must carry its own `parent` or
`blockingIssue` field, without a competing non-null endpoint. Unsupported events
and swapped endpoint fields cannot become intentional parent or blocker facts.
Event and endpoint IDs must contain text; the endpoint URL must be the exact
approved repository's canonical positive issue-number URL, without a query,
fragment or alternate path. Cached events receive the same event-field shape
checks as fresh pages. Valid event bytes and revision fingerprints are preserved;
unknown actors and unsupported clock text remain unknown. These checks neither
add source privileges nor certify an installed history. Existing published data
still needs its authorized source replay and publication review; changing the
reader alone is not a claim that old snapshots were rebuilt. Synthetic reader and
normalization regressions are in `packages/github/test/timeline-relationship-integrity.test.mjs`.

The Project-status inventory includes open and closed issues and PRs, then selects
the explicit issue or pullRequest timeline and verifies its exact repository,
subject URL and event revision again during normalization. Collection binds the
REST node identity to every GraphQL page; normalization also requires one stable
subject across fresh and resumed pages. The minimized collected fact retains that
native issue/PR ID separately from its event ID. Hydration must match the collected
ID, including when every later page consistently names a different subject at the
same URL. Ordinary event-revision drift remains uncredited until a fresh collection
verifies the new revision; it does not establish a subject-scope loss.
Legacy facts without the collected native ID remain uncredited until recollected.
A private Project-only normalization version prevents older cached results from
bypassing this binding, without changing frozen comparison policy signatures or
relationship behavior. Typed-history checkpoints use a new
identity-verification namespace so older completed scans cannot bypass these checks.
It uses a separate
inventory checkpoint from older issue-only scans; a completed legacy checkpoint
cannot silently certify PR coverage. Duplicate subjects and incomplete nested
pages fail closed. The PR author never substitutes for the event actor: an unknown
editor remains uncredited unknown evidence. Current and pinned PR publications
use the same persistent Project-privacy denial and reapproval gate as issue evidence.
A nested subject that becomes private, disappears or changes identity enters that
durable denial path even when the enclosing REST repository and Project still
appear public. Missing, invalid or reused inventory identities enter the same
denial path. Restoring the source alone cannot reopen prior publications:
recovery requires a separately approved configuration and rebuilt publication.
The synthetic transport, collector, normalizer and publication regressions are in
`apps/pipeline/test/project-pr-history.test.mjs` and `project-privacy.test.mjs`.
See the [PR timeline types](https://docs.github.com/en/graphql/reference/pulls)
and [native Project status event fields](https://docs.github.com/en/graphql/reference/projects).

Remaining source work includes broader typed historical subtypes, verified
readiness cohorts, and live installation permission/reconciliation evidence.
Real source approval, public permission probes, independent evidence review and
launch gates remain external acceptance prerequisites. None of these issues is
closed by synthetic tests alone.

Approved trusted enrichment also supports [revision-bound research record
candidates](research-record-adapter.md). A configured record path and verified
Git blob create a pending decision-record version with an exact source link;
independent private review is required before accepted credit. Generated/imported
contracts, synthetic notes and PR merge status cannot establish research findings.
Classification configuration participates in normalization cache identity.

Confirmed Project privacy or authorization loss denies the repository's current
and pinned publications. Every approved Project receives an explicit public-node
probe, even when histories or memberships omit it. Collection and normalization
scope-loss paths persist a private configuration-bound denial in controls and a
SQL receipt; an immediate in-process fence prevents a failed controls write from
leaving published evidence readable. A public repository probe cannot clear this
Project denial. Recovery requires a newly approved configuration version and a
successful rebuilt publication; old-version snapshots remain unavailable.
Transient transport failures retain ordinary retry behavior and are not asserted
to prove a Project became private.

The separate opt-in [native Project curation family](NATIVE_PROJECT_CURATION.md)
reads issue/PR add/remove events under explicit repository and Project grants.
It binds actual subject, Project and native event identities without inventing a
ProjectV2Item ID, keeps automation separate, and refreshes source admission before
publication. Full-scan output cursors bind minimized native semantics; incomplete
history and the existing persistent Project denial/reapproval boundary remain
explicit. Existing status, field and current-membership adapters are unchanged.
