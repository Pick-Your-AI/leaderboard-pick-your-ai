# Private reviewer policy comparison

Refs [#122](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/122)
and [#115](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/115).
The administration screen now connects reviewers to the existing
[frozen-policy comparison service](private-policy-comparison.md).

## Reviewer journey

An authenticated reviewer explicitly loads the retained input list, chooses a
snapshot revision and supplies a complete candidate policy for a metric present in
that input. The service selects the approved baseline from its retained record;
the browser cannot supply baseline facts, authorization, scope or approval. The
panel displays baseline and candidate versions, coverage, values, rank differences
and inclusion/exclusion causes in pages of 25 changed contributors. Unknown values
and unavailable ranks remain explicit. Rank differences describe recalculation on
the same frozen input, not live contributor progress.

A saved comparison can be reread against the selected input. Every request uses
the same-origin controls client, current server authorization and privacy checks.
The candidate write carries the existing CSRF token; reads send no CSRF token.
The client verifies snapshot, input/scope hashes, baseline metric/version/hash,
candidate semantics and the service's preview-only status before rendering a
result. It rejects an unexpected snapshot or candidate, stale input, unsupported
schema or an alleged public activation result.

The panel is available only on `/admin` for the reviewer role. An operator role
alone does not grant access. Hidden tabs, session expiry, selected-input expiry,
account changes and unmounts discard private state. Editing the input or candidate
invalidates an in-flight result. A server-side authority denial clears the parent
account state as well. Private policies, receipts and source evidence are never
written to browser storage, URL parameters, clipboard or public APIs.

The panel retains the service's eight-input and 2,000-contributor bounds, enforces
an 8 KiB candidate editor limit, and uses a bounded response reader. Absent host
configuration or expired inputs produce an explicit unavailable state without
blocking the rest of administration or substituting synthetic data.

## Verification and remaining acceptance

The client regression suite uses the real private SQLite comparison store and
metric engine. Browser scenarios bridge to the real authenticated controls HTTP
server and test before/after calculation, renewed privacy redaction, operator-only
denial, reviewer revocation, hidden-tab invalidation and edited-candidate races.
All fixtures are synthetic and confined to the test boundary.

This UI provides private recalculation and saved-result review. It has no policy
approval, activation, release or rollback action. Designated policy approval,
published release notes, reversible deployed rollout and the operational drill
remain separate issue criteria. These implementation and test paths do not claim
real-source permission, real reviewer acceptance, deployment or full issue closure.

## Calculation evidence audit

The confirmed private preview includes a separate audit inspector for the baseline and candidate calculations, even when their contributor totals are unchanged. It displays all of the engine's retained audit entries, including positive inclusion entries, grouping, conflicting-input, unconfirmed-acceptance, correction/exclusion and other calculation conditions. These entries support human review and do not establish intent, label a contributor as abusive, change eligibility or authorize a penalty. Existing published aggregation and correction rules remain authoritative.

Reviewers can select the policy side and one recorded condition, page through 25 entries at a time, and inspect one entry's exact fact identities in pages of 25. The list identifies visible audit entries and the fact IDs attached to each entry, not complete source-event counts. A null actor remains unknown. An empty or privacy-redacted list is not evidence of complete history or absence of a problem.

The client validates both audit arrays before displaying a result: exact entry fields, nullable actor identity, nonempty unique fact IDs, bounded condition codes, at most 10,000 entries and 10,000 attached identities per policy side. Unknown valid condition codes receive a neutral explanation without an inferred classification. The endpoint's existing frozen-input, policy, source authority, session, expiry and current-redaction checks remain in force. The browser does not restore audit state from storage; changing inputs, losing authority, hiding the tab, expiry or a refreshed result clears the old view. A new current privacy projection resets audit selection and expanded details.

Synthetic tests use the actual captured input, metric engine and protected controls service. They cover repeated units, conflicting revisions, corrections, missing independent acceptance, unresolved actors, unchanged-policy inspection, pagination, privacy removal and malformed audit payloads. This is the protected audit inspection slice of LB-11.05; it does not provide a deployed moderation operation, new source anomaly classifier or whole-issue acceptance.
