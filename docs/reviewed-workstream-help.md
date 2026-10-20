# Reviewed cross-workstream help, version 1

Refs [LB-10.05 / #70](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/70) and [LB-15.05 / #124](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/124).

This adapter defines one positive, explicitly reviewed relationship: an accepted authored merge helped workstream B through work undertaken for workstream A. It displays the original contribution and an immutable public statement that identifies both workstreams. The rule is unranked and makes no first-ever, newcomer, tenure, complete collaboration-history or effort claim.

The engineering rule version is `reviewed-cross-workstream-help/v1`. It is independent of the existing `accepted-evidence/v1` and `accepted-evidence/v2` milestone protocols. Their routes, proofs, conditions and response shapes remain unchanged. Their shared-authorship and author/reviewer pairs remain the existing shared-credit presentation.

## Authority and source admission

The current protected host configuration must supply the optional `workstreamHelp` extension on an existing independently reviewed recognition binding. A public request, a GitHub sender, a Project association, a digest, an immutable URL or an approval-shaped field cannot supply that authority.

The host is responsible for establishing all of these facts before installing a record:

1. The organization and versioned workstream catalog are the intended approved definitions. The two distinct IDs and their public labels are explicitly reviewed identities. They are not inferred from repository names, metric categories, current Project membership, a selected filter, assignments or a shared artifact.
2. A currently consented evidence request has an authorized independent accepted review for the original source contribution. Its exact current request ID, request version and accepted decision ID are pinned separately in `sourceAcceptance`. The source request owner, public locator, category, policy and scope must match the help request and binding. A later help review cannot silently replace this original acceptance.
3. The help request has its own exact current request/version/decision binding and reviewed author role. The reviewer must be in the protected binding's reviewer set and must be neither the owner nor a collaborator. The current private audit must contain exactly the accepted decision; the existing intake, collaborator-consent and source-use checks still apply. The source and help requests may be the same current reviewed request.
4. The reviewer actually verified that the authored merge helped the stated destination through work for the stated origin. The pinned statement is the exact public-safe factual record of that determination. Its source-use reference must appear in the help request's current accepted source-use review. A structurally valid statement does not establish this factual review.
5. The host obtained and checked the exact public statement bytes from the authorized repository at the recorded full Git revision. The file is in the same repository as the qualifying PR. The host verifies public disclosure/source-use permission and current source authority for both the statement and contribution. This adapter validates supplied protected bytes; it is not a new GitHub crawler or an automatic source-permission verifier.

The adapter supports existing occurrence-clock recognition destinations `maintenance`, `automation`, `documentation` and `tests`, with source metric `pr_merged` and original role `author`. Every existing destination policy, domain proof and source qualification remains required. This relationship cannot supply a missing maintenance, automation, documentation or test acceptance.

The source must be one uniquely matched, public, original observed GitHub PR merge for the exact actor, artifact and repository. Original branch qualification, occurrence/observation clocks, source revision and public source metadata must match. Synthetic-marked facts, unknown or conflicting identity, bots/service accounts, positively automated execution, non-author roles and unsupported destination metrics cannot receive help recognition. Unknown execution remains unknown; eligibility does not certify manual work.

## Statement bytes and immutable identity

The closed statement schema is `cross-workstream-help-statement/v1`. It contains:

| Field group | Meaning |
| --- | --- |
| organization, definitionVersion | Reviewed workstream catalog authority |
| from, to | Two distinct explicit IDs with public labels |
| actorId, repositoryId, artifactId | Exact original contributor and PR identity |
| sourceUrl, sourceRevision | Exact public PR URL and observed contribution revision |
| occurredAt | Original merged-source occurrence |
| role, helpKind | Literal author and authored_merged_change |

Use `encodeWorkstreamHelpStatement` from the contracts package to produce the canonical JSON field order followed by exactly one LF. The protected record supplies those exact UTF-8 bytes, their SHA-256, a full lowercase 40- or 64-hex Git revision, and the exact `https://github.com/<owner>/<repo>/blob/<revision>/<file>` URL. No query, fragment, mutable branch or encoded path substitution is admitted. The parser rejects duplicate JSON keys, unknown fields, alternative whitespace and noncanonical bytes.

The statement's Git revision is **separate from** the contribution's observed source revision. The normalizer may use an opaque observed revision such as a collection revision; it must match the qualifying proof exactly. It is not relabeled as a commit SHA.

The statement body does not contain its own eventual Git revision. Create the canonical factual body, commit it, then record the immutable file revision, URL and byte hash in the protected review binding. This avoids a self-referential commit requirement. The body identifies the contribution it describes; the outer binding identifies the statement bytes.

The public output exposes the canonical statement, statement revision/URL/hash, qualifying contribution ID and separate acceptance/review times. It never contains private request IDs, decision IDs, reviewer identity, consent records, private rationale, source-acceptance pins or the configuration's observation limit.

## Two acceptances, one selected source unit

The private record format names the current help review with `requestId`, `requestVersion`, `decisionId` and the exact original observed `factId`. Its `sourceAcceptance` object separately names the current source request/version/decision. The complete binding also includes the workstream catalog, statement proof and `validUntil` observation bound. See the closed [contract](../packages/contracts/src/workstream-help.ts) and the fictional [fixture](../tests/fixtures/workstream-help.mjs) for the exact structure. Fixture receipts are not live authorizations.

The ordinary recognition materializer keeps its existing canonical metric receipt and accepted-time order. A later help review can bind to that already retained contribution. It does not replace the original receipt, change its acceptance time, add another metric unit or reorder existing credit.

Every eligible help alias is checked before a metric deduplication shortcut. Conflicting statements, workstream identities, immutable bytes or original acceptance pins fail closed. The final help collection joins only the exact retained source receipt, public source identity, actor, role, revision and clock. If the approved original receipt is no longer the selected accepted proof, no relationship is substituted.

This version yields at most one directed help relationship per organization, actor, repository and PR artifact. Repeated request aliases, source representations and metric categories cannot multiply it. Several asserted destinations for that same unit require an explicit future rule; they are not silently combined. An actor's label never joins identities, and known provider node/database aliases cannot impersonate a second public account.

## Dates, scope and current withdrawal

| Clock or identity | Use |
| --- | --- |
| occurredAt | Original PR merge event; determines inclusive-start/exclusive-end period membership |
| observedAt | Actual source collection bound; must not exceed the selected cutoff |
| source acceptedAt | Exact retained original acceptance receipt; must not precede the source event |
| help reviewedAt | Current help review; must not precede the original acceptance or exceed the cutoff |
| statement revision | Immutable public statement identity; never substituted for an event clock |
| validUntil | Upper bound for the configured review's observation cutoff |

Date comparisons retain source precision. Public labels show source occurrence, original acceptance and help review separately. A positive reviewed event can be displayed with partial historical coverage because it makes no earliest/complete-history claim. An empty result means no qualifying recorded help is available in that selection.

The observation limit is not a wall-clock revocation scheduler. The host must revoke or replace current configuration/review authority when factual review, consent, source authorization or publication permission changes.

Both source and help decisions participate in the existing current recognition fingerprint, exact configuration authority and persisted publication/read fences. Changed, missing, withdrawn or superseded source approval cannot be resurrected through a later still-accepted help request. A withdrawn help request also removes the relationship. Current actor/artifact/contribution suppression, disabled metrics, source revocation and revoked snapshot controls apply to pinned reads and store replay.

The runtime selects help from the actual corrected and scoped portfolio facts. An attribution, role, source revision, source clock, eligibility or original acceptance correction withholds the old relationship until a matching current review is supplied. The service independently requires the visible accepted proof, consistent copies on every evidence route, exact accepted metadata and a recomputed canonical statement digest. It returns a bounded unavailable result for conflicting provider evidence.

## Public endpoint and accessible presentation

The host must separately select `approvedWorkstreamHelpRuleVersion: "reviewed-cross-workstream-help/v1"` in protected service/pipeline configuration. Installing code does not activate the policy. The endpoint is:

`GET /api/v1/contributors/:actorId/workstream-help`

It uses the existing exact public snapshot, organization/repository/workstream/date/context/role scope, account filter and optional metric category. Source projection applies those contribution filters; none of them supplies evidence of the reviewed workstream relationship. An absent approved rule or absent reviewed collection is unavailable, rather than a measured zero.

Each response contains the rule version, selection caveat, original qualifying proof and immutable statement link. It is separate from timeline, sharing-card and milestone cursors. Signed pages bind the actor, full scope, snapshot, category, account filter, page size, current controls and a digest of the actual current recognition set. A corrected source or relationship invalidates continuation even if a provider fails to change its controls version.

The protected input is bounded to 1,000 records and eight million aggregate JSON bytes before cloning, schema parsing, hashing or a receipt callback. A canonical statement is at most 8,192 UTF-8 bytes. Public pages hold 1–100 events, with a one-megabyte item budget and a 1.5-megabyte response budget; the UI requests 20. Accessors, proxies, cycles, sparse arrays and contradictory immutable statement hashes are rejected at the protected extension boundary. Escaped string/key bytes are counted incrementally without allocating their JSON representation, and property counts are checked before obtaining property descriptors. The same bounded admission precedes the public provider projection.

The profile section names both workstreams and provides the exact contribution, statement and public artifact links. Proof navigation retains the displayed snapshot and selected scope. Keyboard page navigation focuses the resulting heading or error; ordinary refresh retains focused proof links. Selection changes, invalid responses, hidden state and revocation clear stale results, and obsolete asynchronous replies cannot restore them. Layout wraps long public text without introducing new notification or streak behavior.

## Verification and remaining acceptance

The proposed contract, pipeline, service/client and browser fixtures exercise canonical bytes, malformed/private fields, immutable identity, ambiguous aliases, earlier source acceptance with a later help review, independent withdrawal of either review, current suppression, corrections, disabled/automated exclusions, precise periods, cursor invalidation, legacy v1/v2 compatibility, proof navigation, keyboard focus and automated accessibility bounds.

The pipeline fixture traverses the real normalizer, current review materializer, persisted publication and HTTP source. Its withdrawal case reopens both the SQL database and SQLite controls store before re-reading the old pin and recomputing. These are explicit fictional finite inputs; they establish no real participant, live source permission, factual help approval or production rollout.

Before delivery, run repository formatting, build/typecheck, the relevant contract/pipeline/service suites and the hosted real-service Playwright cases. Source review and parser checks are not execution receipts. Actual approved source inputs, production activation and contributor/assistive-technology acceptance remain separate operational inputs.

The aggregate metrics `first_contribution`, `collaborations` and `active_periods` retain their actual definition-only capability. Newcomer origin/history, editorial spotlight consent, complete collaborator graphs and other roles remain governed by their existing independent protocols. This delivery supplies the explicit authored-help adapter; it does not claim all acceptance criteria of #70/#124 are complete.
