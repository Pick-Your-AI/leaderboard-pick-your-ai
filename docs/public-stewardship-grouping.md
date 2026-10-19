# Public stewardship day grouping

`public-stewardship-day/v1` supplies the explicit grouping policy for the existing
`public_moderation` definition. The [canonical registry](../packages/metrics/src/v1/registry.json)
defines descriptive actor/item/day groups. Its 98 definitions, definition policy
version, raw item triage policy and label/milestone day policies remain unchanged.

This implements the bounded grouping work in
[#79](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/79).
The [normalizer](../packages/github/src/normalizers.ts) already admits explicitly
verified public pin, unpin, lock and unlock observations. It retains their raw
event identities, actors, occurrence times and action facets. This profile adds
no source adapter, permissions, private moderation history or default activation.

## Daily units and raw history

The [metric engine](../packages/metrics/src/engine.ts) uses this group key:

`(metric ID, repository ID, actor ID, stable item ID, UTC day)`

The day is `floor(selected timestamp in milliseconds / 86,400,000)`, anchored at
`1970-01-01T00:00:00Z`. Each window has an inclusive start and exclusive end.
This is a UTC calendar day; a rolling 24-hour period or ingestion date cannot
replace it. The existing normalizer and engine retain their canonical UTC clock
contract with at most millisecond precision. Unsupported source representations
remain unknown or are rejected, without silently truncating their precision.

The group consumes the normalizer's existing stable item identity unchanged.
For ordinary issue resources that is the supplied node ID, otherwise an opaque
string ID or `github:issue:<numeric ID>`. The repository component of the group
keeps equal fallback IDs in different repositories separate. This policy does not
infer aliases between opaque IDs and numeric representations or between display
names. Source adapters remain responsible for a consistent proven target identity.

| Eligible evidence in one selected lens | Descriptive groups |
| --- | ---: |
| One actor pins, unpins, locks and unlocks one item on one UTC day | 1 |
| The same actor toggles that item repeatedly on the same UTC day | 1 |
| The same actor acts on that item on two UTC days | 2 |
| Two actors act on one item on the same UTC day | 2, attributed separately |
| One actor acts on two items on the same UTC day | 2 |
| A known item author accompanies an event with no proven acting actor | No attributed group |

Canonical event deduplication and reviewed correction selection run before day
grouping. Within a day the engine retains the earliest eligible occurrence, then
stable fact ID. Other contributing observations remain in the immutable input and
the private `repeated_policy_unit` audit. Replaying an exact duplicate or reordering
input does not add a group. Raw portfolio facts can still show the distinct source
transitions; that event history and the daily group count have different units.

A pin followed by an unpin is still an observed stewardship day. Neither the
toggle nor its persistence proves correctness, effort, a justified sanction or
successful moderation. Grouping supplies no quality score, negative credit or
offender label. The metric's existing `descriptive-only` rule rejects `rank: true`.

Knownness remains explicit. A missing actor, stable target or selected date cannot
borrow an item author, title, current pin owner, current lock state or collection
timestamp. Missing or ambiguous qualification keeps coverage incomplete. Empty
partial history cannot certify a measured zero. Repository and actor suppression,
allowed-scope filters and reviewed corrections retain the existing engine gates.

## Separate receipt clocks

The strict profile permits exactly these evidence/clock pairs:

| Evidence class | Date basis | Meaning |
| --- | --- | --- |
| `observed` | `occurredAt` | Admitted source action on its proven source day |
| `qualified` | `occurredAt` | Independently accepted same-metric evidence on its proven source day |
| `qualified` | `acceptedAt` | Independently accepted evidence in a separately labeled acceptance-day lens |

The existing receipt adapter can independently qualify a fact already admitted
as `public_moderation`. This change does not add that metric to the adapter's
cross-metric receipt allowlist. A label application, arbitrary claim or unsupported
action therefore cannot acquire stewardship qualification merely by naming it.

The adapter retains its verified-receipt, authorized independent reviewer, actor,
target, evidence-reference and acceptance-time checks. These are trusted host
inputs: the host must authenticate the actual review and enforce consent,
sanitization and current authority. A Boolean or reference string supplied to the
pure adapter is not independent proof of approval. Neither this profile nor a
source event creates an editorial acceptance or bypasses the controls intake.

Source occurrence and receipt acceptance times remain distinct. A later receipt
never fills missing source time: only the separately selected acceptance-day lens
can use its actual acceptance date. A source event and confirming receipt do not
add two units within one selected lens. Observed and qualified totals must not be
summed, and the engine rejects a policy that combines the evidence classes.

## Privacy, compatibility and remaining gates

Public projections keep the existing bounded action metadata. Restricted lock
reasons, reports, sanctions and private payload fields do not become evidence
descriptions. Internal audits can include suppressed actor or fact identities;
they require authorized access and are not public API responses.

Comment-pin and Discussion-action source identity require their own proven
capability. Current `pinnedBy`, `pinnedAt` or lock state does not prove who performed
an earlier transition. This grouping change supplies no unsupported-action receipt
workflow, administrative permission, installed-source canary or reconstructed
pre-install/deleted history. Those source and review gates remain in
[#41](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/41),
[#60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60) and #79.

Callers must select the exact grouping version, triager role, 86,400-second
interval and evidence/clock pair. Old generic canonical or actor/artifact policies
are rejected instead of being silently reinterpreted as daily groups. Adoption
requires the existing explicit policy-version and replay/release boundary. The
raw source identity and historical fingerprint algorithms are unchanged.

The UI entry remains `definition_only`, with no supported combinations or default,
and all public-enable flags remain false. This implementation alone does not
activate a selectable view or satisfy the entire work package.

The [synthetic source-to-engine cases](../packages/metrics/test/public-stewardship-days.test.js)
cover facets and repeat toggles, UTC boundaries, independent identity namespaces,
unknowns, receipt clocks, suppression, private-field exclusion and reviewed
corrections. They preserve raw observations and test the existing independent
receipt boundary; they are not real source, consent or operational evidence.

Build the contracts, metrics and GitHub workspaces before running that file.
The adjacent definition-day and raw-triage suites verify their unchanged profiles.
