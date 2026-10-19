# Recognition backend and sharing boundaries

Refs #68, #69, #70, #123, #124, #128. These engineering implementations do not close evidence review, accessible journey, production source or launch gates.

## Accepted issue-answer source time (#96)

An accepted `issue_answers` receipt cannot predate its selected source fact's
known occurrence. Both the direct normalizer receipt boundary and the pipeline
enforce that lower bound using contract-valid source timestamps, including
equivalent offsets and fractional precision. The pipeline checks the already
unique target before invoking host receipt authority; it never resolves an
ambiguous claim by removing future candidates. An unknown source occurrence
remains unknown. Collection time, fetched revision time and a different decision
clock do not replace it. The original occurrence and the accepted-at ranking
clock retain their separate meanings and bytes.

The `issue-answer-source-time/v1` authority marker applies only when a configured
destination is `issue_answers`. A source-only answer binding to another metric
keeps its earlier authority and source-specific rules. A mixed configuration
containing an answer destination retires the whole earlier publication, even
without a currently accepted answer request. Current and pinned public reads,
exports and proofs, private previews and aggregate explanations withhold old
authority across database reopen. Reads and startup preserve existing source
facts, snapshot content and recognition fingerprints. Only authorized
recomputation can renew a publication confirmation: unchanged, still-valid
content can retain its content-addressed snapshot ID while receiving the current
fingerprint. Changed valid content can produce a new snapshot. Contributor
withdrawal continues to remove current authorization.

These synthetic chronology and persistence checks do not establish answer
quality, voluntary support recognition, response-time samples, complete source
history or production rollout. The metric definition and maturity remain
unchanged. Native prerequisites and the other evidence-review criteria of #96
retain their existing scope.

## Confirmed bug source admission (#68)

The generic private receipt path for `confirmed_bugs` requires an
`issues_opened` source fact and exactly one issue proof identifying the same
artifact, repository and contributor. A PR, issue-closing action, missing proof
or contradictory proof cannot substitute for that report. The pipeline checks
this boundary before invoking its receipt adapter; direct normalizer callers
receive the same source check. Existing independent reviewer, current audit,
configured policy and contributor-withdrawal requirements remain in force.

An explicit `isSynthetic: true` excludes the input. When the pipeline combines
observations, its private `syntheticFactIds` provenance excludes the specific
target even though the combined object has no global synthetic flag. An
unrelated synthetic observation does not exclude a separately evidenced report.
Absence of a synthetic marker is not proof of factual correctness, permitted
source use, spam/duplicate screening or an actual confirmation.

The authority fingerprint includes `confirmed-bug-source-admission/v1` only
when the configuration contains a `confirmed_bugs` binding. Publications made
under the earlier generic authority are withheld on current and pinned reads,
private previews and aggregate explanations, including after database reopen.
The whole snapshot is retired for a mixed configuration even if no confirmed
bug request was accepted. Configurations without that binding retain their exact
prior authority bytes, including the existing data-quality and reproduction
markers. Recalculation under the current approved configuration can publish a
newly authorized result; it does not rewrite historical source facts.

The metric remains `definition_only`. This bounded source-admission correction
does not supply a specialist confirmation protocol, verify an actual bug, infer
severity or credit implementation to a reporter/closer. Reporter and reproduction
contributor attribution, spam/duplicate exclusions, independently reviewed real
examples, complete backfill and public-policy/rollout acceptance remain separate
issue criteria. All automated fixtures are fictional; marker-free fixtures only
exercise the actual public-mode permission boundary in disposable storage.

## Editorial selection (#69)

`POST /controls/spotlights` accepts `{claimId, consent:true}` from the authenticated claim owner only. The existing evidence claim must already be independently accepted. `POST /controls/spotlights/:id` accepts `{version,action,reason,publicExplanation,conflict}`; acceptance/rejection requires an independent reviewer, and withdrawal requires the contributor. Acceptance requires a separate `publicExplanation`; `reason` remains a private audit note. Neither is generated or attributed as a contributor quotation. Session, CSRF, origin, body and role protections are shared with existing controls APIs.

`GET /controls/spotlights/queue` returns private nominations only to their owner or a reviewer.

`GET /controls/spotlights` requires a current synchronous `spotlightEligibility` source-authority callback configured on the controls server; it defaults to denying all publication. Only an exact `true` permits an item, and promises are rejected as false. The callback must check current evidence visibility, allowed source scope and policy, including revocation. This source check is additional to accepted receipt review. The endpoint anonymously projects current accepted nominations under `reviewed-opt-in/v1`, with source links and explicit editorial labels. Opt-in profile text appears only while the profile remains public. Current suppression, evidence withdrawal, amendment or collaborator-consent changes remove the spotlight. Immutable nomination history is retained privately; current public reads are `no-store` and never affect computed rankings. Selection rotates categories in round-robin order, with oldest accepted selection first within each category; ties use stable nomination identity. This is ordering within the current response, not a promised timed publication schedule.

Remaining acceptance: reviewer adoption of selection rules; a real verified evidence and opt-in nomination exercise; newcomer/behind-the-scenes nomination taxonomy and selection governance; real operator/contributor acceptance of the implemented nomination/review frontend, including assistive-technology testing. No testimony or endorsement is generated.

## Reproducible candidate achievements (#70, #124)

`GET /api/v1/contributors/:actorId/achievements` requires an explicit reviewed `approvedAchievementRuleVersion`. The existing `"accepted-evidence/v1"` setting retains its two rules and response: earliest accepted eligible contribution and earliest accepted review in the selected snapshot/scope. The [version 2 decision](accepted-achievement-milestones.md) adds `"accepted-evidence/v2"`, with earliest accepted evidence per registered category, exact optional category selection, original qualifying proof and bounded shared-artifact participant pages. An absent or unsupported setting fails closed; neither version is automatically activated. Dates are proven source occurrence dates, never manufactured acceptance timestamps. Observed, pending, unknown, automated, ineligible and undated activity cannot receive awards.

Incomplete history withholds candidate first-event awards: every coverage partition must be complete, permission/error/page gaps absent, and its window and watermark must cover the selected period through its end (or the snapshot date). All-history queries additionally require a known history start covered by each partition. Version 2 additionally requires the snapshot cutoff to reach a bounded period's end. All-history queries still mean available evidence history, not a complete lifetime or a first-ever claim. The public UI requests the exact selected category; a v1-only service returns unavailable for that filter and no broader achievements are substituted. Current suppression, artifact correction and policy disabling are reapplied even when a snapshot is pinned; awards and v2 peer links are recomputed from the visible accepted evidence. Shared-artifact links describe their recorded subset and can remain available under partial history. There are no streaks, scores, notifications or implied personal merit from automation.

The versioned decision specifies the category and shared-credit engineering policy, including original author/coauthor/reviewer roles, exact artifact identity, deduplication, correction behavior and accessible pagination. Remaining acceptance: actual source/policy activation; a separately sourced cross-workstream mapping and conditions; real admission and producer integration for the separate reviewed organization-history protocol; real independently reviewed examples; real contributor acceptance of the source-linked achievement display, including assistive-technology testing. Registry metric semantics and all 98 planned definitions remain unchanged.

Coverage bounds, earliest-evidence ordering and the browser's selected-period check compare instants, not timestamp text. Equivalent ISO offsets and second/millisecond encodings therefore have the same meaning. Coverage and evidence ordering also retain the source contract's sub-millisecond precision, which JavaScript's date parser alone discards; equal instants use stable contribution identity as the ordering tie-breaker. The browser validates timestamps against the shared source-event contract and retains the source representation. Periods remain half-open, including the start and excluding the end. The API-to-client regressions in `apps/service/test/achievement-timestamps.test.mjs` cover equivalent coverage, insufficient coverage hidden by offsets or fractional precision, ordering, and date-window rejection with synthetic evidence.

The automated-execution exclusion also applies to a user account whose published actor record has positively evidenced `executionMode: "automated"`. Selecting user accounts, automation or all activity cannot bypass it. The actor's accepted work, account kind and measured board values remain visible under the existing public filters; withholding candidate awards does not erase contribution evidence. Unknown execution remains unknown and does not establish manual work. The public API regression in `apps/service/test/read-api.test.mjs` exercises all three filters on a pinned snapshot and confirms that ordinary unknown-execution eligibility is preserved.

## Cards and embedding (#123)

`GET /api/v1/cards/:actorId?metric=<id>` returns semantic HTML for one published metric, with period, exact scope, coverage, metric policy, source links, snapshot date and a pinned visible portfolio link. Add `snapshot=<id>` for an explicitly archived card. An unpinned card says to refresh to check for changes; neither mode claims live data. Missing/suppressed contributors or dependent aggregates yield no card. All text and links are escaped, output has no scripts or external assets, caching is disabled, and external framing is denied (`frame-ancestors 'self'` and `SAMEORIGIN`). Current privacy checks happen before conditional responses.

`GET /api/v1/cards/:actorId/image` supplies a bounded deterministic passive SVG for README images. It preserves dated scope, policy and source labels, contains no scripts/external assets/links, and uses the same current suppression check plus no-store/nosniff. The public profile provides copyable Markdown linking the pinned image to its dated HTML card. Third-party caches/downloads remain outside server withdrawal control.

Remaining acceptance: approved external embedding origins/cache policy if external embeds are desired, accessible browser/assistive-technology review, and actual production readback. Downloaded or copied content cannot be remotely withdrawn; served reads enforce current controls.

## Account backend (#128)

Authenticated `GET /controls/profile` returns only `{public,bio,highlights,suppressed}` for the session's actor. The OAuth server's `loginSuccessPath` may be `/controls/session` (default) or `/account`; arbitrary return URLs are rejected. Hosting must serve the protected account client at the latter path when configured. This does not configure hosting or deployment.

## Evidence

Synthetic controls HTTP tests exercise consent, CSRF, independent selection, durable state and withdrawal. Pure editorial tests cover revocation, stale versions, self/collaborator conflicts, private profile text and suppression. Service tests exercise dated cards, HTML escaping, current suppression on pinned reads, disabled-by-default achievements and exclusion of non-accepted evidence. Synthetic fixtures are never production recognition.
