# Native Project item curation

The separately configured `project_curation_history` source family reads native
`AddedToProjectV2Event` and `RemovedFromProjectV2Event` observations for repository
issues and pull requests. It supplies observed units for `project_items_curated`.
It does not expand the existing `project_history` status family, current
`project_current` membership snapshots, or Project field updates.

## Explicit source boundary

An approved repository configuration must name this family and a nonempty
`allowedProjectIds` list. Adding code to the family catalog does not grant an
installation permission or enable collection. The reader uses the numeric
repository-bound client and existing durable checkpoint authority. It probes
every approved Project, acquires repository identity/visibility and separate
issue/PR inventories through metadata-only GraphQL queries, binds each subject to
its native node ID and canonical issue/PR URL, and checks the repository and subject again after
the timeline scan. Hidden, private, missing or identity-changed approved sources
fail closed.

The source shape follows GitHub's
[Project event fields](https://docs.github.com/en/graphql/reference/projects),
[issue timeline enum](https://docs.github.com/en/graphql/reference/issues#issuetimelineitemsitemtype)
and [PR timeline enum](https://docs.github.com/en/graphql/reference/pulls#pullrequesttimelineitemsitemtype).
Both native event types expose an event ID, actor, source creation time, Project
and automation flag. Neither exposes a ProjectV2Item ID. The implementation
therefore binds the actual repository, issue/PR subject, Project and native event;
it never invents a `PVTI` identity from an issue number, URL, current membership
or creator.

Only minimized identities, canonical source URLs, source clocks, actor
classification inputs and the native action/automation flag enter the reader's
private checkpoint. Collection facts retain the exact subject, Project, event,
actor, source clock and revision binding. Titles, bodies, field values and
arbitrary provider fields are not retained by this family. The repository probe
and both inventories avoid the shared REST ETag cache, whose response write
otherwise precedes scan selection. Each inventory has a separate versioned key.
Other explicitly configured source families retain their existing cache behavior;
this capability does not erase historical cache records.

## Full observation windows and cursors

This family accepts a full `since: null` audit or backfill, and the existing
unplanned full reconciliation form. Its upper `until` must be an exact canonical
UTC millisecond instant. Events after that instant are excluded; an event exactly
at it is retained. The engine separately applies the chosen metric window's
half-open `[from, to)` bounds. There is no claimed recent lower-bound API:
the four existing recent source families and reconciliation planner remain
unchanged. The existing planner can select this family for a full audit; it
cannot select it for planned recent reconciliation. The legacy unplanned full
reconciliation form stays distinct from that recent capability. The storage
admission boundary enforces a null lower bound and
unknown expected history count for this family too, including an empty page;
a custom adapter cannot certify a finite total by bypassing the built-in reader.

The issue and PR inventories have separate checkpoint namespaces and both refresh
before every output page. Each native subject scan
also has an independent versioned namespace and bounded pagination. Native scans
refresh before delivery, including after an earlier completed scan; they do not
treat an old checkpoint as current privacy or event-availability authority.

Output pages sort native event IDs canonically. Their `hexDigest:offset` cursor
binds the repository, run, upper cutoff and complete minimized observation:
subject, Project, native event, action, revision, actor, source time and automation.
Stable replay and provider reordering preserve the page. An inserted, removed or
changed operation rejects the saved cursor, requiring a fresh full run rather
than silently shifting its offset. Legacy numeric cursors are not accepted for
this family; every older family's cursor behavior is unchanged. The reader
bounds each native page, each subject scan and the total subject/event inventory.

An observed inventory is not complete historical capability. Expected history
count remains unknown, coverage stays incomplete, and missing events are not
converted into measured zero.

## Source identity and attribution

The canonical operation key is the repository plus native issue/PR subject,
Project and event ID. Genuine add, remove and re-add events have distinct IDs.
Replay and later observation of the same operation cannot multiply it. Conflicting
actor, action or source-time observations retain the same key and are rejected by
the engine's existing semantic-conflict rule.

Only the native event actor supplies credit. Issue/PR author, item creator,
assignee and current Project membership are not substitutes. Missing actor
identity remains unknown. `wasAutomated: true` is retained as automated execution
and role `automation`; the bounded observed curation policy requires role
`triager`, so an automated User event cannot receive human curation credit.
`wasAutomated: false` means execution is unknown, not manual. Bot and independently
reviewed service-account classifications retain their separate actor kinds.

The policy requires the source occurrence clock, canonical operation grouping
and the observed triager class. It creates no acceptance or correction receipt.
The operation's Project is an internal event filter, not complete historical
or current membership. The public Project-context projector is unchanged and
does not promote add/remove observations into a current-membership claim.

## Rehydration, denial and recovery

Every retained curation fact is rehydrated through the native reader before a
new publication, even when collection is already complete and the normalization
cache has the same revision. A separate normalization generation leaves all
older status/field families and their keys unchanged. Its admitted frozen-identity
and correction generations retain the same ordered wrapper and marker checks;
this does not enroll the family as a relationship-pair source. Collected identity,
Project, source revision, source clock and actor must match the fresh observation.

Loss of a still-approved event, subject, repository or Project uses the existing
durable Project denial: SQL source access and the private configuration-bound
fence withhold current and pinned publications. Merely restoring the source or
reopening the database cannot clear that denial. Recovery requires a separately
approved configuration version and successful rebuilt publication; earlier
configuration snapshots remain unavailable. A separately approved narrower
Project scope may exclude old observations before reading them.

Transient transport/schema failures do not prove that a Project became private.
The normalizer does not claim continuous atomicity between GitHub and HTTP
delivery. Existing repository, source, correction, private confirmation and
final host checks retain their own authority.

## Bounded regression evidence and remaining acceptance

The source tests use explicitly fictional GitHub transport and host approvals:

- `packages/github/test/project-curation-history.test.mjs` exercises native
  parsing, subject binding, actor distinctions, post-scan privacy, captured input,
  current authorization and the real filesystem checkpoint/retirement boundary.
- `apps/pipeline/test/project-curation-source.test.mjs` exercises the default
  collector/normalizer, stable and changed output pages, actual on-disk database
  reopen, cached native revalidation, durable denial and explicit reapproval.
  A separate existing protected-normalizer port supplies synthetic reviewed
  service-account receipts and classifier IDs; it checks fresh cache/reopen
  behavior, frozen private previews and public receipt redaction without claiming
  a live reviewer roster. A separate on-disk case exercises the existing protected
  correction port, exact retries and retained frozen bytes; its synthetic host
  authorization is not independent real-world correction acceptance.
- `packages/metrics/test/project-curation-source.test.js` exercises the real
  normalizer/engine, operation identity, replay/order, source clocks, automation,
  unknowns and contradictory observations. Ingestion and operator-client tests
  cover the explicit family and minimized stored facts.

These definitions do not themselves establish execution results, an installed
App grant, a live native capture, complete history, manual effort, independent
correction authorization or public activation. The 98 metric definitions,
`definition_only` UI maturity, empty selectable combinations and
`public_enabled: false` remain unchanged. Project curation is separate from
scalar field edits and substantive published Project progress updates.
