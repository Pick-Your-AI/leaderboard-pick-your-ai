# Release phases and evaluation targets

Decision version: **release-gates/v1**. Scope: [LB-01.06](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/28).

Review and merge adopt this project's release policy under the project owner's
delegated engineering authority. The policy defines what a later receiving
review must establish. It does not assert that a phase has passed. Live issues,
native relationships, accepted evidence and the selected release manifest carry
that subsequent state.

The [release manifest](../planning/release-manifest.json) is the source for the
phase evidence and proposed numeric targets rendered in the
[operations plan](OPERATIONS_PLAN.md). The [decision register](GOVERNANCE.md)
retains unresolved alternatives, required decision roles and the packages they
block. The adopted [metric policy](metric-recognition-policy.md) and
[contributor-rights policy](evidence-contributor-rights.md) apply at every phase.

## Phase decisions

Keep concept publication, synthetic evaluation, public-data shadow collection,
public beta, production launch and full project acceptance distinct. Each phase
must retain the exact source/build identity, declared environment and source
scope, required evidence, unresolved findings and attributable receiving review.
An earlier phase's successful receipt cannot certify a later environment or
newly enabled capability.

Synthetic fixtures may validate mechanics before an actual host or collector is
selected. Shadow collection additionally requires the approved source IDs,
permissions, source-use conditions and history boundaries; its results are not
public rankings. Beta additionally requires working public journeys, current
privacy controls, an enabled-capability manifest and accepted operations.
Production requires the staged release evidence and actual deployed readback.

The manifest's mandatory package and first-product-journey lists remain in force.
Conditional modules keep their own acceptance, privacy and security gates. Full
project acceptance requires every in-scope package complete or an explicit,
reviewed scope decision with a reason. Leaving a module disabled does not silently
remove an in-scope task.

For each transition, record a reviewed release receipt containing:

- Source commit, built artifact identity, environment, observation interval and
  exact enabled-capability/policy/definition versions.
- Links to each required package's acceptance and the actual test, source,
  participant or operational evidence appropriate to that gate.
- All failed, skipped, unavailable and unmeasured checks; the affected capability
  stays gated while a required result is unresolved.
- An attributable review against that manifest, the accepted rollback target and
  the actual receiving authority. A proposed role is not a named acceptance.

An issue or PR count, rendered page, synthetic success or green planning check
cannot substitute for this transition receipt.

## Proposed service targets

The numeric values in the manifest are **evaluation targets**, chosen for a
modest initial service. They are not measured results, a service-level agreement,
a paid capacity choice or an operator commitment. Before public beta, the
operations, product, privacy and budget roles must accept a host-specific profile
and its measurement protocol. They may accept these proposals or replace them
through a versioned, reviewed decision. A target change must retain the old
results and rationale; it cannot turn a failed measurement into a pass.

The existing durable-acknowledgement and publication-latency proposals are
retained. Proposed availability and recovery values now make the evaluation
concrete without assuming that the website's static host can run the service.
The public-target and host-capability decision remains [#25](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/25);
cost ceiling, actual host, accepted operating roster and deployment configuration
remain [#130](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/130).
Those unresolved selections are usable planning constraints, not accepted
deployment inputs.

### Freshness and acknowledgement

Measure webhook acknowledgement from receipt of a complete authenticated,
in-scope delivery at the service to acknowledgement after the durable inbox
write is confirmed. Declare the payload/traffic envelope and observation window
before the run. Report failures, timeouts and rejected valid deliveries alongside
the percentile; they cannot be removed to make latency appear successful.

Measure receive-to-publication latency for every received in-scope event that
requires a public projection, from the same complete-delivery receipt clock to an
independently observed eligible publication. Record deferred, failed and
unpublished events. A fast
percentile cannot hide an unbounded oldest pending event. Upstream event-to-receive
lag, permission gaps, reconciliation progress and selected historical-snapshot
age are separate measurements.

A successful collection poll with no new activity is still a successful source
heartbeat. Quiet activity must not become disconnection. A failed or unknown
source cannot be described as current merely because an older snapshot or the
web server is reachable. [Telemetry](OBSERVABILITY.md) and the
[wall acceptance](public-live-wall.md) retain these distinctions.

### Availability

Evaluate the proposed availability percentage over a complete rolling thirty-day
window using one declared observation slot per minute. Before measurement,
freeze the enabled critical anonymous journey routes, valid request scope and
expected contract states, including current publication identity and suppression.
A rendered application shell alone cannot satisfy a read. A slot succeeds only
when every selected route returns its correct, privacy-safe response within ten
seconds. Service failures, timeouts and planned
maintenance count as failed slots. Missing observations remain unknown and
prevent a complete-window acceptance claim; they are not removed from the
denominator or counted as success.

An accurately labeled, still-authorized stale snapshot may preserve read
availability while failing the separate freshness objective. An unavailable
placeholder, privacy leak or incorrect attribution is not an available journey.
Record user-request errors separately, with malformed or out-of-scope requests
classified explicitly, so low-volume probe success cannot conceal failures under
real traffic. Short synthetic or staging runs verify this protocol
only; they do not supply a thirty-day availability result.

The proposed percentage allows 216 failed minute slots in a thirty-day window.
The proposed four-hour recovery ceiling can therefore be met by a single incident
that still misses availability. Both objectives must be reported independently;
recovery success never erases the outage from the availability calculation.

### Recovery time and recoverable data

Measure recovery time from the first observed loss of the required service,
including detection and decision delay, through safe restoration, reconciliation
of the declared recovery scope, and independent public journey readback. Record
the observed start and any earlier onset that remains unknown. Restoring a dump,
booting a process or viewing the old page is not completion of this interval.

The proposed recovery-point objective applies to recoverable public source
observations. Freeze the actual failure cutoff and expected durable
acknowledgements; identify every acknowledged observation not recovered after
restore and reconciliation. The loss window runs from the oldest missing
acknowledgement to that cutoff. An unrecovered acknowledgement older than the
proposed twenty-four-hour bound misses the objective. Preserve original source
occurrence times separately; late source arrival does not change the recovery
clock. If the complete expected set is verified present, record zero observed
loss for that set; an incomplete expected set remains unknown.

A backup's age, watermark gap or synthetic fixture with no post-backup events
cannot prove the production objective or establish zero production loss.
Unavailable source history or unverifiable acknowledged data leaves that result
unknown. Report source lag and unreplayable gaps separately from the observed
recovery window.

Privacy, consent, correction, revocation and deletion state are not expendable
within that recovery-point allowance. Keep the restored service isolated until
the current authoritative restrictions have been recovered and reapplied across
all enabled projections and caches. If that state cannot be established, retain
suppression and withhold public serving, even when a time target is exceeded.
The [recovery implementation](RECOVERY.md) already requires current suppression
and separate source reconciliation; this decision does not relax those controls.

Choose the actual backup schedule, verified recovery points, encrypted storage,
key access, retention/deletion bounds and restore operator in the receiving
operations decision. The proposed data window does not itself select a daily
backup job or a retention duration. A tighter data-loss objective can require
additional infrastructure and must be costed before adoption.

## Roles and unresolved decisions

The register's ten existing decision boundaries remain traceable: repository and
runtime placement; source admission/history; recognition policy; evidence and
dispute authority; hosting and budget; identity and opt-out; metric enablement;
freshness; visual identity; retention and recovery. Its new phase-policy entry
binds this decision to release evaluation. Keep live GitHub Assignees and source
owners unchanged. Repository engineering authority cannot create a contributor's
consent, a source capability receipt, a human evaluation result or a future
operator's acknowledgement.

Before accepting an unresolved choice, record the chosen alternative and reason,
the exact affected scope/version, attributable authority, evidence and remaining
limits. A role may remain unfilled; that blocks the corresponding operational
transition without preventing local implementation and synthetic evaluation.
Do not publish an unaccepted response-time promise or appoint a person from an
example, review comment or existing repository permission.

## Acceptance of this decision

The reviewed artifact and generated manifest provide all four LB-01.06 tasks:
the decisions are recorded, the phases have distinct evidence, proposed targets
are explicit, and responsibilities are stated as roles. Every unresolved register
entry retains alternatives and blocking scope. The gate policy prohibits a launch
claim based solely on merged code or a rendered interface. Its acceptance leaves
hosting, source activation, empirical evaluations, installed environments and
operating/release packages open for their own evidence.
