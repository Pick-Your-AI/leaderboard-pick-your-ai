# Recognition backend and sharing boundaries

Refs #69, #70, #123, #124, #128. These engineering implementations do not close evidence review, accessible journey, production source or launch gates.

## Editorial selection (#69)

`POST /controls/spotlights` accepts `{claimId, consent:true}` from the authenticated claim owner only. The existing evidence claim must already be independently accepted. `POST /controls/spotlights/:id` accepts `{version,action,reason,publicExplanation,conflict}`; acceptance/rejection requires an independent reviewer, and withdrawal requires the contributor. Acceptance requires a separate `publicExplanation`; `reason` remains a private audit note. Neither is generated or attributed as a contributor quotation. Session, CSRF, origin, body and role protections are shared with existing controls APIs.

`GET /controls/spotlights/queue` returns private nominations only to their owner or a reviewer.

`GET /controls/spotlights` requires a current synchronous `spotlightEligibility` source-authority callback configured on the controls server; it defaults to denying all publication. Only an exact `true` permits an item, and promises are rejected as false. The callback must check current evidence visibility, allowed source scope and policy, including revocation. This source check is additional to accepted receipt review. The endpoint anonymously projects current accepted nominations under `reviewed-opt-in/v1`, with source links and explicit editorial labels. Opt-in profile text appears only while the profile remains public. Current suppression, evidence withdrawal, amendment or collaborator-consent changes remove the spotlight. Immutable nomination history is retained privately; current public reads are `no-store` and never affect computed rankings. Selection rotates categories in round-robin order, with oldest accepted selection first within each category; ties use stable nomination identity. This is ordering within the current response, not a promised timed publication schedule.

Remaining acceptance: reviewer adoption of selection rules; a real verified evidence and opt-in nomination exercise; newcomer/behind-the-scenes nomination taxonomy and selection governance; reviewer/nomination frontend and accessible journey. No testimony or endorsement is generated.

## Reproducible candidate achievements (#70, #124)

`GET /api/v1/contributors/:actorId/achievements` requires the explicit service setting `approvedAchievementRuleVersion: "accepted-evidence/v1"`. Without that reviewed activation it fails closed. Two rules return the earliest accepted eligible contribution and earliest accepted review in the selected snapshot/scope. Dates are proven source occurrence dates, never manufactured acceptance timestamps. Each result includes rule version, qualifying artifact/contribution IDs, source URLs and coauthor status. Observed, pending, unknown, automated, ineligible and undated activity cannot receive awards.

Incomplete history withholds both candidate awards: every coverage partition must be complete, permission/error/page gaps absent, and its window and watermark must cover the selected period through its end (or the snapshot date). All-history queries additionally require a known history start covered by each partition. All-history queries still mean available evidence history, not a complete lifetime or a first-ever claim. Filtered periods retain exact scope and coverage metadata. Current suppression, artifact correction and policy disabling are reapplied even when a snapshot is pinned; awards are recomputed from the visible accepted evidence. There are no streaks, scores, notifications or implied personal merit from automation.

Remaining acceptance: approved rule policy; cross-workstream mapping/conditions and shared-credit display policy; real independently reviewed examples; frontend badge display and accessible journeys. Registry metric semantics and all 98 planned definitions remain unchanged.

## Cards and embedding (#123)

`GET /api/v1/cards/:actorId?metric=<id>` returns semantic HTML for one published metric, with period, exact scope, coverage, metric policy, source links, snapshot date and a pinned visible portfolio link. Add `snapshot=<id>` for an explicitly archived card. An unpinned card says to refresh to check for changes; neither mode claims live data. Missing/suppressed contributors or dependent aggregates yield no card. All text and links are escaped, output has no scripts or external assets, caching is disabled, and external framing is denied (`frame-ancestors 'self'` and `SAMEORIGIN`). Current privacy checks happen before conditional responses.

Remaining acceptance: approved external embedding origins/cache policy if external embeds are desired, accessible browser/assistive-technology review, and actual production readback. Downloaded or copied content cannot be remotely withdrawn; served reads enforce current controls.

## Account backend (#128)

Authenticated `GET /controls/profile` returns only `{public,bio,highlights,suppressed}` for the session's actor. The OAuth server's `loginSuccessPath` may be `/controls/session` (default) or `/account`; arbitrary return URLs are rejected. Hosting must serve the protected account client at the latter path when configured. This does not configure hosting or deployment.

## Evidence

Synthetic controls HTTP tests exercise consent, CSRF, independent selection, durable state and withdrawal. Pure editorial tests cover revocation, stale versions, self/collaborator conflicts, private profile text and suppression. Service tests exercise dated cards, HTML escaping, current suppression on pinned reads, disabled-by-default achievements and exclusion of non-accepted evidence. Synthetic fixtures are never production recognition.
