# Public API epic acceptance

Scope: [LB-12, issue #13](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/13).
The five native work packages have reviewed automated implementation receipts.
This review verifies their combined public API outcome and corrects actor and
proof privacy ambiguities before the epic is reconciled as completed.

## Accepted work-package outcomes

| Package | Accepted behavior | Retained evidence |
| --- | --- | --- |
| [#99: Public query API](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/99) | Anonymous approved boards, all 98 definitions, exact scope/snapshot metadata, bounded cursor pages and resource limits. | `apps/service/test/read-api.test.mjs` covers current/pinned pages, malformed queries, privacy, deadlines and noncooperative providers. |
| [#105: Contributor and evidence APIs](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/105) | Same-snapshot profile totals, roles, paginated timelines and minimized proof with current visibility controls. | Read-API cases cover board/profile reconciliation, private and suppressed proof, unlinked/deleted actors and more than 100 equal-time records. |
| [#106: Live transport](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/106) | Revision-bound snapshot/reset notices, complete refetch, bounded reconnect, conditional polling and honest freshness. | Read-API, `live-health-race.test.mjs` and `live-response-bounds.test.mjs` cover pause/resume, stale responses, cancellation, parsing bounds and fallback. |
| [#92: Source health](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/92) | Frozen coverage and current repository collection diagnostics remain distinct, with unknown lag retained and operational detail removed. | Read-API health cases cover stale/degraded states, changed authorization, malformed scopes/clocks, duplicate diagnostics and unchanged frozen coverage. |
| [#110: Exports](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/110) | JSON/CSV preserve selected values, scope, definitions and provenance under the same privacy controls. Additional portfolio formats remain explicitly disabled. | `exports.test.mjs`, `csv-export-boundary.test.mjs` and pending-count cases cover formulas, escaping, size limits, current controls and snapshot equality. |

The source boundary is `PublicSnapshotSource` and the shared `projectRead`
projection. A configured provider must supply approved materialized snapshots and
current controls atomically. The API does not turn raw ingestion documents into
public data or infer source approval from a URL. All children retain their native
relationships, original acceptance criteria and separately qualified receipts.

## Privacy ambiguities found during combined review

The previous projection checked duplicate actor IDs only after privacy filtering.
A provider could return a public/resolved actor and another representation of the
same ID marked hidden, deleted, unlinked or unresolved. Filtering removed the
non-public representation, leaving the public copy eligible for publication.

Primary evidence had the same ordering problem: a schema-valid private, unknown,
deleted or unavailable copy of a contribution could be discarded before duplicate
contribution IDs were checked, leaving its public counterpart readable.

Uniqueness is now checked against the full bounded provider actor list and primary
evidence collection first. Duplicate IDs produce the existing generic `503 public_projection_unavailable`
response with `Cache-Control: no-store`. The API does not select a preferred copy,
reuse an earlier conditional response or disclose conflicting identity metadata.
An ordinary unique hidden actor or private proof still removes only the affected
actor/aggregate and dependent evidence; unrelated contributors remain available.
Matching proof in separate primary and portfolio collections remains valid, since
each collection has its own purpose and its own uniqueness boundary. Visibility
must also agree across all supplied primary, portfolio and pending proof for the
same contribution or known artifact identity. Actor node/database-ID canonicalization
and account linking retain their separate #36 scope.

### Initial correction receipts at `503ca9a0`

Nine synthetic regressions in `apps/service/test/public-actor-ambiguity.test.mjs`
exercise both ordering directions for all non-public actor and identity states,
current and historical conditional reads, all shared query/profile/proof/export/
health/notice boundaries, and the unique-hidden-actor control. On the unchanged
accepted source, eight cases failed at the intended ambiguity assertions and the
control passed. With the correction, all nine pass with no skipped cases.
Update notices intentionally use current scope only; the test does not invent a
historical SSE protocol.

Seven additional synthetic cases in `apps/service/test/public-evidence-ambiguity.test.mjs`
cover all four non-public artifact dispositions in both input orders, pinned
conditional proof/board/export denial, unique-private-proof suppression and
legitimate primary/portfolio overlap. Before the evidence correction, five cases
failed at the intended visibility assertions and both controls passed. All sixteen
actor and evidence cases pass together after the two corrections, with no skips.

### Cross-collection and artifact visibility correction

Independent follow-up review reproduced eight contradictory same-contribution
copies across the portfolio/pending collections and three same-artifact copies
with different contribution IDs at `503ca9a0`. A pinned proof request still
returned its previous `304` after a private portfolio copy appeared. The initial
sixteen regressions above passed at that source and did not cover these cases.

The shared projection now checks visibility consistency for every supplied
collection before returning a result. Contribution IDs have a separate identity
map from known artifact IDs. Both an artifact's stable ID and a contribution's
non-null artifact reference participate; omitted/null artifact identities are
not grouped together or resolved from names. A conflict produces the same generic
`503` and `no-store` response before any conditional response can be reused.

`apps/service/test/public-evidence-visibility.test.mjs` covers all four non-public
dispositions, both encounter directions, cross-collection contribution copies,
different contributions to one artifact, either surviving artifact identity,
current/pinned conditional routes, matching public/private copies and distinct
unidentified private proof. These are synthetic regression inputs. Their actual
execution and final receiving disposition are recorded in the delivery PR;
the pre-outage reproduction and initial sixteen-case receipts remain historical.

## Verification and acceptance boundary

The combined review starts from accepted main
[`00d9278a58701560ade3332c175668c7214ff1f5`](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/commit/00d9278a58701560ade3332c175668c7214ff1f5).
The full workspace build and all 153 pre-existing actual service tests passed
before this correction. The focused failing-before/passing-after receipt above
uses those same compiled packages. Final current-source review and hosted gates
are recorded in the delivery PR before normal protected merge; prior results are
not attributed to a changed receiving tree.

This epic's accepted outcome is the composed automated API contract. It does not
certify an installed GitHub App, real contribution history, contributor consent,
screen-reader or physical-device use, elapsed-time soak, approved infrastructure
or public deployment. Those remain the relevant source, UI and release packages'
own evidence requirements. No source is enabled and no upstream contribution
state is mutated by this acceptance record.
