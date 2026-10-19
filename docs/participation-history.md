# Reviewed organization history

Refs [#98](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/98) and
[#124](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/124).

The optional `accepted-organization-history/v1` rule describes a contributor's
first qualifying accepted source occurrence inside a reviewed organization history.
It has a separate `leaderboard-participation-history/v1` public response and a
fresh first-proof route. The existing selected-snapshot `activitySummary` and
metric-engine `participationView` remain separate contracts. No rank, metric
definition, release eligibility or default source configuration is changed.

## Versioned decisions

The reference universe is the entire admitted organization from its reviewed
origin through a frozen observation cutoff, across every required repository/source
pair and qualifying policy. Profile repository, Project, workstream, membership
context, role, actor-filter and category choices remain an independently echoed
profile lens. They never narrow the first-contribution search. Thus an earlier
review in another repository can precede the author contribution shown in the
selected profile. A category milestone remains the separate selected-scope
[achievement rule](recognition-ui-integration.md).

Qualifying evidence must already be public, attributable to the requested resolved
user account, accepted, eligible and supported by at least one admitted
metric/role/source policy. Automated accounts and non-user account kinds have
unknown history eligibility. Unknown execution mode does not become a claim of
manual work. The service consumes the provider's accepted evidence classification;
it does not infer acceptance from a metric name, source URL, PR disposition or
typed receipt.

Order uses the original source occurrence, including offsets and fractional
precision. Observation time is independently required and must not precede the
occurrence or exceed the frozen cutoff. Neither collection time nor publication
time replaces a missing occurrence. Equal occurrences use the original
contribution ID as a deterministic tie-breaker. Distinct role/policy proofs for
one canonical event remain distinct; their known occurrence must agree. Artifact
identity, actor identity and contribution identity remain separate namespaces.
Opaque artifact IDs retain their already projected spelling and are never route
components.

For a complete finite selected period, `newcomer` means only that this first
qualifying occurrence falls in its start-inclusive, end-exclusive interval.
An all-time selection returns a null Boolean with `unbounded_selection`. A period
whose end exceeds the frozen observation cutoff returns a null Boolean with
`history_cutoff_before_selection_end`. These cases can still expose a known
historical first proof. There is no manufactured period denominator, joining date,
first-ever claim, manual-work claim or personal-quality score.

## Protected provider boundary

`PublicSnapshotSource.readParticipationHistory(scope, snapshotId, actorId, signal)`
is an optional trusted server capability. A provider either returns a paired
`ParticipationHistoryRead`, returns null for an unavailable selected publication,
or returns a valid current read with `history: null` when no applicable reviewed
history is admitted. There is no public request field, writer endpoint or service
option that approves history. A provider failure is not retried through ordinary
`read` to obtain a weaker result.

A real provider implementing this capability must perform these operations under
its existing authenticated configuration, source-authorization and storage
boundary:

1. Resolve the selected publication's immutable input and exact content identity.
   Bind its snapshot ID, revision, SHA256 and actual observation cutoff. Resolve
   the history dataset, its exact input identity and backfill revision from
   protected storage. Both sides must use that same frozen cutoff.
2. Resolve a reviewed organization origin and **complete required** source inventory
   from protected configuration, independently of the dataset's supplied coverage
   entries. Resolve the complete qualifying policy versions, signatures, role
   sets and source adapters. Match the dataset inventory to that admitted set;
   omitting an inconvenient repository or policy is not a coverage repair.
3. Read the selected publication, full historical universe, current controls and
   all required source authority in one transaction/critical section. Use the
   existing repository source locks and current repository identity/visibility
   authorization. A pair assembled from two independent public reads is not this
   protocol. A configured source becoming unavailable must deny the admission or
   retain a gap; it cannot silently shrink the universe.
4. After the final awaited source/authorization operation, recheck the applicable
   admission, source configuration, publication confirmations, repository/source
   denial state and current suppression/revocation controls before returning.
   Respect cancellation. Do not return a detached earlier authorized result after
   that authority has changed. Apply the same fence on the dedicated proof read.

The private protocol's `decisionId`, hashes, revisions and nonempty strings are
**identity descriptors, not authentication**. The service verifies their shapes,
cross-bindings and public projection; it cannot prove that arbitrary bytes from a
trusted provider are the claimed dataset or that a forged review string is an
authorized decision. A provider implementation must supply that authority through
its actual protected configuration/storage flow and tests. This change does not
install such an admission in the stock pipeline. Its existing partial historical
coverage and unknown origin continue to produce unknown newcomer status.

### Private publication profile

The private history contains an existing `PublicRead` whose selected scope is
exactly unfiltered organization/all-time, with no source-scope version or actor
filter. Its `portfolioEvidence` is the complete admitted proof universe; rows,
primary evidence, pending evidence and diagnostics must be empty. Other provider
metadata is passed only to the existing allowlisted projection. No general
historical snapshot URL is fabricated from this private object.

Every supplied portfolio proof has exactly one `proofSources` contribution-ID,
repository-ID and source-adapter binding. Every source pair belongs to the
admitted inventory. Current and historical actor IDs must retain their stable
GitHub node/database bindings globally, before requested-actor or privacy
filtering; a login change is not an identity change. Current and historical
suppression/revocation arrays and controls version must match as sorted arrays,
even when the controls version string did not advance.

Coverage for every required pair must enclose the reviewed origin through the
cutoff, declare complete state and known origin, and have a successful sync and
source watermark reaching that cutoff, with no missing pages, permissions or
source errors. Every supplied record for a pair must satisfy this condition.
An extra unadmitted pair is invalid input. The full policy set must remain
available with matching recorded signatures and versions; disabling one policy
cannot silently reduce the definition of first contribution.

Providers must retain unresolved attribution, time, qualification, conflicts and
withheld-history gaps in the bounded private `unresolved` array, even when they
cannot publish the original payload. Each reason must be a literal supported
string; malformed reason values invalidate the complete provider response before
actor scoping on both history and first-proof reads. A gap for the requested actor, or a gap with
unknown actor attribution, withholds a known first event. An unrelated actor's
known-attribution gap does not establish a gap for everyone. Supplied relevant
raw proofs also retain this uncertainty before public filtering. Missing clocks,
pending/unknown qualification or activity, and an accepted proof removed by current
visibility withhold the result. The service never promotes a later proof merely
because an earlier accepted proof was suppressed. Explicitly ineligible evidence
and known observed-only work do not enter the accepted-only rule. No remaining
qualifying proof means unknown, not a certified zero.

## Public reads and invalidation

The ordinary read is:

```text
GET /api/v1/contributors/:actorId/participation-history
```

It accepts the existing canonical profile source scope, actor filter, snapshot
pin and category context. It rejects metric, search, cursor, limit and format
parameters. The result repeats the normal public metadata, exact scope,
`actorId` and `profileCategory`, plus the closed `history` object.

An unknown result has a controlled reason and null basis, key, proof and newcomer
assessment. A known result exposes only the admitted public scope, origin,
cutoff, required source pairs, policy descriptions, original minimized first
proof, observation clock and period assessment. It excludes decision IDs,
dataset hashes, raw input bytes, backfill identifiers, source-binding receipts,
unresolved identities and private review or authorization records.

The known result's SHA256 `historyKey` binds the complete bounded private history,
selected immutable input, requested actor, full profile lens, category and current
controls. Even a history-only backfill or changed private admission changes the
key. Harmless input ordering changes can also invalidate it conservatively. This
hash is an opaque identity key; possession never grants access.

First-proof inspection uses the exact returned key and contribution ID:

```text
GET /api/v1/contributors/:actorId/participation-history/:historyKey/evidence/:contributionId
```

This route performs the same fresh paired authorized read. It returns the current
known result only if both key and first-proof ID still match; otherwise it returns
`409 participation_history_changed_refetch`. An unavailable or revoked selected
publication follows the existing public read error, and a suppressed current
actor remains unavailable. An old key never substitutes a newly valid first proof.
This makes earlier evidence outside the selected repository/role/category actually
inspectable without misrepresenting its private history as an ordinary published
snapshot in that selection. Both routes use `no-store`; a conditional ETag request
rechecks source authority before returning 304.

## Bounds and browser behavior

The private read has a conservative 8,000,000-byte JSON budget, maximum depth 32,
250,000 visited values and 20,000 entries per array. Non-JSON values, cycles,
accessors, inherited object prototypes and hidden/symbol fields are rejected
before hashing or projection. Arrays must use the ordinary `Array.prototype`;
dense frozen arrays remain valid. Inherited traversal hooks cannot hide supplied
unresolved records from the later history checks. Existing publication actor,
proof and metric limits still apply. The basis has at most 500 unique source pairs and 98 policies,
with bounded unique role/source sets. The final complete public response,
including ordinary metadata, is limited to 1,500,000 UTF-8 bytes; the strict client
enforces the same limit. Opaque artifact IDs keep the existing transport-sized
domain, with the complete response bound applied separately. No list is truncated
to manufacture complete history.

The capability uses the existing service timeout, cancellation and concurrent-read
budget. A timed-out provider that ignores cancellation occupies its slot until it
actually settles. Known first proofs and API hashes are not retained in browser
storage, exported into cards or inserted into rankings.

The contributor profile renders a separately labelled organization-history section.
It preserves the full selected lens and parent snapshot/revision/definition/
computation/controls pins. The client checks the closed response, matching
registered policies, full source/role membership, exact proof clocks and derived
period Boolean before display. It rejects additional private fields or a proof
substituted under a retained action.

A visible section rechecks every 30 seconds and on visibility changes. Hiding the
page or changing its bindings clears retained history and cancels requests. A
same-key history refresh preserves an open proof and its keyboard focus. A new key,
denial or source failure retires the old details; if focus was inside the retired
proof, it moves to the history heading or visible error. The first-proof action
has keyboard focus, an expanded-state announcement, Escape/return controls and a
fresh request; a closed or superseded request cannot reopen old proof details.
This child behavior does not change the parent profile's existing revalidation
lifetime or promise focus preservation across a parent remount.

## Executable evidence and remaining delivery

The shared [synthetic provider fixture](../tests/fixtures/participation-history.mjs)
models protected admission in memory. Its source IDs, origin, policies, hashes,
actors and receipts are explicitly synthetic. Actual service tests cover the
absent capability, complete/incomplete history, cross-scope first proof, identity,
privacy, current controls, exact clocks, policy availability, authority changing
across an await, invalidation and bounds. Strict-client tests use these real
handlers. React rendering tests verify the actual TSX presentation; service-backed
Playwright cases cover proof inspection, navigation, keyboard behavior, stale
responses, privacy, narrow layout and automated accessibility checks.

These tests establish executable protocol and rendering behavior. They do not
supply a real reviewed origin, independent source acceptance, production history
admission, native assistive-technology acceptance or operational deployment.
Connecting an actual protected producer and its reviewed complete universe remains
explicit work. The selected-summary and metric-engine history paths remain intact;
this bounded implementation alone does not close the complete #98 or #124 package.
