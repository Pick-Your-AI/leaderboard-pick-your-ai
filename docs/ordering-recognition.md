# Reviewed ordering receipts: COV-16

The `ordering-review/v1` profile supplies a bounded, independently reviewed
manual-ordering plan to the existing `issue_ordering` metric. It does not enable
the definition-only metric, grant GitHub permissions, infer an ordering actor
from a list snapshot, or assert that any real receipt has been reviewed.

This is the ordering portion of [LB-08.03](DELIVERY_PLAN.md) and COV-16 in
[#87](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/87) and
[#60](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/60).
Project-configuration COV-14, public stewardship COV-17, native relationship
collection, Project access and transfer inference retain their own contracts
and owners. There are still 98 metric definitions.

## Protected review and current consent

A contributor submits the existing `evidence-intake/v1` request in category
`ordering`. The submitter explicitly selects the role `ordering_contributor`;
all listed collaborators must independently consent to their current roles and
the exact claim. The authenticated independent reviewer supplies `ordering`
alongside the existing public-source, source-use, conflict and policy checks at
`POST /controls/requests/:id/review`. It is required for a new ordering
acceptance and forbidden on another category or a non-accept decision.

The closed descriptor records:

| Field                                 | Interpretation                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `version`                             | Exactly `ordering-review/v1`                                                   |
| `requestId`, `claimDigest`, `actorId` | Exact current protected request, intake claim and submitter                    |
| `contributorRole`, `method`           | Exactly `ordering_contributor` and `manual`                                    |
| `scope`                               | Exact repository ID/slug and parent or Project ID/URL                          |
| `source`                              | One current public plan fact, artifact, locator and opaque collection revision |
| `aliases`                             | Unique reviewed plan aliases, including the source artifact                    |
| `before`, `after`                     | Two immutable public GitHub file references and their ordered item IDs         |

Each snapshot reference uses its exact 40- or 64-character lowercase commit
revision in a `github.com/<repository>/blob/<revision>/<path>` URL, with no query,
fragment, percent encoding or alternate repository. Both exact locator/revision
pairs must also occur exactly once in the independent source-use review. The
reviewer attests that the files actually show this same manual plan, scope,
contributor and before/after order. The parser does not fetch these files and
does not convert well-formed URLs into independent verification of their
contents or rights. That responsibility remains with the authenticated reviewer.

There must be 2–100 unique item IDs in each list, the same membership in both
lists, and a genuine order difference. Added or removed membership, reparenting,
priority edits, automatic view sorting and a final order equal to the starting
order are outside this profile. In particular, a net away-and-back drag is not
another accepted ordering change. An author or actor cannot be inferred from
the ordering arrays themselves.

The stored accepted event and its private audit twin retain the parsed,
detached descriptor. The adapter requires the exact current request ID, version,
decision, policy and independent reviewer. Existing consent validation binds
the participant roles; the source-use audit's `reviewedInputDigest` additionally
binds private detail, roles and source-use basis, which `claimDigest` alone does
not cover. Amendments, withdrawal, changed terms or consent, profile suppression,
and missing or stale reviews do not retain current recognition.

The same eligibility predicate protects the generic public claim projection.
A legacy accepted `ordering` record without this typed descriptor remains
unqualified; reading old state does not synthesize consent or a new review.
No private item arrays, review references, role attestations or internal claim
IDs are added to public proof or export fields.

## Host-enrolled source scope

The separately approved recognition binding must contain:

```json
{
  "orderingAuthority": {
    "version": "ordering-source-authority/v1",
    "scopes": [
      {
        "kind": "subissues",
        "repositoryId": "2",
        "repositorySlug": "example-org/example-repo",
        "id": "FICTIONAL_PARENT_ID",
        "url": "https://github.com/example-org/example-repo/issues/20"
      }
    ]
  }
}
```

This example is fictional configuration, not a grant or deployment input.
`project_items` instead uses a canonical `github.com/orgs/<owner>/projects/<n>`
or `github.com/users/<owner>/projects/<n>` URL and the exact enrolled Project ID.
Enrollment must match every scope field; an arbitrary `request.scope` label,
current item order, source-review boolean or Project-looking URL is insufficient.
Duplicate scope identities and absent enrollment are rejected.

This host enrollment authorizes interpretation of the reviewed receipt only.
It grants no Project API access and does not prove current Project membership
or public visibility. Removing an enrollment changes the configuration and
recognition authority, so existing current and pinned results are withheld.
If the Project is not separately collected, the host cannot claim instantaneous
detection of a Project privacy change. Actual Project collection still requires
its existing independent source and permission gates.

The selected original plan must be a unique observed fact with one matching
public proof and one known visible human actor. Its repository, artifact,
source revision, actor, original author/reporter/commenter role, canonical event,
metric and occurrence must agree. Synthetic, hidden, automated, already accepted,
ambiguous or undated plan sources are rejected. A later review cannot precede
the known plan-source time. The metric continues to use `accepted_at`; no
unobserved physical drag timestamp is manufactured.

## One plan, stable counting

The canonical unit is contributor, repository, scope kind/ID and the public
plan artifact. Ten children in that plan yield one unit. Request IDs, review
IDs, later review times, source/proof revisions, alias order and caller-supplied
`changesetId` values do not mint additional units.

A separate descriptor identity preserves the actual ordered arrays. Repeated
valid receipts for that same plan collapse only after validation. Opposite or
otherwise conflicting before/after descriptions, or aliases bridging distinct
canonical plans, fail the entire ordering admission. The adapter validates all
current ordering plans before invoking any ordering receipt callback; neither
request insertion order nor an earlier duplicate can hide a later conflict.
The asynchronous normalizer's receipt batch applies the same plan check.
It retains the earliest valid acceptance for each plan, breaking equal-instant
ties by receipt ID, without reordering unrelated receipts. A missing slot in a
sparse receipt batch fails the same validation as an explicit invalid receipt.

This bounded contract cannot discover an undisclosed relationship between two
different public plan artifacts. Reviewers must provide known aliases and
review whether the underlying work is one plan. It does not infer an exhaustive
drag history from missing observations. Raw source activity stays intact, and
reparenting/priority facets do not create additional ordering units. The proof
continues to reference its original artifact, preserving existing aggregate
artifact deduplication rather than defining a new overall productivity score.

## Bounds, versioning and verification

The profile permits at most 32 distinct plan aliases, 100 source-scope
enrollments and 100 ordered items. Opaque item/plan/scope IDs are exact strings
up to 2,048 code units; request/actor/fact IDs have a 200-unit bound and opaque
source revisions a 512-unit bound. No trimming or ID rewriting occurs. The
parsed descriptor is at most 48,000 UTF-8 bytes; the protected HTTP route also
retains its existing stricter 16,384-byte whole-request limit. A large valid
in-memory record is not a promise that an oversized HTTP envelope is admitted.
These are new profile limits, not changes to existing public artifact IDs.

Only configurations with an `issue_ordering` destination add the
`reviewed-ordering-plan/v1` fingerprint marker, including configurations with
no current requests. This retires saved generic ordering publications. Other
destinations retain their preceding exact fingerprint bytes. The standard
current-control and source-authorization fences continue to protect boards,
contributors, proofs, exports and pinned reads until a fresh authorized run.

The shared parser lives in the already-present `@pick-your-ai/github` workspace.
The controls host adds only that internal dependency; no new external package,
startup listener, source fetch, secret or migration is introduced. Source and
receipt inputs are detached before asynchronous acceptance boundaries while
the opaque native issue-history batch token retains its original identity.

The regression suites use fictional source and consent providers. They cover
strict descriptor bounds, all three authorities (current claim, reviewed proof,
host scope), conserved units, conflicting aliases, asynchronous mutation,
protected HTTP rejection/acceptance/participant consent/withdrawal, and the
actual protected-HTTP-to-pipeline/public-proof/export path. Successful fixtures
do not establish real reviews, installed source access, live metric accuracy
or whole-issue completion. Executed source and any environment failures belong
in the PR's validation record; tests are not silently skipped for unavailable
local sockets.
