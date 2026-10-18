# GitHub source adapter coverage

Refs #45, #46, #59, #63, #67. This is implementation evidence, not installation,
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

Selected native issue histories now support ProjectV2ItemStatusChangedEvent and
ParentIssueAdded/RemovedEvent plus BlockedByAdded/RemovedEvent. They traverse the
bounded filtered GraphQL timelineItems connection and retain exact event IDs,
actors and creation clocks. Distinct native events in the same second remain
distinct; replaying one event does not create another unit. Status details are
hydrated only after the event's public Project matches repository.allowedProjectIds.
The native wasAutomated flag is bound into event revision proof; automated or
unknown automation states receive no human status-update credit.
Parent/blocker endpoints must both be public in the approved repository; foreign
or hidden endpoints remain unavailable. Current parent or blocker fields never
stand in for missing history. This adapter currently covers issue timelines;
PR-specific Project timelines and other event subtypes remain unsupported.

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
