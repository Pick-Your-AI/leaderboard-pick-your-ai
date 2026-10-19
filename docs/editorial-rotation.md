# Reviewed editorial dimensions

This implements a bounded part of [issue #69](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/69).
The existing category-only `reviewed-opt-in/v1` selection and `accepted-organization-history/v1` history
contracts remain unchanged. No computed score, frozen leaderboard contract, source-provider admission,
participant permission, or operational publication is created by this feature.

## Owner and reviewer workflow

An owner with an already accepted, currently eligible spotlight may open **Editorial dimension consent**
in their account and separately propose one or more dimensions. The nomination's existing consent remains
independent. A reviewer must review the exact current proposal, declare independence, and supply a public
explanation. Owners and claim collaborators cannot accept their own classification.

An **editorial workstream** is an explicitly proposed and independently reviewed description of the linked
contribution. It is not a T0–T6 identifier, repository membership, a mapped program workstream, or a GitHub
Project assignment. Up to four labels are admitted, each at most 100 UTF-16 code units. Leading and trailing
whitespace is trimmed explicitly; interior spelling and distinct UTF-8 sequences are retained. Control
characters, lone UTF-16 surrogates, empty labels and exact duplicates are rejected. Valid supplementary
characters, U+FFFD and composed/decomposed spellings remain distinct admitted text. There is no default
taxonomy or inferred label.
Behind-the-scenes is a separate explicit choice with the same review requirements.

An owner can also consent to a **dated history assessment** for one finite half-open period `[start, end)`.
Both bounds are canonical UTC timestamps ending `.000Z`, with a positive duration of at most 366 days and
an end that has already passed. These are the existing public reader's supported bounds, not a definition
of when someone joined. No default period, cohort denominator, newcomer identity, first-ever contribution,
or current status is inferred. Every displayed result includes the exact requested dates.

Amending a declaration increments its revision and removes its accepted classification until another
independent review. The private history retains the exact prior proposal fields, digest and decision events.
Withdrawing this separate consent always remains available to its owner, including when the original
nomination, claim or source is no longer eligible or nonterminal amendment capacity has been reached.
Withdrawal does not silently withdraw the original category-only nomination.

## Private persistence and routes

The additive `editorial-dimensions/v1` sidecar is `state.spotlightRotations`. The unchanged Controls SQLite
store serializes it within its synchronous whole-document transaction with `publish: false`. No new
migration, cache format, public metric revision, ranking publication or network call inside the transaction
is introduced. Existing authentication, role refresh, CSRF and final persisted-session checks apply.

| Route                                    | Meaning                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /controls/spotlight-rotation`      | Owner proposes or amends exact declarations with separate consent and expected version.         |
| `GET /controls/spotlight-rotation/queue` | Authenticated owner or reviewer reads the private current proposal, event count and last event. |
| `POST /controls/spotlight-rotation/:id`  | Current independent reviewer accepts/rejects, or owner withdraws.                               |
| `GET /controls/spotlight-rotation`       | Public minimized, current eligible classified candidates.                                       |

Neither query parameters nor body fields can supply a `historyKey`, history receipt or asserted newcomer
status. The public response omits private reasons, reviewer identities and the private audit history. It
includes the exact nomination/claim versions, classification version/revision/digest, reviewed declarations
and public explanations. The digest is an integrity identity of a declaration, not an authorization token.
Every public read reuses the original nomination projector's current consent, intake and source gate.

The private reviewer panel displays the declaration's bound nomination version, claim ID/version and digest
beside its dimensions and period. A matching current eligible nomination supplies the safely linked
contribution, category, original selection explanation and timestamp. If that exact current context becomes
unavailable or changes, review is disabled while owner withdrawal remains available. The panel does not
invent a historical source URL from a current claim.
An optional context that fails this view's safe-link or metadata checks becomes unavailable for that record;
it does not discard the consent record or hide withdrawal, including for v1 locators with query strings or
unsupported fragments. Other valid records remain usable and the public link policy stays unchanged.

The private sidecar retains at most 256 records. At most 32 current eligible classifications may be admitted,
of which at most eight may request history. Each record permits 64 nonterminal events and a final withdrawal.
The public response is at most 256 KiB; the minimized private queue is at most 2 MB. Invalid or over-capacity
state fails visibly rather than presenting a silently truncated prefix. Rejected and withdrawn records retain
their private audit history; this implementation supplies no audit-deletion or retention policy.

## Mounted public reader

On the supported current, unfiltered organization overview, **Explore editorial dimensions** opens the new
view. The category-only view and its request remain the default; **Return to category-only spotlights**
restores it. Filtered or historical views do not substitute organization-wide editorial classifications.

For every admitted history request, the reader first fetches the contributor's actual profile for that exact
finite organization period. It validates the profile and actor before deriving the snapshot, revision,
generation time and three version pins. It then calls the existing participation-history route with that
snapshot and passes the independently verified profile to the existing strict history reader. Parent pins
are never constructed from the history response or borrowed from the all-time homepage. The service's
existing `source.readParticipationHistory` capability, source validation and protected admission remain
responsible for accepted history. The stock provider has no such capability and produces an explicit unknown.

At most two candidate chains run concurrently, with at most eight profile/history chains and sixteen source
requests. They share a cancelable ten-second budget; initial and final Controls reads each have an eight-second
budget. The existing transport additionally bounds each response to 2 MB. A timed-out batch loses all prior
positive assessments from that attempt. No partial positive prefix is represented as a complete batch.

After **all** source awaits, the reader obtains a fresh Controls projection. A history result is reusable only
when the nomination, actor, claim/version, classification version/revision/digest, exact declarations and exact
period still match. All displayed content comes from this final response, including changed bio, rationale,
evidence URL and selection timestamp. Withdrawn candidates disappear; new or amended candidates have unknown
history until a subsequent complete attempt. Cancellation, hidden-page refresh and changed view inputs retire
old attempts. This final recheck does not claim an atomic transaction across Controls and the source service.

Known history is described only as the first qualifying accepted contribution in reviewed organization history
falling inside or outside the displayed period. Unavailable, unbounded, incomplete or cutoff-short history
does not establish newcomer status. The details list retains unknown assessments even when no qualifying
history lane can be built. Different owner-selected periods remain separate dated editorial assessments.

Editorial workstream lanes use locale-independent UTF-8 name ordering, followed by behind-the-scenes and
qualifying dated-history lanes. Each lane orders by original selection instant and exact nomination ID.
Round-robin selection uses one global emitted-ID set, so multi-lane entries cannot appear twice or starve
later entries. Previous/next controls move only on reader input; the thirty-second data refresh does not
automatically advance the active nomination. The first displayed nomination is bound before any manual
click and remains selected if an earlier lane arrives; only removal permits a fallback. The view clears
retired positives during refresh and restores
keyboard focus to its heading when a removed control otherwise loses focus.

## Reproducible validation and remaining acceptance

Use the repository's pinned dependencies and build the workspace packages before the web tests:

```sh
node --test-reporter=tap apps/controls/test/editorial-rotation.test.mjs
node --test-reporter=tap apps/controls/test/editorial-rotation-http.test.mjs
node --test-reporter=tap apps/web/test/editorial-rotation.test.mjs
npm run typecheck --workspace @pick-your-ai/web
npm run test:browser -- apps/web/browser/editorial-rotation.spec.ts
```

The new backend cases exercise independent review, current eligibility, immutable proposal history, caps,
amendment and unconditional owner withdrawal. The actual loopback HTTP cases exercise authentication/CSRF,
role and expected-version failures, SQLite close/reopen persistence and unchanged public metric state. Their
sessions and evidence are synthetic; they do not claim a real OAuth login or source approval.

The client cases exercise the actual profile/history service producer, exact parent pinning, bounded concurrency,
late replies, final-projection changes, deterministic deduplication and explicit unknown recovery. The mounted
browser cases use the real built React view, actual pure Controls transitions and the actual service over
synthetic admitted fixtures; they cover explicit entry, manual keyboard rotation, dated/unknown disclosure,
withdrawal during a delayed history response, refresh recovery, initial-card retention when an earlier lane
arrives, narrow layouts and automated accessibility. A mounted account/admin journey also checks separate
unchecked consent, exact proposal and independent-review payloads, visible bound contribution context,
stale-version input retention, malformed private labels and owner withdrawal after eligibility is lost.
They do not replace the separate actual Controls HTTP acceptance tests or an affected participant's review.

Source and test presence alone are not execution. Record each original command, source identity and outcome
when qualifying a particular commit. Normal repository planning, formatting, type and hosted runtime/browser
gates still apply. Production provider/admission readiness, real classification and participant acceptance,
operational scheduling, and applicable [#60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60)
and [#55](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/55) gates remain separately scoped.
This bounded implementation does not close all of #69 by itself.
