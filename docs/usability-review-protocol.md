# Usability and accessibility review protocol

Preparation for [LB-13.05 / #71](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/71).

**Status: proposed session packet; no participant results recorded.** This document
turns the adopted [product journeys](product-journeys.md) into a facilitator packet
and a blank receiving record. It supplies neither participant recruitment nor a
completed review. The journey decision remains the authority for tasks, timing,
denominators and success targets. The [prototype record](ui-prototype.md) and
[visual-system acceptance guide](visual-system-acceptance.md) retain their actual
implementation and accessibility evidence limits.

The packet changes no metric, ranking rule, source permission, public service,
design specification or issue acceptance state. A source review of this packet is
preparation evidence. Actual representative-user feedback, accepted design changes
and named remediation owners are still required for #71.

## 1. Prepare an actual session

Before inviting or contacting anyone, obtain the applicable session authorization,
an accountable facilitator and the participant's agreement to the necessary test
evidence. This packet assigns none of those roles. Follow the existing
[evidence and contributor-rights policy](evidence-contributor-rights.md); keep raw identities,
private contribution content and unnecessary recordings out of this repository.
Use a session-local attempt identifier in the report. A participant may stop or
decline recording; record the resulting scope and incomplete attempt accurately.

Select a fixed build and declared test environment before administering a task.
The environment owner must confirm which modules actually work, whether a fixture
is synthetic, and whether any real source or correction destination is authorized.
Do not send a participant to an upstream write flow merely to complete a study.
The leaderboard's read paths must not change upstream issues, assignees, labels,
relationships or Project fields.

| Preparation field | Fill with actual session information |
| --- | --- |
| Protocol and scenario version | This document's commit and the consumed J1–J5 decision revision; any separately reviewed scenario change |
| Session authority and facilitator | Actual agreement/reference and accountable facilitator, or **unfilled** |
| Participant evidence agreement | Minimal consented evidence and retention/access policy; do not put a participant name here |
| Tested source and artifact | Complete source commit, actual build/artifact identity, deployment/test URL and environment owner |
| Input authority | Labeled fixture/version or authorized public snapshot/source receipt; never a guessed live dataset |
| Selected scope | Program/Project/repository, metric/category, role/actor filters, half-open UTC interval, publication and policy identities |
| Capability inventory | Enabled, unavailable or out-of-scope modules, with their actual receiving basis |
| Platform and input | OS/browser/device, viewport/zoom/font settings, keyboard/touch and actual assistive technology where used |
| Task allocation | Audience, scenario, new-task variant and declared limit for every assigned attempt |
| Recording and cleanup | Allowed evidence, access/retention location and actual cleanup responsibility; **unfilled** until agreed |

Do not start a timed attempt until the declared environment is ready and the task
has been given. Subsequent loading or connection failures stay in the result; they
do not disappear from the denominator. Record the actual tested version again if
the environment changes. A repaired build or different scenario is a new versioned
attempt, with the earlier outcome retained.

### Required audience and role coverage

J1–J5 are separate audience evaluations. Include the coding, research and triage
contributor roles required by #71 across the declared participant/task plan, as
well as the five scenarios below. Do not substitute a coding-only sample for the
other roles, or merge audience denominators to conceal a failed audience. Record
only the role information needed to explain the task's representativeness.

| Journey / #71 scenario | Role and task selection | Adopted limit |
| --- | --- | --- |
| J1 — Anonymous visitor | An unfamiliar eligible non-code contribution, including research or triage evidence and a contributor outside a ranked podium | Three minutes |
| J2 — Newcomer | An interest-matched public issue with actual owner/prerequisite/acceptance information, without claiming ownership through the leaderboard | Five minutes |
| J3 — Non-code or regular contributor | Work across two evidenced roles, with accepted and pending portions and an anonymously readable portfolio link | Three minutes |
| J4 — Maintainer | An incorrect or disputed claim, the actual supported correction destination and its durable receipt | Five minutes for submission and receipt; no promised review-decision deadline |
| J5 — Display host | A declared wall scope, pause and explicit update, then a declared stale/disconnected state | Three minutes with the fixture's declared synthetic clock |

Use at least five independent task attempts **for each audience**. At least four
of five must finish unaided within that journey's limit with the required correct
interpretation. Larger samples require at least 80%. These are the already adopted
design targets, not observed results or a statistical population claim. Use a new
task for a repeated participant; do not count a rehearsed answer as an independent
first attempt. Report actual participation and repeated-attempt relationships
without publishing participant identities.

Desktop keyboard, small-screen touch and supported assistive-technology paths need
their own observed accessibility evidence. Record each actual combination. A mouse
session, automated semantic assertion or generated screenshot cannot establish
keyboard traversal, screen-reader behavior or physical-device usability.

## 2. Bind the task fixtures before the session

Use the complete fixture requirements and deterministic assertions in
[J1–J5](product-journeys.md#j1--visitor-discovers-a-contribution-and-checks-its-evidence).
The following allocation makes their critical distinctions easy to track; it does
not reduce the adopted checks or fabricate new contributor observations.

| Fixture distinction | Required task coverage and expected interpretation |
| --- | --- |
| Accepted versus observed work | J1/J3: distinct original source, actor and role; a pending item is not an accepted outcome |
| Activity volume versus qualification | J1/J3: explain the actual metric and acceptance evidence; more events, lines or comments do not establish merit, effort or an accepted result |
| A real zero versus unavailable data | J1/J3: use a declared known-zero value and a separate unavailable value, with the displayed coverage and evidence reasons |
| Shared ranks and continuation | J1/J5: tied rows and a tie crossing a page boundary; inspect displayed rank, current-page ordering and continuation without redefining the API order |
| Partial history and missing comparison | J1/J3/J5: distinguish the selected coverage window from an all-history claim; no invented movement from incomparable evidence |
| Multi-Project membership | J1/J2: preserve Project context without counting one canonical contribution twice or treating membership as earned credit |
| Missing owner and open prerequisite | J2: identify the current agreement path; unassigned is not automatically available, and a completed child does not complete its parent |
| Current withdrawal or correction | J3/J4/J5: hidden evidence stays hidden through enabled links/exports/cards/retained views; no attempt to recover private content |
| Correction receipt and authority | J4: distinguish a received request from an accepted decision, and an unauthorized requester from the actual decision role |
| Pause, update, stale state and recovery | J5: declared snapshot/clock, no mixed cycle or automatic reading-position changes, and current privacy still applies while paused |

The facilitator's answer key must be derived from the exact fixture or authorized
snapshot and its actual source/policy receipts. Write the expected actor/role,
public source, acceptance basis and missing-evidence explanation for each task
before the attempt; keep the key out of the participant's prompt. Use only the
minimum consented source detail needed for assessment. An answer key is not a new
source-admission or acceptance authority.

For the literal requirement to locate **their contribution**, distinguish an
attempt on the participant's own eligible public contribution from a synthetic
actor rehearsal. A rehearsal may establish deterministic navigation coverage but
does not satisfy that participant-specific observation. If real-source access or
eligible work is unavailable, record the gap rather than inventing a contribution
or asking the participant to publish private information.

J4 requires an actual supported correction path in the declared environment.
Exercise it only under its own authority. If unavailable, mark the capability and
attempt unavailable/not evaluated as appropriate, preserving the assigned-attempt
denominator; a decorative contact link is not a durable correction receipt. A
conditional module that is not enabled remains explicitly outside its enabled
capability claim. J5's short synthetic-clock task cannot replace an independently
required-duration wall soak or operational acceptance.

## 3. Conduct neutral tasks and comprehension checks

Give the selected journey's task without demonstrating the route or explaining the
answer. Explain how the participant may stop and that the session assesses the
interface, not their worth or work output. Clarify only the task's wording before
timing. Do not prime participants with the intended acceptance/coverage distinction
or turn a walkthrough into an unaided attempt.

During the unaided phase, observe without directing clicks or correcting an
interpretation. Record requests for help and any help actually supplied, with its
time. If help is necessary, retain the original unaided outcome and continue only
as an explicitly assisted diagnostic phase. Do not restart the original clock or
turn an assisted completion into an unaided pass.

Use the following neutral prompts to check understanding after navigation. They
are observation questions, not suggested answers. A prompt asking for the task's
required explanation is part of the task; new route guidance or teaching counts
as assistance.

| Journey | Neutral comprehension prompts |
| --- | --- |
| J1 | “What does this contribution represent?” “Which source supports that interpretation?” “What can this view tell you, and what cannot it tell you?” |
| J2 | “What would your next useful action be?” “What must happen before that task can be completed?” “Where would you check who is responsible?” |
| J3 | “How would you explain these two roles and totals to another reader?” “What would the copied link show them?” “How do you interpret each of these two value states?” |
| J4 | “What was received, and where is that recorded?” “Has the correction been accepted?” “What changed publicly, and what is still awaiting a decision?” |
| J5 | “Which scope and publication are on screen?” “What happens while this is paused?” “What would you tell viewers about this freshness state?” |

Stop the timer only when the navigation and required explanation are complete, or
record that the attempt ended without completion. Compare the explanation with
the predeclared key. Reaching a page, copying a URL or clicking the original source
does not by itself demonstrate understanding. Preserve the actual sequence if a
participant first gives an incorrect explanation and later changes it; record
whether assistance caused the change.

### Accessibility and visual observations

Use [visual-system acceptance](visual-system-acceptance.md) and the actual design
specification as the review basis. For each observed barrier record the relevant
component/state, platform/input path and impact on the assigned task. Include
dense-row and mobile-card readability; focus visibility/order; names and state
announcements; ties, samples and coverage wording; value-state distinctions; and
pause/update behavior where the scenario reaches them. Record only paths actually
exercised, with “not exercised” for the rest.

Do not infer color contrast measurements, screen-reader speech, font/zoom behavior
or reduced-motion behavior from a static screenshot or a separate test on another
build. Attach the precise manual or automated observation to its own artifact.
Record automation as supporting evidence, separately from participant feedback.

## 4. Record every attempt without replacing missing results

Copy this blank record into the agreed evidence destination. **No row below is an
execution result.** Keep all assigned attempts, including unsuccessful, assisted,
interrupted and unavailable ones. Explain any exclusion using the criteria declared
before the session; do not remove an inconvenient result to improve a score.

| Attempt field | Actual observation to record |
| --- | --- |
| Session-local attempt ID | Opaque ID and relevant audience/role; no public participant identity |
| Task and version | Journey, task variant, first/repeated task relationship and fixed source/artifact/fixture |
| Input path | Actual device/browser, viewport/zoom/font, keyboard/touch/assistive technology |
| Start/end/elapsed | Actual UTC times and elapsed time, including post-start loading or connection failures |
| Navigation result | Original source/own contribution/receipt reached, or exact failed/unavailable step |
| Interpretation | Necessary consented paraphrase and the answer-key comparison; unresolved ambiguity retained |
| Assistance | None, requested or supplied; actual timing/type and whether a later completion was assisted |
| Outcome | Correct unaided within limit, correct but assisted/over limit, incorrect, incomplete, interrupted or unavailable; keep the original observation |
| Accessibility/visual finding | Component/state and task impact, evidence reference, or no finding observed on this exact path |
| Retest link | Original attempt and changed build/scenario, when a separately recorded retest actually occurs |

For each audience, report **correct unaided attempts within limit / all assigned
attempts**, plus every failure and assistance outcome. A zero denominator is
**not evaluated**, never 100%. Keep deterministic fixture coverage and empirical
audience completion as separate measures. Check the existing 100% deterministic
discovery coverage across eligible fixture contributors and the 11 planned
categories without inventing observations for unavailable categories.

An unresolved false attribution, acceptance, coverage, freshness or privacy result
blocks the affected capability regardless of a favorable average completion score.
The public-claim correctness target remains zero unresolved correctness failures.
An independent reviewer must assess the actual outcomes; a filled template or
passing aggregate alone does not establish #71 completion.

## 5. Turn feedback into owned, reviewed changes

Record findings against the current accepted specification and its responsible
source owner. Do not edit another active design lane or replace an implementation
owner through this packet. Distinguish a comprehension or accessibility defect,
a suggested preference and an unsupported capability; retain disagreements until
the actual receiving review resolves them.

| Finding field | Required disposition |
| --- | --- |
| Finding and original evidence | Concrete observed behavior, affected task/platform and exact receipt |
| Impact and current status | Actual barrier or incorrect interpretation; unresolved, under review or resolved with evidence |
| Remediation owner | Actual accepted accountable owner/acknowledgment, or **unassigned**; proposed role alone is insufficient |
| Accepted change | Reviewed design-specification or source change, exact version and affected-owner receipt |
| Retest | Actual changed artifact, task, result and any remaining limitation; no automatic carry from an earlier build |
| Final receiving decision | Actual reviewer, scope and evidence-backed disposition, preserving the original finding |

The #71 criterion requires explicit owners for outstanding accessibility issues.
An unassigned finding remains an unresolved ownership gap; this packet cannot fill
it by naming an absent person. A resolved finding needs a concrete changed source
or accepted disposition and applicable retest evidence. Preserve original failures,
including any still-open barrier after a partial fix.

## 6. Literal #71 receiving checklist

These are the exact five task and three acceptance texts read from #71. The packet
identifies the future evidence needed; **none is marked complete here**.

| Literal task or criterion | Required actual receiving evidence |
| --- | --- |
| Review with coding, research and triage contributor roles | Actual representative-role task coverage, independent attempts and reviewed observations |
| Test understanding of volume versus qualified outcomes | Source-bound interpretation records and assistance/failure outcomes, not raw event or click counts |
| Check dense table readability, ties and coverage wording | Actual dense/mobile/input-path observations and the corresponding feedback/dispositions |
| Record feedback and revise the accepted design specification | Retained feedback, reviewed revisions or explicit accepted dispositions, and affected-owner acceptance |
| Include newcomer, non-code contributor, maintainer, anonymous visitor and display-host scenarios in usability validation | Separate actual J1–J5 audience/task records, denominators, limits and capability gaps |
| Users can identify why a contribution counted and what is missing | Correct unaided source/acceptance/coverage explanations tied to the actual task and artifact |
| Outstanding accessibility issues have explicit remediation owners | Each actual unresolved issue has an accepted accountable owner; unfilled assignments remain gaps |
| Participants can locate their contribution and public source and explain true zero versus unavailable data and observed versus accepted work | Actual participant-specific discovery and source follow-through plus the separate value/acceptance interpretations; synthetic rehearsal alone is insufficient |

Before proposing completion, refresh #71, its native prerequisite #61 and the
accepted design/implementation versions. Reconcile every row with actual receiving
records, preserving unrelated issue text, owners, fields and relationships. Do not
infer the completion of dependent #107/#111/#117 or connected-source, privacy,
device, operational or release gates from this document's publication.

The remaining session decisions are concrete: agree the facilitator and authorized
environment; confirm representative participants and necessary evidence handling;
bind the task fixtures/builds and enabled capability set; conduct and review the
attempts; obtain actual remediation ownership; deliver and retest the accepted
changes. Until those observations and decisions exist, #71's empirical outcome
remains pending.
