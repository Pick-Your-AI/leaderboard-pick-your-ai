# Accepted evidence milestones, version 2

Refs [LB-10.05 / #70](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/70) and [LB-15.05 / #124](https://github.com/Pick-Your-AI/leaderboard-pick-your-ai/issues/124). This is the `accepted-evidence/v2` engineering decision under the project owner's delegated policy authority. Independent review and merge record acceptance of these conditions. Actual source authorization and runtime activation remain separate receipts; this document does not supply them.

The decision extends the [recognition policy](metric-recognition-policy.md) with category milestones and public links between qualifying participants on the same artifact. It implements the existing work-package scope. The 98 metric definitions, aggregate adapters and planned UI metric mappings do not change.

## Version and activation

`GET /api/v1/contributors/:actorId/achievements` retains its existing route. A host must explicitly select `approvedAchievementRuleVersion: "accepted-evidence/v2"` to receive this version. An absent or unsupported policy remains unavailable. The repository does not silently activate an installed or public service.

| Explicit policy | Award rules | Category selection | Shared-artifact pages |
| --- | --- | --- | --- |
| `accepted-evidence/v1` | Existing earliest accepted contribution and review | Unsupported, as before | Not supplied |
| `accepted-evidence/v2` | Existing two rules plus earliest accepted evidence per registered measure | Exact selected category on both award and peer proofs | Bounded signed-cursor pages |

The v1 source function and response fields remain compatible. The public client accepts either version. When a category is selected, it requests that category explicitly; a v1 service returns unavailable and the client never substitutes an unfiltered award. Cards retain their existing independent single-metric protocol.

## Milestone conditions and dates

Every eligible proof must already be public, accepted, qualified as eligible, attached to a resolved public user account, and have a contract-valid source occurrence time and at least one current enabled metric category. Roles must be explicit. Unknown roles, automation roles, positively automated execution, bot/service/unknown account kinds, undated evidence and nonaccepted activity receive no award. Unknown execution is retained as unknown; eligibility does not establish manual work.

All declared snapshot source partitions must have complete enclosing coverage, no missing pages, permissions or source errors, and a watermark through the selected exclusive end or the snapshot cutoff. An unbounded selection also requires each partition's known history start to be covered. For a bounded selection, the snapshot's own cutoff must reach its exclusive end. These conditions establish the available evidence boundary; the source provider remains responsible for including every required approved source partition and establishing its claims.

The two retained rules select the earliest qualifying contribution and the earliest qualifying proof with an explicit reviewer role. The new rule selects the earliest qualifying proof containing each registered metric ID, or only the exact requested category. “Category” means a metric registry entry, not a department, team or inferred workstream. A single proof may qualify for several category milestones; it does not become several delivered artifacts.

Ordering compares source instants at their original precision, including equivalent offsets and sub-millisecond fractions. Equal instants use ascending stable contribution ID. Responses preserve the selected proof's original timestamp text. Periods include their start and exclude their end. No observation, collection, publication or later acceptance timestamp is manufactured from that source occurrence.

Each milestone carries its fixed rule ID/label, rule version, category ID where applicable, source date, scope caveat, coauthor flag and one original qualifying proof. The legacy evidence/artifact/URL arrays must bind that same proof exactly. “First” always means earliest available accepted evidence in this selected snapshot and scope. It does not establish first-ever contribution, an organization joining date, newcomer status or tenure.

## Shared-artifact participant conditions

This projection displays recorded accepted work; it is unranked and does not require complete historical coverage. Partial history may therefore show qualifying public pairs while withholding every first-event milestone. An empty pair list says no qualifying links are available in the projected evidence, not that no collaboration occurred.

| Relationship | Required original roles | Display meaning |
| --- | --- | --- |
| `shared_authorship` | Both distinct accounts have author or coauthor proof | Accepted shared authorship on this artifact |
| `author_review_pair` | One has author/coauthor proof and the other has reviewer proof | Accepted author and reviewer evidence on this artifact |

Both sides must satisfy the same public, accepted, eligible, dated account/proof conditions. Both must be inside the selected scope, role filter and optional category. Reviewer–reviewer pairs, mere mentions, assignments, account membership, automation and coincident triage/reporting do not establish either relationship. The service does not infer a participant or estimate their share of effort.

The artifact's stable ID, kind, repository ID and safe public URL must all match exactly. Unknown artifact kinds are not paired. A response contains at most one pair per artifact and peer account. Repeated metric representations and repeated roles cannot increase that number. With both forms available, shared authorship takes precedence; otherwise the first qualifying original author/reviewer proof for each side is used. The implementation retains those two original proofs rather than combining roles from several records into invented evidence. Pairs sort by artifact ID, then peer account ID.

Actor IDs are already resolved by the public source projection. The v2 preflight also rejects different visible actors sharing a known provider node/database ID; names are display text, never an identity join. It cannot establish an unprovided cross-ID identity mapping. Within visible accepted evidence, conflicting kind/repository/URL bindings for one artifact or conflicting source instants for one canonical event/actor/artifact fail closed. A retained pending copy with the same contribution ID as an accepted award also fails closed because the proof route would otherwise show a contradictory state.

## Current controls, bounded pages and client validation

The service operates on the current public projection, including source/policy filtering, actor and artifact suppression, disabled categories, revoked snapshots and the selected account lens. A historical pin does not freeze permissions or public eligibility. Corrections recompute both awards and pairs. A selected disabled category is explicitly unavailable. Private receipt/nomination fields and withheld identities do not appear in the extension.

The [closed response schemas](../packages/contracts/src/v1/achievements.ts) bind original proof IDs, accepted state, roles, category membership, precise date and exact artifact identity. All known category IDs come from the compatible registry; these schemas do not authenticate a source claim. The [client](../apps/web/src/remote/achievement-milestones-client.ts) additionally binds each proof to the requested actor/category, current disabled categories, exact public scope and snapshot cutoff. Unknown extra fields inside awards, proofs or peers, malformed links/cursors, duplicate awards/pairs and inconsistent identities are rejected before rendering.

The endpoint accepts 1–100 pairs per page; the UI requests 20. Each page is bounded by the existing 20,000-input evidence budget, a one-megabyte pair budget and a 1.5-megabyte total response budget. At most 98 category milestones plus the two retained rules are returned. Page cursors bind the actor, snapshot, scope, category, account filter, page size, current controls version and a digest of the actual current awards/pairs. A source correction or changed display alias cannot silently continue an earlier page even if the source provider failed to change its controls version. The client offers an explicit restart after an unavailable page. Cursors retain the existing signature and expiry checks.

Contributor, peer and proof links retain the displayed snapshot and public repository/workstream/date scope. Peer profiles also retain the category selection. Direct proof links identify the exact contribution; its current evidence view is independently revalidated. Achievement pagination never borrows the contributor timeline cursor. Page navigation moves keyboard focus to the resulting shared-artifact heading or error message; ordinary same-selection refresh does not move a focused source link. Changed selection, failed validation, revocation and hidden state clear prior recognition, and obsolete asynchronous replies cannot restore it.

## Acceptance and remaining scope

The synthetic service/client suite covers v1 compatibility, category isolation, canonical deduplication, precise ordering/cutoffs, incomplete coverage, current privacy and withdrawal, disabled/automated exclusions, signed paging, correction invalidation, conflicting proof identities and strict malformed-response rejection. The real-service browser cases cover category proof navigation, twenty-item paging, keyboard focus, automated accessibility/bounds, restart after a current correction, refresh and suppression, and an obsolete category response. Hosted pinned Playwright execution remains a required delivery gate; source compilation alone is not browser acceptance. Fixtures are fictional and never seed public recognition.

This delivery defines these milestone and shared-credit rules rather than leaving their engineering choices unassigned. It does not claim the following remaining work:

- Cross-workstream help requires a versioned, explicitly sourced workstream-to-artifact relationship and qualifying contribution conditions. No such relationship is inferred from categories, repository names or the selected filter.
- Newcomer eligibility requires a separately defined organization-origin and complete historical-evidence protocol; it remains unavailable through the existing participation API when history is insufficient. A first-in-scope milestone cannot substitute for that protocol.
- Public use requires actual approved source inputs and activation, independently reviewed real examples, and contributor/accessibility acceptance of the intended production journey. An editorial spotlight additionally keeps its existing nomination, consent, independent review and current source-authority checks.

The aggregate registry entries `first_contribution`, `collaborations` and `active_periods` retain their actual `definition_only` status and empty supported computation combinations. These source-linked detail projections do not supply those aggregate implementations, a complete collaborator graph, a universal score, follower ranking, daily streak or activity-pressure notification. Issues #70 and #124 therefore retain their genuinely unfinished work after this bounded delivery.
