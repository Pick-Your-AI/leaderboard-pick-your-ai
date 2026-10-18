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
