# Snapshot-bound public rank comparison

This is backend and public-browser integration for [#97](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/97). Ordinary board and export responses are unchanged. An optional comparison request exposes movement only when two retained, currently authorized publications have compatible engine history. It does not recalculate published values, infer a prior rank, or authorize a source or metric.

## Explicit API selection

`GET /api/v1/boards` and `GET /api/v1/exports` accept these additional optional query parameters:

- `compare`: the exact earlier published snapshot ID.
- `compareStart` and `compareEnd`: optional paired half-open UTC baseline bounds. If omitted, the baseline uses the current request's exact bounds. Dates use the existing `.000Z` API format, and each bounded window is limited to 366 days.

The baseline retains the same complete versioned public scope: organization, repository, workstream, event-time or current membership, selected GitHub Projects and contribution roles. Only an explicitly supplied baseline interval differs. The provider must have published both requested scopes; a query is not a request to compute a new scope. The persisted engine period, filters, policy and evidence metadata remain authoritative. In particular, matching window lengths never reinterpret `custom` windows as a named rolling period.

Comparison selection is bound into signed pagination cursors and snapshot-pinned share links. JSON exports contain the same safe comparison and row movement fields as the board. Requested CSV comparisons add `comparison` and `movement` columns. Requests without `compare` retain the existing output shape and cursor binding.

## Provider and privacy boundary

The optional `PublicSnapshotSource.readComparison` loads both selected snapshots inside one existing database transaction, reusing that transaction rather than acquiring a nested connection. The pipeline holds both repository source locks and checks current configuration, recognition, confirmation markers, confirmed heads and private actor suppression after its final awaited authorization check. A changed authority prevents the paired read from returning stale current rows.

Both snapshots then pass the existing public projection, including current actor/artifact suppression, disabled metrics and revoked snapshots. The service verifies exact receipt/public row, value, rank, evidence and clock agreement before calling `compareRankMovement`. A changed visible cohort is unavailable; hidden rows are never used to reconstruct a visible historical rank. Actor-filtered requests currently return `filtered_cohort_unavailable` rather than pretending that an all-actor receipt establishes a narrower cohort comparison.

The service also rejects the entire paired response when provider control versions or exact current suppression/revocation lists disagree, including private edits without a version increment. Withholding movement alone cannot make earlier current rows safe under a changed authority.

Providers without atomic paired-read support return an unavailable comparison using the ordinary current board. A missing, expired or revoked baseline never produces a guessed history. The baseline's public identity and bounds are returned only when its projected receipt is usable.

## Immutable private metadata

New required aggregate explanations retain a `private-rank-evidence/v1` section containing selected-policy source identities, included evidence clocks and opaque comparison signatures. Coverage checks require each selected source/repository pair and ignore unrelated snapshot coverage; missing or contradictory required coverage stays unavailable. For both publications, every required snapshot and result coverage record must have a source reconciliation watermark through the selected interval's end, and the public snapshot generation boundary must also reach that end. Declared coverage bounds alone cannot establish completeness. Exact source-time comparison accepts an equal boundary and withholds movement when reconciliation is even one nanosecond short. Existing receipt metrics already retain actual ranks, values, policy hashes, scope, cutoff and backfill identity, so no identity/provider records or raw inputs are copied into the new section. The complete required explanation remains covered by its immutable digest and publication confirmation.

Pre-extension explanations are never rewritten or upgraded in place. They remain valid for ordinary reads and repeated publication/restart; their comparison is explicitly `insufficient_evidence_history`. Optional policy-preview retention is not a comparison dependency.

The retained clocks consume the metric engine's existing explicit UTC precision boundary (up to milliseconds). The engine rejects finer effective/observation instants before aggregate capture; this slice neither truncates them nor narrows a previously accepted engine input. Broader public source timestamp support is separate from that engine boundary.

Only `{actorId, state, delta, reason}` is added to visible rows. States are `comparable`, `new_entrant`, and `unavailable`. New entrants have a null delta; unavailable comparisons also have a null delta. Private signatures, receipt contents, backfill identifiers, hidden actor IDs and audit records are not public response or export fields.

## Persisted reconciliation lineage

The pipeline's private `backfillRevision` is a versioned digest of its normalization signature, repository-scoped imported source-fact identities and the captured corrections observed by the frozen observation cutoff. Ordinary `reconcile` run IDs and normalized output contents are excluded. A new timely issue can change the dataset and its measured value without being reported as an import.

Imported history comes from immutable `source_facts` joined to the explicit `backfill` or `audit` run that first retained each fact. The digest binds each ordered `(first_run_id, fact_key)` pair, rather than only the run ID. Another committed page of the same import therefore changes the lineage. A committed page remains part of it if a later page fails or a current-state refresh replaces the selected source revision. Restart and mutable run completion state cannot erase that provenance. Duplicate audits, empty scans and failures before any committed fact introduce no new history identity.

The query uses the publication's observation cutoff, including the persisted cutoff reused by webhook dispatch. Source facts first observed after that boundary cannot change the earlier import set. The correction component sorts a separate list of fact digests; it preserves the existing captured correction order and keeps later corrections in the full private input. Those later facts remain excluded from the earlier epoch while the existing exact dispatch-input fence can still reject a changed unconfirmed replay. Stored snapshots and explanation receipts are never rewritten to acquire a new marker. Comparisons across the old output-digest format and the versioned lineage are conservatively unavailable.

An interrupted dispatch may already have committed its SQL publication before private confirmation. Recovery verifies that publication's retained frozen-input hash, exact observation cutoff and opaque marker, then reuses only that recorded marker while recomputing the other inputs. Its full comparison-input hash must still match the original publication receipt before confirmation. A missing or altered frozen record, a substituted marker or a later correction cannot acquire the old receipt. New publications continue to derive the current lineage; recovering an existing immutable publication does not reinterpret it using a newer marker algorithm or rewrite its input.

The cumulative imported-history read admits at most 10,000 retained source facts per publication scope and rejects the 10,001st with `reconciliation_history_budget_exceeded`. This includes obsolete imported current-state revisions, not only the currently selected normalization set. The implementation does not truncate that history or substitute a constant marker. A deployment reaching this bound needs a separately reviewed durable lineage/retention design under [#95](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/95); deleting provenance or increasing the limit without resource evidence is not an automatic recovery.

This lineage is an invalidation input, not a complete-coverage or completed-import receipt. Existing late-evidence and changed/removed evidence-signature checks still detect historical changes discovered through ordinary reconciliation. Source capability, publication windows, coverage and current privacy authority remain independently required.

## Public-browser selection and display

API-backed metric boards and project boards expose an explicit baseline form. The reader enters the exact published baseline snapshot ID and can supply its paired UTC interval. Leaving both baseline dates blank requests the displayed board's exact interval; it does not guess a preceding period. Submitting a baseline pins the currently displayed snapshot, retains the metric, source scope and actor filter, and clears the old cursor and evidence drawer.

The baseline identity, generation time and requested interval are shown with each comparison. Rows preserve the service's dense ranks across cursor pages and show accessible text for upward movement, downward movement, unchanged rank, a new entrant with no previous rank, or an unavailable comparison with its stated reason. An unavailable result has no numeric fallback. Publication generation time is provenance; the service's retained comparison cutoffs determine period ordering.

Board and project permalinks, cursor navigation, and the background of an evidence drawer retain the explicit baseline selection. Ordinary health, live update, proof, contributor, activity and catalog requests do not receive comparison parameters. Navigating to those other pages drops the comparison selection while retaining the displayed current-snapshot pin. The dedicated Live wall keeps its existing separate scope controls.

The client validates the baseline identity, both exact canonical versioned scopes, public timestamps and every movement-to-actor binding before display. Missing or downgraded scope versions, changed membership/Project/role fields and additional private fields invalidate a comparison. Changing the primary scope clears an unchanged old snapshot pin and cursor while retaining the explicitly requested baseline; an unpublished replacement scope remains unavailable. Comparable and entrant states require a ranked numeric result and an enabled matching ranking policy. Comparable deltas are safe integers with a possible positive prior rank; entrant and unavailable deltas are null. Unknown or contradictory shapes and unexpected private comparison fields invalidate the response. The client does not reconstruct ranks from row order, subtract values, or infer a hidden contributor's previous position.

JSON and CSV downloads retain the currently displayed snapshot, metric, scope, actor filter, baseline and page cursor. Both formats pass the same strict comparison validation before a download is offered. CSV comparisons retain the selected `public-export/v1`, `public-export/v2` or `public-export/v3` scope columns and have exactly two additional comparison columns with identical comparison metadata on the metadata record and every row; the metadata record has no movement. Existing byte, field, evidence, duplicate-key and spreadsheet-formula safeguards remain in force. A requested comparison cannot silently become an ordinary export.

A new selection, a second download, applying a held snapshot, a privacy recheck, navigation, hiding the page, or unmounting cancels a pending download. A late response cannot offer a file after its controller is no longer current. The existing focus and 20-second visible-page publication checks revalidate both sides of a comparison through the atomic service read; failed reads clear the displayed rows and movement.

## Current implementation limits

The pipeline currently publishes fixed custom scopes or all-time scopes with incomplete historical coverage. This change preserves those facts: it does not certify historical completeness, change publication-window semantics or produce artificial progress. Positive movement/new-entrant API tests use actual engine-generated synthetic named-period aggregates with complete synthetic coverage. The actual pipeline tests use two persisted fixed-window snapshots and assert `insufficient_history`.

Named-period publication integration and a connected complete-coverage producer remain separate unfinished integration work under #75/#91/#97. The persisted reconciliation lineage corrects the ordinary-ingestion marker boundary; the browser consumes the service's explicit compatibility result. Neither supplies those missing publication capabilities. This integration alone does not close #97, and no production deployment requirement has been added to its automated-validation gate.

## Validation

- `node --test apps/service/test/rank-comparison.test.mjs`: compatible engine receipts, entrant state, partial coverage, changed policies/backfill, corrections, privacy on both snapshots, pagination, query bounds and safe JSON/CSV output.
- `node --test --test-concurrency=1 apps/pipeline/test/rank-comparison.test.mjs`: actual persistence/restart, immutable legacy replay, shared transaction/no nested connection, authority changes during pairing and confirmed-digest tamper rejection.
- `node --test --test-concurrency=1 apps/pipeline/test/reconciliation-lineage*.test.mjs`: actual ordinary ingestion, correction capture and retry, partial/failed/resumed imports, current-state refresh, audit, frozen cutoffs and cumulative history overflow, while every published coverage record remains partial.
- `node --test --test-concurrency=1 apps/pipeline/test/reconciliation-recovery.test.mjs`: a synthetic prior-producer marker passes through the actual SQL publisher before interrupted private confirmation; database restart recovers the exact receipt, while missing, altered or substituted frozen records stay unavailable. The existing webhook-dispatch cases separately retain later-correction denial.

- `node --test apps/web/test/rank-comparison-client.test.mjs`: actual engine/service movement and tied cursor pages; strict board and JSON/CSV intake; malformed, private, mismatched and stale export inputs; exact URL scope isolation.
- `node --test apps/web/test/rank-comparison-scope.test.mjs`: actual engine/service comparisons for event/current membership and role scopes, complete v2/v3 board and JSON/CSV round trips, and rejection of substituted, downgraded, private and malformed comparison records.
- `npm run test:browser -- rank-comparison.spec.ts`: real-handler baseline selection, visible movement, complete v2/v3 scope and timezone preservation, filter-change pin invalidation, evidence/history, privacy and response-lifetime journeys. The shared fixture is [rank-comparison.mjs](../tests/fixtures/rank-comparison.mjs); it derives movement from the metric engine with explicitly synthetic actors and evidence.

Build workspace packages first. Fixtures are synthetic; their success establishes these executable invariants, not real-source accuracy or coverage.
