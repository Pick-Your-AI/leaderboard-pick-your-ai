# Contributor directory and timeline implementation slice

Refs #112, #105, #120. This is implementation and synthetic verification evidence, not owner acceptance or a public release.

## Bounded design

- `/api/v1/contributors` searches current public usernames and filters independent metric categories. An actor requires attributable public evidence to appear; an actor roster, assignee, mention or membership does not establish work.
- `/api/v1/contributors/:actorId` returns the same scoped metric results plus a complete cursor-paginated portfolio timeline and independent category artifact counts. Counts are never added into a personal score. Categories can overlap.
- Preserve the immutable snapshot and current-control model. Signed cursors bind endpoint, actor, exact materialized scope, search/category, page size, snapshot and control revision. Each page is at most 100; provider limits remain 10,000 actors/rows and 20,000 evidence records. Replaying the same valid page is idempotent. Cross-route/filter reuse fails; control changes require refetch.
- Add a separate bounded portfolio evidence projection alongside ranked evidence. Reuse existing correction/version, canonical attribution, source, role, context, independent acceptance and frozen-cutoff checks. Portfolio visibility uses the actual contribution occurrence clock, while board results retain each approved metric clock. No new source, measure, recognition policy or identity link is enabled. Observed and pending work stays labelled; accepted means an independent acceptance receipt was validated, not merely metric eligibility.
- Public evidence contains only existing allowlisted artifact/contribution metadata, explicit activity state and collection time. Raw facts, acceptance/correction receipt contents, actor emails, membership, aliases and private text are not published. Hidden/deleted/unlinked actors and withdrawn metrics remain unavailable under current controls even for pinned snapshots.
- The UI uses labelled username/category controls, stable snapshot links and ordinary keyboard-accessible pagination. Navigation replaces one bounded page, rather than retaining an unbounded client-side history. Browser Back restores a prior pinned page.

## Portfolio response binding

The browser validates every timeline contribution against the enclosing profile actor. With a selected category, every timeline contribution must include that category and every metric result must identify it, including on the legacy response path without an optional participation summary. Existing summary validation, requested-URL actor checks and role/snapshot/scope checks remain in effect.

Category totals remain independent: a contribution can belong to several categories, so a filtered profile may legitimately retain overlapping category totals. Eligibility without an explicit accepted state remains unknown; these response checks do not infer acceptance, supply missing source evidence or create an overall score.

## Project groups within a timeline page

The API profile groups its current page's unique evidence records by authoritative Project membership. Existing collaboration-role counts remain separate. A record associated with several Projects is referenced by each group but remains one timeline record; neither Project reference counts nor unlike category measures are added into a personal score. Group counts explicitly say **on this timeline page**, while the existing profile/category counts retain their complete selected-snapshot meaning.

The optional, independently versioned `public-project-context/v1` wrapper contains an exact repository/artifact/contribution binding, `event` or `current` basis, `known` or `unknown` state, sorted unique canonical Project IDs, the verified Project scope, and the actual source observation clock. It does not modify the frozen Artifact/Contribution contracts or `leaderboard-evidence/v1`. `known` with an empty membership list means no membership **within that verified scope at that observation**. Missing legacy context and explicit `unknown` remain unavailable, not an empty global membership claim. Each membership/scope array is bounded to 100 canonical IDs of at most 128 ASCII characters. Malformed present context, unsupported versions, foreign bindings and inconsistent copies fail before public filtering or grouping.

The pipeline projects current context only from the latest completed full native-subject inventory, retaining its source receipt and clock. Event context requires the exact validated collected Project-history proof and verified scope; current membership does not backfill event history. The private native repository/subject-kind/ID/URL join remains authoritative. Membership observation time is checked against the frozen observation cutoff, not substituted for an event date, selected window or publication timestamp. The primary, pending and portfolio copies agree. Existing current source/Project permission, opt-out, artifact/unit suppression and pin-revocation gates still apply; a valid wrapper is not authorization.

The UI displays the canonical Project ID and explicitly says that a name and link were not supplied. It derives neither from repository names, selected filters, URLs, governance Projects or membership inferred from the selected scope. Groups use the established canonical ID ordering, show at most ten headings, and allow one expanded group with twenty evidence references per page. The scope view replaces those references and pages twenty verified IDs at a time. Keyboard navigation announces the visible range and moves focus to the group heading; proof links retain the displayed snapshot. Changes to actor, scope, snapshot, controls or timeline page reset local grouping navigation. Only the visible group/reference/scope page is mounted.

The profile response retains the existing 2,000,000-byte complete UTF-8 client ceiling. Pagination chooses the largest complete proof prefix allowed by the requested limit and the exact serialized envelope, including metadata, evidence IDs, separators and the actual signed continuation cursor. It advances by the number actually returned and preserves the original snapshot/scope/limit/control binding. No proof or scope array is truncated. An indivisible proof or fixed envelope that cannot fit returns a controlled unavailable response.

Synthetic checks cover the actual native collection/normalization and SQL publication path, scoped-empty versus missing inventory, event hydration, immutable pins/current denial, all three public copies, real service-to-client admission, full-envelope byte boundaries and cursor traversal, and bounded browser navigation. These checks do not certify real Project permissions, live membership, human accessibility acceptance or a public deployment.

## Public login display policy

For this #120 delivery, the [recorded engineering decision](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/120#issuecomment-6265638864) selects **no public historical-login alias list**. This is a delegated engineering decision, not consent or acceptance attributed to another contributor.

For login display, each readable pinned snapshot uses its own verified source label. A current snapshot can use a later login only under the [verified provider identity and source-ordering rules](verified-actor-renames.md); login, display-name or email matches do not establish identity. Existing source, publication and privacy controls still govern current and pinned responses, including denial of unavailable evidence.

Stable provider-bound serving identifiers retain their separate [identity foundation](contributor-identity-foundation.md). Contribution identity, evidence and credit remain unchanged by the display policy. Live rename history, account-link authorization and public-service acceptance require their own evidence.

## Acceptance still required

Source capability and configuration approvals; identity/display policy choices for former/newcomer/unlinked presentation; independent security, accessibility and metric-owner review; real participant and assistive-technology testing; deployment and anonymous production readback remain open. No employment, popularity, membership or overall productivity classification is inferred.

## Synthetic validation

- Workspace build, formatting/type checks and browser-test TypeScript validation passed.
- The full serial Node aggregate suite passed 324 tests, with seven existing PostgreSQL-only tests skipped (331 total). A separate four-test web client suite passed for query bounds, route/page selection, mismatched filters and unknown legacy acceptance.
- The aggregate includes 33 service read tests and 30 pipeline tests. Coverage includes observed-only external contributors with accepted-only ranking policies, assignment/mention exclusion, hidden/deleted/suppressed identities and artifacts, legacy and current policy/category filtering, independent overlapping categories, 205 equal-time timeline records, cursor replay/tampering/expiry/scope changes, and current-control changes on historical pins.
- Plan validation, generated-document checking and all 27 Python tests passed. These retain the 98-metric planning baseline unchanged.
- Two new browser scenarios exercise accessible directory search/filter pagination, snapshot-preserving Back navigation, a timeline beyond 100 records, and suppression on a later page. They typecheck but did not execute locally: the pinned Playwright Chromium build is absent; the installed system Chromium also fails at OS socket creation. Hosted browser CI remains required. No accessibility pass is claimed from these unexecuted tests.
- The first concurrent, unbounded-heap pipeline attempt terminated without an assertion after 24 passing cases. The isolated 384 MB heap rerun completed all 30 cases, and the bounded serial aggregate also completed without failures.
