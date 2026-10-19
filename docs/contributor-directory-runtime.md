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

## Acceptance still required

Source capability and configuration approvals; identity/display policy choices for aliases, former/newcomer/unlinked presentation; independent security, accessibility and metric-owner review; real participant and assistive-technology testing; deployment and anonymous production readback remain open. No employment, popularity, membership or overall productivity classification is inferred.

## Synthetic validation

- Workspace build, formatting/type checks and browser-test TypeScript validation passed.
- The full serial Node aggregate suite passed 324 tests, with seven existing PostgreSQL-only tests skipped (331 total). A separate four-test web client suite passed for query bounds, route/page selection, mismatched filters and unknown legacy acceptance.
- The aggregate includes 33 service read tests and 30 pipeline tests. Coverage includes observed-only external contributors with accepted-only ranking policies, assignment/mention exclusion, hidden/deleted/suppressed identities and artifacts, legacy and current policy/category filtering, independent overlapping categories, 205 equal-time timeline records, cursor replay/tampering/expiry/scope changes, and current-control changes on historical pins.
- Plan validation, generated-document checking and all 27 Python tests passed. These retain the 98-metric planning baseline unchanged.
- Two new browser scenarios exercise accessible directory search/filter pagination, snapshot-preserving Back navigation, a timeline beyond 100 records, and suppression on a later page. They typecheck but did not execute locally: the pinned Playwright Chromium build is absent; the installed system Chromium also fails at OS socket creation. Hosted browser CI remains required. No accessibility pass is claimed from these unexecuted tests.
- The first concurrent, unbounded-heap pipeline attempt terminated without an assertion after 24 passing cases. The isolated 384 MB heap rerun completed all 30 cases, and the bounded serial aggregate also completed without failures.
